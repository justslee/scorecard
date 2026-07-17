"""Text-path ADVICE/SCORE interception — specs/caddie-two-tier-routing-
plan.md §2, §5, §9. `classify_intent` runs server-side BEFORE the Claude
loop on both session voice endpoints: an ADVICE-class ask NEVER reaches
Claude — it routes straight to the one brain (`run_strategy_turn`, the SAME
implementation `/session/strategy` uses); a SCORE-class ask gets the honest
text-path handoff line, no brain call. FACT/OTHER is unaffected — it stays
on the Claude tool loop exactly as before.

DB-free: `get_owned_session` is monkeypatched on the route module, `current_
user_id` is overridden on a throwaway FastAPI() app — same idiom as
`tests/eval/test_strategy_tool.py`'s route-level tests.
"""

from __future__ import annotations

import json
import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.caddie import tools as tools_mod  # noqa: E402
from app.caddie.session import RoundSession  # noqa: E402
from app.routes import caddie as caddie_routes  # noqa: E402
from app.services.clerk_auth import current_user_id  # noqa: E402


def _session() -> RoundSession:
    return RoundSession(round_id="round-1", user_id="user-1", current_hole=1)


class _PoisonedAnthropic:
    """Raises the instant it's constructed — the load-bearing proof that the
    Claude loop never even starts on an intercepted (ADVICE/SCORE) turn."""

    def __init__(self, *args, **kwargs):
        raise AssertionError("Claude must never be constructed for an intercepted turn")


class _FakeUsage:
    cache_read_input_tokens = 0
    cache_creation_input_tokens = 0
    input_tokens = 10
    output_tokens = 5


class _FakeTextBlock:
    def __init__(self, text: str):
        self.text = text


class _FakeMessage:
    def __init__(self, text: str):
        self.content = [_FakeTextBlock(text)]
        self.usage = _FakeUsage()
        self.stop_reason = "end_turn"


class _FakeStream:
    def __init__(self, text: str):
        self._text = text

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def _gen(self):
        yield self._text

    @property
    def text_stream(self):
        return self._gen()

    async def get_final_message(self):
        return _FakeMessage(self._text)


class _FakeMessages:
    def __init__(self, text: str):
        self._text = text

    def stream(self, **kwargs):
        return _FakeStream(self._text)


class _FakeClaudeAnthropic:
    """Answers normally — proves the Claude loop DOES still run for a
    FACT/OTHER-class turn."""

    def __init__(self, *args, **kwargs):
        self.messages = _FakeMessages("It's blowing about 8 out of the west.")


async def _fake_personality_visible_always(persona_id, user_id=None):
    return True


async def _fake_load_personality_classic(persona_id):
    from app.caddie.types import CaddiePersonality

    return CaddiePersonality(
        id="classic", name="Classic", description="", avatar="🏌️",
        system_prompt="Classic system prompt.",
    )


async def _noop_set_current_hole(round_id, hole_number):
    return None


async def _no_memories(user_id):
    return []


async def _noop_append_message_pair(round_id, user_content, assistant_content, hole_number=None):
    return None


def _client(monkeypatch, session: RoundSession) -> TestClient:
    """DB-free, mirroring `test_guide_consumption.py`'s `_patch_session_
    builder_deps` — every DB touchpoint `_build_session_voice_prompt` (the
    FACT/OTHER path) and the interception branches (ADVICE/SCORE, which
    persist via `sessions.append_message_pair`) can reach is stubbed."""

    async def _fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", _fake_get_owned_session)
    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible_always)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_personality_classic)
    monkeypatch.setattr(caddie_routes.sessions, "set_current_hole", _noop_set_current_hole)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _no_memories)
    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _noop_append_message_pair)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")

    app = FastAPI()
    app.include_router(caddie_routes.router)
    app.dependency_overrides[current_user_id] = lambda: "user-1"
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_strategy_cache():
    from app.caddie import strategy as strategy_mod

    strategy_mod._CACHE.clear()
    yield
    strategy_mod._CACHE.clear()


def _fake_run_strategy_turn(strategy_text: str, calls: list):
    async def _fake(session, round_id, user_id, hole, **kwargs):
        calls.append((round_id, hole))
        return {
            "available": True, "hole_number": hole, "strategy": strategy_text,
            "degraded": False, "reason": None, "numbers": {},
        }

    return _fake


# ── /session/voice (JSON) ───────────────────────────────────────────────────


async def test_session_voice_advice_ask_routes_to_brain_and_never_calls_claude(monkeypatch):
    session = _session()
    client = _client(monkeypatch, session)
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _PoisonedAnthropic)
    calls: list = []
    monkeypatch.setattr(
        caddie_routes, "run_strategy_turn", _fake_run_strategy_turn("Hit driver, aim center, commit.", calls)
    )

    res = client.post(
        "/api/caddie/session/voice",
        json={
            "round_id": "round-1", "transcript": "What should I hit off this tee?",
            "personality_id": "classic", "hole_number": 1,
        },
    )

    assert res.status_code == 200
    assert res.json()["response"] == "Hit driver, aim center, commit."
    assert calls == [("round-1", 1)]


async def test_session_voice_fact_ask_stays_on_claude_loop(monkeypatch):
    session = _session()
    client = _client(monkeypatch, session)
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _FakeClaudeAnthropic)
    calls: list = []
    monkeypatch.setattr(caddie_routes, "run_strategy_turn", _fake_run_strategy_turn("SHOULD NEVER BE SPOKEN", calls))

    async def _fake_append_message_pair(round_id, user_content, assistant_content, hole_number=None):
        return None

    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _fake_append_message_pair)

    res = client.post(
        "/api/caddie/session/voice",
        json={
            "round_id": "round-1", "transcript": "How's the wind?",
            "personality_id": "classic", "hole_number": 1,
        },
    )

    assert res.status_code == 200
    assert res.json()["response"] == "It's blowing about 8 out of the west."
    assert calls == []  # the brain was never called


async def test_session_voice_score_ask_returns_honest_handoff_line_and_never_calls_brain(monkeypatch):
    session = _session()
    client = _client(monkeypatch, session)
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _PoisonedAnthropic)
    calls: list = []
    monkeypatch.setattr(caddie_routes, "run_strategy_turn", _fake_run_strategy_turn("SHOULD NEVER BE SPOKEN", calls))

    res = client.post(
        "/api/caddie/session/voice",
        json={
            "round_id": "round-1", "transcript": "I made a 5",
            "personality_id": "classic", "hole_number": 1,
        },
    )

    assert res.status_code == 200
    assert res.json()["response"] == caddie_routes._SCORE_TEXT_HANDOFF_LINE
    assert calls == []


async def test_advice_turn_persists_message_pair_like_normal_turns(monkeypatch):
    session = _session()
    client = _client(monkeypatch, session)
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _PoisonedAnthropic)
    calls: list = []
    monkeypatch.setattr(
        caddie_routes, "run_strategy_turn", _fake_run_strategy_turn("Hit driver, aim center, commit.", calls)
    )

    persisted: list = []

    async def _fake_append_message_pair(round_id, user_content, assistant_content, hole_number=None):
        persisted.append((round_id, user_content, assistant_content, hole_number))

    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _fake_append_message_pair)

    res = client.post(
        "/api/caddie/session/voice",
        json={
            "round_id": "round-1", "transcript": "What should I hit off this tee?",
            "personality_id": "classic", "hole_number": 1,
        },
    )

    assert res.status_code == 200
    assert persisted == [
        ("round-1", "What should I hit off this tee?", "Hit driver, aim center, commit.", 1)
    ]


# ── /session/voice/stream (SSE) ──────────────────────────────────────────────


def _parse_sse(body: str) -> list[tuple[str, object]]:
    events: list[tuple[str, object]] = []
    for block in body.strip("\n").split("\n\n"):
        if not block.strip():
            continue
        lines = block.split("\n")
        event = lines[0].removeprefix("event: ")
        data = json.loads(lines[1].removeprefix("data: "))
        events.append((event, data))
    return events


async def test_session_voice_stream_advice_emits_reading_the_hole_status_then_brain_text(monkeypatch):
    session = _session()
    client = _client(monkeypatch, session)
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _PoisonedAnthropic)
    calls: list = []
    monkeypatch.setattr(
        caddie_routes, "run_strategy_turn", _fake_run_strategy_turn("Hit driver, aim center, commit.", calls)
    )

    async def _fake_append_message_pair(round_id, user_content, assistant_content, hole_number=None):
        return None

    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _fake_append_message_pair)

    with client.stream(
        "POST",
        "/api/caddie/session/voice/stream",
        json={
            "round_id": "round-1", "transcript": "What should I hit off this tee?",
            "personality_id": "classic", "hole_number": 1,
        },
    ) as res:
        body = "".join(res.iter_text())

    events = _parse_sse(body)
    assert events[0] == ("status", "reading the hole")
    assert events[1] == ("token", "Hit driver, aim center, commit.")
    assert events[-1] == ("done", {})
    assert calls == [("round-1", 1)]


# ── TEXT_TOOLS prompt-cache pin (plan D7) ────────────────────────────────────


def test_text_tools_constant_byte_identical():
    """Complements eval/test_tool_parity.py::test_text_tools_are_a_schema_
    equal_subset_of_realtime — pins that NEITHER realtime-only tool
    (get_strategy, record_scores) ever leaks into TEXT_TOOLS: mutating it
    would bust the text mouth's cached prompt prefix mid-round (plan D7)."""
    encoded = json.dumps(tools_mod.TEXT_TOOLS, sort_keys=True)
    assert "get_strategy" not in encoded
    assert "record_scores" not in encoded
