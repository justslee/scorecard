"""Bounded server-side tool loop for the TEXT caddie mouths
(specs/caddie-tool-loop-parity-plan.md D4).

One shared async event generator so all four text endpoints
(/session/voice, /session/voice/stream, /voice, /voice/stream) run ONE loop
implementation. Pure of FastAPI — the caller maps events to its own transport
(SSE frames or a single JSON reply).

Every stop is STRUCTURAL — never warning text (prose does not stop a loop):

  - loop counter: at most ``_MAX_MODEL_CALLS`` model calls per turn;
  - ``tool_choice={"type": "none"}`` on the final permitted call;
  - cumulative output-token budget across the turn;
  - repeated-identical-call guard: a re-asked (name, args) is served from
    cache without re-execution, and an all-repeats round force-texts the
    next call.

Prompt-cache guard (plan D7): ``tools=TEXT_TOOLS`` is passed on EVERY call —
a constant, name-sorted list that never mutates mid-round, so after the
one-time bust it lives inside the cached prefix.
"""

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Callable, Optional

from app.caddie.tools import TEXT_TOOLS, ToolContext, resolve_tool

log = logging.getLogger("looper.caddie")

# Structural stop: at most 2 tool-resolution rounds + 1 final text call.
_MAX_MODEL_CALLS = 3
# Per tool_use block, asyncio.wait_for (cycle-29 timeout discipline).
_TOOL_RESOLVE_TIMEOUT_S = 6.0
# Cumulative usage.output_tokens across the turn.
_OUTPUT_TOKEN_BUDGET = 900
# Oversized tool payloads are truncated with an explicit marker.
_TOOL_RESULT_MAX_CHARS = 4000

# Client-facing keepalive label between rounds (rendered by the sheet as
# "checking the numbers…"); calm copy, no internals.
TOOL_STATUS_LABEL = "checking the numbers"

# Calm failure result — never raw exception text (injection/leak hygiene).
_TOOL_ERROR_RESULT = {"error": "tool unavailable right now"}


def _clip(payload: str) -> str:
    if len(payload) <= _TOOL_RESULT_MAX_CHARS:
        return payload
    return payload[:_TOOL_RESULT_MAX_CHARS] + "…[truncated]"


async def run_caddie_turn(
    client,
    model: str,
    system,
    messages: list[dict],
    ctx: ToolContext,
    on_usage: Optional[Callable[[Any, int], None]] = None,
) -> AsyncIterator[tuple[str, str]]:
    """Run one caddie turn with bounded tool use.

    Yields ``("token", str)`` for every streamed text delta (pre-tool
    narration is real speech), ``("status", str)`` between tool rounds
    (client watchdog keepalive), and exactly one ``("done", full_text)`` on
    success. Failures raise — the caller maps them exactly as today.

    ``on_usage(usage, call_index)`` fires once per model call so the caller
    can keep its prompt-cache telemetry per call.

    Conversation-history hygiene: tool_use/tool_result blocks live only in
    this turn's local message list — the caller persists only the transcript
    + the final ``done`` text.
    """
    seen_calls: dict[tuple[str, str], dict] = {}  # (name, canonical-json-args) -> result
    parts: list[str] = []
    output_tokens = 0
    convo = list(messages)  # never mutate the caller's list

    for call_n in range(_MAX_MODEL_CALLS):
        force_text = (call_n == _MAX_MODEL_CALLS - 1) or (output_tokens >= _OUTPUT_TOKEN_BUDGET)
        stream_kwargs: dict = dict(
            model=model,
            max_tokens=300,
            temperature=0.7,
            system=system,
            messages=convo,
            tools=TEXT_TOOLS,  # ALWAYS passed — never mutates (prompt cache)
        )
        if force_text:
            stream_kwargs["tool_choice"] = {"type": "none"}

        async with client.messages.stream(**stream_kwargs) as stream:
            async for text in stream.text_stream:
                if text:
                    parts.append(text)
                    yield ("token", text)
            # Guarded: a stream that already delivered its text but can't
            # produce a final aggregate must never turn a SUCCESSFUL reply
            # into an error (pre-existing _sse_reply guarantee).
            try:
                final = await stream.get_final_message()
            except Exception:  # noqa: BLE001
                log.debug("get_final_message failed; ending turn with streamed text", exc_info=True)
                yield ("done", "".join(parts))
                return

        if on_usage is not None:
            on_usage(getattr(final, "usage", None), call_n)
        output_tokens += getattr(getattr(final, "usage", None), "output_tokens", 0) or 0

        if getattr(final, "stop_reason", None) != "tool_use":
            yield ("done", "".join(parts))
            return

        # Resolve — ALL tool_use blocks answered in ONE user message (SDK
        # contract), each matched by tool_use_id.
        yield ("status", TOOL_STATUS_LABEL)
        tool_results: list[dict] = []
        repeated_all = True
        for block in (b for b in (final.content or []) if getattr(b, "type", None) == "tool_use"):
            key = (block.name, json.dumps(block.input, sort_keys=True, default=str))
            if key in seen_calls:
                result = seen_calls[key]  # no re-execution — no-progress guard
            else:
                repeated_all = False
                try:
                    result = await asyncio.wait_for(
                        resolve_tool(block.name, dict(block.input or {}), ctx),
                        _TOOL_RESOLVE_TIMEOUT_S,
                    )
                except Exception:  # noqa: BLE001 — calm copy only, internals to the log
                    log.exception("caddie tool %s failed", block.name)
                    result = dict(_TOOL_ERROR_RESULT)
                seen_calls[key] = result
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": _clip(json.dumps(result, default=str)),
                **({"is_error": True} if "error" in result else {}),
            })

        if not tool_results:
            # stop_reason claimed tool_use with no tool_use blocks — end honestly.
            yield ("done", "".join(parts))
            return

        convo = convo + [
            {"role": "assistant", "content": final.content},
            {"role": "user", "content": tool_results},
        ]
        if repeated_all:
            # The model re-asked identical questions — structurally end it on
            # the next call (budget breach → tool_choice none).
            output_tokens = _OUTPUT_TOKEN_BUDGET

    # Structurally unreachable against a compliant API: the final permitted
    # call carries tool_choice={"type":"none"}, so its stop_reason cannot be
    # tool_use. Defensive (a non-compliant fake/upstream): end the turn with
    # whatever text streamed rather than crash a live reply.
    log.warning("run_caddie_turn exhausted %d model calls still in tool_use", _MAX_MODEL_CALLS)
    yield ("done", "".join(parts))
