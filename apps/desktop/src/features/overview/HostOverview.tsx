import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Host, HostKeyChallenge } from '@ubgops/protocol';
import { Button, Notice, Spinner } from '@ubgops/ui';
import { hostApi, applicationError } from '../../api/client';
import { hostKeys, useHostSession } from '../../api/queries';
import { ConnectionBadge } from '../../components/ConnectionBadge';
import { Icon } from '../../components/Icon';
import { DiscoveryDetails } from './DiscoveryDetails';
import { uptime } from './format';
import { HostKeyNotice } from './HostKeyNotice';
import { LiveMonitoring } from './LiveMonitoring';

export function HostOverview({
  host,
  onEdit,
  onDelete,
  compactUnified = false,
  monitoringVisible = true,
  systemInfoOpen = false,
  onToggleSystemInfo,
}: {
  host: Host;
  onEdit: () => void;
  onDelete: () => void;
  compactUnified?: boolean;
  monitoringVisible?: boolean;
  systemInfoOpen?: boolean;
  onToggleSystemInfo?: () => void;
}) {
  const queryClient = useQueryClient();
  const sessionQuery = useHostSession(host.id);
  const command = useMutation({
    mutationFn: (action: 'connect' | 'reconnect' | 'refresh') => hostApi[action](host.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: hostKeys.session(host.id) }),
  });
  // Cancellation remains independently callable while a long connect/discovery is pending.
  const disconnect = useMutation({
    mutationFn: () => hostApi.disconnect(host.id),
    onSettled: () => {
      command.reset();
      return queryClient.invalidateQueries({ queryKey: hostKeys.session(host.id) });
    },
  });
  const trust = useMutation({
    mutationFn: async (challenge: HostKeyChallenge) => {
      await hostApi.trust(host.id, challenge);
      await hostApi.connect(host.id);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: hostKeys.session(host.id) }),
  });

  const session = sessionQuery.data;
  const state = session?.state ?? 'disconnected';
  const busy =
    command.isPending || trust.isPending || state === 'connecting' || state === 'disconnecting';
  const active = state === 'connected' || state === 'connecting' || state === 'awaitingTrust';
  const operationError = disconnect.error ?? trust.error ?? command.error;
  const error = session?.error ?? (operationError ? applicationError(operationError) : null);
  const keyError = error?.code === 'unknownHostKey' || error?.code === 'changedHostKey';

  if (state === 'connected' && session && compactUnified) {
    const discovery = session.discovery;
    return (
      <div className="host-unified-header-wrap">
        <header className="host-header-unified">
          <div className="host-header-unified-main">
            <div className="host-header-unified-title">
              <h1>{host.displayName}</h1>
              <ConnectionBadge state={state} />
              <span className="host-header-endpoint mono">
                {host.connection.username}@{host.connection.hostname}:{host.connection.port}
              </span>
            </div>
            {discovery && (
              <div className="host-header-facts" aria-label="Host snapshot summary">
                {discovery.os && <span>{discovery.os}</span>}
                {discovery.osVersion && <span>{discovery.osVersion}</span>}
                {discovery.kernel && <span>Kernel {discovery.kernel}</span>}
                <span>Up {uptime(discovery.uptimeSeconds)}</span>
                {discovery.loadOne !== null && <span>Load {discovery.loadOne.toFixed(2)}</span>}
              </div>
            )}
          </div>
          <div className="host-header-unified-actions">
            {onToggleSystemInfo && (
              <Button
                variant="ghost"
                aria-expanded={systemInfoOpen}
                onClick={onToggleSystemInfo}
              >
                <Icon name="overview" size={14} />
                {systemInfoOpen ? 'Hide system info' : 'System info'}
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => command.mutate('refresh')}>
              <Icon name="refresh" size={14} />
              {command.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => command.mutate('reconnect')}>
              Reconnect
            </Button>
            <Button
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </div>
        </header>

        {error && !keyError && error.code !== 'cancelled' && (
          <Notice>
            <strong>Unable to complete the request.</strong> {error.message}
          </Notice>
        )}

        <LiveMonitoring
          hostId={host.id}
          hostSessionId={session.hostSessionId}
          connected
          visible={monitoringVisible}
          compact
        />

        {systemInfoOpen && (
          <section className="system-info-drawer" aria-label="Host system details">
            <div className="system-info-drawer-bar">
              <span>Snapshot &amp; SSH endpoint verification</span>
              <div className="system-info-drawer-actions">
                <Button variant="ghost" onClick={onEdit} disabled={busy || active}>
                  Edit host
                </Button>
                <Button variant="ghost" onClick={onDelete} disabled={busy || active}>
                  Delete
                </Button>
              </div>
            </div>
            {discovery ? (
              <DiscoveryDetails discovery={discovery} session={session} compactDrawer />
            ) : (
              <div className="state-panel state-panel--compact">
                <Spinner label="Discovering system information…" />
              </div>
            )}
          </section>
        )}
      </div>
    );
  }

  return (
    <>
      <header className="page-heading page-heading--compact">
        <div>
          <div className="eyebrow">HOST OVERVIEW</div>
          <div className="host-title-inline">
            <h1>{host.displayName}</h1>
            <ConnectionBadge state={state} />
          </div>
          <div className="host-subtitle">
            <span className="mono">
              {host.connection.username}@{host.connection.hostname}:{host.connection.port}
            </span>
          </div>
        </div>
        <div className="heading-actions">
          <Button variant="ghost" onClick={onEdit} disabled={busy || active}>
            Edit host
          </Button>
          <Button variant="ghost" onClick={onDelete} disabled={busy || active}>
            Delete
          </Button>
          {active || busy ? (
            <Button
              disabled={disconnect.isPending || state === 'disconnecting'}
              onClick={() => disconnect.mutate()}
            >
              {state === 'connecting' || state === 'awaitingTrust'
                ? 'Cancel connection'
                : 'Disconnect'}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={
                sessionQuery.isPending || (state === 'failed' && error?.code === 'changedHostKey')
              }
              onClick={() => {
                trust.reset();
                command.mutate('connect');
              }}
            >
              <Icon name="terminal" size={15} />
              Connect
            </Button>
          )}
        </div>
      </header>
      {state === 'connected' && (
        <div className="section-tabs">
          <span className="section-tab">Overview</span>
          <div className="section-tabs-right">
            <Button variant="ghost" disabled={busy} onClick={() => command.mutate('reconnect')}>
              Reconnect
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => command.mutate('refresh')}>
              <Icon name="refresh" size={14} />
              {command.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>
      )}
      {sessionQuery.isPending && (
        <div className="state-panel">
          <Spinner label="Reading connection state…" />
        </div>
      )}
      {sessionQuery.isError && (
        <Notice>
          {applicationError(sessionQuery.error).message}
          <div className="notice-action">
            <Button
              onClick={() => {
                void sessionQuery.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        </Notice>
      )}
      {error && keyError && (
        <HostKeyNotice
          key={`${error.code}:${error.hostKey?.fingerprint}`}
          error={error}
          busy={trust.isPending}
          onTrust={(challenge) => {
            command.reset();
            trust.mutate(challenge);
          }}
        />
      )}
      {error && !keyError && error.code !== 'cancelled' && (
        <Notice>
          <strong>Unable to complete the request.</strong> {error.message}
        </Notice>
      )}
      {state === 'connecting' && (
        <div className="state-panel">
          <Spinner label="Connecting and discovering this host…" />
          <p>Verifying host identity, then collecting read-only system information.</p>
        </div>
      )}
      {state === 'disconnecting' && (
        <div className="state-panel">
          <Spinner label="Closing the SSH session…" />
        </div>
      )}
      {session && (state === 'connected' || state === 'disconnected' || state === 'failed') && (
        <LiveMonitoring
          hostId={host.id}
          hostSessionId={session.hostSessionId}
          connected={state === 'connected'}
          visible={monitoringVisible}
          compact
        />
      )}
      {state === 'connected' &&
        session &&
        (session.discovery ? (
          <DiscoveryDetails discovery={session.discovery} session={session} />
        ) : (
          <div className="state-panel">
            <Spinner label="Discovering system information…" />
          </div>
        ))}
      {(state === 'disconnected' || state === 'failed') && !sessionQuery.isPending && !keyError && (
        <section className="connection-empty">
          <span className="large-icon">
            <Icon name="server" size={28} />
          </span>
          <h2>{state === 'failed' ? 'Connection needs attention' : 'Ready when you are'}</h2>
          <p>
            {state === 'failed'
              ? 'Review the connection details and try again.'
              : 'Connect to discover this host’s system information and open a remote terminal.'}
          </p>
          <div className="connection-facts">
            <span>
              <Icon name="security" size={14} />
              Verified SSH identity
            </span>
            <span>
              <Icon name="terminal" size={14} />
              Unified shell &amp; SFTP
            </span>
          </div>
        </section>
      )}
    </>
  );
}
