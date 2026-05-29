"""CoinStats /wallet/balance client — Solana, Sui, and Cosmos wallet assets."""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

COINSTATS_WALLET_BALANCE_URL = "https://openapiv1.coinstats.app/wallet/balance"
SOLANA_CONNECTION_ID = "solana"
SUI_CONNECTION_ID = "sui-wallet"
COSMOS_CONNECTION_ID = "cosmos"


def _fetch_wallet_assets(
    address: str,
    api_key: str,
    connection_id: str,
    timeout: float,
) -> dict[str, Any]:
    normalized_address = str(address or "").strip()
    if not normalized_address:
        raise ValueError("CoinStats wallet address is required.")
    resolved_api_key = str(api_key or "").strip()
    if not resolved_api_key:
        raise ValueError("CoinStats API key is required.")
    query = urllib.parse.urlencode(
        {"address": normalized_address, "connectionId": connection_id}
    )
    request = urllib.request.Request(
        f"{COINSTATS_WALLET_BALANCE_URL}?{query}",
        headers={"accept": "application/json", "X-API-KEY": resolved_api_key},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))

    if not isinstance(payload, list):
        raise ValueError("Unexpected CoinStats response; expected a list of assets.")

    assets: list[dict[str, Any]] = []
    total_balance = 0.0
    for item in payload:
        if not isinstance(item, dict):
            continue
        amount = float(item.get("amount", 0.0) or 0.0)
        price = float(item.get("price", 0.0) or 0.0)
        usd_value = amount * price
        total_balance += usd_value
        assets.append(
            {
                "id": str(item.get("coinId", "") or ""),
                "name": str(item.get("name", item.get("symbol", "")) or ""),
                "symbol": str(item.get("symbol", "") or "").strip().upper(),
                "chain": str(item.get("chain", connection_id) or connection_id),
                "amount": amount,
                "unit_price": price,
                "usd_value": usd_value,
                "logo_url": str(item.get("imgUrl", "") or "").strip(),
                "contract_address": str(item.get("contractAddress", "") or "").strip(),
            }
        )

    return {
        "address": normalized_address,
        "connection_id": connection_id,
        "balance": total_balance,
        "assets": assets,
    }


def fetch_solana_wallet_assets(
    address: str,
    api_key: str,
    timeout: float = 30.0,
) -> dict[str, Any]:
    return _fetch_wallet_assets(address, api_key, SOLANA_CONNECTION_ID, timeout)


def fetch_sui_wallet_assets(
    address: str,
    api_key: str,
    timeout: float = 30.0,
) -> dict[str, Any]:
    return _fetch_wallet_assets(address, api_key, SUI_CONNECTION_ID, timeout)


def fetch_cosmos_wallet_assets(
    address: str,
    api_key: str,
    timeout: float = 30.0,
) -> dict[str, Any]:
    return _fetch_wallet_assets(address, api_key, COSMOS_CONNECTION_ID, timeout)
