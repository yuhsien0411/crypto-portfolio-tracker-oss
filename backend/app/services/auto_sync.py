"""Daily per-user auto-sync scheduling.

The schedule is stored in local user time plus a timezone value. New UI saves
fixed UTC offsets like ``UTC+02:00``; older IANA values such as
``Europe/Paris`` are still accepted so existing rows keep working.
"""
from __future__ import annotations

import re
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from .. import db_models as m


DEFAULT_TIMEZONE = "UTC"
DEFAULT_LOCAL_TIME = "09:00"
_UTC_OFFSET_RE = re.compile(r"^UTC(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$", re.I)


class InvalidSchedule(ValueError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_aware_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_utc_offset(name: str) -> tuple[str, timezone] | None:
    raw = (name or "").strip().replace(" ", "")
    match = _UTC_OFFSET_RE.fullmatch(raw)
    if not match:
        return None
    sign_s, hour_s, minute_s = match.groups()
    if not sign_s:
        return ("UTC", timezone.utc)
    hours = int(hour_s)
    minutes = int(minute_s or "0")
    if hours > 14 or minutes > 59:
        raise InvalidSchedule("UTC offset must be between UTC-12:00 and UTC+14:00")
    if sign_s == "-" and hours > 12:
        raise InvalidSchedule("UTC offset must be between UTC-12:00 and UTC+14:00")
    if hours == 14 and minutes != 0:
        raise InvalidSchedule("UTC offset must be between UTC-12:00 and UTC+14:00")
    total = hours * 60 + minutes
    if sign_s == "-":
        total = -total
    normalized = _format_utc_offset(total)
    return (normalized, timezone(timedelta(minutes=total)))


def _format_utc_offset(total_minutes: int) -> str:
    if total_minutes == 0:
        return "UTC"
    sign = "+" if total_minutes > 0 else "-"
    total = abs(total_minutes)
    return f"UTC{sign}{total // 60:02d}:{total % 60:02d}"


def validate_timezone(name: str) -> str:
    tz = (name or "").strip()
    if not tz:
        raise InvalidSchedule("timezone is required")
    offset = _parse_utc_offset(tz)
    if offset is not None:
        return offset[0]
    try:
        ZoneInfo(tz)
    except ZoneInfoNotFoundError as exc:
        raise InvalidSchedule("unknown timezone") from exc
    return tz


def _timezone_for(name: str) -> timezone | ZoneInfo:
    offset = _parse_utc_offset(name)
    if offset is not None:
        return offset[1]
    return ZoneInfo(name)


def parse_local_time(value: str) -> time:
    raw = (value or "").strip()
    try:
        hour_s, minute_s = raw.split(":", 1)
        hour = int(hour_s)
        minute = int(minute_s)
    except (TypeError, ValueError) as exc:
        raise InvalidSchedule("time must use HH:MM format") from exc
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise InvalidSchedule("time must be between 00:00 and 23:59")
    return time(hour=hour, minute=minute)


def compute_next_run_at(
    timezone_name: str,
    local_time: str,
    *,
    now_utc: datetime | None = None,
) -> datetime:
    tz_name = validate_timezone(timezone_name)
    run_time = parse_local_time(local_time)
    now = now_utc or utc_now()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)

    tz = _timezone_for(tz_name)
    local_now = now.astimezone(tz)
    candidate = datetime.combine(local_now.date(), run_time, tzinfo=tz)
    if candidate <= local_now:
        candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc).replace(tzinfo=None)


def settings_to_model(row: m.UserAutoSyncRow | None) -> dict:
    if row is None:
        return {
            "enabled": False,
            "timezone": DEFAULT_TIMEZONE,
            "local_time": DEFAULT_LOCAL_TIME,
            "next_run_at": None,
            "last_run_at": None,
            "last_status": "",
            "last_error": None,
        }
    return {
        "enabled": row.enabled,
        "timezone": row.timezone,
        "local_time": row.local_time,
        "next_run_at": _as_aware_utc(row.next_run_at),
        "last_run_at": _as_aware_utc(row.last_run_at),
        "last_status": row.last_status,
        "last_error": row.last_error,
    }


def upsert_settings(
    db: Session,
    user_id: str,
    *,
    enabled: bool,
    timezone_name: str,
    local_time: str,
) -> m.UserAutoSyncRow:
    tz_name = validate_timezone(timezone_name)
    parsed = parse_local_time(local_time)
    normalized_time = f"{parsed.hour:02d}:{parsed.minute:02d}"
    row = db.get(m.UserAutoSyncRow, user_id)
    if row is None:
        row = m.UserAutoSyncRow(user_id=user_id)
        db.add(row)
    row.enabled = enabled
    row.timezone = tz_name
    row.local_time = normalized_time
    row.next_run_at = (
        compute_next_run_at(tz_name, normalized_time) if enabled else None
    )
    row.locked_at = None
    row.last_error = None
    db.commit()
    db.refresh(row)
    return row
