"""Live spot-price lookup — used by the custom-asset UI."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import db_models as m
from ..auth import current_user
from ..integrations.prices import PriceNotFound, fetch_spot_quote_usd
from .. import ratelimit

router = APIRouter(prefix="/api/prices", tags=["prices"])
_SYMBOL_RE = re.compile(r"^[A-Z0-9._-]{1,16}$")


class SpotPrice(BaseModel):
    symbol: str
    price_usd: float
    source: str


@router.get("/{symbol}", response_model=SpotPrice)
def get_spot_price(
    symbol: str,
    user: m.UserRow = Depends(current_user),
) -> SpotPrice:
    sym = symbol.strip().upper()
    if not _SYMBOL_RE.fullmatch(sym):
        raise HTTPException(status_code=400, detail="Invalid symbol")
    try:
        ratelimit.check_price_allowed(user.id)
    except ratelimit.RateLimited as rl:
        raise HTTPException(
            status_code=429,
            detail=f"Looking up prices too quickly. Try again in {rl.retry_after_seconds} seconds.",
            headers={"Retry-After": str(rl.retry_after_seconds)},
        )
    try:
        quote = fetch_spot_quote_usd(sym)
    except PriceNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return SpotPrice(symbol=sym, price_usd=quote.price_usd, source=quote.source)
