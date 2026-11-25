/** Development-only visual test entry. Never imported by the production app/build. */
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ContainerSnapshot,
  DirectoryListing,
  DnsConfigurationSnapshot,
  Host,
  HostMonitorSample,
  HostSession,
  ListeningPortSnapshot,
  NetworkRouteSnapshot,
  NetworkSnapshot,
  ServiceSnapshot,
  SftpSessionInfo,
  SshEndpointTrust,
  SystemJournalSnapshot,
  TerminalOutputBatch,
  TerminalSession,
} from '@ubgops/protocol';
import App from '../App';
import {
  containersApi,
  filesApi,
  hostApi,
  logsApi,
  monitorApi,
  networkApi,
  securityApi,
  servicesApi,
  terminalApi,
  updateApi,
} from '../api/client';
import { useSelection } from '../state/selection';
import { connected, disconnected, host } from './fixtures';
import '@ubgops/ui/styles.css';
import '../styles.css';

if (!import.meta.env.DEV) throw new Error('Visual test entry is development-only.');

const params = new URLSearchParams(location.search);
const mode = params.get('state') ?? 'connected';
const initialSection = params.get('section') === 'terminal' ? 'terminal' : 'overview';
const initialTerminalMonitoring = params.get('monitoring') === '1';

const hosts: Host[] =
  mode === 'empty'
    ? []
    : [
        host,
        {
          ...host,
          id: 'test-host-2',
          displayName: 'Test worker',
          connection: {
            ...host.connection,
            hostname: 'worker.example.test',
            authentication: 'privateKey',
          },
        },
        {
          ...host,
          id: 'test-host-3',
          displayName: 'Primary database replica with very long descriptive label',
          connection: {
            ...host.connection,
            hostname: 'db-replica-01.example.test',
            port: 2222,
            authentication: 'privateKey',
          },
        },
        {
          ...host,
          id: 'test-host-4',
          displayName: 'Edge ingress node',
          connection: {
            ...host.connection,
            hostname: 'edge-01.example.test',
            authentication: 'password',
          },
        },
      ];

const session: HostSession =
  mode === 'unknown' || mode === 'changed'
    ? {
        ...disconnected,
        state: mode === 'unknown' ? 'awaitingTrust' : 'failed',
        error: {
          code: mode === 'unknown' ? 'unknownHostKey' : 'changedHostKey',
          message: 'Visual test host-key challenge.',
          hostKey: {
            hostname: host.connection.hostname,
            port: 22,
            algorithm: 'ssh-ed25519',
            fingerprint: 'SHA256:UHEOcEvPnWsLfATpKNAVBkfrnzBZpcvQQtwLXDeOxlc',
            previousFingerprint:
              mode === 'changed' ? 'SHA256:ORhMQdlQzuYYNkDFefzHAMXlDoKRExqmqETftHrYAcg' : null,
          },
        },
      }
    : connected;

const sessionById = (id: string): HostSession => {
  if (id === host.id) return session;
  if (id === 'test-host-3') {
    return { ...disconnected, hostId: id, state: 'awaitingTrust' };
  }
  if (id === 'test-host-4') {
    return {
      ...disconnected,
      hostId: id,
      state: 'failed',
      error: { code: 'refused', message: 'Synthetic connection refused.', hostKey: null },
    };
  }
  return { ...disconnected, hostId: id };
};

hostApi.list = async () => hosts;
hostApi.session = async (id) => sessionById(id);
hostApi.connect = hostApi.reconnect = hostApi.disconnect = hostApi.refresh = async () => undefined;
hostApi.trust = async () => undefined;
hostApi.save = async () => {
  throw {
    code: 'policy',
    message: 'Saving is disabled in this visual test fixture.',
    hostKey: null,
  };
};
hostApi.delete = async () => undefined;

updateApi.state = async () => ({
  currentVersion: '0.1.2',
  phase: 'upToDate',
  availableVersion: null,
  announcementId: null,
  verifiedArtifactId: null,
  installationSupported: false,
});
updateApi.check = updateApi.state;

let sampleStep = 0;
const cpuCurve = [34.2, 41.8, 38.5, 49.4, 53.1, 46.7, 58.2, 44.6];
const memCurve = [4.1, 4.3, 4.6, 4.5, 4.9, 5.1, 4.8, 5.0];
const rxCurve = [420_000, 780_000, 610_000, 1_240_000, 950_000, 1_480_000, 890_000, 1_120_000];
const txCurve = [190_000, 310_000, 275_000, 540_000, 480_000, 620_000, 410_000, 490_000];
const diskReadCurve = [2_400_000, 6_800_000, 4_200_000, 12_400_000, 5_600_000, 9_100_000, 3_800_000, 7_400_000];
const diskWriteCurve = [950_000, 2_100_000, 1_650_000, 4_800_000, 2_900_000, 5_300_000, 1_900_000, 3_400_000];

monitorApi.sample = async (hostId, hostSessionId): Promise<HostMonitorSample> => {
  const idx = sampleStep % cpuCurve.length;
  sampleStep += 1;
  const warnings =
    mode === 'diskio-unavailable'
      ? [{ code: 'discovery' as const, message: 'disk I/O monitoring is unavailable.', hostKey: null }]
      : [];
  const diskIo =
    mode === 'diskio-unavailable' || mode === 'diskio-warming'
      ? null
      : {
          primaryDevice: 'sdd',
          primaryMajor: 8,
          primaryMinor: 48,
          primaryKind: 'virtualDisk' as const,
          primaryDiskSeq: '28',
          primaryDeviceId: 'naa.60022480',
          isRootBacking: true,
          readBytesPerSecond: diskReadCurve[idx]!,
          writeBytesPerSecond: diskWriteCurve[idx]!,
          devices: [
            {
              name: 'sdd',
              major: 8,
              minor: 48,
              kind: 'virtualDisk' as const,
              diskSeq: '28',
              deviceId: 'naa.60022480',
              isRootBacking: true,
              readBytesPerSecond: diskReadCurve[idx]!,
              writeBytesPerSecond: diskWriteCurve[idx]!,
            },
          ],
        };
  return {
    hostId,
    hostSessionId,
    observedAt: new Date().toISOString(),
    cpuUsagePercent: mode === 'diskio-warming' ? null : cpuCurve[idx]!,
    memoryTotalBytes: 8 * 1024 ** 3,
    memoryUsedBytes: Math.round(memCurve[idx]! * 1024 ** 3),
    swapTotalBytes: 2 * 1024 ** 3,
    swapUsedBytes: Math.round((0.18 + (idx % 3) * 0.04) * 1024 ** 3),
    rootTotalBytes: 100 * 1024 ** 3,
    rootUsedBytes: Math.round((32.4 + (idx % 4) * 0.3) * 1024 ** 3),
    networkRxBytesPerSecond: mode === 'diskio-warming' ? null : rxCurve[idx]!,
    networkTxBytesPerSecond: mode === 'diskio-warming' ? null : txCurve[idx]!,
    diskIo,
    warnings,
  };
};

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

const syntheticTabs: TerminalSession[] = [
  {
    id: 'term-visual-1',
    hostId: host.id,
    hostSessionId: connected.hostSessionId!,
    label: 'deploy@gateway',
    state: 'open',
    size: { columns: 100, rows: 28, pixelWidth: 800, pixelHeight: 500 },
    error: null,
  },
  {
    id: 'term-visual-2',
    hostId: host.id,
    hostSessionId: connected.hostSessionId!,
    label: 'journal-inspect',
    state: 'open',
    size: { columns: 100, rows: 28, pixelWidth: 800, pixelHeight: 500 },
    error: null,
  },
];
const emittedOutput = new Set<string>();

terminalApi.list = async (hostId) => (hostId === host.id ? syntheticTabs : []);
terminalApi.open = async (hostId, size) => ({
  id: `term-visual-${syntheticTabs.length + 1}`,
  hostId,
  hostSessionId: connected.hostSessionId!,
  label: 'Shell',
  state: 'open',
  size,
  error: null,
});
terminalApi.poll = async (sess): Promise<TerminalOutputBatch> => {
  const tab = syntheticTabs.find((item) => item.id === sess.id) ?? syntheticTabs[0]!;
  if (emittedOutput.has(sess.id)) {
    return { session: tab, chunksBase64: [], outputDrained: false };
  }
  emittedOutput.add(sess.id);
  const samplePtyText =
    sess.id === 'term-visual-1'
      ? [
          '\x1b[1;36mdeploy@gateway\x1b[0m:\x1b[1;34m~\x1b[0m$ uname -srm && uptime -p\r\n',
          'Linux 6.12.0-synthetic x86_64\r\n',
          'up 1 day, 1 hour, 14 minutes\r\n\r\n',
          '\x1b[1;36mdeploy@gateway\x1b[0m:\x1b[1;34m~\x1b[0m$ systemctl --failed --no-legend\r\n',
          '\x1b[32m●\x1b[0m 0 loaded units failed (simulated fixture)\r\n\r\n',
          '\x1b[1;36mdeploy@gateway\x1b[0m:\x1b[1;34m~\x1b[0m$ ss -lnt | head -n 5\r\n',
          '\x1b[90mState      Recv-Q Send-Q Local Address:Port   Peer Address:Port\x1b[0m\r\n',
          'LISTEN     0      128    192.0.2.10:22        0.0.0.0:*\r\n',
          'LISTEN     0      511    \x1b[33m127.0.0.1:8080\x1b[0m       0.0.0.0:*\r\n',
          '\x1b[1;36mdeploy@gateway\x1b[0m:\x1b[1;34m~\x1b[0m$ ',
        ].join('')
      : '\x1b[1;36mdeploy@gateway\x1b[0m:\x1b[1;34m~\x1b[0m$ # Secondary synthetic session ready\r\n';
  return { session: tab, chunksBase64: [toBase64(samplePtyText)], outputDrained: false };
};
terminalApi.write = async () => undefined;
terminalApi.resize = async () => undefined;
terminalApi.rename = async (sess, label) => ({
  ...(syntheticTabs.find((t) => t.id === sess.id) ?? syntheticTabs[0]!),
  label,
});
terminalApi.close = async () => undefined;

const sftpSession: SftpSessionInfo = {
  id: 'sftp-visual-1',
  hostId: host.id,
  hostSessionId: connected.hostSessionId!,
  protocolVersion: 3,
  rootPath: '/home/test',
  extensions: [{ name: 'posix-rename@openssh.com', version: '1' }],
  limits: {
    maxPacketBytes: '262144',
    maxReadBytes: '65536',
    maxWriteBytes: '65536',
    maxOpenHandles: '64',
    clientChunkBytes: '65536',
    listingEntryCap: 5000,
  },
};

filesApi.open = async () => sftpSession;
filesApi.list = async (_sess, path): Promise<DirectoryListing> => ({
  hostId: host.id,
  hostSessionId: connected.hostSessionId!,
  sftpSessionId: sftpSession.id,
  path,
  partial: false,
  entryCap: 5000,
  entries: [
    {
      name: 'configs',
      displayName: 'configs',
      path: `${path}/configs`,
      kind: 'directory',
      sizeBytes: null,
      modifiedAt: '2026-09-14T11:20:00Z',
      permissions: 'drwxr-xr-x',
      uid: 1000,
      gid: 1000,
    },
    {
      name: 'nginx.conf',
      displayName: 'nginx.conf',
      path: `${path}/nginx.conf`,
      kind: 'file',
      sizeBytes: '4280',
      modifiedAt: '2026-09-14T10:05:00Z',
      permissions: '-rw-r--r--',
      uid: 1000,
      gid: 1000,
    },
    {
      name: 'synthetic-report.json',
      displayName: 'synthetic-report.json',
      path: `${path}/synthetic-report.json`,
      kind: 'file',
      sizeBytes: '18432',
      modifiedAt: '2026-09-14T09:40:00Z',
      permissions: '-rw-r--r--',
      uid: 1000,
      gid: 1000,
    },
  ],
});
filesApi.transfers = async () => [];

servicesApi.list = async (hostId, hostSessionId): Promise<ServiceSnapshot> => ({
  hostId,
  hostSessionId,
  observedAt: '2026-09-14T12:00:00Z',
  entries: [
    {
      unit: 'ssh.service',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      description: 'OpenBSD Secure Shell server (synthetic)',
      canStart: false,
      canReload: true,
      resetFailedObservationId: null,
      tryRestartObservationId: 'obs-ssh-restart',
      reloadObservationId: 'obs-ssh-reload',
      startObservationId: null,
    },
    {
      unit: 'nginx.service',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      description: 'Reverse proxy HTTP server (synthetic)',
      canStart: false,
      canReload: true,
      resetFailedObservationId: null,
      tryRestartObservationId: 'obs-nginx-restart',
      reloadObservationId: 'obs-nginx-reload',
      startObservationId: null,
    },
    {
      unit: 'worker-sync.service',
      loadState: 'loaded',
      activeState: 'failed',
      subState: 'failed',
      description: 'Periodic dataset sync worker (synthetic)',
      canStart: true,
      canReload: false,
      resetFailedObservationId: 'obs-worker-reset',
      tryRestartObservationId: null,
      reloadObservationId: null,
      startObservationId: 'obs-worker-start',
    },
  ],
});

networkApi.list = async (hostId, hostSessionId): Promise<NetworkSnapshot> => ({
  hostId,
  hostSessionId,
  observedAt: '2026-09-14T12:00:00Z',
  entries: [
    {
      ifindex: 1,
      name: 'lo',
      operState: 'unknown',
      mtu: 65536,
      addresses: [{ family: 'ipv4', address: '127.0.0.1', prefixLength: 8 }],
    },
    {
      ifindex: 2,
      name: 'eth0',
      operState: 'up',
      mtu: 1500,
      addresses: [
        { family: 'ipv4', address: '192.0.2.10', prefixLength: 24 },
        { family: 'ipv6', address: '2001:db8::10', prefixLength: 64 },
      ],
    },
  ],
});
networkApi.routes = async (hostId, hostSessionId): Promise<NetworkRouteSnapshot> => ({
  hostId,
  hostSessionId,
  observedAt: '2026-09-14T12:00:00Z',
  entries: [
    {
      family: 'ipv4',
      destination: 'default',
      gateway: '192.0.2.1',
      interface: 'eth0',
      metric: 100,
      onLink: false,
      linkDown: false,
      preference: null,
    },
    {
      family: 'ipv4',
      destination: '192.0.2.0/24',
      gateway: null,
      interface: 'eth0',
      metric: 100,
      onLink: true,
      linkDown: false,
      preference: null,
    },
  ],
});
networkApi.listeningPorts = async (hostId, hostSessionId): Promise<ListeningPortSnapshot> => ({
  hostId,
  hostSessionId,
  observedAt: '2026-09-14T12:00:00Z',
  entries: [
    { protocol: 'tcp', family: 'ipv4', localAddress: '192.0.2.10', port: 22, state: 'listen' },
    { protocol: 'tcp', family: 'ipv4', localAddress: '127.0.0.1', port: 8080, state: 'listen' },
  ],
});
networkApi.dnsConfiguration = async (
  hostId,
  hostSessionId,
): Promise<DnsConfigurationSnapshot> => ({
  hostId,
  hostSessionId,
  observedAt: '2026-09-14T12:00:00Z',
  nameservers: [{ address: '192.0.2.53', family: 'ipv4' }],
  searchDirective: 'search',
  searchDomains: ['example.test'],
  options: ['edns0'],
  sortlist: [],
});

logsApi.list = async (hostId, hostSessionId): Promise<SystemJournalSnapshot> => ({
  hostId,
  hostSessionId,
  observedAt: '2026-09-14T12:00:00Z',
  entries: [
    {
      timestamp: '2026-09-14T11:59:12Z',
      priority: 'info',
      unit: 'ssh.service',
      identifier: 'sshd',
      messageState: 'text',
      message: 'Accepted publickey for deploy from 198.51.100.4 port 51204 (synthetic)',
    },
    {
      timestamp: '2026-09-14T11:58:03Z',
      priority: 'warning',
      unit: 'worker-sync.service',
      identifier: 'worker-sync',
      messageState: 'text',
      message: 'Retry backoff scheduled for synthetic replication queue',
    },
  ],
});

containersApi.list = async (hostId, hostSessionId): Promise<ContainerSnapshot> => ({
  hostId,
  hostSessionId,
  observedAt: '2026-09-14T12:00:00Z',
  provider: 'dockerSystem',
  entries: [
    {
      id: 'a1b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef0123',
      name: 'gateway-proxy',
      image: 'example.test/proxy:1.27',
      state: 'running',
      status: 'Up 6 hours (healthy)',
      ports: '127.0.0.1:8080->80/tcp',
      networks: 'frontend',
    },
    {
      id: 'b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef01234',
      name: 'metrics-collector',
      image: 'example.test/collector:0.9',
      state: 'running',
      status: 'Up 6 hours',
      ports: '127.0.0.1:9100->9100/tcp',
      networks: 'monitoring',
    },
  ],
});

securityApi.get = async (hostId): Promise<SshEndpointTrust> => ({
  hostId,
  hostname: host.connection.hostname,
  port: host.connection.port,
  authentication: host.connection.authentication,
  endpointPin: {
    algorithm: 'ssh-ed25519',
    sha256: 'SHA256:test-fingerprint',
  },
});

useSelection.setState({ hostId: mode === 'empty' || mode === 'list' ? null : host.id });
const root = document.getElementById('root');
if (!root) throw new Error('Missing visual test root.');
root.style.setProperty('--shell-offset', '27px');

createRoot(root).render(
  <QueryClientProvider client={new QueryClient()}>
    <div
      style={{
        height: '27px',
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        color: '#fcd34d',
        background: '#1c2130',
        borderBottom: '1px solid #3c485e',
        fontSize: 11,
      }}
    >
      UI TEST FIXTURE · Simulated hosts and measurements · No SSH connection
    </div>
    <App
      initialSection={initialSection}
      initialTerminalMonitoring={initialTerminalMonitoring}
    />
  </QueryClientProvider>,
);
