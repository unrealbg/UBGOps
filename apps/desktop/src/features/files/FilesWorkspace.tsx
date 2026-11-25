import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  ConflictPolicy, FileOperationPlan, Host, RemoteEntry, RemoteTextDocument, SftpSessionInfo, TransferJob,
} from '@ubgops/protocol';
import { Button, Modal, Notice, Spinner } from '@ubgops/ui';
import { applicationError, filesApi } from '../../api/client';
import { useHostSession } from '../../api/queries';
import { Icon } from '../../components/Icon';
import { buildRemoteBreadcrumbs, parentRemotePath } from './remotePath';
import { RemoteTextEditor } from './RemoteTextEditor';
import { ReadOnlyEditorPanel } from '../editor/ReadOnlyEditorPanel';
import {
  ReadOnlyEditorProvider,
  useOptionalReadOnlyEditor,
  useReadOnlyEditor,
} from '../editor/ReadOnlyEditorRegistry';

type EntryDialog = { type: 'mkdir'; value: string } | { type: 'rename'; entry: RemoteEntry; value: string } | null;
type Approval = { session: SftpSessionInfo; generation: number; plans: FileOperationPlan[] };

function sameSession(left: SftpSessionInfo, right: SftpSessionInfo) {
  return left.hostId === right.hostId && left.hostSessionId === right.hostSessionId && left.id === right.id;
}

function ownsPlan(session: SftpSessionInfo, plan: FileOperationPlan) {
  return session.hostId === plan.hostId && session.hostSessionId === plan.hostSessionId && session.id === plan.sftpSessionId;
}

export function FilesWorkspace(props: {
  host: Host;
  visible: boolean;
  onShowOverview: () => void;
  presentation?: 'full' | 'compact';
  onShowFull?: () => void;
}) {
  const outerRegistry = useOptionalReadOnlyEditor();
  if (outerRegistry) {
    return <FilesWorkspaceInner {...props} />;
  }
  return (
    <ReadOnlyEditorProvider>
      <FilesWorkspaceInner {...props} />
    </ReadOnlyEditorProvider>
  );
}

function FilesWorkspaceInner({ host, visible, onShowOverview, presentation = 'full', onShowFull }: {
  host: Host; visible: boolean; onShowOverview: () => void;
  presentation?: 'full' | 'compact'; onShowFull?: () => void;
}) {
  const registry = useReadOnlyEditor();
  const connection = useHostSession(host.id);
  const [sftp, setSftp] = useState<SftpSessionInfo | null>(null);
  const [listing, setListing] = useState<{ path: string; entries: RemoteEntry[]; partial: boolean; entryCap: number } | null>(null);
  const [address, setAddress] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<'name' | 'size' | 'modified'>('name');
  const [descending, setDescending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [breadcrumbMenuOpen, setBreadcrumbMenuOpen] = useState(false);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('skip');
  const [approval, setApproval] = useState<Approval | null>(null);
  const [dialog, setDialog] = useState<EntryDialog>(null);
  const [properties, setProperties] = useState<RemoteEntry | null>(null);
  const [transfers, setTransfers] = useState<TransferJob[]>([]);
  const [editor, setEditor] = useState<RemoteTextDocument | null>(null);
  const [openingEditor, setOpeningEditor] = useState(false);
  const openingEditorGuard = useRef(false);
  const mounted = useRef(true);
  const visibleNow = useRef(visible);
  useLayoutEffect(() => { visibleNow.current = visible; }, [visible]);
  const requestGeneration = useRef(0);
  const approvalGeneration = useRef(0);
  const activeSession = useRef<SftpSessionInfo | null>(null);
  const approvalRef = useRef<Approval | null>(null);
  const openingSession = useRef<{ owner: string; promise: Promise<SftpSessionInfo> } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const hostSessionId = connection.data?.hostSessionId ?? null;
  const connected = connection.data?.state === 'connected' && hostSessionId !== null;
  const connectionOwner = `${host.id}:${connected ? hostSessionId : ''}`;
  const previousOwner = useRef(connectionOwner);
  const compact = presentation === 'compact';
  const ownsConnection = !!sftp && sftp.hostId === host.id && sftp.hostSessionId === hostSessionId;
  const canMutate = connected && ownsConnection && !stale && !loading;
  const liveApproval = connected && ownsConnection && approval && sftp && sameSession(approval.session, sftp) ? approval : null;

  useLayoutEffect(() => {
    if (previousOwner.current === connectionOwner) return;
    previousOwner.current = connectionOwner;
    requestGeneration.current += 1;
    approvalGeneration.current += 1;
    activeSession.current = null;
    openingSession.current = null;
    approvalRef.current = null;
  }, [connectionOwner]);

  function clearApproval() {
    approvalRef.current = null;
    setApproval(null);
  }
  function isCurrent(session: SftpSessionInfo, generation: number) {
    return mounted.current && generation === approvalGeneration.current && !!activeSession.current && sameSession(session, activeSession.current);
  }
  function discardStale(session: SftpSessionInfo, plans: FileOperationPlan[]) {
    void Promise.allSettled(plans.filter((plan) => ownsPlan(session, plan)).map((plan) => filesApi.discardPlan(session, plan.id)));
  }
  function publishPlans(session: SftpSessionInfo, generation: number, plans: FileOperationPlan[]) {
    if (!isCurrent(session, generation) || plans.some((plan) => !ownsPlan(session, plan))) {
      discardStale(session, plans);
      return;
    }
    if (approvalRef.current) discardStale(approvalRef.current.session, approvalRef.current.plans);
    const next = { session, generation, plans };
    approvalRef.current = next;
    setApproval(next);
  }

  async function loadDirectory(
    session: SftpSessionInfo,
    target: string,
    mode:
      | { type: 'push' }
      | { type: 'replace' }
      | { type: 'history'; targetIndex?: number } = { type: 'push' },
  ) {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const result = await filesApi.list(session, target);
      if (!mounted.current || generation !== requestGeneration.current) return;
      if (
        !activeSession.current ||
        !sameSession(activeSession.current, session) ||
        result.hostId !== session.hostId ||
        result.hostSessionId !== session.hostSessionId ||
        result.sftpSessionId !== session.id
      ) {
        return;
      }
      setListing({ path: result.path, entries: result.entries, partial: result.partial, entryCap: result.entryCap });
      setAddress(result.path);
      setSelected(new Set());
      setStale(false);
      setBreadcrumbMenuOpen(false);
      if (mode.type === 'push') {
        const nextHistory = [...historyRef.current.slice(0, historyIndexRef.current + 1), result.path];
        const nextIndex = nextHistory.length - 1;
        historyRef.current = nextHistory;
        historyIndexRef.current = nextIndex;
        setHistory(nextHistory);
        setHistoryIndex(nextIndex);
      } else if (mode.type === 'replace') {
        historyRef.current = [result.path];
        historyIndexRef.current = 0;
        setHistory([result.path]);
        setHistoryIndex(0);
      } else if (typeof mode.targetIndex === 'number') {
        const boundedIndex = Math.max(
          0,
          Math.min(historyRef.current.length - 1, mode.targetIndex),
        );
        historyIndexRef.current = boundedIndex;
        setHistoryIndex(boundedIndex);
      }
    } catch (reason) {
      if (mounted.current && generation === requestGeneration.current) {
        setError(applicationError(reason).message);
      }
    } finally {
      if (mounted.current && generation === requestGeneration.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!connected) {
      requestGeneration.current += 1;
      approvalGeneration.current += 1;
      activeSession.current = null;
      approvalRef.current = null;
      let active = true;
      void Promise.resolve().then(() => {
        if (!active) return;
        setSftp(null);
        setApproval(null);
        if (listing) setStale(true);
      });
      return () => { active = false; };
    }
    if (!visible) return;
    if (activeSession.current?.hostId === host.id && activeSession.current.hostSessionId === hostSessionId) return;
    let active = true;
    if (!openingSession.current || openingSession.current.owner !== connectionOwner) {
      openingSession.current = { owner: connectionOwner, promise: Promise.resolve().then(() => filesApi.open(host.id)) };
    }
    const opening = openingSession.current;
    void opening.promise.then((session) => {
      if (!active) return;
      if (session.hostId !== host.id || session.hostSessionId !== hostSessionId) throw new Error('The SFTP session does not match the current connection.');
      if (!activeSession.current || !sameSession(activeSession.current, session)) {
        approvalGeneration.current += 1;
        approvalRef.current = null;
        setApproval(null);
        requestGeneration.current += 1;
        if (listing) setStale(true);
      }
      activeSession.current = session;
      setSftp(session);
      void loadDirectory(
        session,
        listing?.path ?? session.rootPath,
        listing ? { type: 'history' } : { type: 'replace' },
      );
    }).catch((reason) => {
      // Retire this failed attempt even after hide, without evicting a newer owner or Promise.
      if (openingSession.current?.owner === connectionOwner && openingSession.current.promise === opening.promise) {
        openingSession.current = null;
      }
      if (active) setError(applicationError(reason).message);
    });
    return () => { active = false; };
    // Reopen after a visible disconnect/reconnect transition; keep location by host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id, hostSessionId, connected, connectionOwner, visible]);

  useEffect(() => {
    registry.syncHostConnection(host.id, connected, hostSessionId, ownsConnection ? sftp.id : null);
  }, [registry, host.id, connected, hostSessionId, ownsConnection, sftp]);

  useEffect(() => {
    if (!visible || !connected) return;
    let active = true;
    const poll = () => { void filesApi.transfers(host.id).then((value) => { if (active) setTransfers(value); }).catch(() => undefined); };
    poll();
    const timer = window.setInterval(poll, 500);
    return () => { active = false; window.clearInterval(timer); };
  }, [host.id, visible, connected]);

  const entries = useMemo(() => {
    const query = filter.toLocaleLowerCase();
    return [...(listing?.entries ?? [])]
      .filter((entry) => (showHidden || !entry.name.startsWith('.')) && entry.displayName.toLocaleLowerCase().includes(query))
      .sort((left, right) => {
        let comparison = 0;
        if (sort === 'name') comparison = left.displayName.localeCompare(right.displayName);
        if (sort === 'size') comparison = compareOptionalBigInt(left.sizeBytes, right.sizeBytes);
        if (sort === 'modified') comparison = (left.modifiedAt ?? '').localeCompare(right.modifiedAt ?? '');
        return descending ? -comparison : comparison;
      });
  }, [listing, filter, showHidden, sort, descending]);
  const selectedEntries = (listing?.entries ?? []).filter((entry) => selected.has(entry.path));

  function owner(session = sftp) {
    if (!session) throw new Error('SFTP unavailable');
    return session;
  }
  function toggle(path: string, checked: boolean) {
    setSelected((current) => { const next = new Set(current); if (checked) next.add(path); else next.delete(path); return next; });
  }
  async function upload() {
    let session: SftpSessionInfo | null = null;
    let generation = approvalGeneration.current;
    setError(null);
    try {
      session = owner(); generation = approvalGeneration.current; const target = listing?.path; if (!target) return;
      const grant = await filesApi.chooseUploadFiles(session); if (!grant) return;
      if (!isCurrent(session, generation)) { void filesApi.discardGrant(session, grant.id).catch(() => undefined); return; }
      publishPlans(session, generation, [await filesApi.planUpload(session, grant.id, target, conflictPolicy)]);
    } catch (reason) { if (session && isCurrent(session, generation)) setError(applicationError(reason).message); }
  }
  async function download() {
    let session: SftpSessionInfo | null = null;
    let generation = approvalGeneration.current;
    setError(null);
    try {
      session = owner(); generation = approvalGeneration.current;
      const paths = selectedEntries.filter((entry) => entry.kind === 'file').map((entry) => entry.path); if (!paths.length) return;
      const grant = await filesApi.chooseDownloadDirectory(session); if (!grant) return;
      if (!isCurrent(session, generation)) { void filesApi.discardGrant(session, grant.id).catch(() => undefined); return; }
      publishPlans(session, generation, [await filesApi.planDownload(session, grant.id, paths, conflictPolicy)]);
    } catch (reason) { if (session && isCurrent(session, generation)) setError(applicationError(reason).message); }
  }
  async function prepareDelete() {
    let session: SftpSessionInfo | null = null;
    let generation = approvalGeneration.current;
    setError(null);
    const next: FileOperationPlan[] = [];
    try {
      session = owner(); generation = approvalGeneration.current;
      for (const entry of selectedEntries) {
        if (!isCurrent(session, generation)) break;
        next.push(await filesApi.planDelete(session, entry.path));
      }
      if (next.length) publishPlans(session, generation, next);
    } catch (reason) {
      if (session) discardStale(session, next);
      if (session && isCurrent(session, generation)) setError(applicationError(reason).message);
    }
  }
  async function prepareEntryDialog() {
    setError(null);
    let session: SftpSessionInfo | null = null;
    let generation = approvalGeneration.current;
    try {
      session = owner(); generation = approvalGeneration.current; if (!dialog || !listing) return;
      const plan = dialog.type === 'mkdir'
        ? await filesApi.planCreateDirectory(session, listing.path, dialog.value)
        : await filesApi.planRename(session, dialog.entry.path, dialog.value);
      if (isCurrent(session, generation)) setDialog(null);
      publishPlans(session, generation, [plan]);
    } catch (reason) { if (session && isCurrent(session, generation)) setError(applicationError(reason).message); }
  }
  async function executePlans() {
    if (!visibleNow.current) return;
    const pending = approvalRef.current; if (!pending) return;
    clearApproval(); setError(null);
    try {
      const session = owner();
      if (!isCurrent(pending.session, pending.generation) || !sameSession(session, pending.session)) {
        discardStale(pending.session, pending.plans);
        return;
      }
      for (const plan of pending.plans) {
        if (!isCurrent(session, pending.generation)) { discardStale(session, pending.plans); return; }
        await filesApi.execute(session, plan.id);
      }
      if (listing && isCurrent(session, pending.generation)) await loadDirectory(session, listing.path, { type: 'history' });
    } catch (reason) {
      discardStale(pending.session, pending.plans);
      if (isCurrent(pending.session, pending.generation)) setError(applicationError(reason).message);
    }
  }
  async function discardPlans() {
    const pending = approvalRef.current; if (!pending) return;
    clearApproval();
    const results = await Promise.allSettled(pending.plans.map((plan) => filesApi.discardPlan(pending.session, plan.id)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected' && isCurrent(pending.session, pending.generation)) setError(applicationError(failure.reason).message);
  }
  async function showProperties(entry: RemoteEntry) {
    try { setProperties(await filesApi.properties(owner(), entry.path)); } catch (reason) { setError(applicationError(reason).message); }
  }
  async function openEditor(entry: RemoteEntry) {
    if (entry.kind !== 'file' || editor || openingEditorGuard.current) return;
    openingEditorGuard.current = true;
    setOpeningEditor(true);
    let session: SftpSessionInfo | null = null;
    let generation = approvalGeneration.current;
    try {
      session = owner(); generation = approvalGeneration.current;
      const document = await filesApi.openText(session, entry.path);
      if (mounted.current && visibleNow.current && isCurrent(session, generation) &&
          document.hostId === session.hostId && document.hostSessionId === session.hostSessionId &&
          document.sftpSessionId === session.id) setEditor(document);
      else void filesApi.discardTextDocument({ hostId: document.hostId, hostSessionId: document.hostSessionId,
        id: document.sftpSessionId }, document.id).catch(() => undefined);
    } catch (reason) { if (mounted.current && session && isCurrent(session, generation)) setError(applicationError(reason).message); }
    finally { openingEditorGuard.current = false; if (mounted.current) setOpeningEditor(false); }
  }
  async function viewReadOnly(entry: RemoteEntry) {
    if (entry.kind !== 'file' || editor || !sftp || !connected || !ownsConnection || stale) return;
    setError(null);
    setViewerOpen(true);
    await registry.openDocument(sftp, entry.path);
  }
  async function retry(job: TransferJob) {
    let session: SftpSessionInfo | null = null;
    let generation = approvalGeneration.current;
    try {
      session = owner(); generation = approvalGeneration.current;
      publishPlans(session, generation, [await filesApi.planRetry(session, job.id)]);
    } catch (reason) { if (session && isCurrent(session, generation)) setError(applicationError(reason).message); }
  }
  const currentPath = listing?.path ?? null;
  const parentPath = currentPath ? parentRemotePath(currentPath) : null;
  const breadcrumbs = useMemo(
    () => (currentPath ? buildRemoteBreadcrumbs(currentPath) : []),
    [currentPath],
  );
  const canGoBack = !!sftp && historyIndex > 0;
  const canGoForward = !!sftp && historyIndex >= 0 && historyIndex < history.length - 1;
  const canGoParent = !!sftp && !!parentPath && !loading;
  const canRefresh = !!sftp && !!listing && !loading;

  function visitHistory(index: number) {
    const target = historyRef.current[index];
    if (!sftp || !connected || !ownsConnection || !target) return;
    void loadDirectory(sftp, target, { type: 'history', targetIndex: index });
  }

  function up() {
    if (!listing || !sftp || loading) return;
    const target = parentRemotePath(listing.path);
    if (!target) return;
    void loadDirectory(sftp, target);
  }

  function handleWorkspaceKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (editor || !sftp) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, .readonly-editor-panel')
    ) {
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.key === 'ArrowLeft') {
        if (canGoBack) {
          event.preventDefault();
          visitHistory(historyIndex - 1);
        }
      } else if (event.key === 'ArrowRight') {
        if (canGoForward) {
          event.preventDefault();
          visitHistory(historyIndex + 1);
        }
      } else if (event.key === 'ArrowUp') {
        if (canGoParent) {
          event.preventDefault();
          up();
        }
      }
    }
  }

  const hostTabs = registry.documents.filter((doc) => doc.hostId === host.id);
  const hostPending = registry.pendingOpens.filter((item) => item.hostId === host.id);
  const hostViewerError = registry.errorsByHost[host.id] ?? null;
  const activeHostTab =
    hostTabs.find((doc) => doc.id === registry.activeByHost[host.id]) ?? hostTabs[0] ?? null;
  const showReadOnlyViewer =
    !compact && !editor && viewerOpen && (hostTabs.length > 0 || hostPending.length > 0 || hostViewerError !== null);

  const maxVisibleCrumbs = compact ? 4 : 6;
  const shouldCollapseCrumbs = breadcrumbs.length > maxVisibleCrumbs;
  const tailCount = compact ? 2 : 3;
  const collapsedCrumbs = shouldCollapseCrumbs ? breadcrumbs.slice(1, breadcrumbs.length - tailCount) : [];
  const visibleTailCrumbs = shouldCollapseCrumbs ? breadcrumbs.slice(breadcrumbs.length - tailCount) : breadcrumbs;

  return (
    <section
      className={`files-workspace ${compact ? 'files-workspace--compact' : ''}`}
      aria-label={`Files on ${host.displayName}`}
      hidden={!visible}
      onKeyDown={handleWorkspaceKeyDown}
    >
      <div className="files-controls">
      <header className="files-heading">
        <div><div className="eyebrow">SFTP WORKSPACE</div><h1>{host.displayName} files</h1></div>
        <div className="files-session">{sftp ? `SFTP v${sftp.protocolVersion}` : connected ? 'Opening SFTP…' : 'Disconnected'}</div>
        {compact && <Button onClick={onShowFull}>Open full Files view</Button>}
      </header>
      {!connected && <Notice>Connect this host to browse files. {listing && 'The visible listing is stale and mutations are disabled.'}<div className="notice-action"><Button onClick={onShowOverview}>Open overview</Button></div></Notice>}
      {(stale || (!!listing && !ownsConnection)) && connected && <Notice>This listing belongs to an old connection and is read-only until refresh completes.</Notice>}
      {error && <Notice>{error}</Notice>}
      <div className="files-toolbar" aria-label="File navigation">
        <div className="files-nav-group" role="group" aria-label="Directory navigation">
          <button
            type="button"
            className="files-nav-btn"
            disabled={!canGoBack}
            aria-label="Back"
            title={canGoBack ? 'Back to previous directory (Alt+Left)' : 'No previous directory in history (Alt+Left)'}
            onClick={() => visitHistory(historyIndex - 1)}
          >
            <Icon name="arrowLeft" size={16} />
          </button>
          <button
            type="button"
            className="files-nav-btn"
            disabled={!canGoForward}
            aria-label="Forward"
            title={canGoForward ? 'Forward in directory history (Alt+Right)' : 'No forward directory in history (Alt+Right)'}
            onClick={() => visitHistory(historyIndex + 1)}
          >
            <Icon name="arrowRight" size={16} />
          </button>
          <button
            type="button"
            className="files-nav-btn"
            disabled={!canGoParent}
            aria-label="Parent directory"
            title={parentPath ? `Open parent directory ${parentPath} (Alt+Up)` : 'Already at root directory (/)'}
            onClick={up}
          >
            <Icon name="arrowUp" size={16} />
          </button>
          <button
            type="button"
            className="files-nav-btn"
            disabled={!canRefresh}
            aria-label="Refresh"
            title={canRefresh ? 'Refresh current directory' : 'Directory unavailable to refresh'}
            onClick={() => { if (sftp && listing) void loadDirectory(sftp, listing.path, { type: 'history' }); }}
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>
        <form className="files-address" onSubmit={(event) => { event.preventDefault(); if (sftp) void loadDirectory(sftp, address); }}>
          <label className="sr-only" htmlFor={`files-address-${host.id}`}>Remote path</label>
          <input
            id={`files-address-${host.id}`}
            value={address}
            title={address || 'Enter remote path'}
            onChange={(event) => setAddress(event.target.value)}
            spellCheck={false}
          />
          <Button type="submit" disabled={!sftp || loading}>Go</Button>
        </form>
      </div>
      {listing && breadcrumbs.length > 0 && (
        <nav
          className="files-breadcrumbs"
          aria-label="Remote path breadcrumbs"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && breadcrumbMenuOpen) {
              event.stopPropagation();
              setBreadcrumbMenuOpen(false);
            }
          }}
        >
          {shouldCollapseCrumbs && breadcrumbs[0] && (
            <>
              <button
                type="button"
                className="files-breadcrumb files-breadcrumb--root"
                title={breadcrumbs[0].path}
                disabled={!sftp || loading}
                onClick={() => { if (sftp) void loadDirectory(sftp, breadcrumbs[0]!.path); }}
              >
                {breadcrumbs[0].label}
              </button>
              <span className="files-breadcrumb-sep" aria-hidden="true">
                <Icon name="chevronRight" size={12} />
              </span>
              <div className="files-breadcrumb-overflow">
                <button
                  type="button"
                  className="files-breadcrumb files-breadcrumb--more"
                  aria-expanded={breadcrumbMenuOpen}
                  aria-label={`Show ${collapsedCrumbs.length} parent directories`}
                  title="Show hidden ancestor directories"
                  onClick={() => setBreadcrumbMenuOpen((current) => !current)}
                >
                  …
                </button>
                {breadcrumbMenuOpen && (
                  <div className="files-breadcrumb-menu" role="menu" aria-label="Ancestor directories">
                    {collapsedCrumbs.map((crumb) => (
                      <button
                        key={crumb.path}
                        type="button"
                        role="menuitem"
                        title={crumb.path}
                        disabled={!sftp || loading}
                        onClick={() => {
                          if (!sftp) return;
                          setBreadcrumbMenuOpen(false);
                          void loadDirectory(sftp, crumb.path);
                        }}
                      >
                        {crumb.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="files-breadcrumb-sep" aria-hidden="true">
                <Icon name="chevronRight" size={12} />
              </span>
            </>
          )}
          {visibleTailCrumbs.map((crumb, index) => {
            const isCurrent = index === visibleTailCrumbs.length - 1;
            return (
              <Fragment key={crumb.path}>
                {index > 0 && (
                  <span className="files-breadcrumb-sep" aria-hidden="true">
                    <Icon name="chevronRight" size={12} />
                  </span>
                )}
                <button
                  type="button"
                  className={`files-breadcrumb ${crumb.path === '/' ? 'files-breadcrumb--root' : ''} ${isCurrent ? 'files-breadcrumb--current' : ''}`}
                  title={crumb.path}
                  aria-current={isCurrent ? 'location' : undefined}
                  disabled={!sftp || loading}
                  onClick={() => { if (sftp && !isCurrent) void loadDirectory(sftp, crumb.path); }}
                >
                  {crumb.label}
                </button>
              </Fragment>
            );
          })}
        </nav>
      )}
      <div className="files-actions" hidden={compact}>
        <Button disabled={!canMutate} onClick={() => void upload()}>Upload files…</Button>
        <Button disabled={!canMutate || !selectedEntries.some((entry) => entry.kind === 'file')} onClick={() => void download()}>Download selected…</Button>
        <Button disabled={!canMutate || !!editor || selectedEntries.length !== 1 || selectedEntries[0]?.kind !== 'file'} onClick={() => { const entry = selectedEntries[0]; if (entry) void viewReadOnly(entry); }}>View (Read-only)</Button>
        <Button disabled={!canMutate || !!editor || openingEditor || selectedEntries.length !== 1 || selectedEntries[0]?.kind !== 'file'} onClick={() => { const entry = selectedEntries[0]; if (entry) void openEditor(entry); }}>Edit</Button>
        <Button disabled={!canMutate} onClick={() => setDialog({ type: 'mkdir', value: '' })}>New directory</Button>
        <Button disabled={!canMutate || selectedEntries.length !== 1 || selectedEntries[0]?.kind !== 'file'} onClick={() => { const entry = selectedEntries[0]; if (entry) setDialog({ type: 'rename', entry, value: entry.name }); }}>Rename</Button>
        <Button variant="danger" disabled={!canMutate || selectedEntries.length === 0} onClick={() => void prepareDelete()}>Delete</Button>
        <label>Conflict <select value={conflictPolicy} onChange={(event) => setConflictPolicy(event.target.value as ConflictPolicy)}><option value="skip">Skip</option><option value="keepBoth">Keep both</option><option value="replace">Replace</option></select></label>
      </div>
      <div className="files-view-options">
        <label><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} /> Show hidden</label>
        <label>Filter loaded entries <input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
        <span>{listing ? `${listing.entries.length}${listing.partial ? '+' : ''} loaded` : 'No listing'}</span>
        {!compact && !editor && !showReadOnlyViewer && (hostTabs.length > 0 || hostPending.length > 0) && (
          <Button onClick={() => setViewerOpen(true)}>
            Open viewer ({hostTabs.length})
          </Button>
        )}
      </div>
      </div>
      {editor ? <RemoteTextEditor initial={editor} host={host} session={sftp} connected={connected} visible={visible} transfers={transfers} onClose={() => setEditor(null)} /> : showReadOnlyViewer ? (
        <ReadOnlyEditorPanel
          hostDisplayName={host.displayName}
          tabs={hostTabs}
          totalOpenCount={registry.documents.length}
          activeTab={activeHostTab}
          pendingOpens={hostPending}
          error={hostViewerError}
          onSelectTab={(documentId) => registry.selectDocument(host.id, documentId)}
          onCloseTab={(documentId) => {
            registry.closeDocument(documentId);
            if (hostTabs.length <= 1 && hostPending.length === 0 && !hostViewerError) {
              setViewerOpen(false);
            }
          }}
          onCloseAllHostTabs={() => {
            registry.closeHostDocuments(host.id);
            registry.clearHostError(host.id);
            if (hostPending.length === 0) setViewerOpen(false);
          }}
          onCancelPending={(requestId) => { void registry.cancelOpen(host.id, requestId); }}
          onDismissError={() => {
            registry.clearHostError(host.id);
            if (hostTabs.length === 0 && hostPending.length === 0) setViewerOpen(false);
          }}
          onBrowseFiles={() => setViewerOpen(false)}
        />
      ) : <div className="files-table-wrap">
        {loading && !listing ? <Spinner label="Loading remote directory…" /> : (
          <table className="files-table">
            <thead><tr><th><span className="sr-only">Select</span></th><th><button onClick={() => { if (sort === 'name') setDescending(!descending); else { setSort('name'); setDescending(false); } }}>Name</button></th><th>Type</th><th><button onClick={() => { if (sort === 'size') setDescending(!descending); else { setSort('size'); setDescending(false); } }}>Size</button></th><th><button onClick={() => { if (sort === 'modified') setDescending(!descending); else { setSort('modified'); setDescending(false); } }}>Modified</button></th><th>Mode</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {listing && parentPath && sftp && !stale && (
                <tr
                  className="files-parent-row"
                  onDoubleClick={() => { if (!loading) up(); }}
                >
                  <td aria-hidden="true" />
                  <td>
                    <button
                      type="button"
                      className="file-name file-name--parent"
                      disabled={loading}
                      aria-label="Parent directory (..)"
                      title={`Open parent directory (${parentPath})`}
                      onClick={up}
                    >
                      <Icon name="arrowUp" size={13} /> ..
                    </button>
                  </td>
                  <td>parent</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td />
                </tr>
              )}
              {entries.map((entry) => <tr key={entry.path} className={selected.has(entry.path) ? 'is-selected' : ''} onDoubleClick={() => { if (entry.kind === 'directory' && sftp) void loadDirectory(sftp, entry.path); }}>
              <td><input aria-label={`Select ${entry.displayName}`} type="checkbox" checked={selected.has(entry.path)} onChange={(event) => toggle(entry.path, event.target.checked)} /></td>
              <td><button className="file-name" onClick={() => toggle(entry.path, !selected.has(entry.path))} onKeyDown={(event) => { if (event.key === 'Enter' && entry.kind === 'directory' && sftp) void loadDirectory(sftp, entry.path); }}>{entry.kind === 'directory' ? '📁' : entry.kind === 'symlink' ? '↗' : '▧'} {entry.displayName}</button></td>
              <td>{entry.kind}</td><td>{entry.sizeBytes ?? 'Unknown'}</td><td>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : 'Unknown'}</td><td>{entry.permissions ?? 'Unknown'}</td>
              <td className="files-row-actions">
                {!compact && entry.kind === 'file' && (
                  <button
                    type="button"
                    disabled={!canMutate || !!editor}
                    onClick={() => void viewReadOnly(entry)}
                  >
                    View
                  </button>
                )}
                <button onClick={() => void showProperties(entry)}>Properties</button>
              </td>
            </tr>)}</tbody>
          </table>
        )}
        {listing?.partial && <Notice>Partial listing: the safety cap of {listing.entryCap} entries was reached. Sorting and filtering apply only to loaded entries.</Notice>}
      </div>}
      <section className="transfer-queue" aria-label="Transfer queue" hidden={compact}><h2>Transfers</h2>{transfers.length === 0 ? <p>No transfers in this session.</p> : transfers.map((job) => <div className="transfer-row" key={job.id}><div><strong>{job.direction === 'upload' ? '↑' : '↓'} {job.sourceDisplay}</strong><span> → {job.destinationDisplay}</span></div><div><span className={`transfer-state transfer-state--${job.state}`}>{job.state}</span> <span>{formatProgress(job)}</span>{['queued','preparing','transferring'].includes(job.state) && <button onClick={() => { if (sftp) void filesApi.cancel(sftp, job.id); }}>Cancel</button>}{job.retryable && <button onClick={() => void retry(job)}>Prepare retry</button>}</div>{job.error && <span className="transfer-error">{job.error.message}</span>}</div>)}</section>
      {visible && dialog && <Modal title={dialog.type === 'mkdir' ? 'Create remote directory' : 'Rename remote entry'} onClose={() => setDialog(null)}><label className="field"><span>Name</span><input autoFocus value={dialog.value} onChange={(event) => setDialog({ ...dialog, value: event.target.value })} /></label><p className="dialog-description">The operation will be prepared as an immutable plan. Rename never overwrites an existing destination.</p><div className="modal-actions"><Button onClick={() => setDialog(null)}>Cancel</Button><Button disabled={!dialog.value} onClick={() => void prepareEntryDialog()}>Review plan</Button></div></Modal>}
      {visible && liveApproval && <Modal title="Approve file operation" onClose={() => { void discardPlans(); }}><p className="dialog-description">Host: <strong>{host.displayName}</strong>. This one-time approval expires at {new Date(liveApproval.plans[0]!.expiresAt).toLocaleTimeString()}.</p>{liveApproval.plans.map((plan) => <div className="file-plan" key={plan.id}><strong>{plan.kind} · {plan.risk}{plan.conflictPolicy ? ` · Conflict: ${plan.conflictPolicy}` : ''}</strong>{plan.items.map((item, index) => <div key={index}><code>{item.sourceDisplay}</code> → <code>{item.destinationDisplay}</code>{item.sizeBytes && ` · ${item.sizeBytes} bytes`}</div>)}</div>)}{liveApproval.plans.some((plan) => plan.kind === 'delete') && <Notice>Delete is permanent. Directories must be empty; symbolic links are removed without following their target.</Notice>}<div className="modal-actions"><Button onClick={() => { void discardPlans(); }}>Cancel</Button><Button variant={liveApproval.plans.some((plan) => plan.kind === 'delete') ? 'danger' : 'primary'} onClick={() => void executePlans()}>Approve and execute</Button></div></Modal>}
      {visible && properties && <Modal title="Remote properties" onClose={() => setProperties(null)}><dl className="properties"><dt>Name</dt><dd>{properties.displayName}</dd><dt>Type</dt><dd>{properties.kind}</dd><dt>Size</dt><dd>{properties.sizeBytes ?? 'Unknown'}</dd><dt>Modified</dt><dd>{properties.modifiedAt ?? 'Unknown'}</dd><dt>Permissions</dt><dd>{properties.permissions ?? 'Unknown'}</dd><dt>UID / GID</dt><dd>{properties.uid ?? 'Unknown'} / {properties.gid ?? 'Unknown'}</dd></dl><div className="modal-actions"><Button onClick={() => setProperties(null)}>Close</Button></div></Modal>}
    </section>
  );
}

function compareOptionalBigInt(left: string | null, right: string | null) { if (left === right) return 0; if (left === null) return 1; if (right === null) return -1; const a = BigInt(left); const b = BigInt(right); return a < b ? -1 : a > b ? 1 : 0; }
function formatProgress(job: TransferJob) { if (!job.totalBytes) return `${job.confirmedBytes} bytes`; const confirmed = BigInt(job.confirmedBytes); const total = BigInt(job.totalBytes); const percent = total === 0n ? 100n : (confirmed * 100n) / total; return `${confirmed} / ${total} bytes (${percent}%)`; }
