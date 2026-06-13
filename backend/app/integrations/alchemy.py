"""Alchemy token-only wallet clients with DefiLlama prices.

This is a lightweight fallback for operators who only need wallet token
balances and USD prices, not DeBank-style DeFi positions.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.parse
import urllib.request
from typing import Any


_log = logging.getLogger(__name__)

STABLECOIN_SYMBOLS = {
    "USDT",
    "USDT0",
    "USDC",
    "DAI",
    "BUSD",
    "TUSD",
    "USDP",
    "USDD",
    "FDUSD",
    "USDE",
    "SUSDE",
    "PYUSD",
}

KNOWN_TOKEN_METADATA: dict[str, dict[str, dict[str, Any]]] = {
    "arb": {
        # Arbitrum canonical stablecoins. Fetch these explicitly so they are
        # never dropped by the metadata cap or transient metadata failures.
        "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": {
            "symbol": "USDT",
            "name": "Tether USD",
            "decimals": 6,
        },
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831": {
            "symbol": "USDC",
            "name": "USD Coin",
            "decimals": 6,
        },
        "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": {
            "symbol": "USDC.E",
            "name": "Bridged USDC",
            "decimals": 6,
        },
    },
    "bnb": {
        # BNB Smart Chain canonical stablecoins.
        "0x55d398326f99059ff775485246999027b3197955": {
            "symbol": "USDT",
            "name": "Tether USD",
            "decimals": 18,
        },
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": {
            "symbol": "USDC",
            "name": "USD Coin",
            "decimals": 18,
        },
        "0xe9e7cea3dedca5984780bafc599bd69add087d56": {
            "symbol": "BUSD",
            "name": "BUSD",
            "decimals": 18,
        },
        "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3": {
            "symbol": "DAI",
            "name": "Dai Stablecoin",
            "decimals": 18,
        },
    },
    "mantle": {
        # Mantle stablecoins. Fetch these explicitly because Mantle metadata
        # coverage can be sparse and the generic token scan is capped.
        "0x201eba5cc46d216ce6dc03f6a759e8e766e956ae": {
            "symbol": "USDT",
            "name": "Tether USD",
            "decimals": 6,
        },
        "0x09bc4e0d864854c6afb6eb9a9cdf58ac190d0df9": {
            "symbol": "USDC",
            "name": "USD Coin",
            "decimals": 6,
        },
        "0x779ded0c9e1022225f8e0630b35a9b54be713736": {
            "symbol": "USDT0",
            "name": "USDT0",
            "decimals": 6,
        },
        "0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8": {
            "symbol": "WMNT",
            "name": "Wrapped Mantle",
            "decimals": 18,
        },
    },
}

ALCHEMY_NETWORKS: dict[str, dict[str, str]] = {
    "eth": {
        "url": "https://eth-mainnet.g.alchemy.com/v2/{api_key}",
        "llama": "ethereum",
        "native_symbol": "ETH",
        "native_name": "Ethereum",
        "native_price": "coingecko:ethereum",
    },
    "polygon": {
        "url": "https://polygon-mainnet.g.alchemy.com/v2/{api_key}",
        "llama": "polygon",
        "native_symbol": "POL",
        "native_name": "Polygon",
        "native_price": "coingecko:polygon-ecosystem-token",
    },
    "bnb": {
        "url": "https://bnb-mainnet.g.alchemy.com/v2/{api_key}",
        "llama": "bsc",
        "native_symbol": "BNB",
        "native_name": "BNB",
        "native_price": "coingecko:binancecoin",
    },
    "arb": {
        "url": "https://arb-mainnet.g.alchemy.com/v2/{api_key}",
        "llama": "arbitrum",
        "native_symbol": "ETH",
        "native_name": "Ethereum",
        "native_price": "coingecko:ethereum",
    },

    "base": {
        "url": "https://base-mainnet.g.alchemy.com/v2/{api_key}",
        "llama": "base",
        "native_symbol": "ETH",
        "native_name": "Ethereum",
        "native_price": "coingecko:ethereum",
    },
    "mantle": {
        "url": "https://mantle-mainnet.g.alchemy.com/v2/{api_key}",
        "llama": "mantle",
        "native_symbol": "MNT",
        "native_name": "Mantle",
        "native_price": "coingecko:mantle",
    },
    "scroll": {
        "url": "https://scroll-mainnet.g.alchemy.com/v2/{api_key}",
        "llama": "scroll",
        "native_symbol": "ETH",
        "native_name": "Ethereum",
        "native_price": "coingecko:ethereum",
    },
}

DEFILLAMA_PRICES_URL = "https://coins.llama.fi/prices/current/{coins}"
SOLANA_URL = "https://solana-mainnet.g.alchemy.com/v2/{api_key}"
SUI_URL = "https://sui-mainnet.g.alchemy.com/v2/{api_key}"
SUI_NATIVE_COIN_TYPE = "0x2::sui::SUI"
ERC20_BALANCE_OF_SELECTOR = "0x70a08231"


def _rpc(url: str, method: str, params: list[Any], timeout: float) -> Any:
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if isinstance(payload, dict) and payload.get("error"):
        message = payload["error"].get("message") if isinstance(payload["error"], dict) else payload["error"]
        raise ValueError(f"Alchemy RPC error: {message}")
    return payload.get("result") if isinstance(payload, dict) else None


def _hex_to_int(value: str | None) -> int:
    if not value:
        return 0
    return int(value, 16)


def _encode_address_arg(address: str) -> str:
    return address.lower().replace("0x", "").rjust(64, "0")


def _fetch_erc20_balance(
    url: str,
    wallet_address: str,
    contract_address: str,
    timeout: float,
) -> int:
    data = ERC20_BALANCE_OF_SELECTOR + _encode_address_arg(wallet_address)
    result = _rpc(
        url,
        "eth_call",
        [{"to": contract_address, "data": data}, "latest"],
        timeout,
    )
    return _hex_to_int(str(result or "0x0"))


def _price_map(price_ids: list[str], timeout: float) -> dict[str, float]:
    prices: dict[str, float] = {}
    unique = sorted(set(p for p in price_ids if p))
    for i in range(0, len(unique), 100):
        chunk = unique[i:i + 100]
        encoded = urllib.parse.quote(",".join(chunk), safe=",:")
        request = urllib.request.Request(
            DEFILLAMA_PRICES_URL.format(coins=encoded),
            headers={"accept": "application/json"},
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        coins = payload.get("coins") if isinstance(payload, dict) else None
        if not isinstance(coins, dict):
            continue
        for key, item in coins.items():
            if isinstance(item, dict) and item.get("price") is not None:
                prices[key] = float(item["price"])
    return prices


def _fallback_price(asset: dict[str, Any], prices: dict[str, float]) -> float:
    price = prices.get(str(asset.get("price_id") or ""), 0.0)
    if price > 0:
        return price
    symbol = str(asset.get("symbol") or "").upper()
    if symbol in STABLECOIN_SYMBOLS:
        return 1.0
    return 0.0


def _solana_rpc(url: str, method: str, params: list[Any], timeout: float) -> Any:
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if isinstance(payload, dict) and payload.get("error"):
        message = payload["error"].get("message") if isinstance(payload["error"], dict) else payload["error"]
        raise ValueError(f"Alchemy Solana RPC error: {message}")
    return payload.get("result") if isinstance(payload, dict) else None


def _sui_rpc(url: str, method: str, params: list[Any], timeout: float) -> Any:
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if isinstance(payload, dict) and payload.get("error"):
        message = payload["error"].get("message") if isinstance(payload["error"], dict) else payload["error"]
        raise ValueError(f"Alchemy Sui RPC error: {message}")
    return payload.get("result") if isinstance(payload, dict) else None


def _sui_price_id(coin_type: str) -> str:
    if coin_type == SUI_NATIVE_COIN_TYPE:
        return "coingecko:sui"
    return f"sui:{coin_type}"


def _fetch_network_assets(
    address: str,
    api_key: str,
    network_id: str,
    timeout: float,
) -> list[dict[str, Any]]:
    cfg = ALCHEMY_NETWORKS[network_id]
    url = cfg["url"].format(api_key=api_key)
    assets: list[dict[str, Any]] = []

    native_raw = _hex_to_int(_rpc(url, "eth_getBalance", [address, "latest"], timeout))
    if native_raw > 0:
        assets.append({
            "symbol": cfg["native_symbol"],
            "name": cfg["native_name"],
            "chain": network_id,
            "amount": native_raw / 1e18,
            "contract_address": "",
            "price_id": cfg["native_price"],
        })

    known_meta = KNOWN_TOKEN_METADATA.get(network_id, {})
    seen_contracts: set[str] = set()
    for contract, meta in known_meta.items():
        try:
            raw_balance = _fetch_erc20_balance(url, address, contract, timeout)
        except Exception as exc:  # noqa: BLE001
            _log.warning(
                "alchemy: skipping known %s token %s after balanceOf failure: %s",
                network_id,
                contract,
                exc,
            )
            continue
        if raw_balance <= 0:
            continue
        decimals_i = int(meta.get("decimals") or 18)
        amount = raw_balance / (10 ** decimals_i)
        if amount <= 0:
            continue
        seen_contracts.add(contract)
        assets.append({
            "symbol": str(meta.get("symbol") or contract[:8]).upper(),
            "name": str(meta.get("name") or meta.get("symbol") or contract),
            "chain": network_id,
            "amount": amount,
            "contract_address": contract,
            "price_id": f"{cfg['llama']}:{contract}",
        })

    try:
        result = _rpc(url, "alchemy_getTokenBalances", [address, "erc20"], timeout)
    except Exception as exc:  # noqa: BLE001
        _log.warning(
            "alchemy: skipping generic %s token scan after failure: %s",
            network_id,
            exc,
        )
        return assets
    balances = result.get("tokenBalances") if isinstance(result, dict) else []
    if not isinstance(balances, list):
        return assets

    balances = sorted(
        balances,
        key=lambda row: 0
        if isinstance(row, dict)
        and str(row.get("contractAddress") or "").lower() in known_meta
        else 1,
    )
    max_tokens = int(os.getenv("ALCHEMY_MAX_TOKENS_PER_NETWORK", "25"))
    metadata_timeout = float(os.getenv("ALCHEMY_METADATA_TIMEOUT_SECONDS", "3"))
    metadata_count = 0
    for row in balances:
        if not isinstance(row, dict):
            continue
        raw_balance = _hex_to_int(row.get("tokenBalance"))
        contract = str(row.get("contractAddress") or "").lower()
        if raw_balance <= 0 or not contract:
            continue
        if contract in seen_contracts:
            continue
        meta = known_meta.get(contract)
        if meta is None:
            if metadata_count >= max_tokens:
                _log.info(
                    "alchemy: %s token metadata limit reached (%s)",
                    network_id,
                    max_tokens,
                )
                break
            try:
                meta = _rpc(url, "alchemy_getTokenMetadata", [contract], metadata_timeout)
            except Exception as exc:  # noqa: BLE001
                _log.warning(
                    "alchemy: skipping %s token %s after metadata failure: %s",
                    network_id,
                    contract,
                    exc,
                )
                continue
            metadata_count += 1
        if not isinstance(meta, dict):
            continue
        decimals = meta.get("decimals")
        try:
            decimals_i = int(decimals)
        except (TypeError, ValueError):
            decimals_i = 18
        amount = raw_balance / (10 ** decimals_i)
        if amount <= 0:
            continue
        llama_chain = cfg["llama"]
        assets.append({
            "symbol": str(meta.get("symbol") or contract[:8]).upper(),
            "name": str(meta.get("name") or meta.get("symbol") or contract),
            "chain": network_id,
            "amount": amount,
            "contract_address": contract,
            "price_id": f"{llama_chain}:{contract}",
            "logo_url": str(meta.get("logo") or "") or None,
        })
    return assets


def fetch_evm_wallet_assets(
    address: str,
    api_key: str,
    networks: list[str],
    timeout: float = 8.0,
) -> dict[str, Any]:
    normalized = str(address or "").strip()
    if not normalized:
        raise ValueError("Alchemy wallet address is required.")
    resolved_key = str(api_key or "").strip()
    if not resolved_key:
        raise ValueError("Alchemy API key is required.")

    assets: list[dict[str, Any]] = []
    for network_id in networks:
        if network_id not in ALCHEMY_NETWORKS:
            continue
        try:
            assets.extend(_fetch_network_assets(normalized, resolved_key, network_id, timeout))
        except Exception as exc:  # noqa: BLE001
            _log.warning("alchemy: skipping %s after fetch failure: %s", network_id, exc)

    try:
        prices = _price_map([str(a.get("price_id") or "") for a in assets], timeout)
    except Exception as exc:  # noqa: BLE001
        _log.warning("alchemy: price lookup failed: %s", exc)
        prices = {}
    total = 0.0
    for asset in assets:
        price = _fallback_price(asset, prices)
        amount = float(asset.get("amount") or 0.0)
        usd = amount * price
        asset["unit_price"] = price
        asset["usd_value"] = usd
        total += usd
    return {"address": normalized, "balance": total, "assets": assets}


def fetch_solana_wallet_assets(
    address: str,
    api_key: str,
    timeout: float = 30.0,
) -> dict[str, Any]:
    normalized = str(address or "").strip()
    if not normalized:
        raise ValueError("Solana wallet address is required.")
    resolved_key = str(api_key or "").strip()
    if not resolved_key:
        raise ValueError("Alchemy API key is required.")

    url = SOLANA_URL.format(api_key=resolved_key)
    assets: list[dict[str, Any]] = []

    sol_balance = _solana_rpc(url, "getBalance", [normalized], timeout)
    lamports = 0
    if isinstance(sol_balance, dict):
        lamports = int(sol_balance.get("value") or 0)
    if lamports > 0:
        assets.append({
            "symbol": "SOL",
            "name": "Solana",
            "chain": "solana",
            "amount": lamports / 1_000_000_000,
            "contract_address": "",
            "price_id": "coingecko:solana",
        })

    token_accounts = _solana_rpc(
        url,
        "getTokenAccountsByOwner",
        [
            normalized,
            {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
            {"encoding": "jsonParsed"},
        ],
        timeout,
    )
    rows = token_accounts.get("value") if isinstance(token_accounts, dict) else []
    if isinstance(rows, list):
        for row in rows:
            try:
                info = row["account"]["data"]["parsed"]["info"]
                mint = str(info["mint"])
                token_amount = info["tokenAmount"]
                amount = float(token_amount.get("uiAmount") or 0.0)
                decimals = int(token_amount.get("decimals") or 0)
            except (KeyError, TypeError, ValueError):
                continue
            if amount <= 0 or not mint:
                continue
            assets.append({
                "symbol": mint[:6].upper(),
                "name": mint,
                "chain": "solana",
                "amount": amount,
                "decimals": decimals,
                "contract_address": mint,
                "price_id": f"solana:{mint}",
            })

    prices = _price_map([str(a.get("price_id") or "") for a in assets], timeout)
    total = 0.0
    for asset in assets:
        price = _fallback_price(asset, prices)
        amount = float(asset.get("amount") or 0.0)
        usd = amount * price
        asset["unit_price"] = price
        asset["usd_value"] = usd
        total += usd
    return {"address": normalized, "balance": total, "assets": assets}


def fetch_sui_wallet_assets(
    address: str,
    api_key: str,
    timeout: float = 30.0,
) -> dict[str, Any]:
    normalized = str(address or "").strip()
    if not normalized:
        raise ValueError("Sui wallet address is required.")
    resolved_key = str(api_key or "").strip()
    if not resolved_key:
        raise ValueError("Alchemy API key is required.")

    url = SUI_URL.format(api_key=resolved_key)
    assets: list[dict[str, Any]] = []
    balances = _sui_rpc(url, "suix_getAllBalances", [normalized], timeout)
    if isinstance(balances, list):
        max_tokens = int(os.getenv("ALCHEMY_MAX_TOKENS_PER_NETWORK", "25"))
        metadata_timeout = float(os.getenv("ALCHEMY_METADATA_TIMEOUT_SECONDS", "3"))
        metadata_count = 0
        for row in balances:
            if not isinstance(row, dict):
                continue
            coin_type = str(row.get("coinType") or "")
            if not coin_type:
                continue
            try:
                total_balance = int(str(row.get("totalBalance") or "0"))
            except ValueError:
                continue
            if total_balance <= 0:
                continue

            meta: dict[str, Any] = {}
            if coin_type == SUI_NATIVE_COIN_TYPE:
                meta = {
                    "symbol": "SUI",
                    "name": "Sui",
                    "decimals": 9,
                }
            elif metadata_count < max_tokens:
                try:
                    raw_meta = _sui_rpc(
                        url,
                        "suix_getCoinMetadata",
                        [coin_type],
                        metadata_timeout,
                    )
                except Exception as exc:  # noqa: BLE001
                    _log.warning(
                        "alchemy: skipping Sui token metadata for %s after failure: %s",
                        coin_type,
                        exc,
                    )
                    raw_meta = None
                metadata_count += 1
                if isinstance(raw_meta, dict):
                    meta = raw_meta
            else:
                _log.info("alchemy: sui token metadata limit reached (%s)", max_tokens)
                break

            decimals = meta.get("decimals", 9)
            try:
                decimals_i = int(decimals)
            except (TypeError, ValueError):
                decimals_i = 9
            amount = total_balance / (10 ** decimals_i)
            if amount <= 0:
                continue
            assets.append({
                "symbol": str(meta.get("symbol") or coin_type.split("::")[-1]).upper(),
                "name": str(meta.get("name") or meta.get("symbol") or coin_type),
                "chain": "sui",
                "amount": amount,
                "decimals": decimals_i,
                "contract_address": coin_type,
                "price_id": _sui_price_id(coin_type),
                "logo_url": str(meta.get("iconUrl") or "") or None,
            })

    try:
        prices = _price_map([str(a.get("price_id") or "") for a in assets], timeout)
    except Exception as exc:  # noqa: BLE001
        _log.warning("alchemy: Sui price lookup failed: %s", exc)
        prices = {}
    total = 0.0
    for asset in assets:
        price = _fallback_price(asset, prices)
        amount = float(asset.get("amount") or 0.0)
        usd = amount * price
        asset["unit_price"] = price
        asset["usd_value"] = usd
        total += usd
    return {"address": normalized, "balance": total, "assets": assets}
