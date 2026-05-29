import React, { useState } from "react";
import { fmt$, fmt$k, fmtPct, seeded } from "./format";

export interface TimePoint {
  t: string;
  v: number;
}

/* ── Placeholder for charts without enough data ────────────── */
export function ChartPlaceholder({
  message = "chart will populate after your first sync — press Sync to pull fresh data",
}: {
  message?: string;
}) {
  return (
    <div
      className="tiny muted"
      style={{
        width: "100%",
        height: "100%",
        minHeight: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1.5px dashed var(--line-soft)",
        borderRadius: 6,
        padding: 12,
        textAlign: "center",
        fontStyle: "italic",
      }}
    >
      {message}
    </div>
  );
}

/* ── Delta indicator ───────────────────────────────────────── */
export function Delta({ v, suffix = "%" }: { v: number; suffix?: string }) {
  const cls = v >= 0 ? "accent-2" : "accent";
  const s = v >= 0 ? "▲" : "▼";
  return (
    <span className={cls} style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
      {s} {Math.abs(v).toFixed(2)}
      {suffix}
    </span>
  );
}

/* ── LineChart ─────────────────────────────────────────────── */
interface LineProps {
  w?: number;
  h?: number;
  seed?: number;
  color?: string;
  fill?: string | null;
  points?: number;
  trend?: number;
  data?: number[];
  /** Time-series data — when provided, the chart becomes interactive with
   *  a hover tooltip showing the date + formatted value. */
  series?: TimePoint[];
  /** Render an x-axis with localized date labels under the chart. Requires
   *  series with at least 2 points. */
  xAxis?: boolean;
  /** Allow click-drag selection to compare the value change over a period. */
  rangeSelect?: boolean;
}

function fmtTooltipDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtAxisDate(iso: string, spanMs: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Spans under ~36h get a time component; longer ranges use month/day only,
  // since two ticks an hour apart on a 30-day chart aren't useful.
  const opts: Intl.DateTimeFormatOptions =
    spanMs <= 36 * 3600 * 1000
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric" };
  return d.toLocaleString(undefined, opts);
}

function fmtRangeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function LineChart({
  w = 600,
  h = 180,
  seed = 7,
  color = "#1a1814",
  fill = null,
  points = 30,
  trend = 0.35,
  data,
  series,
  xAxis = false,
  rangeSelect = false,
}: LineProps) {
  const values: number[] | undefined = series
    ? series.map((p) => p.v)
    : data;

  let pts: [number, number][];
  const singlePoint = !!values && values.length === 1;
  if (values && values.length >= 2) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 1);
    pts = values.map((v, i) => [
      (i / (values.length - 1)) * w,
      h - 10 - ((v - min) / span) * (h - 20),
    ]);
  } else if (singlePoint) {
    // One data point: centered dot with a dashed reference baseline so it
    // reads as "we have a snapshot, but only one — no trend yet."
    pts = [[w / 2, h / 2]];
  } else {
    const r = seeded(seed);
    pts = [];
    let y = h * 0.6;
    for (let i = 0; i <= points; i++) {
      y += (r() - 0.5) * 14 - trend * 0.5;
      y = Math.max(20, Math.min(h - 20, y));
      pts.push([i * (w / points), y]);
    }
  }
  const d = singlePoint
    ? ""
    : pts
        .map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1))
        .join(" ");
  const dFill = d + ` L ${w} ${h} L 0 ${h} Z`;
  const last = pts[pts.length - 1];

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [dragStartIdx, setDragStartIdx] = useState<number | null>(null);
  const [dragEndIdx, setDragEndIdx] = useState<number | null>(null);
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
  const interactive = !!series && series.length > 0;
  const selectable =
    rangeSelect && !!series && series.length >= 2 && !!values && values.length >= 2;

  const idxFromEvent = (e: React.MouseEvent<HTMLDivElement>): number | null => {
    if (!interactive || !values || values.length === 0) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return Math.round(pct * (values.length - 1));
  };

  const commitSelection = () => {
    if (dragStartIdx == null || dragEndIdx == null) return;
    const start = Math.min(dragStartIdx, dragEndIdx);
    const end = Math.max(dragStartIdx, dragEndIdx);
    setSelectedRange(start === end ? null : { start, end });
    setDragStartIdx(null);
    setDragEndIdx(null);
  };

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const idx = idxFromEvent(e);
    if (idx == null) return;
    setHoverIdx(idx);
    if (dragStartIdx != null) setDragEndIdx(idx);
  };

  const handleDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!selectable) return;
    const idx = idxFromEvent(e);
    if (idx == null) return;
    e.preventDefault();
    setSelectedRange(null);
    setDragStartIdx(idx);
    setDragEndIdx(idx);
    setHoverIdx(idx);
  };

  const hoverPt = hoverIdx != null ? pts[hoverIdx] : null;
  const hoverSeries = hoverIdx != null && series ? series[hoverIdx] : null;
  const hoverLeftPct = hoverPt ? (hoverPt[0] / w) * 100 : 0;
  const hoverTopPct = hoverPt ? (hoverPt[1] / h) * 100 : 0;
  // Flip the tooltip to the left half when the cursor is on the right half so
  // it never overflows the container.
  const tooltipAnchorRight = hoverLeftPct > 60;
  const rawActiveRange =
    dragStartIdx != null && dragEndIdx != null
      ? { start: Math.min(dragStartIdx, dragEndIdx), end: Math.max(dragStartIdx, dragEndIdx) }
      : selectedRange;
  const activeRange =
    rawActiveRange && rawActiveRange.end < pts.length ? rawActiveRange : null;
  const rangeStartPt = activeRange ? pts[activeRange.start] : null;
  const rangeEndPt = activeRange ? pts[activeRange.end] : null;
  const rangeStartSeries = activeRange && series ? series[activeRange.start] : null;
  const rangeEndSeries = activeRange && series ? series[activeRange.end] : null;
  const rangeDelta =
    rangeStartSeries && rangeEndSeries ? rangeEndSeries.v - rangeStartSeries.v : 0;
  const rangePct =
    rangeStartSeries && rangeStartSeries.v !== 0
      ? (rangeDelta / rangeStartSeries.v) * 100
      : 0;
  const rangePositive = rangeDelta >= 0;
  const rangeColor = rangePositive ? "var(--accent-2)" : "var(--accent)";

  // X-axis labels: pick start, middle, end of the time range. Three ticks is
  // enough for a narrow chart card; more would overlap on the dashboard's
  // ~600px container.
  const showAxis = xAxis && !!series && series.length >= 2;
  const axisTicks: { iso: string; leftPct: number }[] = [];
  let spanMs = 0;
  if (showAxis && series) {
    const lastIdx = series.length - 1;
    const idxs =
      series.length >= 3 ? [0, Math.floor(lastIdx / 2), lastIdx] : [0, lastIdx];
    spanMs =
      new Date(series[lastIdx].t).getTime() - new Date(series[0].t).getTime();
    for (const i of idxs) {
      axisTicks.push({
        iso: series[i].t,
        leftPct: (i / lastIdx) * 100,
      });
    }
  }

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
    <div
      style={{ position: "relative", width: "100%", flex: 1, minHeight: 0 }}
      onMouseMove={interactive ? handleMove : undefined}
      onMouseDown={selectable ? handleDown : undefined}
      onMouseUp={selectable ? commitSelection : undefined}
      onMouseLeave={() => {
        if (dragStartIdx != null) commitSelection();
        setHoverIdx(null);
      }}
    >
      <svg
        viewBox={`0 0 ${w} ${h}`}
        style={{ width: "100%", height: "100%", display: "block" }}
        preserveAspectRatio="none"
      >
        {[0.25, 0.5, 0.75].map((g, i) => (
          <line
            key={i}
            x1="0"
            y1={h * g}
            x2={w}
            y2={h * g}
            stroke="#1a1814"
            strokeWidth="0.5"
            strokeDasharray="3 5"
            opacity="0.25"
          />
        ))}
        {rangeStartPt && rangeEndPt && activeRange && (
          <rect
            x={rangeStartPt[0]}
            y="0"
            width={Math.max(rangeEndPt[0] - rangeStartPt[0], 1)}
            height={h}
            fill={rangePositive ? "#2e8b6b" : "#d64933"}
            opacity="0.08"
          />
        )}
        {fill && !singlePoint && <path d={dFill} fill={fill} opacity="0.15" />}
        {singlePoint && (
          <line
            x1={0}
            y1={h / 2}
            x2={w}
            y2={h / 2}
            stroke={color}
            strokeWidth="0.8"
            strokeDasharray="4 4"
            opacity="0.35"
          />
        )}
        {!singlePoint && (
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeWidth="1.8"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {rangeStartPt && rangeEndPt && activeRange && (
          <>
            {[rangeStartPt, rangeEndPt].map((pt, i) => (
              <line
                key={i}
                x1={pt[0]}
                y1={0}
                x2={pt[0]}
                y2={h}
                stroke={rangeColor}
                strokeWidth="1"
                opacity="0.85"
              />
            ))}
          </>
        )}
        {hoverPt && !activeRange && (
          <line
            x1={hoverPt[0]}
            y1={0}
            x2={hoverPt[0]}
            y2={h}
            stroke={color}
            strokeWidth="0.8"
            strokeDasharray="3 3"
            opacity="0.5"
          />
        )}
      </svg>
      {singlePoint && (
        <div
          style={{
            position: "absolute",
            left: `${(last[0] / w) * 100}%`,
            top: `${(last[1] / h) * 100}%`,
            width: 18,
            height: 18,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            background: color,
            opacity: 0.18,
            pointerEvents: "none",
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          left: `${(last[0] / w) * 100}%`,
          top: `${(last[1] / h) * 100}%`,
          width: singlePoint ? 10 : 6,
          height: singlePoint ? 10 : 6,
          transform: "translate(-50%, -50%)",
          borderRadius: "50%",
          background: color,
          pointerEvents: "none",
        }}
      />
      {rangeStartPt && rangeEndPt && activeRange && (
        <>
          {[rangeStartPt, rangeEndPt].map((pt, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${(pt[0] / w) * 100}%`,
                top: `${(pt[1] / h) * 100}%`,
                width: 14,
                height: 14,
                transform: "translate(-50%, -50%)",
                borderRadius: "50%",
                background: rangeColor,
                border: "2px solid #fbfbfa",
                boxShadow: "0 0 0 1px rgba(26,24,20,0.18)",
                boxSizing: "content-box",
                pointerEvents: "none",
              }}
            />
          ))}
        </>
      )}
      {hoverPt && !activeRange && (
        <div
          style={{
            position: "absolute",
            left: `${(hoverPt[0] / w) * 100}%`,
            top: `${(hoverPt[1] / h) * 100}%`,
            width: 8,
            height: 8,
            transform: "translate(-50%, -50%)",
            borderRadius: "50%",
            background: "#fbfbfa",
            border: `1.5px solid ${color}`,
            boxSizing: "content-box",
            pointerEvents: "none",
          }}
        />
      )}
      {rangeStartSeries && rangeEndSeries && activeRange && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 8,
            transform: "translateX(-50%)",
            pointerEvents: "none",
            fontFamily: "var(--mono)",
            textAlign: "center",
            zIndex: 6,
            background: "rgba(251,251,250,0.72)",
            border: "1px solid rgba(26,24,20,0.12)",
            borderRadius: 6,
            padding: "4px 10px",
            backdropFilter: "blur(4px)",
            whiteSpace: "nowrap",
          }}
        >
          <div
            style={{
              fontFamily: "var(--head)",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--ink)",
            }}
          >
            {fmtRangeDate(rangeStartSeries.t)} - {fmtRangeDate(rangeEndSeries.t)}
          </div>
          <div
            style={{
              color: rangeColor,
              fontFamily: "var(--head)",
              fontSize: 18,
              fontWeight: 600,
              display: "flex",
              gap: 18,
              justifyContent: "center",
              marginTop: 1,
            }}
          >
            <span>
              {rangePositive ? "+" : "-"}
              {fmt$(Math.abs(rangeDelta))}
            </span>
            <span>
              {rangePositive ? "+" : "-"}
              {Math.abs(rangePct).toFixed(2)}%
            </span>
          </div>
        </div>
      )}
      {hoverSeries && hoverPt && !activeRange && (
        <div
          style={{
            position: "absolute",
            left: `${hoverLeftPct}%`,
            top: `${hoverTopPct}%`,
            transform: `translate(${tooltipAnchorRight ? "calc(-100% - 10px)" : "10px"}, -50%)`,
            pointerEvents: "none",
            background: "var(--ink)",
            color: "var(--paper)",
            padding: "6px 10px",
            borderRadius: 6,
            fontFamily: "var(--mono)",
            fontSize: 11,
            lineHeight: 1.35,
            whiteSpace: "nowrap",
            boxShadow: "2px 2px 0 rgba(26,24,20,0.12)",
            zIndex: 5,
          }}
        >
          <div style={{ opacity: 0.65, fontSize: 10 }}>
            {fmtTooltipDate(hoverSeries.t)}
          </div>
          <div style={{ fontFamily: "var(--head)", fontSize: 13, fontWeight: 500 }}>
            {fmt$(hoverSeries.v)}
          </div>
        </div>
      )}
    </div>
      {showAxis && (
        <div
          style={{
            position: "relative",
            height: 14,
            marginTop: 2,
            fontFamily: "var(--mono)",
            fontSize: 9,
            color: "var(--muted)",
            pointerEvents: "none",
            flexShrink: 0,
          }}
        >
          {axisTicks.map((tick, i) => {
            // Anchor the first label to the left edge and the last to the
            // right edge so they don't bleed past the chart bounds; middle
            // labels stay centered on their tick.
            const isFirst = i === 0;
            const isLast = i === axisTicks.length - 1;
            const transform = isFirst
              ? "translateX(0)"
              : isLast
                ? "translateX(-100%)"
                : "translateX(-50%)";
            return (
              <span
                key={i}
                style={{
                  position: "absolute",
                  left: `${tick.leftPct}%`,
                  top: 0,
                  transform,
                  whiteSpace: "nowrap",
                }}
              >
                {fmtAxisDate(tick.iso, spanMs)}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── StackedArea ───────────────────────────────────────────── */
export interface StackedSeries {
  key: string;
  points: TimePoint[];
  color?: string;
}

export function StackedArea({
  w = 600,
  h = 180,
  seed = 3,
  layers = 4,
  series,
  xAxis = false,
}: {
  w?: number;
  h?: number;
  seed?: number;
  layers?: number;
  series?: StackedSeries[];
  xAxis?: boolean;
}) {
  const colors = ["#1a1814", "#d64933", "#2e8b6b", "#f2c14e", "#7a5fbd", "#8a8376"];
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (series && series.length > 0) {
    const times = Array.from(
      new Set(series.flatMap((s) => s.points.map((p) => p.t))),
    ).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    const pointCount = times.length;
    if (pointCount === 0) return <ChartPlaceholder />;

    const values = series.map((s) => {
      const byTime = new Map(s.points.map((p) => [p.t, p.v]));
      return times.map((t) => byTime.get(t) ?? 0);
    });
    const totals = times.map((_, i) =>
      values.reduce((sum, layerValues) => sum + layerValues[i], 0),
    );
    const maxY = Math.max(...totals, 1);
    const chartBottom = h - 10;
    const chartHeight = h - 20;
    const xAt = (i: number) => (pointCount === 1 ? w / 2 : (i / (pointCount - 1)) * w);
    const yAt = (v: number) => chartBottom - (v / maxY) * chartHeight;
    const cumulative: number[][] = times.map(() => []);
    for (let i = 0; i < pointCount; i++) {
      let acc = 0;
      for (let l = 0; l < values.length; l++) {
        acc += values[l][i];
        cumulative[i][l] = acc;
      }
    }

    const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setHoverIdx(Math.round(pct * (pointCount - 1)));
    };

    const paths: React.ReactNode[] = [];
    for (let l = values.length - 1; l >= 0; l--) {
      const top = times
        .map((_, i) => `L ${xAt(i).toFixed(1)} ${yAt(cumulative[i][l]).toFixed(1)}`)
        .join(" ");
      const bottom = times
        .map((_, i) => {
          const ri = pointCount - 1 - i;
          const lower = l === 0 ? 0 : cumulative[ri][l - 1];
          return `L ${xAt(ri).toFixed(1)} ${yAt(lower).toFixed(1)}`;
        })
        .join(" ");
      const firstLower = l === 0 ? 0 : cumulative[0][l - 1];
      const d = `M ${xAt(0).toFixed(1)} ${yAt(firstLower).toFixed(1)} ${top} ${bottom} Z`;
      paths.push(
        <path
          key={series[l].key}
          d={d}
          fill={series[l].color ?? colors[l % colors.length]}
          opacity={0.78}
          stroke="#1a1814"
          strokeWidth="0.65"
          strokeLinejoin="round"
        />,
      );
    }

    const hoverX = hoverIdx == null ? null : xAt(hoverIdx);
    const hoverLeftPct = hoverX == null ? 0 : (hoverX / w) * 100;
    const hoverRows =
      hoverIdx == null
        ? []
        : series
            .map((s, i) => ({
              key: s.key,
              color: s.color ?? colors[i % colors.length],
              v: values[i][hoverIdx],
            }))
            .filter((r) => r.v > 0)
            .sort((a, b) => b.v - a.v)
            .slice(0, 5);
    const tooltipAnchorRight = hoverLeftPct > 60;
    const showAxis = xAxis && pointCount >= 2;
    const spanMs =
      showAxis
        ? new Date(times[pointCount - 1]).getTime() - new Date(times[0]).getTime()
        : 0;
    const axisTicks =
      showAxis
        ? (pointCount >= 3 ? [0, Math.floor((pointCount - 1) / 2), pointCount - 1] : [0, pointCount - 1])
            .map((i) => ({ iso: times[i], leftPct: (i / (pointCount - 1)) * 100 }))
        : [];

    return (
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{ position: "relative", width: "100%", flex: 1, minHeight: 0 }}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <svg
            viewBox={`0 0 ${w} ${h}`}
            style={{ width: "100%", height: "100%", display: "block" }}
            preserveAspectRatio="none"
          >
            {[0.25, 0.5, 0.75].map((g, i) => (
              <line
                key={i}
                x1="0"
                y1={h * g}
                x2={w}
                y2={h * g}
                stroke="#1a1814"
                strokeWidth="0.5"
                strokeDasharray="3 5"
                opacity="0.25"
              />
            ))}
            {paths}
            {hoverX != null && (
              <line
                x1={hoverX}
                y1={0}
                x2={hoverX}
                y2={h}
                stroke="#1a1814"
                strokeWidth="0.8"
                strokeDasharray="3 3"
                opacity="0.5"
              />
            )}
          </svg>
          {hoverIdx != null && (
            <div
              style={{
                position: "absolute",
                left: `${hoverLeftPct}%`,
                top: "42%",
                transform: `translate(${tooltipAnchorRight ? "calc(-100% - 10px)" : "10px"}, -50%)`,
                pointerEvents: "none",
                background: "var(--ink)",
                color: "var(--paper)",
                padding: "7px 10px",
                borderRadius: 6,
                fontFamily: "var(--mono)",
                fontSize: 11,
                lineHeight: 1.35,
                whiteSpace: "nowrap",
                boxShadow: "2px 2px 0 rgba(26,24,20,0.12)",
                zIndex: 5,
              }}
            >
              <div style={{ opacity: 0.65, fontSize: 10 }}>
                {fmtTooltipDate(times[hoverIdx])}
              </div>
              <div style={{ fontFamily: "var(--head)", fontSize: 13, fontWeight: 500 }}>
                {fmt$(totals[hoverIdx])}
              </div>
              <div style={{ marginTop: 4, display: "grid", gap: 2 }}>
                {hoverRows.map((r) => (
                  <span key={r.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <i
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: r.color,
                        display: "inline-block",
                      }}
                    />
                    {r.key}: {fmt$k(r.v)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        {showAxis && (
          <div
            style={{
              position: "relative",
              height: 14,
              marginTop: 2,
              fontFamily: "var(--mono)",
              fontSize: 9,
              color: "var(--muted)",
              pointerEvents: "none",
              flexShrink: 0,
            }}
          >
            {axisTicks.map((tick, i) => {
              const isFirst = i === 0;
              const isLast = i === axisTicks.length - 1;
              const transform = isFirst
                ? "translateX(0)"
                : isLast
                  ? "translateX(-100%)"
                  : "translateX(-50%)";
              return (
                <span
                  key={i}
                  style={{
                    position: "absolute",
                    left: `${tick.leftPct}%`,
                    top: 0,
                    transform,
                    whiteSpace: "nowrap",
                  }}
                >
                  {fmtAxisDate(tick.iso, spanMs)}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const r = seeded(seed);
  const points = 24;
  const demoSeries: number[][] = [];
  for (let l = 0; l < layers; l++) {
    const arr: number[] = [];
    let v = 20 + r() * 30;
    for (let i = 0; i <= points; i++) {
      v += (r() - 0.5) * 8;
      arr.push(Math.max(4, v));
    }
    demoSeries.push(arr);
  }
  const cum: number[][] = [];
  for (let i = 0; i <= points; i++) {
    let acc = 0;
    cum.push(demoSeries.map((s) => (acc += s[i])));
  }
  const maxY = Math.max(...cum.map((c) => c[c.length - 1]));
  const toY = (v: number) => h - (v / maxY) * (h - 10);
  const xs = (i: number) => i * (w / points);

  const paths: React.ReactNode[] = [];
  for (let l = layers - 1; l >= 0; l--) {
    let d = `M 0 ${h} `;
    for (let i = 0; i <= points; i++)
      d += `L ${xs(i).toFixed(1)} ${toY(cum[i][l]).toFixed(1)} `;
    d += `L ${w} ${h} Z`;
    paths.push(
      <path
        key={l}
        d={d}
        fill={colors[l % colors.length]}
        opacity={0.75 - l * 0.08}
        stroke="#1a1814"
        strokeWidth="0.8"
      />,
    );
  }
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", height: "100%" }}
      preserveAspectRatio="none"
    >
      {[0.25, 0.5, 0.75].map((g, i) => (
        <line
          key={i}
          x1="0"
          y1={h * g}
          x2={w}
          y2={h * g}
          stroke="#1a1814"
          strokeWidth="0.5"
          strokeDasharray="3 5"
          opacity="0.25"
        />
      ))}
      {paths}
    </svg>
  );
}

/* ── Donut ─────────────────────────────────────────────────── */
export interface DonutSeg {
  v: number;
  c: string;
  k: string;
}
export function Donut({
  size = 140,
  segs,
  thickness = 22,
  label,
}: {
  size?: number;
  segs: DonutSeg[];
  thickness?: number;
  label?: { top: string; bot: string };
}) {
  const total = segs.reduce((s, x) => s + x.v, 0);
  const r = size / 2 - thickness / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  let a0 = -Math.PI / 2;
  const arcs = segs.map((s, i) => {
    const a1 = a0 + (s.v / total) * Math.PI * 2;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    a0 = a1;
    return (
      <path
        key={i}
        d={d}
        stroke={s.c}
        strokeWidth={thickness}
        fill="none"
        strokeLinecap="butt"
      />
    );
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        stroke="#1a1814"
        strokeWidth="1"
        strokeDasharray="2 4"
        fill="none"
        opacity="0.3"
      />
      {arcs}
      {label && (
        <text x={cx} y={cy - 2} textAnchor="middle" fontFamily="var(--head)" fontSize="22">
          {label.top}
        </text>
      )}
      {label && (
        <text
          x={cx}
          y={cy + 16}
          textAnchor="middle"
          fontFamily="var(--mono)"
          fontSize="10"
          fill="#8a8376"
        >
          {label.bot}
        </text>
      )}
    </svg>
  );
}

/* ── BarList ───────────────────────────────────────────────── */
export interface BarItem {
  k: string;
  v: number;
  c?: string;
}
export function BarList({
  items,
  max,
  color = "#1a1814",
}: {
  items: BarItem[];
  max?: number;
  color?: string;
}) {
  const mx = max ?? Math.max(...items.map((i) => i.v));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((it, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "120px 1fr 80px",
            gap: 8,
            alignItems: "center",
            fontFamily: "var(--mono)",
            fontSize: 11,
          }}
        >
          <div>{it.k}</div>
          <div
            style={{
              height: 10,
              border: "1px solid #1a1814",
              borderRadius: 3,
              background: "#fbfbfa",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: ((it.v / mx) * 100).toFixed(1) + "%",
                height: "100%",
                background: it.c ?? color,
              }}
            />
          </div>
          <div style={{ textAlign: "right" }}>
            {typeof it.v === "number" ? fmt$k(it.v) : (it.v as unknown as string)}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Heatmap (calendar) ───────────────────────────────────── */
export function Heatmap({ weeks = 13, seed = 9 }: { weeks?: number; seed?: number }) {
  const r = seeded(seed);
  const levels = ["#f5f1e8", "#d6e6dc", "#9ecdb7", "#2e8b6b", "#1e5d47"];
  const negLevels = ["#f5f1e8", "#f3d6ce", "#e59c8a", "#d64933", "#9a3624"];
  type Cell = { d: number; w: number; c: string; v: number };
  const cells: Cell[] = [];
  for (let d = 0; d < 7; d++) {
    for (let w = 0; w < weeks; w++) {
      const v = (r() - 0.5) * 2;
      const lv = Math.min(4, Math.floor(Math.abs(v) * 5));
      const c = v >= 0 ? levels[lv] : negLevels[lv];
      cells.push({ d, w, c, v });
    }
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${weeks}, 1fr)`,
        gap: 3,
      }}
    >
      {Array.from({ length: 7 * weeks }).map((_, i) => {
        const w = i % weeks;
        const d = Math.floor(i / weeks);
        const cell = cells.find((c) => c.d === d && c.w === w)!;
        return (
          <div
            key={i}
            style={{
              aspectRatio: "1",
              background: cell.c,
              border: "1px solid rgba(26,24,20,0.15)",
              borderRadius: 3,
            }}
            title={fmtPct(cell.v * 3)}
          />
        );
      })}
    </div>
  );
}

/* ── Sparkline ─────────────────────────────────────────────── */
export function Spark({
  seed = 1,
  color = "#1a1814",
  w = 100,
  h = 28,
  data,
}: {
  seed?: number;
  color?: string;
  w?: number;
  h?: number;
  data?: number[];
}) {
  let pts: [number, number][];
  let d: string;
  if (data && data.length >= 2) {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = Math.max(max - min, 1);
    pts = data.map((v, i) => [
      (i / (data.length - 1)) * w,
      h - 3 - ((v - min) / span) * (h - 6),
    ]);
    d = pts
      .map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1))
      .join(" ");
  } else if (data && data.length === 1) {
    // Flat baseline + dot on the right = "one snapshot so far".
    pts = [[w, h / 2]];
    d = `M 0 ${h / 2} L ${w} ${h / 2}`;
  } else {
    const r = seeded(seed);
    pts = [];
    let y = h / 2;
    for (let i = 0; i <= 20; i++) {
      y += (r() - 0.5) * 6;
      y = Math.max(3, Math.min(h - 3, y));
      pts.push([i * (w / 20), y]);
    }
    d = pts
      .map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1))
      .join(" ");
  }
  const last = pts[pts.length - 1];
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} stroke={color} fill="none" strokeWidth="1.3" strokeLinejoin="round" />
      {data && data.length === 1 && (
        <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />
      )}
    </svg>
  );
}

/* ── Treemap ───────────────────────────────────────────────── */
export interface TreeItem {
  k: string;
  v: number;
  c?: string;
}
export function Treemap({
  items,
  w = 600,
  h = 220,
}: {
  items: TreeItem[];
  w?: number;
  h?: number;
}) {
  const total = items.reduce((s, x) => s + x.v, 0);
  type Block = TreeItem & { x: number; y: number; w: number; h: number };
  const blocks: Block[] = [];
  let x = 0;
  const y = 0;
  let i = 0;
  while (i < items.length) {
    const rowCount = Math.min(3, items.length - i);
    const row = items.slice(i, i + rowCount);
    const rowV = row.reduce((s, x0) => s + x0.v, 0);
    const rowW = (rowV / total) * w;
    let ry = 0;
    for (let j = 0; j < row.length; j++) {
      const bh = (row[j].v / rowV) * h;
      blocks.push({ x, y: y + ry, w: rowW, h: bh, ...row[j] });
      ry += bh;
    }
    x += rowW;
    i += rowCount;
  }
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "100%" }}>
      {blocks.map((b, i) => (
        <g key={i}>
          <rect
            x={b.x + 1}
            y={b.y + 1}
            width={b.w - 2}
            height={b.h - 2}
            fill={b.c || "#fbfbfa"}
            stroke="#1a1814"
            strokeWidth="1.2"
          />
          <text x={b.x + 8} y={b.y + 16} fontFamily="var(--head)" fontSize="16">
            {b.k}
          </text>
          <text
            x={b.x + 8}
            y={b.y + 32}
            fontFamily="var(--mono)"
            fontSize="10"
            fill="#3d3830"
          >
            {fmt$k(b.v)} · {((b.v / total) * 100).toFixed(1)}%
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ── Flow diagram (Sankey-ish) ─────────────────────────────── */
export function FlowDiagram({ w = 640, h = 260 }: { w?: number; h?: number }) {
  const sources = [
    { k: "CEX", y: 20, h: 90, c: "#d64933" },
    { k: "Chain", y: 120, h: 70, c: "#2e8b6b" },
    { k: "Perp", y: 200, h: 30, c: "#7a5fbd" },
  ];
  const sinks = [
    { k: "Chain wallets", y: 10, h: 80, c: "#2e8b6b" },
    { k: "Perp vaults", y: 100, h: 60, c: "#7a5fbd" },
    { k: "Withdraw (bank)", y: 170, h: 40, c: "#8a8376" },
  ];
  const ribbons: Array<[number, number, number]> = [
    [0, 0, 40],
    [0, 1, 30],
    [0, 2, 20],
    [1, 0, 40],
    [1, 1, 20],
    [2, 0, 10],
    [2, 2, 20],
  ];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "100%" }}>
      {sources.map((s, i) => (
        <g key={"s" + i}>
          <rect x="8" y={s.y} width="18" height={s.h} fill={s.c} stroke="#1a1814" />
          <text x="32" y={s.y + 14} fontFamily="var(--mono)" fontSize="11">
            {s.k}
          </text>
        </g>
      ))}
      {sinks.map((s, i) => (
        <g key={"d" + i}>
          <rect
            x={w - 26}
            y={s.y}
            width="18"
            height={s.h}
            fill={s.c}
            stroke="#1a1814"
          />
          <text
            x={w - 100}
            y={s.y + 14}
            fontFamily="var(--mono)"
            fontSize="11"
            textAnchor="start"
          >
            {s.k}
          </text>
        </g>
      ))}
      {ribbons.map(([a, b, thick], i) => {
        const s = sources[a];
        const d = sinks[b];
        const y1 = s.y + s.h / 2;
        const y2 = d.y + d.h / 2;
        const x1 = 26;
        const x2 = w - 26;
        const cx = (x1 + x2) / 2;
        const path = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
        return (
          <path
            key={i}
            d={path}
            stroke={s.c}
            strokeOpacity="0.4"
            strokeWidth={thick}
            fill="none"
          />
        );
      })}
    </svg>
  );
}
