"""Lightweight in-process throttles for the paid external APIs.

These are soft guards against accidental spam (a stuck retry loop in the UI,
or mashing "Sync") — not security controls. They protect the operator's
Alchemy / CoinMarketCap quota. In-memory state is fine: with
multiple uvicorn workers each enforces its own interval, so the effective
floor is roughly the configured interval divided by the worker count, which
is good enough for an accidental-spam guard.
"""
from __future__ import annotations

import os
import threading
import time


class RateLimited(Exception):
    """Raised when the caller has tripped a throttle window.
    The router converts this into a 429 with Retry-After."""

    def __init__(self, scope: str, retry_after_seconds: int) -> None:
        super().__init__(f"rate limited on {scope}")
        self.scope = scope  # "sync" or "price"
        self.retry_after_seconds = retry_after_seconds


# Minimum seconds between sync calls for a single user. Each on-chain sync
# costs the operator API quota, and the UI auto-refresh can get stuck retrying
# — this caps the damage. Tunable via env.
SYNC_MIN_INTERVAL_SECONDS = int(os.getenv("SYNC_MIN_INTERVAL_SECONDS", "20"))
PRICE_MIN_INTERVAL_SECONDS = float(os.getenv("PRICE_MIN_INTERVAL_SECONDS", "1.0"))
PRICE_WINDOW_SECONDS = int(os.getenv("PRICE_WINDOW_SECONDS", "60"))
PRICE_MAX_LOOKUPS_PER_WINDOW = int(os.getenv("PRICE_MAX_LOOKUPS_PER_WINDOW", "30"))

_sync_last_call: dict[str, float] = {}
_price_calls: dict[str, list[float]] = {}
_sync_lock = threading.Lock()
_price_lock = threading.Lock()


def check_sync_allowed(user_id: str) -> None:
    """Raise ``RateLimited`` if ``user_id`` synced too recently."""
    if SYNC_MIN_INTERVAL_SECONDS <= 0:
        return
    now = time.monotonic()
    with _sync_lock:
        last = _sync_last_call.get(user_id)
        if last is not None:
            elapsed = now - last
            if elapsed < SYNC_MIN_INTERVAL_SECONDS:
                retry = max(1, int(SYNC_MIN_INTERVAL_SECONDS - elapsed))
                raise RateLimited(scope="sync", retry_after_seconds=retry)
        _sync_last_call[user_id] = now


def check_price_allowed(user_id: str) -> None:
    """Per-user guard for paid spot-price lookups.

    CoinMarketCap requests cost quota even though the endpoint is just a UI
    convenience. This in-memory limiter is paired with a cache in
    integrations/prices.py so normal typing stays responsive.
    """
    if PRICE_MAX_LOOKUPS_PER_WINDOW <= 0 and PRICE_MIN_INTERVAL_SECONDS <= 0:
        return
    now = time.monotonic()
    window = max(1, PRICE_WINDOW_SECONDS)
    with _price_lock:
        calls = [
            t for t in _price_calls.get(user_id, [])
            if now - t < window
        ]
        if PRICE_MIN_INTERVAL_SECONDS > 0 and calls:
            elapsed = now - calls[-1]
            if elapsed < PRICE_MIN_INTERVAL_SECONDS:
                retry = max(1, int(PRICE_MIN_INTERVAL_SECONDS - elapsed + 0.999))
                _price_calls[user_id] = calls
                raise RateLimited(scope="price", retry_after_seconds=retry)
        if PRICE_MAX_LOOKUPS_PER_WINDOW > 0 and len(calls) >= PRICE_MAX_LOOKUPS_PER_WINDOW:
            retry = max(1, int(window - (now - calls[0])))
            _price_calls[user_id] = calls
            raise RateLimited(scope="price", retry_after_seconds=retry)
        calls.append(now)
        _price_calls[user_id] = calls
