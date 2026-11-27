import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FileOperationPlan,
  RemoteReadOnlyDocument,
  RemoteTextDocument,
  SftpSessionInfo,
  TransferJob,
} from '@ubgops/protocol';
import { filesApi } from '../../api/client';
import {
  MAX_READONLY_DOCUMENTS,
  ReadOnlyEditorProvider,
  registerReadOnlyModelDisposer,
  useReadOnlyEditor,
} from './ReadOnlyEditorRegistry';
import {
  MAX_EDITOR_PAYLOAD_BYTES,
  MAX_LOCAL_BUFFER_BYTES,
  calculateEncodedBytes,
  isPasteAllowed,
  normalizePasteToLf,
  validateEditableText,
} from './textCodec';

vi.mock('../../api/client', async (original) => ({
  ...(await original<typeof import('../../api/client')>()),
  filesApi: {
    openReadOnly: vi.fn(),
    cancelReadOnlyOpen: vi.fn(),
    openText: vi.fn(),
    planTextSave: vi.fn(),
    discardTextDocument: vi.fn(),
    execute: vi.fn(),
    discardPlan: vi.fn(),
    discardEditorPlan: vi.fn(),
    transfers: vi.fn(),
  },
}));

function makeSession(hostId = 'host-1', hostSessionId = 'hs-1', id = 'sftp-1'): SftpSessionInfo {
  return {
    id,
    hostId,
    hostSessionId,
    protocolVersion: 3,
    extensions: [
      { name: 'posix-rename@openssh.com', version: '1' },
      { name: 'fsync@openssh.com', version: '1' },
    ],
    limits: {
      maxPacketBytes: '262144',
      maxReadBytes: '65536',
      maxWriteBytes: '65536',
      maxOpenHandles: '64',
      clientChunkBytes: '65536',
      listingEntryCap: 5000,
    },
    rootPath: '/etc',
  };
}

function makeReadOnlyDoc(
  id: string,
  path: string,
  text = 'initial=1\n',
  session: SftpSessionInfo = makeSession(),
): RemoteReadOnlyDocument {
  return {
    id,
    hostId: session.hostId,
    hostSessionId: session.hostSessionId,
    sftpSessionId: session.id,
    displayName: path.split('/').pop() ?? path,
    path,
    text,
    originalBytes: text.length,
    newline: 'lf',
    bom: false,
    maxBytes: MAX_EDITOR_PAYLOAD_BYTES,
    modifiedAt: '2026-11-26T00:00:00Z',
    permissions: '-rw-r--r--',
  };
}

function makeRemoteTextDoc(
  id: string,
  path: string,
  text = 'initial=1\n',
  session: SftpSessionInfo = makeSession(),
  overrides: Partial<RemoteTextDocument> = {},
): RemoteTextDocument {
  return {
    id,
    hostId: session.hostId,
    hostSessionId: session.hostSessionId,
    sftpSessionId: session.id,
    path,
    text,
    originalBytes: text.length,
    newline: 'lf',
    bom: false,
    maxBytes: MAX_EDITOR_PAYLOAD_BYTES,
    ...overrides,
  };
}

function makePlan(id: string, path: string, session: SftpSessionInfo): FileOperationPlan {
  return {
    id,
    hostId: session.hostId,
    hostSessionId: session.hostSessionId,
    sftpSessionId: session.id,
    kind: 'editText',
    risk: 'high',
    conflictPolicy: null,
    items: [
      {
        sourceDisplay: 'Edited text',
        destinationDisplay: path,
        sizeBytes: '12',
      },
    ],
    expiresAt: '2099-01-01T00:00:00Z',
  };
}

function makeJob(
  id: string,
  state: TransferJob['state'],
  session: SftpSessionInfo,
  error: TransferJob['error'] = null,
): TransferJob {
  return {
    id,
    hostId: session.hostId,
    hostSessionId: session.hostSessionId,
    sftpSessionId: session.id,
    direction: 'upload',
    sourceDisplay: 'Edited text',
    destinationDisplay: '/etc/app.conf',
    state,
    confirmedBytes: '12',
    totalBytes: '12',
    error,
    retryable: false,
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <ReadOnlyEditorProvider>{children}</ReadOnlyEditorProvider>
);

describe('textCodec & Editor Save Lifecycle (02B.2B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(filesApi.discardPlan).mockResolvedValue(undefined);
    vi.mocked(filesApi.discardEditorPlan).mockResolvedValue(true);
    vi.mocked(filesApi.discardTextDocument).mockResolvedValue(undefined);
    vi.mocked(filesApi.cancelReadOnlyOpen).mockResolvedValue(true);
    vi.mocked(filesApi.transfers).mockResolvedValue([]);
    registerReadOnlyModelDisposer(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    registerReadOnlyModelDisposer(null);
  });

  it('1. validates LF/CRLF, BOM overhead, NUL rejection, 1 MiB save ceiling & 1.5 MiB local ceiling', () => {
    expect(normalizePasteToLf('a\r\nb\rc')).toBe('a\nb\nc');

    const crlfMetrics = calculateEncodedBytes('line1\nline2\n', 'crLf', true);
    expect(crlfMetrics.lfUtf8Bytes).toBe(12);
    expect(crlfMetrics.bomBytes).toBe(3);
    expect(crlfMetrics.crlfExpansionBytes).toBe(2);
    expect(crlfMetrics.encodedBytes).toBe(17);

    const exact1MiB = 'a'.repeat(MAX_EDITOR_PAYLOAD_BYTES);
    expect(validateEditableText(exact1MiB, 'lf', false).canSave).toBe(true);

    const justOverPayload = 'a'.repeat(MAX_EDITOR_PAYLOAD_BYTES + 1);
    const payloadOverflow = validateEditableText(justOverPayload, 'lf', false);
    expect(payloadOverflow.canHoldLocally).toBe(true);
    expect(payloadOverflow.canSave).toBe(false);

    const overLocal = 'a'.repeat(MAX_LOCAL_BUFFER_BYTES + 1);
    const localOverflow = validateEditableText(overLocal, 'lf', false);
    expect(localOverflow.canHoldLocally).toBe(false);
    expect(localOverflow.canSave).toBe(false);

    expect(isPasteAllowed('ok', 'bad\0text', 0, 'lf', false).allowed).toBe(false);
    expect(isPasteAllowed('a', 'x'.repeat(MAX_LOCAL_BUFFER_BYTES), 0, 'lf', false).allowed).toBe(
      false,
    );
  });

  it('2. read-only open acquires no EditorDocumentId, promotes cleanly in place, and blocks overlapping promotions', async () => {
    const session = makeSession();
    vi.mocked(filesApi.openReadOnly).mockResolvedValueOnce(
      makeReadOnlyDoc('ro-doc-1', '/etc/app.conf', 'hello\n', session),
    );
    let resolveOpenText!: (doc: RemoteTextDocument) => void;
    vi.mocked(filesApi.openText).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpenText = resolve;
        }),
    );

    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });

    await act(async () => {
      await result.current.openDocument(session, '/etc/app.conf');
    });

    expect(filesApi.openText).not.toHaveBeenCalled();
    expect(result.current.documents[0]).toMatchObject({
      id: 'ro-doc-1',
      editable: false,
      editState: 'readOnly',
      editDocumentId: null,
    });

    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    await act(async () => {
      p1 = result.current.promoteToEditable('ro-doc-1', session);
      p2 = result.current.promoteToEditable('ro-doc-1', session);
    });
    expect(result.current.documents[0]?.editState).toBe('openingForEdit');
    expect(filesApi.openText).toHaveBeenCalledTimes(1);

    resolveOpenText(makeRemoteTextDoc('edit-doc-99', '/etc/app.conf', 'hello\n', session));
    await act(async () => {
      await Promise.all([p1, p2]);
    });

    expect(result.current.documents).toHaveLength(1);
    expect(result.current.documents[0]).toMatchObject({
      id: 'ro-doc-1',
      editable: true,
      editState: 'editableClean',
      editDocumentId: 'edit-doc-99',
      modelRevision: 0,
    });
  });

  it('3. enforces shared 8-document global quota and blocks duplicate live write authorities', async () => {
    const session = makeSession();
    vi.mocked(filesApi.openReadOnly).mockImplementation(async (_s, reqId, path) =>
      makeReadOnlyDoc(`ro-${reqId}`, path, 'ro\n', session),
    );
    vi.mocked(filesApi.openText).mockImplementation(async (_s, path) =>
      makeRemoteTextDoc(`ed-${path}`, path, 'edit\n', session),
    );

    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });

    for (let i = 0; i < MAX_READONLY_DOCUMENTS - 1; i += 1) {
      await act(async () => {
        await result.current.openDocument(session, `/etc/ro-${i}.conf`);
      });
    }
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/live-edit.conf');
    });
    expect(result.current.documents).toHaveLength(MAX_READONLY_DOCUMENTS);

    let ninthRo: unknown;
    let ninthEd: unknown;
    await act(async () => {
      ninthRo = await result.current.openDocument(session, '/etc/ninth.conf');
      ninthEd = await result.current.openEditableDocument(session, '/etc/ninth-edit.conf');
    });
    expect(ninthRo).toBeNull();
    expect(ninthEd).toBeNull();
    expect(result.current.errorsByHost['host-1']).toMatch(/8 open documents/i);
  });

  it('4. requires explicit save, invalidates immutable plan on intervening edits, and checks discardEditorPlan result', async () => {
    const session = makeSession();
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-1', '/etc/app.conf', 'v1\n', session),
    );
    const plan1 = makePlan('plan-1', '/etc/app.conf', session);
    vi.mocked(filesApi.planTextSave).mockResolvedValue(plan1);

    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/app.conf');
    });
    const tabId = result.current.documents[0]!.id;

    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'v2\n', { canUndo: true, canRedo: false });
    });
    expect(result.current.documents[0]).toMatchObject({
      dirty: true,
      editState: 'editableModified',
      draftText: 'v2\n',
    });
    expect(filesApi.planTextSave).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    expect(filesApi.planTextSave).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'host-1', hostSessionId: 'hs-1', id: 'sftp-1' }),
      'ed-1',
      'v2\n',
    );
    expect(result.current.documents[0]?.editState).toBe('savePreparation');

    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'v3\n');
    });
    expect(filesApi.discardEditorPlan).toHaveBeenCalledWith(expect.anything(), 'plan-1');
    expect(result.current.documents[0]?.savePlan).toBeNull();
    expect(result.current.documents[0]?.editState).toBe('editableModified');

    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    expect(result.current.documents[0]?.editState).toBe('savePreparation');
    await act(async () => {
      expect(await result.current.cancelSavePreparation(tabId)).toBe(true);
    });
    expect(result.current.documents[0]).toMatchObject({
      dirty: true,
      draftText: 'v3\n',
      savePlan: null,
      editState: 'editableModified',
    });

    // If discardEditorPlan returns false (revoked/expired), authority is marked stale
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    vi.mocked(filesApi.discardEditorPlan).mockResolvedValueOnce(false);
    await act(async () => {
      expect(await result.current.cancelSavePreparation(tabId)).toBe(false);
    });
    expect(result.current.documents[0]).toMatchObject({
      staleRevision: true,
      editDocumentId: null,
      editState: 'conflictDetected',
      dirty: true,
    });

    // Editing while planTextSave is in flight discards the stale returned plan
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-1b', '/etc/app.conf', 'v1\n', session),
    );
    await act(async () => {
      await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
    });
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'v3\n');
    });
    let resolvePlan!: (p: FileOperationPlan) => void;
    vi.mocked(filesApi.planTextSave).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePlan = resolve;
        }),
    );
    vi.mocked(filesApi.discardEditorPlan).mockClear();
    let prepPromise!: Promise<unknown>;
    await act(async () => {
      prepPromise = result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'v4\n');
    });
    resolvePlan(makePlan('plan-stale', '/etc/app.conf', session));
    const prepOutcome = await act(async () => prepPromise);
    expect(prepOutcome).toBeNull();
    expect(filesApi.discardEditorPlan).toHaveBeenCalledWith(expect.anything(), 'plan-stale');
  });

  it('5. completes safe save via root poller, preserves concurrent T1->T2 edits, and handles refresh failure', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    vi.mocked(filesApi.openText)
      .mockResolvedValueOnce(makeRemoteTextDoc('ed-1', '/etc/app.conf', 'T0\n', session))
      .mockResolvedValueOnce(makeRemoteTextDoc('ed-2', '/etc/app.conf', 'T1\n', session))
      .mockRejectedValueOnce({ code: 'connection', message: 'Network blip on refresh', hostKey: null });

    vi.mocked(filesApi.planTextSave)
      .mockResolvedValueOnce(makePlan('plan-t1', '/etc/app.conf', session))
      .mockResolvedValueOnce(makePlan('plan-t2', '/etc/app.conf', session));

    vi.mocked(filesApi.execute)
      .mockResolvedValueOnce([makeJob('job-1', 'transferring', session)])
      .mockResolvedValueOnce([makeJob('job-2', 'completed', session)]);

    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/app.conf');
    });
    const tabId = result.current.documents[0]!.id;

    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'T1\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      await result.current.executeSave(tabId, session);
    });
    expect(result.current.documents[0]?.editState).toBe('saving');

    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'T2\n');
    });

    vi.mocked(filesApi.transfers).mockResolvedValueOnce([makeJob('job-1', 'completed', session)]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(result.current.documents[0]).toMatchObject({
      editDocumentId: 'ed-2',
      baselineText: 'T1\n',
      draftText: 'T2\n',
      dirty: true,
      editState: 'editableModified',
    });

    // Save #2 where transfer completes but post-save openText authority refresh fails
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      await result.current.executeSave(tabId, session);
    });
    expect(result.current.documents[0]).toMatchObject({
      editDocumentId: null,
      baselineText: 'T2\n',
      draftText: 'T2\n',
      dirty: false,
      staleRevision: true,
      editState: 'saveConfirmed',
    });
    expect(result.current.documents[0]?.editError).toMatch(/refreshing editor authority failed/i);
  });

  it('6. handles conflicts, safe pre-dispatch rejections, async transfer failures & strict outcomeUnknown settlement', async () => {
    const session = makeSession();
    vi.mocked(filesApi.openText)
      .mockResolvedValueOnce(makeRemoteTextDoc('ed-1', '/etc/app.conf', 'a\n', session))
      .mockResolvedValueOnce(makeRemoteTextDoc('ed-2', '/etc/app.conf', 'remote-b\n', session))
      .mockResolvedValueOnce(makeRemoteTextDoc('ed-3', '/etc/app.conf', 'remote-c\n', session))
      .mockResolvedValueOnce(makeRemoteTextDoc('ed-4', '/etc/app.conf', 'remote-d\n', session));

    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/app.conf');
    });
    const tabId = result.current.documents[0]!.id;

    // Pre-dispatch conflict during planTextSave
    vi.mocked(filesApi.planTextSave).mockRejectedValueOnce({
      code: 'conflict',
      message: 'Remote file changed since open.',
      hostKey: null,
    });
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'dirty-a\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    expect(result.current.documents[0]).toMatchObject({
      editState: 'conflictDetected',
      staleRevision: true,
      dirty: true,
      draftText: 'dirty-a\n',
    });

    await act(async () => {
      await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
    });
    expect(result.current.documents[0]).toMatchObject({
      editState: 'editableClean',
      staleRevision: false,
      dirty: false,
      draftText: 'remote-b\n',
      editDocumentId: 'ed-2',
    });

    // Pre-dispatch policy rejection during execute -> safe saveFailed
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('plan-pol', '/etc/app.conf', session),
    );
    vi.mocked(filesApi.execute).mockRejectedValueOnce({
      code: 'filePolicy',
      message: 'Exceeds policy limit.',
      hostKey: null,
    });
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'local-edit\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      await result.current.executeSave(tabId, session);
    });
    expect(result.current.documents[0]?.editState).toBe('saveFailed');

    // TransferJob returning state: 'outcomeUnknown' settles strictly as outcomeUnknown
    await act(async () => {
      await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
    });
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('plan-job-unk', '/etc/app.conf', session),
    );
    vi.mocked(filesApi.execute).mockResolvedValueOnce([
      makeJob('job-unk', 'transferring', session),
    ]);
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'job-unk-edit\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      await result.current.executeSave(tabId, session);
    });
    await act(async () => {
      result.current.syncTransfers([
        makeJob('job-unk', 'outcomeUnknown', session, {
          code: 'outcomeUnknown',
          message: 'Lost rename reply',
          hostKey: null,
        }),
      ]);
    });
    expect(result.current.documents[0]).toMatchObject({
      editState: 'outcomeUnknown',
      dirty: true,
      draftText: 'job-unk-edit\n',
    });

    // Raw IPC error / connection loss during execute -> STRICT outcomeUnknown!
    await act(async () => {
      await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
    });
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('plan-ipc', '/etc/app.conf', session),
    );
    vi.mocked(filesApi.execute).mockRejectedValueOnce(new Error('IPC channel closed'));
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'ambiguous-edit\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      await result.current.executeSave(tabId, session);
    });
    expect(result.current.documents[0]).toMatchObject({
      editState: 'outcomeUnknown',
      dirty: true,
      draftText: 'ambiguous-edit\n',
    });

    // Normal close refused during outcomeUnknown; explicit discard confirmation allowed
    let closedNormal = true;
    await act(async () => {
      closedNormal = result.current.closeDocument(tabId);
    });
    expect(closedNormal).toBe(false);
    expect(result.current.documents).toHaveLength(1);
    await act(async () => {
      expect(result.current.closeDocument(tabId, { confirmDiscard: true })).toBe(true);
    });
    expect(result.current.documents).toHaveLength(0);
  });

  it('7. preserves dirty buffer across disconnect, auto-discards late promo, guards beforeunload, and enforces legacy mutual exclusion', async () => {
    const disposer = vi.fn();
    registerReadOnlyModelDisposer(disposer);
    const session = makeSession();
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-dc', '/etc/dc.conf', 'base\n', session),
    );

    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/dc.conf');
    });
    const tabId = result.current.documents[0]!.id;
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'unsaved-work\n');
    });

    // beforeunload is prevented while dirty work exists
    const unloadEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadEvent);
    expect(unloadEvent.defaultPrevented).toBe(true);

    // Legacy modal cannot claim same live session+path while coordinator holds write authority
    expect(result.current.hasActiveEditAuthority(session, '/etc/dc.conf')).toBe(true);
    expect(result.current.registerExternalEdit(session, '/etc/dc.conf', 'legacy-1')).toBe(false);

    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('plan-dc', '/etc/dc.conf', session),
    );
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      result.current.syncHostConnection('host-1', false, null, null);
    });
    expect(filesApi.discardEditorPlan).toHaveBeenCalledWith(expect.anything(), 'plan-dc');
    expect(result.current.documents[0]).toMatchObject({
      disconnected: true,
      editState: 'disconnected',
      editDocumentId: null,
      savePlan: null,
      dirty: true,
      draftText: 'unsaved-work\n',
    });
    expect(disposer).not.toHaveBeenCalled();

    // Discard changes cleanly restores baselineText; purgeHost disposes model cleanly
    await act(async () => {
      await result.current.discardChanges(tabId);
    });
    expect(result.current.documents[0]?.dirty).toBe(false);
    expect(result.current.documents[0]?.draftText).toBe('base\n');

    await act(async () => {
      result.current.purgeHost('host-1');
    });
    expect(disposer).toHaveBeenCalledWith(tabId);
    expect(result.current.documents).toHaveLength(0);

    // Disconnect while promoteToEditable openText is in flight discards late returned token
    const sessionRo = makeSession('host-3', 'hs-3', 'sftp-3');
    vi.mocked(filesApi.openReadOnly).mockResolvedValueOnce(
      makeReadOnlyDoc('ro-race', '/etc/race.conf', 'hi\n', sessionRo),
    );
    let resolveLateOpenText!: (d: RemoteTextDocument) => void;
    vi.mocked(filesApi.openText).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLateOpenText = resolve;
        }),
    );
    await act(async () => {
      await result.current.openDocument(sessionRo, '/etc/race.conf');
    });
    let promoPromise!: Promise<unknown>;
    await act(async () => {
      promoPromise = result.current.promoteToEditable('ro-race', sessionRo);
    });
    await act(async () => {
      result.current.syncHostConnection('host-3', false, null, null);
    });
    resolveLateOpenText(makeRemoteTextDoc('ed-late', '/etc/race.conf', 'hi\n', sessionRo));
    expect(await act(async () => promoPromise)).toBeNull();
    expect(filesApi.discardTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'host-3', hostSessionId: 'hs-3', id: 'sftp-3' }),
      'ed-late',
    );
    await act(async () => {
      result.current.purgeHost('host-3');
    });

    // Reverse mutual exclusion: external modal registers -> coordinator blocked until unregistered
    const session2 = makeSession('host-2', 'hs-2', 'sftp-2');
    expect(result.current.registerExternalEdit(session2, '/etc/modal.conf', 'ext-1')).toBe(true);
    let blockedEdit: unknown;
    await act(async () => {
      blockedEdit = await result.current.openEditableDocument(session2, '/etc/modal.conf');
    });
    expect(blockedEdit).toBeNull();
    expect(result.current.errorsByHost['host-2']).toMatch(/active edit authority/i);

    act(() => {
      result.current.unregisterExternalEdit('ext-1');
    });
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-unlocked', '/etc/modal.conf', 'ok\n', session2),
    );
    let unlockedEdit: unknown;
    await act(async () => {
      unlockedEdit = await result.current.openEditableDocument(session2, '/etc/modal.conf');
    });
    expect(unlockedEdit).not.toBeNull();
  });

  it('8. hardens ownership, save state mutual exclusion, 7-point verification, bounded polling, and discard guards (F-02..F-06)', async () => {
    const session = makeSession('host-8', 'hs-8', 'sftp-8');
    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });

    // F-02: concurrent openDocument + openEditableDocument cancels RO open and yields 1 tab
    let resolveRo!: (doc: RemoteReadOnlyDocument) => void;
    vi.mocked(filesApi.openReadOnly).mockImplementationOnce(
      () => new Promise((r) => { resolveRo = r; }),
    );
    let resolveEd!: (doc: RemoteTextDocument) => void;
    vi.mocked(filesApi.openText).mockImplementationOnce(
      () => new Promise((r) => { resolveEd = r; }),
    );
    let roPromise!: Promise<unknown>;
    let edPromise!: Promise<unknown>;
    await act(async () => {
      roPromise = result.current.openDocument(session, '/etc/concurrent.conf');
      edPromise = result.current.openEditableDocument(session, '/etc/concurrent.conf');
    });
    resolveEd(makeRemoteTextDoc('ed-win', '/etc/concurrent.conf', 'v1\n', session));
    resolveRo(makeReadOnlyDoc('ro-lose', '/etc/concurrent.conf', 'v1\n', session));
    await act(async () => {
      await Promise.all([roPromise, edPromise]);
    });
    expect(result.current.documents).toHaveLength(1);
    expect(result.current.documents[0]?.editable).toBe(true);

    // F-02: synchronous reserveExternalEdit blocks concurrent openEditableDocument on same path
    const resId = result.current.reserveExternalEdit(session, '/etc/ext-sync.conf');
    expect(resId).not.toBeNull();
    let blocked!: unknown;
    await act(async () => {
      blocked = await result.current.openEditableDocument(session, '/etc/ext-sync.conf');
    });
    expect(blocked).toBeNull();
    act(() => {
      result.current.releaseExternalEdit(resId!);
    });

    // F-03: equal-text updateEditableBuffer preserves savePlan; cancelSavePreparation enters cancellingSave and blocks concurrent executeSave
    const tabId = result.current.documents[0]!.id;
    vi.mocked(filesApi.planTextSave).mockResolvedValue(makePlan('plan-8', '/etc/concurrent.conf', session));
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'v2\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    vi.mocked(filesApi.discardEditorPlan).mockClear();
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'v2\n');
    });
    expect(filesApi.discardEditorPlan).not.toHaveBeenCalled();
    expect(result.current.documents[0]?.savePlan?.plan.id).toBe('plan-8');

    let resolveDiscard!: (v: boolean) => void;
    vi.mocked(filesApi.discardEditorPlan).mockImplementationOnce(
      () => new Promise((r) => { resolveDiscard = r; }),
    );
    let cancelPromise!: Promise<boolean>;
    let execWhileCancelling: TransferJob | null = null;
    await act(async () => {
      cancelPromise = result.current.cancelSavePreparation(tabId);
      execWhileCancelling = await result.current.executeSave(tabId, session);
    });
    expect(result.current.documents[0]?.editState).toBe('cancellingSave');
    expect(execWhileCancelling).toBeNull();
    expect(result.current.closeDocument(tabId, { confirmDiscard: true })).toBe(false);
    resolveDiscard(true);
    await act(async () => {
      expect(await cancelPromise).toBe(true);
    });

    // F-06: reloadDocument refuses dirty buffer unless allowDirtyDiscard is explicitly true
    expect(result.current.documents[0]?.dirty).toBe(true);
    let dirtyReloadResult: unknown = 'unset';
    await act(async () => {
      dirtyReloadResult = await result.current.reloadDocument(tabId, session);
    });
    expect(dirtyReloadResult).toBeNull();
    expect(result.current.documents[0]?.draftText).toBe('v2\n');

    // F-04/F-05: 7-point verification rejects mismatched refreshed text without overwriting draftText
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    vi.mocked(filesApi.execute).mockResolvedValueOnce([makeJob('job-8a', 'completed', session)]);
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-8b-mismatch', '/etc/concurrent.conf', 'EXTERNAL_WRITE\n', session),
    );
    vi.mocked(filesApi.discardTextDocument).mockClear();
    await act(async () => {
      await result.current.executeSave(tabId, session);
    });
    expect(result.current.documents[0]).toMatchObject({
      draftText: 'v2\n',
      editState: 'conflictDetected',
      lastSaveOutcome: 'confirmed',
      staleRevision: true,
      editDocumentId: null,
    });
    expect(filesApi.discardTextDocument).toHaveBeenCalledWith(expect.anything(), 'ed-8b-mismatch');

    // F-04/F-05/F-06: bounded polling exhaustion -> outcomeUnknown, preserved on discardChanges & disconnect,
    // blocked from purgeHost until resolved or confirmed discard
    vi.useFakeTimers();
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-poll', '/etc/concurrent.conf', 'base\n', session),
    );
    await act(async () => {
      await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
    });
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(makePlan('plan-poll', '/etc/concurrent.conf', session));
    vi.mocked(filesApi.execute).mockResolvedValueOnce([makeJob('job-evicted', 'transferring', session)]);
    vi.mocked(filesApi.transfers).mockResolvedValue([]);
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'saved-edit\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      await result.current.executeSave(tabId, session);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.documents[0]?.editState).toBe('outcomeUnknown');
    expect(result.current.canPurgeHost('host-8').allowed).toBe(false);

    act(() => {
      result.current.syncHostConnection('host-8', false, null, null);
    });
    await act(async () => {
      await result.current.discardChanges(tabId);
    });
    expect(result.current.documents[0]).toMatchObject({
      editState: 'outcomeUnknown',
      lastSaveOutcome: 'outcomeUnknown',
      dirty: false,
    });
    vi.useRealTimers();
  });
});
