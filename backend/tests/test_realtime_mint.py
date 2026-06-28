"""Tests for parsing the OpenAI Realtime mint response.

GA /v1/realtime/client_secrets returns the secret at top-level "value"; the
legacy /sessions nested it under client_secret.value. Both must work.
"""

import os

# Importing the route module pulls in app.db.engine, which requires DATABASE_URL
# at import (engine is lazy — no connection). Set a dummy so this pure test can
# import it; CI's backend job sets a real one.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/x")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from app.routes.realtime import _client_secret_from_mint  # noqa: E402


def test_ga_top_level_value():
    secret, exp = _client_secret_from_mint({"value": "ek_abc", "expires_at": 123})
    assert secret == "ek_abc"
    assert exp == 123


def test_legacy_nested_client_secret():
    secret, exp = _client_secret_from_mint(
        {"client_secret": {"value": "cs_xyz", "expires_at": 456}}
    )
    assert secret == "cs_xyz"
    assert exp == 456


def test_missing_secret_raises_502():
    with pytest.raises(HTTPException) as ei:
        _client_secret_from_mint({"error": {"message": "Invalid URL"}})
    assert ei.value.status_code == 502


def test_no_expiry_defaults_zero():
    secret, exp = _client_secret_from_mint({"value": "ek_abc"})
    assert secret == "ek_abc"
    assert exp == 0
