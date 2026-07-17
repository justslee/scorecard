# Caddie Two-Tier Advice Routing — Structurally Enforced (+ Full Intent Router)

**Owner directive (2026-07-17, authority):** "if it is EASILY answerable by notes, we can use
a weaker model, but in general the brain should be a more advanced model with context of my
yardages / tendencies, known context of the course, and from the map data itself. That routing
is the crux of what we are trying to build." Extension (same day, via eng-lead): "the caddie
component is ALL encompassing … Depending on what I am saying, it should route the request to
different parts of my backend that can handle serving the request."

**Root cause being fixed (10th wrong-side recurrence):** the WEAK realtime speech model
composes advice from a grab-bag — the live payload, POISONED cached guides, and its own
judgment — because `_situation_block` (backend/app/caddie/voice_prompts.py:361-421) bakes
hazard-side detail (L386-389), bend (L390-392), guide text (L393-395), and green slope
(L396-397) directly into the session instructions. The fix is STRUCTURAL: strip the
ingredients from the mouth; route every advice-class ask to the one brain; verdict-pin the
brain's output to the deterministic engine; gate the cached guide at read time against the
engine's live verdict.

NORTHSTAR fit: voice-first, calm, no spinners — the bridge is spoken; nothing here adds UI
chrome. No VAD changes. Caller path inert. No new dependencies (brain call is existing raw
httpx). Never touch main.

---

## 0. Architecture (ratified — build exactly this)

**Fast path (FACT/OTHER):** unchanged instant deterministic engine tools
(`get_recommendation`, `get_conditions`, `get_carries`, `get_bend`, `get_green_read`,
`get_shot_distance`, `get_session_status`, `get_player_profile`, `record_shot`) + the
realtime voice / Claude text loop. The weak model only READS OUT tool numbers. Zero latency
tax, zero behavior change.

**Brain path (ADVICE — everything judgment-class):** MANDATORY route to
`CADDIE_STRATEGY_MODEL` (default `gpt-5.6-sol`, strategy.py:74) through ONE implementation:
the existing `get_strategy` seam, fed one complete payload —
(a) player yardages + tendencies (honest about heuristic vs learned, §7),
(b) course context with the cached guide DEMOTED to "prior notes — may be stale" and
    included only if it passes the read-time verdict gate (§5),
(c) live map/engine data (hazard sides/carries, corridor, green geometry, GPS plays-like).
Output verdict-pinned (§6) → fail-closed to `_degraded_line` (routes/caddie.py:768-785),
which is composed purely from engine data.

**Score path (SCORE — eng-lead extension):** live realtime session recognizes score-entry
asks and writes the scorecard via the EXISTING voice score parser + the EXISTING score write
path — a THIN ROUTING LAYER, zero rewrites. An explicit spoken score command writes DIRECTLY
with a minimal natural acknowledgment (NO confirm ceremony, no read-back-and-await); the
"never silent" rule applies to PASSIVE shot tracking only, not to explicit commands (§9).

**Enforcement is structural:**
- Realtime mouth: the strategy ingredients are REMOVED from its instructions (§3) — it has
  nothing to freelance with; it detects ask-class (strengthened `STRATEGY_TOOL_RULE`, §8),
  calls `get_strategy`, speaks the returned text verbatim.
- Text mouth: `classify_intent` runs server-side BEFORE the Claude loop (§4); ADVICE never
  reaches Claude — it goes to the same brain function, same cache, same validator.
- ONE brain, every mouth: `run_strategy_turn()` (§2) is the only advice composer.

---

## 1. Router design + THE ROUTING MATRIX (test contract)

New module: `backend/app/caddie/routing.py` (pure, no I/O, no app imports beyond stdlib).

```python
from enum import Enum

class Intent(str, Enum):
    ADVICE = "advice"   # judgment: club choice, how to play, miss/bail, risk-reward, layup
    FACT   = "fact"     # numbers/readouts: distances, carries, wind, green, score status
    SCORE  = "score"    # scorecard entry: "I made a 5", "put me down for…", "par for Mike"
    OTHER  = "other"    # chit-chat, repeats, unclassifiable → fast path

def classify_intent(transcript: str) -> Intent: ...
```

Deterministic, ordered, word-boundary regex over the lowercased transcript:
1. **SCORE first** (most specific): first-person past-tense/imperative score statements —
   `\b(i (made|had|got|shot|took)|put me down|give me a|mark (me|him|her|<name>)|(par|birdie|bogey|double( bogey)?|eagle|triple) for\b|\bfor me\b.*\b(par|birdie|bogey|\d)\b|scored?\b)` combined
   with a stroke word/number. EXCLUSION guard (pinned): `need to (shoot|make|score)` /
   `what (do|would) i need` → NOT score (falls through to FACT).
2. **ADVICE**: `what should i (hit|play|do)`, `(which|what) club`, `\bor\b` between two club
   names ("driver or 3-wood"), `how (do|should) i play`, `what's the play`, `walk me
   through`, `where('s| is| should) (the |my )?(miss|bail|bailout)`, `should i (go for|take
   on|lay ?up|challenge)`, `can i (take on|carry the corner|get there|go for)`, `lay ?up`,
   `risk`, `aim`, `favor`. Fail-toward-ADVICE: any club-vs-club or side-judgment phrasing
   classifies ADVICE even when mixed with fact words.
3. **FACT**: `how far`, `distance`, `what('s| is) the (carry|number|wind|front|back|middle)`,
   `plays like`, `how deep`, `green (depth|read|break)` *as a question about data*, `what do
   i need to shoot`, `where do i stand`, `what('s| is) my score`.
4. **OTHER**: everything else (repeats, thanks, chit-chat).

Extensibility (proved, not built): a future intent = one new `Intent` member + one pattern
list + one dispatch arm in the two consumers — no rearchitecture. Document TEE_TIME /
COURSE_SEARCH / NAVIGATION as reserved names in the module docstring.

### The matrix (each row = one parametrized offline test case)

| # | Canonical ask | Intent | Serving path |
|---|---|---|---|
| 1 | "How far to the green?" | FACT | yardage line / GPS readout |
| 2 | "What's the carry over the left bunker?" | FACT | `get_carries` |
| 3 | "How's the wind?" | FACT | `get_conditions` |
| 4 | "What does 150 play like right now?" | FACT | `get_shot_distance` |
| 5 | "How deep is the green?" | FACT | engine green data |
| 6 | "What's the front number?" | FACT | yardage readout |
| 7 | "What do I need to shoot par on the back nine?" | FACT | target computation — NOT score entry (pinned discriminator) |
| 8 | "What should I hit off this tee?" | ADVICE | brain |
| 9 | "Driver or 3-wood here?" | ADVICE | brain |
| 10 | "How do I play this hole?" | ADVICE | brain |
| 11 | "Where's the miss here?" / "which side do I bail?" | ADVICE | brain |
| 12 | "Should I go for it in two?" | ADVICE | brain |
| 13 | "Can I take on the corner?" | ADVICE | brain (verdict, not a number — "what's the carry AT the corner" is row 2) |
| 14 | "Where should I lay up?" | ADVICE | brain |
| 15 | "What's the play — attack this pin or play safe?" | ADVICE | brain |
| 16 | "I made a 5" | SCORE | score tool |
| 17 | "Put me down for a 5, par for Mike" | SCORE | score tool (multi-player) |
| 18 | "Bogey for me" | SCORE | score tool |
| 19 | "Say that again?" | OTHER | fast (repeat) |
| 20 | "Thanks, that was a great call" | OTHER | fast (chit-chat) |

---

## 2. One brain, every mouth — extract `run_strategy_turn`

**New file `backend/app/caddie/strategy_turn.py`** — move the body of
`routes/caddie.py::session_strategy` (currently L728-826: payload build → numbers echo →
honest-empty branch → `_degraded_line` → cache → synth → validate → degrade) into:

```python
async def run_strategy_turn(
    session: RoundSession, round_id: str, user_id: str, hole: int, *,
    distance_to_green_yards: int | None = None,
    hole_yards: int | None = None,
    yardage_basis: str | None = None,
) -> dict:   # exact SessionStrategyResponse field shape (available/hole_number/strategy/degraded/reason/numbers)
```

`routes/caddie.py::session_strategy` becomes a thin wrapper (auth + Pydantic in/out —
ownership stays in the route via `get_owned_session`, unchanged). Import direction stays
clean: `strategy_turn` imports only `app.caddie.*` (strategy, tools, types), never routes.
`_degraded_line` and the `numbers` echo move with it. No behavior change — pinned by the
existing route tests in `backend/tests/eval/test_strategy_tool.py` (L563-676) passing
unmodified.

**Text-path interception** — in `routes/caddie.py`:
- `session_voice` (L1072): after the API-key check and before `_build_session_voice_prompt`,
  run `intent = classify_intent(request.transcript)`. If `Intent.ADVICE`: skip the Claude
  loop entirely; call `run_strategy_turn(session, request.round_id, user_id,
  request.hole_number, distance_to_green_yards=request.distance_to_green_yards,
  hole_yards=request.hole_yards, yardage_basis=request.yardage_basis)`; the response text is
  the strategy (or degraded line); persist the user/assistant pair to the message ledger
  exactly as the normal path does; return `VoiceCaddieResponse(response=strategy_text)`.
- `session_voice/stream`: same interception; emit one `status` frame with the calm label
  `"reading the hole"` (new constant next to `TOOL_STATUS_LABEL`, tool_loop.py:43), then the
  strategy text as token/done frames using the endpoint's existing SSE framing.
- Stateless `/voice` + `/voice/stream`: OUT OF SCOPE for brain routing (no session, no
  engine data, nothing to pin against) — document in the handler docstring. They already
  carry no session guide.

Why (b) over (a)/(c): (a) `get_strategy` inside the loop nests a 10s
(`_STRATEGY_TIMEOUT_S`, strategy.py:88) network call inside `_TOOL_RESOLVE_TIMEOUT_S = 6.0`
(tool_loop.py:35) — structurally guaranteed timeouts — and mutating `TEXT_TOOLS` busts the
cached prompt prefix (tools.py:289-291, plan D7). (c) keeps two brains whose answers can
disagree across mouths mid-round, violating the owner's literal "ONE brain". (b) gives both
mouths one implementation, one cache key (`format_strategy_ground_truth` bytes), therefore
one answer.

---

## 3. Context strip — realtime (`voice_prompts.py::_situation_block`)

**Remove** (the freelancing fuel): hazards line (L386-389), bend line (L390-392), guide line
(L393-395), green-slope line (L396-397). **Keep** everything else, including the par-sanity
note (L383-385) and the last-recommendation lines (L398-413) — the recommendation IS the
engine's verdict (aim + miss + tee-shot numbers are exactly what `_degraded_line` speaks;
repeating a verdict is not composing one). Tee-shot numbers are KEPT: they are fast-path
facts the mouth reads out (NUMBERS_COHERENCE_RULE depends on them being present).

Exact edited block (the `if intel:` body shrinks to the par-sanity note only):

```python
def _situation_block(session: Optional[RoundSession]) -> str:
    if session is None:
        return ""
    lines: list[str] = []
    if session.handicap is not None:
        lines.append(f"Handicap: {session.handicap}")
    if session.club_distances:
        clubs = ", ".join(
            f"{CLUB_DISPLAY_NAMES.get(k, k)}: {v}y"
            for k, v in sorted(session.club_distances.items(), key=lambda x: x[1], reverse=True)
            if v
        )
        if clubs:
            lines.append(f"Player clubs: {clubs}")
    if session.weather:
        w = session.weather
        lines.append(
            f"Weather: {w.temperature_f:.0f}°F, wind {w.wind_speed_mph:.0f}mph from {w.wind_direction}°"
        )
    lines.append(f"Current hole: #{session.current_hole}")
    intel = session.hole_intel.get(session.current_hole)
    if intel:
        # Structural context strip (specs/caddie-two-tier-routing-plan.md §3):
        # hazard sides, bend, the cached guide, and green slope are STRATEGY
        # INGREDIENTS — they live server-side in the get_strategy brain payload
        # ONLY. Baking them here is what let the weak realtime model freelance
        # wrong-side advice (10 recurrences). Only the par-sanity note remains.
        par_sanity_note = format_par_sanity_note(intel.par, intel.yards)
        if par_sanity_note:
            lines.append(f"Hole {session.current_hole}, par {intel.par} {par_sanity_note}")
    if session.last_recommendation:
        ...  # L398-413 UNCHANGED (tee-shot numbers / aim / miss verbatim)
    recent_shots = session.shot_history[-5:]
    ...  # L414-421 UNCHANGED
```

Drop the now-unused imports (`format_bend_line`, `format_hazards_line`, `format_guide_line`
from voice_prompts.py:16-17) if nothing else in the module uses them.

**Untouched on purpose:** `keyterms.build_transcription_prompt` (routes/realtime.py:133) —
hazard words there bias the TRANSCRIBER, they are never generative context. The grounding
RULES (HAZARD/BEND/GREEN/MISS_SIDE) stay in the behavior block — they now defend tool
RESULTS instead of baked lines.

**Text-path equivalent** (`routes/caddie.py::_build_session_voice_prompt`, L948-972): remove
the hazards line (L961-964), bend line (L965-967), guide line (L968-970), and green-slope
line (L971-972) from `context_parts`. Keep the yardage line, elevation/effective-delta,
weather, handicap, clubs, last recommendation, recent shots. Claude now only ever answers
FACT/OTHER turns (ADVICE is intercepted, §2), and factual hazard asks resolve honestly
through `get_conditions`/`get_carries` tool results.

**Fact-tool results are not stripped** (both mouths): reading out "bunker left, carry 245"
from `get_carries` is a FACT readout. The mandatory routing rule (§8) forbids using those
results to CHOOSE a side — and the always-present baked channel, which is what the incidents
actually rode on, is gone.

---

## 4. Enforcement relationship (how §1 and §3 guarantee no un-brained advice)

- **Realtime**: enforcement is the STRIP. The mouth cannot compose side advice because it
  holds no side data; its only advice source is `get_strategy` (mandatory rule §8); its only
  verdict text in-context is the engine's own recommendation. `classify_intent` does not run
  in the realtime loop (the speech model self-routes to the tool) — the matrix still governs
  it via the strip test (§10.4) and the live eval probes.
- **Text**: enforcement is the CLASSIFIER — ADVICE is intercepted before Claude ever runs.
- **Both** advice outputs pass the same verdict-pinned validator and degrade to the same
  engine line. Residual channel (misrouted realtime ask + a fact-tool call + freelance
  composition) is bounded by: no baked fuel, MISS_SIDE_GROUNDING_RULE pinning any spoken
  miss side to the recommendation's, and the strengthened mandatory rule; tracked by the
  live routing probes (§10.8). This is stated honestly: the realtime strip is structural;
  the realtime tool-choice remains a strong prompt contract, as it must on a speech model
  with `tool_choice:"auto"` (realtime_relay.py:184).

---

## 5. Read-time guide gate (verdict-level — NEW, distinct from `validate_guide`)

`validate_guide` (guide_writer.py:877-999) checks hazard NAMING/side/carry grounding; it
never checks whether the guide's strategic FAVOR agrees with the engine's verdict. New:

**New file `backend/app/caddie/verdict.py`** (pure, shared by §5 and §6):

```python
_FAVOR_PATTERNS: list[tuple[re.Pattern, ...]]  # compiled, word-boundary
# favor/aim claims:   "favor the left", "aim (up the )?left", "hug the right",
#                     "up the left side", "left side is the play", "start it left"
# miss claims:        "best miss is left", "miss left", "bail (out )?left",
#                     "left is the (better|safe) miss"
# Opposition guard: reuse the SIDE-opposition idea from guide_writer (§_SIDE_OPPOSITION_
# PATTERN): "away from the left" / "avoid the left" claims the OTHER side — resolve to
# the opposite lateral before comparing.

def extract_favor_side(text: str) -> Optional[str]:
    """'left' | 'right' | 'conflict' | None. None = no lateral favor/miss claim.
    'conflict' = both laterals claimed as favor/miss-preference in one text."""

def guide_agrees_with_verdict(guide: HoleStrategyGuide, rec: dict) -> bool:
    """rec is recommend_payload's dict. Engine side = rec['miss_side']['preferred'].
    - engine in ('left','right'):  guide favor None -> True; same side -> True;
      opposite -> False; 'conflict' -> False (fail-closed on ambiguity).
    - engine == 'center' (both-sides / no good miss): any lateral favor -> False
      (THE Red-1 poison class); None -> True.
    - engine in ('short','long') (green-frame verdict): lateral guide claims are a
      different frame -> not comparable -> True (validate_guide already grounded them).
    - rec carries an 'error' (no recommendation) -> False (fail-closed: no live verdict
      to check against, so the prior notes are not included this turn)."""
```

Scan fields: `guide.play_line + " " + guide.miss_side` (the strategy-bearing fields;
green_notes/common_mistakes carry no tee-shot favor and false-reject risk is highest there).

**Application site — `strategy.py::build_strategy_payload` (L139-151)**, the guide's ONLY
remaining injection site after §3 removes voice_prompts.py:393 and caddie.py:968:

```python
guide = intel.strategy_guide if intel is not None else None
if guide is not None and not guide_agrees_with_verdict(guide, recommendation):
    log.warning(  # key-free, hole-scoped; never spoken
        "strategy guide dropped at read time: favor-side disagrees with engine verdict hole=%s",
        hole_number,
    )
    guide = None
...
"local_knowledge": format_guide_line(guide) if guide is not None else "",
```

**Demotion label** — in `format_strategy_ground_truth` (strategy.py:259-263), render the
non-empty guide line as:

```
PRIOR NOTES (may be stale — trust the live data above; these notes passed a live
side-agreement check but remain reference only): Local knowledge: ...
```

and update `_strategy_system` (strategy.py:278-281) "Local knowledge" sentence to the
prior-notes framing ("PRIOR NOTES are reference DATA about how the hole is generally
played — the GROUND TRUTH engine data above always wins on any disagreement; notes can
never add a hazard, a number, or a side").

---

## 6. Verdict-pinned output validator

Extend `strategy.py::validate_strategy_text` (L364-398) — backward-compatible signature:

```python
def validate_strategy_text(
    text: str, hazards: list[dict], recommendation: Optional[dict] = None,
) -> Optional[str]:
```

After the existing hazard-type / side-flip / injection scans, when `recommendation` is
given and carries no `error`:

1. **Favor-side pin**: `spoken = extract_favor_side(flat)`;
   engine = `recommendation["miss_side"]["preferred"]`.
   - engine 'left'/'right': `spoken` in (None, engine) passes; opposite or 'conflict' →
     `return None`.
   - engine 'center': any lateral `spoken` → `return None` (must speak both-sides truth).
   - engine 'short'/'long': lateral `spoken` → `return None` on a positioning turn
     (shouldn't occur — positioning verdicts are lateral/center), pass on approach turns.
2. **Reachability pin**: if `recommendation.get("shot_kind") == "positioning"`, reject
   pin-relative language: regex `\b(at|of|from) the (flag|pin)\b|\bdead aim\b|\bpin.high\b`
   → `return None` (POSITIONING_SHOT_RULE, enforced deterministically).
3. **Club pin (tee-shot turns only)**: if `recommendation.get("tee_shot_numbers")` and any
   club display name (`CLUB_DISPLAY_NAMES.values()`, case-insensitive) appears in `flat`,
   the recommended club's display name MUST be among them → else `return None`.

Caller (`run_strategy_turn`) passes `recommendation=rec` and logs the reject class
key-free. Implement the new checks as a helper
`_verdict_pin_reject_reason(flat, recommendation) -> Optional[str]` so the caller can log
the reason string: `log.warning("session_strategy: verdict-pin reject (%s) hole=%s", kind, hole)`.
Degrade behavior unchanged: `_degraded_line()` — the engine's own composed verdict — is what
gets spoken; degraded results are never cached (routes/caddie.py L819-822 semantics move to
`strategy_turn` intact).

---

## 7. Player payload — honest yardages + tendencies

`format_strategy_ground_truth` PLAYER block (strategy.py:251-257) becomes:

```
PLAYER:
  Handicap: {handicap}. Club distances (player-entered, still-air): {json}.
  Tendencies — learned from {rounds_analyzed} logged rounds
  (0 rounds = handicap-based heuristics, not this player's measured data):
    miss direction: {miss_direction}; misses short: {miss_short_pct}%;
    three-putts/round: {three_putts_per_round}; par-5 bogey rate: {par5_bogey_rate}%.
  Typical driver dispersion for this handicap band (TrackMan amateur reference,
  NOT measured for this player): ±{width/2:.0f}y lateral.
```

Sources (all existing — nothing fabricated): `player_profile_payload` (tools.py:557-583)
already returns `tendencies` + `rounds_analyzed`; the dispersion number comes from
`app.caddie.dispersion._DISPERSION_BY_CLUB_AND_HANDICAP` via its existing lookup fn for
`"driver"` at the session handicap. Omit any line whose source is None — never a
placeholder. `build_strategy_payload` already includes `player` (strategy.py:146); only the
renderer changes, so the cache key changes once (one-time cache turnover, same as any
ground-truth format change).

---

## 8. Realtime rule + thinking bridge (designer sign-off)

Replace `STRATEGY_TOOL_RULE` (voice_prompts.py:200-211) with the strengthened form (same
constant name; realtime-only as today):

```python
STRATEGY_TOOL_RULE = (
    "For EVERY advice question — what club to hit, how to play the hole, where to aim or "
    "miss, club-vs-club, layup or go, any risk call — you MUST call get_strategy and "
    "deliver its strategy text faithfully, as given: never change a number, club, side, or "
    "the call, and never blend in your own analysis. You do not carry this hole's trouble "
    "map; any advice you compose yourself will be ungrounded and wrong. Before the call, "
    "say ONE short natural acknowledgment in your own voice — like 'Let me look at this "
    "one.' or 'Give me a second to read this hole.' — then call the tool and wait; never "
    "fill the wait with numbers or guesses, and never leave dead air without the "
    "acknowledgment. For a single quick number — a distance, a carry, wind, a green "
    "read — use the specific engine tool instead; it is faster. If get_strategy reports "
    "data unavailable or a degraded line, speak what it gives you and say plainly what "
    "isn't known."
)
```

Mechanism: the Realtime model emits the acknowledgment audio and the function_call within
one response; the frontend tool dispatch (realtime.ts:1159-1218) then runs the ~3-4s brain
call (p50 measured by `tests/eval/run_strategy_latency.py`; cache hits <150ms) and
`response.create` triggers the answer. No spinner, no frontend timer, no new UI. The bridge
phrase list lives ONLY in this constant — the designer reviews this one diff. (Text path:
the stream's `"reading the hole"` status frame, §2, is the sheet's existing calm-status
rendering — designer reviews that copy too.)

---

## 9. SCORE intent — score entry from the live session (owner gap; PURE ROUTING, no rewrites)

**Reuse, not rebuild** (owner: "Our code already has the capability to do this so we don't
need to rewrite it just needs a routing layer"): transcript → the EXISTING parser
(`POST /api/voice/parse-scores`, backend/app/routes/voice.py:135, Claude-backed,
multi-player: returns `{hole, scores: {name: n}, confidence}`; local fallback
`parseVoiceScoresLocally` exercised by `frontend/src/lib/voice/parseVoiceScores.test.ts` —
the named regression net) → the EXISTING write path (`RoundPageClient.handleSetScore`,
RoundPageClient.tsx:976 — optimistic UI + pending overlay + `POST /api/rounds/{id}/scores` +
localStorage/offline retry, all free). NO new parser, schema, validation layer, or write path.

**Owner refinement (2026-07-17): no confirm ceremony.** An explicit spoken score command
writes DIRECTLY. The model gives at most a brief, natural in-flow acknowledgment (e.g.
"Got it — 5.") — it does NOT read the score back by name-and-number every time, and it NEVER
runs a read-back-and-await-confirmation loop. The "never silent" rule is for PASSIVE shot
tracking only ([[passive-shot-tracking-direction]]); an explicit command is already explicit.

**Backend** — add to `REALTIME_ONLY_TOOLS` (tools.py:231-257), NEVER `TEXT_TOOLS`
(prompt-cache D7; `test_text_tools_are_a_schema_equal_subset_of_realtime` keeps passing):

```python
{
    "name": "record_scores",
    "description": (
        "Enter hole SCORES on the scorecard (strokes — distinct from record_shot, which "
        "logs a single swing). Call this the moment the player states a score for "
        "themselves or anyone in the group: 'I made a 5', 'put me down for a 5', 'par for "
        "me, double for Mike'. Pass the player's words verbatim in utterance; the score is "
        "written directly. The result lists exactly what was recorded — give a brief, "
        "natural acknowledgment in the flow of conversation (like 'Got it, 5') and move "
        "on; do NOT read every score back by name and number, and never ask the player to "
        "confirm before writing. Only if the result reports an error or an unmatched name "
        "should you say so and ask them to repeat."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "utterance": {"type": "string", "description": "The player's words, verbatim."},
            "hole_number": {"type": "integer", "description": "Hole scored (1-18). Omit for the current hole."},
        },
        "required": ["utterance"],
    },
},
```

`resolve_tool` (tools.py:921) needs no arm — `_TOOL_NAMES` is CADDIE_TOOLS-only (tools.py:902),
so a non-compliant text-path call gets the honest unknown-tool error, as with `get_strategy`.

**Frontend** — `realtime.ts`:
- Extend the tool-context provider type (realtime.ts:300-303) and `RealtimeToolContext`
  with `enterScores?: (utterance: string, holeNumber?: number) => Promise<ScoreEntryResult>`.
- New `dispatchTool` case `'record_scores'`: call `ctx.enterScores(String(args.utterance),
  args.hole_number != null ? Number(args.hole_number) : undefined)`; no callback wired →
  `{ error: 'score entry not available on this screen' }` (honest — e.g. detached surfaces
  without a scorecard).
- Wiring: `RoundPageClient` (owns `players`, `handleSetScore`, `currentHole`, `holePar`)
  builds `enterScores`: POST `/api/voice/parse-scores` `{transcript: utterance, playerNames,
  hole, par}` → range-validate 1-15 (same as `applyVoiceScores`, ScoreSheet.tsx:497) →
  `handleSetScore(playerId, hole-1, n)` per matched player → return
  `{hole, recorded: {Name: n}, unmatched: [...], confidence}` for the model to acknowledge.
  Thread it: RoundPageClient → `useDetachedCaddieLive` → `useCaddieLiveSession` options →
  merged into `getToolContext` (useCaddieLiveSession.ts:268-275). Writes go through the
  EXISTING `handleSetScore` — no new write path.
- Parse-failure guard (NOT a confirm ceremony): `confidence < 0.5` or empty `scores` →
  return `{error: "couldn't make out the scores", heard: utterance}` — model asks to
  repeat; NOTHING is written. This guards a bad PARSE, not a valid explicit command.

Text path: `classify_intent` labels SCORE; v1 the text handler returns the honest line
"score entry runs on the live caddie or the score sheet" (constant, not model-generated) —
the seam accepts the future server-side write without rearchitecting (documented in
routing.py). The owner's stated gap is the LIVE session; that is fully closed.

---

## 10. Live-GPS fix (realtime → brain)

`realtime.ts` get_strategy case (L201-214) — add the missing field, deriving it exactly as
`CaddieSheet.tsx:261` does (`ctx.holeYards` IS the GPS distance when basis is 'gps'):

```typescript
case 'get_strategy': {
  return await sessionStrategy({
    round_id: ctx.roundId,
    hole_number: args.hole_number != null ? Number(args.hole_number) : undefined,
    distance_to_green_yards:
      ctx.yardageBasis === 'gps' && ctx.holeYards != null ? Number(ctx.holeYards) : undefined,
    hole_yards: ctx.holeYards ?? undefined,
    yardage_basis: ctx.yardageBasis ?? undefined,
  });
}
```

Backend already accepts it (`SessionStrategyRequest.distance_to_green_yards`,
routes/caddie.py:693) and resolves it first in the yardage ladder (strategy.py:120-122).

---

## 11. Test contract (exact files + names)

### New — `backend/tests/test_intent_routing.py` (offline, no DB)
- `test_routing_matrix` — parametrized over ALL 20 matrix rows (§1): asserts exact Intent.
- `test_need_to_shoot_is_fact_not_score` — row 7 discriminator pinned on its own.
- `test_i_made_a_five_is_score` / `test_multiplayer_score_utterance_is_score` (rows 16/17).
- `test_club_vs_club_is_advice_even_with_fact_words` (fail-toward-advice).
- `test_intent_enum_is_extensible_without_dispatch_rewrite` — adding a dummy Intent member
  + pattern classifies without touching consumers (seam proof).

### New — `backend/tests/test_situation_block_strip.py` (the structural pin)
Build a session with hazards+bend+guide+green slope on the current hole (reuse the fixture
builders in `test_realtime_grounding.py`); `instructions =
build_realtime_instructions(personality, session, [])`; assert:
- `test_realtime_instructions_carry_no_hazard_side_detail` — no `format_hazards_line(...)`
  output substring, and no `"trees L"` / `"bunker R"`-style side tokens outside the
  behavior rules.
- `test_realtime_instructions_carry_no_guide_text` — `"Local knowledge:"` absent.
- `test_realtime_instructions_carry_no_bend_or_green_slope_lines`.
- `test_realtime_instructions_keep_tee_numbers_aim_miss_and_par_sanity`.
- `test_session_voice_prompt_carries_no_hazard_bend_guide_or_slope_lines` (text twin, via
  `_build_session_voice_prompt` with a monkeypatched session — follow
  `test_yardage_line.py`'s pattern).
- `test_transcription_vocab_prompt_still_carries_hazard_terms` (keyterms untouched).

Existing tests whose assertions INVERT (spec-driven behavior change — updated WITH this
item, not deleted): `test_realtime_grounding.py::test_green_slope_present_reaches_situation_block`,
`::test_bend_line_present_reaches_situation_block` (→ `..._never_reaches_...`),
`test_guide_consumption.py` (guide-in-prompt assertions → brain-payload-only),
`test_tree_span_gap.py` / `test_par_sanity_guard.py` — audit for instruction-content
assertions; par-sanity stays green unchanged.

### New — `backend/tests/test_guide_verdict_gate.py` (offline)
- `test_extract_favor_side_left_right_none_conflict` (parametrized phrase table, incl.
  opposition: "away from the left" → right).
- `test_lateral_flip_guide_dropped` / `test_agreeing_guide_included` /
  `test_no_favor_claim_guide_included`.
- `test_center_verdict_drops_any_lateral_favor` (the Red-1 class).
- `test_conflicting_sides_guide_dropped_fail_closed`.
- `test_green_frame_verdict_keeps_lateral_guide` (no false-reject across frames).
- `test_missing_recommendation_drops_guide_fail_closed`.
- `test_build_strategy_payload_drops_disagreeing_guide_and_logs_key_free` (caplog: hole
  number only — no key material, no guide text).

### Extend — `backend/tests/eval/test_strategy_tool.py`
- `test_validator_rejects_favor_side_disagreeing_with_engine`
- `test_validator_rejects_lateral_favor_when_engine_says_center`
- `test_validator_rejects_pin_relative_language_on_positioning_shot`
- `test_validator_requires_recommended_club_on_tee_shot_narrative`
- `test_validator_without_recommendation_behaves_exactly_as_before` (back-compat pin)
- `test_ground_truth_player_block_labels_heuristic_vs_learned`
- `test_ground_truth_renders_prior_notes_demotion_label`

### New — `backend/tests/test_red1_acceptance.py` (THE acceptance gate; offline, fixture-only)
Fixture: `backend/tests/fixtures/bethpage_red_trees.json` hole `"1"` →
`extract_hole_hazards` (the proven ±5y geodesic ground truth) + NEW fixture
`backend/tests/fixtures/bethpage_red1_poisoned_guide.json` = a `HoleStrategyGuide` whose
`play_line`/`miss_side` assert the LEFT-favor poison (the incident class). Builder: build it
by RECONSTRUCTION (a left-favor `play_line`/`miss_side` that names trees LEFT correctly yet
still advises favoring/aiming LEFT) and mark `_provenance: "reconstructed"`. Do NOT hit
prod/staging DB for this — DB access is owner-gated and unnecessary; the test's teeth are
identical with a reconstructed guide.
- `test_red1_black_tee_ask_produces_favor_right_or_center_never_left_with_poisoned_guide_present`:
  session with hole-1 intel (yards=466, hazards from fixture, `strategy_guide` = poisoned
  fixture), driver 300; monkeypatch `synthesize_strategy` (echo-the-degraded-path style
  already used at test_strategy_tool.py:563+); call `run_strategy_turn`. Assert, exactly:
  1. `payload["local_knowledge"] == ""` — the read-time gate dropped the poisoned guide;
  2. the ground truth carries left trees in the drive zone (a `trees` left entry with
     carry ≥ 265 — "trees LEFT from ~265");
  3. `rec["miss_side"]["preferred"] in ("center", "right")` and the spoken text (validated
     or degraded) never contains `"favor the left"` / `"miss left"` / `"left is the"`;
  4. a synthetic left-favor narrative fed to `validate_strategy_text(..., recommendation=rec)`
     returns `None` (the pin would have caught the poison even if the model repeated it).
- `test_red1_same_ask_twice_returns_same_club_and_side` — two `run_strategy_turn` calls,
  synth monkeypatched with a call counter: one synth call (cache hit), byte-identical text
  (consistency gate).

### New — `backend/tests/test_text_advice_interception.py`
- `test_session_voice_advice_ask_routes_to_brain_and_never_calls_claude` (monkeypatch
  `run_strategy_turn` + a poisoned `anthropic.AsyncAnthropic` that raises if constructed).
- `test_session_voice_fact_ask_stays_on_claude_loop`.
- `test_session_voice_stream_advice_emits_reading_the_hole_status_then_brain_text`.
- `test_session_voice_score_ask_returns_honest_handoff_line_and_never_calls_brain`.
- `test_text_tools_constant_byte_identical` (TEXT_TOOLS unchanged — prompt-cache D7 pin;
  complements existing `eval/test_tool_parity.py::test_text_tools_are_a_schema_equal_subset_of_realtime`).
- `test_advice_turn_persists_message_pair_like_normal_turns`.

### Extend — `backend/tests/test_realtime_tools.py` (or eval/test_tool_parity.py)
- `test_record_scores_present_in_realtime_tools_absent_from_text_tools`
- `test_resolve_tool_record_scores_is_honest_unknown` (server loop can't reach it).

### Frontend (vitest)
- `frontend/src/lib/voice/realtime-dispatch.test.ts`:
  - `get_strategy forwards distance_to_green_yards when yardage basis is gps`
  - `get_strategy omits distance_to_green_yards when basis is not gps`
  - `record_scores calls parse-scores then enterScores and returns the recorded map`
  - `record_scores with no enterScores callback returns honest error and writes nothing`
  - `record_scores below confidence threshold writes nothing and returns error`
- Score-entry acceptance (`frontend/src/hooks/useCaddieLiveSession.connect.test.tsx` or a
  new `record-scores.test.ts` using `realtime-test-fakes.ts`): live session mid-round,
  model calls `record_scores({utterance: "put me down for a 5"})` → parse-scores fetch
  fired with playerNames/hole/par → `handleSetScore`-callback invoked with (firstPlayerId,
  hole-1, 5) → tool output names the hole and score → `sessionStrategy` never called →
  NO confirmation round-trip (write happens on the first call, not after a readback).
- Regression nets, unchanged and green: `parseVoiceScores.test.ts` (the score parser's own
  suite — named per eng-lead), `caddie-experience-suite.test.ts` (271+ cases),
  full voice suite (278 tests at time of writing — re-verify count at build time),
  dedup/zombie/one-mic suites (`realtime-dedup`, `realtime-lifecycle`, `warm-session`).

---

## 12. Shared-types sync list
- `SessionStrategyRequest/Response` unchanged → `frontend/src/lib/caddie/api.ts::sessionStrategy`
  params/`SessionStrategy` already match (verified api.ts:262-270). No change.
- No new `models.py` ↔ `types.ts` shapes: `record_scores` I/O is frontend-internal
  (parse-scores request/response already exist both sides: `VoiceScoreRequest/Response` ↔
  ScoreSheet's `ParseResponse`). Builder MUST re-verify `frontend/src/lib/caddie/types.ts`
  compiles against any `numbers` echo change (none planned).
- `RealtimeToolContext` + tool-context provider extension is frontend-only (realtime.ts,
  useCaddieLiveSession.ts, useDetachedCaddieLive.ts, RoundPageClient.tsx).

## 13. Build order (each step lands green before the next)
1. `routing.py` + matrix tests (pure add).
2. `verdict.py` + guide-gate + validator extension + their tests (pure adds + strategy.py edits).
3. `strategy_turn.py` extraction (route tests pin no behavior change).
4. Context strips (voice_prompts.py + caddie.py) + strip tests + inverted grounding tests
   + strengthened STRATEGY_TOOL_RULE (bridge phrasing → designer review).
5. Text-path interception + its tests.
6. Red-1 acceptance (reconstructed poisoned fixture first).
7. Frontend: GPS fix + `record_scores` tool + wiring + frontend tests.
8. Full gates.

## 14. Gates
Local (this machine has NO Postgres): `cd backend && ruff check .` + `uv run pytest tests
-k "not integration"` (all suites above are offline/monkeypatched — follow
test_strategy_tool.py's session-monkeypatch pattern); `cd frontend && npx tsc --noEmit &&
npm run build && npx vitest run && npx tsx voice-tests/runner.ts --smoke`.
CI-only (Postgres-backed): `backend/tests/integration/*`, `test_guide_read_revalidation.py`
(DB-adjacent read path), anything touching `async_session`. Live-key gated, never CI:
`run_strategy_latency.py` (re-measure p50 after the payload grows — budget: p50 ≤ 4.5s),
`run_consistency.py`, tier-2 probes for the routing matrix asks.
Latency fast-path: unchanged by construction (no fast-tool edits; instructions get smaller);
prompt-cache: TEXT_TOOLS byte-identical; the stable text block changes ONCE at deploy (rule
wording) then re-stabilizes — expected, note in PR.

## 15. Edge cases + risks
- **Guide false-rejects**: frame-mismatch keep-rule (§5) + `test_green_frame_verdict_keeps_
  lateral_guide` bound it; a dropped-but-valid guide degrades to NO prior notes — the brain
  still has full live data (calm failure mode, per [[no-fake-data-fallbacks]]).
- **Classifier misses on the text path**: fail-toward-ADVICE for judgment words; a FACT
  misrouted to ADVICE costs ~3-4s and returns an engine-grounded answer (safe, slow); an
  ADVICE misrouted to FACT reaches Claude — which now holds NO hazard/guide context and the
  full grounding-rule stack, so worst case is a tool-grounded or generic answer, never a
  wrong-side composition. Matrix rows are the regression net; add rows on every new probe.
- **Realtime model skips the bridge or the tool**: strip guarantees it cannot state a side
  it was never given; live eval probes watch tool-call rates.
- **Score entry safety**: range 1-15, low-confidence parse writes nothing and asks to
  repeat, unmatched names surfaced; explicit command writes directly with a light in-flow
  acknowledgment (no confirm ceremony); existing pending/offline write machinery reused —
  no new write path.
- **Cache turnover**: ground-truth format changes (§5 label, §7 player block) roll the
  strategy cache once; TTL 15min, size 256 — no action needed.
- **`sendOpener`/auto-reco paths**: unchanged — they speak engine output, not composed advice.

## 16. Adversarial self-check (answered)
- *Can any advice-class ask still slip to a mouth un-brained?* Text: no — classifier runs
  before Claude on both session endpoints; stateless `/voice` has no engine/session and is
  out of scope by design (documented). Realtime: the baked-ingredient channel is closed
  structurally; the residual tool-result channel requires the weak model to both misroute
  AND compose against three explicit rules with no baked fuel — bounded, honestly stated
  (§4), watched by live probes. Score asks: `record_scores` returns structured facts only;
  no advice text is generated on that path.
- *Does the strip break benign chit-chat / fast-path readout?* No — weather, clubs,
  yardage, tee-shot numbers, last call, shots, and history all remain; hazard FACTS remain
  reachable via tools; OTHER-class turns never needed the stripped lines. Pinned by the
  keep-assertions in §11 and the experience suite.
- *Does the guide-gate false-reject a VALID guide?* Only if the guide asserts a lateral
  favor the live engine disagrees with — which is precisely the class that must never be
  spoken; agreeing, non-committal, and different-frame guides all pass (tests pin each).
- *Any latency regression on the fast path?* No code on the fast path changes; realtime
  instructions shrink; the brain call is unchanged except a slightly larger payload
  (re-measured via the gated latency probe).
