"""Authentication helpers.

- Password hashing uses stdlib `hashlib.scrypt` (memory-hard, no extra deps).
- Sessions are opaque random tokens stored in the `sessions` table and set as
  HttpOnly cookies on the client. Every authenticated endpoint uses the
  `current_user` FastAPI dependency.
"""
from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from . import db_models as m
from .db import get_db

SESSION_COOKIE = "portfolio_session"
SESSION_TTL_DAYS = 30


def _cookie_secure() -> bool:
    """Should the session cookie be marked Secure?

    Default is True (production-safe — cookies only travel over HTTPS). Set
    ``SESSION_COOKIE_SECURE=false`` (or ``0``/``no``) in ``.env`` for local
    dev where the app is served over plain HTTP. Any other value, including
    unset, defaults to secure — fail closed, not open."""
    raw = os.getenv("SESSION_COOKIE_SECURE")
    if raw is None:
        return True
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


# scrypt parameters — tuned for reasonable hashing cost (~50–100 ms) while
# staying well within stdlib limits.
_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_DKLEN = 64


# ── Password hashing ─────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_DKLEN,
    )
    return f"scrypt${salt.hex()}${h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = stored.split("$", 2)
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except ValueError:
        return False
    candidate = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_DKLEN,
    )
    return secrets.compare_digest(candidate, expected)


# ── Session management ───────────────────────────────────────────────────

def _new_token() -> str:
    return secrets.token_urlsafe(32)


def _hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(db: Session, user_id: str) -> str:
    now = datetime.now(timezone.utc)
    raw_token = _new_token()
    row = m.SessionRow(
        # Store only a hash of the bearer token. A DB leak should not hand an
        # attacker immediately replayable session cookies.
        token=_hash_session_token(raw_token),
        user_id=user_id,
        created_at=now,
        expires_at=now + timedelta(days=SESSION_TTL_DAYS),
    )
    db.add(row)
    db.commit()
    return raw_token


def destroy_session(db: Session, token: str) -> None:
    row = db.get(m.SessionRow, _hash_session_token(token))
    if row is not None:
        db.delete(row)
        db.commit()


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_TTL_DAYS * 24 * 3600,
        httponly=True,
        # Strict so the cookie isn't sent on cross-site navigations — this app
        # holds exchange API keys and wallet private keys, so the small UX cost
        # (no auto-login when arriving from an external link) is worth the CSRF
        # protection.
        samesite="strict",
        # Secure-by-default. Flip to False in .env with SESSION_COOKIE_SECURE=false
        # only for local HTTP dev. See _cookie_secure().
        secure=_cookie_secure(),
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


# ── Dependencies ─────────────────────────────────────────────────────────

def current_user(
    portfolio_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> m.UserRow:
    if not portfolio_session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    session = db.get(m.SessionRow, _hash_session_token(portfolio_session))
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")
    now = datetime.now(timezone.utc)
    expires = session.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < now:
        db.delete(session)
        db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired")
    user = db.get(m.UserRow, session.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User no longer exists")
    return user
