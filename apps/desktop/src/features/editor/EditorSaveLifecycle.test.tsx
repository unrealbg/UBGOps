import { act, render, renderHook } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
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
    vi.mocked(filesApi.openReadOnly).mockReset();
    vi.mocked(filesApi.openText).mockReset();
    vi.mocked(filesApi.planTextSave).mockReset();
    vi.mocked(filesApi.execute).mockReset();
    vi.mocked(filesApi.discardPlan).mockReset().mockResolvedValue(undefined);
    vi.mocked(filesApi.discardEditorPlan).mockReset().mockResolvedValue(true);
    vi.mocked(filesApi.discardTextDocument).mockReset().mockResolvedValue(undefined);
    vi.mocked(filesApi.cancelReadOnlyOpen).mockReset().mockResolvedValue(true);
    vi.mocked(filesApi.transfers).mockReset().mockResolvedValue([]);
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

  it('9. preserves retainedAuthority for fail-closed cleanup across all 4 lockout paths without 60m Conflict lockout (FINDING-02)', async () => {
    const session = makeSession('host-9', 'hs-9', 'sftp-9');
    const activeAuthorities = new Map<string, string>();
    const pendingPlans = new Map<string, string>();
    let seq = 0;

    vi.mocked(filesApi.openText).mockImplementation(async (s, path) => {
      const k = `${s.hostId}:${s.hostSessionId}:${s.id}:${path}`;
      if (activeAuthorities.has(k)) {
        throw {
          code: 'conflict',
          message: 'An active editor authority already exists for this file in this SFTP session.',
          hostKey: null,
        };
      }
      const id = `auth-${++seq}`;
      activeAuthorities.set(k, id);
      return makeRemoteTextDoc(id, path, `rev-${seq}\n`, { ...session, ...s });
    });
    vi.mocked(filesApi.discardTextDocument).mockImplementation(async (s, docId) => {
      for (const [k, v] of activeAuthorities.entries()) {
        if (v === docId && k.startsWith(`${s.hostId}:${s.hostSessionId}:${s.id}:`)) {
          activeAuthorities.delete(k);
        }
      }
    });
    vi.mocked(filesApi.discardEditorPlan).mockImplementation(async (_s, planId) => {
      return pendingPlans.delete(planId);
    });

    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/lockout.conf');
    });
    const tabId = result.current.documents[0]!.id;
    expect(result.current.documents[0]?.retainedAuthority?.documentId).toBe('auth-1');

    // Path 1: prepareSave revision Conflict leaves backend Ready -> reload MUST discard auth-1 cleanly
    vi.mocked(filesApi.planTextSave).mockRejectedValueOnce({
      code: 'conflict',
      message: 'Remote file changed since open.',
      hostKey: null,
    });
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'edit-1\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    expect(result.current.documents[0]).toMatchObject({
      editDocumentId: null,
      editState: 'conflictDetected',
      retainedAuthority: expect.objectContaining({
        documentId: 'auth-1',
        usable: false,
        ownershipState: 'staleCleanupRequired',
      }),
    });
    await act(async () => {
      const reloaded = await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
      expect(reloaded?.editDocumentId).toBe('auth-2');
    });
    expect(activeAuthorities.get('host-9:hs-9:sftp-9:/etc/lockout.conf')).toBe('auth-2');

    // Path 2: executeSave pre-dispatch expired plan failure preserves authority for reload recovery
    pendingPlans.set('plan-exp', 'auth-2');
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(makePlan('plan-exp', '/etc/lockout.conf', session));
    vi.mocked(filesApi.execute).mockRejectedValueOnce({
      code: 'policy',
      message: 'The file-operation plan expired.',
      hostKey: null,
    });
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'edit-2\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      await result.current.executeSave(tabId, session);
    });
    expect(result.current.documents[0]?.retainedAuthority).toMatchObject({
      documentId: 'auth-2',
      usable: false,
      ownershipState: 'staleCleanupRequired',
    });
    await act(async () => {
      const reloaded = await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
      expect(reloaded?.editDocumentId).toBe('auth-3');
    });

    // Path 3: cancelSavePreparation returning false retains authority for reload recovery
    pendingPlans.set('plan-cancel-false', 'auth-3');
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('plan-cancel-false', '/etc/lockout.conf', session),
    );
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'edit-3\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    vi.mocked(filesApi.discardEditorPlan).mockResolvedValueOnce(false);
    await act(async () => {
      expect(await result.current.cancelSavePreparation(tabId)).toBe(false);
    });
    expect(result.current.documents[0]?.retainedAuthority?.documentId).toBe('auth-3');
    await act(async () => {
      const reloaded = await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
      expect(reloaded?.editDocumentId).toBe('auth-4');
    });

    // Path 4: updateEditableBuffer superseded plan discard rejects/false retains auth-4 AND stale reject cannot clobber auth-5
    let resolveSlowDiscard!: (v: boolean) => void;
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('plan-superseded', '/etc/lockout.conf', session),
    );
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'edit-4\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    vi.mocked(filesApi.discardEditorPlan).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveSlowDiscard = r;
        }),
    );
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'edit-4-superseded\n');
    });
    // Recover via reload acquiring auth-5 while slow discard of auth-4's plan is still pending
    vi.mocked(filesApi.discardEditorPlan).mockImplementation(async (_s, planId) =>
      pendingPlans.delete(planId),
    );
    await act(async () => {
      const reloaded = await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
      expect(reloaded?.editDocumentId).toBe('auth-5');
    });
    resolveSlowDiscard(false);
    await act(async () => {
      await Promise.resolve();
    });
    // Late false from auth-4's plan discard MUST NOT clobber newly acquired auth-5
    expect(result.current.documents[0]?.editDocumentId).toBe('auth-5');
    expect(result.current.documents[0]?.staleRevision).toBe(false);

    // Fail-closed: if discardTextDocument throws during reload, reload MUST fail closed without calling openText
    const callsBeforeFailClosed = vi.mocked(filesApi.openText).mock.calls.length;
    vi.mocked(filesApi.discardTextDocument).mockRejectedValueOnce(new Error('IPC lost during discard'));
    await act(async () => {
      const blockedReload = await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
      expect(blockedReload).toBeNull();
    });
    expect(vi.mocked(filesApi.openText).mock.calls.length).toBe(callsBeforeFailClosed);
    expect(result.current.documents[0]?.retainedAuthority?.documentId).toBe('auth-5');
    // While retained authority is unusable after failed discard, prepareSave remains blocked (staleRevision: true)
    await act(async () => {
      expect(await result.current.prepareSave(tabId, session)).toBeNull();
    });

    // Recover cleanly via reload (now discardTextDocument succeeds -> auth-6), then test ambiguous execute loss
    await act(async () => {
      const recovered = await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
      expect(recovered?.editDocumentId).toBe('auth-6');
    });
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(makePlan('plan-ambig', '/etc/lockout.conf', session));
    vi.mocked(filesApi.execute).mockRejectedValueOnce(new Error('Lost execute reply'));
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'edit-ambig\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    await act(async () => {
      await result.current.executeSave(tabId, session);
    });
    expect(result.current.documents[0]).toMatchObject({
      editState: 'outcomeUnknown',
      retainedAuthority: expect.objectContaining({
        documentId: 'auth-6',
        usable: false,
        ownershipState: 'executionAmbiguous',
      }),
    });
    vi.mocked(filesApi.discardTextDocument).mockClear();
    await act(async () => {
      expect(result.current.closeDocument(tabId, { confirmDiscard: true })).toBe(true);
    });
    // Must NOT release destination ownership while unresolved mutation could still be executing
    expect(filesApi.discardTextDocument).not.toHaveBeenCalled();
    expect(result.current.hasActiveEditAuthority(session, '/etc/lockout.conf')).toBe(true);
    expect(result.current.canPurgeHost('host-9').allowed).toBe(false);

    // Reconnect under new session generation retires old unresolved session fence cleanly
    const sessionNew = makeSession('host-9', 'hs-9b', 'sftp-9b');
    act(() => {
      result.current.syncHostConnection('host-9', true, sessionNew.hostSessionId, sessionNew.id);
    });
    expect(result.current.hasActiveEditAuthority(sessionNew, '/etc/lockout.conf')).toBe(false);
    expect(result.current.canPurgeHost('host-9').allowed).toBe(true);
  });

  it('10. enforces strict cancelSavePreparation state guard across all 9 DocumentEditStates (FINDING-05)', async () => {
    const session = makeSession('host-10', 'hs-10', 'sftp-10');
    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });

    vi.mocked(filesApi.openReadOnly).mockResolvedValueOnce(
      makeReadOnlyDoc('ro-10', '/etc/ro-10.conf', 'ro\n', session),
    );
    await act(async () => {
      await result.current.openDocument(session, '/etc/ro-10.conf');
    });
    // readOnly
    await act(async () => {
      expect(await result.current.cancelSavePreparation('ro-10')).toBe(false);
    });
    expect(result.current.documents[0]?.editState).toBe('readOnly');

    // Promote to editableClean
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-10', '/etc/ro-10.conf', 'ro\n', session),
    );
    await act(async () => {
      await result.current.promoteToEditable('ro-10', session);
    });
    await act(async () => {
      expect(await result.current.cancelSavePreparation('ro-10')).toBe(false);
    });
    expect(result.current.documents[0]?.editState).toBe('editableClean');

    // editableModified
    await act(async () => {
      result.current.updateEditableBuffer('ro-10', 'mod\n');
    });
    await act(async () => {
      expect(await result.current.cancelSavePreparation('ro-10')).toBe(false);
    });
    expect(result.current.documents[0]?.editState).toBe('editableModified');

    // savePreparation -> cancellingSave -> mutual exclusion with cancel/execute
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('plan-10a', '/etc/ro-10.conf', session),
    );
    await act(async () => {
      await result.current.prepareSave('ro-10', session);
    });
    let resolveDiscard!: (v: boolean) => void;
    vi.mocked(filesApi.discardEditorPlan).mockImplementationOnce(
      () => new Promise((r) => { resolveDiscard = r; }),
    );
    let cancel1!: Promise<boolean>;
    let cancel2!: Promise<boolean>;
    let execWhileCancelling!: TransferJob | null;
    await act(async () => {
      cancel1 = result.current.cancelSavePreparation('ro-10');
      cancel2 = result.current.cancelSavePreparation('ro-10');
      execWhileCancelling = await result.current.executeSave('ro-10', session);
    });
    expect(result.current.documents[0]?.editState).toBe('cancellingSave');
    expect(execWhileCancelling).toBeNull();
    resolveDiscard(true);
    await act(async () => {
      expect(await cancel1).toBe(true);
      expect(await cancel2).toBe(false);
    });

    // saving
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('plan-10b', '/etc/ro-10.conf', session),
    );
    vi.mocked(filesApi.execute).mockResolvedValueOnce([makeJob('job-10', 'transferring', session)]);
    await act(async () => {
      await result.current.prepareSave('ro-10', session);
      await result.current.executeSave('ro-10', session);
    });
    expect(result.current.documents[0]?.editState).toBe('saving');
    await act(async () => {
      expect(await result.current.cancelSavePreparation('ro-10')).toBe(false);
    });
    expect(result.current.documents[0]?.editState).toBe('saving');

    // conflictDetected
    await act(async () => {
      result.current.syncTransfers([
        makeJob('job-10', 'failed', session, {
          code: 'conflict',
          message: 'Remote file changed since open.',
          hostKey: null,
        }),
      ]);
    });
    expect(result.current.documents[0]?.editState).toBe('conflictDetected');
    await act(async () => {
      expect(await result.current.cancelSavePreparation('ro-10')).toBe(false);
    });
    expect(result.current.documents[0]?.editState).toBe('conflictDetected');

    // outcomeUnknown
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-10b', '/etc/ro-10.conf', 'fresh\n', session),
    );
    await act(async () => {
      await result.current.reloadDocument('ro-10', session, { allowDirtyDiscard: true });
    });
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('plan-10c', '/etc/ro-10.conf', session),
    );
    vi.mocked(filesApi.execute).mockRejectedValueOnce(new Error('IPC dropped'));
    await act(async () => {
      result.current.updateEditableBuffer('ro-10', 'mod2\n');
      await result.current.prepareSave('ro-10', session);
      await result.current.executeSave('ro-10', session);
    });
    expect(result.current.documents[0]?.editState).toBe('outcomeUnknown');
    await act(async () => {
      expect(await result.current.cancelSavePreparation('ro-10')).toBe(false);
    });
    expect(result.current.documents[0]?.editState).toBe('outcomeUnknown');

    // disconnected
    act(() => {
      result.current.syncHostConnection('host-10', false, null, null);
    });
    const dcSession = makeSession('host-10b', 'hs-10b', 'sftp-10b');
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-10d', '/etc/dc-10.conf', 'base\n', dcSession),
    );
    await act(async () => {
      await result.current.openEditableDocument(dcSession, '/etc/dc-10.conf');
    });
    const dcTabId = result.current.documents[1]!.id;
    act(() => {
      result.current.syncHostConnection('host-10b', false, null, null);
    });
    expect(result.current.documents[1]?.editState).toBe('disconnected');
    await act(async () => {
      expect(await result.current.cancelSavePreparation(dcTabId)).toBe(false);
    });
    expect(result.current.documents[1]?.editState).toBe('disconnected');
  });

  it('11. maintains monotonic confirmed-save settlement across slow refresh, >5 poll errors, >3 missing polls, out-of-order/superseded responses, and disconnects (FINDING-06)', async () => {
    vi.useFakeTimers();
    const session = makeSession('host-11', 'hs-11', 'sftp-11');
    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });

    // Scenario A: completed save + slow openText + >5 poll errors + >3 missing polls + out-of-order non-terminal poll
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-11a', '/etc/m.conf', 'T0\n', session),
    );
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/m.conf');
    });
    const tabId = result.current.documents[0]!.id;
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'T1\n');
    });
    let resolveSlowRefresh!: (doc: RemoteTextDocument) => void;
    vi.mocked(filesApi.openText).mockImplementationOnce(
      () => new Promise((r) => { resolveSlowRefresh = r; }),
    );

    // Out-of-order poll: seq 1 resolves slowly with 'transferring' AFTER seq 2 resolves with 'completed'
    // Register transfers mock BEFORE executeSave triggers initial immediate poll on effect mount!
    let resolveStalePoll!: (jobs: TransferJob[]) => void;
    vi.mocked(filesApi.transfers)
      .mockImplementationOnce(() => new Promise((r) => { resolveStalePoll = r; }))
      .mockResolvedValueOnce([makeJob('job-11a', 'completed', session)])
      .mockRejectedValue(new Error('Poll failure'));

    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(makePlan('plan-11a', '/etc/m.conf', session));
    vi.mocked(filesApi.execute).mockResolvedValueOnce([makeJob('job-11a', 'transferring', session)]);
    await act(async () => {
      await result.current.prepareSave(tabId, session);
      await result.current.executeSave(tabId, session);
    });

    // Advance 400ms so seq 2 runs and completes the job synchronously while openText is still pending
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.documents[0]).toMatchObject({
      lastSaveOutcome: 'confirmed',
      editState: 'saveConfirmed',
      baselineText: 'T1\n',
    });

    // Stale non-terminal poll resolves after completion AND >5 poll errors fire while refresh awaits
    resolveStalePoll([makeJob('job-11a', 'transferring', session)]);
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(result.current.documents[0]?.lastSaveOutcome).toBe('confirmed');
      expect(result.current.documents[0]?.editState).toBe('saveConfirmed');
    }

    // Missing job polls (>3) + concurrent T2 edit during slow refresh -> still confirmed
    vi.mocked(filesApi.transfers).mockResolvedValue([]);
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'T2\n');
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(result.current.documents[0]?.lastSaveOutcome).toBe('confirmed');
    }

    resolveSlowRefresh(makeRemoteTextDoc('ed-11b', '/etc/m.conf', 'T1\n', session));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.documents[0]).toMatchObject({
      lastSaveOutcome: 'confirmed',
      baselineText: 'T1\n',
      draftText: 'T2\n',
      dirty: true,
      editState: 'editableModified',
      editDocumentId: 'ed-11b',
    });

    // Undo back to T1 -> clean while staying confirmed
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'T1\n');
    });
    expect(result.current.documents[0]).toMatchObject({
      dirty: false,
      editState: 'editableClean',
      lastSaveOutcome: 'confirmed',
    });

    // Scenario B: Superseded slow refresh after host disconnect must keep lastSaveOutcome: 'confirmed'
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(makePlan('plan-11b', '/etc/m.conf', session));
    vi.mocked(filesApi.execute).mockResolvedValueOnce([makeJob('job-11b', 'completed', session)]);
    let resolveSuperseded!: (doc: RemoteTextDocument) => void;
    vi.mocked(filesApi.openText).mockImplementationOnce(
      () => new Promise((r) => { resolveSuperseded = r; }),
    );
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'T3\n');
    });
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    let execSuperseded!: Promise<TransferJob | null>;
    await act(async () => {
      execSuperseded = result.current.executeSave(tabId, session);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.documents[0]?.lastSaveOutcome).toBe('confirmed');
    act(() => {
      result.current.syncHostConnection('host-11', false, null, null);
    });
    resolveSuperseded(makeRemoteTextDoc('ed-late-discard', '/etc/m.conf', 'T3\n', session));
    await act(async () => {
      await execSuperseded;
    });
    expect(filesApi.discardTextDocument).toHaveBeenCalledWith(expect.anything(), 'ed-late-discard');
    expect(result.current.documents[0]).toMatchObject({
      lastSaveOutcome: 'confirmed',
      editState: 'disconnected',
      baselineText: 'T3\n',
    });
    vi.useRealTimers();
  });

  it('12. isolates repeated save operations across all 10 Save #2 outcomes without freezing in saving (CG-01)', async () => {
    vi.useFakeTimers();
    const session = makeSession('host-12', 'hs-12', 'sftp-12');

    type CaseKind =
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'outcomeUnknown'
      | 'missingPolls'
      | 'pollErrors'
      | 'lostIpcNoJobId'
      | 'preDispatchPolicy'
      | 'conflict'
      | 'disconnectBeforeSettle';

    const cases: CaseKind[] = [
      'completed',
      'failed',
      'cancelled',
      'outcomeUnknown',
      'missingPolls',
      'pollErrors',
      'lostIpcNoJobId',
      'preDispatchPolicy',
      'conflict',
      'disconnectBeforeSettle',
    ];

    for (const kind of cases) {
      vi.clearAllMocks();
      vi.mocked(filesApi.discardEditorPlan).mockResolvedValue(true);
      vi.mocked(filesApi.discardTextDocument).mockResolvedValue(undefined);
      vi.mocked(filesApi.transfers).mockResolvedValue([]);

      const { result, unmount } = renderHook(() => useReadOnlyEditor(), { wrapper });
      vi.mocked(filesApi.openText)
        .mockResolvedValueOnce(makeRemoteTextDoc('ed-1', `/etc/${kind}.conf`, 'T0\n', session))
        .mockResolvedValueOnce(makeRemoteTextDoc('ed-2', `/etc/${kind}.conf`, 'T1\n', session));

      await act(async () => {
        await result.current.openEditableDocument(session, `/etc/${kind}.conf`);
      });
      const tabId = result.current.documents[0]!.id;

      // Save #1 completes -> baselineText = 'T1\n'
      await act(async () => {
        result.current.updateEditableBuffer(tabId, 'T1\n');
      });
      vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
        makePlan(`p1-${kind}`, `/etc/${kind}.conf`, session),
      );
      await act(async () => {
        await result.current.prepareSave(tabId, session);
      });
      vi.mocked(filesApi.execute).mockResolvedValueOnce([
        makeJob(`j1-${kind}`, 'completed', session),
      ]);
      await act(async () => {
        await result.current.executeSave(tabId, session);
      });
      expect(result.current.documents[0]?.lastSaveOutcome).toBe('confirmed');
      expect(result.current.documents[0]?.baselineText).toBe('T1\n');
      expect(result.current.documents[0]?.editDocumentId).toBe('ed-2');

      // Prepare Save #2 with T2\n
      await act(async () => {
        result.current.updateEditableBuffer(tabId, 'T2\n');
      });
      vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
        makePlan(`p2-${kind}`, `/etc/${kind}.conf`, session),
      );
      await act(async () => {
        await result.current.prepareSave(tabId, session);
      });

      if (kind === 'completed') {
        vi.mocked(filesApi.execute).mockResolvedValueOnce([
          makeJob(`j2-${kind}`, 'completed', session),
        ]);
        await act(async () => {
          await result.current.executeSave(tabId, session);
        });
        expect(result.current.documents[0]).toMatchObject({
          editState: 'saveConfirmed',
          lastSaveOutcome: 'confirmed',
          baselineText: 'T2\n',
          activeSaveOpId: null,
          activeTransferJobId: null,
        });
      } else if (kind === 'lostIpcNoJobId') {
        vi.mocked(filesApi.execute).mockRejectedValueOnce(new Error('IPC pipe broken'));
        await act(async () => {
          await result.current.executeSave(tabId, session);
        });
        expect(result.current.documents[0]).toMatchObject({
          editState: 'outcomeUnknown',
          lastSaveOutcome: 'outcomeUnknown',
          baselineText: 'T1\n',
          draftText: 'T2\n',
          activeSaveOpId: null,
          activeTransferJobId: null,
        });
      } else if (kind === 'preDispatchPolicy') {
        vi.mocked(filesApi.execute).mockRejectedValueOnce({
          code: 'filePolicy',
          message: 'Policy denied',
          hostKey: null,
        });
        await act(async () => {
          await result.current.executeSave(tabId, session);
        });
        expect(result.current.documents[0]).toMatchObject({
          editState: 'saveFailed',
          lastSaveOutcome: 'failed',
          baselineText: 'T1\n',
          activeSaveOpId: null,
        });
      } else if (kind === 'conflict') {
        vi.mocked(filesApi.execute).mockRejectedValueOnce({
          code: 'conflict',
          message: 'Revision mismatch',
          hostKey: null,
        });
        await act(async () => {
          await result.current.executeSave(tabId, session);
        });
        expect(result.current.documents[0]).toMatchObject({
          editState: 'conflictDetected',
          lastSaveOutcome: 'conflict',
          baselineText: 'T1\n',
          activeSaveOpId: null,
        });
      } else {
        vi.mocked(filesApi.execute).mockResolvedValueOnce([
          makeJob(`j2-${kind}`, 'transferring', session),
        ]);
        await act(async () => {
          await result.current.executeSave(tabId, session);
        });
        // Delayed Save #1 terminal event during Save #2 MUST be ignored!
        await act(async () => {
          result.current.syncTransfers([makeJob(`j1-${kind}`, 'completed', session)]);
        });
        expect(result.current.documents[0]?.editState).toBe('saving');

        if (kind === 'failed' || kind === 'cancelled' || kind === 'outcomeUnknown') {
          vi.mocked(filesApi.transfers).mockResolvedValueOnce([
            makeJob(`j2-${kind}`, kind, session),
          ]);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
          });
          // Duplicate terminal observation stays idempotent
          await act(async () => {
            result.current.syncTransfers([makeJob(`j2-${kind}`, 'completed', session)]);
          });
          const expectedState = kind === 'outcomeUnknown' ? 'outcomeUnknown' : 'saveFailed';
          const expectedOutcome = kind === 'outcomeUnknown' ? 'outcomeUnknown' : 'failed';
          expect(result.current.documents[0]).toMatchObject({
            editState: expectedState,
            lastSaveOutcome: expectedOutcome,
            baselineText: 'T1\n',
            activeSaveOpId: null,
            activeTransferJobId: null,
          });
        } else if (kind === 'missingPolls') {
          vi.mocked(filesApi.transfers).mockResolvedValue([]);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
          });
          expect(result.current.documents[0]).toMatchObject({
            editState: 'outcomeUnknown',
            lastSaveOutcome: 'outcomeUnknown',
            baselineText: 'T1\n',
            activeSaveOpId: null,
          });
        } else if (kind === 'pollErrors') {
          vi.mocked(filesApi.transfers).mockRejectedValue(new Error('poll timeout'));
          await act(async () => {
            await vi.advanceTimersByTimeAsync(2200);
          });
          expect(result.current.documents[0]).toMatchObject({
            editState: 'outcomeUnknown',
            lastSaveOutcome: 'outcomeUnknown',
            baselineText: 'T1\n',
            activeSaveOpId: null,
          });
        } else if (kind === 'disconnectBeforeSettle') {
          act(() => {
            result.current.syncHostConnection('host-12', false, null, null);
          });
          expect(result.current.documents[0]).toMatchObject({
            editState: 'outcomeUnknown',
            lastSaveOutcome: 'outcomeUnknown',
            disconnected: true,
            baselineText: 'T1\n',
            activeSaveOpId: null,
            activeTransferJobId: null,
          });
        }
      }

      // Recoverable Save #2 failures permit reload + Save #3
      if (kind === 'failed' || kind === 'preDispatchPolicy') {
        vi.mocked(filesApi.openText).mockResolvedValueOnce(
          makeRemoteTextDoc('ed-3', `/etc/${kind}.conf`, 'T1\n', session),
        );
        await act(async () => {
          await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true });
        });
        await act(async () => {
          result.current.updateEditableBuffer(tabId, 'T3\n');
        });
        vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
          makePlan(`p3-${kind}`, `/etc/${kind}.conf`, session),
        );
        vi.mocked(filesApi.execute).mockResolvedValueOnce([
          makeJob(`j3-${kind}`, 'completed', session),
        ]);
        vi.mocked(filesApi.openText).mockResolvedValueOnce(
          makeRemoteTextDoc('ed-4', `/etc/${kind}.conf`, 'T3\n', session),
        );
        await act(async () => {
          await result.current.prepareSave(tabId, session);
          await result.current.executeSave(tabId, session);
        });
        expect(result.current.documents[0]?.baselineText).toBe('T3\n');
        expect(result.current.documents[0]?.lastSaveOutcome).toBe('confirmed');
        // Concurrent local edit + Undo back to T3\n
        await act(async () => {
          result.current.updateEditableBuffer(tabId, 'T4-draft\n');
          result.current.updateEditableBuffer(tabId, 'T3\n');
        });
        expect(result.current.documents[0]?.dirty).toBe(false);
        expect(result.current.documents[0]?.editState).toBe('editableClean');
      }

      unmount();
    }
    vi.useRealTimers();
  });

  it('13. preserves unreleasedAuthoritiesRef across repeated same-session syncs and enforces MAX_UNRESOLVED_AUTHORITY_FENCES (CG-03)', async () => {
    const session = makeSession('host-13', 'hs-13', 'sftp-13');
    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });

    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-13a', '/etc/fence-a.conf', 'A\n', session),
    );
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/fence-a.conf');
    });
    const tabA = result.current.documents[0]!.id;
    await act(async () => {
      result.current.updateEditableBuffer(tabA, 'A1\n');
    });
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('p-13a', '/etc/fence-a.conf', session),
    );
    await act(async () => {
      await result.current.prepareSave(tabA, session);
    });
    vi.mocked(filesApi.execute).mockRejectedValueOnce(new Error('IPC lost'));
    await act(async () => {
      await result.current.executeSave(tabA, session);
    });
    await act(async () => {
      expect(result.current.closeDocument(tabA, { confirmDiscard: true })).toBe(true);
    });

    // Repeated same-session syncHostConnection MUST be strictly idempotent
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        result.current.syncHostConnection('host-13', true, session.hostSessionId, session.id);
      });
      expect(result.current.hasActiveEditAuthority(session, '/etc/fence-a.conf')).toBe(true);
      expect(result.current.canPurgeHost('host-13').allowed).toBe(false);
      expect(result.current.reserveExternalEdit(session, '/etc/fence-a.conf')).toBeNull();
    }

    // Actual FilesWorkspace useEffect([registry]) re-sync mirror preserves fence across close/host switch/Close All
    let mirrorRegistry!: ReturnType<typeof useReadOnlyEditor>;
    function FilesWorkspaceSyncMirror() {
      const reg = useReadOnlyEditor();
      mirrorRegistry = reg;
      useEffect(() => {
        reg.syncHostConnection(session.hostId, true, session.hostSessionId, session.id);
      }, [reg]);
      return null;
    }
    const mirrorView = render(
      <ReadOnlyEditorProvider>
        <FilesWorkspaceSyncMirror />
      </ReadOnlyEditorProvider>,
    );
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-13-m1', '/etc/mirror-ambig.conf', 'M0\n', session),
    );
    await act(async () => {
      await mirrorRegistry.openEditableDocument(session, '/etc/mirror-ambig.conf');
    });
    const mId1 = mirrorRegistry.documents[0]!.id;
    await act(async () => {
      mirrorRegistry.updateEditableBuffer(mId1, 'M1\n');
    });
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('p-13-m1', '/etc/mirror-ambig.conf', session),
    );
    await act(async () => {
      await mirrorRegistry.prepareSave(mId1, session);
    });
    vi.mocked(filesApi.execute).mockRejectedValueOnce(new Error('IPC lost'));
    await act(async () => {
      await mirrorRegistry.executeSave(mId1, session);
    });
    await act(async () => {
      expect(mirrorRegistry.closeHostDocuments('host-13', { confirmDiscard: true })).toBe(true);
    });
    // Closing via Close All triggers FilesWorkspaceSyncMirror re-sync on same live session -> fence MUST stay intact!
    expect(mirrorRegistry.hasActiveEditAuthority(session, '/etc/mirror-ambig.conf')).toBe(true);
    expect(mirrorRegistry.canPurgeHost('host-13').allowed).toBe(false);
    mirrorView.unmount();

    // Stale discard resolution from earlier document does not clear a newer fence on a failed close
    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-13b', '/etc/fence-b.conf', 'B\n', session),
    );
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/fence-b.conf');
    });
    const tabB = result.current.documents[0]!.id;
    vi.mocked(filesApi.discardTextDocument).mockRejectedValueOnce(new Error('discard failed'));
    await act(async () => {
      expect(result.current.closeDocument(tabB, { confirmDiscard: true })).toBe(true);
      await Promise.resolve();
    });
    act(() => {
      result.current.syncHostConnection('host-13', true, session.hostSessionId, session.id);
    });
    expect(result.current.hasActiveEditAuthority(session, '/etc/fence-b.conf')).toBe(true);
    expect(result.current.getLifecycleDiagnostics().unresolvedAuthorityFences).toBe(2);

    // Replacing SFTP channel retires old session fences cleanly
    const session2 = makeSession('host-13', 'hs-13', 'sftp-13-new');
    act(() => {
      result.current.syncHostConnection('host-13', true, session2.hostSessionId, session2.id);
    });
    expect(result.current.hasActiveEditAuthority(session2, '/etc/fence-a.conf')).toBe(false);
    expect(result.current.getLifecycleDiagnostics().unresolvedAuthorityFences).toBe(0);
    expect(result.current.canPurgeHost('host-13').allowed).toBe(true);

    // Conservative budget cap (64): 64 unresolved fences block opening #65 without evicting any of the 64!
    for (let i = 0; i < 64; i += 1) {
      const path = `/etc/budget-${i}.conf`;
      vi.mocked(filesApi.openText).mockResolvedValueOnce(
        makeRemoteTextDoc(`ed-b-${i}`, path, 'x\n', session2),
      );
      await act(async () => {
        await result.current.openEditableDocument(session2, path);
      });
      const id = result.current.documents[0]!.id;
      vi.mocked(filesApi.discardTextDocument).mockRejectedValueOnce(new Error('sticky discard'));
      await act(async () => {
        expect(result.current.closeDocument(id, { confirmDiscard: true })).toBe(true);
        await Promise.resolve();
      });
    }
    expect(result.current.getLifecycleDiagnostics().unresolvedAuthorityFences).toBe(64);
    expect(result.current.reserveExternalEdit(session2, '/etc/budget-64.conf')).toBeNull();
    let denied65: unknown = 'not-null';
    await act(async () => {
      denied65 = await result.current.openEditableDocument(session2, '/etc/budget-64.conf');
    });
    expect(denied65).toBeNull();
    // Existing fence #0 was NOT evicted
    expect(result.current.hasActiveEditAuthority(session2, '/etc/budget-0.conf')).toBe(true);
    expect(result.current.getLifecycleDiagnostics().unresolvedAuthorityFences).toBe(64);
  });

  it('14. serializes post-save refresh and bounds settledJobHistoryRef across 1,000 saves + adversarial delayed events (CG-04)', async () => {
    const session = makeSession('host-14', 'hs-14', 'sftp-14');
    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });

    vi.mocked(filesApi.openText).mockResolvedValueOnce(
      makeRemoteTextDoc('ed-14-0', '/etc/thousand.conf', 'v0\n', session),
    );
    await act(async () => {
      await result.current.openEditableDocument(session, '/etc/thousand.conf');
    });
    const tabId = result.current.documents[0]!.id;

    // 1) Serialize pending post-save refresh vs reloadDocument / closeDocument / prepareSave / canPurgeHost
    let resolvePendingRefresh!: (doc: RemoteTextDocument) => void;
    vi.mocked(filesApi.openText).mockImplementationOnce(
      () => new Promise((r) => { resolvePendingRefresh = r; }),
    );
    await act(async () => {
      result.current.updateEditableBuffer(tabId, 'v1\n');
    });
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
      makePlan('p-14-r', '/etc/thousand.conf', session),
    );
    vi.mocked(filesApi.execute).mockResolvedValueOnce([
      makeJob('job-14-r', 'completed', session),
    ]);
    await act(async () => {
      await result.current.prepareSave(tabId, session);
    });
    let execP!: Promise<TransferJob | null>;
    await act(async () => {
      execP = result.current.executeSave(tabId, session);
      await Promise.resolve();
    });
    expect(result.current.documents[0]?.refreshPending).toBe(true);
    expect(result.current.documents[0]?.lastSaveOutcome).toBe('confirmed');
    expect(result.current.closeDocument(tabId, { confirmDiscard: true })).toBe(false);
    expect(result.current.canPurgeHost('host-14').allowed).toBe(false);
    expect(result.current.hasActiveEditAuthority(session, '/etc/thousand.conf')).toBe(true);
    expect(result.current.reserveExternalEdit(session, '/etc/thousand.conf')).toBeNull();
    await act(async () => {
      expect(await result.current.reloadDocument(tabId, session, { allowDirtyDiscard: true })).toBeNull();
      expect(await result.current.prepareSave(tabId, session)).toBeNull();
    });
    resolvePendingRefresh(makeRemoteTextDoc('ed-14-1', '/etc/thousand.conf', 'v1\n', session));
    await act(async () => {
      await execP;
    });
    expect(result.current.documents[0]?.refreshPending).toBe(false);

    // 2) 1,000 sequential simulated saves stay bounded <= 256 & ignore evicted delayed job events
    for (let i = 1; i <= 1000; i += 1) {
      const nextText = `v${i}\n`;
      await act(async () => {
        result.current.updateEditableBuffer(tabId, nextText);
      });
      vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(
        makePlan(`p-1k-${i}`, '/etc/thousand.conf', session),
      );
      vi.mocked(filesApi.execute).mockResolvedValueOnce([
        makeJob(`j-1k-${i}`, 'completed', session),
      ]);
      vi.mocked(filesApi.openText).mockResolvedValueOnce(
        makeRemoteTextDoc(`ed-1k-${i}`, '/etc/thousand.conf', nextText, session),
      );
      await act(async () => {
        await result.current.prepareSave(tabId, session);
        await result.current.executeSave(tabId, session);
      });
    }

    // Inject delayed adversarial events for evicted early jobs well past the 256 FIFO window
    const openCallsBeforeAdversarial = vi.mocked(filesApi.openText).mock.calls.length;
    await act(async () => {
      result.current.syncTransfers([
        makeJob('j-1k-1', 'failed', session),
        makeJob('j-1k-50', 'outcomeUnknown', session),
        makeJob('j-1k-1000', 'completed', session),
      ]);
    });
    expect(vi.mocked(filesApi.openText).mock.calls.length).toBe(openCallsBeforeAdversarial);

    const diag = result.current.getLifecycleDiagnostics();
    expect(diag.activeSaveAttempts).toBe(0);
    expect(diag.activeRefreshes).toBe(0);
    expect(diag.unresolvedAuthorityFences).toBe(0);
    expect(diag.settledJobHistorySize).toBeLessThanOrEqual(256);
    expect(diag.peakSettledJobHistorySize).toBeLessThanOrEqual(256);
    expect(result.current.documents[0]).toMatchObject({
      baselineText: 'v1000\n',
      lastSaveOutcome: 'confirmed',
      editState: 'saveConfirmed',
    });
  });
});
