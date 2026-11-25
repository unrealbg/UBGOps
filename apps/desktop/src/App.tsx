import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CredentialInput, Host, HostInput } from '@ubgops/protocol';
import { SecurityWorkspace } from './features/security/SecurityWorkspace';
import { Button, Modal, Notice, Spinner } from '@ubgops/ui';
import { hostApi, applicationError } from './api/client';
import { hostKeys, useHosts, useHostSession } from './api/queries';
import { useSelection } from './state/selection';
import { CommandPalette } from './components/CommandPalette';
import { ConnectionBadge } from './components/ConnectionBadge';
import { HostSidebar, type WorkspaceSection } from './components/HostSidebar';
import { Icon } from './components/Icon';
import { UpdateCheck } from './components/UpdateCheck';
import { HostForm } from './features/hosts/HostForm';
import { HostList } from './features/hosts/HostList';
import { HostOverview } from './features/overview/HostOverview';
import { LiveMonitoring } from './features/overview/LiveMonitoring';
import { TerminalWorkspace, type TerminalWorkspaceHandle } from './features/terminal/TerminalWorkspace';
import { FilesWorkspace } from './features/files/FilesWorkspace';
import { ReadOnlyEditorProvider, useReadOnlyEditor } from './features/editor/ReadOnlyEditorRegistry';
import { ServicesWorkspace } from './features/services/ServicesWorkspace';
import { LogsWorkspace } from './features/logs/LogsWorkspace';
import { ContainersWorkspace } from './features/containers/ContainersWorkspace';
import { NetworkWorkspace } from './features/network/NetworkWorkspace';
import { CompactMonitorStrip } from './features/overview/CompactMonitorStrip';

type DialogState =
  | { type: 'add' }
  | { type: 'edit'; host: Host }
  | { type: 'delete'; host: Host }
  | null;

const FILES_MIN_WIDTH = 280;
const TERMINAL_MIN_WIDTH = 400;
const SPLIT_HANDLE_WIDTH = 8;

const SECTION_LABELS: Record<WorkspaceSection, string> = {
  overview: 'Overview',
  terminal: 'Terminal',
  files: 'Files',
  services: 'Services',
  network: 'Network',
  security: 'Security',
  logs: 'Logs',
  containers: 'Containers',
};

// A host's two workspaces always occupy these same parent slots. Modes change
// visibility and presentation, never the owner or parent of a mounted pane.
function SshWorkspace({
  host,
  mode,
  terminalVisited,
  filesVisited,
  focused,
  editorFocused = false,
  embedded = false,
  showCompactMonitor = false,
  monitoringOpen = false,
  monitoringSlot,
  onToggleMonitoring,
  onToggleFocus,
  onToggleEditorFocus,
  onExitEditorFocus,
  onShowOverview,
  onShowFiles,
}: {
  host: Host;
  mode: 'terminal' | 'files' | null;
  terminalVisited: boolean;
  filesVisited: boolean;
  focused: boolean;
  editorFocused?: boolean;
  embedded?: boolean;
  showCompactMonitor?: boolean;
  monitoringOpen?: boolean;
  monitoringSlot?: ReactNode;
  onToggleMonitoring?: () => void;
  onToggleFocus: () => void;
  onToggleEditorFocus?: () => void;
  onExitEditorFocus?: () => void;
  onShowOverview: () => void;
  onShowFiles: () => void;
}) {
  const connection = useHostSession(host.id);
  const [combined, setCombined] = useState(false);
  const [filesRequested, setFilesRequested] = useState(false);
  const [terminalOpening, setTerminalOpening] = useState(false);
  const [fraction, setFraction] = useState(0.33);
  const [width, setWidth] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const terminalActionsRef = useRef<TerminalWorkspaceHandle | null>(null);
  const drag = useRef<{
    pointer: number;
    element: HTMLElement;
    startX: number;
    startLeft: number;
  } | null>(null);
  const panelId = useId();
  const narrow = width < FILES_MIN_WIDTH + TERMINAL_MIN_WIDTH + SPLIT_HANDLE_WIDTH;
  const split = mode === 'terminal' && combined && !narrow;
  const filesVisible = mode === 'files' || split;
  const maximum = Math.max(FILES_MIN_WIDTH, width - TERMINAL_MIN_WIDTH - SPLIT_HANDLE_WIDTH);
  const left = Math.min(
    maximum,
    Math.max(FILES_MIN_WIDTH, (width - SPLIT_HANDLE_WIDTH) * fraction),
  );

  const stopDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.element.hasPointerCapture(current.pointer)) {
      current.element.releasePointerCapture(current.pointer);
    }
  }, []);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => stopDrag, [split, stopDrag]);

  function resize(next: number) {
    if (!split) return;
    setFraction(Math.min(maximum, Math.max(FILES_MIN_WIDTH, next)) / (width - SPLIT_HANDLE_WIDTH));
  }

  const connected = connection.data?.state === 'connected';
  const toggleFiles = () => {
    setFilesRequested(true);
    setCombined((current) => !current);
  };

  return (
    <div className="ssh-host-root" hidden={mode === null}>
      {mode === 'terminal' && !embedded && (
        <header className="terminal-heading" aria-label={`${host.displayName} terminal toolbar`}>
          <div className="terminal-heading-identity">
            <div className="eyebrow">REMOTE TERMINAL</div>
            <div className="terminal-title-line">
              <h1>{host.displayName}</h1>
              <ConnectionBadge state={connection.data?.state ?? 'disconnected'} />
              <span className="terminal-endpoint mono">
                {host.connection.username}@{host.connection.hostname}:{host.connection.port}
              </span>
            </div>
          </div>
          <div className="heading-actions terminal-workspace-actions">
            {onToggleMonitoring && (
              <Button
                variant="ghost"
                aria-pressed={monitoringOpen}
                disabled={!connected}
                onClick={onToggleMonitoring}
              >
                <Icon name="activity" size={14} />
                {monitoringOpen ? 'Hide monitoring' : 'Show monitoring'}
              </Button>
            )}
            <Button aria-pressed={combined} onClick={toggleFiles}>
              {combined ? 'Hide files panel' : 'Combine Terminal + Files'}
            </Button>
            <Button
              variant="ghost"
              aria-pressed={focused}
              title={focused ? 'Exit terminal focus mode' : 'Focus terminal workspace'}
              onClick={onToggleFocus}
            >
              <Icon name={focused ? 'minimize' : 'maximize'} size={14} />
              {focused ? 'Exit focus' : 'Focus'}
            </Button>
            <Button variant="ghost" onClick={onShowOverview}>
              Overview
            </Button>
            <Button
              variant="primary"
              disabled={!connected || terminalOpening}
              onClick={() => terminalActionsRef.current?.openTerminal()}
            >
              <Icon name="plus" size={14} />
              {terminalOpening ? 'Opening…' : 'New terminal'}
            </Button>
          </div>
        </header>
      )}
      {monitoringSlot}
      <div
        ref={root}
        className={`ssh-layout ${split ? 'ssh-layout--split' : ''}`}
        style={
          split
            ? { gridTemplateColumns: `${left}px ${SPLIT_HANDLE_WIDTH}px minmax(0, 1fr)` }
            : undefined
        }
      >
        <div id={`${panelId}-files`} className="ssh-files-slot" hidden={!filesVisible}>
          {(filesVisited || filesRequested) && (
            <FilesWorkspace
              host={host}
              visible={filesVisible}
              presentation={mode === 'files' ? 'full' : 'compact'}
              editorFocused={mode === 'files' && editorFocused}
              onToggleEditorFocus={onToggleEditorFocus}
              onExitEditorFocus={onExitEditorFocus}
              onShowFull={onShowFiles}
              onShowOverview={onShowOverview}
            />
          )}
        </div>
        <div
          className="ssh-separator"
          hidden={!split}
          role="separator"
          aria-label="Resize files panel"
          aria-orientation="vertical"
          aria-controls={`${panelId}-files ${panelId}-terminal`}
          aria-valuemin={FILES_MIN_WIDTH}
          aria-valuemax={Math.round(maximum)}
          aria-valuenow={Math.round(left)}
          aria-valuetext={`${Math.round(left)} pixels for files`}
          tabIndex={split ? 0 : -1}
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowLeft'
                ? left - 16
                : event.key === 'ArrowRight'
                  ? left + 16
                  : event.key === 'Home'
                    ? FILES_MIN_WIDTH
                    : event.key === 'End'
                      ? maximum
                      : null;
            if (next !== null) {
              event.preventDefault();
              resize(next);
            }
          }}
          onPointerDown={(event) => {
            if (!split || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointer: event.pointerId,
              element: event.currentTarget,
              startX: event.clientX,
              startLeft: left,
            };
          }}
          onPointerMove={(event) => {
            if (drag.current?.pointer === event.pointerId) {
              resize(drag.current.startLeft + event.clientX - drag.current.startX);
            }
          }}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onLostPointerCapture={stopDrag}
        />
        <div id={`${panelId}-terminal`} className="ssh-terminal-slot" hidden={mode !== 'terminal'}>
          {terminalVisited && (
            <TerminalWorkspace
              host={host}
              visible={mode === 'terminal'}
              onShowOverview={onShowOverview}
              combined={combined}
              focused={focused}
              embedded={embedded}
              hideHeading={!embedded}
              monitoringOpen={monitoringOpen}
              onToggleMonitoring={onToggleMonitoring}
              onToggleFocus={onToggleFocus}
              onToggleFiles={toggleFiles}
              actionsRef={terminalActionsRef}
              onOpeningChange={setTerminalOpening}
            />
          )}
        </div>
      </div>
      {mode === 'terminal' && combined && narrow && (
        <div className="ssh-collapsed-files" role="status">
          Files panel collapsed to keep the terminal usable.{' '}
          <Button onClick={onShowFiles}>Open full Files view</Button>
        </div>
      )}
      <CompactMonitorStrip
        hostId={host.id}
        hostSessionId={connection.data?.hostSessionId ?? null}
        connected={connection.data?.state === 'connected'}
        visible={showCompactMonitor && mode === 'terminal' && combined}
      />
    </div>
  );
}

export default function App({
  initialSection = 'overview',
  initialTerminalMonitoring = false,
}: {
  initialSection?: WorkspaceSection;
  initialTerminalMonitoring?: boolean;
} = {}) {
  return (
    <ReadOnlyEditorProvider>
      <AppShellContent
        initialSection={initialSection}
        initialTerminalMonitoring={initialTerminalMonitoring}
      />
    </ReadOnlyEditorProvider>
  );
}

function AppShellContent({
  initialSection = 'overview',
  initialTerminalMonitoring = false,
}: {
  initialSection?: WorkspaceSection;
  initialTerminalMonitoring?: boolean;
}) {
  const { purgeHost } = useReadOnlyEditor();
  const hostsQuery = useHosts();
  const queryClient = useQueryClient();
  const { hostId, select } = useSelection();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [section, setSection] = useState<WorkspaceSection>(initialSection);
  const [terminalHosts, setTerminalHosts] = useState<string[]>(() =>
    initialSection === 'terminal' && hostId ? [hostId] : [],
  );
  const [fileHosts, setFileHosts] = useState<string[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalFocus, setTerminalFocus] = useState(false);
  const [editorFocus, setEditorFocus] = useState(false);
  const [systemInfoOpen, setSystemInfoOpen] = useState(false);
  const [terminalMonitoringOpen, setTerminalMonitoringOpen] = useState(initialTerminalMonitoring);

  const hosts = hostsQuery.data ?? [];
  const selectedHost = hosts.find((host) => host.id === hostId) ?? null;
  const selectedSession = useHostSession(selectedHost?.id ?? '');
  const isSelectedConnected = Boolean(selectedHost && selectedSession.data?.state === 'connected');
  const overviewUnifiedMode = Boolean(
    selectedHost && isSelectedConnected && section === 'overview',
  );
  const activeTerminalFocus = Boolean(
    terminalFocus && selectedHost && (section === 'terminal' || overviewUnifiedMode),
  );
  const activeEditorFocus = Boolean(editorFocus && selectedHost && section === 'files');
  const terminalViewportLocked = Boolean(
    selectedHost && (section === 'terminal' || section === 'files' || overviewUnifiedMode),
  );

  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', handleGlobalKey, true);
    return () => window.removeEventListener('keydown', handleGlobalKey, true);
  }, []);

  function visitTerminal(host: Host) {
    setTerminalHosts((current) => (current.includes(host.id) ? current : [...current, host.id]));
  }

  function selectHost(id: string | null) {
    if (overviewUnifiedMode && selectedHost) visitTerminal(selectedHost);
    select(id);
    setSystemInfoOpen(false);
    setEditorFocus(false);
    const host = hosts.find((candidate) => candidate.id === id);
    if (!host) {
      setTerminalFocus(false);
      setTerminalMonitoringOpen(false);
    }
    if (host && section === 'terminal') visitTerminal(host);
    if (host && section === 'files') {
      setFileHosts((current) => (current.includes(host.id) ? current : [...current, host.id]));
    }
  }

  function selectSection(next: WorkspaceSection) {
    if (overviewUnifiedMode && selectedHost) visitTerminal(selectedHost);
    setSection(next);
    if (next !== 'overview') setSystemInfoOpen(false);
    if (next !== 'files') setEditorFocus(false);
    if (next !== 'terminal' && !(next === 'overview' && isSelectedConnected)) {
      setTerminalFocus(false);
    }
    if (next === 'terminal' && selectedHost) visitTerminal(selectedHost);
    if (next === 'files' && selectedHost) {
      setFileHosts((current) =>
        current.includes(selectedHost.id) ? current : [...current, selectedHost.id],
      );
    }
  }

  // Do not move this into useMutation: its cache retains mutation variables, including secrets.
  async function saveHost(input: HostInput, credential: CredentialInput | null) {
    const saved = await hostApi.save(input, credential);
    await queryClient.invalidateQueries({ queryKey: hostKeys.all });
    await queryClient.invalidateQueries({ queryKey: hostKeys.session(saved.id) });
    select(saved.id);
    if (section === 'terminal') visitTerminal(saved);
  }
  async function deleteHost(host: Host) {
    setDeleting(true);
    setDeleteError(null);
    try {
      await hostApi.delete(host.id);
      purgeHost(host.id);
      queryClient.removeQueries({ queryKey: hostKeys.session(host.id) });
      await queryClient.invalidateQueries({ queryKey: hostKeys.all });
      if (hostId === host.id) select(null);
      setDialog(null);
    } catch (error) {
      setDeleteError(applicationError(error).message);
    } finally {
      setDeleting(false);
    }
  }

  const showHostOverview = Boolean(selectedHost && section === 'overview');
  const terminalMonitoringVisible = Boolean(
    selectedHost &&
      isSelectedConnected &&
      section === 'terminal' &&
      terminalMonitoringOpen &&
      !activeTerminalFocus,
  );

  return (
    <div
      className={`app-shell ${terminalViewportLocked ? 'app-shell--viewport-locked' : ''} ${activeTerminalFocus ? 'app-shell--terminal-focus' : ''} ${activeEditorFocus ? 'app-shell--editor-focus' : ''}`}
    >
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <HostSidebar
        hosts={hosts}
        selectedId={selectedHost?.id ?? null}
        onSelect={selectHost}
        onAdd={() => setDialog({ type: 'add' })}
        activeSection={section}
        onSection={selectSection}
        loading={hostsQuery.isPending}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((current) => !current)}
      />
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              type="button"
              onClick={() => {
                selectHost(null);
                selectSection('overview');
              }}
            >
              Workspace
            </button>
            <span className="breadcrumb-sep">/</span>
            <span className="breadcrumb-host">{selectedHost?.displayName ?? 'Overview'}</span>
            {selectedHost && (
              <>
                <span className="breadcrumb-sep">/</span>
                <span className="breadcrumb-current">{SECTION_LABELS[section]}</span>
              </>
            )}
          </div>

          <div className="topbar-center">
            <button
              type="button"
              className="command-trigger"
              aria-label="Open command palette"
              aria-keyshortcuts="Control+K"
              onClick={() => setPaletteOpen(true)}
            >
              <Icon name="search" size={14} />
              <span className="command-trigger-text">Jump to host or workspace…</span>
              <kbd className="command-shortcut">Ctrl+K</kbd>
            </button>
          </div>

          <div className="topbar-actions">
            <UpdateCheck />
            <span className="topbar-label">
              <span className="local-dot" />
              Local control plane
            </span>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className={`main-content ${overviewUnifiedMode ? 'main-content--unified' : ''} ${section === 'terminal' ? 'main-content--terminal' : ''} ${section === 'files' ? 'main-content--files' : ''}`}
        >
          {hostsQuery.isPending ? (
            <div className="state-panel">
              <Spinner label="Loading your workspace…" />
            </div>
          ) : hostsQuery.isError ? (
            <>
              <header className="page-heading">
                <div>
                  <div className="eyebrow">LOCAL WORKSPACE</div>
                  <h1>Your infrastructure</h1>
                </div>
              </header>
              <Notice>
                {applicationError(hostsQuery.error).message}
                <div className="notice-action">
                  <Button
                    onClick={() => {
                      void hostsQuery.refetch();
                    }}
                  >
                    Try again
                  </Button>
                </div>
              </Notice>
            </>
          ) : showHostOverview && selectedHost ? (
            <HostOverview
              key={selectedHost.id}
              host={selectedHost}
              compactUnified={isSelectedConnected}
              monitoringVisible={!activeTerminalFocus}
              systemInfoOpen={systemInfoOpen}
              onToggleSystemInfo={() => setSystemInfoOpen((current) => !current)}
              onEdit={() => setDialog({ type: 'edit', host: selectedHost })}
              onDelete={() => {
                setDeleteError(null);
                setDialog({ type: 'delete', host: selectedHost });
              }}
            />
          ) : !selectedHost ? (
            <HostList
              hosts={hosts}
              onSelect={selectHost}
              onAdd={() => setDialog({ type: 'add' })}
            />
          ) : null}
          {[
            ...new Set([
              ...terminalHosts,
              ...fileHosts,
              ...(overviewUnifiedMode && selectedHost ? [selectedHost.id] : []),
            ]),
          ].map((id) => {
            const host = hosts.find((candidate) => candidate.id === id);
            if (!host) return null;
            const isSelected = selectedHost?.id === id;
            const hostUnified = isSelected && overviewUnifiedMode;
            const mode: 'terminal' | 'files' | null = isSelected
              ? section === 'files'
                ? 'files'
                : section === 'terminal' || hostUnified
                  ? 'terminal'
                  : null
              : null;
            const showMonitoringHere = isSelected && terminalMonitoringVisible && mode === 'terminal';
            return (
              <SshWorkspace
                key={host.id}
                host={host}
                mode={mode}
                terminalVisited={terminalHosts.includes(id) || hostUnified}
                filesVisited={fileHosts.includes(id)}
                focused={activeTerminalFocus && isSelected}
                editorFocused={activeEditorFocus && isSelected}
                embedded={hostUnified}
                showCompactMonitor={false}
                monitoringOpen={terminalMonitoringOpen}
                monitoringSlot={
                  showMonitoringHere ? (
                    <LiveMonitoring
                      key={`term-mon:${host.id}`}
                      hostId={host.id}
                      hostSessionId={selectedSession.data?.hostSessionId ?? null}
                      connected
                      visible
                      compact
                    />
                  ) : null
                }
                onToggleMonitoring={() => setTerminalMonitoringOpen((current) => !current)}
                onToggleFocus={() => setTerminalFocus((current) => !current)}
                onToggleEditorFocus={() => setEditorFocus((current) => !current)}
                onExitEditorFocus={() => setEditorFocus(false)}
                onShowOverview={() => selectSection('overview')}
                onShowFiles={() => selectSection('files')}
              />
            );
          })}
          {selectedHost && section === 'services' && (
            <ServicesWorkspace key={selectedHost.id} host={selectedHost} />
          )}
          {selectedHost && section === 'logs' && (
            <LogsWorkspace key={selectedHost.id} host={selectedHost} />
          )}
          {selectedHost && section === 'containers' && (
            <ContainersWorkspace key={selectedHost.id} host={selectedHost} />
          )}
          {selectedHost && section === 'network' && (
            <NetworkWorkspace key={selectedHost.id} host={selectedHost} />
          )}
          {selectedHost && section === 'security' && (
            <SecurityWorkspace key={selectedHost.id} host={selectedHost} />
          )}
        </main>
        <footer className="app-footer">
          <span>
            UBGOps <span className="footer-divider">/</span>{' '}
            {overviewUnifiedMode
              ? 'Unified SSH workspace'
              : section === 'files'
                ? 'SFTP files'
                : section === 'services'
                  ? 'System services'
                  : section === 'network'
                    ? 'Network interfaces'
                    : section === 'security'
                      ? 'SSH endpoint trust'
                      : section === 'containers'
                        ? 'Docker containers'
                        : section === 'logs'
                          ? 'System journal'
                          : section === 'overview'
                            ? 'Infrastructure overview'
                            : 'Terminal workspace'}
          </span>
          <span>
            {section === 'security'
              ? 'Local trust metadata · on demand'
              : section === 'files'
                ? 'Agentless · streamed transfers'
                : section === 'services' ||
                    section === 'network' ||
                    section === 'containers' ||
                    section === 'logs'
                  ? 'Read-only · on demand'
                  : 'Interactive PTY · local scrollback'}
          </span>
        </footer>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        hosts={hosts}
        selectedHost={selectedHost}
        activeSection={section}
        sidebarCollapsed={sidebarCollapsed}
        terminalFocus={activeTerminalFocus}
        editorFocus={activeEditorFocus}
        unifiedConnected={overviewUnifiedMode}
        systemInfoOpen={systemInfoOpen}
        terminalMonitoringOpen={terminalMonitoringOpen}
        onSelectHost={selectHost}
        onSelectSection={selectSection}
        onAddHost={() => setDialog({ type: 'add' })}
        onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
        onToggleTerminalFocus={() => setTerminalFocus((current) => !current)}
        onToggleEditorFocus={() => setEditorFocus((current) => !current)}
        onToggleSystemInfo={() => setSystemInfoOpen((current) => !current)}
        onToggleTerminalMonitoring={() => setTerminalMonitoringOpen((current) => !current)}
      />
      {dialog && dialog.type !== 'delete' && (
        <HostForm
          key={dialog.type === 'edit' ? dialog.host.id : 'new'}
          host={dialog.type === 'edit' ? dialog.host : null}
          onSave={saveHost}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'delete' && (
        <Modal
          title="Delete this host?"
          onClose={() => {
            if (!deleting) setDialog(null);
          }}
        >
          <p className="dialog-description">
            <strong>{dialog.host.displayName}</strong> and its saved credentials will be removed
            from this workspace. This does not make any changes to the remote server.
          </p>
          {deleteError && <Notice>{deleteError}</Notice>}
          <div className="modal-actions">
            <Button disabled={deleting} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleting}
              onClick={() => {
                void deleteHost(dialog.host);
              }}
            >
              {deleting ? 'Deleting…' : 'Delete host'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
