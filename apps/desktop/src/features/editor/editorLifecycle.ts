import type { SftpSessionInfo, TextNewline } from '@ubgops/protocol';

export const MAX_SETTLED_JOB_HISTORY = 256;
export const MAX_UNRESOLVED_AUTHORITY_FENCES = 64;

export type SessionOwnerTuple = Pick<SftpSessionInfo, 'hostId' | 'hostSessionId' | 'id'>;

export type AuthorityOwnershipState = 'active' | 'staleCleanupRequired' | 'executionAmbiguous';

export interface EditorAuthorityHandle {
  readonly documentId: string;
  readonly session: SessionOwnerTuple;
  readonly path: string;
  readonly authorityGeneration: number;
  readonly usable: boolean;
  readonly ownershipState: AuthorityOwnershipState;
}

export type SaveAttemptPhase = 'executing' | 'transferring' | 'settled';

export type SaveAttemptOutcome =
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'conflict'
  | 'cancelled'
  | 'outcomeUnknown';

export interface SaveAttemptRecord {
  readonly saveOpId: number;
  readonly tabId: string;
  readonly session: SessionOwnerTuple;
  readonly path: string;
  readonly authority: EditorAuthorityHandle | null;
  readonly planId: string;
  readonly snapshotText: string;
  readonly snapshotGeneration: number;
  jobId: string | null;
  phase: SaveAttemptPhase;
  outcome: SaveAttemptOutcome;
  consecutivePollErrors: number;
  missingJobPolls: number;
  lastPollSeq: number;
}

export interface PostSaveRefreshRecord {
  readonly refreshOpId: number;
  readonly saveOpId: number;
  readonly tabId: string;
  readonly session: SessionOwnerTuple;
  readonly path: string;
  readonly snapshotText: string;
  readonly expectedNewline: TextNewline;
  readonly expectedBom: boolean;
  readonly savedAt: string;
  superseded: boolean;
}

export interface AuthorityFenceRecord {
  readonly key: string;
  readonly authority: EditorAuthorityHandle;
  readonly createdAtMs: number;
  cleanupInFlight: boolean;
}

export interface EditorLifecycleDiagnostics {
  readonly activeSaveAttempts: number;
  readonly activeRefreshes: number;
  readonly unresolvedAuthorityFences: number;
  readonly settledJobHistorySize: number;
  readonly peakSettledJobHistorySize: number;
  readonly peakUnresolvedFences: number;
}

export class BoundedSettledJobHistory {
  private readonly entries = new Map<string, SaveAttemptOutcome>();
  private readonly maxSize: number;
  private peak = 0;

  constructor(maxSize = MAX_SETTLED_JOB_HISTORY) {
    this.maxSize = maxSize;
  }

  has(jobId: string): boolean {
    return this.entries.has(jobId);
  }

  record(jobId: string, outcome: SaveAttemptOutcome): void {
    if (this.entries.has(jobId)) {
      this.entries.delete(jobId);
    } else if (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(jobId, outcome);
    if (this.entries.size > this.peak) {
      this.peak = this.entries.size;
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  get peakSize(): number {
    return this.peak;
  }
}

export function sameSessionOwnerTuple(left: SessionOwnerTuple, right: SessionOwnerTuple): boolean {
  return (
    left.hostId === right.hostId &&
    left.hostSessionId === right.hostSessionId &&
    left.id === right.id
  );
}

export function authorityFenceKey(
  authority: Pick<EditorAuthorityHandle, 'session' | 'path' | 'documentId'>,
): string {
  return `${authority.session.hostId}:${authority.session.hostSessionId}:${authority.session.id}:${authority.path}:${authority.documentId}`;
}

export function isSessionOwnerMatching(
  authSession: SessionOwnerTuple,
  hostId: string,
  connected: boolean,
  hostSessionId: string | null,
  sftpSessionId: string | null,
): boolean {
  if (authSession.hostId !== hostId) return true;
  return (
    connected &&
    hostSessionId !== null &&
    sftpSessionId !== null &&
    authSession.hostSessionId === hostSessionId &&
    authSession.id === sftpSessionId
  );
}
