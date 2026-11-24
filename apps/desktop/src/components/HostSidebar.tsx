import { useRef, useState } from 'react';
import type { Host } from '@ubgops/protocol';
import { Button, Spinner } from '@ubgops/ui';
import { Icon, type IconName } from './Icon';
import { useHostSession } from '../api/queries';
import { applicationVersion as builtApplicationVersion } from '../applicationVersion';
import { ConnectionBadge } from './ConnectionBadge';

export type WorkspaceSection =
  | 'overview'
  | 'terminal'
  | 'files'
  | 'services'
  | 'network'
  | 'security'
  | 'logs'
  | 'containers';

const NAV_ITEMS: Array<{
  id: WorkspaceSection;
  label: string;
  icon: IconName;
  requiresHost: boolean;
}> = [
  { id: 'overview', label: 'Overview', icon: 'overview', requiresHost: false },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', requiresHost: true },
  { id: 'files', label: 'Files', icon: 'files', requiresHost: true },
  { id: 'services', label: 'Services', icon: 'services', requiresHost: true },
  { id: 'network', label: 'Network', icon: 'network', requiresHost: true },
  { id: 'logs', label: 'Logs', icon: 'logs', requiresHost: true },
  { id: 'containers', label: 'Containers', icon: 'containers', requiresHost: true },
  { id: 'security', label: 'Security', icon: 'security', requiresHost: true },
];

function HostItem({
  host,
  selected,
  onSelect,
}: {
  host: Host;
  selected: boolean;
  onSelect: () => void;
}) {
  const session = useHostSession(host.id, 3_000);
  const state = session.data?.state;
  return (
    <button
      type="button"
      className={`host-item ${selected ? 'host-item--selected' : ''}`}
      aria-pressed={selected}
      title={`${host.displayName} (${host.connection.username}@${host.connection.hostname}:${host.connection.port})`}
      onClick={onSelect}
    >
      <span className="host-item-icon">
        <Icon name="server" size={15} />
      </span>
      <span className="host-item-content">
        <span className="host-item-name">{host.displayName}</span>
        <span className="host-item-address">
          {host.connection.username}@{host.connection.hostname}:{host.connection.port}
        </span>
      </span>
      <span className="host-item-state" title={state ?? 'Loading status'}>
        {session.data ? (
          <ConnectionBadge state={session.data.state} />
        ) : (
          <span className="status-placeholder" aria-label="Loading status">
            ·
          </span>
        )}
      </span>
    </button>
  );
}

export function HostSidebar({
  hosts,
  selectedId,
  onSelect,
  onAdd,
  activeSection,
  onSection,
  applicationVersion = builtApplicationVersion,
  loading = false,
  collapsed = false,
  onToggleCollapse,
}: {
  hosts: Host[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: () => void;
  activeSection: WorkspaceSection;
  onSection: (section: WorkspaceSection) => void;
  applicationVersion?: string;
  loading?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [hostFilter, setHostFilter] = useState('');
  const navRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const normalizedFilter = hostFilter.trim().toLowerCase();
  const filteredHosts = normalizedFilter
    ? hosts.filter((host) =>
        [host.displayName, host.connection.hostname, host.connection.username].some((value) =>
          value.toLowerCase().includes(normalizedFilter),
        ),
      )
    : hosts;

  function moveNavFocus(currentButton: HTMLButtonElement, delta: number | 'start' | 'end') {
    const buttons = Array.from(
      navRef.current?.querySelectorAll<HTMLButtonElement>('button.nav-item:not(:disabled)') ?? [],
    );
    if (!buttons.length) return;
    if (delta === 'start') {
      buttons[0]?.focus();
      return;
    }
    if (delta === 'end') {
      buttons[buttons.length - 1]?.focus();
      return;
    }
    const index = buttons.indexOf(currentButton);
    if (index === -1) return;
    const nextIndex = (index + delta + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  }

  return (
    <aside className={`sidebar-shell ${collapsed ? 'sidebar-shell--collapsed' : ''}`}>
      <div className="nav-rail">
        <button
          type="button"
          className="brand-mark-button"
          title="UBGOps · All hosts"
          aria-label="UBGOps workspace overview"
          onClick={() => {
            onSelect(null);
            onSection('overview');
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2.8L20 7.4V16.6L12 21.2L4 16.6V7.4L12 2.8Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <path
                d="M8.5 9V13.5C8.5 15.2 9.9 16.5 12 16.5C14.1 16.5 15.5 15.2 15.5 13.5V9"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </button>

        <nav ref={navRef} className="navigation nav-rail-list" aria-label="Host navigation">
          {NAV_ITEMS.map((item) => {
            const disabled = item.requiresHost && !selectedId;
            const active = activeSection === item.id;
            const tooltip = disabled ? `${item.label} (select a host first)` : item.label;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${active ? 'nav-item--active' : ''}`}
                aria-current={active ? 'page' : undefined}
                disabled={disabled}
                title={tooltip}
                data-tooltip={tooltip}
                onClick={() => onSection(item.id)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    moveNavFocus(event.currentTarget, 1);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveNavFocus(event.currentTarget, -1);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    moveNavFocus(event.currentTarget, 'start');
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    moveNavFocus(event.currentTarget, 'end');
                  }
                }}
              >
                <span className="nav-item-icon">
                  <Icon name={item.icon} size={18} />
                </span>
                <span className="nav-item-label">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {onToggleCollapse && (
          <div className="nav-rail-bottom">
            <button
              type="button"
              className="rail-toggle"
              aria-label={collapsed ? 'Expand hosts sidebar' : 'Collapse hosts sidebar'}
              aria-expanded={!collapsed}
              title={collapsed ? 'Expand hosts sidebar' : 'Collapse hosts sidebar'}
              onClick={onToggleCollapse}
            >
              <Icon name={collapsed ? 'expand' : 'collapse'} size={17} />
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="sidebar" aria-label="Hosts sidebar">
          <div className="brand">
            <div className="brand-title-group">
              <span>
                UBG<span className="brand-light">Ops</span>
              </span>
              <span className="brand-tagline">Control plane</span>
            </div>
            <span className="build-label">PREVIEW</span>
          </div>

          <div className="sidebar-selector-wrap">
            <label className="sr-only" htmlFor="host-selector">
              Select a host
            </label>
            <select
              id="host-selector"
              className="host-selector"
              value={selectedId ?? ''}
              onChange={(event) => onSelect(event.target.value || null)}
            >
              <option value="">All hosts</option>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.displayName}
                </option>
              ))}
            </select>
          </div>

          <div className="sidebar-hosts-heading">
            <span>
              HOSTS <span className="count">{hosts.length}</span>
            </span>
            <Button variant="ghost" onClick={onAdd} aria-label="Add host" title="Add host">
              <Icon name="plus" size={16} />
            </Button>
          </div>

          <div className="sidebar-search">
            <span className="sidebar-search-icon" aria-hidden="true">
              <Icon name="search" size={14} />
            </span>
            <input
              ref={filterRef}
              id="sidebar-host-filter"
              type="search"
              aria-label="Filter sidebar hosts"
              placeholder="Filter hosts…"
              value={hostFilter}
              onChange={(event) => setHostFilter(event.target.value)}
            />
            {hostFilter && (
              <button
                type="button"
                className="sidebar-search-clear"
                aria-label="Clear host filter"
                onClick={() => {
                  setHostFilter('');
                  filterRef.current?.focus();
                }}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>

          <div className="sidebar-hosts" aria-label="Saved hosts">
            {loading && hosts.length === 0 ? (
              <div className="sidebar-loading">
                <Spinner label="Loading hosts…" />
              </div>
            ) : hosts.length === 0 ? (
              <p className="sidebar-empty">Your hosts will appear here.</p>
            ) : filteredHosts.length === 0 ? (
              <div className="sidebar-empty-filter">
                <p className="sidebar-empty">No matching hosts.</p>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setHostFilter('');
                    filterRef.current?.focus();
                  }}
                >
                  Clear filter
                </Button>
              </div>
            ) : (
              filteredHosts.map((host) => (
                <HostItem
                  key={host.id}
                  host={host}
                  selected={selectedId === host.id}
                  onSelect={() => onSelect(host.id)}
                />
              ))
            )}
          </div>

          <div className="sidebar-footer">
            <Icon name="security" size={15} />
            <div>
              <strong>Direct. Agentless.</strong>
              <span>Secure SSH connections</span>
            </div>
            <span className="version">v{applicationVersion}</span>
          </div>
        </div>
      )}
    </aside>
  );
}
