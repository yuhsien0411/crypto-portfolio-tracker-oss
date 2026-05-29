import { useState } from "react";
import { api } from "../api";
import { ChartPlaceholder, Delta, LineChart, Spark } from "../lib/charts";
import { fmt$k } from "../lib/format";
import { useApi } from "../hooks/useApi";
import { SYNC_ALL_CONFIRM, SyncButton } from "../components/SyncButton";
import { useTranslation } from "../i18n/useTranslation";

const RANGES = ["24H", "7D", "30D", "90D", "YTD", "ALL"];

export function Balance() {
  const t = useTranslation();
  const VIEWS = [
    { k: "line", l: t.balance.viewLine },
    { k: "stack", l: t.balance.viewStacked },
    { k: "heat", l: t.balance.viewHeatmap },
    { k: "combo", l: t.balance.viewCombo },
  ];
  const [range, setRange] = useState("30D");
  const [view, setView] = useState("combo");
  const accounts = useApi(() => api.listAccounts(), [], "accounts:list");
  const history = useApi(
    () => api.balanceHistory(range),
    [range],
    `balance:history:${range}`,
  );

  const refreshAfterSync = () => {
    accounts.refetch();
    history.refetch();
  };

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <h2>{t.balance.title}</h2>
          <div className="tiny mt-8">{t.balance.subtitle}</div>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <SyncButton
            sync={() => api.syncAll()}
            onDone={refreshAfterSync}
            label={t.balance.syncAll}
            confirm={SYNC_ALL_CONFIRM}
          />
        </div>
      </div>

      <div className="col" style={{ gap: 12 }}>
        <div className="row between">
          <div
            className="row"
            style={{
              gap: 4,
              border: "1.5px solid var(--line)",
              borderRadius: 8,
              padding: 3,
              background: "#fbfbfa",
            }}
          >
            {VIEWS.map((v) => (
              <span
                key={v.k}
                onClick={() => setView(v.k)}
                className="hand"
                style={{
                  padding: "3px 10px",
                  borderRadius: 5,
                  background: v.k === view ? "var(--ink)" : "transparent",
                  color: v.k === view ? "var(--paper)" : "inherit",
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                {v.l}
              </span>
            ))}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {RANGES.map((r) => (
              <span
                key={r}
                className={"pill" + (range === r ? " active" : "")}
                onClick={() => setRange(r)}
              >
                {r}
              </span>
            ))}
          </div>
        </div>

        <div className="sketch-box p-16">
          <div className="row between mb-8">
            <span className="mono-xs">{t.balance.totalRange(range)}</span>
            <span className="tiny">
              {t.balance.snapshots(history.data?.total.length ?? 0)}
            </span>
          </div>
          <div style={{ height: 220 }}>
            {(history.data?.total.length ?? 0) >= 1 ? (
              <LineChart
                seed={18}
                fill="#2e8b6b"
                trend={0.5}
                series={history.data!.total}
              />
            ) : (
              <ChartPlaceholder />
            )}
          </div>
        </div>

        <div className="sketch-box p-16">
          <div className="mono-xs mb-8">{t.balance.perAccount}</div>
          <div className="grid g-3" style={{ gap: 10 }}>
            {accounts.data?.map((a, i) => (
              <div
                key={a.id}
                className="sketch-box p-12"
                style={{ gap: 4, display: "flex", flexDirection: "column" }}
              >
                <div className="row between">
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                    <b>{a.name}</b>
                  </span>
                  <span className={"src " + a.source}>{a.source}</span>
                </div>
                <div className="row between">
                  <span style={{ fontFamily: "var(--head)", fontSize: 20 }}>
                    {fmt$k(a.bal)}
                  </span>
                  <Delta v={a.d} />
                </div>
                <div style={{ height: 36 }}>
                  {(history.data?.per_account[a.id]?.length ?? 0) >= 1 ? (
                    <Spark
                      seed={i + 4}
                      w={260}
                      color={a.d >= 0 ? "#2e8b6b" : "#d64933"}
                      data={history.data!.per_account[a.id].map((p) => p.v)}
                    />
                  ) : (
                    <ChartPlaceholder message={t.balance.needsSnapshot} />
                  )}
                </div>
              </div>
            ))}
            {accounts.data?.length === 0 && (
              <div className="tiny muted">{t.balance.noAccounts}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
