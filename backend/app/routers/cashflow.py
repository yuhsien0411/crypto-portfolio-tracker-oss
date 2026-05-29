"""Cashflow endpoint (placeholder — persistence not implemented yet)."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import db_models as m
from ..auth import current_user
from ..models import CashflowSummary

router = APIRouter(prefix="/api/cashflow", tags=["cashflow"])


@router.get("", response_model=CashflowSummary)
def summary(_: m.UserRow = Depends(current_user)) -> CashflowSummary:
    return CashflowSummary(
        inflows_30d=0.0,
        outflows_30d=0.0,
        net_30d=0.0,
        pending=0,
    )
