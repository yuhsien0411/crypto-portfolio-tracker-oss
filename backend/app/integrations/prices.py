"""Live spot-price lookup for user-entered custom assets.

Uses CoinMarketCap's ``/cryptocurrency/quotes/latest`` endpoint. Requires
``COINMARKETCAP_API_KEY`` to be set in the environment. When a symbol maps to
multiple coins (e.g. forked tickers), the response is ranked by ``cmc_rank``
and we pick the top one so you get the canonical BTC/ETH/SOL and not some
obscure clone.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

CMC_QUOTES_URL = "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest"
PRICE_CACHE_TTL_SECONDS = int(os.getenv("PRICE_CACHE_TTL_SECONDS", "300"))

_cache_lock = threading.Lock()
_price_cache: dict[str, tuple[float, float]] = {}


class PriceNotFound(Exception):
    """Raised when we can't resolve a USD price for the given symbol."""


def _pick_canonical(entries: list[dict[str, Any]]) -> dict[str, Any] | None:
    """CMC's v2 quotes endpoint returns a list per symbol (one entry per
    coin that shares the ticker). Pick the one with the lowest ``cmc_rank``
    (rank 1 = biggest market cap). Entries without a rank sort last."""
    if not entries:
        return None

    def sort_key(e: dict[str, Any]) -> tuple[int, int]:
        rank = e.get("cmc_rank")
        if isinstance(rank, int) and rank > 0:
            return (0, rank)
        return (1, 0)

    return sorted(entries, key=sort_key)[0]


def fetch_spot_price_usd(symbol: str, *, timeout: float = 8.0) -> float:
    """Return the current USD spot price for ``symbol`` (e.g. ``"BTC"``)."""
    sym = (symbol or "").strip().upper()
    if not sym:
        raise PriceNotFound("symbol is required")
    if PRICE_CACHE_TTL_SECONDS > 0:
        now = time.monotonic()
        with _cache_lock:
            cached = _price_cache.get(sym)
            if cached is not None:
                cached_at, cached_price = cached
                if now - cached_at < PRICE_CACHE_TTL_SECONDS:
                    return cached_price

    api_key = (os.getenv("COINMARKETCAP_API_KEY") or "").strip()
    if not api_key:
        raise PriceNotFound("server missing COINMARKETCAP_API_KEY")

    query = urllib.parse.urlencode({"symbol": sym, "convert": "USD"})
    request = urllib.request.Request(
        f"{CMC_QUOTES_URL}?{query}",
        headers={
            "accept": "application/json",
            "X-CMC_PRO_API_KEY": api_key,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 400:
            raise PriceNotFound(f"unknown symbol {sym}") from exc
        if exc.code == 401:
            raise PriceNotFound("CoinMarketCap rejected the API key") from exc
        if exc.code == 429:
            raise PriceNotFound("CoinMarketCap rate limit hit") from exc
        raise PriceNotFound(f"price lookup failed ({exc.code})") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise PriceNotFound(f"price lookup failed: {exc}") from exc

    data = (payload or {}).get("data") if isinstance(payload, dict) else None
    entries = data.get(sym) if isinstance(data, dict) else None
    # v2 returns a list; v1 returned a single dict — tolerate both shapes.
    if isinstance(entries, dict):
        entries = [entries]
    if not isinstance(entries, list) or not entries:
        raise PriceNotFound(f"no price data for {sym}")

    best = _pick_canonical(entries)
    quote = (best or {}).get("quote") if isinstance(best, dict) else None
    usd = (quote or {}).get("USD") if isinstance(quote, dict) else None
    price = (usd or {}).get("price") if isinstance(usd, dict) else None
    try:
        price_f = float(price)
    except (TypeError, ValueError) as exc:
        raise PriceNotFound(f"bad price payload for {sym}") from exc
    if price_f <= 0:
        raise PriceNotFound(f"non-positive price for {sym}")
    if PRICE_CACHE_TTL_SECONDS > 0:
        with _cache_lock:
            _price_cache[sym] = (time.monotonic(), price_f)
    return price_f
