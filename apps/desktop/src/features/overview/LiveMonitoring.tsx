import { useId, useMemo } from 'react';
import type { DiskDeviceKind, DiskIoSample } from '@ubgops/protocol';
import { Icon } from '../../components/Icon';
import { bytes, bytesPerSecond, percentage } from './format';

import { useHostMonitoring, formatPercent, type MonitoringProps } from './useHostMonitoring';
export { MONITOR_INTERVAL_MS, MONITOR_HISTORY_LIMIT } from './useHostMonitoring';
const STALE_AFTER_MS = 15_000;

type SparkTone = 'cyan' | 'blue' | 'purple' | 'emerald' | 'amber';
type SeriesGeometry = {
  segments: Array<{ line: string; area: string }>;
  lastPoint: { x: number; y: number } | null;
};

function computeSeries(values: Array<number | null>, min: number, max: number): SeriesGeometry {
  const finiteCount = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  ).length;
  if (finiteCount < 2) {
    return { segments: [], lastPoint: null };
  }
  const range = Math.max(max - min, 1);
  const width = Math.max(values.length - 1, 1);
  const built: Array<{ line: string; area: string }> = [];
  let coords: Array<{ x: number; y: number }> = [];
  let tail: { x: number; y: number } | null = null;

  const flush = () => {
    if (coords.length > 1) {
      const line = coords.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      const firstX = coords[0]!.x.toFixed(2);
      const lastX = coords[coords.length - 1]!.x.toFixed(2);
      built.push({ line, area: `${firstX},29 ${line} ${lastX},29` });
      tail = coords[coords.length - 1] ?? tail;
    }
    coords = [];
  };

  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      flush();
      return;
    }
    const x = (index / width) * 100;
    const y = 25 - ((value - min) / range) * 20;
    coords.push({ x, y });
  });
  flush();
  return { segments: built, lastPoint: tail };
}

function jointBounds(lists: Array<Array<number | null>>): [number, number] {
  const finite = lists
    .flat()
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (finite.length === 0) return [0, 1];
  return [Math.min(...finite), Math.max(...finite)];
}

function Sparkline({
  values,
  tone = 'cyan',
}: {
  values: Array<number | null>;
  tone?: SparkTone;
}) {
  const rawId = useId();
  const gradientId = `spark-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const { segments, lastPoint } = useMemo(() => {
    const [min, max] = jointBounds([values]);
    return computeSeries(values, min, max);
  }, [values]);

  return (
    <svg
      className={`monitor-chart monitor-chart--${tone}`}
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-point-count={values.length}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.34" />
          <stop offset="70%" stopColor="currentColor" stopOpacity="0.09" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <line x1="0" y1="15" x2="100" y2="15" className="monitor-chart-midline" />
      {segments.map((segment, index) => (
        <g key={`${index}:${segment.line}`}>
          <polygon points={segment.area} fill={`url(#${gradientId})`} />
          <polyline points={segment.line} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      {lastPoint && (
        <circle
          cx={lastPoint.x}
          cy={lastPoint.y}
          r="2.1"
          className="monitor-chart-dot"
        />
      )}
    </svg>
  );
}

function DualSparkline({
  primaryValues,
  secondaryValues,
  primaryTone = 'cyan',
  secondaryTone = 'blue',
  deviceKey,
}: {
  primaryValues: Array<number | null>;
  secondaryValues: Array<number | null>;
  primaryTone?: SparkTone;
  secondaryTone?: SparkTone;
  deviceKey?: string | null;
}) {
  const rawId = useId();
  const gradientId = `dspark-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const { primary, secondary } = useMemo(() => {
    const [min, max] = jointBounds([primaryValues, secondaryValues]);
    return {
      primary: computeSeries(primaryValues, min, max),
      secondary: computeSeries(secondaryValues, min, max),
    };
  }, [primaryValues, secondaryValues]);

  return (
    <svg
      className={`monitor-chart monitor-chart--${primaryTone}`}
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-point-count={Math.max(primaryValues.length, secondaryValues.length)}
      data-series-count="2"
      data-segment-count={primary.segments.length}
      data-disk-device-key={deviceKey ?? undefined}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.26" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <line x1="0" y1="15" x2="100" y2="15" className="monitor-chart-midline" />
      {primary.segments.map((segment, index) => (
        <g key={`p:${index}:${segment.line}`} className={`monitor-chart-series--${primaryTone}`}>
          <polygon points={segment.area} fill={`url(#${gradientId})`} />
          <polyline points={segment.line} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      {secondary.segments.map((segment, index) => (
        <g key={`s:${index}:${segment.line}`} className={`monitor-chart-series--${secondaryTone}`}>
          <polyline points={segment.line} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      {primary.lastPoint && (
        <circle
          cx={primary.lastPoint.x}
          cy={primary.lastPoint.y}
          r="2"
          className={`monitor-chart-dot monitor-chart-series--${primaryTone}`}
        />
      )}
      {secondary.lastPoint && (
        <circle
          cx={secondary.lastPoint.x}
          cy={secondary.lastPoint.y}
          r="1.9"
          className={`monitor-chart-dot monitor-chart-series--${secondaryTone}`}
        />
      )}
    </svg>
  );
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
  return [
    diskIo.primaryDevice,
    diskIo.primaryMajor,
    diskIo.primaryMinor,
    diskIo.primaryKind,
    diskIo.isRootBacking ? 'root' : 'fallback',
    diskIo.primaryDiskSeq ?? '',
    diskIo.primaryDeviceId ?? '',
  ].join(':');
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
          <Sparkline values={visibleHistory.map((item) => item.cpuUsagePercent)} tone="cyan" />
        </article>

        <article className="monitor-card monitor-card--memory">
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
          <Sparkline
            values={visibleHistory.map((item) =>
              percentage(item.memoryUsedBytes, item.memoryTotalBytes),
            )}
            tone="blue"
          />
        </article>

        <article className="monitor-card monitor-card--disk">
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
          <Sparkline
            values={visibleHistory.map((item) =>
              percentage(item.rootUsedBytes, item.rootTotalBytes),
            )}
            tone="emerald"
          />
        </article>

        <article className="monitor-card monitor-card--swap">
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
          <Sparkline
            values={visibleHistory.map((item) =>
              percentage(item.swapUsedBytes, item.swapTotalBytes),
            )}
            tone="purple"
          />
        </article>

        <article className="monitor-card monitor-card--network">
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
          <div className="monitor-bar monitor-bar--network-divider" aria-hidden="true">
            <span
              className={`monitor-bar-fill ${netReady ? 'monitor-bar-fill--network' : ''}`}
              style={{ width: netReady ? '100%' : '0%' }}
            />
          </div>
          <DualSparkline
            primaryValues={visibleHistory.map((item) => item.networkRxBytesPerSecond)}
            secondaryValues={visibleHistory.map((item) => item.networkTxBytesPerSecond)}
            primaryTone="cyan"
            secondaryTone="blue"
          />
        </article>

        <article className="monitor-card monitor-card--diskio">
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
          <div className="monitor-bar monitor-bar--network-divider" aria-hidden="true">
            <span
              className={`monitor-bar-fill ${diskIoReady ? 'monitor-bar-fill--diskio' : ''}`}
              style={{ width: diskIoReady ? '100%' : '0%' }}
            />
          </div>
          <DualSparkline
            primaryValues={diskHistory.map((item) =>
              diskIdentityKey(item.diskIo) === activeDiskKey
                ? (item.diskIo?.readBytesPerSecond ?? null)
                : null,
            )}
            secondaryValues={diskHistory.map((item) =>
              diskIdentityKey(item.diskIo) === activeDiskKey
                ? (item.diskIo?.writeBytesPerSecond ?? null)
                : null,
            )}
            primaryTone="emerald"
            secondaryTone="amber"
            deviceKey={activeDiskKey}
          />
        </article>
      </div>
    </section>
  );
}
