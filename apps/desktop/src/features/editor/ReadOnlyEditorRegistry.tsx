import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  FileOperationPlan,
  SftpSessionInfo,
  TextNewline,
  TransferJob,
} from '@ubgops/protocol';
import { applicationError, filesApi } from '../../api/client';
import { detectRemoteFileLanguage, getLanguageById } from './languageDetection';
import { MAX_EDITOR_PAYLOAD_BYTES, validateEditableText } from './textCodec';

export const MAX_READONLY_DOCUMENTS = 8;
export const MAX_EDITOR_DOCUMENTS = MAX_READONLY_DOCUMENTS;
export const MAX_READONLY_BYTES = MAX_EDITOR_PAYLOAD_BYTES;

const TRANSFER_POLL_INTERVAL_MS = 350;
const MAX_CONSECUTIVE_POLL_ERRORS = 5;
const MAX_MISSING_JOB_POLLS = 3;

export type DocumentEditState =
  | 'readOnly'
  | 'openingForEdit'
  | 'editableClean'
  | 'editableModified'
  | 'savePreparation'
  | 'cancellingSave'
  | 'saving'
  | 'saveConfirmed'
  | 'conflictDetected'
  | 'saveFailed'
  | 'outcomeUnknown'
  | 'disconnected';

export type SaveOutcomeStatus = 'none' | 'confirmed' | 'failed' | 'conflict' | 'outcomeUnknown';

export interface SavePlanState {
  readonly session: Pick<SftpSessionInfo, 'hostId' | 'hostSessionId' | 'id'>;
  readonly plan: FileOperationPlan;
  readonly snapshotText: string;
  readonly bufferGeneration: number;
}

export interface UnsavedWorkSummary {
  readonly dirtyCount: number;
  readonly inFlightSaveCount: number;
  readonly outcomeUnknownCount: number;
  readonly hostIdsWithUnsavedWork: readonly string[];
}

export interface ReadOnlyDocumentTab {
  readonly id: string;
  readonly hostId: string;
  readonly hostSessionId: string;
  readonly sftpSessionId: string;
  readonly path: string;
  readonly displayName: string;
  readonly text: string;
  readonly originalBytes: number;
  readonly newline: TextNewline;
  readonly bom: boolean;
  readonly maxBytes: number;
  readonly modifiedAt: string | null;
  readonly permissions: string | null;
  readonly languageId: string;
  readonly languageLabel: string;
  readonly disconnected: boolean;
  readonly editable: boolean;
  readonly editState: DocumentEditState;
  readonly lastSaveOutcome: SaveOutcomeStatus;
  readonly editDocumentId: string | null;
  readonly baselineText: string;
  readonly draftText: string;
  readonly dirty: boolean;
  readonly bufferGeneration: number;
  readonly modelRevision: number;
  readonly savePlan: SavePlanState | null;
  readonly activeTransferJobId: string | null;
  readonly editError: string | null;
  readonly staleRevision: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly lastSavedAt: string | null;
}

export interface PendingReadOnlyOpen {
  readonly requestId: string;
  readonly hostId: string;
  readonly hostSessionId: string;
  readonly sftpSessionId: string;
  readonly path: string;
}

export type SessionOwnerTuple = Pick<SftpSessionInfo, 'hostId' | 'hostSessionId' | 'id'>;

type ModelDisposer = (documentId: string) => void;

let registeredModelDisposer: ModelDisposer | null = null;

export function registerReadOnlyModelDisposer(disposer: ModelDisposer | null): void {
  registeredModelDisposer = disposer;
}

function disposeRetainedModel(documentId: string): void {
  registeredModelDisposer?.(documentId);
}

interface InternalPendingOpen extends PendingReadOnlyOpen {
  readonly session: SessionOwnerTuple;
  cancelled: boolean;
}

interface InternalPendingEditOpen {
  readonly requestKey: string;
  readonly targetTabId: string | null;
  readonly session: SessionOwnerTuple;
  readonly path: string;
  cancelled: boolean;
}

interface InternalInFlightSave {
  readonly session: SessionOwnerTuple;
  readonly planId: string;
  readonly jobId: string;
  readonly snapshotText: string;
  readonly snapshotGeneration: number;
  readonly prevEditDocumentId: string | null;
}

interface RegistryApi {
  readonly documents: readonly ReadOnlyDocumentTab[];
  readonly pendingOpens: readonly PendingReadOnlyOpen[];
  readonly activeByHost: Readonly<Record<string, string | null>>;
  readonly errorsByHost: Readonly<Record<string, string | null>>;
  readonly openDocument: (
    session: SftpSessionInfo,
    path: string,
  ) => Promise<ReadOnlyDocumentTab | null>;
  readonly openEditableDocument: (
    session: SftpSessionInfo,
    path: string,
  ) => Promise<ReadOnlyDocumentTab | null>;
  readonly promoteToEditable: (
    documentId: string,
    session: SftpSessionInfo,
  ) => Promise<ReadOnlyDocumentTab | null>;
  readonly updateEditableBuffer: (
    documentId: string,
    nextLfText: string,
    undoRedo?: { canUndo: boolean; canRedo: boolean },
  ) => void;
  readonly prepareSave: (
    documentId: string,
    session: SftpSessionInfo,
  ) => Promise<FileOperationPlan | null>;
  readonly cancelSavePreparation: (documentId: string) => Promise<boolean>;
  readonly executeSave: (
    documentId: string,
    session: SftpSessionInfo,
  ) => Promise<TransferJob | null>;
  readonly reloadDocument: (
    documentId: string,
    session: SftpSessionInfo,
    options?: { allowDirtyDiscard?: boolean },
  ) => Promise<ReadOnlyDocumentTab | null>;
  readonly discardChanges: (documentId: string) => Promise<boolean>;
  readonly syncTransfers: (jobs: readonly TransferJob[]) => void;
  readonly reserveExternalEdit: (owner: SessionOwnerTuple, path: string) => string | null;
  readonly commitExternalEdit: (reservationId: string, externalDocumentId: string) => boolean;
  readonly releaseExternalEdit: (id: string) => void;
  readonly registerExternalEdit: (
    owner: SessionOwnerTuple,
    path: string,
    externalDocumentId: string,
  ) => boolean;
  readonly unregisterExternalEdit: (externalDocumentId: string) => void;
  readonly hasActiveEditAuthority: (owner: SessionOwnerTuple, path: string) => boolean;
  readonly canCloseTab: (documentId: string) => { allowed: boolean; reason: string | null };
  readonly canPurgeHost: (hostId: string) => { allowed: boolean; reason: string | null };
  readonly getUnsavedWorkSummary: () => UnsavedWorkSummary;
  readonly cancelOpen: (hostId: string, requestId: string) => Promise<void>;
  readonly selectDocument: (hostId: string, documentId: string) => void;
  readonly setDocumentLanguage: (documentId: string, languageId: string) => void;
  readonly closeDocument: (documentId: string, options?: { confirmDiscard?: boolean }) => boolean;
  readonly closeHostDocuments: (hostId: string, options?: { confirmDiscard?: boolean }) => boolean;
  readonly clearHostError: (hostId: string) => void;
  readonly syncHostConnection: (
    hostId: string,
    connected: boolean,
    hostSessionId: string | null,
    sftpSessionId: string | null,
  ) => void;
  readonly purgeHost: (hostId: string) => void;
}

const ReadOnlyEditorContext = createContext<RegistryApi | null>(null);

function nextRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `ro-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sanitizeDisplayText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 ||
        code === 127 ||
        code === 0x061c ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
        ? `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`
        : character;
    })
    .join('');
}

function displayNameFromPath(path: string): string {
  const trimmed = path.trimEnd();
  const slash = trimmed.lastIndexOf('/');
  const base = slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : path;
  return sanitizeDisplayText(base);
}

function sameSessionTuple(
  left: { hostId: string; hostSessionId: string; sftpSessionId: string },
  right: { hostId: string; hostSessionId: string; sftpSessionId: string },
): boolean {
  return (
    left.hostId === right.hostId &&
    left.hostSessionId === right.hostSessionId &&
    left.sftpSessionId === right.sftpSessionId
  );
}

function ownerTuple(session: SessionOwnerTuple): SessionOwnerTuple {
  return {
    hostId: session.hostId,
    hostSessionId: session.hostSessionId,
    id: session.id,
  };
}

function tabSession(
  tab: Pick<ReadOnlyDocumentTab, 'hostId' | 'hostSessionId' | 'sftpSessionId'>,
): SessionOwnerTuple {
  return {
    hostId: tab.hostId,
    hostSessionId: tab.hostSessionId,
    id: tab.sftpSessionId,
  };
}

function unbypassableCloseReason(doc: ReadOnlyDocumentTab): string | null {
  if (doc.editState === 'openingForEdit') {
    return 'Wait for the file to finish opening for edit before closing this tab.';
  }
  if (doc.editState === 'savePreparation') {
    return 'Cancel save preparation or complete saving before closing this tab.';
  }
  if (doc.editState === 'cancellingSave') {
    return 'Wait for save cancellation to settle before closing this tab.';
  }
  if (doc.editState === 'saving') {
    return 'A remote save transfer is currently in progress. Wait for it to settle before closing.';
  }
  return null;
}

function closureGuardReason(doc: ReadOnlyDocumentTab): string | null {
  const activeAsync = unbypassableCloseReason(doc);
  if (activeAsync) return activeAsync;
  if (doc.editState === 'outcomeUnknown' || doc.lastSaveOutcome === 'outcomeUnknown') {
    return 'The outcome of the last remote save could not be confirmed. Reload or explicitly confirm discarding before closing this tab.';
  }
  if (doc.dirty) {
    return 'This document has unsaved changes. Save, discard changes, or explicitly confirm discarding before closing this tab.';
  }
  return null;
}

function isWriteAuthorityActiveOnTab(doc: ReadOnlyDocumentTab): boolean {
  return (
    !doc.disconnected &&
    (doc.editDocumentId !== null ||
      doc.editable ||
      doc.editState === 'openingForEdit' ||
      doc.editState === 'savePreparation' ||
      doc.editState === 'cancellingSave' ||
      doc.editState === 'saving' ||
      doc.editState === 'outcomeUnknown')
  );
}

function classifyExecuteRejection(error: unknown): {
  nextState: 'conflictDetected' | 'saveFailed' | 'outcomeUnknown';
  staleRevision: boolean;
  message: string;
} {
  const err = applicationError(error);
  if (err.code === 'conflict') {
    return {
      nextState: 'conflictDetected',
      staleRevision: true,
      message: err.message,
    };
  }
  // Known synchronous pre-dispatch rejections rule out enqueue/mutation.
  if (
    err.code === 'policy' ||
    err.code === 'filePolicy' ||
    err.code === 'sftpUnavailable' ||
    err.code === 'cancelled'
  ) {
    return {
      nextState: 'saveFailed',
      staleRevision: false,
      message: err.message,
    };
  }
  // client.ts synthesizes raw/lost Tauri IPC errors as code 'connection', and
  // TransferManager or storage failures can leave mutation settlement ambiguous.
  return {
    nextState: 'outcomeUnknown',
    staleRevision: true,
    message:
      err.code === 'outcomeUnknown'
        ? err.message
        : `Save execution could not confirm remote settlement (${err.message}). Verify the remote file before saving again.`,
  };
}

function bestEffortDiscardPlan(session: SessionOwnerTuple, planId: string): void {
  void filesApi.discardEditorPlan(session, planId).catch(() => undefined);
}

function bestEffortDiscardTextDocument(session: SessionOwnerTuple, editDocumentId: string): void {
  void filesApi.discardTextDocument(session, editDocumentId).catch(() => undefined);
}

export function ReadOnlyEditorProvider({ children }: { children: ReactNode }) {
  const [documents, setDocuments] = useState<ReadOnlyDocumentTab[]>([]);
  const [pendingOpens, setPendingOpens] = useState<PendingReadOnlyOpen[]>([]);
  const [activeByHost, setActiveByHost] = useState<Record<string, string | null>>({});
  const [errorsByHost, setErrorsByHost] = useState<Record<string, string | null>>({});

  const documentsRef = useRef<ReadOnlyDocumentTab[]>([]);
  const pendingRef = useRef<Map<string, InternalPendingOpen>>(new Map());
  const pendingEditOpenRef = useRef<Map<string, InternalPendingEditOpen>>(new Map());
  const inFlightSaveRef = useRef<Map<string, InternalInFlightSave>>(new Map());
  const pollTrackerRef = useRef<Map<string, { consecutiveErrors: number; missingPolls: number }>>(
    new Map(),
  );
  const opGenByTabRef = useRef<Map<string, number>>(new Map());
  const settlingJobIdsRef = useRef<Set<string>>(new Set());
  const externalReservationsRef = useRef<
    Map<string, { hostId: string; hostSessionId: string; sftpSessionId: string; path: string }>
  >(new Map());
  const externalEditsRef = useRef<
    Map<string, { hostId: string; hostSessionId: string; sftpSessionId: string; path: string }>
  >(new Map());
  const sessionByHostRef = useRef<
    Map<string, { connected: boolean; hostSessionId: string | null; sftpSessionId: string | null }>
  >(new Map());
  const mountedRef = useRef(true);

  const bumpTabGen = useCallback((tabId: string): number => {
    const next = (opGenByTabRef.current.get(tabId) ?? 0) + 1;
    opGenByTabRef.current.set(tabId, next);
    return next;
  }, []);

  const commitDocuments = useCallback((nextDocs: ReadOnlyDocumentTab[]) => {
    documentsRef.current = nextDocs;
    if (mountedRef.current) {
      setDocuments(nextDocs);
    }
  }, []);

  const updateTab = useCallback(
    (documentId: string, updater: (doc: ReadOnlyDocumentTab) => ReadOnlyDocumentTab) => {
      let changed = false;
      const nextDocs = documentsRef.current.map((doc) => {
        if (doc.id !== documentId) return doc;
        const updated = updater(doc);
        if (updated !== doc) changed = true;
        return updated;
      });
      if (changed) {
        commitDocuments(nextDocs);
      }
      return changed;
    },
    [commitDocuments],
  );

  const isSessionLive = useCallback((session: SessionOwnerTuple): boolean => {
    const tracked = sessionByHostRef.current.get(session.hostId);
    if (!tracked) return true;
    return (
      tracked.connected &&
      tracked.hostSessionId === session.hostSessionId &&
      tracked.sftpSessionId === session.id
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const pendingMap = pendingRef.current;
    const pendingEditMap = pendingEditOpenRef.current;
    const inFlightMap = inFlightSaveRef.current;
    const pollMap = pollTrackerRef.current;
    const opGenMap = opGenByTabRef.current;
    const settlingSet = settlingJobIdsRef.current;
    const externalReservationsMap = externalReservationsRef.current;
    const externalMap = externalEditsRef.current;
    return () => {
      mountedRef.current = false;
      for (const item of pendingMap.values()) {
        item.cancelled = true;
      }
      pendingMap.clear();
      for (const item of pendingEditMap.values()) {
        item.cancelled = true;
      }
      pendingEditMap.clear();
      for (const doc of documentsRef.current) {
        if (doc.savePlan) {
          bestEffortDiscardPlan(doc.savePlan.session, doc.savePlan.plan.id);
        }
        if (doc.editDocumentId) {
          bestEffortDiscardTextDocument(tabSession(doc), doc.editDocumentId);
        }
        disposeRetainedModel(doc.id);
      }
      inFlightMap.clear();
      pollMap.clear();
      opGenMap.clear();
      settlingSet.clear();
      externalReservationsMap.clear();
      externalMap.clear();
      documentsRef.current = [];
    };
  }, []);

  // Warn before accidental browser/webview unload when dirty or unresolved work exists.
  const hasProtectedWork = useMemo(
    () => documents.some((doc) => closureGuardReason(doc) !== null),
    [documents],
  );
  useEffect(() => {
    if (!hasProtectedWork) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasProtectedWork]);

  const syncPendingState = useCallback(() => {
    if (!mountedRef.current) return;
    setPendingOpens(
      Array.from(pendingRef.current.values()).map(
        ({ requestId, hostId, hostSessionId, sftpSessionId, path }) => ({
          requestId,
          hostId,
          hostSessionId,
          sftpSessionId,
          path,
        }),
      ),
    );
  }, []);

  const clearHostError = useCallback((hostId: string) => {
    setErrorsByHost((current) => (current[hostId] ? { ...current, [hostId]: null } : current));
  }, []);

  const hasActiveEditAuthority = useCallback((owner: SessionOwnerTuple, path: string): boolean => {
    const targetTuple = {
      hostId: owner.hostId,
      hostSessionId: owner.hostSessionId,
      sftpSessionId: owner.id,
    };
    for (const res of externalReservationsRef.current.values()) {
      if (sameSessionTuple(res, targetTuple) && res.path === path) {
        return true;
      }
    }
    for (const ext of externalEditsRef.current.values()) {
      if (sameSessionTuple(ext, targetTuple) && ext.path === path) {
        return true;
      }
    }
    for (const item of pendingEditOpenRef.current.values()) {
      if (
        !item.cancelled &&
        sameSessionTuple(
          {
            hostId: item.session.hostId,
            hostSessionId: item.session.hostSessionId,
            sftpSessionId: item.session.id,
          },
          targetTuple,
        ) &&
        item.path === path
      ) {
        return true;
      }
    }
    return documentsRef.current.some(
      (doc) =>
        isWriteAuthorityActiveOnTab(doc) &&
        sameSessionTuple(doc, targetTuple) &&
        doc.path === path,
    );
  }, []);

  const reserveExternalEdit = useCallback(
    (owner: SessionOwnerTuple, path: string): string | null => {
      if (!isSessionLive(owner) || hasActiveEditAuthority(owner, path)) {
        return null;
      }
      const reservationId = nextRequestId();
      externalReservationsRef.current.set(reservationId, {
        hostId: owner.hostId,
        hostSessionId: owner.hostSessionId,
        sftpSessionId: owner.id,
        path,
      });
      return reservationId;
    },
    [hasActiveEditAuthority, isSessionLive],
  );

  const commitExternalEdit = useCallback(
    (reservationId: string, externalDocumentId: string): boolean => {
      const reserved = externalReservationsRef.current.get(reservationId);
      if (!reserved) return false;
      externalReservationsRef.current.delete(reservationId);

      const owner: SessionOwnerTuple = {
        hostId: reserved.hostId,
        hostSessionId: reserved.hostSessionId,
        id: reserved.sftpSessionId,
      };
      if (!isSessionLive(owner) || hasActiveEditAuthority(owner, reserved.path)) {
        return false;
      }
      externalEditsRef.current.set(externalDocumentId, reserved);
      return true;
    },
    [hasActiveEditAuthority, isSessionLive],
  );

  const releaseExternalEdit = useCallback((id: string) => {
    externalReservationsRef.current.delete(id);
    externalEditsRef.current.delete(id);
  }, []);

  const registerExternalEdit = useCallback(
    (owner: SessionOwnerTuple, path: string, externalDocumentId: string): boolean => {
      const existing = externalEditsRef.current.get(externalDocumentId);
      if (
        existing &&
        sameSessionTuple(existing, {
          hostId: owner.hostId,
          hostSessionId: owner.hostSessionId,
          sftpSessionId: owner.id,
        }) &&
        existing.path === path
      ) {
        return true;
      }
      if (hasActiveEditAuthority(owner, path)) {
        return false;
      }
      externalEditsRef.current.set(externalDocumentId, {
        hostId: owner.hostId,
        hostSessionId: owner.hostSessionId,
        sftpSessionId: owner.id,
        path,
      });
      return true;
    },
    [hasActiveEditAuthority],
  );

  const unregisterExternalEdit = useCallback((externalDocumentId: string) => {
    externalReservationsRef.current.delete(externalDocumentId);
    externalEditsRef.current.delete(externalDocumentId);
  }, []);

  const selectDocument = useCallback((hostId: string, documentId: string) => {
    setActiveByHost((current) => ({ ...current, [hostId]: documentId }));
  }, []);

  const setDocumentLanguage = useCallback(
    (documentId: string, languageId: string) => {
      const resolved = getLanguageById(languageId);
      updateTab(documentId, (doc) =>
        doc.languageId === resolved.id && doc.languageLabel === resolved.label
          ? doc
          : { ...doc, languageId: resolved.id, languageLabel: resolved.label },
      );
    },
    [updateTab],
  );

  const canCloseTab = useCallback((documentId: string) => {
    const target = documentsRef.current.find((doc) => doc.id === documentId);
    if (!target) return { allowed: true, reason: null };
    const reason = closureGuardReason(target);
    return { allowed: reason === null, reason };
  }, []);

  const getUnsavedWorkSummary = useCallback((): UnsavedWorkSummary => {
    let dirtyCount = 0;
    let inFlightSaveCount = 0;
    let outcomeUnknownCount = 0;
    const hosts = new Set<string>();
    for (const doc of documentsRef.current) {
      if (doc.dirty) {
        dirtyCount += 1;
        hosts.add(doc.hostId);
      }
      if (
        doc.editState === 'saving' ||
        doc.editState === 'cancellingSave' ||
        doc.editState === 'savePreparation' ||
        doc.editState === 'openingForEdit'
      ) {
        inFlightSaveCount += 1;
        hosts.add(doc.hostId);
      }
      if (doc.editState === 'outcomeUnknown' || doc.lastSaveOutcome === 'outcomeUnknown') {
        outcomeUnknownCount += 1;
        hosts.add(doc.hostId);
      }
    }
    for (const ext of externalEditsRef.current.values()) {
      hosts.add(ext.hostId);
    }
    return {
      dirtyCount,
      inFlightSaveCount,
      outcomeUnknownCount,
      hostIdsWithUnsavedWork: Array.from(hosts),
    };
  }, []);

  const canPurgeHost = useCallback((hostId: string): { allowed: boolean; reason: string | null } => {
    for (const pending of pendingRef.current.values()) {
      if (!pending.cancelled && pending.hostId === hostId) {
        return {
          allowed: false,
          reason: 'Wait for pending file loads on this host to finish or cancel before deleting it.',
        };
      }
    }
    for (const pendingEdit of pendingEditOpenRef.current.values()) {
      if (!pendingEdit.cancelled && pendingEdit.session.hostId === hostId) {
        return {
          allowed: false,
          reason: 'Wait for active editor opens on this host to finish before deleting it.',
        };
      }
    }
    for (const ext of externalEditsRef.current.values()) {
      if (ext.hostId === hostId) {
        return {
          allowed: false,
          reason: 'Close the active text editor on this host before deleting it.',
        };
      }
    }
    for (const res of externalReservationsRef.current.values()) {
      if (res.hostId === hostId) {
        return {
          allowed: false,
          reason: 'Wait for the text editor to finish opening before deleting this host.',
        };
      }
    }
    const hostDocs = documentsRef.current.filter((doc) => doc.hostId === hostId);
    for (const doc of hostDocs) {
      const reason = closureGuardReason(doc);
      if (reason) {
        return { allowed: false, reason };
      }
    }
    return { allowed: true, reason: null };
  }, []);

  const closeDocument = useCallback(
    (documentId: string, options?: { confirmDiscard?: boolean }): boolean => {
      const target = documentsRef.current.find((doc) => doc.id === documentId);
      if (!target) return true;
      const unbypassable = unbypassableCloseReason(target);
      if (unbypassable) {
        updateTab(documentId, (doc) => ({ ...doc, editError: unbypassable }));
        if (mountedRef.current) {
          setErrorsByHost((current) => ({ ...current, [target.hostId]: unbypassable }));
        }
        return false;
      }
      const reason = closureGuardReason(target);
      if (reason && !options?.confirmDiscard) {
        updateTab(documentId, (doc) => ({ ...doc, editError: reason }));
        if (mountedRef.current) {
          setErrorsByHost((current) => ({ ...current, [target.hostId]: reason }));
        }
        return false;
      }

      if (target.savePlan) {
        bestEffortDiscardPlan(target.savePlan.session, target.savePlan.plan.id);
      }
      if (target.editDocumentId) {
        bestEffortDiscardTextDocument(tabSession(target), target.editDocumentId);
      }
      for (const pendingEdit of pendingEditOpenRef.current.values()) {
        if (pendingEdit.targetTabId === documentId) {
          pendingEdit.cancelled = true;
        }
      }
      bumpTabGen(documentId);
      opGenByTabRef.current.delete(documentId);
      pollTrackerRef.current.delete(documentId);
      inFlightSaveRef.current.delete(documentId);

      disposeRetainedModel(documentId);
      const nextDocs = documentsRef.current.filter((doc) => doc.id !== documentId);
      commitDocuments(nextDocs);
      if (mountedRef.current) {
        setActiveByHost((current) => {
          if (current[target.hostId] !== documentId) return current;
          const fallback = nextDocs.find((doc) => doc.hostId === target.hostId)?.id ?? null;
          return { ...current, [target.hostId]: fallback };
        });
      }
      return true;
    },
    [bumpTabGen, commitDocuments, updateTab],
  );

  const removeHostDocumentsInternal = useCallback(
    (hostId: string) => {
      const hostDocs = documentsRef.current.filter((doc) => doc.hostId === hostId);
      if (hostDocs.length === 0) return;
      for (const doc of hostDocs) {
        if (doc.savePlan) {
          bestEffortDiscardPlan(doc.savePlan.session, doc.savePlan.plan.id);
        }
        if (doc.editDocumentId) {
          bestEffortDiscardTextDocument(tabSession(doc), doc.editDocumentId);
        }
        for (const pendingEdit of pendingEditOpenRef.current.values()) {
          if (pendingEdit.targetTabId === doc.id) {
            pendingEdit.cancelled = true;
          }
        }
        bumpTabGen(doc.id);
        opGenByTabRef.current.delete(doc.id);
        pollTrackerRef.current.delete(doc.id);
        inFlightSaveRef.current.delete(doc.id);
        disposeRetainedModel(doc.id);
      }
      const nextDocs = documentsRef.current.filter((doc) => doc.hostId !== hostId);
      commitDocuments(nextDocs);
      if (mountedRef.current) {
        setActiveByHost((current) => ({ ...current, [hostId]: null }));
      }
    },
    [bumpTabGen, commitDocuments],
  );

  const closeHostDocuments = useCallback(
    (hostId: string, options?: { confirmDiscard?: boolean }): boolean => {
      const hostDocs = documentsRef.current.filter((doc) => doc.hostId === hostId);
      if (hostDocs.length === 0) return true;
      const unbypassable = hostDocs.find((doc) => unbypassableCloseReason(doc) !== null);
      if (unbypassable) {
        const reason = unbypassableCloseReason(unbypassable)!;
        updateTab(unbypassable.id, (doc) => ({ ...doc, editError: reason }));
        if (mountedRef.current) {
          setErrorsByHost((current) => ({ ...current, [hostId]: reason }));
        }
        return false;
      }
      if (!options?.confirmDiscard) {
        const guarded = hostDocs.find((doc) => closureGuardReason(doc) !== null);
        if (guarded) {
          const reason = closureGuardReason(guarded)!;
          updateTab(guarded.id, (doc) => ({ ...doc, editError: reason }));
          if (mountedRef.current) {
            setErrorsByHost((current) => ({ ...current, [hostId]: reason }));
          }
          return false;
        }
      }
      removeHostDocumentsInternal(hostId);
      return true;
    },
    [removeHostDocumentsInternal, updateTab],
  );

  const cancelOpen = useCallback(
    async (hostId: string, requestId: string) => {
      const pending = pendingRef.current.get(requestId);
      if (!pending || pending.hostId !== hostId || pending.cancelled) return;
      pending.cancelled = true;
      pendingRef.current.delete(requestId);
      syncPendingState();
      await filesApi.cancelReadOnlyOpen(pending.session, requestId).catch(() => undefined);
    },
    [syncPendingState],
  );

  const purgeHost = useCallback(
    (hostId: string) => {
      let changedPending = false;
      for (const [id, pending] of pendingRef.current.entries()) {
        if (pending.hostId === hostId) {
          pending.cancelled = true;
          pendingRef.current.delete(id);
          changedPending = true;
          void filesApi.cancelReadOnlyOpen(pending.session, id).catch(() => undefined);
        }
      }
      for (const pendingEdit of pendingEditOpenRef.current.values()) {
        if (pendingEdit.session.hostId === hostId) {
          pendingEdit.cancelled = true;
        }
      }
      for (const [resId, res] of externalReservationsRef.current.entries()) {
        if (res.hostId === hostId) {
          externalReservationsRef.current.delete(resId);
        }
      }
      for (const [extId, ext] of externalEditsRef.current.entries()) {
        if (ext.hostId === hostId) {
          externalEditsRef.current.delete(extId);
        }
      }
      if (changedPending) syncPendingState();
      sessionByHostRef.current.delete(hostId);
      removeHostDocumentsInternal(hostId);
      if (mountedRef.current) {
        setErrorsByHost((current) => {
          if (!(hostId in current)) return current;
          const next = { ...current };
          delete next[hostId];
          return next;
        });
      }
    },
    [removeHostDocumentsInternal, syncPendingState],
  );

  const settleTransferJob = useCallback(
    async (tabId: string, job: TransferJob) => {
      if (settlingJobIdsRef.current.has(job.id)) return;
      settlingJobIdsRef.current.add(job.id);
      try {
        const snapshot = inFlightSaveRef.current.get(tabId);
        const tabBefore = documentsRef.current.find((doc) => doc.id === tabId);
        if (
          !tabBefore ||
          tabBefore.activeTransferJobId !== job.id ||
          (tabBefore.editState !== 'saving' && tabBefore.editState !== 'outcomeUnknown')
        ) {
          return;
        }

        pollTrackerRef.current.delete(tabId);

        if (job.state === 'completed') {
          inFlightSaveRef.current.delete(tabId);
          const session = snapshot?.session ?? tabSession(tabBefore);
          const snapshotText = snapshot?.snapshotText ?? tabBefore.draftText;
          const savedAt = new Date().toISOString();

          if (!isSessionLive(session) || tabBefore.disconnected) {
            updateTab(tabId, (doc) => ({
              ...doc,
              activeTransferJobId: null,
              editDocumentId: null,
              savePlan: null,
              baselineText: snapshotText,
              dirty: doc.draftText !== snapshotText,
              editState: 'disconnected',
              lastSaveOutcome: 'confirmed',
              disconnected: true,
              staleRevision: true,
              lastSavedAt: savedAt,
              editError:
                'Saved remotely, but the session disconnected before refreshing edit authority.',
            }));
            return;
          }

          try {
            const refreshed = await filesApi.openText(session, tabBefore.path);
            const currentAfterRefresh = documentsRef.current.find((doc) => doc.id === tabId);
            const refreshedOwner: SessionOwnerTuple = {
              hostId: refreshed.hostId,
              hostSessionId: refreshed.hostSessionId,
              id: refreshed.sftpSessionId,
            };
            const identityOk =
              mountedRef.current &&
              Boolean(currentAfterRefresh) &&
              !currentAfterRefresh!.disconnected &&
              isSessionLive(session) &&
              refreshed.hostId === session.hostId &&
              refreshed.hostSessionId === session.hostSessionId &&
              refreshed.sftpSessionId === session.id &&
              refreshed.path === currentAfterRefresh!.path;

            if (!identityOk) {
              bestEffortDiscardTextDocument(refreshedOwner, refreshed.id);
              if (mountedRef.current && currentAfterRefresh) {
                updateTab(tabId, (doc) => ({
                  ...doc,
                  activeTransferJobId: null,
                  editDocumentId: null,
                  savePlan: null,
                  baselineText: snapshotText,
                  dirty: doc.draftText !== snapshotText,
                  editState:
                    !isSessionLive(session) || doc.disconnected ? 'disconnected' : 'saveConfirmed',
                  lastSaveOutcome: 'confirmed',
                  disconnected: !isSessionLive(session) || doc.disconnected,
                  staleRevision: true,
                  lastSavedAt: savedAt,
                  editError:
                    'Saved remotely, but the refreshed document identity did not match the current session. Reload before saving again.',
                }));
              }
              return;
            }

            const fidelityOk =
              refreshed.newline === tabBefore.newline &&
              refreshed.bom === tabBefore.bom &&
              refreshed.text === snapshotText;

            if (!fidelityOk) {
              bestEffortDiscardTextDocument(refreshedOwner, refreshed.id);
              updateTab(tabId, (doc) => ({
                ...doc,
                activeTransferJobId: null,
                editDocumentId: null,
                savePlan: null,
                baselineText: snapshotText,
                dirty: doc.draftText !== snapshotText,
                editState: 'conflictDetected',
                lastSaveOutcome: 'confirmed',
                staleRevision: true,
                lastSavedAt: savedAt,
                editError:
                  'Saved remotely, but the remote file contents or encoding changed before authority refreshed. Your editor buffer was preserved; reload or resolve before saving again.',
              }));
              return;
            }

            // All 7 checks passed; never overwrite user's live draftText (e.g. concurrent T1 -> T2 edits).
            updateTab(tabId, (doc) => {
              const stillDirty = doc.draftText !== refreshed.text;
              return {
                ...doc,
                activeTransferJobId: null,
                savePlan: null,
                editDocumentId: refreshed.id,
                baselineText: refreshed.text,
                text: refreshed.text,
                originalBytes: refreshed.originalBytes,
                newline: refreshed.newline,
                bom: refreshed.bom,
                maxBytes: refreshed.maxBytes,
                dirty: stillDirty,
                editState: stillDirty ? 'editableModified' : 'saveConfirmed',
                lastSaveOutcome: 'confirmed',
                staleRevision: false,
                editError: null,
                lastSavedAt: savedAt,
              };
            });
          } catch (refreshError) {
            const err = applicationError(refreshError);
            updateTab(tabId, (doc) => ({
              ...doc,
              activeTransferJobId: null,
              savePlan: null,
              editDocumentId: null,
              baselineText: snapshotText,
              dirty: doc.draftText !== snapshotText,
              editState: isSessionLive(session) && !doc.disconnected ? 'saveConfirmed' : 'disconnected',
              lastSaveOutcome: 'confirmed',
              disconnected: !isSessionLive(session) || doc.disconnected,
              staleRevision: true,
              lastSavedAt: savedAt,
              editError: `Saved remotely, but refreshing editor authority failed (${err.message}). Reload before saving again.`,
            }));
          }
          return;
        }

        if (job.state === 'outcomeUnknown') {
          inFlightSaveRef.current.delete(tabId);
          updateTab(tabId, (doc) => ({
            ...doc,
            activeTransferJobId: null,
            savePlan: null,
            editDocumentId: null,
            staleRevision: true,
            editState: 'outcomeUnknown',
            lastSaveOutcome: 'outcomeUnknown',
            editError:
              job.error?.message ??
              'The remote save outcome is unknown. Verify or reload the remote file before trying again.',
          }));
          return;
        }

        if (job.state === 'failed' || job.state === 'cancelled') {
          inFlightSaveRef.current.delete(tabId);
          const errorCode = job.error?.code;
          const message =
            job.error?.message ??
            (job.state === 'cancelled'
              ? 'Save transfer was cancelled; reload the remote file before saving again.'
              : 'Save transfer failed.');
          const isConflict =
            errorCode === 'conflict' || /changed since|revision|conflict|stale/i.test(message);
          updateTab(tabId, (doc) => ({
            ...doc,
            activeTransferJobId: null,
            savePlan: null,
            editDocumentId: null,
            staleRevision: true,
            editState: isConflict ? 'conflictDetected' : 'saveFailed',
            lastSaveOutcome: isConflict ? 'conflict' : 'failed',
            editError: message,
          }));
        }
      } finally {
        settlingJobIdsRef.current.delete(job.id);
      }
    },
    [isSessionLive, updateTab],
  );

  const syncTransfers = useCallback(
    (jobs: readonly TransferJob[]) => {
      if (jobs.length === 0) return;
      for (const doc of documentsRef.current) {
        if (!doc.activeTransferJobId) continue;
        const canReconcile =
          doc.editState === 'saving' ||
          (doc.editState === 'outcomeUnknown' &&
            inFlightSaveRef.current.get(doc.id)?.jobId === doc.activeTransferJobId);
        if (!canReconcile) continue;
        const matched = jobs.find((job) => job.id === doc.activeTransferJobId);
        if (
          matched &&
          (matched.state === 'completed' ||
            matched.state === 'failed' ||
            matched.state === 'cancelled' ||
            matched.state === 'outcomeUnknown')
        ) {
          void settleTransferJob(doc.id, matched);
        }
      }
    },
    [settleTransferJob],
  );

  // Root-owned bounded transfer polling loop so saves settle even when host view is switched or hidden.
  const hasSavingDocuments = useMemo(
    () => documents.some((doc) => doc.editState === 'saving' && doc.activeTransferJobId !== null),
    [documents],
  );
  useEffect(() => {
    if (!hasSavingDocuments) return;
    let active = true;
    const poll = async () => {
      if (!active || !mountedRef.current) return;
      try {
        const jobs = await filesApi.transfers();
        if (!active || !mountedRef.current) return;
        syncTransfers(jobs);
        for (const doc of documentsRef.current) {
          if (doc.editState !== 'saving' || !doc.activeTransferJobId) continue;
          const jobEntry = jobs.find((job) => job.id === doc.activeTransferJobId);
          const tracker = pollTrackerRef.current.get(doc.id) ?? {
            consecutiveErrors: 0,
            missingPolls: 0,
          };
          tracker.consecutiveErrors = 0;
          if (jobEntry) {
            tracker.missingPolls = 0;
            pollTrackerRef.current.set(doc.id, tracker);
          } else {
            tracker.missingPolls += 1;
            pollTrackerRef.current.set(doc.id, tracker);
            if (tracker.missingPolls >= MAX_MISSING_JOB_POLLS) {
              updateTab(doc.id, (current) =>
                current.editState === 'saving' &&
                current.activeTransferJobId === doc.activeTransferJobId
                  ? {
                      ...current,
                      savePlan: null,
                      editDocumentId: null,
                      staleRevision: true,
                      editState: 'outcomeUnknown',
                      lastSaveOutcome: 'outcomeUnknown',
                      editError:
                        'The save transfer is no longer reported by the transfer manager before settlement was confirmed. Verify or reload the remote file.',
                    }
                  : current,
              );
            }
          }
        }
      } catch {
        if (!active || !mountedRef.current) return;
        for (const doc of documentsRef.current) {
          if (doc.editState !== 'saving' || !doc.activeTransferJobId) continue;
          const tracker = pollTrackerRef.current.get(doc.id) ?? {
            consecutiveErrors: 0,
            missingPolls: 0,
          };
          tracker.consecutiveErrors += 1;
          pollTrackerRef.current.set(doc.id, tracker);
          if (tracker.consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
            updateTab(doc.id, (current) =>
              current.editState === 'saving' &&
              current.activeTransferJobId === doc.activeTransferJobId
                ? {
                    ...current,
                    savePlan: null,
                    editDocumentId: null,
                    staleRevision: true,
                    editState: 'outcomeUnknown',
                    lastSaveOutcome: 'outcomeUnknown',
                    editError:
                      'Lost status updates while polling the save transfer. Verify or reload the remote file before trying again.',
                  }
                : current,
            );
          }
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, TRANSFER_POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hasSavingDocuments, syncTransfers, updateTab]);

  const syncHostConnection = useCallback(
    (
      hostId: string,
      connected: boolean,
      hostSessionId: string | null,
      sftpSessionId: string | null,
    ) => {
      sessionByHostRef.current.set(hostId, { connected, hostSessionId, sftpSessionId });

      let changedPending = false;
      for (const [id, pending] of pendingRef.current.entries()) {
        if (pending.hostId !== hostId) continue;
        const stillLive =
          connected &&
          pending.hostSessionId === hostSessionId &&
          pending.sftpSessionId === sftpSessionId;
        if (!stillLive) {
          pending.cancelled = true;
          pendingRef.current.delete(id);
          changedPending = true;
          void filesApi.cancelReadOnlyOpen(pending.session, id).catch(() => undefined);
        }
      }
      if (changedPending) syncPendingState();

      for (const item of pendingEditOpenRef.current.values()) {
        if (item.session.hostId !== hostId) continue;
        const stillLive =
          connected &&
          item.session.hostSessionId === hostSessionId &&
          item.session.id === sftpSessionId;
        if (!stillLive) {
          item.cancelled = true;
        }
      }

      for (const [resId, res] of externalReservationsRef.current.entries()) {
        if (res.hostId !== hostId) continue;
        const stillLive =
          connected &&
          res.hostSessionId === hostSessionId &&
          res.sftpSessionId === sftpSessionId;
        if (!stillLive) {
          externalReservationsRef.current.delete(resId);
        }
      }

      for (const [extId, ext] of externalEditsRef.current.entries()) {
        if (ext.hostId !== hostId) continue;
        const stillLive =
          connected &&
          ext.hostSessionId === hostSessionId &&
          ext.sftpSessionId === sftpSessionId;
        if (!stillLive) {
          externalEditsRef.current.delete(extId);
        }
      }

      let changedDocs = false;
      const nextDocs = documentsRef.current.map((doc) => {
        if (doc.hostId !== hostId) return doc;
        const matchesLive =
          connected &&
          hostSessionId !== null &&
          sftpSessionId !== null &&
          doc.hostSessionId === hostSessionId &&
          doc.sftpSessionId === sftpSessionId;
        if (!matchesLive) {
          if (doc.savePlan) {
            bestEffortDiscardPlan(doc.savePlan.session, doc.savePlan.plan.id);
          }
          bumpTabGen(doc.id);
          const nextState: DocumentEditState =
            doc.editState === 'outcomeUnknown'
              ? 'outcomeUnknown'
              : doc.editState === 'saving'
                ? 'saving'
                : 'disconnected';
          if (
            !doc.disconnected ||
            doc.editDocumentId !== null ||
            doc.savePlan !== null ||
            doc.editState !== nextState
          ) {
            changedDocs = true;
            return {
              ...doc,
              disconnected: true,
              editDocumentId: null,
              savePlan: null,
              staleRevision: doc.editable ? true : doc.staleRevision,
              editState: nextState,
            };
          }
        }
        return doc;
      });
      if (changedDocs) {
        commitDocuments(nextDocs);
      }
    },
    [bumpTabGen, commitDocuments, syncPendingState],
  );

  const openDocument = useCallback(
    async (session: SftpSessionInfo, path: string): Promise<ReadOnlyDocumentTab | null> => {
      clearHostError(session.hostId);

      const existing = documentsRef.current.find(
        (doc) =>
          !doc.disconnected &&
          doc.hostId === session.hostId &&
          doc.hostSessionId === session.hostSessionId &&
          doc.sftpSessionId === session.id &&
          doc.path === path,
      );
      if (existing) {
        if (mountedRef.current) {
          setActiveByHost((current) => ({ ...current, [session.hostId]: existing.id }));
        }
        return existing;
      }

      const duplicatePending = Array.from(pendingRef.current.values()).find(
        (item) =>
          !item.cancelled &&
          item.hostId === session.hostId &&
          item.hostSessionId === session.hostSessionId &&
          item.sftpSessionId === session.id &&
          item.path === path,
      );
      if (duplicatePending) {
        return null;
      }

      const pendingEditForPath = Array.from(pendingEditOpenRef.current.values()).some(
        (item) =>
          !item.cancelled &&
          item.session.hostId === session.hostId &&
          item.session.hostSessionId === session.hostSessionId &&
          item.session.id === session.id &&
          item.path === path,
      );
      if (pendingEditForPath) {
        return null;
      }

      const activePendingCount = Array.from(pendingRef.current.values()).filter(
        (item) => !item.cancelled,
      ).length;
      const activeEditOpens = Array.from(pendingEditOpenRef.current.values()).filter(
        (item) => !item.cancelled && item.targetTabId === null,
      ).length;
      if (
        documentsRef.current.length + activePendingCount + activeEditOpens >=
        MAX_READONLY_DOCUMENTS
      ) {
        if (mountedRef.current) {
          setErrorsByHost((current) => ({
            ...current,
            [session.hostId]: `Document limit reached (${MAX_READONLY_DOCUMENTS} open documents application-wide, including hidden hosts). Close a tab before opening another file.`,
          }));
        }
        return null;
      }

      const requestId = nextRequestId();
      const entry: InternalPendingOpen = {
        requestId,
        session: ownerTuple(session),
        hostId: session.hostId,
        hostSessionId: session.hostSessionId,
        sftpSessionId: session.id,
        path,
        cancelled: false,
      };
      pendingRef.current.set(requestId, entry);
      syncPendingState();

      try {
        const result = await filesApi.openReadOnly(session, requestId, path);
        const sessionMatchesLive = isSessionLive(session);

        const existingPostAwait = documentsRef.current.find(
          (doc) =>
            !doc.disconnected &&
            doc.hostId === session.hostId &&
            doc.hostSessionId === session.hostSessionId &&
            doc.sftpSessionId === session.id &&
            doc.path === path,
        );
        if (existingPostAwait) {
          if (mountedRef.current) {
            setActiveByHost((current) => ({ ...current, [session.hostId]: existingPostAwait.id }));
          }
          return existingPostAwait;
        }

        const editOpenStartedDuringAwait = Array.from(pendingEditOpenRef.current.values()).some(
          (item) =>
            !item.cancelled &&
            item.session.hostId === session.hostId &&
            item.session.hostSessionId === session.hostSessionId &&
            item.session.id === session.id &&
            item.path === path,
        );

        if (
          !mountedRef.current ||
          entry.cancelled ||
          editOpenStartedDuringAwait ||
          !sessionMatchesLive ||
          !sameSessionTuple(result, {
            hostId: session.hostId,
            hostSessionId: session.hostSessionId,
            sftpSessionId: session.id,
          }) ||
          result.path !== path ||
          documentsRef.current.length >= MAX_READONLY_DOCUMENTS
        ) {
          return null;
        }

        const language = detectRemoteFileLanguage(result.path);
        const tab: ReadOnlyDocumentTab = {
          id: result.id,
          hostId: result.hostId,
          hostSessionId: result.hostSessionId,
          sftpSessionId: result.sftpSessionId,
          path: result.path,
          displayName: result.displayName,
          text: result.text,
          originalBytes: result.originalBytes,
          newline: result.newline,
          bom: result.bom,
          maxBytes: result.maxBytes,
          modifiedAt: result.modifiedAt,
          permissions: result.permissions,
          languageId: language.id,
          languageLabel: language.label,
          disconnected: false,
          editable: false,
          editState: 'readOnly',
          lastSaveOutcome: 'none',
          editDocumentId: null,
          baselineText: result.text,
          draftText: result.text,
          dirty: false,
          bufferGeneration: 0,
          modelRevision: 0,
          savePlan: null,
          activeTransferJobId: null,
          editError: null,
          staleRevision: false,
          canUndo: false,
          canRedo: false,
          lastSavedAt: null,
        };
        const nextDocs = [...documentsRef.current, tab];
        commitDocuments(nextDocs);
        if (mountedRef.current) {
          setActiveByHost((current) => ({ ...current, [session.hostId]: tab.id }));
        }
        return tab;
      } catch (reason) {
        if (mountedRef.current && !entry.cancelled) {
          const message = applicationError(reason).message;
          setErrorsByHost((current) => ({ ...current, [session.hostId]: message }));
        }
        return null;
      } finally {
        pendingRef.current.delete(requestId);
        syncPendingState();
      }
    },
    [clearHostError, commitDocuments, isSessionLive, syncPendingState],
  );

  const promoteToEditable = useCallback(
    async (documentId: string, session: SftpSessionInfo): Promise<ReadOnlyDocumentTab | null> => {
      const target = documentsRef.current.find((doc) => doc.id === documentId);
      if (!target) return null;
      if (target.editable && target.editDocumentId && !target.disconnected) {
        return target;
      }
      if (target.editState !== 'readOnly' || target.disconnected) {
        return null;
      }
      if (
        !sameSessionTuple(target, {
          hostId: session.hostId,
          hostSessionId: session.hostSessionId,
          sftpSessionId: session.id,
        }) ||
        !isSessionLive(session)
      ) {
        updateTab(documentId, (doc) => ({
          ...doc,
          editError: 'Cannot enable editing because the SFTP session is no longer current.',
        }));
        return null;
      }
      if (hasActiveEditAuthority(session, target.path)) {
        const message = 'Another editable session already owns write authority for this file.';
        updateTab(documentId, (doc) => ({ ...doc, editError: message }));
        if (mountedRef.current) {
          setErrorsByHost((current) => ({ ...current, [session.hostId]: message }));
        }
        return null;
      }

      const requestKey = nextRequestId();
      const promoGen = bumpTabGen(documentId);
      const pendingEdit: InternalPendingEditOpen = {
        requestKey,
        targetTabId: documentId,
        session: ownerTuple(session),
        path: target.path,
        cancelled: false,
      };
      pendingEditOpenRef.current.set(requestKey, pendingEdit);
      updateTab(documentId, (doc) => ({
        ...doc,
        editState: 'openingForEdit',
        editError: null,
      }));

      try {
        const result = await filesApi.openText(session, target.path);
        const owner = ownerTuple(session);
        const currentTab = documentsRef.current.find((doc) => doc.id === documentId);
        const targetTuple = {
          hostId: session.hostId,
          hostSessionId: session.hostSessionId,
          sftpSessionId: session.id,
        };
        const hasExternalConflict =
          Array.from(externalReservationsRef.current.values()).some(
            (r) => sameSessionTuple(r, targetTuple) && r.path === target.path,
          ) ||
          Array.from(externalEditsRef.current.values()).some(
            (e) => sameSessionTuple(e, targetTuple) && e.path === target.path,
          ) ||
          Array.from(pendingEditOpenRef.current.values()).some(
            (item) =>
              item.requestKey !== requestKey &&
              !item.cancelled &&
              sameSessionTuple(
                {
                  hostId: item.session.hostId,
                  hostSessionId: item.session.hostSessionId,
                  sftpSessionId: item.session.id,
                },
                targetTuple,
              ) &&
              item.path === target.path,
          );
        if (
          !mountedRef.current ||
          pendingEdit.cancelled ||
          hasExternalConflict ||
          opGenByTabRef.current.get(documentId) !== promoGen ||
          !currentTab ||
          currentTab.disconnected ||
          currentTab.editState !== 'openingForEdit' ||
          !isSessionLive(session) ||
          result.hostId !== session.hostId ||
          result.hostSessionId !== session.hostSessionId ||
          result.sftpSessionId !== session.id
        ) {
          bestEffortDiscardTextDocument(owner, result.id);
          return null;
        }

        const remoteChangedSinceReadOnly = result.text !== currentTab.text;
        let promoted: ReadOnlyDocumentTab | null = null;
        const nextDocs = documentsRef.current.map((doc) => {
          if (doc.id !== documentId) return doc;
          promoted = {
            ...doc,
            text: result.text,
            originalBytes: result.originalBytes,
            newline: result.newline,
            bom: result.bom,
            maxBytes: result.maxBytes,
            editable: true,
            editState: 'editableClean',
            lastSaveOutcome: 'none',
            editDocumentId: result.id,
            baselineText: result.text,
            draftText: result.text,
            dirty: false,
            bufferGeneration: doc.bufferGeneration + (remoteChangedSinceReadOnly ? 1 : 0),
            modelRevision: doc.modelRevision + (remoteChangedSinceReadOnly ? 1 : 0),
            savePlan: null,
            editError: null,
            staleRevision: false,
            canUndo: false,
            canRedo: false,
          };
          return promoted;
        });
        commitDocuments(nextDocs);
        return promoted;
      } catch (reason) {
        const message = applicationError(reason).message;
        updateTab(documentId, (doc) =>
          doc.editState === 'openingForEdit'
            ? {
                ...doc,
                editable: false,
                editState: doc.disconnected ? 'disconnected' : 'readOnly',
                editError: message,
              }
            : doc,
        );
        return null;
      } finally {
        pendingEditOpenRef.current.delete(requestKey);
      }
    },
    [bumpTabGen, commitDocuments, hasActiveEditAuthority, isSessionLive, updateTab],
  );

  const openEditableDocument = useCallback(
    async (session: SftpSessionInfo, path: string): Promise<ReadOnlyDocumentTab | null> => {
      clearHostError(session.hostId);
      if (!isSessionLive(session)) {
        if (mountedRef.current) {
          setErrorsByHost((current) => ({
            ...current,
            [session.hostId]: 'Connect an active SFTP session before opening a file for editing.',
          }));
        }
        return null;
      }

      const existing = documentsRef.current.find(
        (doc) =>
          !doc.disconnected &&
          doc.hostId === session.hostId &&
          doc.hostSessionId === session.hostSessionId &&
          doc.sftpSessionId === session.id &&
          doc.path === path,
      );
      if (existing) {
        if (mountedRef.current) {
          setActiveByHost((current) => ({ ...current, [session.hostId]: existing.id }));
        }
        if (existing.editable || existing.editDocumentId) {
          return existing;
        }
        return promoteToEditable(existing.id, session);
      }

      if (hasActiveEditAuthority(session, path)) {
        if (mountedRef.current) {
          setErrorsByHost((current) => ({
            ...current,
            [session.hostId]: 'This file already has an active edit authority open in this session.',
          }));
        }
        return null;
      }

      // Cancel any concurrent read-only open for the exact same (session, path) so only 1 tab is created.
      let cancelledPendingRo = false;
      for (const [roId, roEntry] of pendingRef.current.entries()) {
        if (
          !roEntry.cancelled &&
          roEntry.hostId === session.hostId &&
          roEntry.hostSessionId === session.hostSessionId &&
          roEntry.sftpSessionId === session.id &&
          roEntry.path === path
        ) {
          roEntry.cancelled = true;
          pendingRef.current.delete(roId);
          cancelledPendingRo = true;
          void filesApi.cancelReadOnlyOpen(roEntry.session, roId).catch(() => undefined);
        }
      }
      if (cancelledPendingRo) syncPendingState();

      const activePendingCount = Array.from(pendingRef.current.values()).filter(
        (item) => !item.cancelled,
      ).length;
      const activeEditOpens = Array.from(pendingEditOpenRef.current.values()).filter(
        (item) => !item.cancelled && item.targetTabId === null,
      ).length;
      if (
        documentsRef.current.length + activePendingCount + activeEditOpens >=
        MAX_READONLY_DOCUMENTS
      ) {
        if (mountedRef.current) {
          setErrorsByHost((current) => ({
            ...current,
            [session.hostId]: `Document limit reached (${MAX_READONLY_DOCUMENTS} open documents application-wide, including hidden hosts). Close a tab before opening another file.`,
          }));
        }
        return null;
      }

      const requestKey = nextRequestId();
      const pendingEdit: InternalPendingEditOpen = {
        requestKey,
        targetTabId: null,
        session: ownerTuple(session),
        path,
        cancelled: false,
      };
      pendingEditOpenRef.current.set(requestKey, pendingEdit);

      try {
        const result = await filesApi.openText(session, path);
        const owner = ownerTuple(session);
        const targetTuple = {
          hostId: session.hostId,
          hostSessionId: session.hostSessionId,
          sftpSessionId: session.id,
        };
        const tupleMatches =
          result.hostId === session.hostId &&
          result.hostSessionId === session.hostSessionId &&
          result.sftpSessionId === session.id;
        const otherEditConflict =
          Array.from(externalReservationsRef.current.values()).some(
            (r) => sameSessionTuple(r, targetTuple) && r.path === path,
          ) ||
          Array.from(externalEditsRef.current.values()).some(
            (e) => sameSessionTuple(e, targetTuple) && e.path === path,
          ) ||
          Array.from(pendingEditOpenRef.current.values()).some(
            (item) =>
              item.requestKey !== requestKey &&
              !item.cancelled &&
              sameSessionTuple(
                {
                  hostId: item.session.hostId,
                  hostSessionId: item.session.hostSessionId,
                  sftpSessionId: item.session.id,
                },
                targetTuple,
              ) &&
              item.path === path,
          ) ||
          documentsRef.current.some(
            (doc) =>
              !doc.disconnected &&
              sameSessionTuple(doc, targetTuple) &&
              doc.path === path,
          );
        if (
          !mountedRef.current ||
          pendingEdit.cancelled ||
          !isSessionLive(session) ||
          !tupleMatches ||
          result.path !== path ||
          documentsRef.current.length >= MAX_READONLY_DOCUMENTS ||
          otherEditConflict
        ) {
          bestEffortDiscardTextDocument(owner, result.id);
          return null;
        }

        const language = detectRemoteFileLanguage(result.path);
        const uiTabId = nextRequestId();
        const tab: ReadOnlyDocumentTab = {
          id: uiTabId,
          hostId: result.hostId,
          hostSessionId: result.hostSessionId,
          sftpSessionId: result.sftpSessionId,
          path: result.path,
          displayName: displayNameFromPath(result.path),
          text: result.text,
          originalBytes: result.originalBytes,
          newline: result.newline,
          bom: result.bom,
          maxBytes: result.maxBytes,
          modifiedAt: null,
          permissions: null,
          languageId: language.id,
          languageLabel: language.label,
          disconnected: false,
          editable: true,
          editState: 'editableClean',
          lastSaveOutcome: 'none',
          editDocumentId: result.id,
          baselineText: result.text,
          draftText: result.text,
          dirty: false,
          bufferGeneration: 0,
          modelRevision: 0,
          savePlan: null,
          activeTransferJobId: null,
          editError: null,
          staleRevision: false,
          canUndo: false,
          canRedo: false,
          lastSavedAt: null,
        };
        commitDocuments([...documentsRef.current, tab]);
        if (mountedRef.current) {
          setActiveByHost((current) => ({ ...current, [session.hostId]: tab.id }));
        }
        return tab;
      } catch (reason) {
        if (mountedRef.current && !pendingEdit.cancelled) {
          setErrorsByHost((current) => ({
            ...current,
            [session.hostId]: applicationError(reason).message,
          }));
        }
        return null;
      } finally {
        pendingEditOpenRef.current.delete(requestKey);
      }
    },
    [
      clearHostError,
      commitDocuments,
      hasActiveEditAuthority,
      isSessionLive,
      promoteToEditable,
      syncPendingState,
    ],
  );

  const updateEditableBuffer = useCallback(
    (
      documentId: string,
      nextLfText: string,
      undoRedo?: { canUndo: boolean; canRedo: boolean },
    ) => {
      const target = documentsRef.current.find((doc) => doc.id === documentId);
      if (!target || !target.editable) return;

      // Equal-text updates preserve an active savePlan cleanly without creating server plan orphans.
      if (target.savePlan && nextLfText === target.savePlan.snapshotText) {
        if (
          undoRedo &&
          (target.canUndo !== undoRedo.canUndo || target.canRedo !== undoRedo.canRedo)
        ) {
          updateTab(documentId, (doc) => ({
            ...doc,
            canUndo: undoRedo.canUndo,
            canRedo: undoRedo.canRedo,
          }));
        }
        return;
      }

      const supersededPlan =
        target.savePlan && nextLfText !== target.savePlan.snapshotText ? target.savePlan : null;

      updateTab(documentId, (doc) => {
        const nextDirty = nextLfText !== doc.baselineText;
        const nextGeneration = doc.bufferGeneration + 1;
        let nextEditState: DocumentEditState = doc.editState;
        if (
          doc.editState === 'editableClean' ||
          doc.editState === 'editableModified' ||
          doc.editState === 'savePreparation' ||
          doc.editState === 'saveConfirmed' ||
          doc.editState === 'saveFailed'
        ) {
          nextEditState = nextDirty ? 'editableModified' : 'editableClean';
        }
        return {
          ...doc,
          draftText: nextLfText,
          dirty: nextDirty,
          bufferGeneration: nextGeneration,
          savePlan: null,
          editState: nextEditState,
          canUndo: undoRedo?.canUndo ?? doc.canUndo,
          canRedo: undoRedo?.canRedo ?? doc.canRedo,
          editError: doc.editState === 'saveFailed' ? null : doc.editError,
        };
      });

      if (supersededPlan) {
        const expectedEditDocId = target.editDocumentId;
        void filesApi
          .discardEditorPlan(supersededPlan.session, supersededPlan.plan.id)
          .then((released) => {
            if (!released && mountedRef.current) {
              updateTab(documentId, (doc) =>
                doc.editDocumentId === expectedEditDocId
                  ? {
                      ...doc,
                      staleRevision: true,
                      editDocumentId: null,
                    }
                  : doc,
              );
            }
          })
          .catch(() => {
            if (mountedRef.current) {
              updateTab(documentId, (doc) =>
                doc.editDocumentId === expectedEditDocId
                  ? {
                      ...doc,
                      staleRevision: true,
                      editDocumentId: null,
                    }
                  : doc,
              );
            }
          });
      }
    },
    [updateTab],
  );

  const prepareSave = useCallback(
    async (documentId: string, session: SftpSessionInfo): Promise<FileOperationPlan | null> => {
      const target = documentsRef.current.find((doc) => doc.id === documentId);
      if (
        !target ||
        !target.editable ||
        target.disconnected ||
        !target.editDocumentId ||
        target.staleRevision ||
        target.editState === 'openingForEdit' ||
        target.editState === 'savePreparation' ||
        target.editState === 'cancellingSave' ||
        target.editState === 'saving' ||
        target.editState === 'conflictDetected' ||
        target.editState === 'outcomeUnknown'
      ) {
        return null;
      }
      if (
        !sameSessionTuple(target, {
          hostId: session.hostId,
          hostSessionId: session.hostSessionId,
          sftpSessionId: session.id,
        }) ||
        !isSessionLive(session)
      ) {
        updateTab(documentId, (doc) => ({
          ...doc,
          editError: 'Cannot prepare save because the SFTP session is no longer current.',
        }));
        return null;
      }

      const validation = validateEditableText(target.draftText, target.newline, target.bom);
      if (!validation.canSave) {
        updateTab(documentId, (doc) => ({
          ...doc,
          editState: 'saveFailed',
          editError: validation.reason,
        }));
        return null;
      }

      if (target.savePlan) {
        bestEffortDiscardPlan(target.savePlan.session, target.savePlan.plan.id);
      }

      const owner = ownerTuple(session);
      const snapshotText = target.draftText;
      const snapshotGeneration = target.bufferGeneration;
      const editDocumentId = target.editDocumentId;
      const prepGen = bumpTabGen(documentId);

      updateTab(documentId, (doc) => ({
        ...doc,
        editState: 'savePreparation',
        savePlan: null,
        editError: null,
      }));

      try {
        const plan = await filesApi.planTextSave(owner, editDocumentId, snapshotText);
        const current = documentsRef.current.find((doc) => doc.id === documentId);
        if (
          !mountedRef.current ||
          !current ||
          current.disconnected ||
          opGenByTabRef.current.get(documentId) !== prepGen ||
          current.editDocumentId !== editDocumentId ||
          current.editState !== 'savePreparation' ||
          !isSessionLive(owner) ||
          current.bufferGeneration !== snapshotGeneration ||
          current.draftText !== snapshotText
        ) {
          bestEffortDiscardPlan(owner, plan.id);
          if (mountedRef.current && current && !current.disconnected) {
            updateTab(documentId, (doc) =>
              doc.editState === 'savePreparation' && doc.savePlan === null
                ? {
                    ...doc,
                    savePlan: null,
                    editState: doc.dirty ? 'editableModified' : 'editableClean',
                    editError: 'Document text changed while preparing save. Review save again.',
                  }
                : doc,
            );
          }
          return null;
        }

        const immutablePlan: SavePlanState = {
          session: owner,
          plan,
          snapshotText,
          bufferGeneration: snapshotGeneration,
        };
        updateTab(documentId, (doc) => ({
          ...doc,
          editState: 'savePreparation',
          savePlan: immutablePlan,
          editError: null,
        }));
        return plan;
      } catch (reason) {
        const err = applicationError(reason);
        const isConflict = err.code === 'conflict';
        updateTab(documentId, (doc) => {
          if (doc.editState !== 'savePreparation') return doc;
          return {
            ...doc,
            savePlan: null,
            staleRevision: true,
            editDocumentId: null,
            editState: isConflict ? 'conflictDetected' : 'saveFailed',
            lastSaveOutcome: isConflict ? 'conflict' : 'failed',
            editError: err.message,
          };
        });
        return null;
      }
    },
    [bumpTabGen, isSessionLive, updateTab],
  );

  const cancelSavePreparation = useCallback(
    async (documentId: string): Promise<boolean> => {
      const target = documentsRef.current.find((doc) => doc.id === documentId);
      if (
        !target ||
        target.editState === 'saving' ||
        target.editState === 'cancellingSave' ||
        target.editState === 'disconnected' ||
        target.editState === 'outcomeUnknown'
      ) {
        return false;
      }

      const pendingPlan = target.savePlan;
      const cancelGen = bumpTabGen(documentId);
      updateTab(documentId, (doc) => ({
        ...doc,
        savePlan: null,
        editState: 'cancellingSave',
        editError: null,
      }));

      let released = true;
      if (pendingPlan) {
        try {
          released = await filesApi.discardEditorPlan(pendingPlan.session, pendingPlan.plan.id);
        } catch {
          released = false;
        }
      }
      updateTab(documentId, (doc) => {
        if (
          doc.editState !== 'cancellingSave' ||
          opGenByTabRef.current.get(documentId) !== cancelGen ||
          doc.disconnected
        ) {
          return doc;
        }
        if (!released) {
          return {
            ...doc,
            savePlan: null,
            staleRevision: true,
            editDocumentId: null,
            editState: 'conflictDetected',
            editError:
              'Pending save plan expired or was consumed; reload the remote file before saving.',
          };
        }
        return {
          ...doc,
          savePlan: null,
          editState: doc.dirty ? 'editableModified' : 'editableClean',
          editError: null,
        };
      });
      return released;
    },
    [bumpTabGen, updateTab],
  );

  const executeSave = useCallback(
    async (documentId: string, session: SftpSessionInfo): Promise<TransferJob | null> => {
      const target = documentsRef.current.find((doc) => doc.id === documentId);
      const pending = target?.savePlan ?? null;
      if (!target || !pending || target.disconnected || target.editState !== 'savePreparation') {
        return null;
      }

      if (
        !sameSessionTuple(target, {
          hostId: session.hostId,
          hostSessionId: session.hostSessionId,
          sftpSessionId: session.id,
        }) ||
        pending.session.id !== session.id ||
        pending.session.hostSessionId !== session.hostSessionId ||
        !isSessionLive(session) ||
        target.bufferGeneration !== pending.bufferGeneration ||
        target.draftText !== pending.snapshotText
      ) {
        bestEffortDiscardPlan(pending.session, pending.plan.id);
        updateTab(documentId, (doc) => ({
          ...doc,
          savePlan: null,
          editState: doc.disconnected
            ? 'disconnected'
            : doc.dirty
              ? 'editableModified'
              : 'editableClean',
          editError:
            'The approved save snapshot no longer matches the current buffer or session. Prepare save again.',
        }));
        return null;
      }

      const owner = ownerTuple(session);
      const prevEditDocumentId = target.editDocumentId;
      bumpTabGen(documentId);
      pollTrackerRef.current.delete(documentId);
      updateTab(documentId, (doc) => ({
        ...doc,
        editState: 'saving',
        savePlan: null,
        editError: null,
      }));

      try {
        const jobs = await filesApi.execute(owner, pending.plan.id);
        const job = jobs[0];
        if (jobs.length !== 1 || !job) {
          updateTab(documentId, (doc) => ({
            ...doc,
            editDocumentId: null,
            activeTransferJobId: null,
            staleRevision: true,
            editState: 'outcomeUnknown',
            lastSaveOutcome: 'outcomeUnknown',
            editError:
              'Save execution returned an unexpected transfer status. Reload or verify remote content.',
          }));
          return null;
        }

        inFlightSaveRef.current.set(documentId, {
          session: owner,
          planId: pending.plan.id,
          jobId: job.id,
          snapshotText: pending.snapshotText,
          snapshotGeneration: pending.bufferGeneration,
          prevEditDocumentId,
        });
        updateTab(documentId, (doc) => ({
          ...doc,
          activeTransferJobId: job.id,
          editDocumentId: null,
        }));

        if (
          job.state === 'completed' ||
          job.state === 'failed' ||
          job.state === 'cancelled' ||
          job.state === 'outcomeUnknown'
        ) {
          await settleTransferJob(documentId, job);
        }
        return job;
      } catch (reason) {
        const classification = classifyExecuteRejection(reason);
        updateTab(documentId, (doc) => ({
          ...doc,
          activeTransferJobId: null,
          savePlan: null,
          editDocumentId: null,
          staleRevision: true,
          editState: classification.nextState,
          lastSaveOutcome:
            classification.nextState === 'conflictDetected'
              ? 'conflict'
              : classification.nextState === 'saveFailed'
                ? 'failed'
                : 'outcomeUnknown',
          editError: classification.message,
        }));
        return null;
      }
    },
    [bumpTabGen, isSessionLive, settleTransferJob, updateTab],
  );

  const reloadDocument = useCallback(
    async (
      documentId: string,
      session: SftpSessionInfo,
      options?: { allowDirtyDiscard?: boolean },
    ): Promise<ReadOnlyDocumentTab | null> => {
      const target = documentsRef.current.find((doc) => doc.id === documentId);
      if (!target) return null;
      if (
        target.editState === 'saving' ||
        target.editState === 'cancellingSave' ||
        target.editState === 'openingForEdit'
      ) {
        return null;
      }
      if (target.dirty && !options?.allowDirtyDiscard) {
        updateTab(documentId, (doc) => ({
          ...doc,
          editError:
            'This document has unsaved edits. Save or explicitly confirm discarding changes before reloading.',
        }));
        return null;
      }
      if (!isSessionLive(session)) {
        updateTab(documentId, (doc) => ({
          ...doc,
          editError: 'Cannot reload because the SFTP session is no longer connected.',
        }));
        return null;
      }

      const reloadGen = bumpTabGen(documentId);
      inFlightSaveRef.current.delete(documentId);
      pollTrackerRef.current.delete(documentId);

      if (target.savePlan) {
        await filesApi
          .discardEditorPlan(target.savePlan.session, target.savePlan.plan.id)
          .catch(() => undefined);
      }
      if (target.editDocumentId) {
        await filesApi
          .discardTextDocument(tabSession(target), target.editDocumentId)
          .catch(() => undefined);
      }

      const afterDiscardTab = documentsRef.current.find((doc) => doc.id === documentId);
      if (
        !mountedRef.current ||
        !afterDiscardTab ||
        opGenByTabRef.current.get(documentId) !== reloadGen ||
        !isSessionLive(session)
      ) {
        return null;
      }

      const owner = ownerTuple(session);
      if (
        target.editable ||
        target.editDocumentId !== null ||
        target.editState === 'conflictDetected' ||
        target.editState === 'outcomeUnknown' ||
        target.editState === 'saveFailed' ||
        target.editState === 'saveConfirmed' ||
        target.lastSaveOutcome !== 'none'
      ) {
        try {
          const fresh = await filesApi.openText(owner, target.path);
          const freshOwner: SessionOwnerTuple = {
            hostId: fresh.hostId,
            hostSessionId: fresh.hostSessionId,
            id: fresh.sftpSessionId,
          };
          const currentAfterAwait = documentsRef.current.find((doc) => doc.id === documentId);
          if (
            !mountedRef.current ||
            !currentAfterAwait ||
            opGenByTabRef.current.get(documentId) !== reloadGen ||
            !isSessionLive(owner) ||
            fresh.hostId !== owner.hostId ||
            fresh.hostSessionId !== owner.hostSessionId ||
            fresh.sftpSessionId !== owner.id ||
            fresh.path !== target.path
          ) {
            bestEffortDiscardTextDocument(freshOwner, fresh.id);
            return null;
          }
          let updatedTab: ReadOnlyDocumentTab | null = null;
          const nextDocs = documentsRef.current.map((doc) => {
            if (doc.id !== documentId) return doc;
            updatedTab = {
              ...doc,
              hostId: fresh.hostId,
              hostSessionId: fresh.hostSessionId,
              sftpSessionId: fresh.sftpSessionId,
              disconnected: false,
              text: fresh.text,
              baselineText: fresh.text,
              draftText: fresh.text,
              originalBytes: fresh.originalBytes,
              newline: fresh.newline,
              bom: fresh.bom,
              maxBytes: fresh.maxBytes,
              editable: true,
              editState: 'editableClean',
              lastSaveOutcome: 'none',
              editDocumentId: fresh.id,
              dirty: false,
              bufferGeneration: doc.bufferGeneration + 1,
              modelRevision: doc.modelRevision + 1,
              savePlan: null,
              activeTransferJobId: null,
              staleRevision: false,
              editError: null,
              canUndo: false,
              canRedo: false,
            };
            return updatedTab;
          });
          commitDocuments(nextDocs);
          return updatedTab;
        } catch (reason) {
          updateTab(documentId, (doc) =>
            opGenByTabRef.current.get(documentId) === reloadGen
              ? {
                  ...doc,
                  savePlan: null,
                  editDocumentId: null,
                  staleRevision: true,
                  editError: applicationError(reason).message,
                }
              : doc,
          );
          return null;
        }
      }

      // Clean read-only reload path.
      const requestId = nextRequestId();
      try {
        const freshRo = await filesApi.openReadOnly(owner, requestId, target.path);
        const currentAfterRo = documentsRef.current.find((doc) => doc.id === documentId);
        if (
          !mountedRef.current ||
          !currentAfterRo ||
          opGenByTabRef.current.get(documentId) !== reloadGen ||
          !isSessionLive(owner) ||
          freshRo.hostId !== owner.hostId ||
          freshRo.hostSessionId !== owner.hostSessionId ||
          freshRo.sftpSessionId !== owner.id ||
          freshRo.path !== target.path
        ) {
          return null;
        }
        let updatedTab: ReadOnlyDocumentTab | null = null;
        const nextDocs = documentsRef.current.map((doc) => {
          if (doc.id !== documentId) return doc;
          updatedTab = {
            ...doc,
            hostId: freshRo.hostId,
            hostSessionId: freshRo.hostSessionId,
            sftpSessionId: freshRo.sftpSessionId,
            disconnected: false,
            text: freshRo.text,
            baselineText: freshRo.text,
            draftText: freshRo.text,
            originalBytes: freshRo.originalBytes,
            newline: freshRo.newline,
            bom: freshRo.bom,
            maxBytes: freshRo.maxBytes,
            modifiedAt: freshRo.modifiedAt,
            permissions: freshRo.permissions,
            lastSaveOutcome: 'none',
            dirty: false,
            bufferGeneration: doc.bufferGeneration + 1,
            modelRevision: doc.modelRevision + 1,
            editError: null,
          };
          return updatedTab;
        });
        commitDocuments(nextDocs);
        return updatedTab;
      } catch (reason) {
        updateTab(documentId, (doc) =>
          opGenByTabRef.current.get(documentId) === reloadGen
            ? {
                ...doc,
                editError: applicationError(reason).message,
              }
            : doc,
        );
        return null;
      }
    },
    [bumpTabGen, commitDocuments, isSessionLive, updateTab],
  );

  const discardChanges = useCallback(
    async (documentId: string): Promise<boolean> => {
      const target = documentsRef.current.find((doc) => doc.id === documentId);
      if (
        !target ||
        target.editState === 'saving' ||
        target.editState === 'cancellingSave' ||
        target.editState === 'openingForEdit'
      ) {
        return false;
      }
      if (target.savePlan) {
        await filesApi
          .discardEditorPlan(target.savePlan.session, target.savePlan.plan.id)
          .catch(() => undefined);
      }
      return updateTab(documentId, (doc) => {
        const restoredState: DocumentEditState =
          doc.editState === 'outcomeUnknown' || doc.lastSaveOutcome === 'outcomeUnknown'
            ? 'outcomeUnknown'
            : doc.disconnected
              ? 'disconnected'
              : !doc.editable
                ? 'readOnly'
                : doc.staleRevision
                  ? 'conflictDetected'
                  : 'editableClean';
        return {
          ...doc,
          draftText: doc.baselineText,
          dirty: false,
          bufferGeneration: doc.bufferGeneration + 1,
          modelRevision: doc.modelRevision + 1,
          savePlan: null,
          editState: restoredState,
          editError: null,
          canUndo: false,
          canRedo: false,
        };
      });
    },
    [updateTab],
  );

  const api = useMemo<RegistryApi>(
    () => ({
      documents,
      pendingOpens,
      activeByHost,
      errorsByHost,
      openDocument,
      openEditableDocument,
      promoteToEditable,
      updateEditableBuffer,
      prepareSave,
      cancelSavePreparation,
      executeSave,
      reloadDocument,
      discardChanges,
      syncTransfers,
      reserveExternalEdit,
      commitExternalEdit,
      releaseExternalEdit,
      registerExternalEdit,
      unregisterExternalEdit,
      hasActiveEditAuthority,
      canCloseTab,
      canPurgeHost,
      getUnsavedWorkSummary,
      cancelOpen,
      selectDocument,
      setDocumentLanguage,
      closeDocument,
      closeHostDocuments,
      clearHostError,
      syncHostConnection,
      purgeHost,
    }),
    [
      documents,
      pendingOpens,
      activeByHost,
      errorsByHost,
      openDocument,
      openEditableDocument,
      promoteToEditable,
      updateEditableBuffer,
      prepareSave,
      cancelSavePreparation,
      executeSave,
      reloadDocument,
      discardChanges,
      syncTransfers,
      reserveExternalEdit,
      commitExternalEdit,
      releaseExternalEdit,
      registerExternalEdit,
      unregisterExternalEdit,
      hasActiveEditAuthority,
      canCloseTab,
      canPurgeHost,
      getUnsavedWorkSummary,
      cancelOpen,
      selectDocument,
      setDocumentLanguage,
      closeDocument,
      closeHostDocuments,
      clearHostError,
      syncHostConnection,
      purgeHost,
    ],
  );

  return <ReadOnlyEditorContext.Provider value={api}>{children}</ReadOnlyEditorContext.Provider>;
}

export function useOptionalReadOnlyEditor(): RegistryApi | null {
  return useContext(ReadOnlyEditorContext);
}

export function useReadOnlyEditor(): RegistryApi {
  const ctx = useContext(ReadOnlyEditorContext);
  if (!ctx) {
    throw new Error('useReadOnlyEditor must be used inside ReadOnlyEditorProvider.');
  }
  return ctx;
}
