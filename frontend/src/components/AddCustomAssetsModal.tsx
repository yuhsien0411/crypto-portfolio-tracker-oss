import { useState } from "react";
import { ApiError, api } from "../api";
import { useTranslation } from "../i18n/useTranslation";
import type {
  AccountDetail,
  CustomAssetInput,
  Holding,
  PriceSource,
} from "../types";

type Row = {
  symbol: string;
  amount: string;
  unit_price: string;
  price_source: PriceSource;
};
const EMPTY: Row = {
  symbol: "",
  amount: "",
  unit_price: "",
  price_source: "custom",
};

function rowsFromHoldings(holdings: Holding[]): Row[] {
  const out: Row[] = [];
  for (const h of holdings) {
    if (h.kind !== "tok" || h.chain !== "custom") continue;
    const amount = typeof h.amt_raw === "number" ? h.amt_raw : NaN;
    const unit_price = typeof h.price_raw === "number" ? h.price_raw : NaN;
    if (!Number.isFinite(amount) || !Number.isFinite(unit_price)) continue;
    out.push({
      symbol: h.sym,
      amount: String(amount),
      unit_price: String(unit_price),
      price_source: h.price_source === "api" ? "api" : "custom",
    });
  }
  return out;
}

export function AddCustomAssetsModal({
  account,
  onClose,
  onSaved,
}: {
  account: AccountDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslation();
  const initial = rowsFromHoldings(account.holdings ?? []);
  const [rows, setRows] = useState<Row[]>(
    initial.length > 0 ? initial : [{ ...EMPTY }],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [priceBusy, setPriceBusy] = useState<Set<number>>(new Set());
  const [priceErr, setPriceErr] = useState<{ idx: number; msg: string } | null>(null);

  const patch = (idx: number, patch: Partial<Row>) =>
    setRows((r) => r.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  const addRow = () => setRows((r) => [...r, { ...EMPTY }]);
  const removeRow = (idx: number) =>
    setRows((r) =>
      r.length <= 1 ? [{ ...EMPTY }] : r.filter((_, i) => i !== idx),
    );

  async function fetchLivePrice(idx: number, symbol: string) {
    const sym = symbol.trim();
    if (!sym) {
      setPriceErr({ idx, msg: t.editAcct.enterSymbol });
      return false;
    }
    setPriceErr(null);
    setPriceBusy((s) => new Set(s).add(idx));
    try {
      const { price_usd } = await api.spotPrice(sym);
      patch(idx, { unit_price: String(price_usd) });
      return true;
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.status === 404
            ? t.editAcct.noLivePrice(sym.toUpperCase())
            : e.message
          : e instanceof Error
            ? e.message
            : t.editAcct.priceFailed;
      setPriceErr({ idx, msg });
      return false;
    } finally {
      setPriceBusy((s) => {
        const next = new Set(s);
        next.delete(idx);
        return next;
      });
    }
  }

  async function setPriceSource(idx: number, next: PriceSource, symbol: string) {
    patch(idx, { price_source: next });
    if (next === "api" && symbol.trim()) {
      await fetchLivePrice(idx, symbol);
    }
  }

  const subtotal = rows.reduce((acc, r) => {
    const a = Number(r.amount);
    const p = Number(r.unit_price);
    if (!r.symbol.trim() || !Number.isFinite(a) || !Number.isFinite(p)) return acc;
    return acc + a * p;
  }, 0);

  async function submit() {
    setErr(null);
    const payload: CustomAssetInput[] = [];
    for (const row of rows) {
      const sym = row.symbol.trim();
      const amt = row.amount.trim();
      const price = row.unit_price.trim();
      if (!sym && !amt && !price) continue;
      const amountNum = Number(amt);
      const priceNum = Number(price);
      if (!sym || !Number.isFinite(amountNum) || !Number.isFinite(priceNum)) {
        setErr(t.editAcct.customAssetInvalid);
        return;
      }
      payload.push({
        symbol: sym.toUpperCase(),
        amount: amountNum,
        unit_price: priceNum,
        price_source: row.price_source,
      });
    }

    setBusy(true);
    try {
      await api.updateAccount(account.id, { custom_assets: payload });
      onSaved();
    } catch (e) {
      if (e instanceof ApiError) setErr(e.message);
      else setErr(e instanceof Error ? e.message : t.addAssets.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(26,24,20,0.35)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        overflowY: "auto",
        display: "flex",
        justifyContent: "center",
        padding: "40px 20px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="sketch-box thick p-16"
        style={{
          width: "100%",
          maxWidth: 520,
          margin: "auto",
          background: "#fbfbfa",
          boxShadow: "10px 10px 0 rgba(26,24,20,0.12)",
        }}
      >
        <div className="row between mb-12">
          <span className="head" style={{ fontSize: 20 }}>
            {t.addAssets.title(account.name)}
          </span>
          <span
            onClick={onClose}
            style={{ cursor: "pointer", fontSize: 18, color: "var(--muted)" }}
          >
            ✕
          </span>
        </div>

        <div className="tiny mb-8" style={{ color: "var(--muted)" }}>
          {t.addAssets.intro1}
          <b>{t.addAssets.introBold}</b>
          {t.addAssets.intro2}
        </div>

        <div className="row between mb-8">
          <span className="mono-xs">{t.editAcct.assetsHeader}</span>
          <span className="tiny" style={{ color: "var(--muted)" }}>
            {t.editAcct.subtotal(
              subtotal.toLocaleString(undefined, { maximumFractionDigits: 2 }),
            )}
          </span>
        </div>
        <div className="col" style={{ gap: 8, marginBottom: 10 }}>
          {rows.map((row, idx) => {
            const pBusy = priceBusy.has(idx);
            const isApi = row.price_source === "api";
            return (
              <div key={idx} className="col" style={{ gap: 3 }}>
                <div className="row" style={{ gap: 6, alignItems: "center" }}>
                  <input
                    className="winput"
                    value={row.symbol}
                    onChange={(e) => patch(idx, { symbol: e.target.value })}
                    placeholder={t.editAcct.symbolPlaceholder}
                    style={{ flex: "1 1 80px", textTransform: "uppercase" }}
                  />
                  <input
                    className="winput"
                    value={row.amount}
                    onChange={(e) => patch(idx, { amount: e.target.value })}
                    placeholder={t.editAcct.amountPlaceholder}
                    inputMode="decimal"
                    style={{ flex: "1 1 90px" }}
                  />
                  <input
                    className="winput"
                    value={row.unit_price}
                    onChange={(e) => patch(idx, { unit_price: e.target.value })}
                    placeholder={isApi ? t.editAcct.autoLive : t.editAcct.unitPricePlaceholder}
                    inputMode="decimal"
                    readOnly={isApi}
                    disabled={isApi}
                    title={isApi ? t.editAcct.priceLockedTip : undefined}
                    style={{
                      flex: "1 1 90px",
                      opacity: isApi ? 0.65 : 1,
                      cursor: isApi ? "not-allowed" : "text",
                    }}
                  />
                  <button
                    type="button"
                    className="wbtn"
                    onClick={() => removeRow(idx)}
                    title={t.addAssets.removeRow}
                    style={{ padding: "2px 8px", fontSize: 11 }}
                  >
                    ✕
                  </button>
                </div>
                <div className="row" style={{ gap: 6, alignItems: "center" }}>
                  <span className="tiny" style={{ color: "var(--muted)" }}>
                    {t.editAcct.pricePrefix}
                  </span>
                  <span
                    onClick={() => setPriceSource(idx, "custom", row.symbol)}
                    className={"pill" + (!isApi ? " active" : "")}
                    style={{ fontSize: 10, padding: "1px 8px", cursor: "pointer" }}
                    title={t.editAcct.priceCustomTip}
                  >
                    {t.editAcct.priceCustom}
                  </span>
                  <span
                    onClick={() => setPriceSource(idx, "api", row.symbol)}
                    className={"pill" + (isApi ? " active" : "")}
                    style={{ fontSize: 10, padding: "1px 8px", cursor: "pointer" }}
                    title={t.editAcct.priceApiTip}
                  >
                    {t.editAcct.priceApi} {isApi && pBusy ? "…" : ""}
                  </span>
                  {isApi && (
                    <button
                      type="button"
                      className="wbtn"
                      onClick={() => fetchLivePrice(idx, row.symbol)}
                      disabled={pBusy}
                      title={t.editAcct.priceRefreshTip}
                      style={{ padding: "1px 8px", fontSize: 10 }}
                    >
                      {pBusy ? "…" : t.editAcct.priceRefresh}
                    </button>
                  )}
                </div>
                {priceErr?.idx === idx && (
                  <div className="tiny accent" style={{ paddingLeft: 2 }}>
                    {priceErr.msg}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="wbtn"
          onClick={addRow}
          style={{ marginBottom: 14, padding: "2px 10px", fontSize: 11 }}
        >
          {t.addAssets.addRow}
        </button>

        {err && (
          <div className="tiny accent" style={{ marginBottom: 10 }}>
            {err}
          </div>
        )}

        <div className="row between" style={{ gap: 6 }}>
          <button
            type="button"
            className="wbtn"
            onClick={onClose}
            disabled={busy}
          >
            {t.addAssets.cancel}
          </button>
          <button
            type="button"
            className="wbtn primary"
            onClick={submit}
            disabled={busy}
          >
            {busy ? t.addAssets.saving : t.addAssets.save}
          </button>
        </div>
      </div>
    </div>
  );
}
