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
import type { SftpSessionInfo, TextNewline } from '@ubgops/protocol';
import { applicationError, filesApi } from '../../api/client';
import { detectRemoteFileLanguage } from './languageDetection';

export const MAX_READONLY_DOCUMENTS = 8;
export const MAX_READONLY_BYTES = 1_048_576;

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
}

export interface PendingReadOnlyOpen {
  readonly requestId: string;
  readonly hostId: string;
  readonly hostSessionId: string;
  readonly sftpSessionId: string;
  readonly path: string;
}

type ModelDisposer = (documentId: string) => void;

let registeredModelDisposer: ModelDisposer | null = null;

export function registerReadOnlyModelDisposer(disposer: ModelDisposer | null): void {
  registeredModelDisposer = disposer;
}

function disposeRetainedModel(documentId: string): void {
  registeredModelDisposer?.(documentId);
}

interface InternalPendingOpen extends PendingReadOnlyOpen {
  readonly session: Pick<SftpSessionInfo, 'hostId' | 'hostSessionId' | 'id'>;
  cancelled: boolean;
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
  readonly cancelOpen: (hostId: string, requestId: string) => Promise<void>;
  readonly selectDocument: (hostId: string, documentId: string) => void;
  readonly closeDocument: (documentId: string) => void;
  readonly closeHostDocuments: (hostId: string) => void;
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

export function ReadOnlyEditorProvider({ children }: { children: ReactNode }) {
  const [documents, setDocuments] = useState<ReadOnlyDocumentTab[]>([]);
  const [pendingOpens, setPendingOpens] = useState<PendingReadOnlyOpen[]>([]);
  const [activeByHost, setActiveByHost] = useState<Record<string, string | null>>({});
  const [errorsByHost, setErrorsByHost] = useState<Record<string, string | null>>({});

  const documentsRef = useRef<ReadOnlyDocumentTab[]>([]);
  const pendingRef = useRef<Map<string, InternalPendingOpen>>(new Map());
  const sessionByHostRef = useRef<
    Map<string, { connected: boolean; hostSessionId: string | null; sftpSessionId: string | null }>
  >(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const pendingMap = pendingRef.current;
    return () => {
      mountedRef.current = false;
      for (const item of pendingMap.values()) {
        item.cancelled = true;
      }
      pendingMap.clear();
      for (const doc of documentsRef.current) {
        disposeRetainedModel(doc.id);
      }
      documentsRef.current = [];
    };
  }, []);

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
    setErrorsByHost((current) =>
      current[hostId] ? { ...current, [hostId]: null } : current,
    );
  }, []);

  const selectDocument = useCallback((hostId: string, documentId: string) => {
    setActiveByHost((current) => ({ ...current, [hostId]: documentId }));
  }, []);

  const closeDocument = useCallback((documentId: string) => {
    const target = documentsRef.current.find((doc) => doc.id === documentId);
    if (!target) return;
    disposeRetainedModel(documentId);
    const nextDocs = documentsRef.current.filter((doc) => doc.id !== documentId);
    documentsRef.current = nextDocs;
    setDocuments(nextDocs);
    setActiveByHost((current) => {
      if (current[target.hostId] !== documentId) return current;
      const fallback = nextDocs.find((doc) => doc.hostId === target.hostId)?.id ?? null;
      return { ...current, [target.hostId]: fallback };
    });
  }, []);

  const closeHostDocuments = useCallback((hostId: string) => {
    const removed = documentsRef.current.filter((doc) => doc.hostId === hostId);
    if (removed.length === 0) return;
    for (const doc of removed) {
      disposeRetainedModel(doc.id);
    }
    const nextDocs = documentsRef.current.filter((doc) => doc.hostId !== hostId);
    documentsRef.current = nextDocs;
    setDocuments(nextDocs);
    setActiveByHost((current) => ({ ...current, [hostId]: null }));
  }, []);

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
      if (changedPending) syncPendingState();
      sessionByHostRef.current.delete(hostId);
      closeHostDocuments(hostId);
      setErrorsByHost((current) => {
        if (!(hostId in current)) return current;
        const next = { ...current };
        delete next[hostId];
        return next;
      });
    },
    [closeHostDocuments, syncPendingState],
  );

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

      let changedDocs = false;
      const nextDocs = documentsRef.current.map((doc) => {
        if (doc.hostId !== hostId) return doc;
        const matchesLive =
          connected &&
          hostSessionId !== null &&
          sftpSessionId !== null &&
          doc.hostSessionId === hostSessionId &&
          doc.sftpSessionId === sftpSessionId;
        if (!matchesLive && !doc.disconnected) {
          changedDocs = true;
          return { ...doc, disconnected: true };
        }
        return doc;
      });
      if (changedDocs) {
        documentsRef.current = nextDocs;
        setDocuments(nextDocs);
      }
    },
    [syncPendingState],
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
        setActiveByHost((current) => ({ ...current, [session.hostId]: existing.id }));
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

      const activePendingCount = Array.from(pendingRef.current.values()).filter(
        (item) => !item.cancelled,
      ).length;
      if (documentsRef.current.length + activePendingCount >= MAX_READONLY_DOCUMENTS) {
        setErrorsByHost((current) => ({
          ...current,
          [session.hostId]: `Document limit reached (${MAX_READONLY_DOCUMENTS} open read-only documents application-wide, including hidden hosts). Close a tab before opening another file.`,
        }));
        return null;
      }

      const requestId = nextRequestId();
      const entry: InternalPendingOpen = {
        requestId,
        session: {
          hostId: session.hostId,
          hostSessionId: session.hostSessionId,
          id: session.id,
        },
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
        const stillLive = sessionByHostRef.current.get(session.hostId);
        const sessionMatchesLive =
          !stillLive ||
          (stillLive.connected &&
            stillLive.hostSessionId === session.hostSessionId &&
            stillLive.sftpSessionId === session.id);

        if (
          !mountedRef.current ||
          entry.cancelled ||
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
        };
        const nextDocs = [...documentsRef.current, tab];
        documentsRef.current = nextDocs;
        setDocuments(nextDocs);
        setActiveByHost((current) => ({ ...current, [session.hostId]: tab.id }));
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
    [clearHostError, syncPendingState],
  );

  const api = useMemo<RegistryApi>(
    () => ({
      documents,
      pendingOpens,
      activeByHost,
      errorsByHost,
      openDocument,
      cancelOpen,
      selectDocument,
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
      cancelOpen,
      selectDocument,
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
