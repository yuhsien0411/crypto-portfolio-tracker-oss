"""Auto-sync settings endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .. import db_models as m
from ..auth import current_user
from ..db import get_db
from ..models import AutoSyncSettings, AutoSyncSettingsUpdate
from ..services import auto_sync as auto_sync_service

router = APIRouter(prefix="/api/auto-sync", tags=["auto-sync"])


@router.get("/settings", response_model=AutoSyncSettings)
def get_settings(
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> AutoSyncSettings:
    row = db.get(m.UserAutoSyncRow, user.id)
    return AutoSyncSettings(**auto_sync_service.settings_to_model(row))


@router.put("/settings", response_model=AutoSyncSettings)
def update_settings(
    body: AutoSyncSettingsUpdate,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> AutoSyncSettings:
    try:
        row = auto_sync_service.upsert_settings(
            db,
            user.id,
            enabled=body.enabled,
            timezone_name=body.timezone,
            local_time=body.local_time,
        )
    except auto_sync_service.InvalidSchedule as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    return AutoSyncSettings(**auto_sync_service.settings_to_model(row))

