import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FileOperationPlan,
  RemoteReadOnlyDocument,
  RemoteTextDocument,
  SftpSessionInfo,
  TransferJob,
} from '@ubgops/protocol';
import { filesApi } from '../../api/client';
import { MAX_UNRESOLVED_AUTHORITY_FENCES, MAX_SETTLED_JOB_HISTORY } from './editorLifecycle';
import { ReadOnlyEditorProvider, useReadOnlyEditor } from './ReadOnlyEditorRegistry';
import { MAX_EDITOR_PAYLOAD_BYTES } from './textCodec';

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

function makeSession(hostId = 'host-sm', hostSessionId = 'hs-1', id = 'sftp-1'): SftpSessionInfo {
  return {
    id,
    hostId,
    hostSessionId,
    protocolVersion: 3,
    extensions: [{ name: 'posix-rename@openssh.com', version: '1' }],
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

function makeRo(id: string, path: string, text: string, session: SftpSessionInfo): RemoteReadOnlyDocument {
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
    modifiedAt: null,
    permissions: '-rw-r--r--',
  };
}

function makeEd(id: string, path: string, text: string, session: SftpSessionInfo): RemoteTextDocument {
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
    items: [{ sourceDisplay: 'Edited text', destinationDisplay: path, sizeBytes: '10' }],
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
    destinationDisplay: '/etc/sm.conf',
    state,
    confirmedBytes: '10',
    totalBytes: '10',
    error,
    retryable: false,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <ReadOnlyEditorProvider>{children}</ReadOnlyEditorProvider>
);

describe('EditorLifecycleStateMachine deterministic transitions & invariants (Task 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(filesApi.discardEditorPlan).mockResolvedValue(true);
    vi.mocked(filesApi.discardTextDocument).mockResolvedValue(undefined);
    vi.mocked(filesApi.cancelReadOnlyOpen).mockResolvedValue(true);
    vi.mocked(filesApi.transfers).mockResolvedValue([]);
  });

  function assertAllInvariants(
    api: ReturnType<typeof useReadOnlyEditor>,
    session: SftpSessionInfo,
  ) {
    // 1. At most one active non-disconnected tab / mutation attempt per destination on a live session
    const livePaths = new Set<string>();
    for (const doc of api.documents) {
      // 2. Dirty state reflects exact text equality
      expect(doc.dirty).toBe(doc.draftText !== doc.baselineText);

      // 3. Unknown settlement never retains usable write authority or savePlan
      if (doc.editState === 'outcomeUnknown' || doc.lastSaveOutcome === 'outcomeUnknown') {
        expect(doc.editDocumentId).toBeNull();
        expect(doc.savePlan).toBeNull();
        expect(doc.staleRevision).toBe(true);
        if (doc.retainedAuthority) {
          expect(doc.retainedAuthority.usable).toBe(false);
        }
      }

      // 4. Every usable authority is owned cleanly and matches editDocumentId
      if (doc.editDocumentId !== null) {
        expect(doc.retainedAuthority).not.toBeNull();
        expect(doc.retainedAuthority?.documentId).toBe(doc.editDocumentId);
        expect(doc.retainedAuthority?.usable).toBe(true);
        expect(doc.retainedAuthority?.ownershipState).toBe('active');
      }

      // 5. Unique non-disconnected tab per session+path
      if (!doc.disconnected && doc.hostId === session.hostId && doc.sftpSessionId === session.id) {
        expect(livePaths.has(doc.path)).toBe(false);
        livePaths.add(doc.path);
      }

      // 6. Active save implies no active refresh at the same time
      if (doc.activeSaveOpId !== null) {
        expect(doc.refreshPending).toBe(false);
        expect(doc.editState).toBe('saving');
      }
      if (doc.refreshPending) {
        expect(doc.activeSaveOpId).toBeNull();
        expect(doc.editDocumentId).toBeNull();
      }
    }

    // 7. Bounded active and historical registries
    const diag = api.getLifecycleDiagnostics();
    expect(diag.settledJobHistorySize).toBeLessThanOrEqual(MAX_SETTLED_JOB_HISTORY);
    expect(diag.unresolvedAuthorityFences).toBeLessThanOrEqual(MAX_UNRESOLVED_AUTHORITY_FENCES);
  }

  it('verifies legal and illegal table-driven transitions across deferred barriers', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });

    vi.mocked(filesApi.openReadOnly).mockResolvedValueOnce(makeRo('sm-1', '/etc/sm.conf', 'T0\n', session));
    await act(async () => {
      await result.current.openDocument(session, '/etc/sm.conf');
    });
    assertAllInvariants(result.current, session);

    // Illegal transitions from readOnly: prepareSave, cancelSavePreparation, executeSave all no-op
    await act(async () => {
      expect(await result.current.prepareSave('sm-1', session)).toBeNull();
      expect(await result.current.cancelSavePreparation('sm-1')).toBe(false);
      expect(await result.current.executeSave('sm-1', session)).toBeNull();
    });
    expect(result.current.documents[0]?.editState).toBe('readOnly');
    assertAllInvariants(result.current, session);

    // Promote -> openingForEdit barrier
    let resolvePromo!: (d: RemoteTextDocument) => void;
    vi.mocked(filesApi.openText).mockImplementationOnce(
      () => new Promise((r) => { resolvePromo = r; }),
    );
    let promoP!: Promise<unknown>;
    await act(async () => {
      promoP = result.current.promoteToEditable('sm-1', session);
    });
    expect(result.current.documents[0]?.editState).toBe('openingForEdit');
    expect(result.current.closeDocument('sm-1', { confirmDiscard: true })).toBe(false);
    resolvePromo(makeEd('ed-1', '/etc/sm.conf', 'T0\n', session));
    await act(async () => {
      await promoP;
    });
    expect(result.current.documents[0]?.editState).toBe('editableClean');
    assertAllInvariants(result.current, session);

    // Edit -> Prepare -> Execute (barrier on execute) -> Poll -> Settle -> Refresh barrier
    await act(async () => {
      result.current.updateEditableBuffer('sm-1', 'T1\n');
    });
    vi.mocked(filesApi.planTextSave).mockResolvedValueOnce(makePlan('p-1', '/etc/sm.conf', session));
    await act(async () => {
      await result.current.prepareSave('sm-1', session);
    });
    expect(result.current.documents[0]?.editState).toBe('savePreparation');

    let resolveExec!: (jobs: TransferJob[]) => void;
    vi.mocked(filesApi.execute).mockImplementationOnce(
      () => new Promise((r) => { resolveExec = r; }),
    );
    let execP!: Promise<unknown>;
    await act(async () => {
      execP = result.current.executeSave('sm-1', session);
    });
    expect(result.current.documents[0]?.editState).toBe('saving');
    // Illegal overlapping operations during saving
    await act(async () => {
      expect(await result.current.prepareSave('sm-1', session)).toBeNull();
      expect(await result.current.cancelSavePreparation('sm-1')).toBe(false);
      expect(await result.current.reloadDocument('sm-1', session, { allowDirtyDiscard: true })).toBeNull();
      expect(result.current.closeDocument('sm-1', { confirmDiscard: true })).toBe(false);
    });
    assertAllInvariants(result.current, session);

    resolveExec([makeJob('j-1', 'transferring', session)]);
    await act(async () => {
      await execP;
    });
    assertAllInvariants(result.current, session);

    // Poll -> Completed -> Refresh pending barrier -> Concurrent T2 edit -> Refresh completes
    let resolveRefresh!: (d: RemoteTextDocument) => void;
    vi.mocked(filesApi.openText).mockImplementationOnce(
      () => new Promise((r) => { resolveRefresh = r; }),
    );
    vi.mocked(filesApi.transfers).mockResolvedValueOnce([makeJob('j-1', 'completed', session)]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.documents[0]?.lastSaveOutcome).toBe('confirmed');
    expect(result.current.documents[0]?.refreshPending).toBe(true);
    assertAllInvariants(result.current, session);

    // Overlapping reload/close/prepare blocked while refreshPending; local draft edit allowed
    await act(async () => {
      result.current.updateEditableBuffer('sm-1', 'T2\n');
      expect(await result.current.reloadDocument('sm-1', session, { allowDirtyDiscard: true })).toBeNull();
      expect(result.current.closeDocument('sm-1', { confirmDiscard: true })).toBe(false);
      expect(await result.current.prepareSave('sm-1', session)).toBeNull();
    });
    assertAllInvariants(result.current, session);

    resolveRefresh(makeEd('ed-2', '/etc/sm.conf', 'T1\n', session));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.documents[0]?.refreshPending).toBe(false);
    expect(result.current.documents[0]?.editDocumentId).toBe('ed-2');
    expect(result.current.documents[0]?.draftText).toBe('T2\n');
    expect(result.current.documents[0]?.baselineText).toBe('T1\n');
    expect(result.current.documents[0]?.dirty).toBe(true);
    assertAllInvariants(result.current, session);
    vi.useRealTimers();
  });

  it('exercises seeded random interleaved multi-operation transition sequences without violating invariants', async () => {
    const rng = mulberry32(20261128);
    let sessionIdx = 1;
    let session = makeSession('host-fuzz', `hs-${sessionIdx}`, `sftp-${sessionIdx}`);
    const backendAuthorities = new Map<string, string>();
    let seq = 0;

    vi.mocked(filesApi.openText).mockImplementation(async (s, path) => {
      const key = `${s.hostId}:${s.hostSessionId}:${s.id}:${path}`;
      if (backendAuthorities.has(key)) {
        throw { code: 'conflict', message: 'Authority already exists', hostKey: null };
      }
      const id = `ed-fuzz-${++seq}`;
      backendAuthorities.set(key, id);
      return makeEd(id, path, `remote-${seq}\n`, { ...session, ...s });
    });
    vi.mocked(filesApi.discardTextDocument).mockImplementation(async (s, docId) => {
      if (rng() < 0.25) {
        throw { code: 'connection', message: 'transient discard error', hostKey: null };
      }
      for (const [k, v] of backendAuthorities.entries()) {
        if (v === docId && k.startsWith(`${s.hostId}:${s.hostSessionId}:${s.id}:`)) {
          backendAuthorities.delete(k);
        }
      }
    });
    vi.mocked(filesApi.planTextSave).mockImplementation(async (s, docId, text) => {
      void docId;
      void text;
      if (rng() < 0.2) {
        throw { code: 'conflict', message: 'Remote conflict', hostKey: null };
      }
      return makePlan(`plan-fuzz-${++seq}`, '/etc/fuzz.conf', { ...session, ...s });
    });
    vi.mocked(filesApi.execute).mockImplementation(async (s) => {
      const r = rng();
      if (r < 0.2) {
        throw { code: 'filePolicy', message: 'Policy reject', hostKey: null };
      }
      if (r < 0.35) {
        throw { code: 'outcomeUnknown', message: 'IPC dropped', hostKey: null };
      }
      const jid = `job-fuzz-${++seq}`;
      const terminal = r < 0.55 ? 'failed' : r < 0.7 ? 'cancelled' : 'completed';
      return [makeJob(jid, terminal, { ...session, ...s })];
    });

    const { result } = renderHook(() => useReadOnlyEditor(), { wrapper });

    for (let step = 0; step < 80; step++) {
      const op = Math.floor(rng() * 8);
      const doc = result.current.documents[0] ?? null;
      if (op === 0 || !doc) {
        await act(async () => {
          await result.current.openEditableDocument(session, '/etc/fuzz.conf');
        });
      } else if (op === 1) {
        await act(async () => {
          result.current.updateEditableBuffer(doc.id, `draft-step-${step}\n`);
        });
      } else if (op === 2) {
        await act(async () => {
          await result.current.prepareSave(doc.id, session);
        });
      } else if (op === 3) {
        await act(async () => {
          await result.current.cancelSavePreparation(doc.id);
        });
      } else if (op === 4) {
        await act(async () => {
          await result.current.executeSave(doc.id, session);
        });
      } else if (op === 5) {
        await act(async () => {
          await result.current.reloadDocument(doc.id, session, { allowDirtyDiscard: true });
        });
      } else if (op === 6) {
        await act(async () => {
          result.current.closeDocument(doc.id, { confirmDiscard: true });
        });
      } else {
        // Re-sync live session or rotate session cleanly
        if (rng() < 0.4) {
          sessionIdx += 1;
          backendAuthorities.clear();
          session = makeSession('host-fuzz', `hs-${sessionIdx}`, `sftp-${sessionIdx}`);
        }
        await act(async () => {
          result.current.syncHostConnection('host-fuzz', true, session.hostSessionId, session.id);
        });
      }
      assertAllInvariants(result.current, session);
    }
  });
});
