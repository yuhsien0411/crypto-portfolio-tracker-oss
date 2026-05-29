"""Dashboard endpoints — summary + top assets (per-user)."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc
from sqlalchemy.orm import Session

from .. import db_models as m
from ..auth import current_user
from ..db import get_db
from ..models import DashboardSummary, TopAsset
from ..services.sync import holding_key

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _as_utc(dt: datetime | None) -> datetime | None:
    # Snapshot timestamps are written with datetime.now(timezone.utc) but
    # SQLAlchemy's plain DateTime column strips tzinfo on read. Reattach UTC
    # so pydantic emits an offset-bearing ISO string and the frontend parses
    # it back to the same instant regardless of browser locale.
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


@router.get("/summary", response_model=DashboardSummary)
def summary(
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> DashboardSummary:
    accounts = db.query(m.AccountRow).filter(m.AccountRow.user_id == user.id).all()
    total = sum(a.bal for a in accounts)
    weighted_d = sum(a.bal * a.d for a in accounts)
    change_24h_pct = round(weighted_d / total, 2) if total > 0 else 0.0
    sources: dict[str, int] = {}
    for a in accounts:
        sources[a.source] = sources.get(a.source, 0) + 1
    last = (
        db.query(m.TotalSnapshotRow)
        .filter(m.TotalSnapshotRow.user_id == user.id)
        .order_by(desc(m.TotalSnapshotRow.t))
        .first()
    )
    return DashboardSummary(
        total=round(total, 2),
        change_24h_usd=round(total * (change_24h_pct / 100), 2),
        change_24h_pct=change_24h_pct,
        change_7d_pct=0.0,
        change_30d_pct=0.0,
        change_ytd_pct=0.0,
        change_1h_pct=0.0,
        accounts_count=len(accounts),
        sources_breakdown=sources,
        last_sync_at=_as_utc(last.t) if last else None,
    )


@router.get("/top-assets", response_model=list[TopAsset])
def top_assets(
    min_usd: float = Query(
        default=1.0,
        ge=0.0,
        description="Drop aggregated buckets whose total USD is below this threshold.",
    ),
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[TopAsset]:
    accounts = (
        db.query(m.AccountRow).filter(m.AccountRow.user_id == user.id).all()
    )
    account_ids = [a.id for a in accounts]
    if not account_ids:
        return []
    # Map account_id → set of excluded holding keys, so the per-snapshot
    # loop below can skip user-excluded rows without an extra query.
    excluded_by_account: dict[str, set[str]] = {
        a.id: set(a.excluded_keys or []) for a in accounts
    }

    # Group wallet tokens by symbol (USDC, ETH, SOL…) and DeFi positions by
    # protocol (Aave V3, Polymarket, Pendle…). The underlying coin of a
    # position isn't the right bucket because a user may have the same coin
    # both in their wallet and inside a protocol.
    agg: dict[str, dict] = {}
    snaps = (
        db.query(m.AccountSnapshotRow)
        .filter(m.AccountSnapshotRow.account_id.in_(account_ids))
        .all()
    )
    for snap in snaps:
        excluded = excluded_by_account.get(snap.account_id, set())
        for h in snap.holdings or []:
            if not isinstance(h, dict):
                continue
            if excluded and holding_key(h) in excluded:
                continue
            usd = float(h.get("usd", 0) or 0)
            if usd <= 0:
                continue
            if h.get("kind") == "pos":
                proto = str(h.get("proto") or "").strip()
                if not proto or proto == "—":
                    proto = "Other DeFi"
                key = f"pos:{proto.lower()}"
                label = proto
                display_name = proto
            else:
                sym = str(h.get("sym", "")).upper()
                if not sym:
                    continue
                key = f"tok:{sym}"
                label = sym
                display_name = str(h.get("name") or sym)
            cur = agg.setdefault(
                key,
                {"label": label, "name": display_name, "bal": 0.0, "wd": 0.0, "chains": set()},
            )
            cur["bal"] += usd
            cur["wd"] += usd * float(h.get("d", 0) or 0)
            cur["chains"].add(str(h.get("chain", "")))
    total = sum(x["bal"] for x in agg.values())
    filtered = [(k, info) for k, info in agg.items() if info["bal"] >= min_usd]
    rows = sorted(filtered, key=lambda kv: -kv[1]["bal"])
    out: list[TopAsset] = []
    for _, info in rows:
        bal = info["bal"]
        out.append(
            TopAsset(
                sym=info["label"],
                name=info["name"],
                bal=round(bal, 2),
                pct=round((bal / total) * 100, 1) if total > 0 else 0.0,
                chains=len(info["chains"]),
                chg=round(info["wd"] / bal, 2) if bal > 0 else 0.0,
            )
        )
    return out
