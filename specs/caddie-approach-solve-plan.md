# Caddie Approach-Solve Plan (cycle 1 engine fix)

Companion to `specs/caddie-approach-solve-diagnosis.md` (verified diagnosis, run `20260722-145448`). Scope: give MID-HOLE (approach / greenside / recovery) shots the same numeric rigor the tee shot already has, with **byte-identical tee-shot behavior**, honest labeled heuristics, extended bench validators, and a clean before/after delta. All paths below are relative to repo root; line numbers are current as of this worktree.

---

## 0. Design keystone — the "approach frame" gate

Every fix below is gated on ONE new predicate so tee output cannot shift:

```
tee_offset = max(0, hole.yards - distance_yards)          # yards already advanced from the tee
approach_framed = hole.yards is not None and tee_offset >= APPROACH_FRAME_MIN_TEE_OFFSET_YDS
```

New module constants in `backend/app/caddie/aim_point.py` (next to `GREEN_REACH_MARGIN_YDS`, line 380):

```python
# A turn only re-frames tee-anchored carry_yards into the player's own frame
# when the player has provably advanced past the tee by more than combined
# GPS jitter + carry rounding. Below this the tee frame stands — which is
# what keeps every shipped reachable/tee test (all offset ~0) byte-identical.
APPROACH_FRAME_MIN_TEE_OFFSET_YDS: int = 25
# A from-here carry below this is "already effectively cleared" (hazards.py
# rounds carries to 5; GPS is a +/-10y-class instrument) — the carry line is
# SUPPRESSED, never spoken as a 5-yard carry (Pebble-3 evidence case).
EN_ROUTE_CLEARED_SUPPRESS_YDS: int = 20
```

Rationale for 25: every pinned reachable-branch test (`test_aim_point.py::TestHazardAwareReachableAim`, `test_positioning_shot.py::test_par3_flag_path_unchanged`, `tests/eval/test_strategy_tool.py::test_compose_degraded_line_augusta_12_*`) uses `distance == hole.yards` (offset 0) or the behind-tee clamp; the diagnosis cases have offsets 225-335. 25 clears jitter with margin and is unreachable by any shipped pin. Because the correction composes two measurement frames (card/tee-geom hole yardage vs live GPS distance), every re-framed number is spoken with "about" and rounded to 5 — the honesty label the owner requires (NORTHSTAR: no fake precision).

`hole.yards is None` -> `approach_framed` is False -> today's honest-unknown behavior everywhere (matches `en_route_carry_hazards`'s existing `None` contract, aim_point.py:151).

---

## 1. Engine changes (`backend/app/caddie/aim_point.py`) — one defect at a time

### 1.1 Shared helper (new, ~line 172, after `_governing_center_carry`)

```python
class EnRouteFromPlayer(NamedTuple):
    en_route: Optional[list[Hazard]]   # verbatim en_route_carry_hazards result
    tee_offset: int                    # 0 when not approach-framed
    approach_framed: bool
    def from_here(self, h: Hazard) -> int:
        # round-to-5 of (h.carry_yards - tee_offset); == h.carry_yards when tee-framed

def en_route_from_player(hole: HoleIntelligence, distance_yards: int) -> EnRouteFromPlayer:
```

- Wraps `en_route_carry_hazards` (line 130) **unchanged** — its unit pins (`test_aim_point.py::TestEnRouteCarryHazards`) stay untouched.
- When `approach_framed`, it additionally FILTERS the en-route list: drop any hazard whose `from_here < EN_ROUTE_CLEARED_SUPPRESS_YDS` **before** `_governing_center_carry` runs — so a cleared hazard can never govern (Pebble-3: carry 230, offset ~225 -> from-here 5 -> dropped -> the line doesn't fire at all).
- When not approach-framed, `from_here(h) == h.carry_yards` and the list is exactly today's — byte-identical downstream.
- Both call sites below use THIS helper; the aim line and the reasoning line get the same corrected number by construction (deterministic, pure — calling it twice is fine, but prefer computing once in `generate_recommendation` and passing the governing result into the reasoning section).

### 1.2 DEFECT 1 — player-relative carry + suppression

**Site A — `compute_aim_point` green-light arm (lines 203-233).** Replace the direct `en_route_carry_hazards` call (line 199) with the helper.

- Tee-framed (`approach_framed == False`): all four existing strings verbatim (`"Aim at the flag — green light, no trouble"`, `"...carry the {noun} at {carry_yards}"`, both lateral variants, bare `"Aim at the flag"` for frame-unknown). Byte-identical.
- Approach-framed, governing center hazard: `f"Aim at the flag — carry the {noun} about {from_here} from you"`.
- Approach-framed, filtered list now empty (all cleared): this is new information — the trouble is *behind* the player. Speak `"Aim at the flag"` (the existing honest-bare string), NOT `"green light, no trouble"` (the hole still has mapped hazards; claiming "no trouble" would be a new false claim).
- Approach-framed lateral-only branch (lines 217-233): same wording as today with `{worst.carry_yards}` -> `about {from_here(worst)} from you`.

**Site B — the P1 reasoning line, `generate_recommendation` (lines 1258-1264).** Replace the second `en_route_carry_hazards` call with the helper result:

- Tee-framed: today's string verbatim: `"{noun} at {carry} between you and the green — take enough club to carry it"` (pinned by `test_aim_point.py:396`).
- Approach-framed: `f"{noun.capitalize()} about {from_here} out between you and the green — take enough club to carry it"`.
- Suppressed (from-here < 20, or list empty after filtering): no line.

### 1.3 DEFECT 2 — per-side evidence in `compute_miss_side` (lines 257-365)

**Invariant: `preferred` and `avoid`-side SELECTION logic is untouched** — `verdict.extract_favor_side` pinning, the read-time guide gate (`strategy.py:179`), and `_verdict_pin_reject_reason` all key off `preferred`; `test_aim_point.py::TestComputeMissSide` pins `preferred` and `avoid.startswith("Don't miss {side}")`. Only the description TEXT is enriched:

- Keep the no-hazard early return (lines 265-270) byte-identical.
- `pref_text` when the avoided side has mapped hazards (today: `"Miss {pref} — safe side, easy recovery"`): name the evidence that drove the pick, e.g. `"Miss {pref} — {avoid_desc_suffix} guards the {avoid_side_word}"` (`avoid_side_word`: left/right verbatim; short->"front", long->"back" mapped to spoken "short of the green"/"long"). The types come from the existing `side_hazard_desc` (line 326) — never a new claim.
- `pref_text` when the preferred side itself has trouble (today: `"...{types} but manageable"`): keep the types, add the side word.
- Optional carry evidence: when `approach_framed` AND the driving hazard has carry-frame evidence, append `about {from_here} from you`. Numbers are only allowed if step 4.2 (validator known-set extension) lands in the same change; if the builder ships text-only first, types+sides alone already satisfy the judge's "per-side evidence" bar.
- Constraint for every template: hazard type + side word must co-occur consistently with geometry, because `guide_writer._has_side_flip` (used by `validate_strategy_text` and the bench `check_side_flip`) scans left/right words within a window of hazard keywords. Safe by construction: for extracted hazards `h.side == h.line_side` (hazards.py:777-787); front/back words are never side-checked.

**Signature note:** `compute_miss_side(hole, player_stats)` needs the frame to compute `from_here` -> add keyword-only `distance_yards: Optional[int] = None` (default `None` = today's text paths for every existing caller; `generate_recommendation` line 1062 passes it). Mirrors the precedent set by `compute_aim_point`'s own `distance_yards=None` back-compat param.

**Hazard-awareness seed (new, reachable branch only, gated on `approach_framed`):** add one P2 reasoning line in `generate_recommendation` after the miss-tendency block (~line 1318): `"Around the green: {type} {side}, {type} {side}"` built from hazards with `distance_from_green <= 20` (the same population `compute_miss_side` reads). Types+sides only — no numbers. Gating on `approach_framed` keeps every par-3-tee and positioning pin byte-identical and avoids reasoning-cap eviction in pinned suites.

### 1.4 DEFECT 3 — bind the payload's plays-like to the mouth

Wind is already IN the solve: `adjusted_yards` (line 1009) = `compute_adjustments` (club_selection.py:205) -> physics; `target_yards` carries it; the per-factor `ShotAdjustment` lines exist (wind entry built at club_selection.py:267-278). The number just never surfaces prominently enough for approach turns:

- **aim_point.py:** on reachable + `approach_framed` turns, when the adjustments list contains a `type == "wind"` entry with `abs(yards) >= 10`, add a P1 line: `f"Wind is real here: plays about {adjusted_yards}, not {distance_yards} — {wind_adj.description}"`. (Competition-legal turns have `adjustments == []` -> structurally can't fire, preserving `test_competition_legal.py`.) The existing P4 `"Distance adjustments: ..."` line (1237-1242) stays as-is.
- **strategy.py `format_strategy_ground_truth`, reachable arm (lines 263-268):** enrich the RECOMMENDATION line so the brain must bind:
  ```
  Club: {club}. Plays-like target {target_yards}y — SPEAK THIS NUMBER for the shot
  (raw {raw_yards}y; {"; ".join(a.description for a in adjustments)}).
  Aim: {aim}. Miss: {miss.description} {miss.avoid}
  ```
  Render the adjustments clause only when non-empty; when empty, keep the raw/target form. **Guard:** this arm is also hit by reachable par-3 TEE turns — the wording change there is a ground-truth prompt improvement, not an engine-number change, and no shipped test pins this arm's bytes (`tests/eval/test_strategy_tool.py` pins the tee-numbers arm, the hazards "COMPLETE list" phrase, the player block, and determinism — verified by grep). Builder must still run that file.
- **Magnitude (FLAGGED, verify-only, do NOT retune here):** +63y on 179 (~35%) vs rule-of-thumb ~1%/mph. `physics.py` is shared with tee (`test_physics.py::test_plays_like_150_into_10mph_headwind` pins 150->160-170 into 10mph, i.e. ~7-13%, sane). Add a **diagnostic** test asserting a band for a mid-iron into 20mph (e.g. 180 target plays <= ~35% long) marked with a comment that a failure means the wind model needs its own calibration epic — if it fails today, record the measured value in the PR and open a separate `caddie-wind-calibration` task instead of touching constants. Rationale: any retune moves tee totals -> violates the byte-identical constraint.

### 1.5 Payload frame correction (the brain's other confabulation source)

The GROUND TRUTH CARRIES section (`strategy.py:296-307`) and degraded line (`strategy_turn.py:95-102`) currently render TEE-anchored `carry_yards` even on a 182y approach — the brain can parrot "bunker at 495" from there even after 1.2 lands.

- **`tools.py::carries_payload` (line 623):** add keyword-only `from_distance_yards: Optional[int] = None`. When provided and `intel.yards` known and `offset >= APPROACH_FRAME_MIN_TEE_OFFSET_YDS` (import the constants from aim_point — one source of truth):
  - drop entries with `carry_yards - offset < EN_ROUTE_CLEARED_SUPPRESS_YDS` (behind/cleared),
  - add dict key `carry_from_you_yards` (round-to-5) alongside the existing `carry_yards`,
  - compute `clubs_that_clear`/`clubs_short_of_it` against the from-you number (that is the actionable question mid-hole).
  Default `None` -> byte-identical (all existing callers: routes, resolve_tool's `get_carries`, tests). The realtime `get_carries` TOOL keeps the tee frame (its description says "off the tee"; the tool has no live player distance) — documented limitation, not changed here.
- **`strategy.py::build_strategy_payload` (line 200-206):** pass `from_distance_yards=resolved_yards`.
- **`format_strategy_ground_truth` CARRIES section:** when entries carry `carry_from_you_yards`, header becomes `CARRIES (from your position, {raw_yards}y out):` and lines render `"{type} {side} — about {carry_from_you_yards}y from you to carry"`. Tee turns: byte-identical (key absent).
- **`strategy_turn.py::compose_degraded_line` hazard clause (line 95-102)** and the `numbers.carries` dict (lines 163-166): prefer `carry_from_you_yards` when present. The Augusta-12 degraded-line pins are offset-0 -> key absent -> byte-identical.

### 1.6 Recovery / lie-aware reachability — honest scope call (mostly DEFERRED)

The engine has **no lie input anywhere** (`generate_recommendation` signature, `RecommendationRequest`, `run_strategy_turn`): the bench's `ResolvedPosition.lie` is sim ground truth the oracle never sees, and prod has no frontend lie signal at all. The geometry we have (hazards.py tree chains along the played line, `green_geometry`) cannot support punch-out gaps/angles from an arbitrary in-trees point — that would be fabricated precision. Therefore:

- **This cycle:** no lie plumbing. The Pareto is dominated by DEFECT 1, which is lie-independent.
- **Flagged for cycle 2 (needs data we don't have in prod):** optional `lie: Optional[str] = None` threaded `run_strategy_turn -> build_strategy_payload -> recommend_payload -> generate_recommendation`, default `None` = byte-identical; rough/bunker = LABELED heuristic carry penalties ("out of the rough, count on roughly a club less — rule of thumb, not measured"); `recovery_trees` = honest "get back to the fairway" with the layup number (the positioning machinery already computes leaves). That change touches `models.py` + `frontend/src/lib/caddie/types.ts` (additive optional) — called out per section 2.

---

## 2. Shared types — **no shape changes required in this cycle**

- `MissSide`, `AimPoint`, `CaddieRecommendation`, `TeeShotNumbers` (backend `app/caddie/types.py` <-> `frontend/src/lib/caddie/types.ts`): text-only enrichment; no new fields.
- `carry_from_you_yards` is a plain dict key in the `carries_payload` return (tool payloads are untyped dicts on both ends today) — no Pydantic/TS change. If the builder prefers typing it, it is additive-optional and must be mirrored in the frontend caddie types; default recommendation: don't.
- Bench `schema.py`: one additive enum member `DetCheckName.APPROACH_MISS_SIDE_PIN` (section 4.2) — bench-internal, not a prod shape.
- The deferred lie plumb-through (1.6) is the only change that would touch `models.py`/frontend types — explicitly out of this cycle.

---

## 3. Edge cases and risks

| Case | Behavior |
|---|---|
| `hole.yards is None` | `approach_framed=False`; `en_route_carry_hazards` already returns `None` -> bare "Aim at the flag", no carry claim, tee-frame carries stay labeled tee-frame (never "from you"). |
| GPS jitter / behind-tee reading | `tee_offset` clamps at 0 (line 153); offsets < 25 keep the tee frame — jitter can't flip frames mid-round. |
| Hazard effectively behind the player | en-route filter `tee_offset < carry` plus the new 0-20y suppression band -> never "carry the bunker about 5". |
| Greenside shots (distance ~15-40y) | Reachable always; en-route lines rarely survive suppression; miss-side evidence + `Around the green` line carry the content; wind P1 needs `|wind| >= 10y` so it won't fire on a pitch. |
| Recovery/trees lies | Engine is lie-blind (1.6) — no fabricated punch-outs; deferred with a data-gap flag. |
| Lateral-only en-route hazards | Corrected in the lateral branch (1.2 Site A); miss-side agreement logic unchanged. |
| Competition-legal | Frame re-anchoring is pure geometry -> applies in both modes identically (preserves `test_competition_legal.py::test_aim_miss_side_unchanged` / `test_same_input_different_mode`); wind line can't fire (adjustments empty). |
| Reasoning cap (4 items) | New lines are P1/P2 and only on approach-framed turns; pinned suites are offset-0. On approach turns P3/P4 color may drop — acceptable, cap discipline unchanged. |
| Strategy cache | Ground-truth bytes change on approach turns -> new cache keys -> fresh synthesis; TTL bounded; no invalidation work needed. |
| Cached JSONB (sessions, hole intel) | No schema change; old cached recommendations still validate. |
| Validator interlock (critical) | If the engine speaks `about 160` before the bench known-numbers set learns it, `numbers_close` turns falsely red — section 4.2 MUST land in the same change as section 1. |
| `_situation_block` reachable "bare form" | Pinned by `test_numbers_coherence_prompt.py::test_situation_block_reachable_rec_keeps_old_bare_form` — do not touch `voice_prompts._situation_block`; it inherits the corrected `aim_point.description` automatically. |
| Prompt discipline | No edits to `voice_prompts.py` persona/register constants, `CADDIE_HOUSE_REGISTER`, or the synth system prompt beyond the ground-truth DATA block — strategic_depth / natural_speech are hypothesized to recover from payload richness; **verify on the re-run before touching caddie prompts**. |

---

## 4. Bench validator extensions (`backend/tests/eval/caddie_bench/`)

### 4.1 `check_numbers_close` frame correction (harness.py:210-229, `_known_numbers` 140-159)

Thread `hole_yards` into the det-checks (`run_case` has `fx`/`intel`; extend the check-fn signature or pass a small context object — bench-internal). On `engine_ref.shot_kind == "approach"` with `offset >= 25`:

- ADD to the known set: `{carry - offset}` (and its round-to-5) for hazards with `offset < carry < hole_yards`, plus `adjusted/raw` already present.
- REMOVE from the known set the raw tee-frame `carry_yards` of those same en-route hazards (parroting 495 on a 182y shot must now FAIL). Keep raw carries for hazards outside the en-route window (e.g. the brain referencing the tee-shot bunker historically). Net effect: stricter where it matters, never looser on tee turns (offset < 25 -> byte-identical known set). This satisfies "extend, don't weaken."

### 4.2 New det-check: `APPROACH_MISS_SIDE_PIN`

`schema.py` `DetCheckName` + harness fn: on `shot_kind == "approach"`, `verdict_mod.extract_favor_side(answer)` must be `None` or equal `engine_ref.miss_side.preferred` (reuse `app.caddie.verdict` — never a fork, same discipline as the existing reuse comments). Register in `_DET_CHECK_FNS`; add to `judge.py::should_second_pass` overlap map -> `MISS_SIDE_EVIDENCE` (mirrors the `CLUB_MATCHES_ENGINE` precedent at judge.py:250-255). Not in `_REDUCED_DET_CHECKS`.

### 4.3 Teeth (test_bench_teeth.py)

Mutants: (a) answer speaks the tee-frame carry on an approach case -> `numbers_close` red; (b) answer speaks the from-here carry -> green; (c) flipped favor-side on approach -> `APPROACH_MISS_SIDE_PIN` red; (d) overlap-map disagreement triggers second pass.

---

## 5. Judge confound — decision and sequencing

**Decision: engine-first, judge-clarity second, never in the same measurement.**

1. **Land section 1 + section 4 (one PR).** Re-run the failing subset under the UNCHANGED judge -> the pure engine delta. The judge's positioning-hallucination depresses `shot_reachability`/`miss_side` equally before and after, so the engine delta is still directionally honest — and `numbers_coherence`/`wrong_numbers` (the dominant Pareto) are unaffected by the confound.
2. **Then land the judge-clarity fix (separate, clearly-flagged PR):**
   - `judge.py:43-47` (`SHOT_REACHABILITY` rubric): state both arms explicitly — *"positioning => never aim at the flag; **approach => the green IS reachable — flag-relative aim is CORRECT and must never be penalized as a positioning violation**."*
   - `judge.py:84` (`_format_engine_ref`): make the parenthetical conditional on the actual value: positioning -> today's text; approach -> `"(approach = green IS in reach; aiming at the flag is correct)"`.
   - **Baseline re-score:** judge-only pass over run `20260722-145448`'s ORIGINAL answers (results.jsonl already stores `answer`, `engine_ref`, `det_checks`) — add a small `--rejudge <run_id>` mode to `run_caddie_bench.py` (skip synth, reuse stored answers, call `judge_case` only; ~150 judge calls, well under the $5 authorization). This produces baseline B' so the final table is a 2x2: {engine old/new} x {judge old/new}, and no judge change ever masquerades as an engine win.

---

## 6. Gates

**Tee-parity pins (run unmodified; these are the byte-identical proof):**
- `backend/tests/test_aim_point.py` (en-route predicate + Augusta-12 aim/reasoning pins, all offset-0)
- `backend/tests/test_positioning_shot.py` (T1-T7 incl. `test_par3_flag_path_unchanged`, `test_short_approach_unchanged`)
- `backend/tests/test_tee_shot_numbers.py` (closure matrix, corridor-fields byte-identity)
- `backend/tests/test_tee_club_expected_strokes.py`, `test_corridor_width_selection.py`, `test_corridor_bend_cap.py`, `test_corridor_profile.py`, `test_corner_tree_forward_bound.py`, `test_tee_club_tree_severity_calibration.py` (tee club solve)
- `backend/tests/test_miss_side_grounding.py` (positioning miss-side, Bethpage-1)
- `backend/tests/test_competition_legal.py`, `test_yardage_line.py`, `test_positioning_prompt.py`, `test_numbers_coherence_prompt.py` (incl. the situation-block bare-form pin)
- `backend/tests/eval/test_strategy_tool.py` (ground-truth determinism/pins, validator, degraded-line Augusta-12)
- `backend/tests/test_physics.py`, `test_hazards.py`, `test_decade_advice.py`, `test_decade.py`, `test_slope_advice.py`, `test_shot_line_advice.py`, `test_reasoning_priority.py`

**New unit tests:**
- Approach frame math (extend `test_aim_point.py` or new `test_approach_frame.py`): Black-4 repro (hole 517 / dist 182 / bunker C 495 -> "about 160 ... from you" in BOTH aim description and reasoning, same number); Pebble-3 repro (hole 404 / dist 179 / carry 230 -> line suppressed, no "green light, no trouble" resurrection); offset-24 vs offset-25 boundary (byte-identical below); `hole.yards None`; lateral-only corrected; behind-player exclusion.
- Miss-side evidence: greenside bunker left -> description names bunker + the guarded side; `preferred`/`avoid` prefix unchanged across a matrix mirroring `TestComputeMissSide`; no-hazard text byte-identical; enriched text passes `_has_side_flip` against its own hole.
- Wind binding: INTO_20-style weather on an approach-framed turn -> P1 line present and its number == `target_yards`; calm/competition-legal/tee-framed -> absent.
- Ground truth: approach turn renders from-you CARRIES + adjustments clause + miss description; tee turn (tee_shot_numbers present) byte-identical; determinism test still passes.
- `carries_payload(from_distance_yards=...)`: from-you numbers, cleared-hazard drop, `clubs_that_clear` against from-you carry, default-arg byte-identity.
- Harness/teeth per section 4.3; physics diagnostic band per section 1.4.

**Suites/commands:** `cd backend && ruff check . && python -m pytest tests/ -x -q` (incl. `tests/eval/caddie_bench/test_bench_offline.py`, `test_bench_teeth.py`). Frontend untouched (no type changes) — standard smoke only if the bundle rides with other work.

**On-box re-run (prod box):** `python -m tests.eval.caddie_bench.run_caddie_bench --only-failures 20260722-145448 --render-mode vector` (flags at run_caddie_bench.py:323, 333).

---

## 7. Delta measurement

1. **Baseline:** run `20260722-145448` report — per-dimension pass rates (numbers_coherence 30%, shot_reachability 34%, miss_side 33%, hazard 37%, wind 38%), det-check rates (numbers_close 67%), `failure_class_pareto` (report.py:218), weighted 53.4% / owner-crux 51.8%.
2. **After engine PR, unchanged judge:** failing-subset re-run. Report: (a) per-dimension deltas on the subset; (b) Pareto shrink of `wrong_numbers` x non-tee-lie rows; (c) **case-level fixed/regressed lists** joined on `case_id` — any previously-listed behavior that flips red is triaged before merge; (d) det-check deltas (numbers_close is the leading indicator for DEFECT 1). Caveat stated in the report: `--only-failures` can't detect regressions on previously-passing cases — so follow with **one full 150-case run** once the subset looks right; that full run (still old judge) is the true engine delta.
3. **After judge PR:** `--rejudge 20260722-145448` (old answers, new judge) + re-score of the new run -> the 2x2 table separating measurement correction (expected: shot_reachability jumps on approach cases with zero engine change) from engine improvement. The post-both full run becomes the cycle-2 baseline.
4. **Explicit non-goal check:** strategic_depth / natural_speech tracked but NOT acted on this cycle — if they don't recover with the richer payload, that's a finding for cycle 2, not a license to pad prompts now.

---

## Critical Files for Implementation
- `backend/app/caddie/aim_point.py` — helper + DEFECT 1/2/3 engine edits (lines 130-254, 257-365, 1237-1343)
- `backend/app/caddie/strategy.py` — ground-truth RECOMMENDATION/CARRIES binding (lines 200-214, 253-307)
- `backend/app/caddie/tools.py` — `carries_payload` from-you frame (line 623)
- `backend/tests/eval/caddie_bench/harness.py` — `_known_numbers`/`check_numbers_close` extension + new det-check (lines 140-280)
- `backend/tests/eval/caddie_bench/judge.py` — judge-clarity fix, separate PR (lines 43-47, 79-96)
