"""DeBank Cloud API client — EVM wallet balances + DeFi positions."""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

TOTAL_BALANCE_URL = "https://pro-openapi.debank.com/v1/user/total_balance"
ALL_TOKEN_LIST_URL = "https://pro-openapi.debank.com/v1/user/all_token_list"
COMPLEX_APP_LIST_URL = "https://pro-openapi.debank.com/v1/user/complex_app_list"


def _fetch_json(
    base_url: str,
    params: dict[str, Any],
    access_key: str,
    timeout: float = 30.0,
) -> Any:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{base_url}?{query}",
        headers={"accept": "application/json", "AccessKey": access_key},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _expect_object(data: Any, endpoint: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError(f"Expected an object from {endpoint}")
    return data


def _expect_object_list(data: Any, endpoint: str) -> list[dict[str, Any]]:
    if not isinstance(data, list):
        raise ValueError(f"Expected a list from {endpoint}")
    return [item for item in data if isinstance(item, dict)]


def fetch_total_balance(
    address: str, access_key: str, timeout: float = 30.0
) -> dict[str, Any]:
    data = _fetch_json(TOTAL_BALANCE_URL, {"id": address}, access_key, timeout)
    return _expect_object(data, "/v1/user/total_balance")


def fetch_all_token_list(
    address: str,
    access_key: str,
    timeout: float = 30.0,
    is_all: bool = True,
) -> list[dict[str, Any]]:
    data = _fetch_json(
        ALL_TOKEN_LIST_URL,
        {"id": address, "is_all": str(is_all).lower()},
        access_key,
        timeout,
    )
    return _expect_object_list(data, "/v1/user/all_token_list")


def fetch_complex_app_list(
    address: str, access_key: str, timeout: float = 30.0
) -> list[dict[str, Any]]:
    data = _fetch_json(COMPLEX_APP_LIST_URL, {"id": address}, access_key, timeout)
    return _expect_object_list(data, "/v1/user/complex_app_list")
