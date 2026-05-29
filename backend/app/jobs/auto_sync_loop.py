"""Fly worker entrypoint for daily auto-sync.

Run with:
    python -m app.jobs.auto_sync_loop
"""
from __future__ import annotations

import logging
import os
import signal
import time
from datetime import timedelta

from dotenv import find_dotenv, load_dotenv
from sqlalchemy import or_

load_dotenv(find_dotenv(usecwd=True))

from ..crypto import assert_key_loaded
from ..db import SessionLocal, init_db
from .. import db_models as m
from ..services import auto_sync as auto_sync_service
from ..services import sync as sync_service


POLL_SECONDS = int(os.getenv("AUTO_SYNC_POLL_SECONDS", "60"))
LOCK_TIMEOUT_SECONDS = int(os.getenv("AUTO_SYNC_LOCK_TIMEOUT_SECONDS", "1800"))
BATCH_SIZE = int(os.getenv("AUTO_SYNC_BATCH_SIZE", "10"))

log = logging.getLogger("auto_sync")
_running = True


def _stop(_signum: int, _frame: object) -> None:
    global _running
    _running = False


def _summarize(results: list) -> str:
    ok = sum(1 for r in results if r.status == "ok")
    skipped = sum(1 for r in results if r.status == "skipped")
    errors = sum(1 for r in results if r.status == "error")
    return f"ok={ok} skipped={skipped} error={errors}"


def _claim_due(limit: int) -> list[str]:
    now = auto_sync_service.utc_now()
    stale_before = now - timedelta(seconds=LOCK_TIMEOUT_SECONDS)
    with SessionLocal() as db:
        candidates = (
            db.query(m.UserAutoSyncRow.user_id)
            .filter(
                m.UserAutoSyncRow.enabled.is_(True),
                m.UserAutoSyncRow.next_run_at.is_not(None),
                m.UserAutoSyncRow.next_run_at <= now,
                or_(
                    m.UserAutoSyncRow.locked_at.is_(None),
                    m.UserAutoSyncRow.locked_at < stale_before,
                ),
            )
            .order_by(m.UserAutoSyncRow.next_run_at.asc())
            .limit(limit)
            .all()
        )
        user_ids: list[str] = []
        for (user_id,) in candidates:
            claimed = (
                db.query(m.UserAutoSyncRow)
                .filter(
                    m.UserAutoSyncRow.user_id == user_id,
                    m.UserAutoSyncRow.enabled.is_(True),
                    m.UserAutoSyncRow.next_run_at.is_not(None),
                    m.UserAutoSyncRow.next_run_at <= now,
                    or_(
                        m.UserAutoSyncRow.locked_at.is_(None),
                        m.UserAutoSyncRow.locked_at < stale_before,
                    ),
                )
                .update({"locked_at": now}, synchronize_session=False)
            )
            if claimed:
                user_ids.append(user_id)
        db.commit()
        return user_ids


def _run_user(user_id: str) -> None:
    with SessionLocal() as db:
        setting = db.get(m.UserAutoSyncRow, user_id)
        user = db.get(m.UserRow, user_id)
        if setting is None or user is None:
            return
        if not setting.enabled:
            setting.locked_at = None
            setting.next_run_at = None
            db.commit()
            return
        try:
            results = sync_service.sync_user_accounts(db, user_id)
            setting = db.get(m.UserAutoSyncRow, user_id)
            if setting is None:
                return
            now = auto_sync_service.utc_now()
            setting.last_run_at = now
            setting.last_status = _summarize(results)
            errors = [r.message for r in results if r.status == "error" and r.message]
            setting.last_error = "; ".join(errors[:3]) if errors else None
            setting.next_run_at = (
                auto_sync_service.compute_next_run_at(
                    setting.timezone,
                    setting.local_time,
                    now_utc=now,
                )
                if setting.enabled
                else None
            )
            setting.locked_at = None
            db.commit()
            log.info("auto-sync complete for user=%s status=%s", user_id, setting.last_status)
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            setting = db.get(m.UserAutoSyncRow, user_id)
            if setting is None:
                return
            now = auto_sync_service.utc_now()
            setting.last_run_at = now
            setting.last_status = "error"
            setting.last_error = str(exc)[:1000]
            setting.next_run_at = (
                auto_sync_service.compute_next_run_at(
                    setting.timezone,
                    setting.local_time,
                    now_utc=now,
                )
                if setting.enabled
                else None
            )
            setting.locked_at = None
            db.commit()
            log.exception("auto-sync failed for user=%s", user_id)


def run_once() -> int:
    user_ids = _claim_due(BATCH_SIZE)
    for user_id in user_ids:
        _run_user(user_id)
    return len(user_ids)


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    assert_key_loaded()
    init_db()
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log.info("auto-sync worker started poll_seconds=%s", POLL_SECONDS)
    while _running:
        count = run_once()
        if count:
            log.info("processed %s due auto-sync schedule(s)", count)
        slept = 0
        while _running and slept < POLL_SECONDS:
            time.sleep(min(1, POLL_SECONDS - slept))
            slept += 1
    log.info("auto-sync worker stopped")


if __name__ == "__main__":
    main()
