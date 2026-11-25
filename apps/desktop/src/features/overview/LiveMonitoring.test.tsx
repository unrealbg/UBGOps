import { act, render, screen } from '@testing-library/react';
import type { DiskIoSample, HostMonitorSample } from '@ubgops/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sample: vi.fn() }));
vi.mock('../../api/client', () => ({
  monitorApi: { sample: mocks.sample },
  applicationError: (error: unknown) =>
    typeof error === 'object' && error !== null && 'message' in error
      ? error
      : { code: 'connection', message: 'Monitoring failed.', hostKey: null },
}));

import { LiveMonitoring, MONITOR_HISTORY_LIMIT, MONITOR_INTERVAL_MS } from './LiveMonitoring';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

function sample(overrides: Partial<HostMonitorSample> = {}): HostMonitorSample {
  return {
    hostId: 'host-a',
    hostSessionId: SESSION_A,
    observedAt: new Date().toISOString(),
    cpuUsagePercent: null,
    memoryTotalBytes: 8 * 1024 ** 3,
    memoryUsedBytes: 2 * 1024 ** 3,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    rootTotalBytes: 100 * 1024 ** 3,
    rootUsedBytes: 25 * 1024 ** 3,
    networkRxBytesPerSecond: null,
    networkTxBytesPerSecond: null,
    diskIo: null,
    warnings: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('live monitoring lifecycle', () => {
  it('polls only while visible and connected, at completion-based five-second cadence', async () => {
    const first = deferred<HostMonitorSample>();
    mocks.sample
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(sample({ cpuUsagePercent: 25 }));
    const view = render(
      <LiveMonitoring hostId="host-a" hostSessionId={SESSION_A} connected visible={false} />,
    );
    expect(mocks.sample).not.toHaveBeenCalled();
    view.rerender(<LiveMonitoring hostId="host-a" hostSessionId={SESSION_A} connected visible />);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.sample).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS * 3);
    });
    expect(mocks.sample).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(sample());
      await Promise.resolve();
    });
    expect(screen.getAllByText('Warming up')).toHaveLength(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS);
    });
    expect(mocks.sample).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('25.0%')).toHaveLength(3);
    view.rerender(
      <LiveMonitoring hostId="host-a" hostSessionId={null} connected={false} visible />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS * 2);
    });
    expect(mocks.sample).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('ignores a delayed old-session sample and starts new sessions with empty history', async () => {
    const old = deferred<HostMonitorSample>();
    mocks.sample
      .mockReturnValueOnce(old.promise)
      .mockImplementation(async (hostId, hostSessionId) =>
        sample({ hostId, hostSessionId, cpuUsagePercent: hostId === 'host-b' ? 7 : null }),
      );
    const view = render(
      <LiveMonitoring hostId="host-a" hostSessionId={SESSION_A} connected visible />,
    );
    await act(async () => { await Promise.resolve(); });
    view.rerender(<LiveMonitoring hostId="host-a" hostSessionId={SESSION_B} connected visible />);
    await act(async () => {
      old.resolve(sample({ cpuUsagePercent: 99 }));
      await Promise.resolve();
    });
    expect(screen.queryByText('99.0%')).not.toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getAllByText('Warming up')).toHaveLength(3);
    expect(mocks.sample).toHaveBeenLastCalledWith('host-a', SESSION_B);
    view.rerender(<LiveMonitoring hostId="host-b" hostSessionId={SESSION_B} connected visible />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('7.0%')).toBeInTheDocument();
    expect(screen.queryByText('99.0%')).not.toBeInTheDocument();
  });

  it('distinguishes unavailable, valid zero, stale data and enforces the history bound', async () => {
    let index = 0;
    mocks.sample.mockImplementation(async () =>
      sample({
        observedAt: index === 0 ? '2026-09-25T11:59:40Z' : new Date().toISOString(),
        cpuUsagePercent: index,
        networkRxBytesPerSecond: 0,
        networkTxBytesPerSecond: 0,
        memoryTotalBytes: null,
        memoryUsedBytes: null,
        warnings: [
          { code: 'discovery', message: 'memory monitoring is unavailable.', hostKey: null },
        ],
      }),
    );
    render(<LiveMonitoring hostId="host-a" hostSessionId={SESSION_A} connected visible />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Stale · Updated 20 seconds ago/)).toBeInTheDocument();
    expect(screen.getByText('↓ 0 B/s')).toBeInTheDocument();
    expect(screen.getByText('↑ 0 B/s')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    for (index = 1; index <= MONITOR_HISTORY_LIMIT + 3; index += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS);
      });
    }
    expect(mocks.sample).toHaveBeenCalledTimes(MONITOR_HISTORY_LIMIT + 4);
    for (const chart of document.querySelectorAll('.monitor-chart')) {
      expect(chart).toHaveAttribute('data-point-count', String(MONITOR_HISTORY_LIMIT));
    }
    expect(screen.getByText(`${(MONITOR_HISTORY_LIMIT + 3).toFixed(1)}%`)).toBeInTheDocument();
  });

  it('cleans up timers and does not publish after unmount', async () => {
    const pending = deferred<HostMonitorSample>();
    mocks.sample.mockReturnValue(pending.promise);
    const view = render(
      <LiveMonitoring hostId="host-a" hostSessionId={SESSION_A} connected visible />,
    );
    await act(async () => { await Promise.resolve(); });
    view.unmount();
    await act(async () => {
      pending.resolve(sample({ cpuUsagePercent: 88 }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS * 2);
    });
    expect(mocks.sample).toHaveBeenCalledTimes(1);
  });

function diskSample(
  name: string,
  read: number,
  write: number,
  {
    major = 8,
    minor = 0,
    diskSeq = '10',
    deviceId = 'naa.1000',
    isRootBacking = true,
  }: {
    major?: number;
    minor?: number;
    diskSeq?: string | null;
    deviceId?: string | null;
    isRootBacking?: boolean;
  } = {},
): DiskIoSample {
  return {
    primaryDevice: name,
    primaryMajor: major,
    primaryMinor: minor,
    primaryKind: 'virtualDisk',
    primaryDiskSeq: diskSeq,
    primaryDeviceId: deviceId,
    isRootBacking,
    readBytesPerSecond: read,
    writeBytesPerSecond: write,
    devices: [
      {
        name,
        major,
        minor,
        kind: 'virtualDisk',
        diskSeq,
        deviceId,
        isRootBacking,
        readBytesPerSecond: read,
        writeBytesPerSecond: write,
      },
    ],
  };
}

  it('renders six live monitoring cards with dual-series network and real disk I/O states', async () => {
    const firstSample = sample({
      cpuUsagePercent: 42.5,
      swapTotalBytes: 2 * 1024 ** 3,
      swapUsedBytes: 512 * 1024 ** 2,
      networkRxBytesPerSecond: 1024,
      networkTxBytesPerSecond: 2048,
      diskIo: diskSample('sda', 4096, 0),
    });
    const gapSample = sample({
      cpuUsagePercent: 45,
      swapTotalBytes: 2 * 1024 ** 3,
      swapUsedBytes: 512 * 1024 ** 2,
      networkRxBytesPerSecond: null,
      networkTxBytesPerSecond: null,
      diskIo: null,
      warnings: [{ code: 'discovery', message: 'disk I/O monitoring is unavailable.', hostKey: null }],
    });
    mocks.sample.mockResolvedValueOnce(firstSample).mockResolvedValueOnce(gapSample);
    render(<LiveMonitoring hostId="host-a" hostSessionId={SESSION_A} connected visible />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('progressbar', { name: 'CPU utilization' })).toHaveAttribute(
      'aria-valuenow',
      '43',
    );
    expect(screen.getByRole('progressbar', { name: 'Memory utilization' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    expect(screen.getByRole('progressbar', { name: 'Swap utilization' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    expect(screen.getByRole('progressbar', { name: 'Root disk utilization' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    const labels = Array.from(document.querySelectorAll('.monitor-grid .metric-label')).map((el) =>
      el.textContent?.trim(),
    );
    expect(labels).toEqual(['CPU', 'MEMORY', 'ROOT DISK', 'SWAP', 'NETWORK', 'DISK I/O']);
    expect(screen.getByText('sda · Virtual')).toBeInTheDocument();
    expect(screen.getByText('R 4 KiB/s')).toBeInTheDocument();
    expect(screen.getByText('W 0 B/s')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-series-count="2"]')).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS);
    });
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('isolates Disk I/O chart history across primary device change, major/minor change, replacement, unavailable recovery, and fallback badge', async () => {
    mocks.sample
      // 1-2: Device A (sda 8:0 diskSeq=10)
      .mockResolvedValueOnce(sample({ diskIo: diskSample('sda', 1000, 500) }))
      .mockResolvedValueOnce(sample({ diskIo: diskSample('sda', 2000, 1000) }))
      // 3-4: Primary device changed A -> B (sdb 8:16 diskSeq=11)
      .mockResolvedValueOnce(sample({ diskIo: null }))
      .mockResolvedValueOnce(
        sample({ diskIo: diskSample('sdb', 3000, 1500, { major: 8, minor: 16, diskSeq: '11', deviceId: 'naa.2000' }) }),
      )
      .mockResolvedValueOnce(
        sample({ diskIo: diskSample('sdb', 4000, 2000, { major: 8, minor: 16, diskSeq: '11', deviceId: 'naa.2000' }) }),
      )
      // 6-7: Same name 'sdb', changed major/minor (8:32)
      .mockResolvedValueOnce(sample({ diskIo: null }))
      .mockResolvedValueOnce(
        sample({ diskIo: diskSample('sdb', 5000, 2500, { major: 8, minor: 32, diskSeq: '12', deviceId: 'naa.2000' }) }),
      )
      .mockResolvedValueOnce(
        sample({ diskIo: diskSample('sdb', 6000, 3000, { major: 8, minor: 32, diskSeq: '12', deviceId: 'naa.2000' }) }),
      )
      // 9-10: Detectable replacement (same name 'sdb', same 8:32, changed diskSeq '13' + deviceId)
      .mockResolvedValueOnce(sample({ diskIo: null }))
      .mockResolvedValueOnce(
        sample({ diskIo: diskSample('sdb', 7000, 3500, { major: 8, minor: 32, diskSeq: '13', deviceId: 'naa.3000' }) }),
      )
      .mockResolvedValueOnce(
        sample({ diskIo: diskSample('sdb', 8000, 4000, { major: 8, minor: 32, diskSeq: '13', deviceId: 'naa.3000' }) }),
      )
      // 12-14: Unavailable sample followed by recovery on SAME device identity + fallback badge check later
      .mockResolvedValueOnce(
        sample({ diskIo: null, warnings: [{ code: 'discovery', message: 'disk I/O monitoring is unavailable.', hostKey: null }] }),
      )
      .mockResolvedValueOnce(
        sample({ diskIo: diskSample('sdb', 9000, 4500, { major: 8, minor: 32, diskSeq: '13', deviceId: 'naa.3000' }) }),
      )
      .mockResolvedValueOnce(
        sample({ diskIo: diskSample('sdb', 10000, 5000, { major: 8, minor: 32, diskSeq: '13', deviceId: 'naa.3000' }) }),
      )
      // 15: Single-device fallback (isRootBacking=false)
      .mockResolvedValueOnce(
        sample({ diskIo: diskSample('nvme0n1', 1024, 512, { major: 259, minor: 0, diskSeq: '99', deviceId: 'eui.9', isRootBacking: false }) }),
      );

    render(<LiveMonitoring hostId="host-a" hostSessionId={SESSION_A} connected visible />);
    const tick = async (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(MONITOR_INTERVAL_MS);
        });
      }
    };
    const chart = () => document.querySelector('.monitor-card--diskio .monitor-chart')!;

    await act(async () => { await Promise.resolve(); });
    await tick(1); // sample 2 (sda)
    expect(chart()).toHaveAttribute('data-point-count', '2');
    expect(chart().getAttribute('data-disk-device-key')).toContain('sda:8:0:');

    await tick(3); // sample 5 (sdb 8:16) — must exclude sda samples!
    expect(chart().getAttribute('data-disk-device-key')).toContain('sdb:8:16:');
    expect(chart()).toHaveAttribute('data-point-count', '3'); // [null reset, b1, b2]
    expect(chart()).toHaveAttribute('data-segment-count', '1');

    await tick(3); // sample 8 (sdb 8:32) — must exclude 8:16 samples!
    expect(chart().getAttribute('data-disk-device-key')).toContain('sdb:8:32:');
    expect(chart()).toHaveAttribute('data-point-count', '3');
    expect(chart()).toHaveAttribute('data-segment-count', '1');

    await tick(3); // sample 11 (sdb 8:32 replaced diskSeq=13) — must exclude diskSeq=12 samples!
    expect(chart().getAttribute('data-disk-device-key')).toContain('13:naa.3000');
    expect(chart()).toHaveAttribute('data-point-count', '3');
    expect(chart()).toHaveAttribute('data-segment-count', '1');

    await tick(1); // sample 12 (unavailable)
    expect(screen.getByText('Unavailable')).toBeInTheDocument();

    await tick(2); // samples 13-14 (recovery on same diskSeq=13 -> preserves 2 segments across unavailable gap!)
    expect(chart()).toHaveAttribute('data-point-count', '6');
    expect(chart()).toHaveAttribute('data-segment-count', '2');

    await tick(1); // sample 15 (explicit Fallback badge)
    expect(screen.getByText('nvme0n1 · Fallback')).toBeInTheDocument();
  });
});
