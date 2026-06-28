"""Tests for the AWS Secrets Manager → env loader (no real AWS; fake client)."""

import json

import pytest

from app.services.secrets import load_secrets_into_env


class _FakeClient:
    def __init__(self, payload):
        self._payload = payload
        self.requested = None

    def get_secret_value(self, SecretId):  # noqa: N803 — boto3 kwarg name
        self.requested = SecretId
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    # Make sure the keys under test aren't already in the env.
    for k in ("DEEPGRAM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.delenv("LOOPER_SECRETS_DISABLED", raising=False)
    monkeypatch.delenv("LOOPER_SECRETS_NAME", raising=False)


def test_loads_json_keys_into_env(monkeypatch):
    client = _FakeClient(
        {"SecretString": json.dumps({"DEEPGRAM_API_KEY": "dg", "OPENAI_API_KEY": "oa"})}
    )
    loaded = load_secrets_into_env("looper/prod", client=client)
    assert set(loaded) == {"DEEPGRAM_API_KEY", "OPENAI_API_KEY"}
    import os

    assert os.environ["DEEPGRAM_API_KEY"] == "dg"
    assert os.environ["OPENAI_API_KEY"] == "oa"
    assert client.requested == "looper/prod"


def test_does_not_override_existing_env(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "already-set")
    client = _FakeClient(
        {"SecretString": json.dumps({"DEEPGRAM_API_KEY": "from-sm", "OPENAI_API_KEY": "oa"})}
    )
    loaded = load_secrets_into_env("looper/prod", client=client)
    import os

    assert os.environ["DEEPGRAM_API_KEY"] == "already-set"  # explicit env wins
    assert "DEEPGRAM_API_KEY" not in loaded
    assert os.environ["OPENAI_API_KEY"] == "oa"  # gap still filled


def test_access_denied_is_noop(monkeypatch):
    client = _FakeClient(RuntimeError("AccessDeniedException"))
    assert load_secrets_into_env("looper/prod", client=client) == []


def test_non_json_secret_is_noop(monkeypatch):
    client = _FakeClient({"SecretString": "not-json"})
    assert load_secrets_into_env("looper/prod", client=client) == []


def test_non_object_json_is_noop(monkeypatch):
    client = _FakeClient({"SecretString": json.dumps(["a", "b"])})
    assert load_secrets_into_env("looper/prod", client=client) == []


def test_disabled_flag_skips(monkeypatch):
    monkeypatch.setenv("LOOPER_SECRETS_DISABLED", "1")
    client = _FakeClient({"SecretString": json.dumps({"DEEPGRAM_API_KEY": "dg"})})
    assert load_secrets_into_env("looper/prod", client=client) == []


def test_secret_name_from_env(monkeypatch):
    monkeypatch.setenv("LOOPER_SECRETS_NAME", "custom/name")
    client = _FakeClient({"SecretString": json.dumps({"OPENAI_API_KEY": "oa"})})
    load_secrets_into_env(client=client)
    assert client.requested == "custom/name"
