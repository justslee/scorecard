"""Unit tests for the bounded server-side tool loop
(app/caddie/tool_loop.py — specs/caddie-tool-loop-parity-plan.md D4/D8d).

No network, no Postgres. A scripted fake Anthropic client drives the loop
through its STRUCTURAL stops: the loop counter + tool_choice:"none" final
call, the repeated-identical-call guard, the output-token budget, per-tool
timeout/error containment, and the one-user-message parallel-results rule.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import asyncio  # noqa: E402
import json  # noqa: E402

from app.caddie import tool_loop as tool_loop_mod  # noqa: E402
from app.caddie.tool_loop import run_caddie_turn  # noqa: E402
from app.caddie.tools import TEXT_TOOLS, ToolContext  # noqa: E402


# ── Scripted fake Anthropic client ──────────────────────────────────────────


class _Usage:
    def __init__(self, output_tokens=10):
        self.output_tokens = output_tokens
        self.input_tokens = 0
        self.cache_read_input_tokens = 0
        self.cache_creation_input_tokens = 0


class _TextBlock:
    type = "text"

    def __init__(self, text):
        self.text = text


class _ToolUseBlock:
    type = "tool_use"

    def __init__(self, name, input, id):
        self.name = name
        self.input = input
        self.id = id


class _Final:
    def __init__(self, content, stop_reason, output_tokens=10):
        self.content = content
        self.stop_reason = stop_reason
        self.usage = _Usage(output_tokens)


def _tool_turn(name="get_carries", args=None, block_id="tu_1", output_tokens=10, extra_blocks=None):
    blocks = [_ToolUseBlock(name, args or {"hole_number": 4}, block_id)]
    if extra_blocks:
        blocks += extra_blocks
    return ([], _Final(blocks, "tool_use", output_tokens))


def _text_turn(tokens, output_tokens=10):
    return (tokens, _Final([_TextBlock("".join(tokens))], "end_turn", output_tokens))


class _FakeStream:
    def __init__(self, tokens, final):
        self._tokens = tokens
        self._final = final

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
        return self._final


class _FakeClient:
    """`script` is a list of (tokens, final) responses, one per model call.
    If the script runs out, the last entry repeats (a 'tool-forever' model)."""

    def __init__(self, script):
        self._script = script
        self.calls: list[dict] = []

        outer = self

        class _Messages:
            def stream(self, **kwargs):
                outer.calls.append(kwargs)
                idx = min(len(outer.calls) - 1, len(outer._script) - 1)
                tokens, final = outer._script[idx]
                return _FakeStream(tokens, final)

        self.messages = _Messages()


def _stateless_ctx() -> ToolContext:
    return ToolContext(session=None, round_id=None, user_id="u1", default_hole=4)


async def _run(client, ctx=None, on_usage=None):
    events = []
    async for evt in run_caddie_turn(
        client, "test-model", "sys", [{"role": "user", "content": "hi"}],
        ctx or _stateless_ctx(), on_usage=on_usage,
    ):
        events.append(evt)
    return events


# ── Structural stops ─────────────────────────────────────────────────────────


async def test_tool_forever_model_stops_at_max_calls_with_tool_choice_none():
    """A model that calls tools on every turn (with FRESH args each time, so
    the repeat guard never trips) gets exactly _MAX_MODEL_CALLS calls, and
    the last one structurally forbids tools."""
    client = _FakeClient([
        _tool_turn(args={"hole_number": 1}, block_id="tu_1"),
        _tool_turn(args={"hole_number": 2}, block_id="tu_2"),
        _tool_turn(args={"hole_number": 3}, block_id="tu_3"),  # non-compliant: ignores tool_choice
    ])
    events = await _run(client)

    assert len(client.calls) == tool_loop_mod._MAX_MODEL_CALLS
    assert "tool_choice" not in client.calls[0]
    assert "tool_choice" not in client.calls[1]
    assert client.calls[-1]["tool_choice"] == {"type": "none"}
    # Even against the non-compliant fake, the loop ends with a done event.
    assert events[-1][0] == "done"


async def test_tools_always_passed_and_constant_across_calls():
    """Prompt-cache guard: every model call carries the SAME TEXT_TOOLS
    object — the tool list never mutates mid-turn/mid-round."""
    client = _FakeClient([
        _tool_turn(args={"hole_number": 1}),
        _text_turn(["Easy 7-iron."]),
    ])
    await _run(client)
    assert len(client.calls) == 2
    for call in client.calls:
        assert call["tools"] is TEXT_TOOLS


async def test_repeated_identical_call_is_served_from_cache_and_force_texts_next():
    resolve_count = 0
    real_resolve = tool_loop_mod.resolve_tool

    async def _counting_resolve(name, args, ctx):
        nonlocal resolve_count
        resolve_count += 1
        return await real_resolve(name, args, ctx)

    tool_loop_mod_resolve_backup = tool_loop_mod.resolve_tool
    tool_loop_mod.resolve_tool = _counting_resolve
    try:
        same = {"hole_number": 4}
        client = _FakeClient([
            _tool_turn(args=same, block_id="tu_1"),
            _tool_turn(args=same, block_id="tu_2"),   # identical re-ask
            _text_turn(["Take the driver."]),
        ])
        events = await _run(client)
    finally:
        tool_loop_mod.resolve_tool = tool_loop_mod_resolve_backup

    # Resolved once; the re-ask was answered from seen_calls without re-execution.
    assert resolve_count == 1
    # The all-repeats round breached the budget → the next call is forced text.
    assert len(client.calls) == 3
    assert client.calls[2]["tool_choice"] == {"type": "none"}
    assert events[-1] == ("done", "Take the driver.")


async def test_token_budget_breach_forces_text_on_the_next_call():
    client = _FakeClient([
        _tool_turn(args={"hole_number": 1}, output_tokens=tool_loop_mod._OUTPUT_TOKEN_BUDGET),
        _text_turn(["Short answer."]),
    ])
    events = await _run(client)
    assert len(client.calls) == 2
    assert client.calls[1]["tool_choice"] == {"type": "none"}
    assert events[-1] == ("done", "Short answer.")


# ── Tool resolution: errors, timeouts, parallel blocks ──────────────────────


async def test_resolver_exception_becomes_calm_is_error_result_and_loop_continues(monkeypatch):
    async def _boom(name, args, ctx):
        raise RuntimeError("internal detail that must never reach the model")

    monkeypatch.setattr(tool_loop_mod, "resolve_tool", _boom)
    client = _FakeClient([
        _tool_turn(args={"hole_number": 4}),
        _text_turn(["Couldn't pull that number."]),
    ])
    events = await _run(client)

    tool_result_msg = client.calls[1]["messages"][-1]
    assert tool_result_msg["role"] == "user"
    (result,) = tool_result_msg["content"]
    assert result["is_error"] is True
    assert result["content"] == json.dumps({"error": "tool unavailable right now"})
    assert "internal detail" not in result["content"]
    assert events[-1] == ("done", "Couldn't pull that number.")


async def test_resolver_timeout_becomes_calm_is_error_result(monkeypatch):
    async def _hangs(name, args, ctx):
        await asyncio.sleep(1.0)
        return {"ok": True}

    monkeypatch.setattr(tool_loop_mod, "resolve_tool", _hangs)
    monkeypatch.setattr(tool_loop_mod, "_TOOL_RESOLVE_TIMEOUT_S", 0.01)
    client = _FakeClient([
        _tool_turn(args={"hole_number": 4}),
        _text_turn(["Numbers aren't coming through."]),
    ])
    events = await _run(client)

    (result,) = client.calls[1]["messages"][-1]["content"]
    assert result["is_error"] is True
    assert result["content"] == json.dumps({"error": "tool unavailable right now"})
    assert events[-1][0] == "done"


async def test_parallel_tool_use_blocks_are_answered_in_one_user_message():
    client = _FakeClient([
        ([], _Final([
            _ToolUseBlock("get_carries", {"hole_number": 4}, "tu_a"),
            _ToolUseBlock("get_conditions", {"hole_number": 4}, "tu_b"),
        ], "tool_use")),
        _text_turn(["Both fetched."]),
    ])
    events = await _run(client)

    messages = client.calls[1]["messages"]
    # Exactly one assistant echo + ONE user message carrying BOTH results.
    assert messages[-2]["role"] == "assistant"
    results_msg = messages[-1]
    assert results_msg["role"] == "user"
    assert [r["tool_use_id"] for r in results_msg["content"]] == ["tu_a", "tu_b"]
    assert all(r["type"] == "tool_result" for r in results_msg["content"])
    assert events[-1] == ("done", "Both fetched.")


async def test_stateless_ctx_resolves_every_tool_to_the_honest_no_session_payload():
    client = _FakeClient([
        _tool_turn(name="get_recommendation", args={"hole_number": 4}),
        _text_turn(["I can't pull live numbers right now."]),
    ])
    await _run(client, ctx=_stateless_ctx())

    (result,) = client.calls[1]["messages"][-1]["content"]
    payload = json.loads(result["content"])
    assert payload["available"] is False
    assert "No active round session" in payload["reason"]
    assert "is_error" not in result  # honest unavailability is DATA, not an error


# ── Event semantics ──────────────────────────────────────────────────────────


async def test_no_tool_turn_is_byte_identical_to_today(monkeypatch):
    """An ordinary no-tool reply: tokens then done, no status frames, one
    model call — exactly the pre-loop behavior the stream tests pin."""
    client = _FakeClient([_text_turn(["Easy ", "7-iron."])])
    usage_calls = []
    events = await _run(client, on_usage=lambda usage, n: usage_calls.append(n))

    assert events == [("token", "Easy "), ("token", "7-iron."), ("done", "Easy 7-iron.")]
    assert len(client.calls) == 1
    assert usage_calls == [0]


async def test_tool_turn_emits_status_keepalive_and_narration_tokens():
    client = _FakeClient([
        (["Let me check. "], _Final(
            [_TextBlock("Let me check. "), _ToolUseBlock("get_carries", {"hole_number": 4}, "tu_1")],
            "tool_use",
        )),
        _text_turn(["245 clears it."]),
    ])
    events = await _run(client)

    assert ("status", tool_loop_mod.TOOL_STATUS_LABEL) in events
    # done carries ALL forwarded text joined — narration + final answer —
    # and NO tool/JSON payloads (history-hygiene: this is what gets persisted).
    assert events[-1] == ("done", "Let me check. 245 clears it.")
    assert not any("tool_use_id" in str(payload) for kind, payload in events if kind in ("token", "done"))


async def test_oversized_tool_result_is_clipped_with_marker(monkeypatch):
    async def _huge(name, args, ctx):
        return {"blob": "x" * (tool_loop_mod._TOOL_RESULT_MAX_CHARS * 2)}

    monkeypatch.setattr(tool_loop_mod, "resolve_tool", _huge)
    client = _FakeClient([
        _tool_turn(args={"hole_number": 4}),
        _text_turn(["ok."]),
    ])
    await _run(client)

    (result,) = client.calls[1]["messages"][-1]["content"]
    assert result["content"].endswith("…[truncated]")
    assert len(result["content"]) <= tool_loop_mod._TOOL_RESULT_MAX_CHARS + len("…[truncated]")
