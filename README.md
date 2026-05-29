# Crypto Portfolio Tracker

Self-hosted dashboard for tracking your whole crypto portfolio in one place:
on-chain wallets, centralized exchange accounts, perp/DEX positions, and manual
("custom") entries. Group accounts, sync balances on demand or on a daily
schedule, and keep per-account history for charts.

This is the open-source, self-hostable edition — multi-user local accounts, no
hosted billing, no email provider required.

## Features

- **On-chain wallets** — EVM via [DeBank](https://cloud.debank.com/) (wallet
  tokens **plus** DeFi positions: lending, LPs, staking, perps); Solana / Sui /
  Cosmos via [CoinStats](https://openapi.coinstats.app/).
- **Exchanges & perp DEXs** — Binance · Bitget · OKX · Bybit · Gate ·
  Hyperliquid · Derive · Extended. Keys are entered in the UI and stored
  **encrypted at rest**.
- **Custom assets** — anything off-API (cold storage, OTC, vault shares), with
  optional live pricing from CoinMarketCap.
- **Groups, balance history, daily auto-sync**, and a per-asset/per-account
  breakdown.
- **Local multi-user auth** — signup/login with session cookies; passwords are
  scrypt-hashed. Sign up and you're in immediately (no email step).

## Stack

- **Backend** — Python 3.12, FastAPI, SQLAlchemy, SQLite (Postgres optional).
- **Frontend** — React 18 + TypeScript + Vite + React Router. English + 中文.
- **Deploy** — Docker Compose (backend Uvicorn on `:8000`, frontend Nginx on
  `:80` serving the SPA and proxying `/api/*`).

## Quick start (Docker Compose)

```bash
cp .env.example .env        # then fill in SECRETS_KEY + provider keys
docker compose up --build -d
```

App on http://localhost · API on http://localhost:8000.

At minimum set `SECRETS_KEY` (used to encrypt stored credentials). Generate one:

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Add `DEBANK_ACCESS_KEY` / `COINSTATS_API_KEY` / `COINMARKETCAP_API_KEY` for the
data sources you use. See [.env.example](.env.example) for everything else.

SQLite data is persisted to `./data` (mounted into the backend container).

## Local development

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SECRETS_KEY=$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())') \
SESSION_COOKIE_SECURE=false \
uvicorn app.main:app --reload          # http://localhost:8000
```

```bash
# Frontend
cd frontend
npm install
npm run dev                             # http://localhost:5173, proxies /api → :8000
```

Health check: `GET /api/health`. Set `ENABLE_API_DOCS=1` for `/docs`.

## How credentials work

- **Global provider keys** (`.env`): `DEBANK_ACCESS_KEY`, `COINSTATS_API_KEY`,
  `COINMARKETCAP_API_KEY`. Used by the server to read public on-chain data.
- **Per-account exchange keys** (entered in the UI): API key/secret/passphrase
  and wallet address/private key, stored encrypted in the DB with `SECRETS_KEY`.
  The API only ever returns `has_*` booleans, never the secret values.

## Notes

- **Forgot password?** There's no email-based reset in the self-hosted edition.
  Reset it directly in the database, or delete and recreate the account.
- **Postgres:** set `DATABASE_URL` (e.g. `postgresql+psycopg://…`) to move off
  SQLite. Schema is created on startup; there's no migrations framework.
- **HTTPS:** the session cookie is Secure-by-default. For local HTTP set
  `SESSION_COOKIE_SECURE=false` (docker-compose already does). Flip it back on
  behind a TLS terminator.

## License

[MIT](LICENSE).
