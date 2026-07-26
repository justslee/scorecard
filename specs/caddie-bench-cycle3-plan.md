# Caddie Bench Cycle 3 — Implementation Plan

**Branch:** `integration/next` (from `b741fe7`). **Goal:** measurement correctness + engine
correctness on the offline caddie bench. Diagnosed run: `20260723-214457` (77.0% weighted, 142
judged advice cases). Expected outcome: **77.0 → ~81.7 immediately from Commit 1 alone**
(measurement fix, zero caddie-behavior change), plus real engine gains from Commits 4–5, plus the
instrumentation/measurement that unblocks the degrade and judge-noise work.

Authored by the Fable Plan agent (2026-07-24) against the eng-lead cycle-3 diagnosis
(`tasks/progress.md`). This plan is the contract handed to the builder; the builder implements it,
it does not re-plan.

## Commit sequence (highest yield / lowest risk first)

| # | Commit | Kind | Risk | Expected effect |
|---|---|---|---|---|
| 1 | shot_reachability N/A on non-positioning (judge clarity + report aggregation) | Measurement correctness | Near-zero | +4.7pts weighted; contested-rate and judge cost drop |
| 2 | Degrade-reason instrumentation | Instrumentation (no decision change) | Low | Unblocks Target 3; categorizes all future degrades for free |
| 3 | Judge-noise double-pass tool (`judge_noise.py`) | Measurement | Zero (new gated script) | Honest ceiling for the 100% goal |
| 4 | `compute_miss_side` honest front/back evidence | Engine behavior (gated) | Medium-low | miss_side_evidence lift on approach cases |
| 5 | Positioning landing-window roll fix (`drive_zone_hazards` long edge) | Engine behavior (gated) | Medium | miss_side_evidence lift on positioning cases (h18-class) |
| — | Degrade-cause fixes (Target 3 follow-on) | **Deferred** — gated on Commit 2 data from the re-run | — | — |
| — | natural_speech prompt work (Target 4) | **Deferred** — verify post-re-run first | — | — |

Commits 1–3 are one focused builder pass, unconditionally. Commit 4 is small and should ride the
same pass. Commit 5 rides **only if** its byte-identity audit (below) shows churn confined to the
intended holes; otherwise it defers to a follow-up with its own review. Targets 3-followup/4
explicitly do NOT get speculative code this cycle.

---

## Commit 1 — shot_reachability is N/A off positioning shots (the centerpiece)

**This is a correctness fix, not judge-weakening: it stops scoring a dimension on cases where it
does not apply.** The dimension's own definition (rubric + `[[caddie-shot-context-reachability]]`)
is about out-of-reach shots; on a reachable approach the flag IS the correct target, so a 0 there
is a category error, and the 68/84 spurious zeros (17.9% pass on approaches vs 82.8% on
positioning, n=58) plus the hallucinated `engine_looks_wrong` flags prove the judge is being
misled by our own prompt.

### Design decision: N/A lives purely in `report.py` aggregation; the judge schema is untouched

Recommended and justified:
- The judge continues to emit 0/1/2 for every dimension (strict schema at
  `judge.py::_judge_json_schema` unchanged); `report.compute_headline` simply excludes
  shot_reachability from aggregation when the case's `engine_ref["shot_kind"] != "positioning"`
  (`engine_ref` is a dict on every `CaseResult`, so this is a pure aggregation-side read — old runs
  re-aggregate correctly too, which is how we prove the +4.7 on the existing run's JSONL without
  re-spending).
- Adding a not-applicable value to the judge JSON schema would: (a) break `JudgeScores` validation
  round-tripping of every existing run, (b) require touching `canary_all_pass_gate` /
  `compute_headline`'s `all(v == 2 ...)` canary check and `should_second_pass`'s `abs(a-b) >= 2`
  arithmetic, and (c) hand the judge a new degree of freedom a canary answer could exploit. All
  risk, no benefit — the report already knows applicability deterministically from `engine_ref`,
  which is strictly more reliable than asking the model to self-declare it.

### Exact changes

**`backend/tests/eval/caddie_bench/judge.py`**
1. `_format_engine_ref` (line 84): make the gloss conditional on the actual shot_kind, e.g.
   - positioning: `shot_kind: positioning (out of reach for THIS swing — the flag is NOT the aim target)`
   - anything else: `shot_kind: approach (the green IS reachable — aiming at or relative to the flag is CORRECT for this shot)`
   Never again attach the positioning gloss to a non-positioning line.
2. `_RUBRIC_TEXT[SHOT_REACHABILITY]` (lines 43-47): remove the word "approach" from the trigger
   clause and make scope explicit. Replacement sense: "APPLIES ONLY when ENGINE REFERENCE
   shot_kind=positioning (out-of-reach shot): the answer must reason landing-zone + leave-yardage
   and must NEVER aim relative to the flag/pin. When shot_kind is approach this dimension is NOT
   APPLICABLE — the green is reachable and flag-relative aim is correct — score it 2 with confidence
   1.0." (Score-2-when-N/A keeps the strict schema satisfied, keeps the confidence-floor
   second-pass trigger quiet, and is ignored by aggregation anyway.)
3. `should_second_pass` (lines 246-267): in the overlap loop, skip the
   `POSITIONING_NO_PIN_LANGUAGE ↔ SHOT_REACHABILITY` pair when the det check's `detail == "not a
   positioning shot"` (the exact string `harness.check_positioning_no_pin_language` emits at line
   321). Today a spurious judge 0 against the auto-passing det check fires a paid second pass on all
   68 mis-scored approaches — this is a large slice of the run's judge2 spend and contested-rate.
   Pin the string coupling with a teeth test (below).

**`backend/tests/eval/caddie_bench/report.py`**
4. `compute_headline`: in the `dim_scores` accumulation loop (lines 129-131), `continue` on
   `dim == JudgeDimension.SHOT_REACHABILITY and (r.engine_ref or {}).get("shot_kind") !=
   "positioning"`. That single exclusion automatically fixes: `dimension_pass_rate` (now
   82.8%-class over positioning only), the `weighted_num`/`weighted_den` (both numerator AND
   denominator — the contract's requirement), and `correctness_dims_pass_rate` (already guarded by
   `if dim_scores.get(d)` for the all-empty case).
5. Add a per-dimension applicable-count (e.g. `dimension_n: dict[str, int]` on `HeadlineStats`,
   `field(default_factory=dict)` so the two hand-constructed `HeadlineStats` in
   `test_bench_offline.py:601/614` stay valid) and annotate the report table row:
   `shot_reachability (2x weighted, positioning shots only, n=X)`. Without n, a future 8-case
   positioning sample could masquerade as a 142-case rate.

### What deliberately does NOT change
- `judge.canary_all_pass_gate` and the canary check inside `compute_headline` read
  `r.judge.scores` raw — untouched, and the N/A exclusion never touches `r.judge`, so the canary
  gate semantics are bit-identical. (A canary on an approach-kind hole whose bad answer now
  "passes" shot_reachability still fails its other dimensions and its failure_class — canaries
  cannot sneak through via N/A.)
- Contested computation: `contested` is set at run time by `second_pass_if_needed` and stored;
  `compute_headline` just averages the stored flags. No change needed; the prompt fix + trigger
  guard reduce it at the source on future runs.
- `worst_cases` still sums raw scores (old runs' spurious zeros affect only that cosmetic
  ordering; note it in the commit message, don't complicate).

### Tests (this commit's contract)
- **`report.py` unit test (required by owner contract):** a fixture of mixed results — one
  positioning case with shot_reachability=2, one approach case with shot_reachability=0 and every
  other dimension 2 — assert (a) `dimension_pass_rate["shot_reachability"] == 1.0`, (b)
  `weighted_correctness_score` equals the hand-computed value with the approach SR excluded from
  numerator and denominator, (c) the same fixture BEFORE the fix computes the lower number (assert
  the exact before value in the test docstring/comment as the before/after proof; the live
  before/after on real data is the packaged report-regen command below).
- Prompt-assembly test (offline, `judge_prompt` only): positioning engine_ref renders the
  positioning gloss; approach engine_ref renders the approach gloss and contains neither the string
  `positioning = out of reach` nor any implication the flag is not the target; rubric text contains
  "shot_kind=positioning" scope language and no bare "approach" in the trigger clause.
- Teeth test: `should_second_pass` does NOT fire for (det `POSITIONING_NO_PIN_LANGUAGE` passed with
  detail "not a positioning shot", judge shot_reachability=0), and STILL fires for a genuine
  positioning-case disagreement; plus a pin that `harness.check_positioning_no_pin_language` emits
  exactly that detail string.
- Commit message must carry the before/after reasoning: 77.0% → 81.7% (+4.7) recomputed offline
  over `20260723-214457` with zero caddie-behavior change; shot_reachability-on-positioning 82.8%.

---

## Commit 2 — degrade-reason instrumentation (Target 3, measurement only)

**Iron rule: the degrade DECISION is untouched — only its reason is recorded.** No new validator
reject class (that would ADD degrades).

### Exact changes

**`backend/app/caddie/strategy.py`**
1. Add `validate_strategy_text_with_reason(text, hazards, recommendation=None) -> tuple[Optional[str], Optional[str]]`
   — the current `validate_strategy_text` body (lines 720-765) restructured to return
   `(validated_flat, None)` on pass and `(None, reason)` on reject, with a closed reason vocabulary
   keyed to the existing check order: `"empty-or-overlong"`, `"hazard-type"`, `"side-flip"`,
   `"injection"`, and the pin reasons namespaced from `_verdict_pin_reject_reason`'s existing
   strings: `"pin:favor-side"`, `"pin:reachability"`, `"pin:club"`.
2. Reimplement `validate_strategy_text` as a two-line wrapper over the new function — byte-identical
   behavior, zero churn for its other callers/tests.

**`backend/app/caddie/strategy_turn.py`** (`run_strategy_turn`, lines 244-272)
3. Call the `_with_reason` variant; delete the post-hoc `_verdict_pin_reject_reason` re-derivation
   (the reason now arrives exact, and side-flip/hazard-type/injection rejects — currently logged as
   the generic "validator rejected narrative" — become individually attributable). Keep both log
   lines' shape (`verdict-pin reject (%s)` for `pin:*`, the generic line otherwise) so no log-based
   alerting drifts.
4. Thread `degrade_reason` into the returned dict: `f"validator:{reason}"` on the reject branch,
   `f"exception:{type(e).__name__}"` on the except branch, `None` on the success, cached, and
   honest-empty branches (all four return sites get the key — keep the dict shape uniform).
   - Wire-safety: `SessionStrategyResponse` (`routes/caddie.py:748`) has default pydantic config
     (`extra` ignored), so `SessionStrategyResponse(**result)` silently drops the new key — nothing
     reaches clients. Critically, do NOT reuse the existing `reason` key: the voice paths at
     `routes/caddie.py` (~1063, ~1261) SPEAK `result.get("reason")` as fallback text when
     `strategy` is falsy — a reject-class string must never be TTS-able. Add a code comment on the
     new key stating exactly this.

**`backend/tests/eval/caddie_bench/schema.py`**
5. `CaseResult` gains two additive fields: `degrade_reason: Optional[str] = None` and
   `raw_synth_text: Optional[str] = None`. (`extra='forbid'` is safe: old JSONL lines lack the keys
   and get the defaults; `load_results` on `20260723-214457` still round-trips.)

**`backend/tests/eval/caddie_bench/run_caddie_bench.py`**
6. `_LiveSynth.__call__`: first statement `self.last_raw_text = None` (staleness guard — an
   exception mid-call must not leak the PREVIOUS case's text), then `self.last_raw_text = text`
   after the real call returns. This is the piece that makes degrades **locally reproducible with
   zero live calls**: `validate_strategy_text` is deterministic given the raw text + hazards +
   recommendation, so once one instrumented run exists, the builder replays every degraded case's
   validator decision offline from `raw_synth_text`.
7. The `final = CaseResult(...)` reconstruction at line 266 **must** copy
   `degrade_reason=result.degrade_reason, raw_synth_text=result.raw_synth_text` — this explicit
   constructor is the silent-drop trap; add a teeth test for it.

**`backend/tests/eval/caddie_bench/harness.py`**
8. `run_case`: `degrade_reason = result.get("degrade_reason")`; `raw_synth_text =
   getattr(synth, "last_raw_text", None) if degraded else None` (only stored on degraded cases —
   keeps results.jsonl lean, and offline stub synths without the attribute are handled by
   `getattr`'s default). Both onto the returned `CaseResult`.

**`backend/tests/eval/caddie_bench/report.py`**
9. `HeadlineStats.degrade_reason_counts: dict[str, int]` (default factory) computed from degraded
   results (`None` reason bucketed as `"unknown(pre-instrumentation)"`), plus a `## Degrade
   reasons` report section. This is what turns the next full run into the Target-3 categorization
   for free.

### Repro path for the 25 degraded cases
- Primary (recommended, $0 extra): the cycle-3 full-150 re-run (already planned, below) lands with
  instrumentation → `degrade_reason` histogram + `raw_synth_text` for every degrade in the new run.
  The 25 old case_ids are deterministic case constructions, so their successors appear in the new
  run under the same ids.
- The builder then triages offline: replay `validate_strategy_text_with_reason` on each stored
  `raw_synth_text` to see the exact tripping clause (e.g. is it `pin:club` from a rounded-vs-raw
  aim_point suppression divergence, or `side-flip` from a residual two-frame leak — the two cycle-3
  reviewer suspects). **Only then** scope cause fixes as follow-on commits; a fix that would tighten
  any validator only lands if it demonstrably prevents a worse spoken error.
- Explicitly rejected: blind-fixing suspects now, and any new reject class.

### Tests
- `run_strategy_turn` decision-parity pin: with a stub synth returning a rejectable narrative,
  `degraded` flips exactly as before and `degrade_reason == "validator:side-flip"` (etc.); with a
  raising stub, `degrade_reason == "exception:RuntimeError"`; with a passing stub,
  `degrade_reason is None`. (Prior art harness: `tests/eval/test_strategy_tool.py`.)
- `validate_strategy_text` wrapper byte-parity: for a matrix of pass/reject inputs, wrapper output
  equals pre-change behavior (its existing tests already pin this — just keep them green untouched).
- Schema round-trip: an old-format results line (no new keys) loads; a new-format line round-trips.
- Teeth: mutant that drops the field propagation in `run_caddie_bench`'s reconstruction goes RED.

---

## Commit 3 — judge-noise double-pass measurement (Target 5)

**Measure, never tune toward agreement.** New gated module
`backend/tests/eval/caddie_bench/judge_noise.py` (filename deliberately not `test_*.py`; add it to
the pytest-collection-glob pin test alongside `run_caddie_bench.py`/`extract_fixtures.py` in
`test_bench_teeth.py:487`).

### Design
- Gates: refuse (exit 2) unless `CADDIE_EVAL_LIVE=1` and `OPENAI_API_KEY` — same discipline as the
  runner. Args: `--run-id` (required), `--sample-size` (default 30), `--seed` (default 3, so the
  sample is reproducible), `--budget-usd` (default 3.00, enforced with `run_caddie_bench._cost_usd`
  — reuse, never fork the pricing table).
- Sampling: load `runs/<run_id>/results.jsonl`, filter to judged advice cases (`judge is not None`,
  not `__fact__`, not `canary__` — canaries are deliberately bad and would understate noise on the
  pass boundary; state this exclusion in the output), `random.Random(seed).sample(..., 30)`.
- Per sampled case: reconstruct the `BenchCase` by id via `questions.build_cases` over the loaded
  fixtures/bank (deterministic), rebuild `det_summary` from the stored `det_checks`, composite from
  `runs/<run_id>/composites/<case_id>.png` (`render.render_case`'s naming — error loudly if missing
  rather than re-rendering), then **two fresh independent `judge_case` calls** (never reusing the
  stored verdict — we are measuring the CURRENT judge, i.e. post-Commit-1 prompt).
- Analysis is a **pure, unit-testable function** (`compute_noise_stats(pairs, engine_refs) -> dict`),
  respecting Commit 1's N/A rule (shot_reachability pairs only counted on positioning cases). Per
  dimension: n_applicable, exact-agreement rate, pass-flip rate (`(a==2) xor (b==2)`), mean |Δ|,
  and the pass-repeat probability `q_dim = P(b==2 | a==2)` (symmetrized over both orderings).
- **Implied weighted-score ceiling**, three numbers, formulas fixed in code comments:
  - `ceiling_expected`: weighted score of a hypothetically perfect caddie =
    `Σ_d w_d · E[score|true-pass]_d / Σ_d w_d · 2`, with `E[score|true-pass]_d` estimated as the
    mean of both passes' scores over case-dims where `max(a,b)==2` (at least one judge saw the pass).
  - `band_optimistic` / `band_pessimistic`: the run-sample weighted score recomputed with
    per-case-dim `max(a,b)` / `min(a,b)`.
  - Output JSON to `runs/<run_id>/judge_noise.json` + a printed table. This is the honest frame for
    the owner's 100% goal: if `ceiling_expected` is ~93%, then 100% weighted is unreachable at any
    caddie quality without further judge-noise work, and the report says so with data.
- Bonus (free, one line): also report agreement of the fresh pair against the STORED first-pass
  scores per dimension — since the stored run predates Commit 1's prompt, this is the cheap
  before/after contested/clarity signal the contract asks for.

### Tests
- Offline unit test of `compute_noise_stats` with canned score pairs (hand-computed expectations,
  including an N/A shot_reachability pair being excluded).
- Gate-refusal test + glob-pin update.

---

## Commit 4 — `compute_miss_side`: honest front/back claims (Target 2a)

**File:** `backend/app/caddie/aim_point.py`, function `compute_miss_side` (lines 356-514).

The only evidence-free unsupported claim left in the approach frame is the fall-through at line
497: `"Miss short — safe side, easy recovery"`, reached when BOTH the preferred and avoid sides
are "open" within the `distance_from_green <= 20` greenside window (the avoid-has-evidence case is
already handled by the "X guards the back — miss short" branch at 482-495). On bethpage h18 the map
shows short trouble just outside that window, so the "safe side" assertion is both unsupported AND
visibly wrong to the judge.

**Chosen design: degrade the claim honestly (contract option 2), do NOT widen the evidence
window.** Widening `distance_from_green <= 20` would change `preferred`/`avoid` SELECTION across
every hole and caller — a blast radius this cycle must not take. Honest degrade is strictly
claim-weakening on an already-evidence-free branch.

### Exact change
Inside the `preferred_desc_suffix == "open"` / else-branch at line 496-497, gate on
`approach_framed` (the existing predicate, line 381 — same `APPROACH_FRAME_MIN_TEE_OFFSET_YDS` prior
art):
- `approach_framed` and both sides open → `pref_text = "No strong miss side mapped — middle of the
  green, two-putt range"` (and correspondingly soften `avoid_text` for this sub-branch only, e.g.
  `"No mapped trouble tight to the green"` instead of `"Don't miss long — open"`).
  `preferred`/`avoid` FIELDS unchanged (selection untouched — `compose_degraded_line` and the
  verdict pin read `preferred`, and `extract_favor_side` agreement must not shift).
- not `approach_framed` → today's text **verbatim** (tee/positioning/direct callers byte-identical,
  same discipline as the cycle-2 `distance_yards=None` gating already documented in this function's
  docstring).

Wording constraints (spell these in the commit): no hazard nouns (`_HAZARD_PATTERNS` would
false-red a synth that echoes "no water"), no left/right side word adjacent to any hazard noun
(`_has_side_flip` proximity scan — the existing comment at line 485 documents this exact trap), no
"safe" without evidence, calm voice-first phrasing per NORTHSTAR.

### Byte-identity gate (hard requirement)
- New unit tests in `tests/test_miss_side_grounding.py` / `tests/test_approach_frame.py` style: (a)
  non-approach-framed inputs produce the pre-change strings byte-for-byte (write the pins FIRST
  against current behavior, land them in the same commit, prove they pass before and after); (b)
  approach-framed + avoid-side evidence → unchanged evidence branch byte-identical; (c)
  approach-framed + both-open → new honest text; (d) `preferred`/`avoid` side fields identical
  across the change for all inputs.
- Full-suite gate: `tests/test_miss_side_grounding.py`, `tests/test_aim_point.py`,
  `tests/test_positioning_shot.py`, `tests/test_approach_frame.py`, `tests/test_decade_advice.py`,
  `tests/eval/test_strategy_tool.py` all green with zero edits to existing assertions (any existing
  assertion that would need editing means the blast radius is bigger than believed — stop and
  reassess).

---

## Commit 5 — positioning miss-side sees the roll segment (Target 2b) — rides only if clean

**Root mechanism** (verified in code): `generate_recommendation` builds the positioning zone as
`drive_zone_hazards(hole.hazards, float(club_dist), max_reach_yds=drive_total)`
(`aim_point.py:1404-1406`), and `drive_zone_hazards` (`decade_advice.py:437-466`) computes
`long_edge = min(expected_advance_yds, max_reach_yds) + DRIVE_ZONE_LONG_YDS`. Since stored carry
(`club_dist`) ≤ physics total (`max_reach_yds`) always at this call site, the `min()` pins the
window to `carry + 30` — the roll segment `(carry+30, total]` is structurally invisible. h18 slot0:
bunker right at 215, total 229 → excluded → `compute_positioning_miss_side` sees a clean right side
and says "favor right" with a bunker inside the actual landing zone. (Note:
`compute_positioning_miss_side` itself already names preferred-side trouble when it can see it —
lines 643-652 "but X are in play too" — so the fix belongs at the window, not the picker.)

### Exact change
In `drive_zone_hazards`, when `max_reach_yds` is provided: the window's long edge must reach the
drive TOTAL, not the carry. Concretely, replace the `min(expected_advance_yds, max_reach_yds)`
anchor so the roll segment is included, while preserving the Finding-C protection (a
beyond-physical-reach hazard, e.g. a 374y greenside bunker vs a 285y total, stays excluded because
374 > 285+30). Simplest correct form:
`anchor = max_reach_yds if max_reach_yds >= expected_advance_yds else min(expected_advance_yds, max_reach_yds)`
then `long_edge = anchor + DRIVE_ZONE_LONG_YDS`. In practice at the one production call site
`max_reach ≥ carry` always. Update the docstring: the window is now `[carry − 50, total + 30]` —
the ball travels through the roll segment, so trouble there is in play; the Finding-C ceiling
(nothing beyond physical reach + margin) still holds. `max_reach_yds=None` callers byte-identical.

**First reproduce, then fix:** before touching code, the builder writes a small scratchpad script
(offline: `geo.load_hole_fixture` + `hole_intel_from_fixture` + `generate_recommendation` for
bethpage_black_h18 slot0 per bag) confirming the bunker-at-215/total-229 exclusion and the "favor
right" output; the same script becomes the after-check.

### Blast-radius audit (the ride/defer decision)
- Consumers of the widened zone at the positioning call site: `compute_positioning_miss_side`
  (intended target), `cross_hazard_line`, and the `aggressiveness` death-hazard scan
  (`aim_point.py:1601`). `decade_landing_advice` takes `max_reach_yds` separately — builder must
  check whether it calls `drive_zone_hazards` internally and include it in the audit if so.
- Audit procedure: scratchpad script dumps `engine_ref.model_dump()` for **all 138 advice cases**
  (8 fixtures × slots × 3 bags — the exact bench population, fully offline/free) before and after;
  diff. **Ride criterion:** every diff is on a case with a mapped hazard whose `carry_yards` lies
  in that case's `(carry+30, total+30]` roll segment, and each diffed miss-side/cross-line reads as
  more honest (names the roll-segment hazard or degrades to the both-sides "no good miss" branch).
  Any diff outside that set, or any existing engine test (`tests/test_decade_advice.py`,
  `tests/test_positioning_shot.py`, `tests/test_tee_shot_numbers.py`, `tests/test_aim_point.py`,
  `tests/test_red1_acceptance.py`, `tests/test_tree_hazards.py`) needing assertion edits beyond
  deliberately-pinned roll-segment scenarios → **defer the commit**, ship 1–4, and let the re-run
  measure them alone.
- New tests: h18-shaped unit fixture (bunker in the roll segment) → zone includes it and
  `compute_positioning_miss_side` output names it (or goes center/no-good-miss); Finding-C
  regression stays green (beyond-reach hazard still excluded); `max_reach_yds=None` byte-identity
  pin.

---

## Target 4 — natural_speech: no code this cycle

Degraded cases pass natural_speech at 32% vs 63.2% non-degraded; 25 mechanical
`compose_degraded_line` fallbacks are the drag. The plan is sequencing, not code: after Commits 1–5
land and the full-150 re-run completes, read natural_speech split by `degraded` (now with
`degrade_reason` attached). Only if natural_speech stays weak on NON-degraded cases does prompt
work get scoped — as its own reviewed change, never in this pass.

---

## Shared-type sync check (types.ts ↔ models.py)

Verified — **no frontend changes required, no frontend gates**:
- `MissSide` is engine-internal (`backend/app/caddie/types.py:249`); it appears in neither
  `backend/app/models.py` nor `frontend/src/lib/types.ts` (grep-confirmed zero hits for
  `miss_side`/`MissSide` in both). The strategy wire shape (`SessionStrategyResponse.numbers`,
  `routes/caddie.py:748-755`) carries tee_shot_numbers/plays_like/carries/green_read only —
  untouched by every commit.
- Commit 2's `degrade_reason` dict key is deliberately kept OFF the wire (pydantic drops it at
  `SessionStrategyResponse(**result)`); no response-model or types.ts field is added.
- Bench schema (`CaseResult`) is backend-test-only, never wire-shared.

## Consolidated edge cases & risks

1. **N/A must not break canary/second-pass/contested** — handled by design: canary gates read raw
   `r.judge.scores` (untouched); contested is a stored flag; the only second-pass change is the
   explicitly-guarded overlap-pair skip, teeth-tested. Judge still emits closed-enum 0/1/2.
2. **Old-run compatibility** — `report.py` reads `engine_ref.get("shot_kind")` defensively;
   `CaseResult` new fields default to None; regenerating the old run's report must work (it's the
   +4.7 proof).
3. **Instrumentation never changes the degrade decision** — `validate_strategy_text` public
   behavior byte-pinned; reasons are a side channel; `_LiveSynth.last_raw_text` reset-per-call so
   an exception never attributes stale text; the `run_caddie_bench` CaseResult reconstruction
   silent-drop trap is teeth-tested.
4. **Miss-side byte-identity** — Commit 4 gated on `approach_framed` + both-open only, fields never
   change, wording vetted against `_HAZARD_PATTERNS`/`_has_side_flip`; Commit 5 rides only on a
   clean 138-case engine_ref diff audit.
5. **`_verdict_pin_reject_reason` string reuse** — Commit 2 namespaces pin reasons
   (`pin:favor-side`) without altering the function's own return values, so
   `check_approach_miss_side_pin`/harness reuse is untouched.
6. **No DB locally** — every gate below is DB-free (the caddie_bench suite and the named engine
   unit tests are pure; README G1/G2 confirm no network/key/DB/Docker). DB-backed backend tests run
   in CI on push; do not spin up a container.

## Per-commit verification gates (local, this machine)

Every commit:
```
cd backend && ruff check . \
  && uv run pytest tests/eval/caddie_bench/test_bench_offline.py tests/eval/caddie_bench/test_bench_teeth.py -q
```
(zero deselects, zero skips added; green_slope flake is already root-fixed on main so a red here is
real).

Additionally:
- Commits 1–3: `uv run pytest tests/eval -q` (the whole eval suite is offline).
- Commit 2: `uv run pytest tests/eval/test_strategy_tool.py tests/test_text_advice_interception.py tests/test_caddie_caching.py -q`
  (the `run_strategy_turn`/validator consumers found by grep).
- Commits 4–5: `uv run pytest tests/test_miss_side_grounding.py tests/test_aim_point.py tests/test_positioning_shot.py tests/test_approach_frame.py tests/test_decade_advice.py tests/test_tee_shot_numbers.py tests/test_red1_acceptance.py tests/test_tree_hazards.py tests/test_lore_acceptance_pinehurst.py -q`
  plus the 138-case engine_ref diff audit (scratchpad, results summarized in the commit message).
- Frontend gates: none (no types.ts change — see sync check).

## Packaged commands for the coordinator (EC2 box, after code lands)

**(a) Free, immediate — regenerate the diagnosed run's report under the Commit-1 aggregation
(proves 77.0 → 81.7 on real data, $0):**
```bash
cd backend && uv run python -c "
from pathlib import Path
from tests.eval.caddie_bench import report
rid = '20260723-214457'
res = report.load_results(Path('tests/eval/caddie_bench/runs') / rid / 'results.jsonl')
h = report.compute_headline(res)
print(f'weighted_correctness: {h.weighted_correctness_score:.1%}')
print(f'shot_reachability (positioning-only): {h.dimension_pass_rate[\"shot_reachability\"]:.1%}')
report.write_report(res, report.RunMeta(run_id=rid + '-reagg'), Path('/tmp/caddie-bench-' + rid + '-reagg.md'))
"
```

**(b) Full-150 re-run (~$7; budget cap 12 for retry margin):**
```bash
cd backend && CADDIE_EVAL_LIVE=1 \
  OPENAI_API_KEY="$OPENAI_API_KEY" \
  GOOGLE_MAPS_KEY="$GOOGLE_MAPS_KEY" \
  uv run python -m tests.eval.caddie_bench.run_caddie_bench \
    --budget-usd 12.00 --min-weighted-correctness 0.85
# exit codes: 0 pass / 1 missed bar or canary / 2 gate refusal / 3 budget / 4 real-call canary
# outputs: tests/eval/caddie_bench/runs/<new_run_id>/{results.jsonl,costs.jsonl,composites/,report.md}
# report.md now includes the Degrade reasons section (Commit 2) and positioning-only shot_reachability (Commit 1)
```
(Models default to `gpt-5.6-sol` via `CADDIE_STRATEGY_MODEL`/`CADDIE_BENCH_JUDGE_MODEL`; satellite
render is the default and requires the maps key — both env vars are already provisioned on the box.)

**(c) Judge-noise double-pass (~$1.5) on the NEW run:**
```bash
cd backend && CADDIE_EVAL_LIVE=1 \
  OPENAI_API_KEY="$OPENAI_API_KEY" \
  uv run python -m tests.eval.caddie_bench.judge_noise \
    --run-id <new_run_id> --sample-size 30 --seed 3 --budget-usd 3.00
# outputs: runs/<new_run_id>/judge_noise.json + printed per-dimension variance table
# and the implied weighted-score ceiling (expected + optimistic/pessimistic band)
```

### Critical files for implementation
- backend/tests/eval/caddie_bench/judge.py
- backend/tests/eval/caddie_bench/report.py
- backend/app/caddie/strategy_turn.py (with backend/app/caddie/strategy.py for the reason-returning validator)
- backend/app/caddie/aim_point.py (with backend/app/caddie/decade_advice.py for the `drive_zone_hazards` window)
- backend/tests/eval/caddie_bench/run_caddie_bench.py (with schema.py/harness.py for `CaseResult` instrumentation, and the new judge_noise.py beside it)
