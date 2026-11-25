import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

export type ChartTone = 'cyan' | 'blue' | 'purple' | 'emerald' | 'amber';
export type ChartDomain = 'percent' | 'rate';

export type ChartPoint = {
  timestampMs: number | null;
  primary: number | null;
  secondary?: number | null;
};

const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT = 40;
const PAD_X = 4;

type PlotMetrics = {
  plotTop: number;
  plotBottom: number;
  midY: number;
  primaryDotR: number;
  secondaryDotR: number;
};

function getPlotMetrics(svgHeight: number): PlotMetrics {
  if (Math.abs(svgHeight - 40) < 0.5) {
    return {
      plotTop: 5.5,
      plotBottom: 35.5,
      midY: 20.5,
      primaryDotR: 2.25,
      secondaryDotR: 2,
    };
  }
  const plotTop = Number((svgHeight * 0.13).toFixed(1));
  const plotBottom = Number(Math.max(plotTop + 8, svgHeight - 3.5).toFixed(1));
  const midY = Number(((plotTop + plotBottom) / 2).toFixed(1));
  const compact = svgHeight <= 30;
  return {
    plotTop,
    plotBottom,
    midY,
    primaryDotR: compact ? 2 : 2.25,
    secondaryDotR: compact ? 1.75 : 2,
  };
}

type SeriesGeometry = {
  segments: Array<{ line: string; area: string }>;
  lastPoint: { x: number; y: number } | null;
};

function formatIntervalLabel(spanMs: number): string {
  if (!Number.isFinite(spanMs) || spanMs < 0) return '—';
  const totalSeconds = Math.round(spanMs / 1000);
  if (totalSeconds === 0) return '0s';
  if (totalSeconds < 60) return `-${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `-${minutes}m` : `-${minutes}m ${seconds}s`;
}

function buildGeometry(
  points: ChartPoint[],
  accessor: (point: ChartPoint) => number | null | undefined,
  domainMin: number,
  domainMax: number,
  windowStartMs: number,
  windowEndMs: number,
  plotWidth: number,
  plotTop: number,
  plotBottom: number,
): SeriesGeometry {
  const innerWidth = Math.max(plotWidth - PAD_X * 2, 1);
  const plotHeight = Math.max(plotBottom - plotTop, 1);
  const spanMs = windowEndMs - windowStartMs;
  const valueRange = Math.max(domainMax - domainMin, 1e-6);
  const indexDenominator = Math.max(points.length - 1, 1);

  const segments: Array<{ line: string; area: string }> = [];
  let coords: Array<{ x: number; y: number }> = [];
  let lastPoint: { x: number; y: number } | null = null;

  const flush = () => {
    if (coords.length > 1) {
      const line = coords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const firstX = coords[0]!.x.toFixed(1);
      const lastX = coords[coords.length - 1]!.x.toFixed(1);
      segments.push({
        line,
        area: `${firstX},${plotBottom.toFixed(1)} ${line} ${lastX},${plotBottom.toFixed(1)}`,
      });
    }
    coords = [];
  };

  points.forEach((point, index) => {
    const raw = accessor(point);
    if (raw === null || raw === undefined || !Number.isFinite(raw)) {
      flush();
      return;
    }
    const clamped = Math.min(domainMax, Math.max(domainMin, raw));
    const ratioX =
      spanMs > 0 && point.timestampMs !== null && Number.isFinite(point.timestampMs)
        ? Math.min(1, Math.max(0, (point.timestampMs - windowStartMs) / spanMs))
        : points.length === 1
          ? 1
          : index / indexDenominator;
    const ratioY = (clamped - domainMin) / valueRange;
    const coord = {
      x: PAD_X + ratioX * innerWidth,
      y: plotBottom - ratioY * plotHeight,
    };
    coords.push(coord);
    lastPoint = coord;
  });
  flush();

  return { segments, lastPoint };
}

export function computeRollingWindow(
  observedTimestamps: string[],
  maxWindowMs: number,
): { startMs: number; endMs: number; label: string } | null {
  const valid = observedTimestamps
    .map((value) => Date.parse(value))
    .filter((ms) => Number.isFinite(ms));
  if (valid.length === 0) return null;
  const minMs = Math.min(...valid);
  const endMs = Math.max(...valid);
  const startMs = Math.max(minMs, endMs - maxWindowMs);
  return {
    startMs,
    endMs,
    label: formatIntervalLabel(endMs - startMs),
  };
}

export function MonitoringChart({
  points,
  domain,
  primaryTone,
  secondaryTone,
  windowStartMs,
  windowEndMs,
  windowLabel,
  endLabel = 'now',
  deviceKey,
}: {
  points: ChartPoint[];
  domain: ChartDomain;
  primaryTone: ChartTone;
  secondaryTone?: ChartTone;
  windowStartMs: number;
  windowEndMs: number;
  windowLabel: string;
  endLabel?: string;
  deviceKey?: string | null;
}) {
  const rawId = useId();
  const gradientId = `mchart-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measuredSize, setMeasuredSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const nextWidth = Math.round(rect.width);
      const rawHeight = Math.round(rect.height);
      if (nextWidth > 0 || rawHeight > 0) {
        setMeasuredSize((current) => {
          const width = nextWidth > 0 ? nextWidth : current.width;
          const height = rawHeight > 0 ? Math.min(44, Math.max(22, rawHeight)) : current.height;
          if (width === current.width && height === current.height) return current;
          return { width, height };
        });
      }
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, []);

  const measuredWidth = measuredSize.width;
  const measuredHeight = measuredSize.height;
  const { plotTop, plotBottom, midY, primaryDotR, secondaryDotR } = getPlotMetrics(measuredHeight);
  const hasSecondary = secondaryTone !== undefined;

  const { primaryGeom, secondaryGeom } = useMemo(() => {
    const finiteValues: number[] = [];
    for (const point of points) {
      if (point.primary !== null && Number.isFinite(point.primary)) {
        finiteValues.push(point.primary);
      }
      if (
        hasSecondary &&
        point.secondary !== null &&
        point.secondary !== undefined &&
        Number.isFinite(point.secondary)
      ) {
        finiteValues.push(point.secondary);
      }
    }

    const domainMin = 0;
    const domainMax =
      domain === 'percent'
        ? 100
        : finiteValues.length > 0
          ? (() => {
              const peak = Math.max(...finiteValues);
              return peak > 0 ? peak * 1.12 : 1;
            })()
          : 1;

    return {
      primaryGeom: buildGeometry(
        points,
        (p) => p.primary,
        domainMin,
        domainMax,
        windowStartMs,
        windowEndMs,
        measuredWidth,
        plotTop,
        plotBottom,
      ),
      secondaryGeom: hasSecondary
        ? buildGeometry(
            points,
            (p) => p.secondary,
            domainMin,
            domainMax,
            windowStartMs,
            windowEndMs,
            measuredWidth,
            plotTop,
            plotBottom,
          )
        : null,
    };
  }, [domain, hasSecondary, measuredWidth, plotBottom, plotTop, points, windowEndMs, windowStartMs]);

  return (
    <div className="monitor-chart-frame">
      <div className="monitor-chart-svg-wrap" ref={wrapRef}>
        <svg
          className={`monitor-chart monitor-chart--${primaryTone}`}
          width={measuredWidth}
          height={measuredHeight}
          viewBox={`0 0 ${measuredWidth} ${measuredHeight}`}
          aria-hidden="true"
          data-point-count={points.length}
          data-series-count={hasSecondary ? 2 : 1}
          data-segment-count={primaryGeom.segments.length}
          data-disk-device-key={deviceKey ?? undefined}
          data-window-label={windowLabel}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
              <stop offset="75%" stopColor="currentColor" stopOpacity="0.03" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>

          <line
            x1={PAD_X}
            y1={plotTop}
            x2={measuredWidth - PAD_X}
            y2={plotTop}
            className="monitor-chart-grid"
            shapeRendering="crispEdges"
          />
          <line
            x1={PAD_X}
            y1={midY}
            x2={measuredWidth - PAD_X}
            y2={midY}
            className="monitor-chart-midline"
            shapeRendering="crispEdges"
          />
          <line
            x1={PAD_X}
            y1={plotBottom}
            x2={measuredWidth - PAD_X}
            y2={plotBottom}
            className="monitor-chart-baseline"
            shapeRendering="crispEdges"
          />

          {primaryGeom.segments.map((segment, index) => (
            <g key={`p:${index}:${segment.line}`} className={`monitor-chart-series--${primaryTone}`}>
              <polygon points={segment.area} fill={`url(#${gradientId})`} />
              <polyline
                points={segment.line}
                className="monitor-chart-line monitor-chart-line--primary"
              />
            </g>
          ))}

          {secondaryGeom?.segments.map((segment, index) => (
            <g
              key={`s:${index}:${segment.line}`}
              className={`monitor-chart-series--${secondaryTone}`}
            >
              <polyline
                points={segment.line}
                className="monitor-chart-line monitor-chart-line--secondary"
              />
            </g>
          ))}

          {secondaryGeom?.lastPoint && (
            <circle
              cx={secondaryGeom.lastPoint.x}
              cy={secondaryGeom.lastPoint.y}
              r={secondaryDotR}
              className={`monitor-chart-dot monitor-chart-series--${secondaryTone}`}
            />
          )}

          {primaryGeom.lastPoint && (
            <circle
              cx={primaryGeom.lastPoint.x}
              cy={primaryGeom.lastPoint.y}
              r={primaryDotR}
              className={`monitor-chart-dot monitor-chart-series--${primaryTone}`}
            />
          )}
        </svg>
      </div>

      <div className="monitor-chart-axis" aria-hidden="true">
        <span>{windowLabel}</span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
}
