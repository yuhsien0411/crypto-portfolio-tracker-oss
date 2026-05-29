"""Credentials endpoints — CEX-only, per-user.

DeBank and CoinStats keys are set by the deployment (via `.env`) and are not
exposed to end-users.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import db_models as m
from ..auth import current_user
from ..db import get_db
from ..models import CexCredentialIn, CexCredentialOut, CredentialsStatus
from ..services import sync as sync_service

router = APIRouter(prefix="/api/credentials", tags=["credentials"])


def _own_account(db: Session, user_id: str, account_id: str) -> m.AccountRow:
    row = db.get(m.AccountRow, account_id)
    if row is None or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="Account not found")
    return row


def _cex_out(account: m.AccountRow, cred: m.CexCredentialRow | None) -> CexCredentialOut:
    return CexCredentialOut(
        account_id=account.id,
        account_name=account.name,
        exchange=cred.exchange if cred else "",
        has_api_key=bool(cred and cred.api_key),
        has_api_secret=bool(cred and cred.api_secret),
        has_passphrase=bool(cred and cred.passphrase),
        has_wallet_address=bool(cred and cred.wallet_address),
        # Public deployments must not collect wallet private keys. Kept in
        # the response shape for backward compatibility with older clients.
        has_private_key=False,
    )


@router.get("", response_model=CredentialsStatus)
def get_status(
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> CredentialsStatus:
    accounts = (
        db.query(m.AccountRow)
        .filter(
            m.AccountRow.user_id == user.id,
            m.AccountRow.source == "exchange",
        )
        .all()
    )
    account_ids = [a.id for a in accounts]
    cex_rows = {
        r.account_id: r
        for r in db.query(m.CexCredentialRow)
        .filter(m.CexCredentialRow.account_id.in_(account_ids))
        .all()
    }
    return CredentialsStatus(
        cex=[_cex_out(a, cex_rows.get(a.id)) for a in accounts],
    )


@router.put("/cex/{account_id}", response_model=CexCredentialOut)
def set_cex(
    account_id: str,
    body: CexCredentialIn,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> CexCredentialOut:
    """Merge-style: empty string on any field means "leave current value
    alone". To clear everything, use DELETE /api/credentials/cex/{id}.

    When any credential field actually changes, we do a dry-run fetch with
    the new values before committing — if it fails, nothing is saved."""
    account = _own_account(db, user.id, account_id)
    row = db.get(m.CexCredentialRow, account_id)
    creating = row is None
    if row is None:
        row = m.CexCredentialRow(account_id=account_id)
        db.add(row)
    changed = creating
    # Exchange is always updated when non-empty (common case: set on create).
    if body.exchange and body.exchange != row.exchange:
        row.exchange = body.exchange
        changed = True
    for field in ("api_key", "api_secret", "passphrase", "wallet_address"):
        value = getattr(body, field)
        if value and value != getattr(row, field):
            setattr(row, field, value)
            changed = True
    if changed and account.source == "exchange":
        try:
            sync_service.validate_account(db, account, pending_cred=row)
        except sync_service.ValidationFailed as exc:
            db.rollback()
            raise HTTPException(
                status_code=400,
                detail=f"Can't load data with the new credentials: {exc}",
            )
    db.commit()
    db.refresh(row)
    return _cex_out(account, row)


@router.delete("/cex/{account_id}", status_code=204)
def delete_cex(
    account_id: str,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    _own_account(db, user.id, account_id)  # ownership check
    row = db.get(m.CexCredentialRow, account_id)
    if row is None:
        return
    db.delete(row)
    db.commit()
