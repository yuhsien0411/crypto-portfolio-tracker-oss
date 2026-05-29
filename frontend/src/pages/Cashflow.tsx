import { useState } from "react";
import { api } from "../api";
import { ChartPlaceholder } from "../lib/charts";
import { fmt$ } from "../lib/format";
import { useApi } from "../hooks/useApi";
import { SYNC_ALL_CONFIRM, SyncButton } from "../components/SyncButton";
import { useTranslation } from "../i18n/useTranslation";

const RANGES = ["24H", "7D", "30D", "90D", "YTD", "ALL"];

export function Cashflow() {
  const t = useTranslation();
  const [range, setRange] = useState("30D");
  const cashflow = useApi(() => api.cashflow(), [], "cashflow");

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div>
          <h2>
            {t.cashflow.title}{" "}
            <span className="tiny" style={{ marginLeft: 10 }}>
              {t.cashflow.subhead}
            </span>
          </h2>
          <div className="tiny mt-8">{t.cashflow.subtitle}</div>
        </div>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <SyncButton
            sync={() => api.syncAll()}
            onDone={() => cashflow.refetch()}
            label={t.cashflow.syncAll}
            confirm={SYNC_ALL_CONFIRM}
          />
        </div>
      </div>

      <div className="col" style={{ gap: 12 }}>
        <div className="row between">
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

        <div className="grid g-4">
          <div className="sketch-box kpi">
            <span className="k">{t.cashflow.inflows30d}</span>
            <span className="v accent-2">
              {fmt$(cashflow.data?.inflows_30d ?? 0)}
            </span>
          </div>
          <div className="sketch-box kpi">
            <span className="k">{t.cashflow.outflows30d}</span>
            <span className="v accent">
              −{fmt$(Math.abs(cashflow.data?.outflows_30d ?? 0))}
            </span>
          </div>
          <div className="sketch-box kpi">
            <span className="k">{t.cashflow.net30d}</span>
            <span
              className={
                "v " + ((cashflow.data?.net_30d ?? 0) >= 0 ? "accent-2" : "accent")
              }
            >
              {(cashflow.data?.net_30d ?? 0) >= 0 ? "+" : "−"}
              {fmt$(Math.abs(cashflow.data?.net_30d ?? 0))}
            </span>
          </div>
          <div className="sketch-box kpi">
            <span className="k">{t.cashflow.pending}</span>
            <span className="v">{cashflow.data?.pending ?? 0}</span>
          </div>
        </div>

        <div className="sketch-box p-16">
          <div className="mono-xs mb-8">{t.cashflow.flowDiagram(range)}</div>
          <div style={{ height: 280 }}>
            <ChartPlaceholder message={t.cashflow.flowPlaceholder} />
          </div>
        </div>

        <div className="sketch-box p-16">
          <div className="mono-xs mb-8">{t.cashflow.transferLedger}</div>
          <div className="tiny muted" style={{ padding: "12px 0" }}>
            {t.cashflow.transferEmpty}
          </div>
        </div>
      </div>
    </div>
  );
}
