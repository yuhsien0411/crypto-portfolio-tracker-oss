"""Pydantic request/response models."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field

SourceType = Literal["onchain", "exchange", "custom"]


# ── Auth ─────────────────────────────────────────────────────────────────

class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=256)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    id: str
    email: str
    created_at: datetime


# ── Accounts ─────────────────────────────────────────────────────────────

class Account(BaseModel):
    id: str
    name: str
    source: SourceType
    addr: str
    group: str
    bal: float = 0.0
    d: float = 0.0
    chain: Optional[str] = None
    pnl: Optional[float] = None
    note: Optional[str] = None


PriceSource = Literal["custom", "api"]


class CustomAsset(BaseModel):
    """User-entered holding for a `custom` account. `amount` × `unit_price`
    contributes to the account balance. `price_source="api"` means the server
    keeps ``unit_price`` in sync with CoinMarketCap on each account sync; the
    client-supplied ``unit_price`` on an "api" asset is only used as a fallback
    if the live lookup fails."""
    symbol: str = Field(min_length=1, max_length=16, pattern=r"^[A-Za-z0-9._-]+$")
    amount: float = Field(default=0.0, ge=0.0, le=1e30, allow_inf_nan=False)
    unit_price: float = Field(default=0.0, ge=0.0, le=1e18, allow_inf_nan=False)
    name: Optional[str] = Field(default=None, max_length=80)
    price_source: PriceSource = "custom"


class AccountCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    source: SourceType
    addr: str = Field(default="", max_length=256)
    group: str = Field(default="", max_length=64)
    chain: Optional[str] = Field(default=None, max_length=32)
    note: Optional[str] = Field(default=None, max_length=1000)
    custom_assets: Optional[list[CustomAsset]] = Field(default=None, max_length=100)


class AccountUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    source: Optional[SourceType] = None
    addr: Optional[str] = Field(default=None, max_length=256)
    group: Optional[str] = Field(default=None, max_length=64)
    chain: Optional[str] = Field(default=None, max_length=32)
    note: Optional[str] = Field(default=None, max_length=1000)
    custom_assets: Optional[list[CustomAsset]] = Field(default=None, max_length=100)
    # When provided, replaces the account's holding-exclusion list. Each
    # entry is a key produced by ``services.sync.holding_key`` — opaque to
    # the client; clients echo back the values they received in
    # AccountDetail.excluded_keys.
    excluded_keys: Optional[list[str]] = Field(default=None, max_length=500)


class Holding(BaseModel):
    kind: Literal["tok", "pos"]
    sym: str
    name: str
    proto: str
    chain: str
    amt: str
    price: str
    usd: float
    d: float
    c: str
    apr: Optional[str] = None
    # Icon URLs supplied by upstream providers. `logo` is the token or protocol
    # logo shown at the asset level; `proto_logo` is the app logo for positions.
    logo: Optional[str] = None
    proto_logo: Optional[str] = None
    # Unformatted numbers — set only for `custom` source holdings so the
    # "Add assets" UI can round-trip the user's original inputs without
    # parsing the formatted `amt` / `price` strings.
    amt_raw: Optional[float] = None
    price_raw: Optional[float] = None
    # Only present on custom-source holdings. "api" means the server refreshes
    # this row's price from CoinMarketCap on every sync.
    price_source: Optional[PriceSource] = None
    # True when this row's USD has been excluded from the account/total
    # balance by the user. The row is still rendered — the UI greys it out.
    excluded: bool = False
    # Stable per-account identifier matching one entry of
    # AccountDetail.excluded_keys. Clients send this back unchanged when
    # toggling exclusion state.
    key: Optional[str] = None


class AccountDetail(Account):
    holdings: list[Holding] = []
    synced_at: Optional[datetime] = None
    provider: Optional[str] = None
    excluded_keys: list[str] = []


# ── Groups ───────────────────────────────────────────────────────────────

class Group(BaseModel):
    name: str
    bal: float
    d: float
    accounts: int
    color: str


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    color: str = Field(default="#8a8376", pattern=r"^#[0-9A-Fa-f]{6}$")


class GroupUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=64)
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


# ── Dashboard / Balance / Cashflow ───────────────────────────────────────

class TopAsset(BaseModel):
    sym: str
    name: str
    bal: float
    pct: float
    chains: int
    chg: float


class DashboardSummary(BaseModel):
    total: float
    change_24h_usd: float
    change_24h_pct: float
    change_7d_pct: float
    change_30d_pct: float
    change_ytd_pct: float
    change_1h_pct: float
    accounts_count: int
    sources_breakdown: dict[str, int]
    last_sync_at: Optional[datetime] = None


class BalancePoint(BaseModel):
    t: str
    v: float


class BalanceHistory(BaseModel):
    total: list[BalancePoint]
    by_source: dict[str, list[BalancePoint]]
    per_account: dict[str, list[BalancePoint]]
    by_wallet: dict[str, list[BalancePoint]]
    by_group: dict[str, list[BalancePoint]]
    by_asset: dict[str, list[BalancePoint]]


class CashflowSummary(BaseModel):
    inflows_30d: float
    outflows_30d: float
    net_30d: float
    pending: int


# ── Credentials (CEX only — global keys come from env) ───────────────────

class CexCredentialIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    exchange: str = Field(default="", max_length=32, pattern=r"^[A-Za-z0-9_-]*$")
    api_key: str = Field(default="", max_length=4096)
    api_secret: str = Field(default="", max_length=4096)
    passphrase: str = Field(default="", max_length=4096)
    wallet_address: str = Field(default="", max_length=256)


class CexCredentialOut(BaseModel):
    account_id: str
    account_name: str
    exchange: str
    has_api_key: bool
    has_api_secret: bool
    has_passphrase: bool
    has_wallet_address: bool
    has_private_key: bool


class CredentialsStatus(BaseModel):
    cex: list[CexCredentialOut]


# ── Sync ─────────────────────────────────────────────────────────────────

SyncStatus = Literal["ok", "skipped", "error"]


class SyncResult(BaseModel):
    account_id: str
    name: str
    source: SourceType
    status: SyncStatus
    balance: Optional[float] = None
    message: Optional[str] = None


class SyncSummary(BaseModel):
    results: list[SyncResult]
    total: float
    ok_count: int
    skipped_count: int
    error_count: int


class SyncEstimate(BaseModel):
    accounts_count: int
    remote_accounts: int


# ── Auto sync ────────────────────────────────────────────────────────────

class AutoSyncSettings(BaseModel):
    enabled: bool
    timezone: str
    local_time: str
    next_run_at: Optional[datetime] = None
    last_run_at: Optional[datetime] = None
    last_status: str = ""
    last_error: Optional[str] = None


class AutoSyncSettingsUpdate(BaseModel):
    enabled: bool
    timezone: str = Field(min_length=1, max_length=64)
    local_time: str = Field(pattern=r"^\d{2}:\d{2}$")
