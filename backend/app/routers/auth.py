"""Signup, login, logout, me, delete-account.

Local multi-user auth: opaque session cookies, scrypt-hashed passwords. No
email is involved — signup creates the account and logs the user straight in.
A forgotten password is an operator concern (reset the row in the DB)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from .. import db_models as m
from ..auth import (
    clear_session_cookie,
    create_session,
    current_user,
    destroy_session,
    hash_password,
    set_session_cookie,
    verify_password,
)
from ..db import get_db
from ..models import LoginRequest, SignupRequest, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_out(u: m.UserRow) -> UserOut:
    return UserOut(id=u.id, email=u.email, created_at=u.created_at)


@router.post("/signup", response_model=UserOut, status_code=201)
def signup(
    body: SignupRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> UserOut:
    """Create the user row and sign them in immediately (sets the session
    cookie). Unlike the hosted version there's no email-confirmation step."""
    email = body.email.strip().lower()
    existing = db.query(m.UserRow).filter(m.UserRow.email == email).first()
    if existing is not None:
        raise HTTPException(status_code=409, detail="Email already registered")

    user = m.UserRow(
        id=f"usr_{uuid.uuid4().hex[:12]}",
        email=email,
        password_hash=hash_password(body.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    session_token = create_session(db, user.id)
    set_session_cookie(response, session_token)
    return _user_out(user)


@router.post("/login", response_model=UserOut)
def login(
    body: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> UserOut:
    email = body.email.strip().lower()
    user = db.query(m.UserRow).filter(m.UserRow.email == email).first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    session_token = create_session(db, user.id)
    set_session_cookie(response, session_token)
    return _user_out(user)


@router.post("/logout", status_code=204)
def logout(
    response: Response,
    portfolio_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> None:
    # Decoupled from current_user — logout should still clear the cookie even
    # if the session happens to be invalid/expired.
    if portfolio_session:
        destroy_session(db, portfolio_session)
    clear_session_cookie(response)


@router.get("/me", response_model=UserOut)
def me(user: m.UserRow = Depends(current_user)) -> UserOut:
    return _user_out(user)


@router.delete("/me", status_code=204)
def delete_me(
    response: Response,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    """Wipe the authenticated user and every row that belongs to them.

    Accounts, snapshots, credentials, groups, sessions and total history all
    cascade via the ``ondelete="CASCADE"`` foreign keys on their rows."""
    db.delete(user)
    db.commit()
    clear_session_cookie(response)
