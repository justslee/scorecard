# Caddie tool-loop parity — implementation plan (`caddie-tool-loop-parity`)

Backlog: `caddie-tool-loop-parity` (P1, major). Audit source: `specs/caddie-excellence-audit.md` P1.4, area C = grade D.
This plan is the contract for the builder. File paths and line numbers were verified against the tree on 2026-07-08.

## Problem

The Realtime orb exposes 6 tools to the model; the classic Claude TEXT caddie passes **no `tools=` at all**:

- `backend/app/routes/caddie.py:840` (`session_voice`), `:915` (`_sse_reply`, shared by both streaming twins),
  `:1423` (`voice_caddie`) — every `client.messages.create(...)` / `client.messages.stream(...)` call omits `tools`.
- So the sheet/fallback brain answers only from the pre-injected CURRENT SITUATION block — it cannot fetch a fresh
  recommendation, log a shot, or pull carries mid-turn.
- `get_carries` is a stub even on the orb: `frontend/src/lib/voice/realtime.ts:126-134` returns
  `{available:false}` unconditionally (asserted by `frontend/src/lib/voice/realtime-dispatch.test.ts:78`).

## Exploration record — where the orb's tools live and resolve

The 6 tools are **defined server-side** in `backend/app/services/realtime_relay.py:42-141` (`DEFAULT_TOOLS`,
OpenAI Realtime `{"type":"function", "name", "description", "parameters"}` shape), embedded into the mint payload by
`build_session_payload()` (`realtime_relay.py:223`) and echoed to the client by
`backend/app/routes/realtime.py::start_realtime_session`. They are **resolved client-side**: tool calls arrive on the
WebRTC data channel and `dispatchTool()` (`frontend/src/lib/voice/realtime.ts:90-143`) fans them out to FastAPI
session endpoints, which read the same `RoundSession` (`app/caddie/session.py`) state:

| Tool | Input schema | Resolves to (today) | Backing implementation (routes/caddie.py) |
|---|---|---|---|
| `get_recommendation` | `hole_number` (req), `distance_yards` (opt) | `POST /caddie/session/recommend` | `session_recommend` :638-675 → `generate_recommendation()` + `sessions.set_recommendation()` |
| `record_shot` | `hole_number`, `club`, `distance_yards` (req), `result` (opt) | `POST /caddie/session/shot` | `record_shot` :416-483 (retry-window dedupe + durable `Shot` dual-write) |
| `get_session_status` | `{}` | `GET /caddie/session/{round_id}` | `get_session_status` :394-408 |
| `get_conditions` | `hole_number` (opt) | `GET /caddie/session/{id}/conditions` | `get_session_conditions` :489-538 (weather, plays-like, hazards via `format_hazards_line`, green slope) |
| `get_player_profile` | `{}` | `GET /caddie/session/{id}/player-profile` | `get_session_player_profile` :541-574 |
| `get_carries` | `hole_number` (req) | **STUB** — frontend returns `available:false` (`realtime.ts:126`) | none — to build |

Key existing facts the design leans on:

- `Hazard` (`backend/app/caddie/types.py:58-68`) already carries `carry_yards` (cumulative **along-path** distance
  measured against the hole's played `golf=hole` way polyline — `backend/app/caddie/hazards.py:161-330`, PR #116) and
  `line_side`. `HoleIntelligence.hazards` is populated by `app/caddie/course_intel.py` (~line 208) at intel fetch time.
  **No new geometry is needed** — real carries = read `session.hole_intel[hn].hazards`.
- Prompt assembly for the text mouths is centralized: `_build_session_voice_prompt` (:681-820) and
  `_build_voice_prompt` (:1293-1401) return `(system_blocks, messages, persona_id)` with a two-block prompt-cache
  system (`stable_text` with `cache_control`, then volatile CURRENT SITUATION). The Tier-1 eval harness
  (`backend/tests/eval/test_golden_tier1.py`, landed PR #117) calls `_build_session_voice_prompt` directly and runs
  `TIER1_CHECKS` (`backend/tests/eval/checks.py:276-286`) against the assembled text — those asserts MUST keep passing.
- Timeouts (cycle 29): `_CADDIE_TIMEOUT_S = 25.0`, `_CADDIE_MAX_RETRIES = 1` (`routes/caddie.py:62-63`) apply to every
  Anthropic client. Frontend SSE watchdogs: `STREAM_FIRST_TOKEN_TIMEOUT_MS = 8_000`, `STREAM_IDLE_TIMEOUT_MS = 10_000`
  (`frontend/src/lib/caddie/api.ts:547-552`); `streamCaddieReply` (:607) silently ignores unknown SSE event names but
  does **not** reset its timers on them.
- Anthropic tool-loop mechanics (verified against current SDK docs via the claude-api skill): pass `tools=[{name,
  description, input_schema}]`; a tool turn returns `stop_reason == "tool_use"`; echo `response.content` back as the
  assistant turn and return ALL `tool_result` blocks (matching `tool_use_id`, `is_error` for failures) in ONE user
  message; `tool_choice={"type": "none"}` structurally forbids further tool use. `client.messages.stream(...,
  tools=...)` + `get_final_message()` works for streamed rounds.

---

## Design

### D1. One canonical tool registry, two renderings (parity by construction)

New module **`backend/app/caddie/tools.py`**:

```python
# Canonical, order-stable (sorted by name), byte-stable at import time.
CADDIE_TOOLS: list[dict]  # [{"name", "description", "input_schema": {...}}, ...]

def realtime_tools() -> list[dict]:
    """OpenAI Realtime rendering: {"type": "function", "name", "description",
    "parameters": <input_schema>} — exactly today's DEFAULT_TOOLS shape."""

def anthropic_tools() -> list[dict]:
    """Anthropic rendering: {"name", "description", "input_schema"} — passed as
    `tools=` on every text-mouth model call. Module-level constant TEXT_TOOLS."""
```

- Move the 6 schema dicts out of `realtime_relay.py:42-141` into `CADDIE_TOOLS` (names, descriptions, schemas
  **verbatim** — descriptions are shared by both mouths so the drift test is trivially green).
- `realtime_relay.py` keeps the public name: `DEFAULT_TOOLS = realtime_tools()` (imports in
  `backend/tests/test_realtime_tools.py:27` and `routes/realtime.py` keep working unchanged).
- The only description edit allowed: `get_carries` loses the "P2 stub" framing in the frontend comment; the schema
  description ("If it returns available:false the course isn't mapped — never invent a carry") stays — it is the
  honest-empty contract.

### D2. Shared server-side resolution — extract, don't duplicate

The four backing endpoints' bodies move into pure-ish helpers in `app/caddie/tools.py`; the HTTP endpoints in
`routes/caddie.py` become thin wrappers (auth via `get_owned_session` stays in the route). The text tool loop calls
the **same helpers** with the session it already holds:

| New helper in `app/caddie/tools.py` | Lifted from (`routes/caddie.py`) | Notes |
|---|---|---|
| `async recommend_payload(session, round_id, hole_number, distance_yards=None, ...)` | `session_recommend` :644-675 | keeps `generate_recommendation(...)` + `sessions.set_recommendation(...)` targeted write |
| `async record_shot_payload(session, round_id, user_id, hole_number, club, distance_yards, result=None)` | `record_shot` :431-483 | keeps 30s retry-window dedupe + best-effort durable `Shot` dual-write |
| `session_status_payload(session)` | `get_session_status` :397-408 | pure |
| `conditions_payload(session, hole_number=None)` | `get_session_conditions` :503-538 | pure; keeps honest `plays_like=None` / empty hazards |
| `async player_profile_payload(session, user_id)` | `get_session_player_profile` :551-574 | reads `memory_mod.get_player_profile` |
| `carries_payload(session, hole_number)` | **new** — see D3 | pure |

Dispatcher:

```python
@dataclass
class ToolContext:
    session: Optional[RoundSession]  # None on the stateless mouth
    round_id: Optional[str]
    user_id: str
    default_hole: Optional[int]

async def resolve_tool(name: str, args: dict, ctx: ToolContext) -> dict:
    # unknown name -> {"error": "Unknown tool: ..."} (mirror realtime.ts:141)
    # ctx.session is None (stateless mouth) -> honest
    #   {"available": False, "reason": "No active round session — live numbers unavailable."}
    # per-tool: validate args (ints), fall back hole_number -> ctx.default_hole,
    # call the matching *_payload helper.
```

Import direction: `routes/caddie.py` and `routes/realtime.py`/`realtime_relay.py` import `app.caddie.tools`;
`tools.py` imports only `app.caddie.*`, `app.db.*`, `app.services.*` — no route imports, no cycle.

### D3. Real `get_carries` (both mouths)

**Computation** (`tools.carries_payload(session, hole_number)`): read `session.hole_intel[hn]`; combine the hazards'
along-path carries with the player's club distances (`session.club_distances`, display names via
`CLUB_DISPLAY_NAMES`). Return shape (add matching TS interface — see D6):

```json
{
  "round_id": "...", "hole_number": 4, "available": true,
  "carries": [
    {"type": "bunker", "side": "left", "carry_yards": 245,
     "clubs_that_clear": ["Driver"], "clubs_short_of_it": ["3 Wood", "5 Iron"]}
  ],
  "club_distances": {"Driver": 260, "3 Wood": 235},
  "note": null
}
```

- `clubs_that_clear` = clubs whose entered distance ≥ `carry_yards` (sorted desc); `clubs_short_of_it` capped at 3.
  Both omitted (null) when the player has no club distances — never inferred.
- **Honest empties (no-fake-data lesson):**
  - no `hole_intel` for the hole (course unmapped / intel not fetched) → `{"available": false, "reason": "No mapped
    hazard data for this hole."}` — same contract the tool description already promises;
  - intel present but `hazards == []` → `{"available": true, "carries": [], "note": "No mapped bunkers or water in
    play on this hole."}` (true statement, distinct from "unknown");
  - `carry_yards == 0` entries (chord/polyline projection degenerate) are filtered out — a zero carry is placeholder
    noise, not a number to speak.
- **New endpoint** for the orb: `GET /caddie/session/{round_id}/carries?hole_number=N` in `routes/caddie.py` (place
  next to `/conditions`, :538) → `get_owned_session` then `tools.carries_payload`. Response model optional; if added,
  put `SessionCarries`/`CarryEntry` pydantic models in `backend/app/models.py` and mirror in `types.ts` (D6).
- **Frontend**: add `getSessionCarries(roundId, holeNumber)` + `SessionCarries` interface in
  `frontend/src/lib/caddie/api.ts` (next to `getSessionConditions`, :254); replace the stub in
  `frontend/src/lib/voice/realtime.ts:126-134` with the real call; rewrite the stub test at
  `frontend/src/lib/voice/realtime-dispatch.test.ts:78` to assert `get_carries` dispatches to the carries endpoint and
  passes `hole_number` through (mirror the `get_conditions` test in that file).

### D4. Bounded server-side tool loop (text mouths)

One shared async event generator so all four endpoints (`/session/voice`, `/session/voice/stream`, `/voice`,
`/voice/stream`) run **one** loop implementation. New module **`backend/app/caddie/tool_loop.py`** (keeps
`routes/caddie.py` from growing; pure of FastAPI):

```python
_MAX_MODEL_CALLS = 3            # structural stop: at most 2 tool-resolution rounds + 1 final
_TOOL_RESOLVE_TIMEOUT_S = 6.0   # per tool_use block, asyncio.wait_for (cycle-29 discipline)
_OUTPUT_TOKEN_BUDGET = 900      # cumulative usage.output_tokens across the turn
_TOOL_RESULT_MAX_CHARS = 4000   # oversized payloads truncated with an explicit marker

async def run_caddie_turn(client, model, system, messages, ctx) -> AsyncIterator[LoopEvent]:
    """Yields ("token", str) | ("status", str) | ("done", full_text).
    Failures raise — the caller maps them exactly as today."""
    seen_calls: dict[tuple[str, str], dict] = {}   # (name, canonical-json-args) -> result
    output_tokens = 0
    for call_n in range(_MAX_MODEL_CALLS):
        force_text = (call_n == _MAX_MODEL_CALLS - 1) or (output_tokens >= _OUTPUT_TOKEN_BUDGET)
        async with client.messages.stream(
            model=model, max_tokens=300, temperature=0.7,
            system=system, messages=messages,
            tools=TEXT_TOOLS,                                  # ALWAYS passed — never mutates (cache)
            **({"tool_choice": {"type": "none"}} if force_text else {}),
        ) as stream:
            async for text in stream.text_stream:
                if text: yield ("token", text)                  # pre-tool narration is real speech
            final = await stream.get_final_message()
        output_tokens += final.usage.output_tokens
        if final.stop_reason != "tool_use":
            yield ("done", <all forwarded text joined>); return
        # resolve — ALL tool_use blocks answered in ONE user message (SDK contract)
        yield ("status", "checking the numbers")               # client watchdog keepalive
        tool_results = []
        repeated_all = True
        for block in (b for b in final.content if b.type == "tool_use"):
            key = (block.name, json.dumps(block.input, sort_keys=True))
            if key in seen_calls:
                result = seen_calls[key]                        # no re-execution — no-progress guard
            else:
                repeated_all = False
                try:
                    result = await asyncio.wait_for(
                        resolve_tool(block.name, block.input, ctx), _TOOL_RESOLVE_TIMEOUT_S)
                except Exception:
                    result = {"error": "tool unavailable right now"}   # calm, no internals
                seen_calls[key] = result
            tool_results.append({"type": "tool_result", "tool_use_id": block.id,
                                 "content": _clip(json.dumps(result)),
                                 **({"is_error": True} if "error" in result else {})})
        messages = messages + [
            {"role": "assistant", "content": final.content},
            {"role": "user", "content": tool_results},
        ]
        if repeated_all:
            # model re-asked identical questions — structurally end it next call
            output_tokens = _OUTPUT_TOKEN_BUDGET
    # loop exit only via force_text branch above — unreachable, assert for safety
```

Stops are **structural** — loop counter, `tool_choice: none`, token budget, repeated-identical-call detection —
never warning text (the audit is explicit that prose does not stop a loop).

**Wiring — non-streaming** (`session_voice` :823-867, `voice_caddie` :1404-1439): switch the sync
`anthropic.Anthropic` client to `anthropic.AsyncAnthropic` (same `timeout=_CADDIE_TIMEOUT_S`,
`max_retries=_CADDIE_MAX_RETRIES`), consume `run_caddie_turn`, ignore `token`/`status` events, take the `done` text.
Empty-guard (`or "Say that once more? ..."`), `_log_caddie_usage` (log per model call, tagged with the call index),
`append_message_pair` persistence, and the exception→`HTTPException` mapping all stay byte-identical in behavior.

**Wiring — streaming** (`_sse_reply` :873-954): replace the single `client.messages.stream` block with the same
generator; map `("token", t)` → `event: token`, `("status", s)` → **new frame** `event: status\ndata: <json str>`,
`("done", full)` → persist-then-`event: done` exactly as today (persistence still gated on completion; abandoned
streams persist nothing). Error handling paths unchanged.

**Conversation-history hygiene:** `tool_use`/`tool_result` blocks live only inside the turn's `messages` list. Only
the user transcript + final assistant text are persisted via `append_message_pair` — `caddie_messages` stays a plain
role/content ledger (the next turn's prompt build at :784-787 cannot render block content).

**Stateless mouth** (`/voice`, `/voice/stream`): same `TEXT_TOOLS` schema (parity), `ToolContext(session=None,
round_id=None)` — every resolution returns the honest "No active round session" payload, so the model says it can't
pull live numbers instead of hallucinating them. (This path is the sheet's tier-2 fallback when the session is broken
— tools genuinely cannot resolve there.)

**Prompt instruction (additive only, content-compatible):** append one line to `stable_text` in BOTH builders
(`:810` after `OBSERVED_REALITY_RULE`, and `:1391`):
> "You have tools to fetch live numbers (recommendation, conditions, carries, player profile) and to log shots.
> Prefer a tool over guessing when the CURRENT SITUATION lacks the number; never state a yardage or carry that came
> from neither a tool nor the CURRENT SITUATION. If a tool reports data unavailable, say so plainly."

Additive lines cannot break the existing Tier-1 `prompt_contains_*` checks (they are containment asserts).

### D5. Streaming UX decision (requirement 3)

**Recommendation: keep one SSE stream and resolve tools inside it, with `status` keepalive frames — not a
tool-event protocol, and not resolving before the stream opens.**

- *Rejected — resolve before opening the stream:* the tool rounds (up to 2 extra Claude calls + resolution) would run
  before the 200 OK; `streamCaddieReply` arms its 8s `firstTokenTimeoutMs` **before** `fetch()`
  (`api.ts:644-647`), so a legitimate 9-second tool turn gets aborted pre-byte and the sheet silently degrades to the
  dumber stateless tier. Fixing that would mean raising the global first-byte timeout — worse failure detection for
  every ordinary turn.
- *Rejected — full stream-with-tool-events:* the sheet has no UI for tool events; inventing a protocol + renderer is
  scope without user value ("quiet" Northstar).
- *Chosen:* the generator streams model text live (an ordinary no-tool turn is byte-identical to today), and between
  rounds emits `event: status` frames. Client change is minimal and honest: in `streamCaddieReply`
  (`api.ts:699-730`), handle `frame.event === "status"` by re-arming the active watchdog (`armFirstTokenTimer()` if
  `!sawFirstToken` else `armIdleTimer()`), and optionally invoke a new `onStatus?: (label: string) => void` so
  `CaddieSheet.tsx` can swap its existing "X is thinking…" copy (:2234) for "checking the numbers…". No new phases,
  no new components. Old clients that predate the change simply ignore `status` frames (unknown events fall through
  `parseSSEFrame` handling) — they only regress on tool turns longer than 8s, and frontend+backend ship in the same
  bundle anyway.

### D6. Shared-types sync (`frontend/src/lib/types.ts` ↔ `backend/app/models.py` ↔ `caddie/api.ts`)

- **New:** `SessionCarries` / `CarryEntry` interfaces in `frontend/src/lib/caddie/api.ts` matching D3's payload; if
  the builder adds pydantic response models, they go in `backend/app/models.py` and the shapes must match field-for-
  field per CLAUDE.md.
- **Existing drift to fix while here:** frontend `SessionConditions` (`api.ts:241-251`) is missing `hazards`,
  `hazards_line`, `green_slope` which the backend already returns (`routes/caddie.py:530-538`). Add them
  (`hazards: Array<{type: string; side: string; carry_yards: number; line_side: string; ...}>`,
  `hazards_line: string | null`, `green_slope: { description: string } | null`).
- No `types.ts` core-model changes expected; tool I/O otherwise lives in `caddie/api.ts` alongside its fetchers,
  matching the existing pattern.

### D7. Prompt-caching interplay (constraint, explicit)

- `tools` render **before** `system` in the Anthropic prompt prefix. Adding `tools=` is a **one-time cache bust** per
  round (acceptable; the next call re-warms). From then on the tool list is part of the cached prefix under the
  existing `cache_control` breakpoint on `stable_text` — free.
- Therefore: `TEXT_TOOLS` is a **module-level constant**, sorted by name, serialized deterministically, and **never
  varies per request or mid-round** — no conditional tools (e.g. do NOT drop `get_carries` on unmapped courses; the
  resolver answers honestly instead). Same rule the registry already enforces for the orb.
- The additive `stable_text` line (D4) also busts the cache once per mouth — ship it in this change, not separately.

### D8. Eval-harness compatibility (HARD gate) + new assertions

Existing Tier-1 (`backend/tests/eval/test_golden_tier1.py`) must pass unchanged — prompt edits are additive only
(verify by running the suite; no check strings are touched).

**(a) New golden scenario** in `backend/tests/eval/golden/caddie_advice.jsonl`:
- `id: "carry-question-cites-true-along-path-carry"` — situation: hole 4, par 4, 400y, hazards including
  `bunker left carry 245` + `water right carry 190`; question: *"What do I need to carry the left bunker?"*.
- Tier-1 checks: `context_hazards_match` (existing) with the two hazards, **plus the new check below**.
- Tier-2 deterministic checks (run by `run_tier2.py` when a key is present): `must_mention_any: ["245"]`,
  `must_not_mention: ["240", "250", "260"]` (fabricated-number tripwires), `no_markdown`, `max_sentences`.

**(b) New Tier-1 deterministic checks** (registered in the closed enum `Tier1CheckName`
(`backend/tests/eval/schema.py:31`), the `TIER1_CHECKS` registry (`checks.py:276`), and — required by the registry-
closure tests at `test_golden_tier1.py:93-121` — exercised in the golden set and/or listed in
`test_harness_has_teeth.py::TIER1_CHECKS_EXERCISED_BY_TEETH` with a teeth entry):
- `CARRIES_TOOL_MATCHES_HAZARDS` — build the scenario's `RoundSession` (`checks.build_round_session`), call
  `app.caddie.tools.carries_payload(session, hole)`, assert the returned `carry_yards` set equals **exactly** the
  scenario's input hazard carries (no invented, none dropped) and `available` flags follow D3's honest-empty rules.

**(c) Tool-schema drift test** — new file **`backend/tests/eval/test_tool_parity.py`** (DB-free, same env-stub
preamble as `test_golden_tier1.py:18-21`):
- `test_tool_schema_identical_between_mouths` — for each name in the registry:
  `realtime` rendering (`realtime_relay.DEFAULT_TOOLS`) and `anthropic` rendering (`tools.TEXT_TOOLS`) have equal
  name sets, and per-tool `description` and `parameters == input_schema` are **deep-equal**; also assert
  `realtime_relay.DEFAULT_TOOLS is/== tools.realtime_tools()` so a hand-edit of the relay copy fails CI.
- `test_text_tools_are_deterministically_ordered` — `TEXT_TOOLS == sorted(by name)` and two serializations are
  byte-identical (`json.dumps(..., sort_keys=True)` stable) — the prompt-cache guard from D7.
- Update `backend/tests/test_realtime_tools.py`: `EXPECTED_TOOL_NAMES` unchanged; drop nothing; add nothing except
  the import continuing to resolve.

**(d) Loop unit tests** (DB-free) — new `backend/tests/test_caddie_tool_loop.py` with a fake Anthropic client
(pattern: `test_caddie_caching.py` monkeypatching):
- model that calls tools forever → loop issues exactly `_MAX_MODEL_CALLS` model calls and the last one carries
  `tool_choice={"type":"none"}` (structural stop);
- repeated identical tool call → resolved once, second occurrence served from `seen_calls`, loop force-texts next;
- tool resolver raising / timing out → `is_error` tool_result with calm copy, loop continues;
- parallel `tool_use` blocks → one user message containing all `tool_result` blocks;
- stateless ctx (`session=None`) → every tool resolves to the honest "No active round session" payload;
- token-budget breach → next call is forced text.

---

## Implementation steps (ordered)

1. **Create `backend/app/caddie/tools.py`**: canonical `CADDIE_TOOLS` registry, `realtime_tools()` /
   `anthropic_tools()` / `TEXT_TOOLS`, `ToolContext`, `resolve_tool`, and the six `*_payload` helpers **extracted**
   from `routes/caddie.py` (D2). Rewire `realtime_relay.py:42-141` to `DEFAULT_TOOLS = realtime_tools()` and the four
   session endpoints to delegate to the helpers. Run backend gates — behavior must be identical (existing
   `test_realtime_tools.py` green).
2. **Real `get_carries` backend**: `carries_payload` (D3) + `GET /caddie/session/{round_id}/carries` route + optional
   pydantic models in `models.py`. Unit tests for the honest-empty matrix (no intel / empty hazards / zero-carry
   filter / no club distances) in `backend/tests/test_caddie_tools.py`.
3. **Real `get_carries` frontend**: `getSessionCarries` + `SessionCarries` in `caddie/api.ts`; replace the stub at
   `realtime.ts:126-134`; rewrite `realtime-dispatch.test.ts:78`; fix the `SessionConditions` drift (D6).
4. **Create `backend/app/caddie/tool_loop.py`** with `run_caddie_turn` (D4) + `backend/tests/test_caddie_tool_loop.py`
   (D8d).
5. **Wire the four text endpoints** to the loop: `session_voice` + `voice_caddie` (AsyncAnthropic, consume events),
   `_sse_reply` (map events to SSE frames incl. `event: status`). Add the additive tool instruction line to both
   prompt builders. Persistence, error copy, usage logging unchanged.
6. **Frontend stream client**: `streamCaddieReply` handles `event: status` (re-arm watchdogs, optional `onStatus`);
   `CaddieSheet.tsx` optionally surfaces the label in the existing thinking pulse. No new phases.
7. **Eval additions** (D8): golden scenario, `CARRIES_TOOL_MATCHES_HAZARDS` check + registry/teeth entries,
   `tests/eval/test_tool_parity.py`.
8. **Run all gates** (below), then `/security-review` + `/code-review` (new endpoint + new model-call surface
   qualifies as a major change per CLAUDE.md).

## Risks & edge cases

- **Loop runaway / cost:** bounded structurally (3 model calls, 900 output-token budget, per-tool 6s timeout, 25s/1-
  retry per model call → worst-case wall clock ≈ 3×50s + 2×6s; typical tool turn ~4-8s). `max_tokens=300` per call
  caps each round. Usage logged per call via `_log_caddie_usage` for cost telemetry.
- **Injection via tool results:** results are server-generated JSON from our own session/DB state, but
  `strategy_guide` (LLM-written) and memories are indirectly attacker-influenced text. Results are passed as
  `tool_result` data blocks (not system text), size-clipped at 4000 chars, and never interpolated into `system`.
  Never echo raw exception text into a tool_result (calm copy only).
- **Parity drift:** killed by construction (one registry) + the drift test; the frontend `dispatchTool` switch and
  server `resolve_tool` share endpoint semantics because both call the same `*_payload` helpers.
- **Empty/missing session data:** every resolver returns honest unavailable/empty payloads (D3 matrix, stateless
  ctx); the schema-level descriptions already instruct "never invent a number".
- **First-token watchdog on old clients:** an already-deployed frontend ignores `status` frames; a >8s tool turn
  falls back to the stateless tier (today's behavior — no worse). Ships as one bundle, so the window is tiny.
- **Prompt-cache regression:** one-time bust on deploy (tools + new instruction line); verify
  `cache_read_input_tokens > 0` on the second call in staging logs (`_log_caddie_usage` already prints usage).
- **History pollution:** tool blocks never persisted (D4); asserted in the loop unit tests by inspecting the
  `append_message_pair` call args.
- **Model behavior:** `ANTHROPIC_MODEL` default (`claude-sonnet-4-5-20250929`, `temperature=0.7`) is untouched —
  changing model/params is out of scope for this item.

## Gates — Definition of done checklist

- [ ] `cd frontend && npm run lint && npx tsc --noEmit && npm run build && npx tsx voice-tests/runner.ts --smoke` — all green.
- [ ] `cd backend && ruff check .` — clean.
- [ ] Tier-1 eval: `cd backend && python -m pytest tests/eval -q` — all pre-existing scenarios/checks pass unchanged,
      new scenario + `CARRIES_TOOL_MATCHES_HAZARDS` + `test_tool_parity.py` pass.
- [ ] Non-DB backend unit tests: `cd backend && python -m pytest tests/test_realtime_tools.py tests/test_realtime_payload.py tests/test_realtime_grounding.py tests/test_caddie_caching.py tests/test_caddie_tool_loop.py tests/test_caddie_tools.py -q`.
      (**No local Postgres** — DB-backed tests run in CI only; never spin up a container.)
- [ ] Frontend vitest for the touched files (`realtime-dispatch.test.ts`, `api.stream.test.ts`) pass.
- [ ] Drift test proves both mouths expose the identical 6-tool schema; `get_carries` returns real along-path carries
      on a mapped hole and honest empties elsewhere; stub removed at `realtime.ts:126` (grep returns nothing for
      `available: false,` stub comment).
- [ ] Manual evidence: one sheet turn asking "what carries the left bunker" on a mapped course shows a tool round
      (status frame) and cites the mapped carry; `/security-review` + `/code-review` findings folded in.
