"""Symmetric encryption for at-rest secrets (CEX API keys, wallet private keys).

We use ``cryptography.Fernet`` (AES-128-CBC + HMAC-SHA256) with a master key
loaded from the ``SECRETS_KEY`` env var. All ciphertext carries a small
version prefix so we can:

  - tell encrypted values apart from legacy plaintext rows during migration
  - rotate the key later without breaking old rows (bump to ``enc:v2:`` and
    keep a second Fernet around)

Generate a new key with::

    python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'

and put it in ``.env`` as ``SECRETS_KEY=…``. Losing the key means losing every
user's stored credentials — back it up out-of-band, not next to the DB."""
from __future__ import annotations

import logging
import os

from cryptography.fernet import Fernet, InvalidToken

_log = logging.getLogger(__name__)

_PREFIX = "enc:v1:"
_fernet: Fernet | None = None


def _load_key() -> bytes:
    raw = (os.getenv("SECRETS_KEY") or "").strip()
    if not raw:
        raise RuntimeError(
            "SECRETS_KEY is not set. Generate one with "
            "`python -c 'from cryptography.fernet import Fernet; "
            "print(Fernet.generate_key().decode())'` and add it to .env."
        )
    return raw.encode("ascii")


def _f() -> Fernet:
    # Lazy so `import app.crypto` doesn't crash at import time when the key
    # is missing — failures surface the first time a credential is actually
    # touched, with a clear message.
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_key())
    return _fernet


def assert_key_loaded() -> None:
    """Force-load the encryption key so a missing/invalid SECRETS_KEY fails
    at app startup rather than on the first credential read/write hours
    later. Idempotent — safe to call from lifespan hooks."""
    _f()


def is_encrypted(value: str | None) -> bool:
    return bool(value) and value.startswith(_PREFIX)


def encrypt(plaintext: str | None) -> str:
    """Encrypt ``plaintext``. Empty / None passes through unchanged so
    optional credential fields stay empty instead of becoming ciphertext of
    the empty string."""
    if not plaintext:
        return ""
    if plaintext.startswith(_PREFIX):
        # Already encrypted — don't double-wrap. Defensive; callers should
        # never pass ciphertext back in, but migrations can race.
        return plaintext
    token = _f().encrypt(plaintext.encode("utf-8")).decode("ascii")
    return _PREFIX + token


def decrypt(value: str | None) -> str:
    """Decrypt ``value``. Values without the ``enc:v1:`` prefix are returned
    as-is — that's how legacy plaintext rows survive the upgrade until the
    one-shot migration rewrites them."""
    if not value:
        return ""
    if not value.startswith(_PREFIX):
        return value  # legacy plaintext row
    token = value[len(_PREFIX):]
    try:
        return _f().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        # Wrong key (rotated without re-encrypt) or tampered ciphertext.
        # Returning "" makes the sync surface "credentials not set" to the
        # user instead of a 500 from the ORM. The operator still sees the
        # encrypted row in the DB — nothing is lost. Log loudly so a botched
        # SECRETS_KEY rotation doesn't sit invisible while every user's
        # syncs silently break.
        _log.error(
            "decrypt: InvalidToken — SECRETS_KEY may have been rotated "
            "without re-encrypting cex_credentials. Sync will report "
            "'credentials not set' for affected accounts until restored."
        )
        return ""
