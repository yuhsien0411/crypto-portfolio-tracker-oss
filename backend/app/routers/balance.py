"""Balance-history endpoints (per-user)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from .. import db_models as m
from ..auth import current_user
from ..db import get_db
from ..models import BalanceHistory, BalancePoint
from ..services.sync import effective_excluded_keys, holding_key

router = APIRouter(prefix="/api/balance", tags=["balance"])

_RANGE_DAYS = {
    "24H": 1,
    "7D": 7,
    "1W": 7,
    "30D": 30,
    "1M": 30,
    "90D": 90,
    "3M": 90,
    "180D": 180,
    "6M": 180,
    "365D": 365,
    "1Y": 365,
    "ALL": 3650,
}


def _as_utc_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _cutoff_for_range(value: str) -> datetime:
    now = datetime.now(timezone.utc)
    key = value.upper()
    if key == "YTD":
        return datetime(now.year, 1, 1, tzinfo=timezone.utc)
    return now - timedelta(days=_RANGE_DAYS.get(key, 30))


def _display_group(name: str) -> str:
    key = (name or "").strip().lower()
    if not key or key == "unassigned":
        return "Unassigned"
    return key.capitalize()


def _asset_label(holding: dict) -> str | None:
    if holding.get("kind") == "pos":
        proto = str(holding.get("proto") or "").strip()
        return proto if proto and proto != "—" else "Other DeFi"
    sym = str(holding.get("sym") or "").upper().strip()
    return sym or None


def _append_point(series: dict[str, list[BalancePoint]], key: str, t: str, v: float) -> None:
    if v <= 0:
        return
    series.setdefault(key, []).append(BalancePoint(t=t, v=round(v, 2)))


@router.get("/history", response_model=BalanceHistory)
def history(
    range: str = Query("30D"),
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> BalanceHistory:
    cutoff = _cutoff_for_range(range)

    total_rows = (
        db.query(m.TotalSnapshotRow)
        .filter(
            m.TotalSnapshotRow.user_id == user.id,
            m.TotalSnapshotRow.t >= cutoff,
        )
        .order_by(m.TotalSnapshotRow.t.asc())
        .all()
    )
    # Snapshots are stored as UTC but SQLAlchemy strips tzinfo on the way out
    # of plain DateTime columns. Reattach UTC so the ISO string carries an
    # explicit offset — otherwise the JS frontend parses naive ISO strings as
    # local time and shifts the chart by the user's UTC offset.
    total = [
        BalancePoint(t=_as_utc_iso(r.t), v=r.v) for r in total_rows
    ]

    accounts = db.query(m.AccountRow).filter(m.AccountRow.user_id == user.id).all()
    account_ids = [a.id for a in accounts]
    account_by_id = {a.id: a for a in accounts}
    per_account: dict[str, list[BalancePoint]] = {}
    by_wallet: dict[str, list[BalancePoint]] = {}
    by_group: dict[str, list[BalancePoint]] = {}
    by_asset: dict[str, list[BalancePoint]] = {}
    if account_ids:
        history_rows = (
            db.query(m.AccountSnapshotHistoryRow)
            .filter(
                m.AccountSnapshotHistoryRow.user_id == user.id,
                m.AccountSnapshotHistoryRow.account_id.in_(account_ids),
                m.AccountSnapshotHistoryRow.synced_at >= cutoff,
            )
            .order_by(m.AccountSnapshotHistoryRow.synced_at.asc())
            .all()
        )
        for snap in history_rows:
            per_account.setdefault(snap.account_id, []).append(
                BalancePoint(t=_as_utc_iso(snap.synced_at), v=snap.bal)
            )

        latest: dict[str, m.AccountSnapshotHistoryRow] = {}
        cursor = 0
        for total_row in total_rows:
            while cursor < len(history_rows) and history_rows[cursor].synced_at <= total_row.t:
                latest[history_rows[cursor].account_id] = history_rows[cursor]
                cursor += 1

            iso = _as_utc_iso(total_row.t)
            group_values: dict[str, float] = {}
            asset_values: dict[str, float] = {}

            for account_id, snap in latest.items():
                account = account_by_id.get(account_id)
                if account is None:
                    continue

                _append_point(by_wallet, account.name, iso, float(snap.bal or 0))

                group_name = _display_group(account.group_name)
                group_values[group_name] = group_values.get(group_name, 0.0) + float(snap.bal or 0)

                excluded = set(effective_excluded_keys(db, account))
                for holding in snap.holdings or []:
                    if not isinstance(holding, dict):
                        continue
                    if excluded and holding_key(holding) in excluded:
                        continue
                    label = _asset_label(holding)
                    if label is None:
                        continue
                    usd = float(holding.get("usd", 0) or 0)
                    if usd <= 0:
                        continue
                    asset_values[label] = asset_values.get(label, 0.0) + usd

            for key, value in group_values.items():
                _append_point(by_group, key, iso, value)
            for key, value in asset_values.items():
                _append_point(by_asset, key, iso, value)

    return BalanceHistory(
        total=total,
        by_source={},
        per_account=per_account,
        by_wallet=by_wallet,
        by_group=by_group,
        by_asset=by_asset,
    )
