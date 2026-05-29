"""Group CRUD (per-user). Balances/counts are computed from the user's accounts."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import db_models as m
from ..auth import current_user
from ..db import get_db
from ..models import Group, GroupCreate, GroupUpdate

router = APIRouter(prefix="/api/groups", tags=["groups"])

UNASSIGNED = "unassigned"
UNASSIGNED_COLOR = "#8a8376"


def _aggregate(db: Session, user_id: str) -> dict[str, tuple[float, float, int]]:
    agg: dict[str, tuple[float, float, int]] = {}
    for row in db.query(m.AccountRow).filter(m.AccountRow.user_id == user_id).all():
        key = row.group_name.lower()
        bal, wd, n = agg.get(key, (0.0, 0.0, 0))
        agg[key] = (bal + row.bal, wd + row.bal * row.d, n + 1)
    return agg


@router.get("", response_model=list[Group])
def list_groups(
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[Group]:
    agg = _aggregate(db, user.id)
    out: list[Group] = []
    for row in db.query(m.GroupRow).filter(m.GroupRow.user_id == user.id).all():
        bal, wd, n = agg.get(row.name.lower(), (0.0, 0.0, 0))
        d = round(wd / bal, 2) if bal > 0 else 0.0
        out.append(
            Group(
                name=row.name.capitalize(),
                bal=round(bal, 2),
                d=d,
                accounts=n,
                color=row.color,
            )
        )
    # Synthetic "Unassigned" bucket — shown whenever the user has any accounts
    # with no group. Not persisted as a real row, can't be deleted.
    ua_bal, ua_wd, ua_n = agg.get(UNASSIGNED, (0.0, 0.0, 0))
    if ua_n > 0:
        out.append(
            Group(
                name="Unassigned",
                bal=round(ua_bal, 2),
                d=round(ua_wd / ua_bal, 2) if ua_bal > 0 else 0.0,
                accounts=ua_n,
                color=UNASSIGNED_COLOR,
            )
        )
    return out


@router.post("", response_model=Group, status_code=201)
def create_group(
    body: GroupCreate,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> Group:
    key = body.name.strip().lower()
    if not key:
        raise HTTPException(status_code=400, detail="Group name required")
    if key == UNASSIGNED:
        raise HTTPException(
            status_code=400,
            detail="'Unassigned' is reserved — accounts without a group show there automatically.",
        )
    existing = (
        db.query(m.GroupRow)
        .filter(m.GroupRow.user_id == user.id, m.GroupRow.name == key)
        .first()
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="Group already exists")
    db.add(m.GroupRow(user_id=user.id, name=key, color=body.color))
    db.commit()
    return Group(name=body.name.capitalize(), bal=0, d=0, accounts=0, color=body.color)


@router.patch("/{name}", response_model=Group)
def update_group(
    name: str,
    body: GroupUpdate,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> Group:
    old_key = name.strip().lower()
    if old_key == UNASSIGNED:
        raise HTTPException(
            status_code=400,
            detail="'Unassigned' isn't a real group — nothing to edit.",
        )
    row = (
        db.query(m.GroupRow)
        .filter(m.GroupRow.user_id == user.id, m.GroupRow.name == old_key)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Group not found")

    new_key = old_key
    if body.name is not None:
        new_key = body.name.strip().lower()
        if not new_key:
            raise HTTPException(status_code=400, detail="Group name required")
        if new_key == UNASSIGNED:
            raise HTTPException(
                status_code=400,
                detail="'Unassigned' is reserved — accounts without a group show there automatically.",
            )
        if new_key != old_key:
            existing = (
                db.query(m.GroupRow)
                .filter(m.GroupRow.user_id == user.id, m.GroupRow.name == new_key)
                .first()
            )
            if existing is not None:
                raise HTTPException(status_code=409, detail="Group already exists")
            row.name = new_key
            # Accounts reference groups by name string, not FK — propagate the
            # rename to every account in this group so they stay attached.
            db.query(m.AccountRow).filter(
                m.AccountRow.user_id == user.id,
                m.AccountRow.group_name == old_key,
            ).update(
                {m.AccountRow.group_name: new_key}, synchronize_session=False
            )

    if body.color is not None:
        row.color = body.color

    db.commit()

    bal, wd, n = _aggregate(db, user.id).get(new_key, (0.0, 0.0, 0))
    d = round(wd / bal, 2) if bal > 0 else 0.0
    return Group(
        name=new_key.capitalize(),
        bal=round(bal, 2),
        d=d,
        accounts=n,
        color=row.color,
    )


@router.delete("/{name}", status_code=204)
def delete_group(
    name: str,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    row = (
        db.query(m.GroupRow)
        .filter(m.GroupRow.user_id == user.id, m.GroupRow.name == name.lower())
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Group not found")
    db.delete(row)
    db.commit()
