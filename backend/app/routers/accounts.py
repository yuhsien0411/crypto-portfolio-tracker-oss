"""Account CRUD + detail endpoints (per-user)."""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import db_models as m
from ..auth import current_user
from ..db import get_db
from ..models import Account, AccountCreate, AccountDetail, AccountUpdate
from ..services import sync as sync_service
from ..services.mappers import account_to_detail, account_to_model

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


def _get_owned(db: Session, user_id: str, account_id: str) -> m.AccountRow:
    row = db.get(m.AccountRow, account_id)
    if row is None or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="Account not found")
    return row


UNASSIGNED = "unassigned"


def _ensure_name_available(
    db: Session, user_id: str, name: str, *, exclude_id: Optional[str] = None
) -> None:
    q = db.query(m.AccountRow.id).filter(
        m.AccountRow.user_id == user_id, m.AccountRow.name == name
    )
    if exclude_id is not None:
        q = q.filter(m.AccountRow.id != exclude_id)
    if q.first() is not None:
        raise HTTPException(
            status_code=409,
            detail=f"You already have an account named '{name}'.",
        )


def _resolve_group(db: Session, user_id: str, name: str) -> str:
    """Normalize the account's group. Empty/whitespace (or the literal
    'unassigned') means the account has no group — stored as
    `UNASSIGNED`. Any other value must match one of the user's groups."""
    key = (name or "").strip().lower()
    if not key or key == UNASSIGNED:
        return UNASSIGNED
    exists = (
        db.query(m.GroupRow)
        .filter(m.GroupRow.user_id == user_id, m.GroupRow.name == key)
        .first()
    )
    if exists is None:
        raise HTTPException(
            status_code=400,
            detail=f"Group '{name}' does not exist — create it first.",
        )
    return key


@router.get("", response_model=list[Account])
def list_accounts(
    source: Optional[str] = None,
    group: Optional[str] = None,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[Account]:
    q = db.query(m.AccountRow).filter(m.AccountRow.user_id == user.id)
    if source:
        q = q.filter(m.AccountRow.source == source)
    if group:
        q = q.filter(m.AccountRow.group_name == group)
    return [account_to_model(r) for r in q.all()]


@router.get("/{account_id}", response_model=AccountDetail)
def get_account(
    account_id: str,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> AccountDetail:
    row = _get_owned(db, user.id, account_id)
    excluded_keys = sync_service.effective_excluded_keys(db, row)
    return account_to_detail(row, excluded_keys=excluded_keys)


@router.post("", response_model=Account, status_code=201)
def create_account(
    body: AccountCreate,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> Account:
    _ensure_name_available(db, user.id, body.name)
    group_name = _resolve_group(db, user.id, body.group)
    row = m.AccountRow(
        id=f"acc_{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        name=body.name,
        source=body.source,
        addr=body.addr,
        group_name=group_name,
        chain=body.chain,
        note=body.note,
    )
    db.add(row)
    db.flush()
    if body.custom_assets is not None:
        sync_service.apply_custom_assets(
            db, row, [a.model_dump() for a in body.custom_assets]
        )
    db.commit()
    db.refresh(row)
    return account_to_model(row)


_SYNC_RELEVANT_FIELDS = ("source", "addr", "chain")


@router.patch("/{account_id}", response_model=Account)
def update_account(
    account_id: str,
    body: AccountUpdate,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> Account:
    row = _get_owned(db, user.id, account_id)
    patch = body.model_dump(exclude_unset=True)
    custom_assets = patch.pop("custom_assets", None)
    excluded_keys = patch.pop("excluded_keys", None)
    needs_validation = any(
        f in patch and patch[f] != getattr(row, f)
        for f in _SYNC_RELEVANT_FIELDS
    )
    if "name" in patch and patch["name"] != row.name:
        _ensure_name_available(db, user.id, patch["name"], exclude_id=row.id)
    if "group" in patch:
        row.group_name = _resolve_group(db, user.id, patch.pop("group"))
    for k, v in patch.items():
        setattr(row, k, v)
    if needs_validation:
        try:
            sync_service.validate_account(db, row)
        except sync_service.ValidationFailed as exc:
            db.rollback()
            raise HTTPException(
                status_code=400,
                detail=f"Can't load data with the new settings: {exc}",
            )
    if custom_assets is not None:
        sync_service.apply_custom_assets(db, row, custom_assets)
    if excluded_keys is not None:
        if row.source == "onchain":
            sync_service.apply_shared_onchain_excluded_keys(
                db,
                user.id,
                excluded_keys,
            )
        else:
            row.excluded_keys = sync_service.normalize_excluded_keys(excluded_keys)
            sync_service.recompute_balance_from_snapshot(db, row)
    db.commit()
    db.refresh(row)
    return account_to_model(row)


@router.delete("/{account_id}", status_code=204)
def delete_account(
    account_id: str,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    row = _get_owned(db, user.id, account_id)
    db.delete(row)
    db.commit()
