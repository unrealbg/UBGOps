import { useMemo } from 'react';
import type { DiskDeviceKind, DiskIoSample } from '@ubgops/protocol';
import { Icon } from '../../components/Icon';
import { bytes, bytesPerSecond, percentage } from './format';
import { computeRollingWindow, MonitoringChart } from './MonitoringChart';

import { useHostMonitoring, formatPercent, type MonitoringProps } from './useHostMonitoring';
export { MONITOR_INTERVAL_MS, MONITOR_HISTORY_LIMIT } from './useHostMonitoring';
const STALE_AFTER_MS = 15_000;
const ROLLING_WINDOW_MS = 120 * 5_000;

function timestampOf(observedAt: string): number | null {
  const ms = Date.parse(observedAt);
  return Number.isFinite(ms) ? ms : null;
}

function formatDeviceKind(kind: DiskDeviceKind): string {
  switch (kind) {
    case 'physicalDisk':
      return 'Physical';
    case 'virtualDisk':
      return 'Virtual';
    case 'partition':
      return 'Partition';
    case 'deviceMapper':
      return 'LVM/DM';
    case 'mdRaid':
      return 'RAID';
    case 'unknown':
      return 'Block';
  }
}

function diskIdentityKey(diskIo: DiskIoSample | null | undefined): string | null {
  if (!diskIo?.primaryDevice) return null;
  return JSON.stringify([
    diskIo.primaryDevice,
    diskIo.primaryMajor,
    diskIo.primaryMinor,
    diskIo.primaryKind,
    diskIo.primarySizeSectors,
    diskIo.isRootBacking,
    diskIo.primaryDiskSeq ?? null,
    diskIo.primaryDeviceId ?? null,
    diskIo.primarySysfsPath,
  ]);
}

function usageTone(percent: number | null | undefined): 'ok' | 'warn' | 'danger' | 'muted' {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return 'muted';
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warn';
  return 'ok';
}

function MonitorBar({
  label,
  percent,
  accentClass,
}: {
  label: string;
  percent: number | null;
  accentClass?: string;
}) {
  const clamped =
    percent === null || !Number.isFinite(percent) ? 0 : Math.min(100, Math.max(0, percent));
  const tone = usageTone(percent);
  const fillClass =
    tone === 'danger'
      ? 'monitor-bar-fill--danger'
      : tone === 'warn'
        ? 'monitor-bar-fill--warn'
        : accentClass ?? '';

  return (
    <div
      className="monitor-bar"
      role="progressbar"
      aria-label={`${label} utilization`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : Math.round(clamped)}
    >
      <span
        className={`monitor-bar-fill ${fillClass}`}
        style={{ width: `${percent === null ? 0 : clamped}%` }}
      />
    </div>
  );
}

function ResourceValue({
  used,
  total,
  unavailable,
}: {
  used: number | null;
  total: number | null;
  unavailable: boolean;
}) {
  if (unavailable || used === null || total === null)
    return <span className="metric-unavailable">Unavailable</span>;
  return (
    <>
      {bytes(used)} <span className="metric-total">/ {bytes(total)}</span>
    </>
  );
}

export function LiveMonitoring(props: MonitoringProps & { compact?: boolean }) {
  const {
    visibleHistory,
    error,
    sample,
    age,
    freshness,
    cpuUnavailable,
    networkUnavailable,
    memoryUnavailable,
    swapUnavailable,
    diskUnavailable,
    diskIoUnavailable,
    memoryPercent,
    swapPercent,
    diskPercent,
  } = useHostMonitoring(props);

  const cpuValue = cpuUnavailable ? null : sample?.cpuUsagePercent ?? null;
  const cpuTone = cpuUnavailable ? 'muted' : usageTone(cpuValue);
  const memTone = memoryUnavailable ? 'muted' : usageTone(memoryPercent);
  const swapConfigured = !(sample?.swapTotalBytes === 0 && !swapUnavailable);
  const swapTone = swapUnavailable || !swapConfigured ? 'muted' : usageTone(swapPercent);
  const diskTone = diskUnavailable ? 'muted' : usageTone(diskPercent);
  const netReady =
    !networkUnavailable &&
    sample != null &&
    sample.networkRxBytesPerSecond !== null &&
    sample.networkTxBytesPerSecond !== null;
  const netTone = networkUnavailable ? 'muted' : netReady ? 'ok' : 'muted';
  const diskIo = sample?.diskIo ?? null;
  const diskIoReady = !diskIoUnavailable && diskIo !== null;
  const diskIoTone = diskIoUnavailable ? 'muted' : diskIoReady ? 'ok' : 'muted';
  const activeDiskKey = useMemo(() => {
    for (let i = visibleHistory.length - 1; i >= 0; i -= 1) {
      const key = diskIdentityKey(visibleHistory[i]?.diskIo);
      if (key) return key;
    }
    return null;
  }, [visibleHistory]);
  const diskHistory = useMemo(() => {
    if (!activeDiskKey) return visibleHistory;
    let cutoff = 0;
    for (let i = 0; i < visibleHistory.length; i += 1) {
      const key = diskIdentityKey(visibleHistory[i]?.diskIo);
      if (key && key !== activeDiskKey) {
        cutoff = i + 1;
      }
    }
    return visibleHistory.slice(cutoff);
  }, [activeDiskKey, visibleHistory]);
  const timeWindow = useMemo(
    () =>
      computeRollingWindow(
        visibleHistory.map((item) => item.observedAt),
        ROLLING_WINDOW_MS,
      ),
    [visibleHistory],
  );
  const windowStartMs = timeWindow?.startMs ?? 0;
  const windowEndMs = timeWindow?.endMs ?? 0;
  const windowLabel = timeWindow?.label ?? '—';
  const endLabel = !props.connected
    ? 'offline'
    : age > STALE_AFTER_MS && sample
      ? 'stale'
      : timeWindow
        ? 'now'
        : '—';
  const compact = props.compact ?? true;

  return (
    <section
      className={`monitoring-section ${compact ? 'monitoring-section--compact' : ''}`}
      aria-labelledby="live-monitoring-title"
    >
      <div className="monitoring-heading">
        <div className="monitoring-heading-title">
          <span className="eyebrow">SESSION TELEMETRY</span>
          <h2 id="live-monitoring-title">Live monitoring</h2>
        </div>
        <span
          className={`monitor-freshness ${age > STALE_AFTER_MS ? 'monitor-freshness--stale' : ''}`}
        >
          <span className="monitor-freshness-dot" aria-hidden="true" />
          {freshness}
        </span>
      </div>
      {error && (
        <p className="monitor-error" role="status">
          {error}
        </p>
      )}
      <div className="monitor-grid">
        <article className="monitor-card monitor-card--cpu">
          <div className="monitor-card-top">
            <div className="monitor-card-header">
              <span className="metric-label">
                <Icon name="cpu" size={12} />
                CPU
              </span>
              <span className={`metric-status-dot metric-status-dot--${cpuTone}`} aria-hidden="true" />
            </div>
            <div className="monitor-card-metric">
              <strong className="monitor-card-value">
                {cpuUnavailable
                  ? 'Unavailable'
                  : sample?.cpuUsagePercent === null || !sample
                    ? 'Warming up'
                    : formatPercent(sample.cpuUsagePercent)}
              </strong>
              <span className="monitor-card-sub">
                {cpuUnavailable ? 'Probe disabled' : 'Compute load'}
              </span>
            </div>
            <MonitorBar label="CPU" percent={cpuValue} />
          </div>
          <MonitoringChart
            points={visibleHistory.map((item) => ({
              timestampMs: timestampOf(item.observedAt),
              primary: item.cpuUsagePercent,
            }))}
            domain="percent"
            primaryTone="cyan"
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
            windowLabel={windowLabel}
            endLabel={endLabel}
          />
        </article>

        <article className="monitor-card monitor-card--memory">
          <div className="monitor-card-top">
            <div className="monitor-card-header">
              <span className="metric-label">
                <Icon name="memory" size={12} />
                MEMORY
              </span>
              <span className={`metric-status-dot metric-status-dot--${memTone}`} aria-hidden="true" />
            </div>
            <div className="monitor-card-metric">
              <strong className="monitor-card-value">
                <ResourceValue
                  used={sample?.memoryUsedBytes ?? null}
                  total={sample?.memoryTotalBytes ?? null}
                  unavailable={memoryUnavailable}
                />
              </strong>
              <span className="monitor-card-sub">{formatPercent(memoryPercent)}</span>
            </div>
            <MonitorBar
              label="Memory"
              percent={memoryUnavailable ? null : memoryPercent}
              accentClass="monitor-bar-fill--blue"
            />
          </div>
          <MonitoringChart
            points={visibleHistory.map((item) => ({
              timestampMs: timestampOf(item.observedAt),
              primary: percentage(item.memoryUsedBytes, item.memoryTotalBytes),
            }))}
            domain="percent"
            primaryTone="blue"
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
            windowLabel={windowLabel}
            endLabel={endLabel}
          />
        </article>

        <article className="monitor-card monitor-card--disk">
          <div className="monitor-card-top">
            <div className="monitor-card-header">
              <span className="metric-label">
                <Icon name="disk" size={12} />
                ROOT DISK
              </span>
              <span
                className={`metric-status-dot metric-status-dot--${diskTone}`}
                aria-hidden="true"
              />
            </div>
            <div className="monitor-card-metric">
              <strong className="monitor-card-value">
                <ResourceValue
                  used={sample?.rootUsedBytes ?? null}
                  total={sample?.rootTotalBytes ?? null}
                  unavailable={diskUnavailable}
                />
              </strong>
              <span className="monitor-card-sub">{formatPercent(diskPercent)}</span>
            </div>
            <MonitorBar
              label="Root disk"
              percent={diskUnavailable ? null : diskPercent}
              accentClass="monitor-bar-fill--emerald"
            />
          </div>
          <MonitoringChart
            points={visibleHistory.map((item) => ({
              timestampMs: timestampOf(item.observedAt),
              primary: percentage(item.rootUsedBytes, item.rootTotalBytes),
            }))}
            domain="percent"
            primaryTone="emerald"
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
            windowLabel={windowLabel}
            endLabel={endLabel}
          />
        </article>

        <article className="monitor-card monitor-card--swap">
          <div className="monitor-card-top">
            <div className="monitor-card-header">
              <span className="metric-label">
                <Icon name="activity" size={12} />
                SWAP
              </span>
              <span
                className={`metric-status-dot metric-status-dot--${swapTone}`}
                aria-hidden="true"
              />
            </div>
            <div className="monitor-card-metric">
              <strong className="monitor-card-value">
                {sample?.swapTotalBytes === 0 && !swapUnavailable ? (
                  'Not configured'
                ) : (
                  <ResourceValue
                    used={sample?.swapUsedBytes ?? null}
                    total={sample?.swapTotalBytes ?? null}
                    unavailable={swapUnavailable}
                  />
                )}
              </strong>
              <span className="monitor-card-sub">
                {sample?.swapTotalBytes !== 0 ? formatPercent(swapPercent) : 'Zero swap'}
              </span>
            </div>
            <MonitorBar
              label="Swap"
              percent={!swapConfigured || swapUnavailable ? null : swapPercent}
              accentClass="monitor-bar-fill--purple"
            />
          </div>
          <MonitoringChart
            points={visibleHistory.map((item) => ({
              timestampMs: timestampOf(item.observedAt),
              primary: percentage(item.swapUsedBytes, item.swapTotalBytes),
            }))}
            domain="percent"
            primaryTone="purple"
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
            windowLabel={windowLabel}
            endLabel={endLabel}
          />
        </article>

        <article className="monitor-card monitor-card--network">
          <div className="monitor-card-top">
            <div className="monitor-card-header">
              <span className="metric-label">
                <Icon name="network" size={12} />
                NETWORK
              </span>
              <span className={`metric-status-dot metric-status-dot--${netTone}`} aria-hidden="true" />
            </div>
            <div className="monitor-card-metric monitor-network-rates">
              <strong className="monitor-card-value monitor-network-rx">
                {networkUnavailable
                  ? 'Unavailable'
                  : sample?.networkRxBytesPerSecond === null || !sample
                    ? 'Warming up'
                    : `↓ ${bytesPerSecond(sample.networkRxBytesPerSecond)}`}
              </strong>
              <span className="monitor-network-tx">
                {networkUnavailable
                  ? ''
                  : sample?.networkTxBytesPerSecond === null || !sample
                    ? 'Awaiting sample'
                    : `↑ ${bytesPerSecond(sample.networkTxBytesPerSecond)}`}
              </span>
            </div>
          </div>
          <MonitoringChart
            points={visibleHistory.map((item) => ({
              timestampMs: timestampOf(item.observedAt),
              primary: item.networkRxBytesPerSecond,
              secondary: item.networkTxBytesPerSecond,
            }))}
            domain="rate"
            primaryTone="cyan"
            secondaryTone="blue"
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
            windowLabel={windowLabel}
            endLabel={endLabel}
          />
        </article>

        <article className="monitor-card monitor-card--diskio">
          <div className="monitor-card-top">
            <div className="monitor-card-header">
              <span className="metric-label">
                <Icon name="disk" size={12} />
                DISK I/O
              </span>
              <span className="monitor-card-header-right">
                {diskIoReady && diskIo.primaryDevice && (
                  <span
                    className="monitor-device-badge"
                    title={
                      diskIo.isRootBacking
                        ? `Root backing block device: ${diskIo.primaryDevice} (${formatDeviceKind(diskIo.primaryKind)})`
                        : `Single-device fallback (root mount unmatched): ${diskIo.primaryDevice} (${formatDeviceKind(diskIo.primaryKind)})`
                    }
                  >
                    {diskIo.primaryDevice} ·{' '}
                    {diskIo.isRootBacking ? formatDeviceKind(diskIo.primaryKind) : 'Fallback'}
                  </span>
                )}
                <span
                  className={`metric-status-dot metric-status-dot--${diskIoTone}`}
                  aria-hidden="true"
                />
              </span>
            </div>
            <div className="monitor-card-metric monitor-network-rates">
              <strong className="monitor-card-value monitor-diskio-read">
                {diskIoUnavailable
                  ? 'Unavailable'
                  : !diskIo
                    ? 'Warming up'
                    : `R ${bytesPerSecond(diskIo.readBytesPerSecond)}`}
              </strong>
              <span className="monitor-diskio-write">
                {diskIoUnavailable
                  ? ''
                  : !diskIo
                    ? 'Awaiting sample'
                    : `W ${bytesPerSecond(diskIo.writeBytesPerSecond)}`}
              </span>
            </div>
          </div>
          <MonitoringChart
            points={diskHistory.map((item) => ({
              timestampMs: timestampOf(item.observedAt),
              primary:
                diskIdentityKey(item.diskIo) === activeDiskKey
                  ? (item.diskIo?.readBytesPerSecond ?? null)
                  : null,
              secondary:
                diskIdentityKey(item.diskIo) === activeDiskKey
                  ? (item.diskIo?.writeBytesPerSecond ?? null)
                  : null,
            }))}
            domain="rate"
            primaryTone="emerald"
            secondaryTone="amber"
            windowStartMs={windowStartMs}
            windowEndMs={windowEndMs}
            windowLabel={windowLabel}
            endLabel={endLabel}
            deviceKey={activeDiskKey}
          />
        </article>
      </div>
    </section>
  );
}
