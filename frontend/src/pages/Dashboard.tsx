import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { BarList, ChartPlaceholder, Delta, LineChart, StackedArea } from "../lib/charts";
import { fmt$, fmt$k, sourceLabel } from "../lib/format";
import { useApi } from "../hooks/useApi";
import { usePreferences } from "../hooks/usePreferences";
import { SYNC_ALL_CONFIRM, SyncButton } from "../components/SyncButton";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { AccountDetailModal } from "../components/AccountDetailModal";
import { useTranslation } from "../i18n/useTranslation";
import type { Account, BalancePoint, Group, SourceType } from "../types";
import type { StackedSeries } from "../lib/charts";

type SortKey = "name" | "group" | "source" | "bal" | "d" | "pct";
type SortDir = "asc" | "desc";
type PortfolioChartMode = "line" | "asset" | "wallet" | "group";
const NUMERIC_KEYS: ReadonlySet<SortKey> = new Set(["bal", "d", "pct"]);
const CHART_RANGES = [
  { k: "7D", l: "1w" },
  { k: "30D", l: "1m" },
  { k: "90D", l: "3m" },
  { k: "180D", l: "6m" },
  { k: "365D", l: "1y" },
  { k: "YTD", l: "ytd" },
] as const;
const STACK_COLORS = [
  "#1a1814",
  "#d64933",
  "#2e8b6b",
  "#f2c14e",
  "#7a5fbd",
  "#8a8376",
  "#0f6f8f",
  "#b65c9a",
  "#5f7d3b",
  "#c77c2f",
];
type ChartRange = (typeof CHART_RANGES)[number]["k"];

export function Dashboard() {
  const { prefs, setPref } = usePreferences();
  const t = useTranslation();
  const hideLowBalance = prefs.hideLowBalance;
  const setHideLowBalance = (v: boolean) => setPref("hideLowBalance", v);
  const threshold = prefs.lowBalanceThreshold;
  const setThreshold = (v: number) => setPref("lowBalanceThreshold", v);
  // Local mirror of the threshold so users can clear the input mid-edit
  // without us snapping back to a number on every keystroke.
  const [thresholdDraft, setThresholdDraft] = useState<string>(String(threshold));
  const minUsd = hideLowBalance ? threshold : 0;
  const [chartMode, setChartMode] = useState<PortfolioChartMode>("line");
  const [chartRange, setChartRange] = useState<ChartRange>("30D");
  const [chartExpanded, setChartExpanded] = useState(false);

  const summary = useApi(() => api.dashboardSummary(), [], "dashboard:summary");
  const accounts = useApi(() => api.listAccounts(), [], "accounts:list");
  const groups = useApi(() => api.listGroups(), [], "groups:list");
  const topAssets = useApi(
    () => api.topAssets(minUsd),
    [minUsd],
    `dashboard:topAssets:${minUsd}`,
  );
  const history = useApi(
    () => api.balanceHistory(chartRange),
    [chartRange],
    `balance:history:${chartRange}`,
  );

  const total = summary.data?.total ?? 0;
  const lastSync = summary.data?.last_sync_at
    ? new Date(summary.data.last_sync_at).toLocaleString()
    : null;

  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const stackSeries = useMemo(() => {
    if (!history.data || chartMode === "line") return [];
    const source =
      chartMode === "asset"
        ? (history.data.by_asset ?? {})
        : chartMode === "wallet"
          ? (history.data.by_wallet ?? {})
          : (history.data.by_group ?? {});
    return toStackedSeries(source, t.dashboard.otherSeries, chartMode === "asset" ? 9 : 10);
  }, [chartMode, history.data, t.dashboard.otherSeries]);
  const chartTitle = useMemo(() => {
    const rangeLabel = CHART_RANGES.find((r) => r.k === chartRange)?.l ?? chartRange;
    const modeLabel =
      chartMode === "line"
        ? t.dashboard.chartLine
        : chartMode === "asset"
          ? t.dashboard.chartByAsset
          : chartMode === "wallet"
            ? t.dashboard.chartByWallet
            : t.dashboard.chartByGroup;
    return t.dashboard.portfolioChartTitle(modeLabel, rangeLabel);
  }, [chartMode, chartRange, t]);
  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev?.key !== key) {
        return { key, dir: NUMERIC_KEYS.has(key) ? "desc" : "asc" };
      }
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  const sortedGroups = useMemo<Group[]>(() => {
    const list = groups.data ?? [];
    return [...list].sort((a, b) => b.bal - a.bal);
  }, [groups.data]);

  const sortedAccounts = useMemo(() => {
    const list = accounts.data ?? [];
    if (!sort) return list;
    const { key, dir } = sort;
    const mult = dir === "asc" ? 1 : -1;
    const get = (a: Account): string | number => {
      switch (key) {
        case "name":
          return a.name.toLowerCase();
        case "group":
          return (a.group ?? "").toLowerCase();
        case "source":
          return sourceLabel(a).toLowerCase();
        case "bal":
        case "pct":
          return a.bal;
        case "d":
          return a.d;
      }
    };
    return [...list].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va < vb) return -1 * mult;
      if (va > vb) return 1 * mult;
      return 0;
    });
  }, [accounts.data, sort]);

  const refreshAll = () => {
    summary.refetch();
    accounts.refetch();
    groups.refetch();
    topAssets.refetch();
    history.refetch();
  };

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <h2>{t.dashboard.title}</h2>
          <div className="tiny mt-8">
            {lastSync ? t.dashboard.lastSync(lastSync) : t.dashboard.notSynced}
          </div>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <SyncButton
            sync={() => api.syncAll()}
            onDone={refreshAll}
            label={t.dashboard.syncAll}
            confirm={SYNC_ALL_CONFIRM}
          />
        </div>
      </div>

      <div
        className="grid"
        style={{
          gridTemplateColumns: "1.3fr 1fr",
          gap: 10,
          fontFamily: "var(--mono)",
          fontSize: 11,
        }}
      >
        <div className="col" style={{ gap: 10 }}>
          <div className="sketch-box p-12">
            <div className="row between">
              <div>
                <div className="mono-xs">{t.dashboard.net}</div>
                <div className="head" style={{ fontSize: 44, lineHeight: 1 }}>
                  {fmt$(total)}
                </div>
              </div>
              <div
                className="col"
                style={{ gap: 2, textAlign: "right", alignItems: "flex-end" }}
              >
                <span>
                  {t.dashboard.col24h}{" "}
                  <span
                    className={
                      (summary.data?.change_24h_usd ?? 0) >= 0 ? "accent-2" : "accent"
                    }
                  >
                    {summary.data
                      ? (summary.data.change_24h_usd >= 0 ? "+" : "−") +
                        fmt$(Math.abs(summary.data.change_24h_usd))
                      : "—"}
                  </span>
                </span>
                <span className="tiny" style={{ color: "var(--muted)" }}>
                  {t.dashboard.accountsLine(
                    summary.data?.accounts_count ?? 0,
                    Object.entries(summary.data?.sources_breakdown ?? {})
                      .map(([k, v]) => `${v} ${k}`)
                      .join(" · "),
                  )}
                </span>
              </div>
            </div>
            <div
              className="row between wrap"
              style={{ gap: 8, marginTop: 12, alignItems: "center" }}
            >
              <PortfolioChartControls
                mode={chartMode}
                range={chartRange}
                onModeChange={setChartMode}
                onRangeChange={setChartRange}
              />
              <div className="row wrap" style={{ gap: 4, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="wbtn"
                  onClick={() => setChartExpanded(true)}
                  aria-label={t.dashboard.expandChart}
                  title={t.dashboard.expandChart}
                  style={{ width: 30, height: 26, padding: 0, lineHeight: 1 }}
                >
                  ⛶
                </button>
              </div>
            </div>
            <div className="mono-xs" style={{ marginTop: 8 }}>
              {chartTitle}
            </div>
            <div style={{ height: 180, marginTop: 4 }}>
              <PortfolioChart
                mode={chartMode}
                total={history.data?.total}
                stackSeries={stackSeries}
              />
            </div>
          </div>

          <div className="sketch-box p-12">
            <div className="mono-xs mb-8">{t.dashboard.allAccounts}</div>
            <table className="sk" style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <SortHeader sort={sort} onSort={toggleSort} k="name" label={t.dashboard.colAcct} />
                  <SortHeader sort={sort} onSort={toggleSort} k="group" label={t.dashboard.colGroup} />
                  <SortHeader sort={sort} onSort={toggleSort} k="source" label={t.dashboard.colSource} />
                  <SortHeader sort={sort} onSort={toggleSort} k="bal" label={t.dashboard.colValue} num />
                  <SortHeader sort={sort} onSort={toggleSort} k="d" label={t.dashboard.col24h} num />
                  <SortHeader sort={sort} onSort={toggleSort} k="pct" label={t.dashboard.colPct} num />
                  <th style={{ width: 36 }}></th>
                </tr>
              </thead>
              <tbody>
                {sortedAccounts.map((a) => (
                  <tr
                    key={a.id}
                    className="clickable"
                    onClick={() => setSelectedAccountId(a.id)}
                    title={`View ${a.name} details`}
                  >
                    <td>{a.name}</td>
                    <td>
                      <span className="chip">{a.group}</span>
                    </td>
                    <td>{sourceLabel(a)}</td>
                    <td className="num">{fmt$k(a.bal)}</td>
                    <td className="num">
                      <Delta v={a.d} />
                    </td>
                    <td className="num">
                      {total ? ((a.bal / total) * 100).toFixed(1) : "—"}%
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <RowSyncButton
                        id={a.id}
                        name={a.name}
                        source={a.source}
                        onDone={refreshAll}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="col" style={{ gap: 10 }}>
          <div className="sketch-box p-12">
            <div className="mono-xs mb-8">{t.dashboard.groups}</div>
            <BarList
              items={sortedGroups.map((g) => ({
                k: g.name,
                v: g.bal,
                c: g.color,
              }))}
            />
          </div>
          <div className="sketch-box p-12">
            <div className="row between mb-8">
              <span className="mono-xs">{t.dashboard.assetBreakdown}</span>
              <label
                className="tiny"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  userSelect: "none",
                }}
                title={t.dashboard.hideLowBalanceTip}
              >
                <input
                  type="checkbox"
                  checked={hideLowBalance}
                  onChange={(e) => setHideLowBalance(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                <span>{t.dashboard.thresholdLabel} $</span>
                <input
                  type="number"
                  className="no-spin"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  value={thresholdDraft}
                  disabled={!hideLowBalance}
                  aria-label={t.dashboard.thresholdAria}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setThresholdDraft(raw);
                    const n = parseFloat(raw);
                    if (Number.isFinite(n) && n >= 0) setThreshold(n);
                  }}
                  onBlur={() => {
                    // Snap the draft back to a valid number on blur so the
                    // input doesn't sit empty after a partial edit.
                    const n = parseFloat(thresholdDraft);
                    if (!Number.isFinite(n) || n < 0) {
                      setThresholdDraft(String(threshold));
                    } else {
                      setThresholdDraft(String(n));
                    }
                  }}
                  style={{
                    width: 64,
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    padding: "1px 4px",
                  }}
                />
              </label>
            </div>
            {(topAssets.data?.length ?? 0) === 0 ? (
              <div className="tiny muted">
                {hideLowBalance
                  ? t.dashboard.noAssetsHidden
                  : t.dashboard.noAssetsYet}
              </div>
            ) : (
              <BarList
                items={topAssets.data!.map((a) => ({ k: a.sym, v: a.bal }))}
              />
            )}
          </div>
        </div>
      </div>

      {chartExpanded && (
        <PortfolioChartModal
          title={chartTitle}
          mode={chartMode}
          range={chartRange}
          total={history.data?.total}
          stackSeries={stackSeries}
          onModeChange={setChartMode}
          onRangeChange={setChartRange}
          onClose={() => setChartExpanded(false)}
        />
      )}

      {selectedAccountId && (
        <AccountDetailModal
          accountId={selectedAccountId}
          onClose={() => setSelectedAccountId(null)}
        />
      )}
    </div>
  );
}

function toStackedSeries(
  record: Record<string, BalancePoint[]> | undefined,
  otherLabel: string,
  limit: number,
): StackedSeries[] {
  const entries = Object.entries(record ?? {})
    .filter(([, points]) => points.some((p) => p.v > 0))
    .sort((a, b) => (b[1][b[1].length - 1]?.v ?? 0) - (a[1][a[1].length - 1]?.v ?? 0));

  const head = entries.slice(0, limit).map(([key, points], i) => ({
    key,
    points,
    color: STACK_COLORS[i % STACK_COLORS.length],
  }));
  const rest = entries.slice(limit);
  if (rest.length === 0) return head;

  const valuesByTime = new Map<string, number>();
  for (const [, points] of rest) {
    for (const point of points) {
      valuesByTime.set(point.t, (valuesByTime.get(point.t) ?? 0) + point.v);
    }
  }
  const otherPoints = Array.from(valuesByTime.entries())
    .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
    .map(([t, v]) => ({ t, v }));

  return [
    ...head,
    {
      key: otherLabel,
      points: otherPoints,
      color: STACK_COLORS[head.length % STACK_COLORS.length],
    },
  ];
}

function PortfolioChart({
  mode,
  total,
  stackSeries,
}: {
  mode: PortfolioChartMode;
  total?: BalancePoint[];
  stackSeries: StackedSeries[];
}) {
  if ((total?.length ?? 0) < 1) return <ChartPlaceholder />;
  if (mode === "line") {
    return <LineChart seed={2} trend={0.4} series={total} xAxis rangeSelect />;
  }
  if (stackSeries.length === 0) return <ChartPlaceholder />;
  return <StackedArea series={stackSeries} xAxis />;
}

function PortfolioChartControls({
  mode,
  range,
  onModeChange,
  onRangeChange,
}: {
  mode: PortfolioChartMode;
  range: ChartRange;
  onModeChange: (mode: PortfolioChartMode) => void;
  onRangeChange: (range: ChartRange) => void;
}) {
  const t = useTranslation();
  const modes: Array<{ k: PortfolioChartMode; l: string }> = [
    { k: "line", l: t.dashboard.chartLine },
    { k: "group", l: t.dashboard.chartByGroup },
    { k: "wallet", l: t.dashboard.chartByWallet },
    { k: "asset", l: t.dashboard.chartByAsset },
  ];

  return (
    <>
      <div className="row wrap" style={{ gap: 4 }}>
        {modes.map((item) => (
          <button
            key={item.k}
            type="button"
            className={"pill" + (mode === item.k ? " active" : "")}
            onClick={() => onModeChange(item.k)}
            style={{ fontSize: 12, padding: "3px 9px" }}
          >
            {item.l}
          </button>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 4, justifyContent: "flex-end" }}>
        {CHART_RANGES.map((item) => (
          <button
            key={item.k}
            type="button"
            className={"pill" + (range === item.k ? " active" : "")}
            onClick={() => onRangeChange(item.k)}
            style={{ fontSize: 12, padding: "3px 9px" }}
          >
            {item.l}
          </button>
        ))}
      </div>
    </>
  );
}

function PortfolioChartModal({
  title,
  mode,
  range,
  total,
  stackSeries,
  onModeChange,
  onRangeChange,
  onClose,
}: {
  title: string;
  mode: PortfolioChartMode;
  range: ChartRange;
  total?: BalancePoint[];
  stackSeries: StackedSeries[];
  onModeChange: (mode: PortfolioChartMode) => void;
  onRangeChange: (range: ChartRange) => void;
  onClose: () => void;
}) {
  const t = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        backgroundColor: "rgba(26,24,20,0.55)",
        backdropFilter: "blur(8px) saturate(80%)",
        WebkitBackdropFilter: "blur(8px) saturate(80%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        className="sketch-box thick p-16"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1120px, 96vw)",
          height: "min(720px, 86vh)",
          background: "#fbfbfa",
          boxShadow: "10px 10px 0 rgba(26,24,20,0.25)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div className="row between" style={{ alignItems: "center" }}>
          <span className="mono-xs">{title}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.common.close}
            title={t.common.close}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 20,
              color: "var(--muted)",
              padding: 4,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        <div className="row between wrap" style={{ gap: 8, alignItems: "center" }}>
          <PortfolioChartControls
            mode={mode}
            range={range}
            onModeChange={onModeChange}
            onRangeChange={onRangeChange}
          />
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <PortfolioChart mode={mode} total={total} stackSeries={stackSeries} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SortHeader({
  k,
  label,
  num,
  sort,
  onSort,
}: {
  k: SortKey;
  label: string;
  num?: boolean;
  sort: { key: SortKey; dir: SortDir } | null;
  onSort: (k: SortKey) => void;
}) {
  const active = sort?.key === k;
  const arrow = active ? (sort!.dir === "asc" ? "▲" : "▼") : "⇅";
  return (
    <th
      className={num ? "num" : undefined}
      onClick={() => onSort(k)}
      style={{ cursor: "pointer", userSelect: "none" }}
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
      <span
        style={{
          opacity: active ? 1 : 0.55,
          fontSize: active ? "1em" : "1.15em",
          marginLeft: 4,
          display: "inline-block",
        }}
      >
        {arrow}
      </span>
    </th>
  );
}

/** Compact per-row sync button for the dashboard Positions table. */
function RowSyncButton({
  id,
  name,
  source,
  onDone,
}: {
  id: string;
  name: string;
  source: SourceType;
  onDone: () => void;
}) {
  const { refresh } = useAuth();
  const t = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Only onchain syncs hit the operator's Alchemy quota — exchange
  // and custom accounts are free, so we don't bother prompting for them.
  const needsConfirm = source === "onchain";

  const doSync = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await api.syncAccount(id);
      if (result.status === "error") {
        setErr(result.message || t.dashboard.syncFailed);
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t.dashboard.syncFailed);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <>
      <button
        type="button"
        className="wbtn"
        onClick={(e) => {
          e.stopPropagation();
          if (needsConfirm) {
            setConfirmOpen(true);
          } else {
            void doSync();
          }
        }}
        disabled={busy}
        style={{ padding: "2px 8px", fontSize: 11 }}
        title={err ? t.dashboard.syncRowErrTitle(err) : t.dashboard.syncRowTitle(name)}
      >
        {busy ? "↻…" : "↻"}
      </button>
      {needsConfirm && (
        <ConfirmDialog
          open={confirmOpen}
          title={t.dashboard.syncOneTitle(name)}
          message={
            <>
              {t.dashboard.syncOneMsgPrefix}
              <b>{name}</b>
              {t.dashboard.syncOneMsgSuffix}
            </>
          }
          confirmLabel={t.dashboard.syncOneConfirm}
          cancelLabel={t.common.cancel}
          onConfirm={() => {
            setConfirmOpen(false);
            void doSync();
          }}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}
