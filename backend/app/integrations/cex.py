"""CEX + perp-DEX account clients.

Credentials (`api_key`, `api_secret`, `passphrase`, `wallet_address`) are
read directly from the wallet dict passed into each
``fetch_*_assets`` function — the backend persists them in its own DB and
injects them here. There is no environment-variable fallback."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from typing import Any

try:
    from eth_account import Account
    from eth_account.messages import encode_defunct
except ModuleNotFoundError:
    Account = None
    encode_defunct = None


def _now_ms() -> int:
    return int(datetime.now(tz=UTC).timestamp() * 1000)


def _iso_now() -> str:
    return datetime.now(tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    body: str = "",
    timeout: float = 30.0,
) -> Any:
    final_url = url
    if params:
        query = urllib.parse.urlencode(
            [(key, value) for key, value in params.items() if value is not None]
        )
        if query:
            separator = "&" if "?" in url else "?"
            final_url = f"{url}{separator}{query}"
    request = urllib.request.Request(
        final_url,
        data=body.encode("utf-8") if body else None,
        headers=headers or {},
        method=method.upper(),
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _request_json_allow_statuses(
    url: str,
    *,
    allowed_statuses: set[int] | None = None,
    **kwargs: Any,
) -> Any | None:
    try:
        return _request_json(url, **kwargs)
    except urllib.error.HTTPError as exc:
        if allowed_statuses and exc.code in allowed_statuses:
            return None
        raise


def _load_cex_credentials(
    wallet: dict[str, Any], *, require_secret: bool = True, require_api_key: bool = True
) -> dict[str, str]:
    name = str(wallet.get("name", "") or "unknown").strip() or "unknown"
    api_key = str(wallet.get("api_key", "") or "").strip()
    api_secret = str(wallet.get("api_secret", "") or "").strip()
    passphrase = str(wallet.get("passphrase", "") or "").strip()
    if (require_api_key and not api_key) or (require_secret and not api_secret):
        raise RuntimeError(
            f"CEX wallet '{name}' is missing required credentials."
        )
    return {
        "api_key": api_key,
        "api_secret": api_secret,
        "passphrase": passphrase,
        "prefix": f"saved:{name}",
    }


def _symbol_candidates(asset: str) -> list[str]:
    upper = asset.upper()
    if upper in {"USD", "USDT", "USDC", "FDUSD", "BUSD", "TUSD", "USDS", "DAI"}:
        return []
    return [
        f"{upper}USDT",
        f"{upper}USDC",
        f"{upper}FDUSD",
        f"{upper}BUSD",
        f"{upper}USD",
    ]


def _binance_headers(api_key: str) -> dict[str, str]:
    return {"X-MBX-APIKEY": api_key, "Content-Type": "application/json"}


def _binance_signed_params(api_secret: str, params: dict[str, Any]) -> dict[str, Any]:
    query_string = urllib.parse.urlencode(params)
    signature = hmac.new(
        api_secret.encode("utf-8"),
        query_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {**params, "signature": signature}


def _fetch_binance_prices(symbols: list[str]) -> dict[str, float]:
    wanted = {symbol for symbol in symbols if symbol}
    if not wanted:
        return {}
    payload = _request_json("https://api.binance.com/api/v3/ticker/price")
    prices: dict[str, float] = {}
    if not isinstance(payload, list):
        return prices
    for item in payload:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("symbol", "") or "")
        if symbol not in wanted:
            continue
        price = item.get("price")
        if price is None:
            continue
        prices[symbol] = float(price)
    return prices


def _fetch_gate_spot_prices(assets: list[str]) -> dict[str, float]:
    wanted = {asset.strip().upper() for asset in assets if asset}
    wanted = {asset for asset in wanted if asset and not _is_stable_asset(asset)}
    if not wanted:
        return {}
    try:
        payload = _request_json("https://api.gateio.ws/api/v4/spot/tickers")
    except Exception:
        return {}
    if not isinstance(payload, list):
        return {}
    quote_priority = {"USDT": 0, "USDC": 1, "USD": 2}
    best_quotes: dict[str, tuple[int, float]] = {}
    for item in payload:
        if not isinstance(item, dict):
            continue
        pair = str(item.get("currency_pair", "") or "").strip().upper()
        if "_" not in pair:
            continue
        base, quote = pair.split("_", 1)
        if base not in wanted or quote not in quote_priority:
            continue
        try:
            price = float(item.get("last", 0.0) or 0.0)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        rank = quote_priority[quote]
        current = best_quotes.get(base)
        if current is None or rank < current[0]:
            best_quotes[base] = (rank, price)
    return {asset: value for asset, (_, value) in best_quotes.items()}


def _is_stable_asset(asset: str) -> bool:
    return asset.upper() in {
        "USD",
        "USD1",
        "USDT",
        "USDC",
        "FDUSD",
        "BUSD",
        "TUSD",
        "USDS",
        "DAI",
        "BFUSD",
        "RWUSD",
    }


def _append_asset_row(
    assets: list[dict[str, Any]],
    *,
    name: str,
    amount: float,
    available: float,
    locked: float,
    unit_price: float,
    usd_value: float,
    chain: str = "binance",
) -> None:
    if amount <= 0 and usd_value <= 0:
        return
    assets.append(
        {
            "name": name,
            "symbol": name,
            "chain": chain,
            "amount": amount,
            "available": available,
            "locked": locked,
            "unit_price": unit_price,
            "usd_value": usd_value,
        }
    )


def _to_float(value: Any) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _fetch_binance_spot_assets(creds: dict[str, str]) -> tuple[float, list[dict[str, Any]], str | None]:
    params = _binance_signed_params(
        creds["api_secret"],
        {
            "omitZeroBalances": "true",
            "recvWindow": "5000",
            "timestamp": str(_now_ms()),
        },
    )
    payload = _request_json_allow_statuses(
        "https://api.binance.com/api/v3/account",
        headers=_binance_headers(creds["api_key"]),
        params=params,
        allowed_statuses={401},
    )
    if not isinstance(payload, dict):
        return 0.0, [], None

    balances = payload.get("balances", [])
    active_assets = []
    symbols: list[str] = []
    for item in balances:
        if not isinstance(item, dict):
            continue
        asset = str(item.get("asset", "") or "").strip().upper()
        free = float(item.get("free", 0.0) or 0.0)
        locked = float(item.get("locked", 0.0) or 0.0)
        total = free + locked
        if not asset or total <= 0:
            continue
        active_assets.append({"coin": asset, "equity": total, "available": free, "locked": locked})
        symbols.extend(_symbol_candidates(asset))

    prices = _fetch_binance_prices(symbols)
    assets: list[dict[str, Any]] = []
    total_usd = 0.0
    for item in active_assets:
        coin = item["coin"]
        unit_price = 1.0 if _is_stable_asset(coin) else 0.0
        for symbol in _symbol_candidates(coin):
            if symbol in prices:
                unit_price = prices[symbol]
                break
        usd_value = item["equity"] * unit_price
        total_usd += usd_value
        _append_asset_row(
            assets,
            name=coin,
            amount=item["equity"],
            available=item["available"],
            locked=item["locked"],
            unit_price=unit_price,
            usd_value=usd_value,
        )
    return total_usd, assets, "binance /api/v3/account"


def _fetch_binance_portfolio_margin_assets(
    creds: dict[str, str],
) -> tuple[float, list[dict[str, Any]], str | None]:
    # /papi/v1/balance is the Portfolio Margin (unified) endpoint. For classic
    # accounts it returns HTTP 401 with a "permission denied" error, which we
    # swallow so the caller can fall back to the classic spot+futures path.
    params = _binance_signed_params(
        creds["api_secret"],
        {
            "recvWindow": "5000",
            "timestamp": str(_now_ms()),
        },
    )
    payload = _request_json_allow_statuses(
        "https://papi.binance.com/papi/v1/balance",
        headers=_binance_headers(creds["api_key"]),
        params=params,
        allowed_statuses={401, 403},
    )
    if not isinstance(payload, list):
        return 0.0, [], None

    # Per Binance docs, totalWalletBalance already folds in spot + USDⓂ-M +
    # COIN-M wallets; crossMarginAsset is the separate cross-margin wallet.
    # Net per-asset quantity = wallet + cross-margin asset - borrowed - interest
    #                          + um/cm unrealized PnL.
    raw: list[dict[str, Any]] = []
    symbols: list[str] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        asset = str(item.get("asset", "") or "").strip().upper()
        if not asset:
            continue
        total_wallet = _to_float(item.get("totalWalletBalance"))
        cross_asset = _to_float(item.get("crossMarginAsset"))
        cross_borrowed = _to_float(item.get("crossMarginBorrowed"))
        cross_interest = _to_float(item.get("crossMarginInterest"))
        um_upnl = _to_float(item.get("umUnrealizedPNL"))
        cm_upnl = _to_float(item.get("cmUnrealizedPNL"))
        amount = (
            total_wallet
            + cross_asset
            - cross_borrowed
            - cross_interest
            + um_upnl
            + cm_upnl
        )
        if amount <= 0:
            continue
        raw.append({"asset": asset, "amount": amount})
        if not _is_stable_asset(asset):
            symbols.extend(_symbol_candidates(asset))

    prices = _fetch_binance_prices(symbols)
    assets: list[dict[str, Any]] = []
    total_usd = 0.0
    for row in raw:
        asset = row["asset"]
        amount = row["amount"]
        unit_price = 1.0 if _is_stable_asset(asset) else 0.0
        if not unit_price:
            for symbol in _symbol_candidates(asset):
                if symbol in prices:
                    unit_price = prices[symbol]
                    break
        usd_value = amount * unit_price
        total_usd += usd_value
        _append_asset_row(
            assets,
            name=asset,
            amount=amount,
            available=amount,
            locked=0.0,
            unit_price=unit_price,
            usd_value=usd_value,
        )
    return total_usd, assets, "binance /papi/v1/balance"


def _fetch_binance_futures_assets(
    creds: dict[str, str],
) -> tuple[float, list[dict[str, Any]], str | None]:
    params = _binance_signed_params(
        creds["api_secret"],
        {
            "recvWindow": "5000",
            "timestamp": str(_now_ms()),
        },
    )
    payload = _request_json_allow_statuses(
        "https://fapi.binance.com/fapi/v2/account",
        headers=_binance_headers(creds["api_key"]),
        params=params,
        allowed_statuses={401},
    )
    if not isinstance(payload, dict):
        return 0.0, [], None

    assets: list[dict[str, Any]] = []
    for item in payload.get("assets", []):
        if not isinstance(item, dict):
            continue
        asset = str(item.get("asset", "") or "").strip().upper()
        if not asset:
            continue
        wallet_balance = float(item.get("walletBalance", 0.0) or 0.0)
        margin_balance = float(item.get("marginBalance", 0.0) or 0.0)
        available = float(item.get("availableBalance", 0.0) or 0.0)
        unrealized_profit = float(item.get("unrealizedProfit", 0.0) or 0.0)
        if wallet_balance <= 0 and margin_balance <= 0 and unrealized_profit == 0:
            continue
        usd_value = margin_balance if _is_stable_asset(asset) else 0.0
        _append_asset_row(
            assets,
            name=asset,
            amount=wallet_balance if wallet_balance > 0 else margin_balance,
            available=min(available, wallet_balance if wallet_balance > 0 else margin_balance),
            locked=max((wallet_balance if wallet_balance > 0 else margin_balance) - available, 0.0),
            unit_price=1.0 if _is_stable_asset(asset) else 0.0,
            usd_value=usd_value,
        )

    total_margin_balance = float(payload.get("totalMarginBalance", 0.0) or 0.0)
    if total_margin_balance <= 0:
        total_margin_balance = sum(float(item.get("usd_value", 0.0) or 0.0) for item in assets)
    return total_margin_balance, assets, "binance /fapi/v2/account"


def fetch_binance_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    creds = _load_cex_credentials(wallet)
    total_usd = 0.0
    assets: list[dict[str, Any]] = []
    strategies: list[str] = []

    # Classic mode always has a spot wallet; unified/PM mode keeps one too
    # (just usually empty once funds are transferred into the PM pool), so
    # it's always safe to call.
    spot_total, spot_assets, spot_strategy = _fetch_binance_spot_assets(creds)
    total_usd += spot_total
    assets.extend(spot_assets)
    if spot_strategy:
        strategies.append(spot_strategy)

    # Unified account: /papi/v1/balance returns the PM pool (cross-margin +
    # USDⓂ-M + COIN-M). Classic accounts get 401/403 here → we fall through
    # to the classic /fapi/v2/account futures wallet instead.
    pm_total, pm_assets, pm_strategy = _fetch_binance_portfolio_margin_assets(creds)
    if pm_strategy:
        total_usd += pm_total
        assets.extend(pm_assets)
        strategies.append(pm_strategy)
    else:
        futures_total, futures_assets, futures_strategy = _fetch_binance_futures_assets(creds)
        if futures_strategy:
            total_usd += futures_total
            assets.extend(futures_assets)
            strategies.append(futures_strategy)

    return {
        "balance": total_usd,
        "assets": assets,
        "fetch_strategy": f"{' + '.join(strategies) or 'binance'} via {creds['prefix']}_*",
    }


def _bitget_sign(secret: str, timestamp: str, method: str, request_path: str, query_string: str = "", body: str = "") -> str:
    suffix = f"?{query_string}" if query_string else ""
    prehash = f"{timestamp}{method.upper()}{request_path}{suffix}{body}"
    digest = hmac.new(
        secret.encode("utf-8"),
        prehash.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode("utf-8")


def _bitget_request(
    creds: dict[str, str],
    request_path: str,
    *,
    method: str = "GET",
    params: dict[str, Any] | None = None,
    body: str = "",
) -> Any:
    filtered_params = {
        key: value for key, value in (params or {}).items() if value is not None
    }
    query_string = urllib.parse.urlencode(filtered_params)
    timestamp = str(_now_ms())
    headers = {
        "ACCESS-KEY": creds["api_key"],
        "ACCESS-SIGN": _bitget_sign(
            creds["api_secret"],
            timestamp,
            method,
            request_path,
            query_string,
            body,
        ),
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": creds["passphrase"],
        "locale": "en-US",
        "Content-Type": "application/json",
    }
    return _request_json(
        f"https://api.bitget.com{request_path}",
        method=method,
        headers=headers,
        params=filtered_params,
        body=body,
    )


def _bitget_http_error_payload(exc: urllib.error.HTTPError) -> dict[str, Any]:
    try:
        raw = exc.read().decode("utf-8")
    except Exception:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _bitget_try_request(
    creds: dict[str, str],
    request_path: str,
    *,
    params: dict[str, Any] | None = None,
    allow_failure: bool = False,
) -> tuple[Any | None, str | None]:
    try:
        payload = _bitget_request(creds, request_path, params=params)
    except urllib.error.HTTPError as exc:
        error_payload = _bitget_http_error_payload(exc)
        code = str(error_payload.get("code", "") or "").strip()
        msg = str(error_payload.get("msg", "") or exc.reason).strip()
        detail = f"{request_path} HTTP {exc.code}{f' ({code})' if code else ''}: {msg}"
        if allow_failure:
            return None, detail
        raise RuntimeError(f"Bitget request failed for {detail}") from exc
    except urllib.error.URLError as exc:
        detail = f"{request_path} network error: {exc.reason}"
        if allow_failure:
            return None, detail
        raise RuntimeError(f"Bitget request failed for {detail}") from exc

    if not isinstance(payload, dict):
        detail = f"{request_path} returned non-object response"
        if allow_failure:
            return None, detail
        raise RuntimeError(f"Bitget request failed for {detail}")

    code = str(payload.get("code", "") or "").strip()
    if code and code not in {"0", "00000"}:
        msg = str(payload.get("msg", "") or "unknown error").strip()
        detail = f"{request_path} API error ({code}): {msg}"
        if allow_failure:
            return None, detail
        raise RuntimeError(f"Bitget request failed for {detail}")
    return payload.get("data"), None


def _bitget_finalize_assets(
    assets: list[dict[str, Any]],
    *,
    fallback_total: float,
) -> tuple[list[dict[str, Any]], float]:
    merged: dict[str, dict[str, Any]] = {}
    for item in assets:
        symbol = str(item.get("symbol", "") or "").strip().upper()
        if not symbol:
            continue
        current = merged.get(symbol)
        amount = _to_float(item.get("amount"))
        available = _to_float(item.get("available"))
        locked = _to_float(item.get("locked"))
        usd_value = _to_float(item.get("usd_value"))
        unit_price = _to_float(item.get("unit_price"))
        if current is None:
            current = {
                "name": symbol,
                "symbol": symbol,
                "chain": "bitget",
                "amount": 0.0,
                "available": 0.0,
                "locked": 0.0,
                "unit_price": 0.0,
                "usd_value": 0.0,
            }
            merged[symbol] = current
        current["amount"] += amount
        current["available"] += available
        current["locked"] += locked
        current["usd_value"] += usd_value
        if unit_price > 0:
            current["unit_price"] = unit_price

    missing_symbols: list[str] = []
    for item in merged.values():
        symbol = str(item.get("symbol", "") or "").upper()
        amount = _to_float(item.get("amount"))
        usd_value = _to_float(item.get("usd_value"))
        if amount <= 0 or usd_value > 0 or _is_stable_asset(symbol):
            continue
        missing_symbols.extend(_symbol_candidates(symbol))

    if missing_symbols:
        prices = _fetch_binance_prices(missing_symbols)
        for item in merged.values():
            symbol = str(item.get("symbol", "") or "").upper()
            amount = _to_float(item.get("amount"))
            usd_value = _to_float(item.get("usd_value"))
            if amount <= 0 or usd_value > 0:
                continue
            if _is_stable_asset(symbol):
                item["unit_price"] = 1.0
                item["usd_value"] = amount
                continue
            for candidate in _symbol_candidates(symbol):
                price = _to_float(prices.get(candidate))
                if price > 0:
                    item["unit_price"] = price
                    item["usd_value"] = amount * price
                    break

    final_assets = []
    estimated_total = 0.0
    for item in merged.values():
        amount = _to_float(item.get("amount"))
        usd_value = _to_float(item.get("usd_value"))
        if amount <= 0 and usd_value <= 0:
            continue
        if _is_stable_asset(str(item.get("symbol", "") or "")) and usd_value <= 0:
            usd_value = amount
            item["usd_value"] = amount
            if _to_float(item.get("unit_price")) <= 0:
                item["unit_price"] = 1.0
        if amount > 0 and _to_float(item.get("unit_price")) <= 0 and usd_value > 0:
            item["unit_price"] = usd_value / amount
        estimated_total += _to_float(item.get("usd_value"))
        final_assets.append(item)
    total_usd = max(fallback_total, estimated_total)
    return final_assets, total_usd


def _bitget_accounts_overview_total(data: Any) -> float:
    if not isinstance(data, list):
        return 0.0
    total = 0.0
    for item in data:
        if not isinstance(item, dict):
            continue
        total += _to_float(item.get("usdtBalance"))
    return total


def fetch_bitget_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    creds = _load_cex_credentials(wallet)
    strategies: list[str] = []
    errors: list[str] = []
    aggregated_assets: list[dict[str, Any]] = []
    fallback_total = 0.0

    uta_data, uta_error = _bitget_try_request(
        creds,
        "/api/v3/account/assets",
        allow_failure=True,
    )
    if isinstance(uta_data, dict):
        raw_assets = uta_data.get("assets", [])
        for item in raw_assets if isinstance(raw_assets, list) else []:
            if not isinstance(item, dict):
                continue
            symbol = str(item.get("coin", "") or "").strip().upper()
            amount = _to_float(item.get("equity"))
            available = _to_float(item.get("available"))
            locked = _to_float(item.get("locked"))
            if amount <= 0:
                amount = available + locked
            usd_value = _to_float(item.get("usdValue"))
            aggregated_assets.append(
                {
                    "name": symbol,
                    "symbol": symbol,
                    "chain": "bitget",
                    "amount": amount,
                    "available": available,
                    "locked": locked,
                    "unit_price": usd_value / amount if amount > 0 and usd_value > 0 else 0.0,
                    "usd_value": usd_value,
                }
            )
        fallback_total += _to_float(
            uta_data.get("accountEquity", uta_data.get("usdtEquity", 0.0))
        )
        strategies.append("bitget /api/v3/account/assets")

        funding_data, funding_error = _bitget_try_request(
            creds,
            "/api/v3/account/funding-assets",
            allow_failure=True,
        )
        if isinstance(funding_data, list):
            for item in funding_data:
                if not isinstance(item, dict):
                    continue
                symbol = str(item.get("coin", "") or "").strip().upper()
                available = _to_float(item.get("available"))
                locked = _to_float(item.get("frozen"))
                amount = _to_float(item.get("balance"))
                if amount <= 0:
                    amount = available + locked
                aggregated_assets.append(
                    {
                        "name": symbol,
                        "symbol": symbol,
                        "chain": "bitget",
                        "amount": amount,
                        "available": available,
                        "locked": locked,
                        "unit_price": 1.0 if _is_stable_asset(symbol) else 0.0,
                        "usd_value": amount if _is_stable_asset(symbol) else 0.0,
                    }
                )
            strategies.append("bitget /api/v3/account/funding-assets")
        elif funding_error:
            errors.append(funding_error)
    elif uta_error:
        errors.append(uta_error)

    if not strategies:
        spot_data, spot_error = _bitget_try_request(
            creds,
            "/api/v2/spot/account/assets",
            allow_failure=True,
        )
        if isinstance(spot_data, list):
            for item in spot_data:
                if not isinstance(item, dict):
                    continue
                symbol = str(item.get("coin", "") or "").strip().upper()
                available = _to_float(item.get("available"))
                locked = _to_float(item.get("frozen"))
                amount = _to_float(item.get("balance"))
                if amount <= 0:
                    amount = available + locked
                aggregated_assets.append(
                    {
                        "name": symbol,
                        "symbol": symbol,
                        "chain": "bitget",
                        "amount": amount,
                        "available": available,
                        "locked": locked,
                        "unit_price": 1.0 if _is_stable_asset(symbol) else 0.0,
                        "usd_value": amount if _is_stable_asset(symbol) else 0.0,
                    }
                )
            strategies.append("bitget /api/v2/spot/account/assets")
        elif spot_error:
            errors.append(spot_error)

        for product_type in ("USDT-FUTURES", "COIN-FUTURES", "USDC-FUTURES"):
            mix_data, mix_error = _bitget_try_request(
                creds,
                "/api/v2/mix/account/accounts",
                params={"productType": product_type},
                allow_failure=True,
            )
            if isinstance(mix_data, list):
                for item in mix_data:
                    if not isinstance(item, dict):
                        continue
                    symbol = str(item.get("marginCoin", "") or "").strip().upper()
                    amount = _to_float(item.get("accountEquity"))
                    available = _to_float(
                        item.get("available", item.get("availableBalance", 0.0))
                    )
                    locked = _to_float(item.get("locked"))
                    if amount <= 0:
                        amount = available + locked
                    usd_value = _to_float(
                        item.get("usdtEquity", item.get("accountEquity", 0.0))
                    )
                    aggregated_assets.append(
                        {
                            "name": symbol,
                            "symbol": symbol,
                            "chain": "bitget",
                            "amount": amount,
                            "available": available,
                            "locked": locked,
                            "unit_price": (
                                usd_value / amount
                                if amount > 0 and usd_value > 0
                                else (1.0 if _is_stable_asset(symbol) else 0.0)
                            ),
                            "usd_value": (
                                usd_value
                                if usd_value > 0
                                else (amount if _is_stable_asset(symbol) else 0.0)
                            ),
                        }
                    )
                    fallback_total += usd_value
                strategies.append(f"bitget /api/v2/mix/account/accounts?productType={product_type}")
            elif mix_error:
                errors.append(mix_error)

    earn_data, earn_error = _bitget_try_request(
        creds,
        "/api/v2/earn/account/assets",
        allow_failure=True,
    )
    if isinstance(earn_data, list):
        for item in earn_data:
            if not isinstance(item, dict):
                continue
            symbol = str(item.get("coin", "") or "").strip().upper()
            amount = _to_float(item.get("amount"))
            if amount <= 0:
                continue
            aggregated_assets.append(
                {
                    "name": symbol,
                    "symbol": symbol,
                    "chain": "bitget-earn",
                    "amount": amount,
                    "available": amount,
                    "locked": 0.0,
                    "unit_price": 1.0 if _is_stable_asset(symbol) else 0.0,
                    "usd_value": amount if _is_stable_asset(symbol) else 0.0,
                }
            )
        strategies.append("bitget /api/v2/earn/account/assets")
    elif earn_error:
        errors.append(earn_error)

    overview_data, overview_error = _bitget_try_request(
        creds,
        "/api/v2/account/all-account-balance",
        allow_failure=True,
    )
    overview_total = _bitget_accounts_overview_total(overview_data)
    if overview_total > 0:
        fallback_total = max(fallback_total, overview_total)
        strategies.append("bitget /api/v2/account/all-account-balance")
    elif overview_error:
        errors.append(overview_error)

    if not strategies:
        joined_errors = "; ".join(errors[:4]) or "no supported Bitget account endpoints returned data"
        raise RuntimeError(f"Bitget fetch failed: {joined_errors}")

    assets, total_usd = _bitget_finalize_assets(
        aggregated_assets,
        fallback_total=fallback_total,
    )
    return {
        "balance": total_usd,
        "assets": assets,
        "fetch_strategy": f"{' + '.join(strategies)} via {creds['prefix']}_*",
    }


def _okx_sign(secret: str, timestamp: str, method: str, request_path: str, body: str = "") -> str:
    prehash = f"{timestamp}{method.upper()}{request_path}{body}"
    digest = hmac.new(
        secret.encode("utf-8"),
        prehash.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(digest).decode("utf-8")


def _okx_request(
    creds: dict[str, str],
    request_path: str,
    *,
    method: str = "GET",
    params: dict[str, Any] | None = None,
    body: str = "",
    allow_failure: bool = False,
) -> tuple[Any | None, str | None]:
    filtered_params = {
        key: value for key, value in (params or {}).items() if value is not None
    }
    query_string = urllib.parse.urlencode(filtered_params)
    signed_path = f"{request_path}?{query_string}" if query_string else request_path
    timestamp = _iso_now()
    headers = {
        "OK-ACCESS-KEY": creds["api_key"],
        "OK-ACCESS-SIGN": _okx_sign(creds["api_secret"], timestamp, method, signed_path, body),
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": creds["passphrase"],
        "Content-Type": "application/json",
        # OKX's Cloudflare layer 403s the default Python-urllib UA on authenticated paths.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    }
    try:
        payload = _request_json(
            f"https://www.okx.com{request_path}",
            method=method,
            headers=headers,
            params=filtered_params,
            body=body,
        )
    except urllib.error.HTTPError as exc:
        detail = f"{request_path} HTTP {exc.code}: {exc.reason}"
        if allow_failure:
            return None, detail
        raise RuntimeError(f"OKX request failed for {detail}") from exc
    except urllib.error.URLError as exc:
        detail = f"{request_path} network error: {exc.reason}"
        if allow_failure:
            return None, detail
        raise RuntimeError(f"OKX request failed for {detail}") from exc

    if not isinstance(payload, dict):
        detail = f"{request_path} returned non-object response"
        if allow_failure:
            return None, detail
        raise RuntimeError(f"OKX request failed for {detail}")

    code = str(payload.get("code", "") or "").strip()
    if code and code != "0":
        msg = str(payload.get("msg", "") or "unknown error").strip()
        detail = f"{request_path} API error ({code}): {msg}"
        if allow_failure:
            return None, detail
        raise RuntimeError(f"OKX request failed for {detail}")
    return payload.get("data"), None


def fetch_okx_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    creds = _load_cex_credentials(wallet)
    strategies: list[str] = []
    errors: list[str] = []
    assets: list[dict[str, Any]] = []
    raw_positions: list[dict[str, Any]] = []
    total_balance = 0.0
    # Unit prices discovered from the unified account so funding/earn/staking
    # entries (which return amounts only) can be valued without an extra
    # ticker round-trip when the same currency is held in trading.
    price_index: dict[str, float] = {}

    # 1. Unified Trading Account — required. totalEq already includes
    # cross-margin + uPnl from open positions, so we don't double-count when
    # we list those positions later as informational `kind=pos` rows.
    uta_data, _ = _okx_request(creds, "/api/v5/account/balance", allow_failure=False)
    uta_account: dict[str, Any] = {}
    if isinstance(uta_data, list) and uta_data and isinstance(uta_data[0], dict):
        uta_account = uta_data[0]
    uta_total = _to_float(uta_account.get("totalEq"))
    total_balance += uta_total
    for item in uta_account.get("details", []) or []:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("ccy", "") or "").strip().upper()
        if not symbol:
            continue
        amount = _to_float(item.get("eq") or item.get("cashBal"))
        usd_value = _to_float(item.get("eqUsd"))
        available = _to_float(item.get("availBal") or item.get("cashBal"))
        if amount > 0 and usd_value > 0:
            price_index.setdefault(symbol, usd_value / amount)
        if amount <= 0 and usd_value <= 0:
            continue
        assets.append(
            {
                "name": symbol,
                "symbol": symbol,
                "chain": "okx",
                "amount": amount,
                "available": available,
                "locked": max(amount - available, 0.0),
                "unit_price": (usd_value / amount) if amount > 0 and usd_value > 0 else 0.0,
                "usd_value": usd_value,
            }
        )
    strategies.append("okx /api/v5/account/balance")

    # 2. Open derivatives positions — informational. Equity is already in
    # totalEq, so these are surfaced as `kind=pos` holdings without adding
    # to the account balance.
    pos_data, pos_err = _okx_request(
        creds, "/api/v5/account/positions", allow_failure=True
    )
    if isinstance(pos_data, list):
        for item in pos_data:
            if not isinstance(item, dict):
                continue
            size = _to_float(item.get("pos"))
            notional_usd = abs(_to_float(item.get("notionalUsd")))
            if size == 0 and notional_usd == 0:
                continue
            inst_id = str(item.get("instId", "") or "").strip()
            if not inst_id:
                continue
            raw_positions.append(
                {
                    "exchange": "okx",
                    "instId": inst_id,
                    "instType": str(item.get("instType", "") or "").strip(),
                    "posSide": str(item.get("posSide", "") or "").strip(),
                    "size": size,
                    "avg_price": _to_float(item.get("avgPx")),
                    "mark_price": _to_float(item.get("markPx") or item.get("last")),
                    "notional_usd": notional_usd,
                    "upl": _to_float(item.get("upl")),
                    "leverage": str(item.get("lever", "") or "").strip(),
                    "ccy": str(item.get("ccy", "") or "").strip().upper(),
                    "mgn_mode": str(item.get("mgnMode", "") or "").strip(),
                }
            )
        strategies.append("okx /api/v5/account/positions")
    elif pos_err:
        errors.append(pos_err)

    # 3. Funding account — separate from the trading account, holds deposits.
    funding_data, fund_err = _okx_request(
        creds, "/api/v5/asset/balances", allow_failure=True
    )
    if isinstance(funding_data, list):
        funding_total = 0.0
        for item in funding_data:
            if not isinstance(item, dict):
                continue
            symbol = str(item.get("ccy", "") or "").strip().upper()
            if not symbol:
                continue
            amount = _to_float(item.get("bal"))
            if amount <= 0:
                continue
            available = _to_float(item.get("availBal"))
            locked = _to_float(item.get("frozenBal"))
            unit_price = price_index.get(symbol, 0.0)
            if unit_price <= 0 and _is_stable_asset(symbol):
                unit_price = 1.0
            usd_value = amount * unit_price if unit_price > 0 else 0.0
            assets.append(
                {
                    "name": symbol,
                    "symbol": symbol,
                    "chain": "okx",
                    "amount": amount,
                    "available": available,
                    "locked": locked,
                    "unit_price": unit_price,
                    "usd_value": usd_value,
                }
            )
            funding_total += usd_value
        total_balance += funding_total
        strategies.append("okx /api/v5/asset/balances")
    elif fund_err:
        errors.append(fund_err)

    # 4. Simple Earn — flexible savings positions live outside the UTA.
    savings_data, sav_err = _okx_request(
        creds, "/api/v5/finance/savings/balance", allow_failure=True
    )
    if isinstance(savings_data, list):
        savings_total = 0.0
        for item in savings_data:
            if not isinstance(item, dict):
                continue
            symbol = str(item.get("ccy", "") or "").strip().upper()
            if not symbol:
                continue
            amount = _to_float(item.get("amt"))
            if amount <= 0:
                continue
            unit_price = price_index.get(symbol, 0.0)
            if unit_price <= 0 and _is_stable_asset(symbol):
                unit_price = 1.0
            usd_value = amount * unit_price if unit_price > 0 else 0.0
            assets.append(
                {
                    "name": symbol,
                    "symbol": symbol,
                    "chain": "okx-earn",
                    "amount": amount,
                    "available": amount,
                    "locked": 0.0,
                    "unit_price": unit_price,
                    "usd_value": usd_value,
                }
            )
            savings_total += usd_value
        total_balance += savings_total
        strategies.append("okx /api/v5/finance/savings/balance")
    elif sav_err:
        errors.append(sav_err)

    # 5. Active staking / DeFi orders — also outside the UTA. Each order can
    # commit multiple currencies via `investData`.
    staking_data, stk_err = _okx_request(
        creds,
        "/api/v5/finance/staking-defi/orders-active",
        allow_failure=True,
    )
    if isinstance(staking_data, list):
        staking_total = 0.0
        for order in staking_data:
            if not isinstance(order, dict):
                continue
            invest_list = order.get("investData") or []
            if not isinstance(invest_list, list):
                continue
            for inv in invest_list:
                if not isinstance(inv, dict):
                    continue
                symbol = str(inv.get("ccy", "") or "").strip().upper()
                if not symbol:
                    continue
                amount = _to_float(inv.get("amt"))
                if amount <= 0:
                    continue
                unit_price = price_index.get(symbol, 0.0)
                if unit_price <= 0 and _is_stable_asset(symbol):
                    unit_price = 1.0
                usd_value = amount * unit_price if unit_price > 0 else 0.0
                assets.append(
                    {
                        "name": symbol,
                        "symbol": symbol,
                        "chain": "okx-earn",
                        "amount": amount,
                        "available": 0.0,
                        "locked": amount,
                        "unit_price": unit_price,
                        "usd_value": usd_value,
                    }
                )
                staking_total += usd_value
        total_balance += staking_total
        strategies.append("okx /api/v5/finance/staking-defi/orders-active")
    elif stk_err:
        errors.append(stk_err)

    return {
        "balance": total_balance,
        "assets": assets,
        "positions": raw_positions,
        "fetch_strategy": f"{' + '.join(strategies)} via {creds['prefix']}_*",
        "errors": errors,
    }


def _bybit_sign(secret: str, timestamp: str, api_key: str, recv_window: str, query_string: str) -> str:
    payload = f"{timestamp}{api_key}{recv_window}{query_string}"
    return hmac.new(
        secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def fetch_bybit_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    creds = _load_cex_credentials(wallet)
    timestamp = str(_now_ms())
    recv_window = "5000"
    request_path = "/v5/account/wallet-balance"
    query_string = urllib.parse.urlencode({"accountType": "UNIFIED"})
    headers = {
        "X-BAPI-API-KEY": creds["api_key"],
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recv_window,
        "X-BAPI-SIGN": _bybit_sign(
            creds["api_secret"], timestamp, creds["api_key"], recv_window, query_string
        ),
        "Content-Type": "application/json",
    }
    payload = _request_json(
        f"https://api.bybit.com{request_path}",
        headers=headers,
        params={"accountType": "UNIFIED"},
    )
    result = payload.get("result", {}) if isinstance(payload, dict) else {}
    account_list = result.get("list", []) if isinstance(result, dict) else []
    account = account_list[0] if account_list and isinstance(account_list[0], dict) else {}
    raw_assets = account.get("coin", []) if isinstance(account, dict) else []
    total_usd = float(account.get("totalEquity", 0.0) or 0.0)
    assets = []
    for item in raw_assets:
        if not isinstance(item, dict):
            continue
        amount = float(item.get("equity", item.get("walletBalance", 0.0)) or 0.0)
        usd_value = float(item.get("usdValue", 0.0) or 0.0)
        if amount <= 0 and usd_value <= 0:
            continue
        assets.append(
            {
                "name": str(item.get("coin", "") or "").upper(),
                "symbol": str(item.get("coin", "") or "").upper(),
                "chain": "bybit",
                "amount": amount,
                "available": float(item.get("walletBalance", 0.0) or 0.0),
                "locked": float(item.get("locked", 0.0) or 0.0),
                "unit_price": usd_value / amount if amount > 0 else 0.0,
                "usd_value": usd_value,
            }
        )
    return {
        "balance": total_usd,
        "assets": assets,
        "fetch_strategy": f"bybit /v5/account/wallet-balance via {creds['prefix']}_*",
    }


def _gate_sign(secret: str, method: str, request_url: str, query_string: str, timestamp: str, body: str = "") -> str:
    body_hash = hashlib.sha512(body.encode("utf-8")).hexdigest()
    sign_string = "\n".join([method.upper(), request_url, query_string, body_hash, timestamp])
    return hmac.new(
        secret.encode("utf-8"),
        sign_string.encode("utf-8"),
        hashlib.sha512,
    ).hexdigest()


def _gate_headers(
    api_key: str,
    api_secret: str,
    method: str,
    request_url: str,
    timestamp: str,
    *,
    query_string: str = "",
    body: str = "",
) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "KEY": api_key,
        "Timestamp": timestamp,
        "SIGN": _gate_sign(api_secret, method, request_url, query_string, timestamp, body),
    }


def _gate_balance_amount(entry: dict[str, Any]) -> tuple[float, float, float]:
    def _first_float(payload: dict[str, Any], keys: tuple[str, ...]) -> float:
        for key in keys:
            raw = payload.get(key)
            if raw is None:
                continue
            try:
                return float(raw or 0.0)
            except (TypeError, ValueError):
                continue
        return 0.0

    available = _first_float(entry, ("available", "available_balance", "avail", "free"))
    locked = _first_float(entry, ("freeze", "locked", "frozen", "hold"))
    amount = available + locked
    if amount <= 0:
        amount = _first_float(
            entry,
            ("balance", "total", "amount", "equity", "total_balance", "wallet_balance"),
        )
        if amount > 0 and available <= 0 and locked <= 0:
            available = amount
    return amount, available, locked


def _gate_assets_from_balances(
    balances: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], float]:
    active_assets: list[dict[str, Any]] = []
    gate_assets: list[str] = []
    symbols: list[str] = []
    for currency, entry in balances.items():
        amount, available, locked = _gate_balance_amount(entry)
        normalized_currency = str(currency or "").strip().upper()
        if not normalized_currency:
            continue
        amount_override_raw = entry.get("__amount_override")
        try:
            amount_override = float(amount_override_raw or 0.0)
        except (TypeError, ValueError):
            amount_override = 0.0
        if amount_override > 0 and amount <= 0:
            amount = amount_override
            available = amount_override
            locked = 0.0
        elif amount_override > 0 and amount > 0 and amount_override > amount:
            amount = amount_override
            available = amount_override
            locked = 0.0
        if amount <= 0:
            continue
        active_assets.append(
            {
                "currency": normalized_currency,
                "available": available,
                "locked": locked,
                "amount": amount,
            }
        )
        gate_assets.append(normalized_currency)
        symbols.extend(_symbol_candidates(normalized_currency))

    gate_prices = _fetch_gate_spot_prices(gate_assets)
    binance_prices = _fetch_binance_prices(symbols)
    assets: list[dict[str, Any]] = []
    total_usd = 0.0
    for item in active_assets:
        currency = item["currency"]
        unit_price = 1.0 if _is_stable_asset(currency) else 0.0
        if not unit_price:
            unit_price = float(gate_prices.get(currency, 0.0) or 0.0)
        if not unit_price:
            for symbol in _symbol_candidates(currency):
                if symbol in binance_prices:
                    unit_price = binance_prices[symbol]
                    break
        amount = float(item["amount"] or 0.0)
        available = float(item["available"] or 0.0)
        locked = float(item["locked"] or 0.0)
        usd_value = amount * unit_price
        total_usd += usd_value
        assets.append(
            {
                "name": currency,
                "symbol": currency,
                "chain": "gate",
                "amount": amount,
                "available": available,
                "locked": locked,
                "unit_price": unit_price,
                "usd_value": usd_value,
            }
        )
    return assets, total_usd


def _gate_total_from_unified_payload(payload: dict[str, Any], fallback_total: float) -> float:
    for key in ("total_balance", "unified_account_total", "total"):
        raw_value = payload.get(key)
        if raw_value is None:
            continue
        try:
            return float(raw_value or 0.0)
        except (TypeError, ValueError):
            continue
    return fallback_total


def _fetch_gate_crossex_assets(
    creds: dict[str, str], timestamp: str
) -> tuple[float, list[dict[str, Any]], str | None]:
    crossex_path = "/api/v4/crossex/accounts"
    payload = _request_json_allow_statuses(
        f"https://api.gateio.ws{crossex_path}",
        headers=_gate_headers(
            creds["api_key"],
            creds["api_secret"],
            "GET",
            crossex_path,
            timestamp,
        ),
        allowed_statuses={401, 403, 404},
    )
    if not isinstance(payload, dict):
        return 0.0, [], None

    assets_raw = payload.get("assets", [])
    crossex_balances: dict[str, dict[str, Any]] = {}
    for item in assets_raw if isinstance(assets_raw, list) else []:
        if not isinstance(item, dict):
            continue
        coin = str(item.get("coin", "") or "").strip().upper()
        if not coin:
            continue
        total_balance = float(item.get("balance", 0.0) or 0.0)
        available_balance = float(item.get("available_balance", 0.0) or 0.0)
        crossex_balances[coin] = {
            "available": available_balance,
            "freeze": max(total_balance - available_balance, 0.0),
        }

    assets, estimated_total = _gate_assets_from_balances(crossex_balances)
    for asset in assets:
        asset["chain"] = "gate-crossex"

    try:
        total_usd = float(payload.get("margin_balance", estimated_total) or estimated_total)
    except (TypeError, ValueError):
        total_usd = estimated_total
    delta = total_usd - estimated_total
    if abs(delta) >= 1.0:
        adjusted = False
        for asset in assets:
            symbol = str(asset.get("symbol", "") or "").upper()
            unit_price = float(asset.get("unit_price", 0.0) or 0.0)
            if symbol not in {"USDT", "USDC", "USD"} or unit_price <= 0:
                continue
            asset["usd_value"] = float(asset.get("usd_value", 0.0) or 0.0) + delta
            amount_shift = delta / unit_price
            asset["amount"] = float(asset.get("amount", 0.0) or 0.0) + amount_shift
            asset["available"] = float(asset.get("available", 0.0) or 0.0) + amount_shift
            adjusted = True
            break
        if not adjusted:
            assets.append(
                {
                    "name": "CROSSEX-OTHER",
                    "symbol": "CROSSEX-OTHER",
                    "chain": "gate-crossex",
                    "amount": delta,
                    "available": delta,
                    "locked": 0.0,
                    "unit_price": 1.0,
                    "usd_value": delta,
                }
            )

    return total_usd, assets, "gate /crossex/accounts"


def fetch_gate_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    creds = _load_cex_credentials(wallet)
    timestamp = str(int(datetime.now(tz=UTC).timestamp()))
    unified_path = "/api/v4/unified/accounts"
    unified_payload = _request_json_allow_statuses(
        f"https://api.gateio.ws{unified_path}",
        headers=_gate_headers(
            creds["api_key"],
            creds["api_secret"],
            "GET",
            unified_path,
            timestamp,
        ),
        allowed_statuses={401, 403, 404},
    )
    if isinstance(unified_payload, dict):
        balances_raw = unified_payload.get("balances", {})
        unified_balances: dict[str, dict[str, Any]] = {}
        if isinstance(balances_raw, dict):
            for currency, entry in balances_raw.items():
                if isinstance(currency, str) and isinstance(entry, dict):
                    next_entry = dict(entry)
                    # Gate unified balances expose per-coin equity; use it as quantity when available.
                    next_entry["__amount_override"] = entry.get("equity", 0.0)
                    unified_balances[currency] = next_entry
        elif isinstance(balances_raw, list):
            for item in balances_raw:
                if not isinstance(item, dict):
                    continue
                currency = str(
                    item.get("currency")
                    or item.get("coin")
                    or item.get("asset")
                    or ""
                ).strip().upper()
                if currency:
                    next_entry = dict(item)
                    next_entry["__amount_override"] = item.get("equity", 0.0)
                    unified_balances[currency] = next_entry
        assets, estimated_total = _gate_assets_from_balances(unified_balances)
        total_usd = estimated_total
        crossex_total, crossex_assets, crossex_strategy = _fetch_gate_crossex_assets(
            creds, timestamp
        )
        return {
            "balance": total_usd + crossex_total,
            "assets": assets + crossex_assets,
            "fetch_strategy": (
                f"gate /unified/accounts"
                f"{' + /crossex/accounts' if crossex_strategy else ''}"
                f" via {creds['prefix']}_*"
            ),
        }

    spot_path = "/api/v4/spot/accounts"
    spot_payload = _request_json(
        f"https://api.gateio.ws{spot_path}",
        headers=_gate_headers(
            creds["api_key"],
            creds["api_secret"],
            "GET",
            spot_path,
            timestamp,
        ),
    )
    spot_balances: dict[str, dict[str, Any]] = {}
    for item in spot_payload if isinstance(spot_payload, list) else []:
        if not isinstance(item, dict):
            continue
        currency = str(item.get("currency", "") or "").strip().upper()
        if not currency:
            continue
        spot_balances[currency] = item

    assets, total_usd = _gate_assets_from_balances(spot_balances)

    total_path = "/api/v4/wallet/total_balance"
    total_payload = _request_json_allow_statuses(
        f"https://api.gateio.ws{total_path}",
        headers=_gate_headers(
            creds["api_key"],
            creds["api_secret"],
            "GET",
            total_path,
            timestamp,
        ),
        allowed_statuses={401, 403},
    )
    total_details = total_payload.get("details", {}) if isinstance(total_payload, dict) else {}
    total_usdt = total_usd
    if isinstance(total_details, dict):
        spot_total = total_details.get("spot")
        if isinstance(spot_total, dict):
            total_usdt = float(spot_total.get("amount", total_usd) or total_usd)
    elif isinstance(total_payload, dict):
        total_usdt = float(total_payload.get("total", total_usd) or total_usd)
    crossex_total, crossex_assets, crossex_strategy = _fetch_gate_crossex_assets(
        creds, timestamp
    )

    return {
        "balance": total_usdt + crossex_total,
        "assets": assets + crossex_assets,
        "fetch_strategy": (
            f"gate /spot/accounts priced via market tickers"
            f"{' + /wallet/total_balance' if isinstance(total_payload, dict) else ''}"
            f"{' + /crossex/accounts' if crossex_strategy else ''}"
            f" via {creds['prefix']}_*"
        ),
    }


def fetch_extended_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    creds = _load_cex_credentials(wallet, require_secret=False)
    payload = _request_json_allow_statuses(
        "https://api.starknet.extended.exchange/api/v1/user/balance",
        headers={
            "accept": "application/json",
            "X-Api-Key": creds["api_key"],
        },
        allowed_statuses={404},
    )
    if payload is None:
        return {
            "balance": 0.0,
            "assets": [],
            "fetch_strategy": f"extended /api/v1/user/balance (404 empty) via {creds['prefix']}_*",
        }
    if not isinstance(payload, dict):
        raise RuntimeError("Extended balance request returned non-object response.")
    status = str(payload.get("status", "") or "").strip().upper()
    if status and status != "OK":
        raise RuntimeError(
            f"Extended API error: {str(payload.get('status', '') or '')} {str(payload.get('message', '') or '').strip()}".strip()
        )
    data = payload.get("data", {}) if isinstance(payload, dict) else {}
    if not isinstance(data, dict):
        data = {}
    collateral = str(data.get("collateralName", "USDC") or "USDC").strip().upper()
    equity = _to_float(data.get("equity", data.get("balance", 0.0)))
    available = _to_float(data.get("availableForTrade", 0.0))
    initial_margin = _to_float(data.get("initialMargin", 0.0))
    assets: list[dict[str, Any]] = []
    if equity > 0 or available > 0 or initial_margin > 0:
        assets.append(
            {
                "name": collateral,
                "symbol": collateral,
                "chain": "extended",
                "amount": equity,
                "available": min(available, equity) if equity > 0 else available,
                "locked": max(equity - min(available, equity), 0.0),
                "unit_price": 1.0,
                "usd_value": equity,
            }
        )
    return {
        "balance": equity,
        "assets": assets,
        "fetch_strategy": f"extended /api/v1/user/balance via {creds['prefix']}_*",
    }


def _fetch_hyperliquid_spot_prices() -> dict[str, float]:
    try:
        spot_meta = _request_json(
            "https://api.hyperliquid.xyz/info",
            method="POST",
            headers={"Content-Type": "application/json", "accept": "application/json"},
            body=json.dumps({"type": "spotMeta"}),
        )
        all_mids = _request_json(
            "https://api.hyperliquid.xyz/info",
            method="POST",
            headers={"Content-Type": "application/json", "accept": "application/json"},
            body=json.dumps({"type": "allMids"}),
        )
    except Exception:
        return {}

    if not isinstance(spot_meta, dict) or not isinstance(all_mids, dict):
        return {}
    tokens = spot_meta.get("tokens", [])
    universe = spot_meta.get("universe", [])
    if not isinstance(tokens, list) or not isinstance(universe, list):
        return {}

    token_name_by_index: dict[int, str] = {}
    for token in tokens:
        if not isinstance(token, dict):
            continue
        try:
            idx = int(token.get("index"))
        except (TypeError, ValueError):
            continue
        name = str(token.get("name", "") or "").strip().upper()
        if name:
            token_name_by_index[idx] = name

    spot_prices: dict[str, float] = {}
    for pair in universe:
        if not isinstance(pair, dict):
            continue
        pair_tokens = pair.get("tokens", [])
        if not isinstance(pair_tokens, list) or len(pair_tokens) != 2:
            continue
        try:
            base_idx = int(pair_tokens[0])
            quote_idx = int(pair_tokens[1])
        except (TypeError, ValueError):
            continue
        if quote_idx != 0:  # only * / USDC
            continue
        coin = token_name_by_index.get(base_idx)
        pair_name = str(pair.get("name", "") or "").strip()
        if not coin or not pair_name:
            continue
        price = _to_float(all_mids.get(pair_name))
        if price > 0:
            spot_prices[coin] = price
    return spot_prices


_HYPERLIQUID_HLP_VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"


def fetch_hyperliquid_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    user = str(wallet.get("address", "") or "").strip()
    if not user.lower().startswith("0x") or len(user) != 42:
        raise RuntimeError(
            "Hyperliquid requires wallet address to be a valid 0x... address."
        )
    headers = {"Content-Type": "application/json", "accept": "application/json"}

    clearing = _request_json(
        "https://api.hyperliquid.xyz/info",
        method="POST",
        headers=headers,
        body=json.dumps({"type": "clearinghouseState", "user": user}),
    )
    spot = _request_json(
        "https://api.hyperliquid.xyz/info",
        method="POST",
        headers=headers,
        body=json.dumps({"type": "spotClearinghouseState", "user": user}),
    )
    # Vault deposits (HLP + any user-vaults) are not in clearinghouseState.
    # Tolerate failure here so a vault-API hiccup doesn't break the whole sync.
    try:
        vault_equities = _request_json(
            "https://api.hyperliquid.xyz/info",
            method="POST",
            headers=headers,
            body=json.dumps({"type": "userVaultEquities", "user": user}),
        )
    except Exception:
        vault_equities = []

    perp_account_value = 0.0
    if isinstance(clearing, dict):
        margin_summary = clearing.get("marginSummary", {})
        if isinstance(margin_summary, dict):
            perp_account_value = _to_float(margin_summary.get("accountValue", 0.0))

    spot_prices = _fetch_hyperliquid_spot_prices()
    assets: list[dict[str, Any]] = []
    total_usd = perp_account_value
    if perp_account_value > 0:
        assets.append(
            {
                "name": "PERP-ACCOUNT",
                "symbol": "PERP-ACCOUNT",
                "chain": "hyperliquid",
                "amount": perp_account_value,
                "available": perp_account_value,
                "locked": 0.0,
                "unit_price": 1.0,
                "usd_value": perp_account_value,
            }
        )

    balances = spot.get("balances", []) if isinstance(spot, dict) else []
    for item in balances if isinstance(balances, list) else []:
        if not isinstance(item, dict):
            continue
        coin = str(item.get("coin", "") or "").strip().upper()
        if not coin:
            continue
        amount = _to_float(item.get("total", 0.0))
        hold = _to_float(item.get("hold", 0.0))
        if amount <= 0 and hold <= 0:
            continue
        unit_price = 1.0 if _is_stable_asset(coin) else _to_float(spot_prices.get(coin))
        usd_value = amount * unit_price
        if usd_value <= 0:
            entry_ntl = _to_float(item.get("entryNtl", 0.0))
            if entry_ntl > 0:
                usd_value = entry_ntl
                if amount > 0:
                    unit_price = entry_ntl / amount
        total_usd += usd_value
        assets.append(
            {
                "name": coin,
                "symbol": coin,
                "chain": "hyperliquid-spot",
                "amount": amount,
                "available": max(amount - hold, 0.0),
                "locked": min(hold, amount) if amount > 0 else hold,
                "unit_price": unit_price,
                "usd_value": usd_value,
            }
        )

    if isinstance(vault_equities, list):
        for entry in vault_equities:
            if not isinstance(entry, dict):
                continue
            equity = _to_float(entry.get("equity", 0.0))
            if equity <= 0:
                continue
            vault_addr = str(entry.get("vaultAddress", "") or "").strip().lower()
            if vault_addr == _HYPERLIQUID_HLP_VAULT:
                label = "HLP"
            elif vault_addr:
                label = f"VAULT-{vault_addr[:6]}"
            else:
                label = "VAULT"
            total_usd += equity
            assets.append(
                {
                    "name": label,
                    "symbol": label,
                    "chain": "hyperliquid-vault",
                    "amount": equity,
                    "available": equity,
                    "locked": 0.0,
                    "unit_price": 1.0,
                    "usd_value": equity,
                }
            )

    return {
        "balance": total_usd,
        "assets": assets,
        "fetch_strategy": "hyperliquid info: clearinghouseState + spotClearinghouseState + userVaultEquities (+ allMids/spotMeta)",
    }


def _derive_auth_headers(wallet_address: str, private_key: str) -> dict[str, str]:
    if Account is None or encode_defunct is None:
        raise RuntimeError(
            "Derive integration requires 'eth-account'. Install dependencies with pip install -r requirements.txt."
        )
    timestamp = str(_now_ms())
    message = encode_defunct(text=timestamp)
    signed = Account.sign_message(message, private_key=private_key)
    signature = str(signed.signature.hex() or "")
    if signature and not signature.startswith("0x"):
        signature = f"0x{signature}"
    return {
        "accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Content-Type": "application/json",
        "Origin": "https://insights.derive.xyz",
        "Referer": "https://insights.derive.xyz/",
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "X-LyraWallet": wallet_address,
        "X-LyraTimestamp": timestamp,
        "X-LyraSignature": signature,
    }


def _derive_first_float(payload: dict[str, Any], keys: tuple[str, ...]) -> float:
    for key in keys:
        if key not in payload:
            continue
        value = _to_float(payload.get(key))
        if value != 0.0:
            return value
    return 0.0


def fetch_derive_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    creds = _load_cex_credentials(wallet, require_secret=True, require_api_key=False)
    account_wallet = str(wallet.get("address", "") or "").strip()
    if not account_wallet or not account_wallet.startswith("0x"):
        raise RuntimeError(
            "Derive requires the L2 account wallet address (0x...) in the wallet address field."
        )
    headers = _derive_auth_headers(account_wallet, creds["api_secret"])
    payload = _request_json(
        "https://api.lyra.finance/private/get_account",
        method="POST",
        headers=headers,
        body=json.dumps({"wallet": account_wallet}),
    )
    if not isinstance(payload, dict):
        raise RuntimeError("Derive response was not a JSON object.")
    error_payload = payload.get("error")
    if isinstance(error_payload, dict):
        code = str(error_payload.get("code", "") or "").strip()
        message = str(error_payload.get("message", "") or "").strip()
        raise RuntimeError(
            "Derive API error"
            f"{f' ({code})' if code else ''}: {message or 'unknown error'}"
            f". account_wallet={account_wallet}"
        )
    result = payload.get("result", {})
    if not isinstance(result, dict):
        raise RuntimeError("Derive account response did not include an account object.")

    subaccount_ids_raw = result.get("subaccount_ids", [])
    subaccount_ids: list[int] = []
    if isinstance(subaccount_ids_raw, list):
        for item in subaccount_ids_raw:
            try:
                subaccount_ids.append(int(item))
            except (TypeError, ValueError):
                continue

    assets: list[dict[str, Any]] = []
    positions: list[dict[str, Any]] = []
    total_usd = 0.0
    for subaccount_id in subaccount_ids:
        sub_payload = _request_json(
            "https://api.lyra.finance/private/get_subaccount",
            method="POST",
            headers=headers,
            body=json.dumps({"subaccount_id": subaccount_id}),
        )
        if not isinstance(sub_payload, dict):
            continue
        sub_error = sub_payload.get("error")
        if isinstance(sub_error, dict):
            continue
        sub_result = sub_payload.get("result", {})
        if not isinstance(sub_result, dict):
            continue
        sub_value = _to_float(sub_result.get("subaccount_value", 0.0))
        if sub_value < 0:
            continue
        total_usd += sub_value

        sub_assets_added = 0
        sub_positions_added = 0

        # Collaterals (e.g. USDC) → spot-style asset rows.
        for c in sub_result.get("collaterals") or []:
            if not isinstance(c, dict):
                continue
            asset_name = str(c.get("asset_name") or "").strip()
            if not asset_name:
                continue
            amount = _to_float(c.get("amount", 0.0))
            mark_price = _to_float(c.get("mark_price", 0.0))
            mark_value = _to_float(c.get("mark_value", 0.0))
            if amount == 0 and mark_value == 0:
                continue
            assets.append(
                {
                    "name": asset_name,
                    "symbol": asset_name,
                    "chain": "derive",
                    "amount": amount,
                    "available": amount,
                    "locked": 0.0,
                    "unit_price": mark_price or 1.0,
                    "usd_value": mark_value,
                }
            )
            sub_assets_added += 1

        # Options / perp positions → informational rows. mark_value is signed
        # (negative for shorts); the sync layer formats them as kind="pos".
        for p in sub_result.get("positions") or []:
            if not isinstance(p, dict):
                continue
            instrument = str(p.get("instrument_name") or "").strip()
            if not instrument:
                continue
            amount = _to_float(p.get("amount", 0.0))
            if amount == 0:
                continue
            positions.append(
                {
                    "instrument_name": instrument,
                    "instrument_type": str(p.get("instrument_type") or "").strip().lower(),
                    "amount": amount,
                    "mark_price": _to_float(p.get("mark_price", 0.0)),
                    "mark_value": _to_float(p.get("mark_value", 0.0)),
                    "index_price": _to_float(p.get("index_price", 0.0)),
                    "average_price": _to_float(p.get("average_price", 0.0)),
                    "delta": p.get("delta"),
                    "unrealized_pnl": _to_float(p.get("unrealized_pnl", 0.0)),
                    "leverage": p.get("leverage"),
                }
            )
            sub_positions_added += 1

        # Fallback: API didn't expose a breakdown for this subaccount.
        # Emit the legacy aggregate row so the equity stays visible.
        if sub_value > 0 and sub_assets_added == 0 and sub_positions_added == 0:
            assets.append(
                {
                    "name": f"Derive Subaccount {subaccount_id}",
                    "symbol": f"SUB-{subaccount_id}",
                    "chain": "derive",
                    "amount": sub_value,
                    "available": sub_value,
                    "locked": 0.0,
                    "unit_price": 1.0,
                    "usd_value": sub_value,
                }
            )

    if total_usd <= 0 and not assets and not positions:
        total_usd = _derive_first_float(
            result,
            (
                "portfolio_value",
                "account_value",
                "equity",
                "balance",
                "wallet_balance",
                "cash",
            ),
        )
        if total_usd > 0:
            assets.append(
                {
                    "name": "Derive Account",
                    "symbol": "DERIVE",
                    "chain": "derive",
                    "amount": total_usd,
                    "available": total_usd,
                    "locked": 0.0,
                    "unit_price": 1.0,
                    "usd_value": total_usd,
                }
            )

    return {
        "balance": total_usd,
        "assets": assets,
        "positions": positions,
        "fetch_strategy": (
            f"derive /private/get_account + /private/get_subaccount"
            f" via {creds['prefix']}_*"
        ),
    }


def fetch_cex_assets(wallet: dict[str, Any]) -> dict[str, Any]:
    exchange = str(wallet.get("exchange", "") or "").strip().lower()
    if exchange == "binance":
        return fetch_binance_assets(wallet)
    if exchange == "bitget":
        return fetch_bitget_assets(wallet)
    if exchange == "okx":
        return fetch_okx_assets(wallet)
    if exchange == "bybit":
        return fetch_bybit_assets(wallet)
    if exchange == "gate":
        return fetch_gate_assets(wallet)
    if exchange == "extended":
        return fetch_extended_assets(wallet)
    if exchange == "derive":
        return fetch_derive_assets(wallet)
    if exchange == "hyperliquid":
        return fetch_hyperliquid_assets(wallet)
    raise ValueError(f"Unsupported CEX exchange '{exchange}'.")
