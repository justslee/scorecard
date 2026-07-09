# Plan: `caddie-prompt-caching-text-path` (+ folded `caddie-llm-timeouts-retries`)

## 0. Verified API shapes (via `claude-api` skill — bake these in)

All confirmed against the Anthropic Python SDK docs in the `claude-api` skill.

- **`system` as a list of content blocks.** `system=` accepts either a bare string **or** a list of text content blocks. Cache form:
  ```python
  system=[
      {"type": "text", "text": STABLE_TEXT, "cache_control": {"type": "ephemeral"}},
      {"type": "text", "text": VOLATILE_TEXT},  # no cache_control
  ]
  ```
- **Where `cache_control` attaches / render order.** Render order is **`tools` → `system` → `messages`**. The breakpoint goes on the **last block of the stable prefix** (here: the first system block). Any byte change before/at the breakpoint invalidates it; the volatile second block (and all `messages`) render after the breakpoint and are never cached. This caddie passes **no `tools=`**, so `system` is position 0 — the whole cacheable prefix is the first system block.
- **Minimum cacheable prefix for the pinned model.** The pinned model is `claude-sonnet-4-5-20250929` (Sonnet 4.5 class). Verified floor = **1024 tokens** (NOT 2048 — this corrects the audit's "~1024–2048" hedge; the Sonnet-4.x family is 1024). Below the floor, caching **silently no-ops** (`cache_creation_input_tokens: 0`, no error).
- **Cache metrics on the response `usage`.** Exact attribute names (identical for sync and streaming final message):
  - `usage.cache_read_input_tokens` (served from cache, ~0.1× input)
  - `usage.cache_creation_input_tokens` (written to cache, ~1.25× input)
  - `usage.input_tokens` (uncached remainder), `usage.output_tokens`
  - Total prompt = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
  - **Sync:** `message.usage.*` on the `client.messages.create(...)` result.
  - **Streaming:** call `stream.get_final_message()` inside/after the `async with client.messages.stream(...)` block; read `final_message.usage.*`. (`messages.stream` is the helper already used at caddie.py:863.)
- **Timeouts/retries — constructor, not per-request.** `timeout` (Python: **seconds**, float; default 10 min) and `max_retries` (default 2; the SDK auto-retries `408/409/429/5xx` + connection errors with exponential backoff — **`max_retries=1` == the requested "ONE retry on transient errors"**) go on the **client constructor**: `anthropic.Anthropic(api_key=..., timeout=25.0, max_retries=1)` / `anthropic.AsyncAnthropic(...)`. `APITimeoutError`/`APIConnectionError` subclass `APIError` and are already caught by the existing broad `except Exception`. Note: timeouts are themselves retried, so worst-case wall clock ≈ `timeout × (max_retries+1)` = **~50s** — a huge improvement over the ~10-min default that currently starves the single worker.

**SDK version verdict:** `backend/pyproject.toml` pins `anthropic>=0.77.0`. List-form `system` + `cache_control` (since ~0.34), `stream.get_final_message()`, and the `usage.cache_*` attributes are all present well before 0.77. **No bump required.** Add one implementation step: confirm the CI/venv resolves `anthropic>=0.77.0` (the local sandbox venv currently has it uninstalled — that's a sandbox artifact, not a pin problem). If, at implementation time, the installed wheel somehow predates list-form system support, make "bump `anthropic` to a version supporting list-form `system` + `cache_control`" an explicit step — but this is not expected.

## 1. The reordering decision (the core structural change)

**HARD CONSTRAINT honored: the caddie's brain does not change — same semantic content, only reordered for cacheability, plus one meaning-preserving pointer reword.**

Current single-string order (both builders): `persona → memory_section → "--- CURRENT SITUATION ---" + context → "--- INSTRUCTIONS ---" (…"use the context above"…) → HAZARD_GROUNDING_RULE`.

The volatile CURRENT SITUATION sits in the *middle*, which prevents a stable prefix. **Decision: emit `system` as a two-block list** — a stable cached prefix, then the volatile situation as a second, uncached system block:

```
system = [
  {  # BLOCK 0 — STABLE, per-round-stable → cache_control ephemeral
    "type": "text",
    "text": f"{personality.system_prompt}\n"
            f"{memory_section}\n"
            f"--- INSTRUCTIONS ---\n{INSTRUCTIONS_TEXT}\n\n"
            f"{HAZARD_GROUNDING_RULE}",
    "cache_control": {"type": "ephemeral"},
  },
  {  # BLOCK 1 — VOLATILE (per-hole) → NO cache_control
    "type": "text",
    "text": f"--- CURRENT SITUATION ---\n{context}",
  },
]
```

**Why a second system block rather than prepending CURRENT SITUATION into the user turn:**
- Keeps CURRENT SITUATION in the system/context voice (it is grounding, not the player's speech) — no risk of the model attributing hole geometry to the golfer.
- Leaves the `messages` array and the persistence path (`append_message_pair` stores only the transcript) completely untouched — zero risk to round history semantics.
- The INSTRUCTIONS pointer resolves cleanly within the system prompt.

**The one pointer reword (meaning-preserving).** INSTRUCTIONS currently says *"use the context above to give specific, actionable advice"*. Once CURRENT SITUATION moves after INSTRUCTIONS, "above" is positionally wrong. Reword the positional pointer to a **named** pointer: *"use the CURRENT SITUATION section to give specific, actionable advice"*. This names the exact same block by its existing header (`--- CURRENT SITUATION ---`), so it is semantically identical — a golfer-facing behavior no-op. This is the **only** content edit; everything else is pure reordering.

**Memory placement (per-round-stable → in the cached prefix).** `memory_mod.get_top_memories` (caddie.py:681 / :1264) is fetched fresh at prompt-build but is stable *within a round* — top-N durable memories don't change mid-round. It belongs in BLOCK 0. **Tradeoff to note:** if a mid-round write-back ever changed the top-N memories between turns of the same round, BLOCK 0's bytes would change and bust the cache for that turn (a single cold write, then warm again). Today there is no mid-round memory mutation (distillation runs at `/session/end`), so this is safe; document it so the future in-round memory-capture item (P2 #6) accounts for it.

**Explicit scope: history stays uncached — by design.** Per the grounding, per-round-stable = persona + memory; volatile = CURRENT SITUATION + history + new transcript. Because the volatile CURRENT SITUATION block renders *after* the cached prefix and the 20-turn `messages` render after that, the conversation history is **not** cached by this item. That is intentional and matches the reviewer's scope ("one item done well"). Caching the history too would require moving CURRENT SITUATION into the user turn and adding a second breakpoint on `messages` — a clean **follow-up** (pairs with P2 #12 pre-warm). Note this honestly in the plan header comment; do not attempt it here.

## 2. Shared-signature change (return type + all 5 consumers + `_sse_reply`)

Change both builders to return the system as a **list of content blocks** instead of a string. `system=` accepts both, so consumers forward unchanged except for the type annotation.

1. **`_build_session_voice_prompt`** (caddie.py:653) — return type `tuple[str, list[dict], str]` → **`tuple[list[dict], list[dict], str]`** `(system_blocks, messages, persona_id)`. Build the two-block list per §1.
2. **`_build_voice_prompt`** (caddie.py:1240) — identical change; identical two-block shape (its `context` differs but the block structure is the same). Apply the same pointer reword to its INSTRUCTIONS literal.
3. **`session_voice`** (caddie.py:781) — `system_blocks, messages, _persona_id = await _build_session_voice_prompt(...)`; pass `system=system_blocks` to `client.messages.create` (:796); log usage from `message.usage` after the call (§4).
4. **`voice_caddie`** (caddie.py:1342) — same as (3) with `_build_voice_prompt` (create at :1359).
5. **`session_voice_stream`** (caddie.py:898) — pass `system_blocks` and `persona_id` into `_sse_reply`.
6. **`voice_caddie_stream`** (caddie.py:1377) — same; the previously-discarded `_persona_id` is now threaded in.
7. **`_sse_reply`** (caddie.py:828) — rename param `system_prompt: str` → **`system: list[dict]`**; add optional param **`persona_id: Optional[str] = None`**; pass `system=system` to `client.messages.stream` (:863); after the `async for` text loop and before `completed = True`, call `final_message = await stream.get_final_message()` and log its usage (§4), all guarded (§4).

**types.ts / models.py sync — confirmed backend-only, no shared-shape change.** `system_blocks` is an in-process structure passed straight to the SDK; it is never serialized to the client. `VoiceCaddieResponse` and the SSE framing (`event: token|done|error`) are unchanged. State explicitly in the plan: **no frontend `types.ts` / Pydantic `models.py` change; no `/verify` of a shared shape needed.**

## 3. Timeouts + retries — FOLD IN (fits cleanly, same file)

Verified above that `timeout`/`max_retries` go on the **constructor**. Add module constants near the other caddie constants (caddie.py:~54):
```python
_CADDIE_TIMEOUT_S = 25.0      # bounded; ~50s worst case with one retry
_CADDIE_MAX_RETRIES = 1       # SDK-native single retry on 408/409/429/5xx/conn
```
Apply to all three client constructions:
- `anthropic.Anthropic(api_key=api_key, timeout=_CADDIE_TIMEOUT_S, max_retries=_CADDIE_MAX_RETRIES)` at caddie.py:794 (`session_voice`) and :1357 (`voice_caddie`).
- `anthropic.AsyncAnthropic(api_key=api_key, timeout=_CADDIE_TIMEOUT_S, max_retries=_CADDIE_MAX_RETRIES)` at caddie.py:858 (`_sse_reply`).

**Degrade path is already correct** — on exhaustion the SDK raises `APITimeoutError`/`APIConnectionError` (subclasses of `APIError`), caught by the existing broad `except Exception` → sync returns `_CADDIE_ERROR_DETAIL` (HTTP 500 calm copy); stream emits one `event: error` with `_CADDIE_ERROR_DETAIL`. No new except branches needed. This is three constructor edits + two constants — it fits cleanly in the same cycle. **Fold it in.**

## 4. Measurement logging spec (make the win provable)

Add one small helper next to the logger (caddie.py:~55), emitting a single structured line via the existing `log = logging.getLogger("looper.caddie")`:
```python
def _log_caddie_usage(usage, *, context: str, persona_id: Optional[str]) -> None:
    try:
        log.info(
            "caddie_usage",
            extra={
                "caddie_context": context,
                "persona_id": persona_id,
                "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
                "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
                "input_tokens": getattr(usage, "input_tokens", 0) or 0,
                "output_tokens": getattr(usage, "output_tokens", 0) or 0,
            },
        )
    except Exception:  # logging must never break a reply
        log.debug("caddie_usage log failed", exc_info=True)
```
(Defensive `getattr` because older/edge usage shapes may omit the cache fields.)

**Where it fires:**
- **Sync** — immediately after `message = client.messages.create(...)` in `session_voice` (:796→) and `voice_caddie` (:1359→): `_log_caddie_usage(message.usage, context="session_voice"|"voice_caddie", persona_id=_persona_id)`. (Capture `persona_id` instead of discarding it.)
- **Stream** — inside `_sse_reply`, after the token loop: `final_message = await stream.get_final_message()` then `_log_caddie_usage(final_message.usage, context=log_context, persona_id=persona_id)`. Wrap the `get_final_message()` + log in a local `try/except Exception: log.debug(...)` so a stream that can't produce a final message never converts a *successful* reply into an `event: error`.

This is how we prove caching engaged: a warm turn shows `cache_read_input_tokens > 0` and `input_tokens` dropping to just the volatile tail; a below-floor no-op shows `cache_creation=0, cache_read=0`.

## 5. Min-prefix risk verdict

Approximate token sizes (chars/4) of BLOCK 0 components:
- Persona `system_prompt`: measured **1077–1446 chars ≈ 270–360 tokens** (personalities.py: classic 1205, strategist 1077, hype 1078, professor 1446).
- INSTRUCTIONS literal: ~1090 chars ≈ **~270 tokens**.
- `HAZARD_GROUNDING_RULE` (hazards.py:50): ~590 chars ≈ **~150 tokens**.
- `memory_section`: **0 → a few hundred tokens** (empty for new users; present once a round/history accumulates).

**Stable prefix with empty memory ≈ 690–780 tokens — below the 1024 floor.** Verdict: for a thin persona with no memory, caching **silently no-ops**. It clears 1024 only when persona + memory + instructions + hazard ≥ 1024 — i.e. larger personas plus any non-trivial memory, which is the common in-round case.

**Handling (per the reviewer's rule — do NOT pad with fake content):**
- Accept the graceful no-op for tiny/empty-memory cases and **document it**. The usage log (§4) makes every no-op visible (`cache_creation=0`), so there is no silent mystery.
- Do not co-locate the volatile CURRENT SITUATION behind the breakpoint to bulk up the prefix — that would defeat the entire point.
- Implementation step: run a one-time `client.messages.count_tokens(...)` (or `messages.count_tokens` on a representative BLOCK 0) during build to replace these chars/4 estimates with real counts and confirm which persona/memory combinations clear 1024. Record the numbers in a code comment.
- Good-news correction to the audit: the floor is **1024**, not 2048 — a lower bar than the audit assumed, so more real in-round turns will cache than the "F"-grade write-up feared. The restructure is also the prerequisite for the P2 pre-warm (#12) and the history-caching follow-up, both of which compound the win.

## 6. Tests (deterministic — mock the client; no live key / network / Postgres)

New file `backend/tests/test_caddie_caching.py`, plus targeted extensions to `backend/tests/test_voice_stream.py`. Mock DB deps directly (`get_owned_session`, `personality_visible`, `load_personality`, `sessions.set_current_hole`, `memory_mod.get_top_memories`) as the existing tests already do.

1. **`system` is a list with the breakpoint on the stable block only.** Call `_build_session_voice_prompt` (and `_build_voice_prompt`) with mocked deps → assert the returned `system` is a `list`; `system[0]["cache_control"] == {"type": "ephemeral"}`; `"cache_control" not in system[1]`.
2. **Stable-before-volatile ordering.** `system[0]["text"]` contains the persona opener + `"--- INSTRUCTIONS ---"` + the `HAZARD_GROUNDING_RULE` text and does **not** contain `"--- CURRENT SITUATION ---"`; `system[1]["text"].startswith("--- CURRENT SITUATION ---")`.
3. **Brain regression guard (content-identical modulo ordering + the one reword).** In the test, keep a frozen copy of the OLD single-string template; render it and the new blocks from the same inputs; normalize the single pointer phrase (`"use the context above"` → `"use the CURRENT SITUATION section"`); assert the **set of non-empty, stripped lines** of `system[0]["text"] + "\n" + system[1]["text"]` equals that of the normalized old string. Order-independent; fails on any accidental content edit.
4. **Cache-usage logging fires (sync).** Add a fake sync `anthropic.Anthropic` whose `messages.create` returns a fake message with `.content` and `.usage` (numeric `cache_read_input_tokens`/`cache_creation_input_tokens`/`input_tokens`/`output_tokens`); drive `session_voice` (mocked DB) and use `caplog` to assert a `caddie_usage` record carrying those numbers + `persona_id`.
5. **Cache-usage logging fires (stream) + frames unchanged.** Extend `_FakeAsyncStream` with an `async def get_final_message(self)` returning a fake message with `.usage`; assert `_sse_reply` still yields `token…/done` exactly as before **and** emits the `caddie_usage` log. (This also guards that the new `get_final_message()` call didn't change SSE output.)
6. **`system` list is what reaches the SDK.** Sync fake captures `create(**kwargs)` → assert `kwargs["system"]` is the two-block list with the breakpoint on `[0]`. Stream: the existing `_FakeMessages.stream` already captures `captured_kwargs`; assert `captured_kwargs["system"]` is the list when driven via `session_voice_stream` (or by passing a list into `_sse_reply` directly).
7. **Timeout/retry construction.** Update the fake constructor signatures to accept the new kwargs — `_FakeAsyncAnthropic.__init__(self, api_key=None, timeout=None, max_retries=None)` (and the sync fake likewise) and record them as class attrs; assert they equal `_CADDIE_TIMEOUT_S` / `_CADDIE_MAX_RETRIES`. **This is a required harness extension, not a weakening** — without it the existing stream tests would break the moment the constructor passes `timeout`/`max_retries`.

**Do not delete/weaken existing tests.** The two existing param-identity tests (`test_sse_reply_uses_identical_model_params`, etc.) pass a bare string as `system` directly into `_sse_reply`; that still works (`system=` accepts str) — keep them, and only update an assertion if it explicitly required `system` to be a string equal to a literal. The existing token/done/error/empty-stream tests must continue to pass; the only mechanical edits they need are the fake-constructor kwargs (test 7) and the `get_final_message()` method on `_FakeAsyncStream` (test 5).

**Existing tests to extend:** `backend/tests/test_voice_stream.py` (fakes + stream assertions). Integration tests `tests/integration/test_caddie_profile_session.py` and `tests/integration/test_caddie_session_message.py` are DB-backed → **CI only**, not run locally.

## 7. Files to touch

- `backend/app/routes/caddie.py` — both builders (:653, :1240), five consumers (:781, :898, :1342, :1377) + `_sse_reply` (:828), two module constants + `_log_caddie_usage` helper (~:54), three client constructions (:794, :858, :1357), INSTRUCTIONS reword in both builders. **(all logic lives here)**
- `backend/tests/test_caddie_caching.py` — new.
- `backend/tests/test_voice_stream.py` — extend fakes (constructor kwargs, `get_final_message`) + add stream usage/system-list assertions.
- (No change to `backend/app/caddie/personalities.py` or `hazards.py` — read-only references.)
- (No change to `pyproject.toml` unless the installed wheel unexpectedly predates list-form system.)
- **No frontend/shared-shape change** (`types.ts` / `models.py` untouched — backend-only).

## 8. Gates to run

- `cd backend && ruff check .`
- Targeted, non-DB unit tests: `cd backend && python -m pytest tests/test_caddie_caching.py tests/test_voice_stream.py -q`
- Do **not** run the DB-backed integration tests locally (no Postgres/docker) — `tests/integration/test_caddie_*` run in CI.
- `tsc` / frontend lint / voice-agent tests are **unaffected** (backend-only, no shared shape) — no need to run.

## 9. Consistency with NORTHSTAR.md

No user-visible change: same model, `max_tokens`, `temperature`, same spoken behavior (content identical modulo ordering + one named-pointer reword). Silent cost/latency win; degrades honestly (calm existing copy on timeout/error, no fabricated cache). Calm and quiet.
