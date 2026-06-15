"""Sync service — per-user, DB-backed.

Alchemy comes from the operator's environment. Per-account CEX credentials
come from the user's `cex_credentials` rows. Balances + snapshots are
persisted into the DB.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from .. import db_models as m
from ..models import SyncResult


# ── Holdings helpers ─────────────────────────────────────────────────────

_HOLDING_PALETTE = [
    "#2775ca", "#627eea", "#28a0f0", "#4b5fe2", "#b6509e", "#ff007a",
    "#2d344b", "#f7b500", "#00a3ff", "#7a5fbd", "#2e8b6b", "#d64933",
]
_MIN_HOLDING_USD = 0.01  # trim truly-worthless entries; the UI has its own
                         # "hide < $1" toggle for the visual list.


def holding_key(h: dict[str, Any]) -> str:
    """Stable identifier for a single holding row across syncs.

    The holdings JSON is rebuilt from scratch every sync, so we can't use a
    surrogate id. ``sym``/``chain``/``proto`` are the only fields the
    upstream APIs return consistently — ``name`` mutates for perps (it
    embeds leverage / uPnL) and is unsuitable. Two rows that share these
    three fields are treated as the same asset for exclusion purposes."""
    kind = str(h.get("kind") or "")
    chain = str(h.get("chain") or "").lower()
    sym = str(h.get("sym") or "").upper()
    if kind == "pos":
        proto = str(h.get("proto") or "")
        return f"pos:{chain}:{proto}:{sym}"
    return f"tok:{chain}:{sym}"


def _excluded_usd(holdings: list[dict[str, Any]], excluded_keys: list[str]) -> float:
    if not excluded_keys:
        return 0.0
    keys = set(excluded_keys)
    return sum(
        float(h.get("usd", 0.0) or 0.0)
        for h in holdings
        if isinstance(h, dict) and holding_key(h) in keys
    )


def _color_for(key: str) -> str:
    if not key:
        return _HOLDING_PALETTE[0]
    n = sum(ord(c) for c in key)
    return _HOLDING_PALETTE[n % len(_HOLDING_PALETTE)]


def _fmt_amount(x: float) -> str:
    if abs(x) >= 1000:
        return f"{x:,.0f}"
    if abs(x) >= 1:
        return f"{x:,.2f}"
    if x == 0:
        return "0"
    return f"{x:.4f}".rstrip("0").rstrip(".")


def _fmt_price(x: float) -> str:
    if x >= 1:
        return f"${x:,.2f}"
    if x > 0:
        return f"${x:.4f}".rstrip("0").rstrip(".")
    return "—"


def _build_alchemy_holdings(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for a in assets or []:
        amount = float(a.get("amount", 0.0) or 0.0)
        price = float(a.get("unit_price", 0.0) or 0.0)
        usd = float(a.get("usd_value") or amount * price)
        if usd < _MIN_HOLDING_USD:
            continue
        sym = str(a.get("symbol") or "").upper() or "?"
        chain = str(a.get("chain") or "evm").lower()
        out.append({
            "kind": "tok",
            "sym": sym,
            "name": str(a.get("name") or sym),
            "proto": "wallet",
            "chain": chain,
            "amt": _fmt_amount(amount),
            "price": _fmt_price(price),
            "usd": round(usd, 2),
            "d": 0.0,
            "c": _color_for(f"{chain}:{sym}"),
            "logo": str(a.get("logo_url") or "") or None,
        })
    out.sort(key=lambda h: h.get("usd", 0.0), reverse=True)
    return out


def _build_derive_positions(positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Render Derive options/perp positions as `kind=pos` informational rows.
    subaccount_value already includes their mark_value, so these don't
    contribute to the synced balance — purely for display."""
    out: list[dict[str, Any]] = []
    for p in positions or []:
        instrument = str(p.get("instrument_name") or "").strip()
        if not instrument:
            continue
        amount = float(p.get("amount", 0.0) or 0.0)
        if amount == 0:
            continue
        instrument_type = str(p.get("instrument_type") or "").strip().lower()
        mark_price = float(p.get("mark_price", 0.0) or 0.0)
        mark_value = float(p.get("mark_value", 0.0) or 0.0)
        size = abs(amount)
        direction = "LONG" if amount > 0 else "SHORT"

        suffix = ""
        delta = p.get("delta")
        if delta is not None:
            try:
                suffix += f" · Δ {float(delta):+.2f}"
            except (TypeError, ValueError):
                pass
        upnl = float(p.get("unrealized_pnl", 0.0) or 0.0)
        if upnl:
            sign = "+" if upnl > 0 else "−"
            suffix += f" · uPnL {sign}{_fmt_price(abs(upnl))}"

        if instrument_type == "option":
            proto_label = "Derive Option"
        elif instrument_type == "perp":
            proto_label = "Derive Perp"
        else:
            proto_label = "Derive"

        out.append({
            "kind": "pos",
            "sym": instrument,
            "name": f"{instrument} {direction}{suffix}",
            "proto": proto_label,
            "chain": "derive",
            "amt": _fmt_amount(size),
            "price": _fmt_price(mark_price),
            "usd": round(abs(mark_value), 2),
            "d": 0.0,
            "c": _color_for(proto_label),
            "logo": None,
            "proto_logo": None,
            "apr": None,
        })
    out.sort(key=lambda h: h.get("usd", 0.0), reverse=True)
    return out


def _build_cex_positions(
    positions: list[dict[str, Any]], exchange: str
) -> list[dict[str, Any]]:
    """Render derivatives positions as `kind=pos` holdings. These are
    informational — the trading account's totalEq / subaccount_value already
    includes margin + uPnl, so position rows must NOT contribute to the
    synced balance."""
    if exchange == "derive":
        return _build_derive_positions(positions)
    out: list[dict[str, Any]] = []
    proto_label = f"{exchange.upper()} Perp" if exchange == "okx" else exchange.upper()
    for p in positions or []:
        size = abs(float(p.get("size", 0.0) or 0.0))
        notional = abs(float(p.get("notional_usd", 0.0) or 0.0))
        if size == 0 and notional == 0:
            continue
        inst_id = str(p.get("instId") or "").strip()
        if not inst_id:
            continue
        pos_side = str(p.get("posSide") or "").strip().lower()
        if pos_side in ("long", "short"):
            direction = pos_side.upper()
        else:
            direction = "LONG" if float(p.get("size", 0.0) or 0.0) >= 0 else "SHORT"
        leverage = str(p.get("leverage") or "").strip()
        lev_suffix = f" · {leverage}x" if leverage and leverage not in ("", "0", "1") else ""
        upl = float(p.get("upl", 0.0) or 0.0)
        upl_suffix = ""
        if upl:
            upl_sign = "+" if upl > 0 else "−"
            upl_suffix = f" · uPnL {upl_sign}{_fmt_price(abs(upl))}"
        label = f"{inst_id} {direction}{lev_suffix}{upl_suffix}"
        mark = float(p.get("mark_price", 0.0) or 0.0)
        avg = float(p.get("avg_price", 0.0) or 0.0)
        out.append({
            "kind": "pos",
            "sym": inst_id,
            "name": label,
            "proto": proto_label,
            "chain": exchange,
            "amt": _fmt_amount(size),
            "price": _fmt_price(mark or avg),
            "usd": round(notional, 2),
            "d": 0.0,
            "c": _color_for(proto_label),
            "logo": None,
            "proto_logo": None,
            "apr": None,
        })
    out.sort(key=lambda h: h.get("usd", 0.0), reverse=True)
    return out


def _build_cex_holdings(
    assets: list[dict[str, Any]], exchange: str
) -> list[dict[str, Any]]:
    """Merge the CEX integration's per-wallet asset rows into the Holding shape
    the UI renders. Rows are grouped by symbol and account bucket so exchange
    sub-accounts such as Bybit Funding/Earn remain visible in the table."""
    merged: dict[tuple[str, str], dict[str, float]] = {}
    for a in assets or []:
        sym = str(a.get("symbol") or a.get("name") or "").upper()
        if not sym:
            continue
        chain = str(a.get("chain") or exchange).lower()
        amount = float(a.get("amount", 0.0) or 0.0)
        price = float(a.get("unit_price", 0.0) or 0.0)
        usd = float(a.get("usd_value") or amount * price)
        cur = merged.setdefault((sym, chain), {"amount": 0.0, "usd": 0.0, "price": 0.0})
        cur["amount"] += amount
        cur["usd"] += usd
        # Keep any positive unit price we saw — CEX rows mix priced and
        # unpriced entries (e.g. PM non-stable rows have no price).
        if price > 0 and cur["price"] <= 0:
            cur["price"] = price
    out: list[dict[str, Any]] = []
    for (sym, chain), v in merged.items():
        amount = v["amount"]
        usd = v["usd"]
        price = v["price"] or (usd / amount if amount > 0 and usd > 0 else 0.0)
        if usd < _MIN_HOLDING_USD:
            continue
        out.append({
            "kind": "tok",
            "sym": sym,
            "name": sym,
            "proto": "—",
            "chain": chain,
            "amt": _fmt_amount(amount),
            "price": _fmt_price(price),
            "usd": round(usd, 2),
            "d": 0.0,
            "c": _color_for(sym),
            "logo": None,
        })
    out.sort(key=lambda h: h.get("usd", 0.0), reverse=True)
    return out


def _live_price_or_none(symbol: str) -> float | None:
    """Best-effort CoinMarketCap lookup. Returns ``None`` on any failure so
    the caller can fall back to the last-known price instead of exploding
    the whole sync."""
    from ..integrations.prices import PriceNotFound, fetch_spot_price_usd

    try:
        return fetch_spot_price_usd(symbol)
    except PriceNotFound:
        return None


def _build_custom_holdings(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Shape user-entered custom assets into the Holding dict the UI renders.
    `amt_raw` / `price_raw` keep the unformatted floats so the edit UI can
    round-trip the values without parsing the formatted strings.

    For rows with ``price_source="api"``, we store the client-supplied
    fallback price and refresh it on the next throttled sync. This keeps save
    operations from becoming an unbounded paid-API fanout."""
    out: list[dict[str, Any]] = []
    for a in assets or []:
        sym = str(a.get("symbol") or "").strip().upper()
        if not sym:
            continue
        amount = float(a.get("amount") or 0.0)
        price = float(a.get("unit_price") or 0.0)
        price_source = str(a.get("price_source") or "custom").lower()
        if price_source not in ("custom", "api"):
            price_source = "custom"
        usd = amount * price
        name = str(a.get("name") or sym).strip() or sym
        out.append({
            "kind": "tok",
            "sym": sym,
            "name": name,
            "proto": "—",
            "chain": "custom",
            "amt": _fmt_amount(amount),
            "price": _fmt_price(price),
            "usd": round(usd, 2),
            "d": 0.0,
            "c": _color_for(sym),
            "logo": None,
            "amt_raw": amount,
            "price_raw": price,
            "price_source": price_source,
        })
    out.sort(key=lambda h: h.get("usd", 0.0), reverse=True)
    return out


def _normalize_custom_asset(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Coerce one user-entered asset into the canonical shape we persist on
    ``account.custom_assets``. Returns ``None`` for rows with no symbol —
    those would be silent noise otherwise."""
    sym = str(raw.get("symbol") or "").strip().upper()
    if not sym:
        return None
    try:
        amount = float(raw.get("amount") or 0.0)
    except (TypeError, ValueError):
        amount = 0.0
    try:
        unit_price = float(raw.get("unit_price") or 0.0)
    except (TypeError, ValueError):
        unit_price = 0.0
    price_source = str(raw.get("price_source") or "custom").lower()
    if price_source not in ("custom", "api"):
        price_source = "custom"
    name = str(raw.get("name") or sym).strip() or sym
    return {
        "symbol": sym,
        "amount": amount,
        "unit_price": unit_price,
        "name": name,
        "price_source": price_source,
    }


def _custom_assets_to_holdings(
    custom_assets: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Render the persisted ``account.custom_assets`` list into Holding dicts.
    Thin wrapper around ``_build_custom_holdings`` that keeps the call sites
    readable."""
    return _build_custom_holdings(custom_assets or [])


def apply_custom_assets(
    db: Session, account: m.AccountRow, assets: list[dict[str, Any]]
) -> None:
    """Replace the user-typed assets on ``account``. The list is persisted
    on the account row and then layered into a fresh snapshot so the UI sees
    the change immediately. Works for any source — for non-custom accounts
    we keep whatever the last sync wrote and just swap the custom rows.
    Caller is responsible for committing."""
    cleaned = [a for a in (_normalize_custom_asset(x) for x in (assets or [])) if a]
    account.custom_assets = cleaned
    flag_modified(account, "custom_assets")

    if account.source == "custom":
        # No remote data source — the snapshot is entirely the custom rows,
        # which ``_persist_snapshot`` will layer in from account.custom_assets.
        _persist_snapshot(db, account, 0.0, "custom", holdings=[])
        return

    # Non-custom: preserve whatever the last sync produced. Strip any
    # leftover chain=="custom" rows from older snapshots so we don't
    # double-count once ``_persist_snapshot`` re-appends the fresh ones.
    snap = db.get(m.AccountSnapshotRow, account.id)
    if snap is None:
        base_rows: list[dict[str, Any]] = []
        base_bal = 0.0
        provider = ""
    else:
        base_rows = [
            h for h in (snap.holdings or [])
            if isinstance(h, dict) and h.get("chain") != "custom"
        ]
        base_bal = sum(float(h.get("usd", 0.0) or 0.0) for h in base_rows)
        provider = snap.provider or ""
    _persist_snapshot(db, account, base_bal, provider, holdings=base_rows)


def _refresh_api_priced_custom_assets(account: m.AccountRow) -> tuple[int, int]:
    """Re-price every ``price_source="api"`` row in ``account.custom_assets``
    from CoinMarketCap, mutating the list in place. Returns
    ``(refreshed, api_total)`` so the caller can build a status message.
    Rows whose live lookup fails keep their last-known price."""
    refreshed = 0
    api_total = 0
    changed = False
    for a in account.custom_assets or []:
        if not isinstance(a, dict):
            continue
        if (a.get("price_source") or "custom") != "api":
            continue
        api_total += 1
        sym = str(a.get("symbol") or "").upper()
        live = _live_price_or_none(sym)
        if live is None:
            continue
        a["unit_price"] = float(live)
        changed = True
        refreshed += 1
    if changed:
        flag_modified(account, "custom_assets")
    return (refreshed, api_total)


# ─────────────────────────────────────────────────────────────────────────

def _is_mock_address(addr: str) -> bool:
    if not addr:
        return True
    return "…" in addr or "..." in addr


_KNOWN_EXCHANGES = ("binance", "bitget", "okx", "bybit", "gate", "extended", "derive")


def _infer_exchange(addr: str, explicit: str | None = None) -> str | None:
    """Pick the exchange name for an exchange-source account. Prefer the
    credential's explicit ``exchange`` field; fall back to address-prefix
    sniffing for legacy rows that pre-date the credential field."""
    if explicit:
        return explicit.strip().lower()
    a = addr.lower()
    for name in _KNOWN_EXCHANGES:
        if a.startswith(name):
            return name
    if a.startswith("hl") or "hyperliquid" in a:
        return "hyperliquid"
    return None


def _cex_wallet(account: m.AccountRow, exchange: str, cred: m.CexCredentialRow) -> dict[str, Any]:
    addr = cred.wallet_address or ""
    return {
        "name": account.name,
        "exchange": exchange,
        "api_key": cred.api_key or "",
        "api_secret": cred.api_secret or "",
        "passphrase": cred.passphrase or "",
        # Hyperliquid/Derive fetchers read `address`; keep `wallet_address` for
        # the other integrations that use that key.
        "wallet_address": addr,
        "address": addr,
    }


def account_uses_live_prices(db: Session, account: m.AccountRow) -> bool:
    """True when syncing this account will call CoinMarketCap. Any account
    with a ``price_source="api"`` custom asset triggers a live lookup,
    regardless of the account's source."""
    return any(
        isinstance(a, dict) and (a.get("price_source") or "custom") == "api"
        for a in (account.custom_assets or [])
    )


def _persist_snapshot(
    db: Session, account: m.AccountRow, new_bal: float, provider: str, holdings: list
) -> None:
    # User-typed custom assets live on the account row; layer them into the
    # snapshot here so every code path (sync, custom-assets edit) keeps them
    # visible without each caller having to remember.
    custom_rendered = _custom_assets_to_holdings(account.custom_assets)
    if custom_rendered:
        custom_total = sum(float(h.get("usd", 0.0) or 0.0) for h in custom_rendered)
        holdings = list(holdings or []) + custom_rendered
        new_bal = float(new_bal or 0.0) + custom_total

    # Subtract any user-excluded holdings from the synced balance. The full
    # holdings list is still stored verbatim in the snapshot so the UI can
    # show excluded rows greyed out instead of hiding them.
    excluded_usd = _excluded_usd(holdings or [], account.excluded_keys or [])
    effective_bal = max(new_bal - excluded_usd, 0.0)
    prev_bal = account.bal or 0.0
    delta_pct = (
        round(((effective_bal - prev_bal) / prev_bal) * 100, 2) if prev_bal > 0 else 0.0
    )
    account.bal = round(effective_bal, 2)
    account.d = delta_pct
    snap = db.get(m.AccountSnapshotRow, account.id)
    now = datetime.now(timezone.utc)
    if snap is None:
        snap = m.AccountSnapshotRow(
            account_id=account.id,
            bal=account.bal,
            d=delta_pct,
            synced_at=now,
            provider=provider,
            holdings=holdings,
        )
        db.add(snap)
    else:
        snap.bal = account.bal
        snap.d = delta_pct
        snap.synced_at = now
        snap.provider = provider
        snap.holdings = holdings
    db.add(
        m.AccountSnapshotHistoryRow(
            user_id=account.user_id,
            account_id=account.id,
            bal=account.bal,
            d=delta_pct,
            synced_at=now,
            provider=provider,
            holdings=holdings,
        )
    )


def recompute_balance_from_snapshot(db: Session, account: m.AccountRow) -> None:
    """Re-derive ``account.bal`` from the existing snapshot's holdings using
    the account's current ``excluded_keys``. Used when the user toggles an
    exclusion — we don't want to write a new history row (that's reserved
    for actual syncs), just update the headline balance so the dashboard
    reflects the change immediately."""
    snap = db.get(m.AccountSnapshotRow, account.id)
    if snap is None:
        return
    holdings = snap.holdings or []
    raw_bal = sum(
        float(h.get("usd", 0.0) or 0.0)
        for h in holdings
        if isinstance(h, dict)
    )
    excluded_usd = _excluded_usd(holdings, account.excluded_keys or [])
    effective_bal = max(raw_bal - excluded_usd, 0.0)
    account.bal = round(effective_bal, 2)
    snap.bal = account.bal


def _result(account: m.AccountRow, status: str, **kw: Any) -> SyncResult:
    return SyncResult(
        account_id=account.id,
        name=account.name,
        source=account.source,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        **kw,
    )


def _sync_onchain(db: Session, account: m.AccountRow) -> SyncResult:
    if _is_mock_address(account.addr):
        return _result(
            account, "skipped",
            message="address is truncated/mock — edit it in Manage Accounts to enable sync",
        )
    chain = (account.chain or "").lower()
    if chain == "cosmos":
        return _result(account, "skipped", message="Cosmos is no longer supported")
    alchemy_key = (os.getenv("ALCHEMY_API_KEY") or "").strip()
    if not alchemy_key:
        return _result(account, "error", message="Server missing ALCHEMY_API_KEY")
    try:
        if chain in ("solana", "sui"):
            from ..integrations.alchemy import (
                fetch_solana_wallet_assets as fetch_alchemy_solana_wallet_assets,
                fetch_sui_wallet_assets as fetch_alchemy_sui_wallet_assets,
            )

            fetcher = {
                "solana": fetch_alchemy_solana_wallet_assets,
                "sui": fetch_alchemy_sui_wallet_assets,
            }[chain]
            payload = fetcher(account.addr, api_key=alchemy_key)
            new_bal = float(payload.get("balance", 0.0) or 0.0)
            holdings = _build_alchemy_holdings(payload.get("assets") or [])
            provider = f"alchemy-{chain}-token-only"
        else:
            from ..integrations.alchemy import fetch_evm_wallet_assets

            networks_raw = os.getenv("ALCHEMY_NETWORKS", "eth,polygon,bnb,arb,opt,base,mantle,scroll")
            networks = [n.strip().lower() for n in networks_raw.split(",") if n.strip()]
            payload = fetch_evm_wallet_assets(account.addr, alchemy_key, networks, timeout=8.0)
            new_bal = float(payload.get("balance", 0.0) or 0.0)
            holdings = _build_alchemy_holdings(payload.get("assets") or [])
            provider = "alchemy-token-only"
    except Exception as exc:  # noqa: BLE001
        return _result(account, "error", message=str(exc))

    _persist_snapshot(db, account, new_bal, provider, holdings=holdings)
    return _result(
        account,
        "ok",
        balance=account.bal,
        message="synced wallet tokens via Alchemy + DefiLlama prices",
    )


def _sync_exchange(db: Session, account: m.AccountRow, exchange: str | None) -> SyncResult:
    if not exchange:
        return _result(
            account, "skipped",
            message=f"cannot infer exchange from addr '{account.addr}'",
        )
    cred = db.get(m.CexCredentialRow, account.id)
    if cred is None or (not cred.api_key and not cred.wallet_address):
        return _result(
            account, "skipped",
            message=f"{exchange} credentials not set — add them in Settings",
        )
    try:
        from ..integrations.cex import fetch_cex_assets

        payload = fetch_cex_assets(_cex_wallet(account, exchange, cred))
        new_bal = float(payload.get("balance", 0.0) or 0.0)
        holdings = _build_cex_holdings(payload.get("assets") or [], exchange)
        position_rows = _build_cex_positions(payload.get("positions") or [], exchange)
        if position_rows:
            holdings = holdings + position_rows
    except Exception as exc:  # noqa: BLE001
        return _result(account, "error", message=str(exc))

    _persist_snapshot(db, account, new_bal, exchange, holdings=holdings)
    return _result(account, "ok", balance=account.bal, message=f"synced via {exchange}")


def _sync_dispatch(db: Session, account: m.AccountRow) -> SyncResult:
    # Refresh any ``price_source="api"`` custom assets first, regardless of
    # source. ``_persist_snapshot`` reads ``account.custom_assets`` at write
    # time, so the per-source sync below picks up the fresh prices for free.
    refreshed, api_total = _refresh_api_priced_custom_assets(account)

    if account.source == "onchain":
        return _sync_onchain(db, account)
    if account.source == "exchange":
        cred = db.get(m.CexCredentialRow, account.id)
        explicit = cred.exchange if cred else None
        return _sync_exchange(db, account, _infer_exchange(account.addr, explicit))

    # Custom: no remote source — just rebuild the snapshot from the (now
    # possibly re-priced) custom assets list.
    apply_custom_assets(db, account, list(account.custom_assets or []))
    if api_total == 0:
        return _result(
            account, "skipped",
            message="custom entry — no live-priced assets to refresh",
        )
    if refreshed == 0:
        return _result(
            account, "error",
            message=f"couldn't refresh any of {api_total} live prices",
        )
    suffix = "" if refreshed == api_total else f" ({api_total - refreshed} failed)"
    return _result(
        account, "ok",
        balance=account.bal,
        message=f"refreshed {refreshed}/{api_total} live prices{suffix}",
    )


def _hits_paid_api(account: m.AccountRow) -> bool:
    """Does syncing this account call the operator's on-chain API provider?

    Only onchain sources do. Exchange syncs call CEX APIs directly with the
    user's own keys; custom rows and mock/truncated addresses short-circuit
    inside ``_sync_dispatch`` and never make a request."""
    if account.source != "onchain":
        return False
    if _is_mock_address(account.addr):
        return False
    chain = (account.chain or "").lower()
    if chain == "cosmos":
        return False
    return True


def sync_account(db: Session, account: m.AccountRow) -> SyncResult:
    """Sync one account and persist its snapshot."""
    return _sync_dispatch(db, account)


def sync_user_accounts(db: Session, user_id: str) -> list[SyncResult]:
    accounts = db.query(m.AccountRow).filter(m.AccountRow.user_id == user_id).all()
    results = [sync_account(db, a) for a in accounts]
    total = round(sum(a.bal for a in accounts), 2)
    db.add(m.TotalSnapshotRow(user_id=user_id, t=datetime.now(timezone.utc), v=total))
    db.commit()
    return results


def estimate_user_sync(db: Session, user_id: str) -> dict[str, int]:
    """Preflight count for the sync-all confirmation dialog. ``remote_accounts``
    are the ones that hit a paid external API (onchain, non-mock)."""
    accounts = (
        db.query(m.AccountRow).filter(m.AccountRow.user_id == user_id).all()
    )
    remote = sum(1 for a in accounts if _hits_paid_api(a))
    return {
        "accounts_count": len(accounts),
        "remote_accounts": remote,
    }


# ── Validation (dry-run fetch, no persistence) ───────────────────────────

class ValidationFailed(Exception):
    """Raised when a dry-run fetch for an account's (possibly pending)
    source/addr/chain/credentials can't successfully load data."""


def validate_account(
    db: Session,
    account: m.AccountRow,
    *,
    pending_cred: m.CexCredentialRow | None = None,
) -> None:
    """Try to fetch fresh data for `account` using its current in-memory
    values (which may include uncommitted PATCH edits). Raises
    ``ValidationFailed`` on any problem — the caller is expected to
    ``db.rollback()`` and surface the error. Manual accounts are always
    considered valid."""
    source = account.source
    if source == "custom":
        return
    if _is_mock_address(account.addr):
        raise ValidationFailed(
            "address is truncated/mock — paste the full address"
        )
    if source == "onchain":
        _validate_onchain(account)
        return
    if source == "exchange":
        cred = (
            pending_cred
            if pending_cred is not None
            else db.get(m.CexCredentialRow, account.id)
        )
        explicit = cred.exchange if cred else None
        exchange = _infer_exchange(account.addr, explicit)
        _validate_exchange(account, exchange, cred)
        return


def _validate_onchain(account: m.AccountRow) -> None:
    chain = (account.chain or "").lower()
    try:
        if chain == "cosmos":
            raise ValidationFailed("Cosmos is no longer supported")
        alchemy_key = (os.getenv("ALCHEMY_API_KEY") or "").strip()
        if not alchemy_key:
            raise ValidationFailed("Server missing ALCHEMY_API_KEY")
        if chain in ("solana", "sui"):
            from ..integrations.alchemy import (
                fetch_solana_wallet_assets as fetch_alchemy_solana_wallet_assets,
                fetch_sui_wallet_assets as fetch_alchemy_sui_wallet_assets,
            )

            fetcher = {
                "solana": fetch_alchemy_solana_wallet_assets,
                "sui": fetch_alchemy_sui_wallet_assets,
            }[chain]
            fetcher(account.addr, api_key=alchemy_key)
            return
        from ..integrations.alchemy import fetch_evm_wallet_assets

        networks_raw = os.getenv("ALCHEMY_NETWORKS", "eth,polygon,bnb,arb,opt,base,mantle,scroll")
        networks = [n.strip().lower() for n in networks_raw.split(",") if n.strip()]
        fetch_evm_wallet_assets(account.addr, alchemy_key, networks, timeout=8.0)
    except ValidationFailed:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ValidationFailed(str(exc)) from exc


def _validate_exchange(
    account: m.AccountRow,
    exchange: str | None,
    cred: m.CexCredentialRow | None,
) -> None:
    if not exchange:
        raise ValidationFailed(
            f"cannot infer exchange from addr '{account.addr}'"
        )
    if cred is None or (not cred.api_key and not cred.wallet_address):
        raise ValidationFailed(f"{exchange} credentials not set")
    try:
        from ..integrations.cex import fetch_cex_assets

        fetch_cex_assets(_cex_wallet(account, exchange, cred))
    except Exception as exc:  # noqa: BLE001
        raise ValidationFailed(str(exc)) from exc
