"""SQLAlchemy ORM models."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from . import crypto
from .db import Base


class EncryptedString(TypeDecorator):
    """Transparent at-rest encryption for sensitive string columns.

    Writes go through ``crypto.encrypt`` (tagged with an ``enc:v1:`` prefix);
    reads go through ``crypto.decrypt``. Legacy plaintext rows are read back
    verbatim — see ``db.py::_migrate_encrypt_credentials`` for the one-shot
    that rewrites them on boot."""

    impl = String
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        return crypto.encrypt(str(value))

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        return crypto.decrypt(str(value))


class UserRow(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class SessionRow(Base):
    __tablename__ = "sessions"

    token: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class AccountRow(Base):
    __tablename__ = "accounts"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_accounts_user_name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)  # onchain|exchange|custom
    addr: Mapped[str] = mapped_column(String, nullable=False, default="")
    group_name: Mapped[str] = mapped_column(String, nullable=False, default="common")
    bal: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    d: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    chain: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    pnl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    note: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    # Per-account list of holding keys (see services.sync.holding_key) the
    # user has chosen to exclude from balance math. Excluded rows are still
    # rendered — just greyed out — so they never silently disappear.
    excluded_keys: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    # User-typed assets layered onto whatever the account's sync produces.
    # Stored as a list of {symbol, amount, unit_price, name?, price_source}
    # dicts. ``services.sync._persist_snapshot`` renders these into the
    # snapshot's holdings on every save so they survive remote syncs.
    # Originally only "custom" source accounts had assets like this, but we
    # now allow them on any source.
    custom_assets: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    snapshot: Mapped[Optional["AccountSnapshotRow"]] = relationship(
        back_populates="account", uselist=False, cascade="all, delete-orphan"
    )
    cex_credential: Mapped[Optional["CexCredentialRow"]] = relationship(
        back_populates="account", uselist=False, cascade="all, delete-orphan"
    )


class GroupRow(Base):
    __tablename__ = "groups"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_groups_user_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    color: Mapped[str] = mapped_column(String, nullable=False, default="#8a8376")


class CexCredentialRow(Base):
    __tablename__ = "cex_credentials"

    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    # exchange (bitget/okx/…) and wallet_address (public) are not secrets.
    exchange: Mapped[str] = mapped_column(String, nullable=False, default="")
    wallet_address: Mapped[str] = mapped_column(String, nullable=False, default="")
    # Encrypted at rest — see EncryptedString / crypto.py. The ORM hides the
    # ``enc:v1:`` wrapping, so the rest of the app reads and writes plaintext.
    api_key: Mapped[str] = mapped_column(EncryptedString, nullable=False, default="")
    api_secret: Mapped[str] = mapped_column(EncryptedString, nullable=False, default="")
    passphrase: Mapped[str] = mapped_column(EncryptedString, nullable=False, default="")
    private_key: Mapped[str] = mapped_column(EncryptedString, nullable=False, default="")

    account: Mapped["AccountRow"] = relationship(back_populates="cex_credential")


class AccountSnapshotRow(Base):
    __tablename__ = "account_snapshots"

    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    bal: Mapped[float] = mapped_column(Float, nullable=False)
    d: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    synced_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    provider: Mapped[str] = mapped_column(String, nullable=False, default="")
    holdings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    account: Mapped["AccountRow"] = relationship(back_populates="snapshot")


class TotalSnapshotRow(Base):
    __tablename__ = "total_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    t: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    v: Mapped[float] = mapped_column(Float, nullable=False)


class AccountSnapshotHistoryRow(Base):
    __tablename__ = "account_snapshot_history"
    __table_args__ = (
        Index("ix_account_snapshot_history_account_synced", "account_id", "synced_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    account_id: Mapped[str] = mapped_column(
        String, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    bal: Mapped[float] = mapped_column(Float, nullable=False)
    d: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    synced_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String, nullable=False, default="")
    holdings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)


class UserAutoSyncRow(Base):
    __tablename__ = "user_auto_sync"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    timezone: Mapped[str] = mapped_column(String, nullable=False, default="UTC")
    local_time: Mapped[str] = mapped_column(String, nullable=False, default="09:00")
    next_run_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True, index=True
    )
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[str] = mapped_column(String, nullable=False, default="")
    last_error: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    locked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )
