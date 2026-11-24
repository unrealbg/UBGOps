import { useId, useMemo } from 'react';
import { Icon } from '../../components/Icon';
import { bytes, bytesPerSecond, percentage } from './format';

import { useHostMonitoring, formatPercent, type MonitoringProps } from './useHostMonitoring';
export { MONITOR_INTERVAL_MS, MONITOR_HISTORY_LIMIT } from './useHostMonitoring';
const STALE_AFTER_MS = 15_000;

type SparkTone = 'cyan' | 'blue' | 'purple' | 'emerald';

function Sparkline({
  values,
  tone = 'cyan',
}: {
  values: Array<number | null>;
  tone?: SparkTone;
}) {
  const rawId = useId();
  const gradientId = `spark-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const segments = useMemo(() => {
    const finite = values.filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
    if (finite.length < 2) return [];
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const range = Math.max(max - min, 1);
    const width = Math.max(values.length - 1, 1);
    const built: Array<{ line: string; area: string }> = [];
    let coords: Array<{ x: number; y: number }> = [];

    const flush = () => {
      if (coords.length > 1) {
        const line = coords.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
        const firstX = coords[0]!.x.toFixed(2);
        const lastX = coords[coords.length - 1]!.x.toFixed(2);
        const area = `${firstX},31 ${line} ${lastX},31`;
        built.push({ line, area });
      }
      coords = [];
    };

    values.forEach((value, index) => {
      if (value === null || !Number.isFinite(value)) {
        flush();
        return;
      }
      const x = (index / width) * 100;
      const y = 27 - ((value - min) / range) * 23;
      coords.push({ x, y });
    });
    flush();
    return built;
  }, [values]);

  return (
    <svg
      className={`monitor-chart monitor-chart--${tone}`}
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-point-count={values.length}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {segments.map((segment, index) => (
        <g key={`${index}:${segment.line}`}>
          <polygon points={segment.area} fill={`url(#${gradientId})`} />
          <polyline points={segment.line} />
        </g>
      ))}
    </svg>
  );
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

export function LiveMonitoring(props: MonitoringProps) {
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
    !networkUnavailable && sample != null && sample.networkRxBytesPerSecond !== null;
  const netTone = networkUnavailable ? 'muted' : netReady ? 'ok' : 'muted';

  return (
    <section className="monitoring-section" aria-labelledby="live-monitoring-title">
      <div className="monitoring-heading">
        <div>
          <div className="eyebrow">SESSION TELEMETRY</div>
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
              <Icon name="cpu" size={13} />
              CPU
            </span>
            <span className={`metric-status-dot metric-status-dot--${cpuTone}`} aria-hidden="true" />
          </div>
          <strong className="monitor-card-value">
            {cpuUnavailable
              ? 'Unavailable'
              : sample?.cpuUsagePercent === null || !sample
                ? 'Warming up'
                : formatPercent(sample.cpuUsagePercent)}
          </strong>
          <span className="monitor-card-sub">
            {cpuUnavailable ? 'Host CPU probe disabled' : 'Aggregate compute load'}
          </span>
          <MonitorBar label="CPU" percent={cpuValue} />
          <Sparkline values={visibleHistory.map((item) => item.cpuUsagePercent)} tone="cyan" />
        </article>

        <article className="monitor-card monitor-card--memory">
          <div className="monitor-card-header">
            <span className="metric-label">
              <Icon name="memory" size={13} />
              MEMORY
            </span>
            <span className={`metric-status-dot metric-status-dot--${memTone}`} aria-hidden="true" />
          </div>
          <strong className="monitor-card-value">
            <ResourceValue
              used={sample?.memoryUsedBytes ?? null}
              total={sample?.memoryTotalBytes ?? null}
              unavailable={memoryUnavailable}
            />
          </strong>
          <span className="monitor-card-sub">{formatPercent(memoryPercent)}</span>
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

        <article className="monitor-card monitor-card--swap">
          <div className="monitor-card-header">
            <span className="metric-label">
              <Icon name="activity" size={13} />
              SWAP
            </span>
            <span
              className={`metric-status-dot metric-status-dot--${swapTone}`}
              aria-hidden="true"
            />
          </div>
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
          {sample?.swapTotalBytes !== 0 ? (
            <span className="monitor-card-sub">{formatPercent(swapPercent)}</span>
          ) : (
            <span className="monitor-card-sub">Zero swap partition active</span>
          )}
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

        <article className="monitor-card monitor-card--disk">
          <div className="monitor-card-header">
            <span className="metric-label">
              <Icon name="disk" size={13} />
              ROOT DISK
            </span>
            <span
              className={`metric-status-dot metric-status-dot--${diskTone}`}
              aria-hidden="true"
            />
          </div>
          <strong className="monitor-card-value">
            <ResourceValue
              used={sample?.rootUsedBytes ?? null}
              total={sample?.rootTotalBytes ?? null}
              unavailable={diskUnavailable}
            />
          </strong>
          <span className="monitor-card-sub">{formatPercent(diskPercent)}</span>
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

        <article className="monitor-card monitor-card--network">
          <div className="monitor-card-header">
            <span className="metric-label">
              <Icon name="network" size={13} />
              NETWORK
            </span>
            <span className={`metric-status-dot metric-status-dot--${netTone}`} aria-hidden="true" />
          </div>
          <div className="monitor-network-rates">
            <strong className="monitor-card-value">
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
                  ? 'Waiting for the next sample'
                  : `↑ ${bytesPerSecond(sample.networkTxBytesPerSecond)}`}
            </span>
          </div>
          <Sparkline
            values={visibleHistory.map((item) => item.networkRxBytesPerSecond)}
            tone="cyan"
          />
        </article>
      </div>
    </section>
  );
}
