"""Database engine + session factory.

SQLite by default — the file lives at `$PORTFOLIO_DB_PATH` or
`<project_root>/data/portfolio.db`. Swap `DATABASE_URL` (e.g.
`postgresql+psycopg://…`) to move to Postgres later.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine, event, func, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


_BACKEND_ROOT = Path(__file__).resolve().parents[1]
_PROJECT_ROOT = _BACKEND_ROOT.parent
_DEFAULT_DB_PATH = _PROJECT_ROOT / "data" / "portfolio.db"


def _normalize_database_url(url: str) -> str:
    """Use the installed psycopg v3 driver for plain Postgres URLs.

    Fly Managed Postgres attaches DATABASE_URL as ``postgresql://...``.
    SQLAlchemy maps that bare dialect to psycopg2, but this app depends on
    psycopg v3 (``psycopg[binary]``). Rewriting only the scheme preserves the
    credentials/host/query string while selecting the driver we ship.
    """
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


_url_env = os.getenv("DATABASE_URL")
if _url_env:
    # Set DATABASE_URL (e.g. postgresql+psycopg://…) to use Postgres instead.
    DATABASE_URL = _normalize_database_url(_url_env)
else:
    # Default: a local SQLite file. For Docker, mount a volume at the DB path
    # so data survives container rebuilds.
    db_path = Path(os.getenv("PORTFOLIO_DB_PATH", _DEFAULT_DB_PATH))
    db_path.parent.mkdir(parents=True, exist_ok=True)
    DATABASE_URL = f"sqlite:///{db_path}"

_engine_kwargs: dict = {}
if DATABASE_URL.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


# SQLite-specific connection setup:
#  - foreign_keys=ON so ``ondelete="CASCADE"`` actually fires on a single
#    ``DELETE users`` (SQLite ignores FK constraints unless the PRAGMA is
#    set per-connection). The "delete my data" flow depends on this.
#  - journal_mode=WAL so readers don't block writers and vice versa. With
#    the default rollback journal a single writer holds an exclusive lock
#    over the file, which serialises every endpoint that touches the DB
#    once we have more than one user. WAL is a one-time DB-level setting
#    but issuing the PRAGMA on every connect is cheap and idempotent.
#  - synchronous=NORMAL is the recommended pairing with WAL — durable
#    enough (commits are fsync'd at checkpoint) without paying FULL's
#    per-commit fsync.
if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _connection_record):  # type: ignore[misc]
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    # Import here so all models are registered on Base before create_all.
    from . import db_models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_source_values()
    # Must run BEFORE any code below that does ORM reads on `accounts` —
    # SQLAlchemy issues SELECT * style queries that include every mapped
    # column, so the new excluded_keys column has to exist first.
    _migrate_account_excluded_keys()
    _migrate_account_custom_assets()
    _backfill_account_snapshot_history()
    _migrate_encrypt_credentials()
    _migrate_account_name_unique()


# Source taxonomy was renamed from chain|cex|perp|manual → onchain|exchange|custom.
# Idempotent in-place rewrite — safe to run on every boot.
_SOURCE_RENAMES = {
    "chain": "onchain",
    "cex": "exchange",
    "perp": "exchange",
    "manual": "custom",
}


def _migrate_source_values() -> None:
    with engine.begin() as conn:
        for old, new in _SOURCE_RENAMES.items():
            conn.execute(
                text("UPDATE accounts SET source = :new WHERE source = :old"),
                {"new": new, "old": old},
            )


def _backfill_account_snapshot_history() -> None:
    from . import db_models as m

    with SessionLocal() as db:
        snaps = db.query(m.AccountSnapshotRow).all()
        changed = False
        for snap in snaps:
            account = db.get(m.AccountRow, snap.account_id)
            if account is None:
                continue
            exists = (
                db.query(m.AccountSnapshotHistoryRow.id)
                .filter(
                    m.AccountSnapshotHistoryRow.account_id == snap.account_id,
                    m.AccountSnapshotHistoryRow.synced_at == snap.synced_at,
                )
                .first()
            )
            if exists:
                continue
            db.add(
                m.AccountSnapshotHistoryRow(
                    user_id=account.user_id,
                    account_id=snap.account_id,
                    bal=snap.bal,
                    d=snap.d,
                    synced_at=snap.synced_at,
                    provider=snap.provider,
                    holdings=snap.holdings or [],
                )
            )
            changed = True
        if changed:
            db.commit()


# One-shot rewrite of any plaintext ``cex_credentials`` rows left over from
# before at-rest encryption landed. Idempotent: rows that already start with
# the ``enc:v1:`` prefix are skipped. Runs on every boot. Safe to keep
# running forever — costs one SELECT per boot once the table is fully
# encrypted, and that SELECT returns no "needs_update" rows.
_ENCRYPTED_CRED_FIELDS = ("api_key", "api_secret", "passphrase", "private_key")


def _migrate_encrypt_credentials() -> None:
    from .crypto import encrypt, is_encrypted

    with engine.begin() as conn:
        try:
            rows = conn.execute(
                text(
                    "SELECT account_id, api_key, api_secret, passphrase, "
                    "private_key FROM cex_credentials"
                )
            ).fetchall()
        except Exception:
            # Table not yet created (first boot) — nothing to migrate.
            return
        for row in rows:
            account_id = row[0]
            updates: dict[str, str] = {}
            for i, field in enumerate(_ENCRYPTED_CRED_FIELDS, start=1):
                raw = row[i] or ""
                if raw and not is_encrypted(raw):
                    updates[field] = encrypt(raw)
            if not updates:
                continue
            set_clause = ", ".join(f"{k} = :{k}" for k in updates)
            conn.execute(
                text(
                    f"UPDATE cex_credentials SET {set_clause} "
                    f"WHERE account_id = :account_id"
                ),
                {**updates, "account_id": account_id},
            )


# Account names are unique per user. ``create_all`` won't add the constraint
# to a pre-existing ``accounts`` table, so we (1) rename any existing
# duplicates in place — keeping the oldest row's name, suffixing the rest with
# " (2)", " (3)", … picking the next free suffix — then (2) install the
# unique index. Idempotent: once every (user_id, name) is unique the rename
# pass is a no-op and ``CREATE UNIQUE INDEX IF NOT EXISTS`` skips.
def _migrate_account_name_unique() -> None:
    from . import db_models as m

    with SessionLocal() as db:
        dupes = (
            db.query(m.AccountRow.user_id, m.AccountRow.name)
            .group_by(m.AccountRow.user_id, m.AccountRow.name)
            .having(func.count(m.AccountRow.id) > 1)
            .all()
        )
        for user_id, name in dupes:
            rows = (
                db.query(m.AccountRow)
                .filter(
                    m.AccountRow.user_id == user_id, m.AccountRow.name == name
                )
                .order_by(m.AccountRow.created_at.asc(), m.AccountRow.id.asc())
                .all()
            )
            taken = {
                n for (n,) in db.query(m.AccountRow.name)
                .filter(m.AccountRow.user_id == user_id)
                .all()
            }
            for row in rows[1:]:
                taken.discard(row.name)
                i = 2
                while f"{name} ({i})" in taken:
                    i += 1
                row.name = f"{name} ({i})"
                taken.add(row.name)
        if dupes:
            db.commit()

    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_user_name "
                "ON accounts (user_id, name)"
            )
        )


# excluded_keys was added after the initial schema. Same idempotent
# ADD COLUMN pattern — defaults to an empty JSON array so existing accounts
# behave as if no holdings are excluded. Runs on both SQLite (dev) and
# Postgres (prod): Postgres tables created before this column shipped need
# the ALTER too, otherwise every ORM read of ``accounts`` will 500.
def _migrate_account_excluded_keys() -> None:
    if DATABASE_URL.startswith("sqlite"):
        with engine.begin() as conn:
            cols = {
                row[1]
                for row in conn.execute(text("PRAGMA table_info(accounts)")).fetchall()
            }
            if "excluded_keys" not in cols:
                conn.execute(
                    text("ALTER TABLE accounts ADD COLUMN excluded_keys JSON NOT NULL DEFAULT '[]'")
                )
    else:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS "
                    "excluded_keys JSON NOT NULL DEFAULT '[]'"
                )
            )


# custom_assets stores user-typed holdings layered onto whatever a sync
# produces — see AccountRow.custom_assets for the shape. Custom-source
# accounts used to keep these inside snapshot.holdings only; this migration
# materialises them onto the account row so every source can carry them and
# they survive remote syncs. Idempotent: existing rows with a non-empty
# custom_assets list are left alone, so this re-runs as a no-op.
def _migrate_account_custom_assets() -> None:
    if DATABASE_URL.startswith("sqlite"):
        with engine.begin() as conn:
            cols = {
                row[1]
                for row in conn.execute(text("PRAGMA table_info(accounts)")).fetchall()
            }
            if "custom_assets" not in cols:
                conn.execute(
                    text("ALTER TABLE accounts ADD COLUMN custom_assets JSON NOT NULL DEFAULT '[]'")
                )
    else:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS "
                    "custom_assets JSON NOT NULL DEFAULT '[]'"
                )
            )

    # Backfill: legacy "custom" accounts kept user-typed assets only in
    # snapshot.holdings (rows with chain="custom"). Extract them onto the new
    # column so the unified code path works for them too.
    from . import db_models as m

    with SessionLocal() as db:
        legacy = (
            db.query(m.AccountRow)
            .filter(m.AccountRow.source == "custom")
            .all()
        )
        changed = False
        for account in legacy:
            if account.custom_assets:
                continue
            snap = db.get(m.AccountSnapshotRow, account.id)
            if snap is None or not snap.holdings:
                continue
            recovered: list[dict] = []
            for h in snap.holdings:
                if not isinstance(h, dict):
                    continue
                if h.get("chain") != "custom":
                    continue
                sym = str(h.get("sym") or "").strip().upper()
                if not sym:
                    continue
                amount = h.get("amt_raw")
                price = h.get("price_raw")
                try:
                    amount_f = float(amount) if amount is not None else 0.0
                    price_f = float(price) if price is not None else 0.0
                except (TypeError, ValueError):
                    amount_f, price_f = 0.0, 0.0
                price_source = str(h.get("price_source") or "custom").lower()
                if price_source not in ("custom", "api"):
                    price_source = "custom"
                recovered.append({
                    "symbol": sym,
                    "amount": amount_f,
                    "unit_price": price_f,
                    "name": str(h.get("name") or sym),
                    "price_source": price_source,
                })
            if recovered:
                account.custom_assets = recovered
                changed = True
        if changed:
            db.commit()


