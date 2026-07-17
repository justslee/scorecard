# Caddie Smart Strategy Tool — `get_strategy` (frontier reasoning behind the live voice)

Fixes: caddie model audit 2026-07-17, lever (b) — "ChatGPT does a better job caddying."
Plan by: Plan(fable) for the architecture; brain swapped to OpenAI per the owner directive
(2026-07-17) — see §0.1. Owner directive is authoritative over the planner's default.

## 0. Problem and shape of the fix

The live orb runs OpenAI `gpt-realtime` (a speech model). Today it fetches deterministic engine
numbers via the shared tools (`app/caddie/tools.py::CADDIE_TOOLS`) and does the strategy SYNTHESIS
itself — the weakest link. Fix: add a **realtime-only** tool `get_strategy`. The orb dispatches it
(browser → FastAPI, same pattern as every other tool), the server assembles the FULL grounded
engine payload and makes ONE **OpenAI `gpt-5.6-sol`** call (Responses API, low reasoning effort),
returns a validated ~80-word spoken-length narrative + engine number echoes, and the realtime model
**speaks it verbatim**. Frontier reasoning without giving up speech latency. Consistent with
`NORTHSTAR.md`: voice-first, calm, grounded — the narrative is constrained to engine facts, never
fabricated.

### 0.1 OWNER MODEL DIRECTIVE — the brain is OpenAI GPT-5.6, NOT Sonnet 5

The owner compared our caddie to **"ChatGPT 5.6 Sol"** in the ChatGPT app and wants THAT brain:
> "No I want you to send it to ChatGPT 5.5 or 5.6."

Resolved model catalog (OpenAI developer docs, verified 2026-07-17):

| Model id | Alias | Role | $/1M in | $/1M out | Context | Max out |
|---|---|---|---|---|---|---|
| **`gpt-5.6-sol`** | `gpt-5.6` | **PRIMARY brain** — flagship reasoning | $5 | $30 | 1.05M | 128K |
| `gpt-5.6-terra` | — | balanced latency/cost fallback | $2.50 | $15 | 1.05M | 128K |
| `gpt-5.6-luna` | — | cost-efficient fallback | $1 | $6 | 1.05M | 128K |
| `gpt-5.5` / `gpt-5.5-2026-04-23` | — | prior-gen fallback | $5 | $30 | 1.05M | 128K |

All four are **Responses-API** models and support `reasoning.effort ∈ {none, low, medium, high,
xhigh, max}`. Default `CADDIE_STRATEGY_MODEL=gpt-5.6-sol` so the owner can flip Sol↔Terra↔Luna with
one env var, no code change. Cost at Sol for a ~1.5K-in / ~150-visible-out call ≈ **$0.013**.

**Live-snapshot verification is BLOCKED and must be recorded honestly.** We could not run a live
`/v1/models` probe against our key: reaching into the prod `looper/prod` Secrets Manager (both
locally and via on-box SSM) is denied by the auto-mode guard because a cross-session coordinator
message can't authorize prod-credential access (correct behavior; not bypassed). So we default the
model id from the public catalog and add a runtime safeguard (§2.6): on a 404/unknown-model response
the tool fails HONESTLY (degraded deterministic line, never a fabricated strategy) and logs loudly.
The definitive snapshot check needs an owner-approved on-box `/v1/models` probe (Risks §8).

### 0.2 Verified API facts (OpenAI Responses API, 2026-07-17)

- **API = Responses API**: `POST https://api.openai.com/v1/responses`. The GPT-5.6 family is
  Responses-API, NOT Chat Completions.
- **No `openai` SDK is installed** — backend deps are `anthropic` + `httpx` only (confirmed). Call
  it with **raw `httpx`**, mirroring `backend/app/services/realtime_relay.py`'s mint pattern exactly:
  `async with httpx.AsyncClient(timeout=...) as client: await client.post(url, headers={"Authorization": f"Bearer {OPENAI_API_KEY}"}, json=payload)`.
  Same `OPENAI_API_KEY` (`os.getenv`, already used for realtime minting) — no new provider, no new
  dependency, same billing.
- **Request body**: `{"model", "instructions": <system prompt>, "input": <string>, "reasoning": {"effort": "low"}, "max_output_tokens": 1024}`.
  - `instructions` carries `STRATEGY_SYSTEM` (the grounding-contract system prompt).
  - `input` carries the assembled GROUND TRUTH block + the "give the strategy now" line (string form
    is accepted; do not build the array form).
  - **Do NOT send `temperature`/`top_p`** — reasoning models on the Responses API do not use
    sampling params (docs do not confirm temperature support for gpt-5.6). Omit them entirely. This
    differs from the Claude conditional-temperature pattern — there is NO `_accepts_temperature`
    helper to reuse or invent here.
  - `max_output_tokens` on a reasoning model bounds **reasoning tokens + visible output tokens
    together** (this is the audit's max_tokens/reasoning-interaction flag, resolved for the OpenAI
    path). At `effort:"low"` reasoning is modest; **1024** comfortably covers low-effort reasoning +
    a ~110-token (~80-word) spoken reply. The 80-word ceiling is enforced by the prompt, not by
    `max_output_tokens`. If a run comes back `status:"incomplete"` with
    `incomplete_details.reason == "max_output_tokens"`, treat it as a failed synthesis → degrade
    (§2.6). A/B candidate for lower latency: `reasoning.effort:"none"` (removes reasoning tokens
    entirely) — measure both (§5).
- **Response shape** (raw httpx — there is NO reliable top-level `output_text` convenience without
  the SDK, so PARSE it): `{"status": "completed"|"incomplete", "incomplete_details": {...}?, "output": [ {"type":"reasoning",...}, {"type":"message","content":[{"type":"output_text","text":"..."}]} ], "usage": {"input_tokens":N, "output_tokens":N, ...}}`.
  Extract text = concatenation of `c["text"]` for every item in `output[]` with `type=="message"`,
  over its `content[]` items with `type=="output_text"`. Reasoning items carry no user-visible text
  and are skipped. Log `usage.input_tokens`/`output_tokens` + latency (cost audit trail), key-free.

## 1. Tool contract (`backend/app/caddie/tools.py`)

### 1.1 Registry entry — new module constant `REALTIME_ONLY_TOOLS`

Add after `CADDIE_TOOLS` (do NOT touch `CADDIE_TOOLS`, `anthropic_tools()`, or `TEXT_TOOLS` — the
text mouths' tool list must stay byte-identical so the Anthropic prompt-cache prefix is untouched,
plan D7):

```python
# ── Realtime-only tools (specs/caddie-smart-strategy-tool-plan.md) ──────────
# NOT in TEXT_TOOLS: the text mouth is already Claude — a nested-LLM tool
# there is circular, and a frontier synthesis call inside the tool loop's 6s
# _TOOL_RESOLVE_TIMEOUT_S (app/caddie/tool_loop.py) would routinely time out.
# Keeping TEXT_TOOLS byte-identical also preserves the text path's cached
# prompt prefix (plan D7).
REALTIME_ONLY_TOOLS: list[dict] = [
    {
        "name": "get_strategy",
        "description": (
            "A full tee-to-green strategy for a hole, reasoned by the caddie "
            "brain from the real engine numbers (recommendation, plays-like, "
            "carries, hazards, green read, player profile). Call this for "
            "strategy and planning questions — 'how should I play this hole', "
            "'what's the play here', 'talk me through it', club-vs-club "
            "comparisons, risk/reward decisions. SPEAK the returned strategy "
            "text to the player as given — do not re-derive numbers or "
            "re-decide the club. For a single quick number (a club, a carry, "
            "a distance, a green read) use the specific tool instead — it is "
            "faster. If the reply marks data unavailable, say so plainly — "
            "never invent a strategy for an unmapped hole."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hole_number": {
                    "type": "integer",
                    "description": "Hole to plan (1-18). Omit for the current hole.",
                },
            },
        },
    },
]
```

### 1.2 `realtime_tools()` — render shared + realtime-only, sorted, byte-stable

```python
def realtime_tools() -> list[dict]:
    return [
        {"type": "function", "name": t["name"], "description": t["description"],
         "parameters": t["input_schema"]}
        for t in sorted(CADDIE_TOOLS + REALTIME_ONLY_TOOLS, key=lambda t: t["name"])
    ]
```

`get_strategy` sorts between `get_shot_distance` and `record_shot` — the merged list stays
name-sorted and constant at import (update the module docstring's D7 wording: TEXT_TOOLS =
CADDIE_TOOLS only; realtime = CADDIE_TOOLS + REALTIME_ONLY_TOOLS, both order-stable).
`realtime_relay.DEFAULT_TOOLS = realtime_tools()` picks this up with zero relay changes.

### 1.3 `resolve_tool` — NO new branch

`_TOOL_NAMES` stays derived from `CADDIE_TOOLS` only. The text loop can never emit `get_strategy`
(not in its schema); a non-compliant caller hits the existing unknown-tool guard
(`{"error": "Unknown tool: get_strategy"}`) — correct and honest. The ORB dispatches `get_strategy`
via a NEW HTTP endpoint (mirroring `/session/recommend`), not `resolve_tool`. Add a one-line comment
above `_TOOL_NAMES` noting REALTIME_ONLY_TOOLS are deliberately excluded.

## 2. New module `backend/app/caddie/strategy.py` (the brain) + endpoint

### 2.1 Model + reasoning-effort resolvers (dedicated-env pattern, à la `GUIDE_WRITER_MODEL`)

```python
import os

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"

def _strategy_model() -> str:
    # Dedicated env — OpenAI's frontier reasoning model, per the owner
    # directive (specs §0.1). Separate from the text mouth's ANTHROPIC_MODEL:
    # the strategy brain intentionally runs a stronger, different-provider model.
    return os.getenv("CADDIE_STRATEGY_MODEL", "gpt-5.6-sol")

def _strategy_reasoning_effort() -> str:
    # 'low' for the ~2s speakable budget; 'none' is a faster A/B (§5).
    return os.getenv("CADDIE_STRATEGY_REASONING_EFFORT", "low")
```

Constants: `_STRATEGY_MAX_OUTPUT_TOKENS = 1024` (§0.2 — covers low-effort reasoning + the ~110-token
spoken reply), `_STRATEGY_TIMEOUT_S = 10.0`, no retry loop (this call sits inside a live voice turn —
one attempt, then degrade). **No `temperature`/`top_p`. No tools.**

### 2.2 Payload assembly — `build_strategy_payload(session, round_id, user_id, hole_number, *, distance_to_green_yards, hole_yards, yardage_basis) -> dict`

Assemble from the EXISTING helpers (single source of truth, parity by construction):
- `recommendation`: `await recommend_payload(session, round_id, hole_number, par=intel.par if intel else 4, yards=resolved_yards, yardage_basis=resolved_basis)` where `resolved_yards` follows the exact
  `/session/voice` ladder: `distance_to_green_yards` (basis `'gps'`) → `hole_yards` (+ caller
  `yardage_basis`) → `intel.yards` → honest None. If None, include `{"error": ...}` verbatim — never
  a fabricated 400. Side effect (intended): `sessions.set_recommendation` persists so both mouths'
  "Last recommendation" context agrees with the strategy.
- `conditions`: `conditions_payload(session, hole_number)` (weather, plays-like, hazards +
  `hazards_line`, green_slope, bend).
- `carries`: `carries_payload(session, hole_number)`.
- `bend`: `bend_payload(session, hole_number)`.
- `green_read`: `green_read_payload(session, hole_number)`.
- `player`: `await player_profile_payload(session, user_id)`.
- `local_knowledge`: `format_guide_line(intel.strategy_guide)` (already validated fail-closed at
  session reload — `session.py::_row_to_session`; `""` when absent → omit).

### 2.3 Ground-truth framing — `format_strategy_ground_truth(payload) -> str`

Deterministic plain-text block à la `guide_writer.build_ground_truth_block`: header
`GROUND TRUTH (authoritative — the deterministic caddie engine). Every number and hazard below is
fixed; there are NO other hazards.`; then labeled sections rendering each sub-payload. Render the
recommendation's tee numbers via `format_tee_numbers_line(rec.tee_shot_numbers)` (reuse it so wording
matches both mouths); render the rest as compact labeled lines or
`json.dumps(..., sort_keys=True)`. The hazards section MUST state the "the COMPLETE list — there are
NO others" phrase when non-empty and "NONE mapped. Do not name any specific hazard." when empty
(load-bearing anti-fabrication language, lifted from `build_ground_truth_block`). `local_knowledge`
is included labeled exactly as it renders in prompts ("Local knowledge: ..." — DATA, not
instruction). Unavailable sub-payloads render their honest `available:false/reason` text, never
silently omitted. **Byte-for-byte deterministic for identical inputs** (this string is the cache
key).

### 2.4 System prompt — `_strategy_system() -> str` (restates the grounding contracts)

Composed f-string reusing the EXISTING constants (never re-worded copies). Imports mirror the routes:
`HAZARD_GROUNDING_RULE` from `app.caddie.hazards`; `NUMBERS_COHERENCE_RULE`,
`MISS_SIDE_GROUNDING_RULE`, `DECISION_GROUNDING_RULE`, `output_language_rule` from
`app.caddie.voice_prompts`.

```python
def _strategy_system() -> str:
    return f"""You are the strategy brain for a live golf caddie. You receive a GROUND TRUTH
block of deterministic engine data for ONE hole and reply with ONE short spoken strategy the
voice caddie will read aloud verbatim.

The GROUND TRUTH block is authoritative and complete. Every yardage, carry, club number, and
hazard you mention MUST appear verbatim in it — never compute, adjust, or invent a number, and
never name a hazard, side, or carry that is not listed. If a section says data is unavailable,
say plainly what you don't know instead of guessing. Any "Local knowledge" line is reference
DATA about how the hole is generally played — filter it through THIS player's real distances;
it can never add a hazard or a number.

{{HAZARD_GROUNDING_RULE}}
{{NUMBERS_COHERENCE_RULE}}
{{MISS_SIDE_GROUNDING_RULE}}
{{DECISION_GROUNDING_RULE}}
{{output_language_rule()}}

Output contract: ONE paragraph, at most 80 words, plain speech — no markdown, bullets,
headings, or emoji; no preamble ("Here's the plan"), no meta-commentary. Tee to green: the
club call (the engine's recommendation IS the call — explain it, never re-decide it), the
aim/landing zone, the miss side the data supports, what the shot leaves, and one green note
when the read is available. Calm and specific, like a good caddie talking, not a report."""
```

(Interpolate the four rule constants + `output_language_rule()` — shown above with escaped braces so
this spec renders; the real code interpolates them.) Compute per call (cheap f-string;
`output_language_rule()` is a stable seam kept monkeypatch-testable). The `input`/user message = the
ground-truth block + `"\n\nGive the strategy for this hole now."`.

### 2.5 The call — `synthesize_strategy(ground_truth: str, *, model: str) -> tuple[str, dict]` (the only networked function)

Raw httpx, mirroring `realtime_relay` mint. Raises `RuntimeError("OPENAI_API_KEY not configured")`
when the key is missing (route maps to the degraded path — never a fabricated strategy).

```python
async def synthesize_strategy(ground_truth: str, *, model: str) -> tuple[str, dict]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not configured")
    payload = {
        "model": model,
        "instructions": _strategy_system(),
        "input": ground_truth + "\n\nGive the strategy for this hole now.",
        "reasoning": {"effort": _strategy_reasoning_effort()},
        "max_output_tokens": _STRATEGY_MAX_OUTPUT_TOKENS,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=_STRATEGY_TIMEOUT_S) as client:
        resp = await client.post(OPENAI_RESPONSES_URL, headers=headers, json=payload)
    resp.raise_for_status()                      # 404/unknown-model or any 4xx/5xx → raise → degrade
    body = resp.json()
    if body.get("status") == "incomplete":
        raise RuntimeError(f"strategy synthesis incomplete: {body.get('incomplete_details')}")
    text = _extract_output_text(body)            # concat output[].content[] where type=="output_text"
    if not text.strip():
        raise RuntimeError("strategy synthesis returned no text")
    usage = body.get("usage") or {}
    return text, usage
```

`_extract_output_text(body)`: iterate `body["output"]`; for items with `type=="message"`, iterate
`item["content"]` and collect `c["text"]` where `c["type"]=="output_text"`; join. Log
`context="session_strategy"`, model, `usage.input_tokens`/`output_tokens`, latency ms (cost audit
trail, à la guide_writer's cost-guard logging) — key-free.

### 2.6 Deterministic fail-closed output validation — `validate_strategy_text(text, hazards) -> Optional[str]`

Reuse `guide_writer`'s pure machinery (import the module-level pieces):
1. Whitespace-flatten to one line (`" ".join(text.split())`) — the spoken contract is single-line.
2. Hazard-type scan: any `_HAZARD_PATTERNS` match whose canonical type ∉ `{hz.type for hz in hazards}`
   → reject (fail-closed, `validate_guide` rules 2/3).
3. Side-flip scan: `_has_side_flip([text], hazards_by_type)` → reject (Red-1 class — wrong-side miss
   claims cannot ship).
4. Injection scan: same regex class as `validate_guide` (ignore/instructions/you are/system prompt/
   URLs/HTML) → reject.
5. Length caps: reject empty, or > 600 chars.

On reject (or on any API/timeout/incomplete failure): DO NOT retry the LLM. Return a **degraded
deterministic line** composed purely from engine data:
`f"{rec['club']}. {format_tee_numbers_line(tee_shot_numbers)} Aim: {aim}. Miss: {miss_side}."`
(plus green-read side when available), `degraded=True`. Honest, grounded, the orb still has something
true to speak. When even the recommendation is unavailable → route returns
`{"available": false, "reason": ...}` like the other tools' honest empties and the realtime model
says it can't build a plan here.

### 2.7 Caching — module-level, keyed by payload hash

`RoundSession` is re-hydrated from Postgres per request, so a session-object field wouldn't persist
across dispatches. Use an in-process cache in `strategy.py` (single-worker uvicorn — see the
`_CADDIE_TIMEOUT_S` "single worker" comment):

```python
_CACHE: dict[str, tuple[float, dict]] = {}   # sha256(ground_truth + "\n" + model) -> (ts, response_dict)
_CACHE_TTL_S = 15 * 60
_CACHE_MAX = 256   # evict oldest beyond this
```

Invalidation is **structural**: any change in weather refresh, recommendation, shots, or yardage
basis changes the ground-truth bytes → new hash → fresh synthesis; identical re-asks (consistency
probe, "say that again") hit the cache and return the byte-identical narrative in <150ms. TTL guards
weather staleness. Never persist to the DB (no migration; `backend/migrations/versions/` untouched).

### 2.8 Endpoint — `backend/app/routes/caddie.py`

```python
class SessionStrategyRequest(BaseModel):
    round_id: str
    hole_number: Optional[int] = None      # None → session.current_hole (conditions_payload convention)
    # This turn's resolved yardage ride-along — same trio /session/voice carries
    # (specs/caddie-yardage-gps-selected-tee-plan.md §2.4); honest None allowed.
    distance_to_green_yards: Optional[int] = None
    hole_yards: Optional[int] = None
    yardage_basis: Optional[str] = None

class SessionStrategyResponse(BaseModel):
    available: bool = True
    hole_number: int
    strategy: Optional[str] = None      # spoken narrative (verbatim delivery)
    degraded: bool = False              # True = deterministic fallback line, not the model
    reason: Optional[str] = None        # honest-empty reason when available=False
    numbers: dict = {}                  # engine echoes: tee_shot_numbers, plays_like, carries,
                                        # green_read side, hazards_line

@router.post("/session/strategy", response_model=SessionStrategyResponse)
async def session_strategy(request: SessionStrategyRequest, user_id: str = Depends(caddie_rate_limited_user)):
    session = await get_owned_session(request.round_id, user_id)   # 404 auth gate
    hole = request.hole_number or session.current_hole
    ... build payload → ground_truth → hash → cache hit? → else synthesize+validate → cache put ...
```

Error hygiene mirrors `session_voice`: internals to `log.exception`; client sees the honest degraded
response (or an honest `available:false`); an OpenAI 401 (bad key) → `log.exception` + degraded (never
leak). **Missing OPENAI_API_KEY: prefer the degraded/honest path over a hard 500** when a
recommendation exists, so a lost env var never silences the caddie mid-round — never a fabricated
LLM strategy; log loudly either way. Rate-limited via the SAME `caddie_rate_limited_user` dependency
the other LLM-backed caddie routes use.

`numbers` block (echoes only, verbatim from payloads): `{"tee_shot_numbers": rec.get("tee_shot_numbers"), "plays_like": conditions["plays_like"], "hazards_line": conditions["hazards_line"], "carries": [{type, side, carry_yards} ...], "green_read": {"uphill_leave_side": ..., "available": ...}}`
— grounded material for the realtime model's follow-ups without re-calling tools.

## 3. Routing — `backend/app/caddie/voice_prompts.py`

Add a realtime-only constant (do NOT add to the text mouths' `stable_text` in `routes/caddie.py` —
`get_strategy` isn't in their schema):

```python
# Realtime-only routing + faithful-delivery rule for the get_strategy tool
# (specs/caddie-smart-strategy-tool-plan.md). Never appended to the text
# mouths' prompts — the tool exists only in the realtime schema.
STRATEGY_TOOL_RULE = (
    "For strategy and planning questions — 'how should I play this hole', "
    "'what's the play', 'walk me through it', comparing clubs or lines, "
    "risk-reward calls — call get_strategy and DELIVER its strategy text to "
    "the player faithfully, as given: you may trim a word for flow, but never "
    "change a number, club, side, or the call itself, and never blend in your "
    "own analysis. Re-writing it reintroduces the guesswork it exists to "
    "remove. For a single quick lookup — what club, how far, a carry, wind, "
    "a green read — use the specific engine tool instead; it is faster. If "
    "get_strategy reports data unavailable or a degraded line, speak what it "
    "gives you and say plainly what isn't known."
)
```

Wire-in: append inside `build_realtime_instructions` behavior block after `DECISION_GROUNDING_RULE`
(line ~247): `+ "\n" + STRATEGY_TOOL_RULE`. `_BASE_BEHAVIOR` stays untouched. **Latency
non-regression:** the simple `get_recommendation`/`get_shot_distance` path is unchanged — same tools,
same endpoints, same instructions except the additive rule telling the model the engine tools are
FASTER for single lookups.

Routing table (contract for the prompt text and eval probes):

| Question class | Tool |
|---|---|
| "How should I play this hole / what's the play / talk me through it" | `get_strategy` |
| "Driver or 3-wood here?" / risk-reward / comparison | `get_strategy` |
| "Where's the bad miss?" (whole-hole strategy framing) | `get_strategy` |
| "What club?" / "how far?" / "what does 7-iron carry?" | `get_recommendation` / `get_shot_distance` (unchanged) |
| Carry over the bunker / wind / green read / bend | existing specific tools (unchanged) |
| "I hit driver, fairway" | `record_shot` (unchanged) |

## 4. Frontend

### 4.1 `frontend/src/lib/caddie/api.ts` (following `sessionRecommend()`, ~line 220)

```typescript
export interface SessionStrategy {
  available: boolean;
  hole_number: number;
  strategy: string | null;
  degraded: boolean;
  reason: string | null;
  numbers: Record<string, unknown>;
}

export async function sessionStrategy(params: {
  round_id: string;
  hole_number?: number;
  distance_to_green_yards?: number;
  hole_yards?: number;
  yardage_basis?: string;
}): Promise<SessionStrategy> {
  return post('/caddie/session/strategy', params);
}
```

Keep the interface field-for-field in sync with backend `SessionStrategyResponse` (shared-types
touchpoint, CLAUDE.md convention).

### 4.2 `frontend/src/lib/voice/realtime.ts` — `dispatchTool` case (after `get_green_read`, ~line 179)

```typescript
case 'get_strategy': {
  // Frontier-reasoned tee-to-green strategy, synthesized server-side by the
  // caddie brain (OpenAI gpt-5.6-sol) from the same engine payloads the other
  // tools read. The holeYards/basis ride-along mirrors get_recommendation:
  // the server's recommendation solve must use THIS turn's resolved yardage,
  // never a stale cached number (no-fake-data). The persona speaks `strategy`
  // faithfully (STRATEGY_TOOL_RULE) — never re-synthesizes.
  return await sessionStrategy({
    round_id: ctx.roundId,
    hole_number: args.hole_number != null ? Number(args.hole_number) : undefined,
    hole_yards: ctx.holeYards ?? undefined,
    yardage_basis: ctx.yardageBasis ?? undefined,
  });
}
```

`hole_number` omitted by the model → request model `hole_number: Optional[int] = None` resolves to
`session.current_hole` server-side (matches `conditions_payload`'s `hn = hole_number or
session.current_hole`). The `toolContextProvider` (line ~263, read at ~1130) already supplies
`holeYards`/`yardageBasis` — no change there. `distance_to_green_yards` (live GPS) is not currently
in the tool context; if `holeYards` already reflects the GPS-resolved number per `hole-yardage.ts`,
passing it as `hole_yards` + basis is sufficient — do NOT add new plumbing in this slice.

## 5. Latency plan

Target: **p50 ≤ ~2s** tool-call→reply-ready (server round-trip as measured; browser adds
~50–150ms RTT). Budget: session load + payload assembly ≤200ms (existing per-tool endpoints already
do this) + one `gpt-5.6-sol` `effort:"low"` call generating a ~110-token visible reply ≈ 1–2s. Cache
hits ≤150ms.

Measurement: NEW gated live runner `backend/tests/eval/run_strategy_latency.py`, cloned from
`run_latency.py`'s three-guard shape:
1. Filename not `test_*.py` (pytest never collects; pin in `test_substance_teeth.py` alongside the
   existing filename pins).
2. `main()` refuses unless `OPENAI_API_KEY` AND `CADDIE_EVAL_LIVE=1` (this probe needs the OpenAI
   key — the strategy brain is OpenAI, NOT Anthropic).
3. `.github/workflows/ci.yml` untouched.

It builds a fixture ground-truth block (reuse a golden scenario's hazards/clubs — no DB), calls
`strategy.synthesize_strategy` N times (default 5; `--model` override to sweep `gpt-5.6-terra` /
`gpt-5.6-luna`; `--effort` override to A/B `none` vs `low`), reports p50/p95 via `run_latency._p95`
(import the clamped inclusive-quantile helper), writes key-free JSON to a gitignored
`last_strategy_latency_run.json`. Invocation:
`cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_strategy_latency --n 5`.

**Honest gated-run note (required in the PR):** if the build env has no `OPENAI_API_KEY`, state
exactly: "Strategy latency probe is gated live (needs OPENAI_API_KEY + CADDIE_EVAL_LIVE=1); not run
in this environment — run the command above on the Mac (or an owner-approved keyed env) to record
p50/p95 before enabling by default." Never paste fabricated numbers.

Fallback tiers (quality-vs-latency table for the owner, no code change — env swap only):
- `CADDIE_STRATEGY_MODEL=gpt-5.6-terra` ($2.50/$15) — faster/cheaper, slightly weaker synthesis.
- `CADDIE_STRATEGY_MODEL=gpt-5.6-luna` ($1/$6) — fastest/cheapest, weakest.
- `CADDIE_STRATEGY_REASONING_EFFORT=none` — drop reasoning tokens for lower latency at any tier.
The deterministic validator (§2.6) fail-closes fabrication regardless of tier, so the floor is safe;
the ceiling (reasoning quality) is what the env trades. Owner default stays `gpt-5.6-sol` + `low`.

## 6. Evals

### 6.1 Offline (CI, key-free) — new `backend/tests/eval/test_strategy_tool.py` + amend `test_tool_parity.py`

Amended parity contract (same PR, deliberate change — replace `test_tool_schema_identical_between_mouths`):

```python
def test_text_tools_are_a_schema_equal_subset_of_realtime():
    realtime_by_name = {t["name"]: t for t in realtime_relay.DEFAULT_TOOLS}
    text_by_name = {t["name"]: t for t in tools_mod.TEXT_TOOLS}
    assert set(text_by_name) <= set(realtime_by_name)
    for name, tx in text_by_name.items():
        rt = realtime_by_name[name]
        assert rt["type"] == "function", name
        assert rt["description"] == tx["description"], f"description drift on {name!r}"
        assert rt["parameters"] == tx["input_schema"], f"schema drift on {name!r}"
    # Realtime EXTRAS explicitly enumerated — a new extra must be added here consciously.
    assert set(realtime_by_name) - set(text_by_name) == {"get_strategy"}
    assert len(realtime_relay.DEFAULT_TOOLS) == len(tools_mod.CADDIE_TOOLS) + len(tools_mod.REALTIME_ONLY_TOOLS)
    assert realtime_relay.DEFAULT_TOOLS == tools_mod.realtime_tools()

def test_realtime_tools_are_deterministically_ordered():
    names = [t["name"] for t in tools_mod.realtime_tools()]
    assert names == sorted(names) and len(set(names)) == len(names)
```

`test_text_tools_are_deterministically_ordered` stays as-is (TEXT_TOOLS unchanged). New offline unit
tests (DB-free, same env-stub header as `test_tool_parity.py`):
- **Payload/ground-truth assembly**: fixture session → `format_strategy_ground_truth` contains the
  exact hazard lines, the "COMPLETE list" phrase (or "NONE mapped" when empty), the
  `format_tee_numbers_line` rendering verbatim, and is byte-identical across two calls (cache-key
  determinism).
- **Prompt-contract pins**: `_strategy_system()` contains `HAZARD_GROUNDING_RULE`,
  `NUMBERS_COHERENCE_RULE`, `MISS_SIDE_GROUNDING_RULE`, `DECISION_GROUNDING_RULE`, the 80-word/
  no-markdown output contract, and the language rule.
- **Routing-text pins**: `build_realtime_instructions(...)` output contains `STRATEGY_TOOL_RULE`;
  the two text-mouth `stable_text` builders do NOT contain "get_strategy".
- **Request-shape pin (no sampling params, correct reasoning field)**: with a fake httpx transport
  capturing the POST body, assert the payload has `reasoning == {"effort": "low"}`,
  `max_output_tokens == 1024`, `instructions`/`input` present, and **no `temperature`/`top_p` key**.
- **Response parse**: `_extract_output_text` pulls text from a canned Responses body with a
  `reasoning` item + a `message` item with `output_text` content; `status:"incomplete"` → raises →
  route degrades.
- **Validator (Red-1 class, offline)**: side-flipped narrative ("bunkers right" vs geometry-left) →
  rejected; invented hazard type on a hazard-less hole → rejected; injection text → rejected; a clean
  narrative naming only real hazards/sides → passes; rejection returns the degraded deterministic line
  containing the tee-numbers block verbatim.
- **Cache**: same ground-truth twice → one synth call (fake-client call-count), identical response;
  changed weather byte → second synth.

### 6.2 Gated live (never CI)

- **Consistency through the new path**: same fixture 5× → cache returns the identical string 5/5
  (true by construction; the probe's value is asserting the FIRST synthesis is side-correct — run
  `extract_substance` on the narrative and check `hazards`/miss-side against the fixture geometry,
  Red-1 class), plus 5× with `--no-cache` to measure raw model variance under the no-sampling-params
  regime.
- **Side-by-side brain comparison (owner-requested data)**: same grounded payload to
  `gpt-5.6-sol` vs `claude-sonnet-5`, judged on the goldens (owner's preference is the default either
  way; the data is worth having). Gated live; add a `--compare-model claude-sonnet-5` mode to the
  strategy runner (the Anthropic path reuses `guide_writer`'s client construction), or a small sibling
  script. Report the judge verdicts + latency side by side.
- **Tier-2 goldens** (`golden/caddie_advice.jsonl`): the existing Tier-2 harness evals the TEXT path;
  the realtime mouth isn't directly evaluable offline. Do NOT force `get_strategy` into that harness.
  Instead add 2–3 golden-style fixture scenarios to `test_strategy_tool.py` reusing `schema.py`
  scenario geometry (e.g. trees-both-sides-no-good-miss, dogleg-corner-bunker-not-fabricated)
  asserting the VALIDATOR verdict on canned good/bad narratives, and (gated) the live synthesis for
  those payloads passes validation and is side-correct. Challenge-and-admit stays a text/realtime
  prompt behavior — unchanged, still covered by the existing goldens; the strategy narrative's numbers
  coming verbatim from `tee_shot_numbers` makes re-derivation consistent by construction.

## 7. Text-path parity — assessment (do NOT wire)

Recommendation: **do not add `get_strategy` to the text mouths.** Confirmed in code:
1. `tool_loop.py::_TOOL_RESOLVE_TIMEOUT_S = 6.0` — every resolution runs under
   `asyncio.wait_for(6.0)`. A frontier synthesis call (p50 1–2s, p95 potentially >6s) would
   intermittently hard-fail into the calm `{"error": "tool unavailable right now"}` path mid-round.
2. Circularity + double cost: the text mouth IS an LLM; the correct text-path lever is upgrading its
   own model (`caddie-advice-sonnet5-flip`, one env var), not nesting a second-provider call as a
   tool.
3. Prompt-cache: `TEXT_TOOLS` is a byte-stable cached-prefix constant (D7); adding a tool busts it
   for zero benefit.

"One brain, all mouths" convergence path (documented, not built): `_strategy_system()`'s grounding
composition and `format_strategy_ground_truth` live in `strategy.py` as importable units, so a future
text-path upgrade can reuse the exact wording/payload without the tool indirection.

## 8. Risks / edge cases

- **Unmapped hole**: every sub-payload returns honest `available:false`/empties; ground truth says
  "NONE mapped. Do not name any specific hazard."; system prompt orders admission; validator rejects
  any invented hazard type. Worst case: degraded line or `available:false` — never fabrication.
- **Missing `OPENAI_API_KEY` at runtime**: degraded deterministic line when a recommendation exists
  (true numbers), honest `available:false` otherwise; loud `log.exception`. Never a fabricated
  strategy, never a mid-round hard crash of the orb turn.
- **Unknown/unavailable model id on our key (the blocked-probe risk, §0.1)**: `raise_for_status()` on
  a 404 → route degrades honestly + logs the model id (key-free). An unavailable id surfaces loudly,
  never silently fabricates. Definitive fix: owner-approved on-box `/v1/models` probe to confirm the
  exact `gpt-5.6-sol` snapshot, then pin `CADDIE_STRATEGY_MODEL` to it.
- **`max_output_tokens` vs reasoning tokens**: at `effort:"low"`, 1024 covers reasoning + the ~110
  visible tokens; an `incomplete` (cap hit) is treated as a failed synthesis → degrade. `effort:"none"`
  removes the interaction entirely (A/B).
- **Injection via strategy_guide/payload**: guide is validated fail-closed at persist AND session
  reload (`validate_guide` in `_row_to_session`); ground truth frames everything as DATA; the output
  validator's injection regex is the third gate.
- **Prompt-cache stability**: TEXT_TOOLS untouched (text-path cache intact).
- **Parity-test contract change**: deliberate, same-PR, extras explicitly enumerated so any future
  realtime-only tool is a conscious edit (§6.1).
- **No sampling params**: none sent, ever — reasoning models don't use them; and the no-temperature
  regime helps the consistency probe.
- **Realtime model paraphrasing drift**: `STRATEGY_TOOL_RULE` orders faithful delivery; residual
  light rephrasing is acceptable (number/club/side changes are what the rule forbids; the `numbers`
  echo block grounds follow-ups).
- **Warm-pool/mint**: `DEFAULT_TOOLS` is computed at import; the new tool rides every future mint
  automatically; `SETUP_TOOLS` (setup flow) is untouched.

## 9. Gates (exact commands)

Backend: `cd backend && uv run ruff check .` · `cd backend && uv run pytest` (runs amended
`tests/eval/test_tool_parity.py`, new `tests/eval/test_strategy_tool.py`, existing route/integration
tests against the CI Postgres service). NO local Postgres — DB-backed tests run in the CI backend
gate, not locally.
Frontend: `cd frontend && npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke`
· `npm test` (vitest) · `npm run build`.
Gated (manual, keys + `CADDIE_EVAL_LIVE=1`, never CI): `uv run python -m tests.eval.run_strategy_latency --n 5`
· strategy consistency + side-by-side probe.
Process: new endpoint + new user-facing capability → `/security-review` and `/code-review` before
PR-ready (CLAUDE.md rule).

## 10. Implementation order / file-touch list

1. `backend/app/caddie/strategy.py` — NEW: `_strategy_model`, `_strategy_reasoning_effort`,
   `build_strategy_payload`, `format_strategy_ground_truth`, `_strategy_system`,
   `synthesize_strategy`, `_extract_output_text`, `validate_strategy_text`, cache.
2. `backend/app/caddie/tools.py` — `REALTIME_ONLY_TOOLS` + `realtime_tools()` merge + docstring/comment updates.
3. `backend/app/caddie/voice_prompts.py` — `STRATEGY_TOOL_RULE` + append in `build_realtime_instructions`.
4. `backend/app/routes/caddie.py` — `SessionStrategyRequest/Response` + `POST /session/strategy`.
5. `frontend/src/lib/caddie/api.ts` — `SessionStrategy` + `sessionStrategy()`.
6. `frontend/src/lib/voice/realtime.ts` — `case 'get_strategy'` in `dispatchTool`.
7. `backend/tests/eval/test_tool_parity.py` — amended contract; `backend/tests/eval/test_strategy_tool.py`
   — NEW offline suite; `backend/tests/eval/run_strategy_latency.py` — NEW gated probe (+ filename pin
   in `test_substance_teeth.py`).

## Summary

**Brain: OpenAI `gpt-5.6-sol`** (the owner's "5.6 Sol"; env `CADDIE_STRATEGY_MODEL`, fallbacks
terra/luna) via the **Responses API** over **raw httpx** (no SDK), `reasoning:{effort:"low"}`,
`max_output_tokens:1024`, **no temperature**, same `OPENAI_API_KEY` as realtime. **Tool:**
`get_strategy {hole_number?}` in a new `REALTIME_ONLY_TOOLS` list merged (name-sorted) into
`realtime_tools()`/`DEFAULT_TOOLS` only — never `TEXT_TOOLS` (nested LLM is circular + blows the 6s
tool timeout + busts the text prompt cache). Orb dispatches to `POST /caddie/session/strategy`
(auth `get_owned_session`), which assembles the existing engine payloads + `format_guide_line`, frames
them as a GROUND-TRUTH block, calls the brain, **fail-closed-validates** the narrative (hazard-type +
`_has_side_flip` + injection + length) or **degrades to a deterministic engine-numbers line** — never
fabrication. Response `{available, strategy, degraded, reason, numbers}`, in-process cached by
`sha256(ground_truth+model)` (TTL 15m). Realtime routing: a new `STRATEGY_TOOL_RULE` sends strategy/
comparison/risk-reward questions to `get_strategy` (spoken faithfully) and keeps single lookups on the
fast engine tools (no latency regression). Latency measured by a NEW gated OpenAI-keyed probe (target
p50 ≤ 2s; honest "not run — no key" note otherwise). Live `/v1/models` snapshot check is blocked under
auto-mode (prod-secret guard) — defaulted from the public catalog with a fail-honest 404 safeguard.
