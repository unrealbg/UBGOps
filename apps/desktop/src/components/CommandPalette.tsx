import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Host } from '@ubgops/protocol';
import { Icon, type IconName } from './Icon';
import type { WorkspaceSection } from './HostSidebar';

export type PaletteAction = {
  id: string;
  category: string;
  label: string;
  detail: string;
  icon: IconName;
  keywords?: string;
  disabled?: boolean;
  run: () => void;
};

export function CommandPalette({
  open,
  onClose,
  hosts,
  selectedHost,
  activeSection,
  sidebarCollapsed,
  terminalFocus,
  editorFocus = false,
  canEditorFocus = false,
  unifiedConnected = false,
  systemInfoOpen = false,
  terminalMonitoringOpen = false,
  onSelectHost,
  onSelectSection,
  onAddHost,
  onToggleSidebar,
  onToggleTerminalFocus,
  onToggleEditorFocus,
  onToggleSystemInfo,
  onToggleTerminalMonitoring,
}: {
  open: boolean;
  onClose: () => void;
  hosts: Host[];
  selectedHost: Host | null;
  activeSection: WorkspaceSection;
  sidebarCollapsed: boolean;
  terminalFocus: boolean;
  editorFocus?: boolean;
  canEditorFocus?: boolean;
  unifiedConnected?: boolean;
  systemInfoOpen?: boolean;
  terminalMonitoringOpen?: boolean;
  onSelectHost: (id: string | null) => void;
  onSelectSection: (section: WorkspaceSection) => void;
  onAddHost: () => void;
  onToggleSidebar: () => void;
  onToggleTerminalFocus: () => void;
  onToggleEditorFocus?: () => void;
  onToggleSystemInfo?: () => void;
  onToggleTerminalMonitoring?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
    });
    return () => {
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous && previous.isConnected) {
        previous.focus();
      }
    };
  }, [open]);

  const actions = useMemo<PaletteAction[]>(() => {
    const items: PaletteAction[] = [];

    const hostRequired = !selectedHost;
    const sections: Array<{
      id: WorkspaceSection;
      label: string;
      icon: IconName;
      disabled?: boolean;
    }> = [
      { id: 'overview', label: 'Go to Overview', icon: 'overview', disabled: false },
      { id: 'terminal', label: 'Go to Terminal', icon: 'terminal', disabled: hostRequired },
      { id: 'files', label: 'Go to Files (SFTP)', icon: 'files', disabled: hostRequired },
      { id: 'services', label: 'Go to Services', icon: 'services', disabled: hostRequired },
      { id: 'network', label: 'Go to Network', icon: 'network', disabled: hostRequired },
      { id: 'logs', label: 'Go to Logs', icon: 'logs', disabled: hostRequired },
      { id: 'containers', label: 'Go to Containers', icon: 'containers', disabled: hostRequired },
      { id: 'security', label: 'Go to Security', icon: 'security', disabled: hostRequired },
    ];

    for (const item of sections) {
      items.push({
        id: `section:${item.id}`,
        category: 'Workspace',
        label: item.label,
        detail: item.disabled
          ? 'Select a host first'
          : activeSection === item.id
            ? `Active · ${selectedHost?.displayName ?? 'All hosts'}`
            : selectedHost
              ? selectedHost.displayName
              : 'All hosts',
        icon: item.icon,
        keywords: `${item.id} section navigation`,
        disabled: item.disabled,
        run: () => onSelectSection(item.id),
      });
    }

    items.push({
      id: 'action:all-hosts',
      category: 'Navigation',
      label: 'Show all hosts inventory',
      detail: 'Clear host selection and open fleet table',
      icon: 'overview',
      keywords: 'all hosts workspace inventory list',
      run: () => {
        onSelectHost(null);
        onSelectSection('overview');
      },
    });

    items.push({
      id: 'action:add-host',
      category: 'Hosts',
      label: 'Add a host',
      detail: 'Open new SSH host profile dialog',
      icon: 'plus',
      keywords: 'new host profile ssh',
      run: onAddHost,
    });

    items.push({
      id: 'action:toggle-sidebar',
      category: 'View',
      label: sidebarCollapsed ? 'Expand hosts sidebar' : 'Collapse hosts sidebar',
      detail: 'Toggle the saved hosts drawer',
      icon: sidebarCollapsed ? 'expand' : 'collapse',
      keywords: 'sidebar drawer hosts toggle',
      run: onToggleSidebar,
    });

    if (selectedHost && (activeSection === 'terminal' || unifiedConnected)) {
      items.push({
        id: 'action:terminal-focus',
        category: 'Terminal',
        label: terminalFocus ? 'Exit terminal focus mode' : 'Enter terminal focus mode',
        detail: terminalFocus ? 'Restore sidebar and command chrome' : 'Expand terminal canvas',
        icon: terminalFocus ? 'minimize' : 'maximize',
        keywords: 'focus maximize terminal fullscreen',
        run: onToggleTerminalFocus,
      });
    }

    if (selectedHost && activeSection === 'files' && canEditorFocus && onToggleEditorFocus) {
      items.push({
        id: 'action:editor-focus',
        category: 'Files & Viewer',
        label: editorFocus ? 'Exit editor focus mode' : 'Enter editor focus mode',
        detail: editorFocus ? 'Restore workspace navigation and header' : 'Expand read-only Monaco viewer',
        icon: editorFocus ? 'minimize' : 'maximize',
        keywords: 'focus maximize editor monaco fullscreen files',
        run: onToggleEditorFocus,
      });
    }

    if (selectedHost && activeSection === 'terminal' && onToggleTerminalMonitoring) {
      items.push({
        id: 'action:terminal-monitoring',
        category: 'Terminal',
        label: terminalMonitoringOpen ? 'Hide live monitoring' : 'Show live monitoring',
        detail: 'Toggle the 6-card telemetry strip above Terminal',
        icon: 'activity',
        keywords: 'monitoring telemetry charts cpu memory disk network',
        run: onToggleTerminalMonitoring,
      });
    }

    if (selectedHost && unifiedConnected && onToggleSystemInfo) {
      items.push({
        id: 'action:system-info',
        category: 'Host',
        label: systemInfoOpen ? 'Hide system info panel' : 'Show system info panel',
        detail: 'Inspect SSH trust fingerprint, capabilities, and OS snapshot',
        icon: 'overview',
        keywords: 'system info discovery fingerprint capabilities snapshot',
        run: onToggleSystemInfo,
      });
    }

    for (const host of hosts) {
      items.push({
        id: `host:${host.id}`,
        category: 'Hosts',
        label: host.displayName,
        detail: `${host.connection.username}@${host.connection.hostname}:${host.connection.port}`,
        icon: 'server',
        keywords: `${host.displayName} ${host.connection.hostname} ${host.connection.username}`,
        run: () => onSelectHost(host.id),
      });
    }

    return items;
  }, [
    activeSection,
    canEditorFocus,
    editorFocus,
    hosts,
    onAddHost,
    onSelectHost,
    onSelectSection,
    onToggleEditorFocus,
    onToggleSidebar,
    onToggleSystemInfo,
    onToggleTerminalFocus,
    onToggleTerminalMonitoring,
    selectedHost,
    sidebarCollapsed,
    systemInfoOpen,
    terminalFocus,
    terminalMonitoringOpen,
    unifiedConnected,
  ]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return actions;
    return actions.filter((action) =>
      [action.label, action.detail, action.category, action.keywords ?? ''].some((value) =>
        value.toLowerCase().includes(term),
      ),
    );
  }, [actions, query]);

  const safeActiveIndex = filtered.length ? Math.min(activeIndex, filtered.length - 1) : -1;

  function execute(action: PaletteAction | undefined) {
    if (!action || action.disabled) return;
    onClose();
    action.run();
  }

  function moveActive(delta: number) {
    if (!filtered.length) return;
    const base = safeActiveIndex < 0 ? 0 : safeActiveIndex;
    const next = (base + delta + filtered.length) % filtered.length;
    setActiveIndex(next);
  }

  if (!open) return null;

  const activeItem = safeActiveIndex >= 0 ? filtered[safeActiveIndex] : undefined;

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveActive(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveActive(-1);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            execute(activeItem);
          }
        }}
      >
        <div className="command-palette-input-row">
          <span className="command-palette-icon" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          <input
            ref={inputRef}
            type="search"
            className="command-palette-input"
            aria-label="Filter commands and hosts"
            aria-controls={listboxId}
            aria-activedescendant={activeItem ? `palette-opt-${activeItem.id}` : undefined}
            placeholder="Type a host name, workspace, or UI action…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
          />
          <button
            type="button"
            className="command-palette-esc"
            onClick={onClose}
            aria-label="Close command palette"
          >
            Esc
          </button>
        </div>

        <div id={listboxId} className="command-palette-list" role="listbox" aria-label="Actions">
          {filtered.length === 0 ? (
            <div className="command-palette-empty" role="status">
              No matching hosts or navigation actions.
            </div>
          ) : (
            filtered.map((item, index) => {
              const active = index === safeActiveIndex;
              return (
                <button
                  key={item.id}
                  id={`palette-opt-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={item.disabled}
                  className={`command-palette-item ${active ? 'command-palette-item--active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => execute(item)}
                >
                  <span className="command-palette-item-icon">
                    <Icon name={item.icon} size={15} />
                  </span>
                  <span className="command-palette-item-text">
                    <span className="command-palette-item-label">{item.label}</span>
                    <span className="command-palette-item-detail">{item.detail}</span>
                  </span>
                  <span className="command-palette-item-category">{item.category}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="command-palette-footer">
          <span>↑↓ Navigate</span>
          <span>Enter Open</span>
          <span>Esc Close</span>
          <span className="command-palette-safety">UI navigation only</span>
        </div>
      </div>
    </div>
  );
}
