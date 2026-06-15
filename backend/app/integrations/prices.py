"""Live spot-price lookup for user-entered custom assets.

Provider order is DefiLlama first, then DexScreener. DefiLlama needs canonical
coin ids, so symbol lookups use the built-in map below. DexScreener is the
fallback for newer or long-tail tokens and chooses the deepest exact-symbol
pair by USD liquidity.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFILLAMA_PRICES_URL = "https://coins.llama.fi/prices/current/{coins}"
DEXSCREENER_SEARCH_URL = "https://api.dexscreener.com/latest/dex/search"
PRICE_CACHE_TTL_SECONDS = int(os.getenv("PRICE_CACHE_TTL_SECONDS", "300"))

_cache_lock = threading.Lock()
_price_cache: dict[str, tuple[float, float, str]] = {}

_DEFILLAMA_SYMBOL_IDS: dict[str, str] = {
    "1INCH": "1inch",
    "AAVE": "aave",
    "ADA": "cardano",
    "APT": "aptos",
    "ARB": "arbitrum",
    "ATOM": "cosmos",
    "AVAX": "avalanche-2",
    "BCH": "bitcoin-cash",
    "BNB": "binancecoin",
    "BONK": "bonk",
    "BTC": "bitcoin",
    "DAI": "dai",
    "DOGE": "dogecoin",
    "DOT": "polkadot",
    "ENA": "ethena",
    "ETC": "ethereum-classic",
    "ETH": "ethereum",
    "FET": "artificial-superintelligence-alliance",
    "FIL": "filecoin",
    "HBAR": "hedera-hashgraph",
    "HYPE": "hyperliquid",
    "ICP": "internet-computer",
    "IMX": "immutable-x",
    "INJ": "injective-protocol",
    "JUP": "jupiter-exchange-solana",
    "KAS": "kaspa",
    "LDO": "lido-dao",
    "LINK": "chainlink",
    "LTC": "litecoin",
    "MATIC": "polygon-ecosystem-token",
    "NEAR": "near",
    "OKB": "okb",
    "OP": "optimism",
    "PEPE": "pepe",
    "POL": "polygon-ecosystem-token",
    "RENDER": "render-token",
    "SEI": "sei-network",
    "SHIB": "shiba-inu",
    "SOL": "solana",
    "SUI": "sui",
    "TAO": "bittensor",
    "TON": "the-open-network",
    "TRX": "tron",
    "UNI": "uniswap",
    "USDC": "usd-coin",
    "USDT": "tether",
    "WBTC": "wrapped-bitcoin",
    "WETH": "weth",
    "WIF": "dogwifcoin",
    "XLM": "stellar",
    "XRP": "ripple",
}

_STABLE_SYMBOLS = {"BUSD", "FDUSD", "PYUSD", "TUSD", "USDD", "USDE", "USDP", "USD"}


class PriceNotFound(Exception):
    """Raised when we can't resolve a USD price for the given symbol."""


@dataclass(frozen=True)
class SpotQuote:
    price_usd: float
    source: str


def _to_positive_float(value: Any, *, context: str) -> float:
    try:
        price = float(value)
    except (TypeError, ValueError) as exc:
        raise PriceNotFound(f"bad price payload from {context}") from exc
    if price <= 0:
        raise PriceNotFound(f"non-positive price from {context}")
    return price


def _request_json(url: str, *, timeout: float, headers: dict[str, str] | None = None) -> Any:
    request = urllib.request.Request(
        url,
        headers={
            "accept": "application/json",
            "user-agent": "crypto-portfolio-tracker/1.0",
            **(headers or {}),
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _defillama_symbol_ids() -> dict[str, str]:
    raw = (os.getenv("DEFILLAMA_SYMBOL_PRICE_IDS") or "").strip()
    if not raw:
        return _DEFILLAMA_SYMBOL_IDS
    try:
        extra = json.loads(raw)
    except json.JSONDecodeError:
        return _DEFILLAMA_SYMBOL_IDS
    if not isinstance(extra, dict):
        return _DEFILLAMA_SYMBOL_IDS
    merged = dict(_DEFILLAMA_SYMBOL_IDS)
    for symbol, coin_id in extra.items():
        sym = str(symbol or "").strip().upper()
        cid = str(coin_id or "").strip()
        if sym and cid:
            merged[sym] = cid
    return merged


def _fetch_defillama_price_usd(sym: str, *, timeout: float) -> float:
    coin_id = _defillama_symbol_ids().get(sym)
    if not coin_id:
        if sym in _STABLE_SYMBOLS:
            return 1.0
        raise PriceNotFound(f"no DefiLlama id for {sym}")
    coin_key = f"coingecko:{coin_id}"
    url = DEFILLAMA_PRICES_URL.format(coins=urllib.parse.quote(coin_key, safe=":,"))
    try:
        payload = _request_json(url, timeout=timeout)
    except urllib.error.HTTPError as exc:
        raise PriceNotFound(f"DefiLlama lookup failed ({exc.code})") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise PriceNotFound(f"DefiLlama lookup failed: {exc}") from exc

    coins = (payload or {}).get("coins") if isinstance(payload, dict) else None
    item = coins.get(coin_key) if isinstance(coins, dict) else None
    if not isinstance(item, dict):
        raise PriceNotFound(f"no DefiLlama price data for {sym}")
    return _to_positive_float(item.get("price"), context="DefiLlama")


def _symbol_matches(value: Any, sym: str) -> bool:
    token_symbol = str(value or "").strip().upper()
    return token_symbol == sym or token_symbol.replace("$", "").replace(" ", "") == sym


def _liquidity_usd(pair: dict[str, Any]) -> float:
    liquidity = pair.get("liquidity")
    if not isinstance(liquidity, dict):
        return 0.0
    try:
        return float(liquidity.get("usd") or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _fetch_dexscreener_price_usd(sym: str, *, timeout: float) -> float:
    query = urllib.parse.urlencode({"q": sym})
    try:
        payload = _request_json(f"{DEXSCREENER_SEARCH_URL}?{query}", timeout=timeout)
    except urllib.error.HTTPError as exc:
        raise PriceNotFound(f"DexScreener lookup failed ({exc.code})") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise PriceNotFound(f"DexScreener lookup failed: {exc}") from exc

    pairs = (payload or {}).get("pairs") if isinstance(payload, dict) else None
    if not isinstance(pairs, list):
        raise PriceNotFound(f"no DexScreener price data for {sym}")

    candidates: list[dict[str, Any]] = []
    for pair in pairs:
        if not isinstance(pair, dict):
            continue
        base_token = pair.get("baseToken")
        if not isinstance(base_token, dict) or not _symbol_matches(base_token.get("symbol"), sym):
            continue
        try:
            _to_positive_float(pair.get("priceUsd"), context="DexScreener")
        except PriceNotFound:
            continue
        candidates.append(pair)
    if not candidates:
        raise PriceNotFound(f"no DexScreener price data for {sym}")

    best = max(candidates, key=_liquidity_usd)
    return _to_positive_float(best.get("priceUsd"), context="DexScreener")


def fetch_spot_quote_usd(symbol: str, *, timeout: float = 8.0) -> SpotQuote:
    """Return the current USD spot quote for ``symbol`` (e.g. ``"BTC"``)."""
    sym = (symbol or "").strip().upper()
    if not sym:
        raise PriceNotFound("symbol is required")
    if PRICE_CACHE_TTL_SECONDS > 0:
        now = time.monotonic()
        with _cache_lock:
            cached = _price_cache.get(sym)
            if cached is not None:
                cached_at, cached_price, cached_source = cached
                if now - cached_at < PRICE_CACHE_TTL_SECONDS:
                    return SpotQuote(price_usd=cached_price, source=cached_source)

    errors: list[str] = []
    providers = (
        ("defillama", _fetch_defillama_price_usd),
        ("dexscreener", _fetch_dexscreener_price_usd),
    )
    for source, fetcher in providers:
        try:
            price_f = fetcher(sym, timeout=timeout)
        except PriceNotFound as exc:
            errors.append(str(exc))
            continue
        if PRICE_CACHE_TTL_SECONDS > 0:
            with _cache_lock:
                _price_cache[sym] = (time.monotonic(), price_f, source)
        return SpotQuote(price_usd=price_f, source=source)

    detail = "; ".join(errors) if errors else f"no price data for {sym}"
    raise PriceNotFound(detail)


def fetch_spot_price_usd(symbol: str, *, timeout: float = 8.0) -> float:
    """Return the current USD spot price for ``symbol`` (e.g. ``"BTC"``)."""
    return fetch_spot_quote_usd(symbol, timeout=timeout).price_usd
