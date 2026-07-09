"""Tests for prompt-cache restructuring of the caddie voice prompts
(specs/caddie-prompt-caching-text-path-plan.md) — no network, no Postgres.

Covers (plan §6):
  1. `system` is a list; `cache_control` on `system[0]` only.
  2. Stable-before-volatile ordering.
  3. Brain-regression guard: rendered content is line-set-identical to the
     OLD single-string template, modulo ordering + the one pointer reword.
  4. Cache-usage logging fires (sync).
  5. Cache-usage logging fires (stream) + SSE frames unchanged.
  6. The `system` list is what reaches the SDK (sync + stream).
  7. Timeout/retry constructor args.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

import json

import pytest

from app.caddie.hazards import HAZARD_GROUNDING_RULE
from app.caddie.session import RoundSession
from app.caddie.types import CaddiePersonality, VoiceCaddieRequest
from app.caddie.voice_prompts import OBSERVED_REALITY_RULE
from app.routes import caddie as caddie_routes


# ── Shared fakes (mirrors test_voice_stream.py patterns) ────────────────────


async def _fake_personality_visible_always(persona_id, user_id=None):
    return True


async def _fake_load_personality_classic(persona_id):
    return CaddiePersonality(
        id=persona_id, name="Classic", description="", avatar="🏌️",
        system_prompt="Classic system prompt.",
    )


async def _noop_set_current_hole(round_id, hole_number):
    return None


async def _no_memories(user_id):
    return []


def _patch_session_builder_deps(monkeypatch, session: RoundSession):
    async def _fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", _fake_get_owned_session)
    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible_always)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_personality_classic)
    monkeypatch.setattr(caddie_routes.sessions, "set_current_hole", _noop_set_current_hole)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _no_memories)


def _patch_voice_prompt_deps(monkeypatch):
    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible_always)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_personality_classic)

    async def _fake_get_top_memories(user_id):
        return []

    async def _fake_get_player_profile(user_id):
        return None

    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _fake_get_top_memories)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_player_profile", _fake_get_player_profile)


# ── 1 & 2: system is a two-block list, breakpoint on stable block only ─────


@pytest.mark.asyncio
async def test_session_voice_prompt_system_is_two_block_list_with_breakpoint(monkeypatch):
    session = RoundSession(round_id="round-1", user_id="user-1", current_hole=4)
    _patch_session_builder_deps(monkeypatch, session)

    request = caddie_routes.SessionVoiceRequest(
        round_id="round-1", transcript="what club?", personality_id="classic", hole_number=4,
    )
    system, messages, persona_id = await caddie_routes._build_session_voice_prompt(request, "user-1")

    assert isinstance(system, list)
    assert len(system) == 2
    assert system[0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in system[1]
    assert persona_id == "classic"
    assert messages[-1] == {"role": "user", "content": "what club?"}


@pytest.mark.asyncio
async def test_session_voice_prompt_stable_before_volatile_ordering(monkeypatch):
    session = RoundSession(round_id="round-1", user_id="user-1", current_hole=4)
    _patch_session_builder_deps(monkeypatch, session)

    request = caddie_routes.SessionVoiceRequest(
        round_id="round-1", transcript="what club?", personality_id="classic", hole_number=4,
    )
    system, _messages, _persona_id = await caddie_routes._build_session_voice_prompt(request, "user-1")

    assert "Classic system prompt." in system[0]["text"]
    assert "--- INSTRUCTIONS ---" in system[0]["text"]
    assert HAZARD_GROUNDING_RULE in system[0]["text"]
    assert "--- CURRENT SITUATION ---" not in system[0]["text"]
    assert system[1]["text"].startswith("--- CURRENT SITUATION ---")
    assert "Current hole: #4" in system[1]["text"]


@pytest.mark.asyncio
async def test_voice_prompt_system_is_two_block_list_with_breakpoint(monkeypatch):
    _patch_voice_prompt_deps(monkeypatch)

    request = VoiceCaddieRequest(transcript="hi", personality_id="classic", hole_number=1)
    system, messages, persona_id = await caddie_routes._build_voice_prompt(request, "user-1")

    assert isinstance(system, list)
    assert len(system) == 2
    assert system[0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in system[1]
    assert persona_id == "classic"
    assert messages[-1] == {"role": "user", "content": "hi"}


@pytest.mark.asyncio
async def test_voice_prompt_stable_before_volatile_ordering(monkeypatch):
    _patch_voice_prompt_deps(monkeypatch)

    request = VoiceCaddieRequest(transcript="hi", personality_id="classic", hole_number=1)
    system, _messages, _persona_id = await caddie_routes._build_voice_prompt(request, "user-1")

    assert "Classic system prompt." in system[0]["text"]
    assert "--- INSTRUCTIONS ---" in system[0]["text"]
    assert HAZARD_GROUNDING_RULE in system[0]["text"]
    assert "--- CURRENT SITUATION ---" not in system[0]["text"]
    assert system[1]["text"].startswith("--- CURRENT SITUATION ---")


# ── 3: brain-regression guard — content-identical modulo order + reword ────


_OLD_SESSION_TEMPLATE = """{persona}
{memory_section}
--- CURRENT SITUATION ---
{context}

--- INSTRUCTIONS ---
You are caddying for this golfer right now, on the course. Respond to their question or comment.
Your reply is SPOKEN ALOUD on the course: keep it to 2-3 short sentences max unless they ask for
more detail. Plain speech only — never use markdown, asterisks, bullet lists, headings, or emoji.
One clear recommendation beats a pep talk. If they ask about club selection, aim, or strategy,
use the context above to give specific, actionable advice — and when the hole context shows an
uphill/downhill change or a plays-like distance, factor it in and SAY it briefly ("plays more
like 195 with the climb"). Any "Local knowledge" line is written for golfers in general — filter
it through THIS player's real distances before repeating it: a hazard beyond their reach off the
tee is irrelevant (don't mention it); talk about what's in play at THEIR landing zone. A 300-yard
driver doesn't care about a bunker at 370. If they're just chatting, be personable but keep it
golf-focused. Never break character.
You have memory of the entire round conversation and prior rounds. Reference earlier holes/shots
or known tendencies when relevant.

{hazard_rule}
{observed_reality_rule}"""


_OLD_STATELESS_TEMPLATE = """{persona}
{memory_section}
--- CURRENT SITUATION ---
{context}

--- INSTRUCTIONS ---
You are caddying for this golfer right now, on the course. Respond to their question or comment.
Your reply is SPOKEN ALOUD on the course: keep it to 2-3 short sentences max unless they ask for
more detail. Plain speech only — never use markdown, asterisks, bullet lists, headings, or emoji.
One clear recommendation beats a pep talk. If they ask about club selection, aim, or strategy,
use the context above to give specific, actionable advice — and when the hole context shows an
uphill/downhill change or a plays-like distance, factor it in and SAY it briefly ("plays more
like 195 with the climb"). Any "Local knowledge" line is written for golfers in general — filter
it through THIS player's real distances before repeating it: a hazard beyond their reach off the
tee is irrelevant (don't mention it); talk about what's in play at THEIR landing zone. A 300-yard
driver doesn't care about a bunker at 370. If they're just chatting, be personable but keep it
golf-focused. Never break character.

{hazard_rule}
{observed_reality_rule}"""


def _normalized_line_set(text: str) -> set[str]:
    """Set of non-empty, stripped lines — order-independent content compare,
    with the ONE meaning-preserving pointer reword normalized away."""
    normalized = text.replace(
        "use the context above to give specific, actionable advice",
        "use the CURRENT SITUATION section to give specific, actionable advice",
    )
    return {line.strip() for line in normalized.splitlines() if line.strip()}


@pytest.mark.asyncio
async def test_session_voice_prompt_content_identical_to_old_template_modulo_order(monkeypatch):
    session = RoundSession(round_id="round-1", user_id="user-1", current_hole=4)
    _patch_session_builder_deps(monkeypatch, session)

    request = caddie_routes.SessionVoiceRequest(
        round_id="round-1", transcript="what club?", personality_id="classic", hole_number=4,
    )
    system, _messages, _persona_id = await caddie_routes._build_session_voice_prompt(request, "user-1")

    new_flat = system[0]["text"] + "\n" + system[1]["text"]
    old_flat = _OLD_SESSION_TEMPLATE.format(
        persona="Classic system prompt.",
        memory_section="",
        context="Current hole: #4",
        hazard_rule=HAZARD_GROUNDING_RULE,
        observed_reality_rule=OBSERVED_REALITY_RULE,
    )
    assert _normalized_line_set(new_flat) == _normalized_line_set(old_flat)


@pytest.mark.asyncio
async def test_voice_prompt_content_identical_to_old_template_modulo_order(monkeypatch):
    _patch_voice_prompt_deps(monkeypatch)

    request = VoiceCaddieRequest(transcript="hi", personality_id="classic", hole_number=1, par=4, yards=400)
    system, _messages, _persona_id = await caddie_routes._build_voice_prompt(request, "user-1")

    new_flat = system[0]["text"] + "\n" + system[1]["text"]
    old_flat = _OLD_STATELESS_TEMPLATE.format(
        persona="Classic system prompt.",
        memory_section="",
        context="Current hole: #1, Par 4, 400 yards",
        hazard_rule=HAZARD_GROUNDING_RULE,
        observed_reality_rule=OBSERVED_REALITY_RULE,
    )
    assert _normalized_line_set(new_flat) == _normalized_line_set(old_flat)


# ── Fakes for anthropic.Anthropic (sync) ────────────────────────────────────


class _FakeUsage:
    def __init__(self, cache_read=7, cache_creation=11, input_tokens=42, output_tokens=13):
        self.cache_read_input_tokens = cache_read
        self.cache_creation_input_tokens = cache_creation
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeTextBlock:
    def __init__(self, text: str):
        self.text = text


class _FakeMessage:
    def __init__(self, text: str, usage: _FakeUsage):
        self.content = [_FakeTextBlock(text)]
        self.usage = usage


class _FakeSyncMessages:
    def __init__(self, text: str, usage: _FakeUsage):
        self._text = text
        self._usage = usage
        self.captured_kwargs: dict | None = None

    def create(self, **kwargs):
        self.captured_kwargs = kwargs
        return _FakeMessage(self._text, self._usage)


class _FakeSyncAnthropic:
    """Stand-in for anthropic.Anthropic — captures constructor kwargs and the
    last instance's `.messages` so tests can assert on captured_kwargs."""

    last_instance: "_FakeSyncAnthropic | None" = None
    _text: str = "Take the 7-iron."
    _usage: _FakeUsage = _FakeUsage()

    def __init__(self, api_key=None, timeout=None, max_retries=None):
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.messages = _FakeSyncMessages(_FakeSyncAnthropic._text, _FakeSyncAnthropic._usage)
        _FakeSyncAnthropic.last_instance = self

    @classmethod
    def configure(cls, text: str = "Take the 7-iron.", usage: _FakeUsage | None = None):
        cls._text = text
        cls._usage = usage or _FakeUsage()


def _make_client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.services.clerk_auth import current_user_id

    app = FastAPI()
    app.include_router(caddie_routes.router)
    app.dependency_overrides[current_user_id] = lambda: "test-user"
    return TestClient(app)


# ── 4 & 6 (sync): usage logging fires + system list reaches the SDK ────────


def test_session_voice_logs_cache_usage_and_sends_system_list(monkeypatch, caplog):
    session = RoundSession(round_id="round-1", user_id="user-1", current_hole=4)
    _patch_session_builder_deps(monkeypatch, session)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")

    async def _fake_append_message_pair(round_id, user_content, assistant_content, hole_number=None):
        return None

    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _fake_append_message_pair)

    _FakeSyncAnthropic.configure(
        text="Take the 7-iron.",
        usage=_FakeUsage(cache_read=100, cache_creation=0, input_tokens=20, output_tokens=9),
    )
    monkeypatch.setattr(caddie_routes.anthropic, "Anthropic", _FakeSyncAnthropic)

    client = _make_client()
    with caplog.at_level("INFO", logger="looper.caddie"):
        res = client.post(
            "/api/caddie/session/voice",
            json={"round_id": "round-1", "transcript": "what club?", "personality_id": "classic", "hole_number": 4},
        )
    assert res.status_code == 200
    assert res.json()["response"] == "Take the 7-iron."

    kwargs = _FakeSyncAnthropic.last_instance.messages.captured_kwargs
    assert isinstance(kwargs["system"], list)
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "cache_control" not in kwargs["system"][1]

    usage_records = [r for r in caplog.records if r.getMessage() == "caddie_usage"]
    assert len(usage_records) == 1
    rec = usage_records[0]
    assert rec.caddie_context == "session_voice"
    assert rec.persona_id == "classic"
    assert rec.cache_read_input_tokens == 100
    assert rec.cache_creation_input_tokens == 0
    assert rec.input_tokens == 20
    assert rec.output_tokens == 9


def test_voice_caddie_logs_cache_usage_and_sends_system_list(monkeypatch, caplog):
    _patch_voice_prompt_deps(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")

    _FakeSyncAnthropic.configure(
        text="Nice shot.",
        usage=_FakeUsage(cache_read=0, cache_creation=250, input_tokens=15, output_tokens=6),
    )
    monkeypatch.setattr(caddie_routes.anthropic, "Anthropic", _FakeSyncAnthropic)

    client = _make_client()
    with caplog.at_level("INFO", logger="looper.caddie"):
        res = client.post(
            "/api/caddie/voice",
            json={"transcript": "hi", "personality_id": "classic", "hole_number": 1},
        )
    assert res.status_code == 200

    kwargs = _FakeSyncAnthropic.last_instance.messages.captured_kwargs
    assert isinstance(kwargs["system"], list)
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}

    usage_records = [r for r in caplog.records if r.getMessage() == "caddie_usage"]
    assert len(usage_records) == 1
    rec = usage_records[0]
    assert rec.caddie_context == "voice_caddie"
    assert rec.cache_creation_input_tokens == 250


# ── 7: timeout/retry constructor args ───────────────────────────────────────


def test_session_voice_constructs_sync_client_with_timeout_and_retries(monkeypatch):
    session = RoundSession(round_id="round-1", user_id="user-1", current_hole=1)
    _patch_session_builder_deps(monkeypatch, session)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key")

    async def _fake_append_message_pair(round_id, user_content, assistant_content, hole_number=None):
        return None

    monkeypatch.setattr(caddie_routes.sessions, "append_message_pair", _fake_append_message_pair)

    _FakeSyncAnthropic.configure()
    monkeypatch.setattr(caddie_routes.anthropic, "Anthropic", _FakeSyncAnthropic)

    client = _make_client()
    res = client.post(
        "/api/caddie/session/voice",
        json={"round_id": "round-1", "transcript": "hi", "personality_id": "classic", "hole_number": 1},
    )
    assert res.status_code == 200
    assert _FakeSyncAnthropic.last_instance.timeout == caddie_routes._CADDIE_TIMEOUT_S
    assert _FakeSyncAnthropic.last_instance.max_retries == caddie_routes._CADDIE_MAX_RETRIES


@pytest.mark.asyncio
async def test_sse_reply_constructs_async_client_with_timeout_and_retries(monkeypatch):
    captured = {}

    class _FakeAsyncStream:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info):
            return False

        @property
        def text_stream(self):
            async def _gen():
                yield "hi"

            return _gen()

        async def get_final_message(self):
            return _FakeMessage("hi", _FakeUsage())

    class _FakeMessages:
        def stream(self, **kwargs):
            return _FakeAsyncStream()

    class _FakeAsyncAnthropicWithRetries:
        def __init__(self, api_key=None, timeout=None, max_retries=None):
            captured["timeout"] = timeout
            captured["max_retries"] = max_retries
            self.messages = _FakeMessages()

    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _FakeAsyncAnthropicWithRetries)

    frames = [
        chunk
        async for chunk in caddie_routes._sse_reply(
            "fake-key", [{"type": "text", "text": "sys"}], [{"role": "user", "content": "hi"}],
            log_context="test",
        )
    ]
    assert frames  # sanity: stream still produced frames
    assert captured["timeout"] == caddie_routes._CADDIE_TIMEOUT_S
    assert captured["max_retries"] == caddie_routes._CADDIE_MAX_RETRIES


# ── 5 & 6 (stream): cache-usage logging fires, frames unchanged, system reaches SDK ──


@pytest.mark.asyncio
async def test_sse_reply_logs_cache_usage_and_frames_unchanged(monkeypatch, caplog):
    class _FakeAsyncStream:
        def __init__(self, tokens, usage):
            self._tokens = tokens
            self._usage = usage

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info):
            return False

        async def _gen(self):
            for t in self._tokens:
                yield t

        @property
        def text_stream(self):
            return self._gen()

        async def get_final_message(self):
            return _FakeMessage("".join(self._tokens), self._usage)

    usage = _FakeUsage(cache_read=55, cache_creation=0, input_tokens=8, output_tokens=3)

    class _FakeMessages:
        def __init__(self):
            self.captured_kwargs = None

        def stream(self, **kwargs):
            self.captured_kwargs = kwargs
            return _FakeAsyncStream(["Easy ", "7-iron."], usage)

    fake_messages = _FakeMessages()

    class _FakeAsyncAnthropic:
        def __init__(self, api_key=None, timeout=None, max_retries=None):
            self.messages = fake_messages

    monkeypatch.setattr(caddie_routes.anthropic, "AsyncAnthropic", _FakeAsyncAnthropic)

    system_blocks = [
        {"type": "text", "text": "stable", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "volatile"},
    ]

    with caplog.at_level("INFO", logger="looper.caddie"):
        frames = [
            chunk
            async for chunk in caddie_routes._sse_reply(
                "fake-key", system_blocks, [{"role": "user", "content": "what club?"}],
                log_context="test_stream", persona_id="strategist",
            )
        ]

    def _parse(frame: str):
        lines = frame.strip("\n").split("\n")
        return lines[0].removeprefix("event: "), json.loads(lines[1].removeprefix("data: "))

    events = [_parse(f) for f in frames]
    assert events == [("token", "Easy "), ("token", "7-iron."), ("done", {})]

    assert fake_messages.captured_kwargs["system"] is system_blocks

    usage_records = [r for r in caplog.records if r.getMessage() == "caddie_usage"]
    assert len(usage_records) == 1
    rec = usage_records[0]
    assert rec.caddie_context == "test_stream"
    assert rec.persona_id == "strategist"
    assert rec.cache_read_input_tokens == 55
