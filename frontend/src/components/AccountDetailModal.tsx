import { Fragment, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { ChartPlaceholder, Delta, LineChart } from "../lib/charts";
import { fmt$ } from "../lib/format";
import { useApi } from "../hooks/useApi";
import { useTranslation } from "../i18n/useTranslation";
import type { Holding } from "../types";

type FilterMode = "all" | "tok" | "pos";

const HIDE_THRESHOLD_USD = 1;

function HoldingIcon({ holding, size = 24 }: { holding: Holding; size?: number }) {
  const [failed, setFailed] = useState(false);
  const label = holding.sym.slice(0, 3) || "?";
  const showImg = holding.logo && !failed;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: holding.c,
        border: "1.5px solid var(--line)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--mono)",
        fontSize: Math.max(8, Math.round(size * 0.38)),
        color: "#fff",
        fontWeight: 600,
        overflow: "hidden",
      }}
    >
      {showImg ? (
        <img
          src={holding.logo!}
          alt={holding.sym}
          width={size}
          height={size}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        label
      )}
    </div>
  );
}

interface ProtocolGroup {
  proto: string;
  chain: string;
  logo?: string | null;
  color: string;
  usd: number;
  d: number;
  positions: Holding[];
}

function groupPositionsByProtocol(
  positions: Holding[],
  isExcluded: (p: Holding) => boolean,
): ProtocolGroup[] {
  const byProto = new Map<string, ProtocolGroup>();
  for (const p of positions) {
    const key = p.proto || "—";
    let bucket = byProto.get(key);
    if (!bucket) {
      bucket = {
        proto: key,
        chain: p.chain,
        logo: p.proto_logo || p.logo,
        color: p.c,
        usd: 0,
        d: 0,
        positions: [],
      };
      byProto.set(key, bucket);
    }
    bucket.positions.push(p);
    if (!isExcluded(p)) {
      bucket.usd += p.usd;
      bucket.d += (p.d || 0) * p.usd;
    }
  }
  const groups = Array.from(byProto.values()).map((g) => ({
    ...g,
    d: g.usd !== 0 ? g.d / g.usd : 0,
  }));
  groups.sort((a, b) => b.usd - a.usd);
  for (const g of groups) g.positions.sort((a, b) => b.usd - a.usd);
  return groups;
}

export function AccountDetailModal({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const t = useTranslation();
  const detail = useApi(
    () => api.getAccount(accountId),
    [accountId],
    `account:${accountId}`,
  );
  const history = useApi(
    () => api.balanceHistory("ALL"),
    [],
    "balance:history:ALL",
  );

  const [filter, setFilter] = useState<FilterMode>("all");
  const [hideDust, setHideDust] = useState(true);
  const [expandedProtos, setExpandedProtos] = useState<Set<string>>(new Set());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleProto = (name: string) => {
    setExpandedProtos((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const holdings: Holding[] = detail.data?.holdings ?? [];
  const excludedKeys = detail.data?.excluded_keys ?? [];
  const excludedSet = useMemo(() => new Set(excludedKeys), [excludedKeys]);
  const isExcluded = (h: Holding): boolean =>
    h.key ? excludedSet.has(h.key) : !!h.excluded;
  const visibleHoldings = hideDust
    ? holdings.filter(
        (h) => Math.abs(h.usd) >= HIDE_THRESHOLD_USD || isExcluded(h),
      )
    : holdings;
  const tokens = visibleHoldings.filter((h) => h.kind === "tok");
  const positions = visibleHoldings.filter((h) => h.kind === "pos");
  const tokCount = tokens.length;
  const posCount = positions.length;
  const protoGroups = useMemo(
    () => groupPositionsByProtocol(positions, isExcluded),
    [positions, excludedSet],
  );

  const showTokens = filter === "all" || filter === "tok";
  const showPositions = filter === "all" || filter === "pos";

  const excludedRowStyle = (excluded: boolean) =>
    excluded
      ? ({
          opacity: 0.45,
          color: "var(--muted)",
        } as const)
      : undefined;
  const excludedUsdStyle = (excluded: boolean) =>
    excluded ? ({ textDecoration: "line-through" } as const) : undefined;

  const modal = (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(26,24,20,0.45)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        overflowY: "auto",
        display: "flex",
        justifyContent: "center",
        padding: "40px 20px",
        isolation: "isolate",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="sketch-box thick"
        style={{
          width: "100%",
          maxWidth: 960,
          margin: "auto",
          background: "#fbfbfa",
          boxShadow: "10px 10px 0 rgba(26,24,20,0.18)",
          padding: 0,
        }}
      >
        <div
          className="row between"
          style={{
            padding: "12px 16px",
            borderBottom: "1.5px solid var(--line)",
            alignItems: "center",
          }}
        >
          <span className="mono-xs" style={{ color: "var(--muted)" }}>
            account details
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 18,
              color: "var(--muted)",
              padding: 4,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        <div className="col" style={{ gap: 12, padding: 16 }}>
          <div className="sketch-box p-16">
            {detail.data ? (
              <>
                <div className="row between">
                  <div>
                    <span className={"src " + detail.data.source}>
                      {detail.data.source}
                    </span>
                    <div
                      className="row"
                      style={{ gap: 10, alignItems: "center", marginTop: 4 }}
                    >
                      <div className="head" style={{ fontSize: 28 }}>
                        {detail.data.name}
                      </div>
                    </div>
                    <div className="tiny" style={{ fontFamily: "var(--mono)" }}>
                      {detail.data.addr}
                      {detail.data.chain && <> · {detail.data.chain}</>} ·{" "}
                      {detail.data.group}
                    </div>
                    {detail.data.note && (
                      <div
                        className="tiny"
                        style={{
                          marginTop: 6,
                          color: "var(--ink-2)",
                          whiteSpace: "pre-wrap",
                          maxWidth: 520,
                        }}
                      >
                        {detail.data.note}
                      </div>
                    )}
                  </div>
                  <div
                    className="col"
                    style={{ alignItems: "flex-end", gap: 4 }}
                  >
                    <div className="head" style={{ fontSize: 32 }}>
                      {fmt$(detail.data.bal)}
                    </div>
                    <Delta v={detail.data.d} />
                    {detail.data.synced_at && (
                      <span className="tiny" style={{ color: "var(--muted)" }}>
                        {t.accounts.syncedAt(
                          new Date(detail.data.synced_at).toLocaleString(),
                        )}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ height: 140, marginTop: 10 }}>
                  {(history.data?.per_account[detail.data.id]?.length ?? 0) >= 1 ? (
                    <LineChart
                      seed={11}
                      fill="#2e8b6b"
                      series={history.data!.per_account[detail.data.id]}
                    />
                  ) : (
                    <ChartPlaceholder />
                  )}
                </div>
              </>
            ) : (
              <div className="tiny muted">{t.common.loading}</div>
            )}
          </div>

          {detail.data && (
            <div className="sketch-box p-16">
              <div className="row between mb-8">
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <span className="mono-xs">{t.accounts.holdingsTitle}</span>
                </div>
                <div className="row" style={{ gap: 10, alignItems: "center" }}>
                  <label
                    className="tiny"
                    style={{
                      display: "inline-flex",
                      gap: 4,
                      alignItems: "center",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={hideDust}
                      onChange={(e) => setHideDust(e.target.checked)}
                    />
                    {t.accounts.hideDust}
                  </label>
                  <div className="row" style={{ gap: 6 }}>
                    <span
                      className={"pill" + (filter === "all" ? " active" : "")}
                      onClick={() => setFilter("all")}
                    >
                      {t.accounts.filterAll} ({tokCount + posCount})
                    </span>
                    <span
                      className={"pill" + (filter === "tok" ? " active" : "")}
                      onClick={() => setFilter("tok")}
                    >
                      {t.accounts.filterTokens} ({tokCount})
                    </span>
                    <span
                      className={"pill" + (filter === "pos" ? " active" : "")}
                      onClick={() => setFilter("pos")}
                    >
                      {t.accounts.filterDefi} ({protoGroups.length})
                    </span>
                  </div>
                </div>
              </div>
              {holdings.length === 0 ? (
                <div className="tiny muted" style={{ padding: "12px 0" }}>
                  {t.accounts.noHoldings}
                </div>
              ) : visibleHoldings.length === 0 ? (
                <div className="tiny muted" style={{ padding: "12px 0" }}>
                  {t.accounts.allDust}
                </div>
              ) : (
                <table className="sk">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th>{t.accounts.colAssetPosition}</th>
                      <th>{t.accounts.colProtocol}</th>
                      <th>{t.accounts.colChainEx}</th>
                      <th className="num">{t.accounts.colAmount}</th>
                      <th className="num">{t.accounts.colPrice}</th>
                      <th className="num">{t.accounts.colUsdValue}</th>
                      <th className="num">{t.accounts.col24h}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {showTokens &&
                      tokens.map((r, i) => {
                        const ex = isExcluded(r);
                        return (
                          <tr key={`tok-${i}`} style={excludedRowStyle(ex)}>
                            <td>
                              <HoldingIcon holding={r} />
                            </td>
                            <td>
                              <b>{r.sym}</b>{" "}
                              <span style={{ color: "var(--muted)" }}>{r.name}</span>
                              {ex && (
                                <span
                                  className="tiny"
                                  style={{
                                    marginLeft: 6,
                                    padding: "0 5px",
                                    border: "1px solid var(--line)",
                                    borderRadius: 3,
                                    color: "var(--ink-2)",
                                    fontSize: 9,
                                    letterSpacing: 0.4,
                                    verticalAlign: "middle",
                                  }}
                                >
                                  {t.accounts.excludedTag}
                                </span>
                              )}
                            </td>
                            <td>{r.proto}</td>
                            <td>
                              <span
                                className="src chain"
                                style={{
                                  borderColor: "var(--line)",
                                  color: "var(--ink-2)",
                                }}
                              >
                                {r.chain}
                              </span>
                            </td>
                            <td className="num">{r.amt}</td>
                            <td className="num">
                              {r.price}
                              {r.price_source === "api" && (
                                <span
                                  className="tiny"
                                  title={t.accounts.livePriceTip}
                                  style={{
                                    marginLeft: 6,
                                    padding: "0 5px",
                                    border: "1px solid var(--line)",
                                    borderRadius: 3,
                                    color: "var(--ink-2)",
                                    fontSize: 9,
                                    letterSpacing: 0.4,
                                    verticalAlign: "middle",
                                  }}
                                >
                                  {t.accounts.live}
                                </span>
                              )}
                            </td>
                            <td className="num">
                              <b style={excludedUsdStyle(ex)}>
                                {r.usd < 0 ? "−" : ""}
                                {fmt$(Math.abs(r.usd))}
                              </b>
                            </td>
                            <td className="num">
                              <Delta v={r.d} />
                            </td>
                          </tr>
                        );
                      })}
                    {showPositions &&
                      protoGroups.map((g) => {
                        const expanded = expandedProtos.has(g.proto);
                        const headerHolding: Holding = {
                          kind: "pos",
                          sym: g.proto,
                          name: g.proto,
                          proto: g.proto,
                          chain: g.chain,
                          amt: "",
                          price: "",
                          usd: g.usd,
                          d: g.d,
                          c: g.color,
                          logo: g.logo,
                        };
                        return (
                          <Fragment key={`proto-${g.proto}`}>
                            <tr
                              onClick={() => toggleProto(g.proto)}
                              style={{ cursor: "pointer" }}
                            >
                              <td>
                                <HoldingIcon holding={headerHolding} />
                              </td>
                              <td>
                                <span
                                  style={{
                                    display: "inline-block",
                                    width: 12,
                                    fontFamily: "var(--mono)",
                                  }}
                                >
                                  {expanded ? "▾" : "▸"}
                                </span>
                                <b>{g.proto}</b>{" "}
                                <span className="chip" style={{ marginLeft: 6 }}>
                                  {t.accounts.positionsLabel(g.positions.length)}
                                </span>
                              </td>
                              <td>{g.proto}</td>
                              <td>
                                <span
                                  className="src chain"
                                  style={{
                                    borderColor: "var(--line)",
                                    color: "var(--ink-2)",
                                  }}
                                >
                                  {g.chain}
                                </span>
                              </td>
                              <td className="num">—</td>
                              <td className="num">—</td>
                              <td className="num">
                                <b>
                                  {g.usd < 0 ? "−" : ""}
                                  {fmt$(Math.abs(g.usd))}
                                </b>
                              </td>
                              <td className="num">
                                <Delta v={g.d} />
                              </td>
                            </tr>
                            {expanded &&
                              g.positions.map((r, i) => {
                                const ex = isExcluded(r);
                                return (
                                  <tr
                                    key={`pos-${g.proto}-${i}`}
                                    style={excludedRowStyle(ex)}
                                  >
                                    <td style={{ paddingLeft: 16 }}>
                                      <HoldingIcon holding={r} size={20} />
                                    </td>
                                    <td style={{ paddingLeft: 24 }}>
                                      <b>{r.name}</b>
                                      {ex && (
                                        <span
                                          className="tiny"
                                          style={{
                                            marginLeft: 6,
                                            padding: "0 5px",
                                            border: "1px solid var(--line)",
                                            borderRadius: 3,
                                            color: "var(--ink-2)",
                                            fontSize: 9,
                                            letterSpacing: 0.4,
                                            verticalAlign: "middle",
                                          }}
                                        >
                                          {t.accounts.excludedTag}
                                        </span>
                                      )}
                                    </td>
                                    <td>{r.proto}</td>
                                    <td>
                                      <span
                                        className="src chain"
                                        style={{
                                          borderColor: "var(--line)",
                                          color: "var(--ink-2)",
                                        }}
                                      >
                                        {r.chain}
                                      </span>
                                    </td>
                                    <td className="num">{r.amt}</td>
                                    <td className="num">{r.price}</td>
                                    <td className="num">
                                      <b style={excludedUsdStyle(ex)}>
                                        {r.usd < 0 ? "−" : ""}
                                        {fmt$(Math.abs(r.usd))}
                                      </b>
                                    </td>
                                    <td className="num">
                                      <Delta v={r.d} />
                                    </td>
                                  </tr>
                                );
                              })}
                          </Fragment>
                        );
                      })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(modal, document.body);
}
