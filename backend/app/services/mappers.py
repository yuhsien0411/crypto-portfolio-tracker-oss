"""Adapters between SQLAlchemy rows and Pydantic response models."""
from __future__ import annotations

from .. import db_models as m
from ..models import Account, AccountDetail, Holding
from .sync import holding_key


def account_to_model(row: m.AccountRow) -> Account:
    return Account(
        id=row.id,
        name=row.name,
        source=row.source,  # type: ignore[arg-type]
        addr=row.addr,
        group=row.group_name,
        bal=row.bal,
        d=row.d,
        chain=row.chain,
        pnl=row.pnl,
        note=row.note,
    )


def account_to_detail(
    row: m.AccountRow,
    excluded_keys: list[str] | None = None,
) -> AccountDetail:
    holdings: list[Holding] = []
    synced_at = None
    provider = None
    effective_excluded_keys = (
        excluded_keys if excluded_keys is not None else row.excluded_keys or []
    )
    excluded_set = set(effective_excluded_keys)
    if row.snapshot is not None:
        raw_holdings = row.snapshot.holdings or []
        for h in raw_holdings:
            key = holding_key(h)
            holdings.append(
                Holding(**h, excluded=key in excluded_set, key=key)
            )
        synced_at = row.snapshot.synced_at
        provider = row.snapshot.provider
    base = account_to_model(row)
    return AccountDetail(
        **base.model_dump(),
        holdings=holdings,
        synced_at=synced_at,
        provider=provider,
        excluded_keys=list(effective_excluded_keys),
    )
