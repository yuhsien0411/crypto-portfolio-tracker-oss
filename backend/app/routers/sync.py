"""Sync endpoints — trigger live pulls for the current user's accounts."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .. import db_models as m
from .. import ratelimit
from ..auth import current_user
from ..db import get_db
from ..models import SyncEstimate, SyncResult, SyncSummary
from ..services import sync as sync_service

router = APIRouter(prefix="/api/sync", tags=["sync"])


def _enforce_sync_throttle(user_id: str) -> None:
    try:
        ratelimit.check_sync_allowed(user_id)
    except ratelimit.RateLimited as rl:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Syncing too quickly. Try again in {rl.retry_after_seconds} seconds.",
            headers={"Retry-After": str(rl.retry_after_seconds)},
        )


@router.get("/all/estimate", response_model=SyncEstimate)
def sync_all_estimate(
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> SyncEstimate:
    """Preflight cost breakdown for the sync-all confirmation dialog."""
    return SyncEstimate(**sync_service.estimate_user_sync(db, user.id))


@router.post("/all", response_model=SyncSummary)
def sync_all(
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> SyncSummary:
    if sync_service.user_uses_sync_throttle(db, user.id):
        _enforce_sync_throttle(user.id)
    results = sync_service.sync_user_accounts(db, user.id)
    total = sum(
        a.bal
        for a in db.query(m.AccountRow).filter(m.AccountRow.user_id == user.id).all()
    )
    return SyncSummary(
        results=results,
        total=round(total, 2),
        ok_count=sum(1 for r in results if r.status == "ok"),
        skipped_count=sum(1 for r in results if r.status == "skipped"),
        error_count=sum(1 for r in results if r.status == "error"),
    )


@router.post("/account/{account_id}", response_model=SyncResult)
def sync_one(
    account_id: str,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> SyncResult:
    account = db.get(m.AccountRow, account_id)
    if account is None or account.user_id != user.id:
        raise HTTPException(status_code=404, detail="Account not found")
    # Plain custom accounts are local-only. Custom accounts with
    # price_source="api" hit live price providers, so they share the sync throttle.
    # Skip the throttle for an account's first sync — the "create new account"
    # flow on the frontend immediately syncs the account it just created, and
    # we want users to be able to add several accounts back-to-back.
    needs_throttle = sync_service.account_uses_sync_throttle(db, account)
    if needs_throttle and account.snapshot is not None:
        _enforce_sync_throttle(user.id)
    result = sync_service.sync_account(db, account)
    # Record an aggregate snapshot so the balance-history chart and
    # `last_sync_at` advance even when the user syncs one account at a time
    # instead of using "Sync All".
    total = round(
        sum(
            a.bal
            for a in db.query(m.AccountRow).filter(m.AccountRow.user_id == user.id).all()
        ),
        2,
    )
    db.add(m.TotalSnapshotRow(user_id=user.id, t=datetime.now(timezone.utc), v=total))
    db.commit()
    return result
