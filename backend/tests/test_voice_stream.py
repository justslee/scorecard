"""Tests for the caddie voice SSE streaming twins
(specs/voice-streaming-replies-plan.md) — no network, no Postgres.

Covers (plan §7.1, backend):
  - `_sse_reply` emits `event: token` per delta + one `event: done`.
  - Session flavor persists the COMPLETE assembled text via
    `sessions.append_message_pair`; stateless flavor never persists.
  - A mid-stream exception yields exactly one `event: error` carrying
    `_CADDIE_ERROR_DETAIL` (never `str(e)`/traceback) and does NOT persist.
  - An empty `text_stream` persists + sends the "Say that once more?"
    fallback (mirrors the non-streaming `_first_text(...) or "..."` guard).
  - Route-level gates run BEFORE the stream: missing ANTHROPIC_API_KEY -> a
    normal JSON 500, and a non-visible persona downgrades to classic —
    exercised via `_build_session_voice_prompt` / `_build_voice_prompt`
    directly (mocked `get_owned_session` / `personality_visible`, no DB).
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.caddie.session import RoundSession
from app.caddie.types import CaddiePersonality, HoleIntelligence, HoleStrategyGuide, VoiceCaddieRequest
from app.db.models import CaddieMemory, PlayerProfile
from app.routes import caddie as caddie_routes
from app.services.clerk_auth import current_user_id


# ── Fakes for anthropic.AsyncAnthropic ──────────────────────────────────────


class _FakeMessageUsage:
    """Minimal stand-in for the Anthropic `usage` object on a final message."""

    def __init__(self, cache_read=0, cache_creation=0, input_tokens=0, output_tokens=0):
        self.cache_read_input_tokens = cache_read
        self.cache_creation_input_tokens = cache_creation
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeFinalMessage:
    def __init__(self, text: str, usage: _FakeMessageUsage):
        self.content = [type("Block", (), {"text": text})()]
        self.usage = usage


class _FakeAsyncStream:
    """Async context manager mimicking AsyncMessageStreamManager."""

    def __init__(self, tokens: list[str], exc: Exception | None = None):
        self._tokens = tokens
        self._exc = exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def _gen(self):
        for t in self._tokens:
            yield t
        if self._exc is not None:
            raise self._exc

    @property
    def text_stream(self):
        return self._gen()

    async def get_final_message(self):
        """Final aggregated message + usage — the caching plan's usage-log
        hook (specs/caddie-prompt-caching-text-path-plan.md §4)."""
        return _FakeFinalMessage("".join(self._tokens), _FakeMessageUsage())


class _FakeMessages:
    def __init__(self, tokens: list[str], exc: Exception | None = None):
        self._tokens = tokens
        self._exc = exc
        self.captured_kwargs: dict | None = None

    def stream(self, **kwargs):
        self.captured_kwargs = kwargs
        return _FakeAsyncStream(self._tokens, self._exc)


class _FakeAsyncAnthropic:
    """Stand-in for anthropic.AsyncAnthropic — captures the last instance's
    `.messages` so tests can assert on captured_kwargs."""

    last_messages: "_FakeMessages | None" = None

    def __init__(self, api_key=None, timeout=None, max_retries=None):
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.messages = _FakeMessages(_FakeAsyncAnthropic._tokens, _FakeAsyncAnthropic._exc)
        _FakeAsyncAnthropic.last_messages = self.messages
        _FakeAsyncAnthropic.last_instance = self

    # Test hook: configure the class before constructing the route.
    _tokens: list[str] = []
    _exc: Exception | None = None
    last_instance: "_FakeAsyncAnthropic | None" = None


def _make_fake_anthropic(tokens: list[str], exc: Exception | None = None):
    _FakeAsyncAnthropic._tokens = tokens
    _FakeAsyncAnthropic._exc = exc
    return _FakeAsyncAnthropic


async def _collect(agen) -> list[str]:
    return [chunk async for chunk in agen]


def _flat_system(system: list[dict]) -> str:
    """Flatten the two-block prompt-cache `system` list back to one string
    for substring assertions — the builders now return
    `[stable_block, volatile_block]` (specs/caddie-prompt-caching-text-path-plan.md)
    instead of a single string."""
    return "\n".join(block["text"] for block in system)


def _parse_sse(frames: list[str]) -> list[tuple[str, object]]:
    """Parse `event: X\\ndata: Y\\n\\n` frames into (event, decoded-json-data)."""
    parsed = []
    for frame in frames:
        lines = frame.strip("\n").split("\n")
        event = lines[0].removeprefix("event: ")
        data_line = lines[1].removeprefix("data: ")
        parsed.append((event, json.loads(data_line)))
    return parsed


# ── _sse_reply (unit) ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sse_reply_emits_token_per_delta_then_done(monkeypatch):
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _make_fake_anthropic(["Easy ", "7-iron."]))

    frames = await _collect(
        caddie_routes._sse_reply(
            "fake-key", "system prompt", [{"role": "user", "content": "what club?"}],
            log_context="test",
        )
    )
    events = _parse_sse(frames)
    assert events == [("token", "Easy "), ("token", "7-iron."), ("done", {})]


@pytest.mark.asyncio
async def test_sse_reply_uses_identical_model_params(monkeypatch):
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _make_fake_anthropic(["hi"]))
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")

    await _collect(
        caddie_routes._sse_reply("fake-key", "sys", [{"role": "user", "content": "x"}], log_context="test")
    )
    kwargs = _FakeAsyncAnthropic.last_messages.captured_kwargs
    assert kwargs["model"] == "claude-sonnet-4-5-20250929"
    assert kwargs["max_tokens"] == 300
    assert kwargs["temperature"] == 0.7
    assert kwargs["system"] == "sys"


@pytest.mark.asyncio
async def test_sse_reply_constructs_client_with_timeout_and_retries(monkeypatch):
    """specs/caddie-prompt-caching-text-path-plan.md §3 (folded
    caddie-llm-timeouts-retries item) — bounded timeout + one SDK-native
    retry on the async client used by every streaming reply."""
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _make_fake_anthropic(["hi"]))

    await _collect(
        caddie_routes._sse_reply("fake-key", "sys", [{"role": "user", "content": "x"}], log_context="test")
    )
    instance = _FakeAsyncAnthropic.last_instance
    assert instance.timeout == caddie_routes._CADDIE_TIMEOUT_S
    assert instance.max_retries == caddie_routes._CADDIE_MAX_RETRIES


@pytest.mark.asyncio
async def test_sse_reply_session_flavor_persists_complete_text(monkeypatch):
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _make_fake_anthropic(["Take the ", "8-iron."]))
    captured = {}

    async def _fake_append_message_pair(round_id, user_content, assistant_content, hole_number=None):
        captured["round_id"] = round_id
        captured["user_content"] = user_content
        captured["assistant_content"] = assistant_content
        captured["hole_number"] = hole_number

    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _fake_append_message_pair)

    frames = await _collect(
        caddie_routes._sse_reply(
            "fake-key", "sys", [{"role": "user", "content": "what club?"}],
            log_context="test", round_id="round-1", transcript="what club?", hole_number=5,
        )
    )
    events = _parse_sse(frames)
    assert events[-1] == ("done", {})
    assert captured["round_id"] == "round-1"
    assert captured["user_content"] == "what club?"
    assert captured["assistant_content"] == "Take the 8-iron."  # COMPLETE assembled text
    assert captured["hole_number"] == 5


@pytest.mark.asyncio
async def test_sse_reply_stateless_flavor_never_persists(monkeypatch):
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _make_fake_anthropic(["Nice shot."]))
    append_spy_called = False

    async def _fake_append_message_pair(*args, **kwargs):
        nonlocal append_spy_called
        append_spy_called = True

    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _fake_append_message_pair)

    frames = await _collect(
        caddie_routes._sse_reply("fake-key", "sys", [{"role": "user", "content": "hi"}], log_context="test")
    )
    events = _parse_sse(frames)
    assert events == [("token", "Nice shot."), ("done", {})]
    assert append_spy_called is False


@pytest.mark.asyncio
async def test_sse_reply_mid_stream_error_yields_single_calm_error_and_never_persists(monkeypatch):
    boom = RuntimeError("some internal traceback detail — never leak this")
    monkeypatch.setattr(
        caddie_routes.anthropic, "AsyncAnthropic", _make_fake_anthropic(["Partial "], exc=boom)
    )
    append_spy_called = False

    async def _fake_append_message_pair(*args, **kwargs):
        nonlocal append_spy_called
        append_spy_called = True

    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _fake_append_message_pair)

    frames = await _collect(
        caddie_routes._sse_reply(
            "fake-key", "sys", [{"role": "user", "content": "hi"}],
            log_context="test", round_id="round-1", transcript="hi", hole_number=1,
        )
    )
    events = _parse_sse(frames)
    # One token made it out before the exception, then exactly one error frame — no `done`.
    assert events == [("token", "Partial "), ("error", caddie_routes._CADDIE_ERROR_DETAIL)]
    assert "traceback" not in events[-1][1].lower()
    assert "runtimeerror" not in events[-1][1].lower()
    assert append_spy_called is False


def _make_auth_error() -> Exception:
    """anthropic.AuthenticationError needs a real httpx.Response to construct
    in this SDK version — build the minimal one rather than hand-wave the signature."""
    import httpx
    import anthropic

    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(401, request=request, json={"error": {"message": "bad key"}})
    return anthropic.AuthenticationError("bad key", response=response, body=None)


@pytest.mark.asyncio
async def test_sse_reply_auth_error_yields_calm_error(monkeypatch):
    monkeypatch.setattr(
        caddie_routes.anthropic, "AsyncAnthropic", _make_fake_anthropic([], exc=_make_auth_error())
    )

    frames = await _collect(
        caddie_routes._sse_reply("bad-key", "sys", [{"role": "user", "content": "hi"}], log_context="test")
    )
    events = _parse_sse(frames)
    assert events == [("error", caddie_routes._CADDIE_ERROR_DETAIL)]


@pytest.mark.asyncio
async def test_sse_reply_empty_stream_persists_and_sends_fallback(monkeypatch):
    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _make_fake_anthropic([]))
    captured = {}

    async def _fake_append_message_pair(round_id, user_content, assistant_content, hole_number=None):
        captured["assistant_content"] = assistant_content

    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _fake_append_message_pair)

    frames = await _collect(
        caddie_routes._sse_reply(
            "fake-key", "sys", [{"role": "user", "content": "..."}],
            log_context="test", round_id="round-1", transcript="...", hole_number=1,
        )
    )
    events = _parse_sse(frames)
    assert events == [("done", {})]  # no token frames at all
    assert captured["assistant_content"] == "Say that once more? I want to get this right."


# ── Route-level gates run before any streaming (no DB) ──────────────────────


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(caddie_routes.router)
    app.dependency_overrides[current_user_id] = lambda: "test-user"
    return TestClient(app)


def test_session_voice_stream_500s_before_streaming_when_api_key_missing(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    client = _make_client()
    res = client.post(
        "/api/caddie/session/voice/stream",
        json={"round_id": "round-1", "transcript": "hi", "personality_id": "classic", "hole_number": 1},
    )
    assert res.status_code == 500
    assert res.headers["content-type"].startswith("application/json")


def test_voice_stream_500s_before_streaming_when_api_key_missing(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    client = _make_client()
    res = client.post(
        "/api/caddie/voice/stream",
        json={"transcript": "hi", "personality_id": "classic", "hole_number": 1},
    )
    assert res.status_code == 500
    assert res.headers["content-type"].startswith("application/json")


def test_session_voice_stream_404s_before_streaming_when_round_not_owned(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")

    async def _fake_get_owned_session(round_id, user_id):
        raise HTTPException(404, "Round not found")

    monkeypatch.setattr(caddie_routes, "get_owned_session", _fake_get_owned_session)
    client = _make_client()
    res = client.post(
        "/api/caddie/session/voice/stream",
        json={"round_id": "round-1", "transcript": "hi", "personality_id": "classic", "hole_number": 1},
    )
    assert res.status_code == 404


# ── Gate-level: persona downgrade to classic (mocked, no DB) ────────────────


@pytest.mark.asyncio
async def test_build_voice_prompt_downgrades_invisible_persona_to_classic(monkeypatch):
    async def _fake_personality_visible(persona_id, user_id=None):
        return False  # every persona is "invisible" to this caller

    loaded_ids = []

    async def _fake_load_personality(persona_id):
        loaded_ids.append(persona_id)
        return CaddiePersonality(
            id=persona_id, name="Classic", description="", avatar="🏌️",
            system_prompt="Classic system prompt.",
        )

    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_personality)

    request = VoiceCaddieRequest(transcript="hi", personality_id="someone-elses-custom-persona", hole_number=1)
    system, messages, persona_id = await caddie_routes._build_voice_prompt(request, "user-1")

    assert persona_id == "classic"
    assert loaded_ids == ["classic"]
    assert "Classic system prompt." in _flat_system(system)
    assert messages[-1] == {"role": "user", "content": "hi"}


@pytest.mark.asyncio
async def test_build_session_voice_prompt_downgrades_invisible_persona_to_classic(monkeypatch):
    session = RoundSession(round_id="round-1", user_id="user-1", current_hole=1)

    async def _fake_get_owned_session(round_id, user_id):
        return session

    async def _fake_personality_visible(persona_id, user_id=None):
        return False

    loaded_ids = []

    async def _fake_load_personality(persona_id):
        loaded_ids.append(persona_id)
        return CaddiePersonality(
            id=persona_id, name="Classic", description="", avatar="🏌️",
            system_prompt="Classic system prompt.",
        )

    async def _noop_set_current_hole(round_id, hole_number):
        return None

    async def _fake_get_top_memories(user_id):
        return []

    monkeypatch.setattr(caddie_routes, "get_owned_session", _fake_get_owned_session)
    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_personality)
    monkeypatch.setattr(caddie_routes.sessions, "set_current_hole", _noop_set_current_hole)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _fake_get_top_memories)

    request = caddie_routes.SessionVoiceRequest(
        round_id="round-1", transcript="what club?", personality_id="someone-elses-custom-persona",
        hole_number=4,
    )
    system, messages, persona_id = await caddie_routes._build_session_voice_prompt(request, "user-1")

    assert persona_id == "classic"
    assert loaded_ids == ["classic"]
    assert "Classic system prompt." in _flat_system(system)
    # Reworded by specs/caddie-yardage-gps-selected-tee-plan.md §2.4 — the
    # yardage-context line now leads with "Hole N, ..." instead of the old
    # bare "Current hole: #N".
    assert "Hole 4," in _flat_system(system)
    assert messages[-1] == {"role": "user", "content": "what club?"}


# ── Strategy guide: both-mouth injection (caddie-hole-strategy-guides Slice 1) ──


async def _fake_load_classic_personality(persona_id):
    return CaddiePersonality(
        id=persona_id, name="Classic", description="", avatar="🏌️",
        system_prompt="Classic system prompt.",
    )


async def _noop_set_current_hole(round_id, hole_number):
    return None


async def _no_memories(user_id):
    return []


@pytest.mark.asyncio
async def test_build_session_voice_prompt_includes_guide_line_when_present(monkeypatch):
    session = RoundSession(
        round_id="round-1",
        user_id="user-1",
        current_hole=7,
        hole_intel={
            7: HoleIntelligence(
                hole_number=7,
                par=4,
                yards=410,
                strategy_guide=HoleStrategyGuide(
                    play_line="Favor the left side off the tee.",
                    miss_side="Bail out short-right.",
                ),
            )
        },
    )

    async def _fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", _fake_get_owned_session)
    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible_always)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_classic_personality)
    monkeypatch.setattr(caddie_routes.sessions, "set_current_hole", _noop_set_current_hole)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _no_memories)

    request = caddie_routes.SessionVoiceRequest(
        round_id="round-1", transcript="what club?", personality_id="classic", hole_number=7,
    )
    system, _, _ = await caddie_routes._build_session_voice_prompt(request, "user-1")

    assert "Local knowledge: Favor the left side off the tee." in _flat_system(system)


@pytest.mark.asyncio
async def test_build_session_voice_prompt_omits_guide_line_when_absent(monkeypatch):
    """No guide (the Slice 1 default) -> the line is simply omitted, never a
    placeholder ([[no-fake-data-fallbacks]])."""
    session = RoundSession(
        round_id="round-1",
        user_id="user-1",
        current_hole=7,
        hole_intel={7: HoleIntelligence(hole_number=7, par=4, yards=410, strategy_guide=None)},
    )

    async def _fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", _fake_get_owned_session)
    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible_always)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_classic_personality)
    monkeypatch.setattr(caddie_routes.sessions, "set_current_hole", _noop_set_current_hole)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _no_memories)

    request = caddie_routes.SessionVoiceRequest(
        round_id="round-1", transcript="what club?", personality_id="classic", hole_number=7,
    )
    system, _, _ = await caddie_routes._build_session_voice_prompt(request, "user-1")

    assert "Local knowledge:" not in _flat_system(system)


# ── Gate-level: _build_voice_prompt personal grounding (brain parity) ──────
# specs/looper-brain-parity-plan.md — the off-course orb (and the stateless
# in-round fallback) must carry the same cross-round memory + handicap the
# session caddie has, and must degrade gracefully (never break the reply)
# when the DB reads fail.


async def _fake_personality_visible_always(persona_id, user_id=None):
    return True


async def _fake_load_personality_classic(persona_id):
    return CaddiePersonality(
        id=persona_id, name="Classic", description="", avatar="🏌️",
        system_prompt="Classic system prompt.",
    )


def _patch_persona(monkeypatch):
    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible_always)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_personality_classic)


@pytest.mark.asyncio
async def test_build_voice_prompt_grounds_in_memory_and_profile_handicap(monkeypatch):
    _patch_persona(monkeypatch)

    async def _fake_get_top_memories(user_id):
        return [CaddieMemory(user_id=user_id, kind="tendency", summary="misses approaches short")]

    async def _fake_get_player_profile(user_id):
        return PlayerProfile(user_id=user_id, handicap=12)

    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _fake_get_top_memories)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_player_profile", _fake_get_player_profile)

    request = VoiceCaddieRequest(transcript="how do I play this hole?", personality_id="classic", hole_number=None)
    system, _messages, _persona_id = await caddie_routes._build_voice_prompt(request, "user-1")

    expected_bullet = caddie_routes.memory_mod.render_memories_for_prompt(
        [CaddieMemory(user_id="user-1", kind="tendency", summary="misses approaches short")]
    )
    flat = _flat_system(system)
    assert "--- PLAYER MEMORY ---" in flat
    assert expected_bullet in flat
    assert "Player handicap: 12" in flat


@pytest.mark.asyncio
async def test_build_voice_prompt_no_memory_no_profile_stays_clean(monkeypatch):
    _patch_persona(monkeypatch)

    async def _fake_get_top_memories(user_id):
        return []

    async def _fake_get_player_profile(user_id):
        return None

    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _fake_get_top_memories)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_player_profile", _fake_get_player_profile)

    request = VoiceCaddieRequest(transcript="hi", personality_id="classic", hole_number=None)
    system, _messages, _persona_id = await caddie_routes._build_voice_prompt(request, "user-1")

    flat = _flat_system(system)
    assert "Classic system prompt." in flat
    # POSITIONING_SHOT_RULE (appended last, specs/caddie-shot-context-
    # reachability-plan.md §6) now closes the STABLE block (system[0]),
    # which carries the cache breakpoint — the volatile CURRENT SITUATION
    # block (system[1]) renders after it. YARDAGE_GROUNDING_RULE and
    # OBSERVED_REALITY_RULE still land right before it.
    assert caddie_routes.HAZARD_GROUNDING_RULE in system[0]["text"]
    assert caddie_routes.OBSERVED_REALITY_RULE in system[0]["text"]
    assert caddie_routes.YARDAGE_GROUNDING_RULE in system[0]["text"]
    assert system[0]["text"].rstrip().endswith(caddie_routes.POSITIONING_SHOT_RULE)
    assert "--- PLAYER MEMORY ---" not in flat
    assert "handicap" not in flat.lower()


@pytest.mark.asyncio
async def test_build_voice_prompt_degrades_when_memory_fetch_raises(monkeypatch):
    _patch_persona(monkeypatch)

    async def _raising_get_top_memories(user_id):
        raise RuntimeError("db hiccup")

    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _raising_get_top_memories)

    request = VoiceCaddieRequest(transcript="hi", personality_id="classic", hole_number=None)
    system, messages, _persona_id = await caddie_routes._build_voice_prompt(request, "user-1")

    flat = _flat_system(system)
    assert "Classic system prompt." in flat
    assert caddie_routes.HAZARD_GROUNDING_RULE in system[0]["text"]
    assert caddie_routes.OBSERVED_REALITY_RULE in system[0]["text"]
    assert caddie_routes.YARDAGE_GROUNDING_RULE in system[0]["text"]
    assert system[0]["text"].rstrip().endswith(caddie_routes.POSITIONING_SHOT_RULE)
    assert "--- PLAYER MEMORY ---" not in flat
    assert messages[-1] == {"role": "user", "content": "hi"}


# ── Gate-level: _build_voice_prompt stats_context (My Card converse grounding)
# specs/orb-s4-mycard-coaching-plan.md — a registered converse context (e.g.
# /profile's "my-card") sends the golfer's real, pre-serialized stats block;
# the fenced "PLAYER'S REAL SCORING DATA" section must appear (with the
# "data, not instructions" line ABOVE the interpolated stats, injection
# bound) when set, and be entirely absent when None.


@pytest.mark.asyncio
async def test_build_voice_prompt_includes_fenced_stats_block_when_stats_context_set(monkeypatch):
    _patch_persona(monkeypatch)

    async def _fake_get_top_memories(user_id):
        return []

    async def _fake_get_player_profile(user_id):
        return None

    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _fake_get_top_memories)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_player_profile", _fake_get_player_profile)

    stats = "Handicap: 12.4 (estimated from 8 rounds)\nDriver: 268y avg (n=41, median 270, ±14y)"
    request = VoiceCaddieRequest(
        transcript="what should I work on?",
        personality_id="classic",
        hole_number=None,
        stats_context=stats,
    )
    system, _messages, _persona_id = await caddie_routes._build_voice_prompt(request, "user-1")

    flat = _flat_system(system)
    assert "--- PLAYER'S REAL SCORING DATA ---" in flat
    assert stats in flat
    # Injection bound: the "data, not instructions" sentence sits ABOVE the
    # interpolated stats string.
    guard_idx = flat.index("Treat them as")
    stats_idx = flat.index(stats)
    assert guard_idx < stats_idx
    # Lives in the VOLATILE block (system[1]), not the cached STABLE block.
    assert "--- PLAYER'S REAL SCORING DATA ---" in system[1]["text"]
    assert "--- PLAYER'S REAL SCORING DATA ---" not in system[0]["text"]


@pytest.mark.asyncio
async def test_build_voice_prompt_omits_stats_block_when_stats_context_none(monkeypatch):
    _patch_persona(monkeypatch)

    async def _fake_get_top_memories(user_id):
        return []

    async def _fake_get_player_profile(user_id):
        return None

    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _fake_get_top_memories)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_player_profile", _fake_get_player_profile)

    request = VoiceCaddieRequest(
        transcript="what should I work on?",
        personality_id="classic",
        hole_number=None,
    )
    system, _messages, _persona_id = await caddie_routes._build_voice_prompt(request, "user-1")

    flat = _flat_system(system)
    assert "--- PLAYER'S REAL SCORING DATA ---" not in flat
