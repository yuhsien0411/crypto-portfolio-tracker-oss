"""FastAPI entry point — per-user auth + per-account sync."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Local dev: walk up from cwd looking for a `.env`. Docker injects these
# vars via compose's `env_file` so the call is a no-op there.
load_dotenv(find_dotenv(usecwd=True))

from .crypto import assert_key_loaded
from .db import init_db
from .routers import (
    accounts,
    auth,
    auto_sync,
    balance,
    cashflow,
    credentials,
    dashboard,
    groups,
    prices,
    sync,
)


def _enable_api_docs() -> bool:
    """Whether to expose ``/docs`` and ``/redoc``. Off by default in
    production — set ``ENABLE_API_DOCS=1`` to opt in (e.g. for staging)."""
    return os.getenv("ENABLE_API_DOCS", "").strip().lower() in {"1", "true", "yes", "on"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Fail fast: a missing SECRETS_KEY would otherwise only surface on the
    # first credential write/read. CEX API keys and wallet private keys are
    # encrypted at rest with this key — see crypto.py.
    assert_key_loaded()
    init_db()
    yield


_docs_enabled = _enable_api_docs()
app = FastAPI(
    title="Crypto Portfolio Tracker API",
    description="Crypto Portfolio Tracker backend — SQLite-backed, per-user auth.",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)

_origins = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173",
).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(accounts.router)
app.include_router(auto_sync.router)
app.include_router(groups.router)
app.include_router(credentials.router)
app.include_router(dashboard.router)
app.include_router(balance.router)
app.include_router(cashflow.router)
app.include_router(sync.router)
app.include_router(prices.router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "crypto-portfolio-tracker"}
