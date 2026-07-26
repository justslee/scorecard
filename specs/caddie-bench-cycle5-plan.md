# Caddie Bench Cycle 5 — Implementation Plan (builder's contract)

**Branch:** `worktree-agent-a4ebfa6037ee25997` (== `origin/integration/next` @ `c954975`).
**Basis:** `specs/caddie-bench-cycle5-diagnosis.md` INCLUDING its three addenda (RC-3 measured
table, RC-1 `numbers_close` whitelist, B's test surfaces). The diagnosis is measured off run
`20260725-230324` (189 cases, satellite, 11-dim) and is NOT re-litigated here. This plan is the
contract; the builder implements it, it does not re-plan.

**The cycle in one sentence:** all three root causes are the same standing pattern — the engine
framed something badly and the model faithfully repeated it — so every change is an engine/payload
fix (A, C) or the removal of a prompt clause that manufactures robotic filler (B). None is a judge
change, a validator loosening, or persona padding.

## Non-negotiable constraints (restated from the cycle brief — the reviewer checks each)

1. **Do NOT touch** the judge (`judge.py` rubric/prompt/schema), the det-checks' logic, the
   canaries, or the `side-flip` validator (`validate_strategy_text` / `_has_side_flip` /
   `_verdict_pin_reject_reason`). The 22-of-24 `validator:side-flip` degrades riding
   `preferred="short"` are a SYMPTOM of C and must stop being generated at the source. The ONE
   sanctioned det-check edit is Commit 1's removal of `leave_plays_like_yards` from the
   `numbers_close` known-numbers set — which makes that check **stricter** (diagnosis Addendum 2),
   never looser.
2. **Tee-shot behaviour stays byte-identical** where a change does not legitimately apply. Each
   commit below carries its own named parity proof (§1.4, §2.4, §3.6) against the existing
   tee-parity pin population (~752 assertions across `test_tee_shot_numbers.py`,
   `test_aim_point.py`, `test_approach_frame.py`, `test_positioning_shot.py`,
   `test_decade_advice.py`, `test_corridor_*`, `test_tee_club_*`, `eval/test_strategy_tool.py`).
3. Shared shapes stay in sync: the caddie wire mirror is
   `frontend/src/lib/caddie/types.ts` ↔ `backend/app/caddie/types.py` (verified: neither
   `backend/app/models.py` nor `frontend/src/lib/types.ts` carries `TeeShotNumbers`/`MissSide`).
4. No fake/mock data, no fallbacks that render invented values ([[no-fake-data-fallbacks]]).
5. **No local Postgres.** Local gates = `ruff check .` + the non-DB pytest run (baseline at
   `48a5db9`/`c954975`: **3361 passed, 154 skipped, 0 failed**; bench offline +
   `test_tee_shot_numbers` + `test_approach_frame` = **325 passed**). DB-backed tests run in CI.
   Never spin up a container. Never run the live bench (paid, owner's box only).

## §0 — Facts verified in THIS worktree (2026-07-25, planner)

- **RC-3 geometry independently re-measured** via the production path
  (`tests.eval.caddie_bench.geometry.hole_intel_from_fixture` → `extract_hole_hazards`) over all
  10 committed fixtures (78 hazards): byte-for-byte agreement with the diagnosis ADDENDUM table.
  Eleven greenside bunkers at `distance_from_green` 20–26y (laterals 2.8–22.5y); the only distance
  void in the region is **26→33**; the flanking TREE lines at 34–47y run laterals **25.4–45.3y**;
  the tight bunkers' lateral max is **22.5y** (lateral void **22.5→25.4**). Restricted to hazards
  with lateral ≤ 24y, the distance distribution is `..., 25, 26, 26, 33, | void |, 42, 46, 51,
  60, ...` — i.e. under the two-axis criterion the honest distance void is **33→42**, which is
  what admits the judge-cited 33y bunker (red_h16, lateral 19.1) that a "high-20s" cut would
  exclude. §3 builds on exactly this.
- **`leave_plays_like_yards` consumer set is CLOSED** (whole-repo grep): producer
  `aim_point.py:794,807`; field `app/caddie/types.py:298`; renderer `voice_prompts.py:351-352`;
  bench whitelist `tests/eval/caddie_bench/harness.py:157`; frontend mirror
  `frontend/src/lib/caddie/types.ts:61` (declared, **never read** by any component — grep);
  test references `test_numbers_coherence_prompt.py:45`, `test_corridor_width_selection.py:343`,
  `test_tee_club_expected_strokes.py:222`. NOT in: `models.py`, `lib/types.ts`, `report.py`,
  `schema.py`, bench README, `judge.py::_format_engine_ref` (prints `leave=` only, judge never
  sees the plays-like), or `compose_degraded_line`.
- **No test pins the spoken clause**: zero hits for `"(plays like ~"` in `tests/`; the two exact
  full-line pins of `format_tee_numbers_line` (`test_tee_shot_numbers.py:325-361`) construct
  WITHOUT the field and already assert the clause-free string.
- **Addendum 3 mechanism correction (verified, changes no conclusion):** the
  `test_caddie_caching.py` line-set guard covers the TEXT mouths and interpolates
  `TOOL_USE_RULE`/`CADDIE_HOUSE_REGISTER`/all grounding constants **via the imported constants on
  both sides** (its own comment, lines 179-183: "referenced via the imported constants so wording
  edits don't rot this guard"); `_BASE_BEHAVIOR` (realtime mouth) is not in that guard at all, and
  zero tests pin either "say so plainly" clause verbatim (grep). So §2's edits are expected to
  need **no test edits**. The Addendum-3 discipline still stands as the contingency rule: if any
  prompt-assembly pin DOES trip, updating its expected text is the one legitimate test edit of the
  cycle, must contain exactly the intended clause change, and must be justified in the diff —
  never quietly re-baselined.
- `Hazard.side == line_side` on the entire OSM extraction path (`hazards.py:904/910` and
  `_tree_hazard`), so `side` is only ever `left|right|center` for extracted courses —
  `compute_miss_side`'s front/back buckets stay empty there, the l/r-vs-f/b tie-break lands on
  `"short"`, and that is the structural source of `preferred="short"` on 121/162 cases.
- `_greenside_hazards_line` (aim_point.py:549) documents that it reads "the exact same greenside
  population `compute_miss_side` does" and is called only under `reachable and
  erp.approach_framed` (aim_point.py:1620) — it must move together with §3's criterion.
- Pydantic models in `app/caddie/types.py` use default config (extra ignored): deleting a field is
  cache-safe — old `session.last_recommendation` / `HoleIntelligence` JSONB carrying the key still
  validates, key silently dropped.

## Commit sequence (impact × safety order; one commit per root cause + a records commit)

| # | Commit | Kind | Risk | Dims moved (weight) |
|---|---|---|---|---|
| 1 | A — remove the unsolved leave plays-like end-to-end | Engine payload removal | LOW | numbers_coherence (2x) |
| 2 | B — stop narrating absent data unprompted (all three mouths' clauses) | Prompt (the cycle's ONLY prompt-surface change) | LOW | natural_speech (1x) |
| 3 | C — measured two-axis greenside evidence criterion | Engine geometry (LIVE advice) | HIGH | miss_side + hazard (2x each) + degrades + strategic_depth |
| 4 | records — progress, backlog items | Silent | — | — |

Each commit is independently green on all gates before the next starts.

---

## Commit 1 — A (RC-1): remove `leave_plays_like_yards` entirely

**Decision: REMOVE the field, not merely stop rendering it.** Rationale, so the builder does not
relitigate: (a) the number is not a solve of anything — `adjusted_yards - club_dist` mixes THIS
shot's wind-adjusted distance with a CALM stored yardage and re-attributes the whole wind
adjustment to a next shot with a different bearing, club, and lie; 40/40 failing cases spoke it
verbatim, zero confabulated — the engine's number is the defect. (b) [[caddie-numbers-coherence]]:
every spoken number binds to ONE per-turn engine solve; a keep-but-hide field is an unsolved
number waiting to be re-rendered, and it still crosses the wire and sits in `engine_ref` where the
judge can see engine self-contradiction. (c) The consumer set is closed and small (§0), removal is
mechanical, and pydantic's default extra-ignore makes it cache-safe. If a plays-like for the NEXT
shot is ever wanted, it must come from an actual solve of that shot — out of scope, do not build.

### 1.1 Exact changes, every consumer accounted for

- `backend/app/caddie/aim_point.py` — delete line 794 (`leave_plays_like_yards = ...`) and the
  `leave_plays_like_yards=` kwarg at 807. Rewrite the docstring sentence at 779-783: the
  plays-like-frame "labeled extra" is GONE (cycle-5, RC-1 — supersedes
  specs/caddie-numbers-coherence-plan.md §2.2's labeled-extra decision; note that in the commit
  message). `leave_exact_yards`/`leave_yards` semantics untouched.
- `backend/app/caddie/types.py` — delete field line 298. Everything else in `TeeShotNumbers`
  untouched.
- `backend/app/caddie/voice_prompts.py` — delete lines 351-352 (the `" (plays like ~N)"` append).
  `leave_clause = f"leaves about {n.leave_yards} in"` stands; the `leave_exact_yards <= 0`
  reaches-the-green branch untouched.
- `backend/tests/eval/caddie_bench/harness.py:157` — remove `tsn.leave_plays_like_yards` from the
  `_known_numbers` tuple. **Direction of this edit (state it in the commit message for the
  reviewer): `numbers_close` becomes STRICTER** — a synth that speaks the old bad number now goes
  RED instead of being whitelisted (Addendum 2: the whitelist is why only 2/42 failures tripped
  the det-check). This is validator tightening, never judge-weakening. (This line also HAS to move
  once the field is deleted or the harness fails on attribute access.)
- `frontend/src/lib/caddie/types.ts:61` — delete the `leave_plays_like_yards?: number | null;`
  line from the `tee_shot_numbers` mirror (keeps the mirror exact per its own "mirrors ...
  exactly" comment). No component reads it (grep-verified) — a type-only change, nothing
  user-visible moves.
- Test maintenance (mechanical, none of these assert the clause):
  `test_numbers_coherence_prompt.py:45` drop the kwarg from `_fixture_numbers`;
  `test_corridor_width_selection.py:343` and `test_tee_club_expected_strokes.py:222` drop the
  entry from the `payload_ints` tuples (the note-numbers ⊆ payload-numbers assertions get strictly
  tighter and stay green — the corridor notes never spoke the leave plays-like).

### 1.2 Edge cases / risks (the leave-number contract)

- The leave contract after this commit: `leave_exact_yards` (signed, closes EXACTLY) is the
  arithmetic; `leave_yards` (round-to-5, floored) is the ONLY spoken leave. The AUTHORITATIVE
  header ("they close: X − Y = Z") is untouched — the golfer's own arithmetic still checks.
- Cache/back-compat: old cached recommendations carrying the key validate fine (extra ignored) and
  simply stop speaking the number — the desired behavior. Old bench `results.jsonl` re-aggregates
  unchanged (`report.py` never reads the key).
- `strategy.py:310` renders via `TeeShotNumbers.model_validate(tee_numbers)` — an old cached rec
  dict with the key validates (extra ignored); ground truth loses the clause everywhere at once.

### 1.3 Tests (RED→GREEN + teeth)

- New RED→GREEN pin (in `test_tee_shot_numbers.py`): build via `compute_tee_shot_numbers` with a
  windy conditions shape where old code produced `leave_plays_like != leave` (e.g. the red_h1
  slot4 short-hitter shape: raw leave ~5, adjusted-vs-stored gap ~15); assert the rendered line
  contains `"leaves about"` and does NOT contain `"(plays like"`; assert
  `"leave_plays_like_yards" not in TeeShotNumbers.model_fields`.
- New bench teeth test (in `test_bench_teeth.py`): an answer speaking a number that is the OLD
  plays-like arithmetic (and no longer in the known set) FAILS `numbers_close` — pins the
  tightening so a future re-whitelist can't slip back silently.
- Existing pins prove the rest: the two exact full-line pins in `test_tee_shot_numbers.py:325-361`
  (already clause-free) must pass UNTOUCHED.

### 1.4 Parity proof for A

The change legitimately applies to every `TeeShotNumbers` render (the 41/42 failures are
`shot_kind=positioning`, i.e. tee/fairway positioning turns — the clause was spoken exactly
there). Parity is therefore: **everything except the removed clause is byte-identical** —
proven by the untouched exact-string pins above plus the full non-DB suite green with zero edits
beyond the three named test files (whose edits are constructor kwargs/tuples, not assertions about
the clause). Any other test needing an edit means an untraced consumer — stop and reassess.

### 1.5 Gates for commit 1

`cd backend && ruff check .` · `uv run --frozen pytest tests/ -q -p no:randomly` (3361-baseline,
zero new skips) — plus, because `frontend/src/lib/caddie/types.ts` moves:
`cd frontend && npm run lint && npx tsc --noEmit` (run `npm install` once first if `node_modules`
is absent in this worktree — eng-lead notes deps are not installed). The voice smoke
(`npx tsx voice-tests/runner.ts --smoke`) is NOT required: nothing frontend-visible moves (an
unused optional type field is deleted); if the builder touches ANY other frontend file it becomes
required.

---

## Commit 2 — B (RC-2): stop narrating absent data unprompted — the cycle's only prompt-surface change

Three surfaces carry the narrate-the-absence behavior; the measured conviction (101/162 answers,
54.5% vs 69.4% natural_speech) is against the strategy brain, and the other two are its
conversational-mouth twins. All three move together **with mouth-appropriate scoping**, because
the codebase's own doctrine is that shared behavior must not drift between mouths, and the same
player hears all of them. The asymmetry is deliberate and must be preserved: the strategy brain
NEVER sees the player's question (verified: `run_strategy_turn` synthesizes from ground truth +
"Give the strategy for this hole now" — no question is passed), so for it absence-narration is
ALWAYS unprompted filler; the realtime/text mouths DO see the question, so for them "say plainly"
survives — scoped to the asked case.

### 2.1 Exact edits (verbatim; the builder implements these strings, not paraphrases)

**(a) `backend/app/caddie/strategy.py::_strategy_system()` — the measured fix.**

Sentence at lines 558-559, currently:
> "If a section says data is unavailable, say plainly what you don't know instead of guessing."

becomes:
> "If a section says data is unavailable, or is simply absent, never guess or invent it — and
> never announce the gap: leave that topic out of the strategy entirely."

Output contract at line 572, currently:
> "…the miss side the data supports, what the shot leaves, and one green note when the read is
> available."

becomes:
> "…the miss side the data supports, what the shot leaves, and — only when the GROUND TRUTH
> carries a Green slope line — one green note; with no green read, end without mentioning the
> green or what is unmapped."

**(b) `backend/app/caddie/voice_prompts.py::_BASE_BEHAVIOR` (realtime mouth), line 55.** Currently:
> "If a tool reports data as unavailable, say so plainly — never invent a number to fill in."

becomes:
> "If a tool reports data as unavailable, never invent a number to fill in: if the player asked
> for it, say plainly you don't have it; otherwise leave it out — never announce missing data
> unprompted."

**(c) `backend/app/caddie/voice_prompts.py::TOOL_USE_RULE` (both text mouths), last sentence.**
Currently: "If a tool reports data unavailable, say so plainly." becomes:
> "If a tool reports data unavailable, never fill the gap with a guess: if the player asked for
> that number, say plainly you don't have it; otherwise leave it out — never announce missing
> data unprompted."

### 2.2 What must NOT change (the reviewer's checklist — anti-confabulation contract)

- The never-invent core survives verbatim in every surface: `_strategy_system`'s "Every yardage,
  carry, club number, and hazard you mention MUST appear verbatim in it — never compute, adjust,
  or invent a number, and never name a hazard, side, or carry that is not listed." is
  byte-identical; `_BASE_BEHAVIOR`'s "Never state a yardage, club distance, or carry you did not
  get from a tool." is byte-identical; `TOOL_USE_RULE`'s "never state a yardage or carry that came
  from neither a tool nor the CURRENT SITUATION" is byte-identical.
- ALL shared constants byte-identical: `CADDIE_HOUSE_REGISTER` (its comment already states
  grounding lives elsewhere — do not touch), `HAZARD_GROUNDING_RULE`, `BEND_GROUNDING_RULE`,
  `PHYSICS_GROUNDING_RULE`, `GREEN_GROUNDING_RULE` (its "say the green read isn't mapped" wording
  is TOOL-RESPONSE-scoped — the asked case — and stays), `NUMBERS_COHERENCE_RULE`,
  `MISS_SIDE_GROUNDING_RULE`, `DECISION_GROUNDING_RULE`, `YARDAGE_GROUNDING_RULE`,
  `POSITIONING_SHOT_RULE`, `OBSERVED_REALITY_RULE`, `INPUT_GROUNDING_RULE`,
  `output_language_rule()`, all personas, `guide_writer.WRITER_SYSTEM`,
  `course_intel_writer.COURSE_WRITER_SYSTEM`.
- The payload builders are untouched: `strategy.py:399-401` already emits a Green-slope line only
  when a description exists; `slope_advice.py` already returns None honestly. Zero engine/payload
  changes in this commit.
- **No persona/padding.** The diff may only remove/rescope the narrate-the-absence behavior; any
  added style, warmth, or filler language to inflate the speech dim is out of bounds and grounds
  for reviewer rejection. The system prompts must not grow beyond the replacement sentences above.
- The 80-word cap, `_STRATEGY_MAX_CHARS`, validators, judge, canaries: untouched.

### 2.3 Tests

- New pins (place beside `test_strategy_system_states_the_output_contract` in
  `eval/test_strategy_tool.py`): `_strategy_system()` does NOT contain
  `"say plainly what you don't know"` and does NOT contain `"when the read is available"`; DOES
  contain `"never announce the gap"` and `"never guess or invent"`; the never-invent sentence
  (§2.2 first bullet) asserted verbatim so a later edit can't soften it. Mirror-shape pins for the
  two `voice_prompts` clauses (e.g. in `test_numbers_coherence_prompt.py`'s rule-pin style):
  neither `_BASE_BEHAVIOR` nor `TOOL_USE_RULE` contains a bare `"say so plainly"` (both now carry
  `"never announce missing data unprompted"` and retain an asked-case "say plainly" clause).
- Existing tests expected green UNTOUCHED: `test_strategy_tool.py:341/350` (constant-membership
  pins), `test_caddie_register_consistency.py` (sweeps the new wording for register violations —
  must pass without edits), `test_lore_consumption.py`, `test_caddie_caching.py` (constants
  interpolated on both sides — §0). Contingency: if any prompt-assembly guard trips anyway, the
  Addendum-3 rule applies — that expected-text update is the cycle's one legitimate test edit,
  containing exactly the intended clause change, justified in the diff.

### 2.4 Parity proof for B

No engine payload, validator, or det-check changes — every deterministic engine number and every
tee pin is byte-identical by construction (the diff touches only prompt prose in `strategy.py` and
`voice_prompts.py`). The full non-DB suite green with (expected) zero test edits IS the parity
proof. Frontend untouched — no frontend gates.

---

## Commit 3 — C (RC-3): the greenside evidence window, re-measured — two-axis, earned by measured lateral

**This feeds `compute_miss_side`, which is LIVE production advice — highest-risk change of the
cycle.** Everything here is gated on a measurement the builder re-derives first and an offline
whole-bench audit after.

### 3.1 Measurement FIRST (hard requirement; ~10s, offline, zero DB)

Before touching code, the builder writes a scratchpad script (in the session scratchpad dir, not
committed) that loads every committed fixture (`backend/tests/eval/caddie_bench/fixtures/holes/
*.json`) via `tests.eval.caddie_bench.geometry.load_hole_fixture` + `hole_intel_from_fixture` and
prints, per hazard: fixture, type, side, severity, `carry_yards`, `distance_from_green`,
`lateral_yards`. The builder MUST reproduce the diagnosis ADDENDUM table (78 hazards) and put the
≤60y slice + the two void statements in the commit message. If the re-derived table disagrees with
the ADDENDUM's, STOP and escalate to eng-lead — do not proceed on either table.

**Decision rule (this is the anti-knife-edge contract; the `CORNER_MIN_DEVIATION_FRACTION`-at-0.30
scar in `backlog.json` is the standing warning):** every chosen constant must sit inside a
measured void of the relevant population, with the margins to the nearest populated points on both
sides stated in the code comment and the commit message. A distance-only widening is REJECTED on
the measurement (a ~35y distance cut would sweep in the pebble_h3/red_h1/red_h6 tree lines at
25–45y lateral — trading one wrong claim for another). The honest criterion is **two-axis**.

### 3.2 The criterion (exact shape)

New module-level constants + predicate in `backend/app/caddie/aim_point.py`, next to
`compute_miss_side`:

```python
# Greenside-evidence criterion (cycle-5 RC-3, specs/caddie-bench-cycle5-plan.md §3).
# Measured over all 10 committed bench fixtures via the production extraction
# path (78 hazards — table in the cycle-5 diagnosis ADDENDUM and this commit's
# message). The old lateral-blind `distance_from_green <= 20` cut was a knife
# edge through the densest cluster in the distribution (eleven greenside
# bunkers at 20-26y: 2 admitted, 9 excluded) — the CORNER_MIN_DEVIATION_
# FRACTION scar repeating. The widened band is EARNED by a measured lateral:
# tight greenside bunkers measure 2.8-22.5y off the played line while the
# flanking tree lines at 34-47y from the green measure 25.4-45.3y — so
# GREENSIDE_EVIDENCE_MAX_LATERAL_YDS = 24.0 sits in the (thin: 22.5 -> 25.4)
# lateral void, and within the lateral-qualified population the distance
# distribution is ..., 25, 26, 26, 33 | void | 42, 46, ... so
# GREENSIDE_EVIDENCE_DISTANCE_YDS = 36.0 sits in the 33->42 void (margins
# 3/6), admitting the judge-cited 33y bunker. `lateral_yards is None` (legacy
# cached JSONB / hand-built fixtures) NEVER earns the widened band and NEVER
# disqualifies the near band — unknown is unknown, and every pre-cycle-4
# course keeps today's behavior byte-identical until re-ingest measures it.
# Falsification watch (backlog: caddie-greenside-lateral-margin-remeasure):
# the lateral void is only 2.9y wide on current fixtures; any new fixture
# landing a greenside bunker at 23-26y lateral re-opens this cut, and the
# pre-named fallback is type-aware evidence qualification (a discrete
# bunker/water feature vs one observation point of a tree LINE), not another
# nudged number.
GREENSIDE_EVIDENCE_NEAR_YDS: float = 20.0
GREENSIDE_EVIDENCE_DISTANCE_YDS: float = 36.0
GREENSIDE_EVIDENCE_MAX_LATERAL_YDS: float = 24.0

def _greenside_evidence(h: Hazard) -> bool:
    if h.distance_from_green <= GREENSIDE_EVIDENCE_NEAR_YDS:
        return True  # today's window, lateral-blind — byte-compatible with all legacy data
    return (
        h.distance_from_green <= GREENSIDE_EVIDENCE_DISTANCE_YDS
        and h.lateral_yards is not None
        and h.lateral_yards <= GREENSIDE_EVIDENCE_MAX_LATERAL_YDS
    )
```

(The builder confirms 36.0/24.0 against its own re-derived table per §3.1's decision rule; if the
honest voids differ, the constants follow the measurement and the comment/commit message state the
new margins. If no clean void exists on either axis, STOP and escalate — never ship a knife-edge.)

**Call sites (all three move together — one predicate, no drift):**
- `aim_point.py:396` (the `side_severity` classification loop) — replace
  `h.distance_from_green <= 20` with `_greenside_evidence(h)`.
- `aim_point.py:444` (`side_hazard_desc`) — same replacement (descriptions must never claim "open"
  against a side the classifier counted).
- `aim_point.py:549` (`_greenside_hazards_line`) — same replacement; update its docstring's
  "exact same greenside population" sentence to name the predicate. (Caller already gated on
  `reachable and erp.approach_framed` — this line only ever renders on approach turns.)
- Update the cycle-3 comment at 504-518 to reference the new criterion; the honest-degrade branch
  ITSELF STAYS, verbatim strings and all, for the case where there truly is no qualifying
  greenside hazard.

**Deliberately NOT gated on `approach_framed`:** parity is carried by the earned-lateral rule
instead. Every hand-built unit fixture (the entire ~752-pin tee-parity population) has
`lateral_yards=None` → the widened band never fires → byte-identical everywhere, including
tee-framed calls. On measured-lateral courses the criterion applies wherever `compute_miss_side`
runs — including a par-3 TEE shot, where greenside evidence legitimately applies (the tee shot IS
the approach; this is the "where the change does not legitimately apply" carve-out, stated for the
reviewer). Positioning turns are untouched by construction (`compute_positioning_miss_side` is a
different function, out of scope).

### 3.3 What changes downstream (blast radius, every consumer traced)

`compute_miss_side` selection (`preferred`/`avoid`) can now change on measured-lateral approach
and par-3-tee turns — that is the point (evidence in the buckets → `best_lr[2] > 0` → a real side
instead of the "short" tie-break). Consumers of the changed fields/strings:
- `generate_recommendation` (aim_point.py:1335) → `engine_ref.miss_side` → the judge line
  (`judge.py:128-129`) and the strategy ground truth (`strategy.py:321-331` renders
  description+avoid on reachable turns) — the model finally SEES per-side evidence.
- `compose_degraded_line` (via `strategy_turn.py:93` `miss_side.preferred`) — degraded lines say
  the evidence-backed side.
- The favor-side verdict pin (`strategy.py:692-697`) — now ACTIVE on more turns (engine side is
  left/right more often). Risk: could this ADD degrades? Mitigation: the same ground-truth block
  instructs the side it pins, so agreement is the path of least resistance; the diagnosis predicts
  the 22 `preferred="short"` side-flip degrades stop being GENERATED. The validator itself is
  untouched (constraint 1).
- Direct caller `aim_point.py:305-316` (lateral en-route safe-side pick on reachable turns) —
  changed `preferred` can change `favor the {safe_side} side`; legitimate, evidence-backed,
  covered by the audit below.
- `_greenside_hazards_line` → the P2 "Around the green:" reasoning line names more real hazards
  (hazard_awareness surface).
- NOT consumers (verified): `MissSide` never crosses `models.py`/`lib/types.ts`;
  `frontend/src/lib/caddie/types.ts::MissSide` is shape-only (strings) — no frontend change; the
  bend/corridor/E-model machinery reads none of this; `classify_pin_position`'s
  `distance_from_green <= 10` (aim_point.py:105) is a different window, untouched.

Known limitation, stated not fixed: with evidence on BOTH l/r sides, `compute_miss_side` still
picks the lesser-evil side ("… but manageable") rather than degrading to center like
`compute_positioning_miss_side` — pre-existing behavior on more cases now; redesigning the picker
is out of scope.

### 3.4 The offline whole-bench audit (ride/defer gate, cycle-3-commit-5 discipline)

Scratchpad script #2: build the full bench case population (`questions.build_cases` over the
committed fixtures/bank) and dump each ADVICE case's deterministic engine solve
(`engine_ref`-equivalent: `generate_recommendation(...).model_dump()` with the case's
lie/distance/bag) BEFORE and AFTER the change; diff. **Ride criterion — every diff must satisfy
all of:** (a) the case's hole has a hazard row admitted by the new predicate (name it:
type/side/dfg/lateral); (b) the change is strictly evidence-gaining (a named side + hazard where
"No strong miss side mapped"/"safe side" stood, or an avoid that now names real trouble) — never a
side flip AWAY from an evidence-backed side; (c) zero diffs on tee-lie par-4/5 cases (positioning
path) and zero diffs on any case whose hole has no admitted hazard. Summarize counts in the commit
message (expect: a large share of the 68 "No strong miss side mapped" cases now name a side; the
diagnosis table's 20-26y bunker holes — black_h5, black_h7, black_h8, red_h5, red_h6 — plus
red_h16 at 33y all move; black_h18 does NOT move (its bunkers are 156y+ from the green — its
miss-side story is positioning-side, out of scope this cycle)). Any diff outside the criterion →
STOP, defer the commit, ship 1-2, escalate with the diff in hand.

### 3.5 Tests (RED→GREEN + boundaries + retention)

New file `backend/tests/test_greenside_evidence_window.py`:
- Real-fixture RED→GREEN repro: `hole_intel_from_fixture(bethpage_black_h5)` (bunkers r-21/17.4,
  l-23/10.3, l-500…), approach-framed `compute_miss_side` → BEFORE: the both-open
  "No strong miss side mapped" branch; AFTER: a named side whose description/avoid cite the
  bunker evidence. Second repro on `bethpage_red_h16` pinning that the judge-cited 33y/19.1
  bunker is admitted.
- Boundary pins on the predicate: (36.0, 24.0) admitted; (36.0, 24.1) not; (36.5, 24.0) not;
  (34.0, 33.8) tree-line-shape not (lateral axis does the work); (33.0, 19.1) admitted;
  (20.0, None) admitted (near band, lateral-blind); (30.0, None) NOT admitted (widened band must
  be earned).
- Retention pin: approach-framed, hazards all beyond the criterion → the honest-degrade strings
  ("No strong miss side mapped — middle of the green, two-putt range" /
  "No mapped trouble tight to the green") verbatim — the cycle-3 branch survives for the
  truly-empty case.
- Parity pins written FIRST against current behavior and landed in the same commit: a hand-built
  hole (lateral None) produces byte-identical `MissSide` (all three fields) tee-framed AND
  approach-framed, before and after.

Existing suites that must pass with **zero assertion edits**: `test_aim_point.py`,
`test_approach_frame.py` (hand-built, lateral None — §3.2), `test_positioning_shot.py`,
`test_miss_side_grounding.py`, `test_decade_advice.py`, `eval/test_strategy_tool.py`,
`test_bench_offline.py`, `test_bench_teeth.py`. An existing assertion needing an edit means the
blast radius is bigger than believed → stop (same rule as cycle 3).

### 3.6 Parity proof for C

(a) The earned-lateral rule: every `lateral_yards=None` input — all legacy caches, all hand-built
unit fixtures, i.e. the entire tee-parity pin population — is byte-identical by construction,
proven by the untouched suites above plus the explicit parity pins. (b) The §3.4 audit proves
zero movement on tee-lie positioning cases and confines all movement to admitted-hazard holes.
(c) Where tee behavior DOES move (par-3 tee on a measured-lateral course), the change legitimately
applies and the audit lists each such case with its admitting hazard.

---

## Commit 4 — records (silent)

- `tasks/progress.md`: cycle-5 status, per-commit summary, the measured tables, predictions (§P).
- `backlog.json` additions: `caddie-greenside-lateral-margin-remeasure` (the 2.9y-wide lateral
  void + the trigger: re-measure before any new fixture/course with greenside bunkers lands; the
  pre-named fallback is type-aware evidence qualification — mirrors the corner-continuum item's
  shape); note on the existing miss-side items that `compute_positioning_miss_side`'s empty-zone
  `preferred="short"` default (the 10 positioning side-flip degrades) is deliberately unfixed
  pending the post-cycle-5 run.

## Verification gates (consolidated; local machine, no DB, no live calls)

Every commit:
```
cd backend && ruff check . \
  && uv run --frozen pytest tests/ -q -p no:randomly
```
(baseline 3361 passed / 154 skipped / 0 failed at `48a5db9`/`c954975` — zero new failures, zero
new skips, no deselects). Targeted re-runs the builder watches per commit:
- Commit 1: `tests/eval/caddie_bench/test_bench_offline.py tests/eval/caddie_bench/test_bench_teeth.py
  tests/test_tee_shot_numbers.py tests/test_numbers_coherence_prompt.py
  tests/test_corridor_width_selection.py tests/test_tee_club_expected_strokes.py
  tests/eval/test_strategy_tool.py` + frontend `npm run lint && npx tsc --noEmit` (§1.5; voice
  smoke only if anything frontend-visible were to move — it does not).
- Commit 2: `tests/eval/test_strategy_tool.py tests/test_caddie_caching.py
  tests/test_caddie_register_consistency.py tests/test_lore_consumption.py
  tests/test_output_language_prompt.py` + both bench offline suites.
- Commit 3: `tests/test_greenside_evidence_window.py tests/test_aim_point.py
  tests/test_approach_frame.py tests/test_positioning_shot.py tests/test_miss_side_grounding.py
  tests/test_decade_advice.py tests/eval/test_strategy_tool.py` + both bench offline suites + the
  §3.4 audit summary in the commit message.

**Do NOT run the live bench** (paid, owner's box). Packaged post-merge command for the
coordinator, unchanged from cycle 3/4 (satellite default; keys exist only on the box):
```bash
cd backend && CADDIE_EVAL_LIVE=1 OPENAI_API_KEY="$OPENAI_API_KEY" GOOGLE_MAPS_KEY="$GOOGLE_MAPS_KEY" \
  uv run python -m tests.eval.caddie_bench.run_caddie_bench --budget-usd 12.00 --min-weighted-correctness 0.85
```

## Out of scope (the builder does not wander)

- The judge (prompt, rubric, schema, second-pass), report aggregation, canaries, ALL validators
  (`side-flip`, favor-side/reachability/club pins, hazard-type, injection, length caps).
- `compute_positioning_miss_side` (incl. its empty-zone `preferred="short"` default) and
  `drive_zone_hazards` — the positioning miss-side story is measured next run, not fixed now.
- The FACT router's `fact_distance_04` misroutes (diagnosis Finding 4 — recorded, n=10 too small).
- The degraded-path strategic_depth gap (28.0%) — second-order; expected to shrink as C removes
  degrades at the source.
- Building a real next-shot solve to replace the removed plays-like; any new `TeeShotNumbers`
  field.
- `GREEN_GROUNDING_RULE`, `CADDIE_HOUSE_REGISTER`, personas, guide/course writer prompts, and any
  prompt wording beyond §2.1's three sentences.
- `classify_pin_position`'s `<= 10` window; bend/corridor/E-model constants; fixtures, question
  bank, slot mix; `render.py`; anything DB-backed; migrations.
- Any frontend change beyond the one-line type-mirror deletion in §1.1.

## §P — Predicted dim movement (stated in advance so the next measured run checks a real prediction)

| Change | Dim (weight) | From | Predicted | Basis |
|---|---|---|---|---|
| A | numbers_coherence (2x) | 74.9% | **88–95%** | 41/42 failures are this class; several carry an independent second defect (e.g. black_h5 slot4 bad_club) so not all flip |
| B | natural_speech (1x) | 60.9% | **~70%** (not higher on this fix alone) | 101 disclaimer cases regress to the measured no-mention baseline 69.4% |
| C | miss_side_evidence (2x) | 63.7% | **70–75%** | the 68-case class moves partway toward the named-side class (74.5%) |
| C | hazard_awareness (2x) | 65.4% | **72–78%** | same split (named-side class 79.8%) |
| C | degraded rate | 15.3% | **materially down** (22/24 side-flips ride `preferred="short"`) | degrades stop being generated; strategic_depth on those cases recovers toward the 87.6% clean path |

C is the least certain projection (diagnosis's own caveat). If the run lands outside these bands,
the delta is signal about the FIX, not a mandate to touch the judge.

### Critical files for implementation
- /Users/justinlee/projects/scorecard/.claude/worktrees/agent-a4ebfa6037ee25997/backend/app/caddie/aim_point.py
- /Users/justinlee/projects/scorecard/.claude/worktrees/agent-a4ebfa6037ee25997/backend/app/caddie/voice_prompts.py
- /Users/justinlee/projects/scorecard/.claude/worktrees/agent-a4ebfa6037ee25997/backend/app/caddie/strategy.py
- /Users/justinlee/projects/scorecard/.claude/worktrees/agent-a4ebfa6037ee25997/backend/app/caddie/types.py (with frontend/src/lib/caddie/types.ts kept in mirror)
- /Users/justinlee/projects/scorecard/.claude/worktrees/agent-a4ebfa6037ee25997/backend/tests/eval/caddie_bench/harness.py
