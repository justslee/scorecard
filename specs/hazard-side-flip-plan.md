# Hazard Side-Flip Correctness Fix — Implementation Plan

## Summary

Second geometry-correctness incident. Bethpage Black hole 4's cached strategy guide names the bunker complex on the **right** when our own surveyed geometry puts it on the **left** (distances are correct; only the side is mirrored), and the caddie then asserted the bad data over the owner's own eyes. Root cause is **not** a math bug in the live hazard extractor — that module is correct — but three separate defects that let a mirrored side reach and persist to the user:

1. The correct extractor (`hazards.py`) has **no bearing-swept regression lock**, so a future sign regression would ship silently. Add the 8-bearing test matrix that would have caught the class of bug.
2. A **second, broken** side classifier (`course_intel._classify_side`) still exists and is **reachable** (not dead) on any round not mapped to a curated course. Remove it.
3. `validate_guide` checks hazard **type** only, so the writer LLM's side-flip hallucination passed validation and was cached forever. Extend it to validate **side** claims, fail-closed.
4. Neither caddie prompt tells the model to defer to the player's direct observation, so it "gaslit" the owner. Add an epistemic-humility rule to both mouths.

Classification: **NOTICEABLE** — the caddie stops mirroring the course; live behavior changes (unmapped-course rounds go from wrong-side hazards to honest generic language; guides with flipped sides get rejected and re-researched).

Backend-only. No frontend/shared-type changes.

## Verification of the reported root causes

**Finding 1 — `hazards.extract_hole_hazards` is CORRECT.** `hazards.py:60-69` projects to a true east/north frame (longitude scaled by `cos(mid_lat)`), and line 192 computes `lateral_m = ux*hy - uy*hx` = the 2D cross of the unit tee→green vector with the tee→hazard vector, documented (lines 20-22) as **positive = LEFT of travel**. Source-of-truth convention. Existing tests pin the sign but **only for due-north holes** — no bearing rotation. That is the coverage gap item 1 closes.

**Finding 2 — `course_intel._classify_side` is BROKEN and REACHABLE.** `course_intel.py:324-356` uses `atan2(Δlng, Δlat)` with **no `cos(lat)`** scaling and measures the feature bearing **from the green**, so landing bunkers label as `"front"`. `_classify_osm_hazards` builds `Hazard(...)` without `line_side`/`carry_yards` (default `"center"`/`0`). The `extract_hole_hazards` overwrite at `routes/caddie.py:1228` is **conditional** (only when the round resolves to a curated course with stored features, lines 1201-1227). On unmapped-course rounds the broken output survives into the session cache and is read by `/session/hazards`, the text mouth, and the realtime prompt. Reachable garbage path → **delete**.

**Finding 3 — `validate_guide` checks TYPE only** (`guide_writer.py:365`). Side never inspected → writer's "right-side bunkers" hallucination passes and is cached. Writer is handed correct ground truth (`build_ground_truth_block` uses `hz.line_side.upper()`), confirming this is a validation gap.

**Finding 4 — neither prompt defers to observation.** `voice_prompts.py:20-33` (`_BASE_BEHAVIOR`) and `routes/caddie.py:792-809` (text `stable_text`) append `HAZARD_GROUNDING_RULE` but nothing about the player's eyes.

## Fix design

### Item 1 — Lock in `hazards.py` correctness with a bearing-swept regression matrix
**File:** `backend/tests/test_hazards.py` (extend; do NOT touch `hazards.py`). Add a `_rotate(along, lateral, bearing)` helper mapping downrange/lateral offsets into (north, east): `east = along·sinθ + lateral·cosθ`, `north = along·cosθ − lateral·sinθ`, sign chosen so **positive lateral = LEFT** (assert against the known due-north case first).

New cases:
- `test_left_bunker_is_left_at_all_eight_bearings` — θ ∈ {0,45,...,315}, bunker 245y downrange, 25y left → `line_side=="left"`, `carry_yards≈245` at every bearing.
- `test_right_bunker_is_right_at_all_eight_bearings` — mirror.
- `test_bethpage_hole4_north_hole_west_bunker_is_left` — explicit real-frame fixture: north-pointing hole, bunker WEST at carry≈265y → `line_side=="left"`. Named regression.
- `test_center_within_deadband_at_all_bearings` — on-line bunker stays `"center"` at every bearing.

Pure, local. Existing 20 cases must keep passing.

### Item 2 — DELETE the broken OSM hazard classifier
Rewriting would keep a second geometry path that can drift — the exact failure mode here. Delete makes `extract_hole_hazards` the single source of hazard truth; unmapped holes stay honestly empty (→ `HAZARD_GROUNDING_RULE` generic language).

**`backend/app/caddie/course_intel.py`:** delete `_classify_osm_hazards` (215-264), `_classify_side` (324-356), `_distance_yards` (309-321, used only by the deleted fns). In `build_hole_intelligence`: remove the `osm_features` param + docstring entry; replace the hazard try/except (180-185) with `hazards: list[Hazard] = []`. `hazards=hazards` field stays (now always `[]` from this function).

**`backend/app/routes/caddie.py`:** remove `fetch_course_features` import (43) + the `osm_features` fetch block (1182-1186) + `osm_features=osm_features` from the `build_hole_intelligence` call (1219). Leave `app/services/osm.py` intact (only the caddie-route call is removed).

**Test ripple (same change):**
- `tests/test_course_intel_resilience.py::test_malformed_osm_features_keep_elevation` — drop `osm_features` kwarg; keep elevation/effective-yards asserts; assert `intel.hazards == []`. Update docstring.
- `tests/integration/test_caddie_profile_session.py` (208-221) — remove `osm_features` from `fake_intel` signature and the `fetch_course_features` monkeypatch.
- `tests/test_course_intel_static_read.py` — confirm no call passes `osm_features` positionally (they use the default → compatible).
- Add `test_unmapped_course_yields_no_hazards` to `test_course_intel_resilience.py` (valid tee/green, no features → `hazards == []`).

### Item 3 — Extend `validate_guide` to reject side-flip claims
**File:** `backend/app/caddie/guide_writer.py`. After the type scan, before structural checks, same fail-closed `return None`.

Build allowed-sides map:
```
sides_by_type: dict[str, set[str]] = {}
for hz in hazards:
    sides_by_type.setdefault(hz.type, set()).add(hz.line_side)  # left|right|center
```
Center-expansion (center = within 10y deadband, genuinely on-line): if a type's set contains `"center"`, treat both `left` and `right` as acceptable for that type.
```
def _acceptable_sides(t):
    s = sides_by_type.get(t, set())
    return s | ({"left","right"} if "center" in s else set())
```
Side lexicon: `_SIDE_PATTERN = re.compile(r"\b(left|right)\b")` (matches inside `left-center`, `short-right`). `_SIDE_WINDOW_WORDS = 6`.

**Detector:** per text field (`play_line`, `miss_side`, `green_notes`, each `common_mistakes`), tokenize with indices. For each hazard keyword (via existing `_HAZARD_PATTERNS`, iterating types so the matched type is known) that is **present in geometry** (`T in sides_by_type`), if a `left`/`right` word falls within ±6 tokens and the claimed side ∉ `_acceptable_sides(T)` → `return None`. Rules: only geometry-present types are side-checked (absent types already rejected by the type scan); a side word with no nearby hazard keyword is ignored (generic bail-out passes); ambiguous windows check all candidate types, reject if any contradicts.

**Edge-case table (all become unit tests):**
| Text | Geometry | Result |
|---|---|---|
| "aim left of the fairway bunker" | bunker LEFT | PASS |
| "favor left-center away from the right-side bunkers" | bunker LEFT | REJECT |
| "bail out left, away from the right bunkers" | bunker LEFT | REJECT |
| "trouble left, keep it right-center" | bunker LEFT | PASS |
| "water guards the right" | water RIGHT | PASS |
| "water guards the right" | water LEFT | REJECT |
| "bunker left, water right" | bunker LEFT, water RIGHT | PASS |
| "bunker left, water right" | bunker LEFT, water LEFT | REJECT |
| "aim at the right edge of the green; the bunker sits left" | bunker CENTER | PASS |
| "miss short-right, never long" | no hazards | PASS |

Plus `test_side_check_runs_after_type_check`, `test_center_only_hole_allows_either_lateral_claim`, `test_multiple_mistakes_items_each_scanned`, `test_correct_side_multi_hazard_passes`. Existing type-only + injection tests must keep passing. Update `validate_guide` docstring with rule 6.

### Item 4 — Epistemic-humility rule in both mouths (shared constant)
**File:** `backend/app/caddie/voice_prompts.py` — module-level:
```
OBSERVED_REALITY_RULE = (
    "The player can see the hole and you cannot. When they contradict the data "
    "on something they can directly observe — which side a hazard is on, what's "
    "visible, where the pin looks — defer to their eyes, plainly and without "
    "argument (\"You're looking at it — trust your eyes; my map may have it "
    "mirrored\"). Correct the read, don't defend it. Stay blunt about GOLF — club, "
    "strategy, commitment — but never insist the player is wrong about something "
    "in front of them."
)
```
- Realtime: `parts.append("# Behavior\n" + _BASE_BEHAVIOR.strip() + "\n" + HAZARD_GROUNDING_RULE + "\n" + OBSERVED_REALITY_RULE)` (voice_prompts.py:61).
- Text mouth: import `OBSERVED_REALITY_RULE` into `routes/caddie.py`, append `\n{OBSERVED_REALITY_RULE}` right after the `{HAZARD_GROUNDING_RULE}` line in `stable_text` (inside the cached stable block — caching unaffected).

**Tests** → new `backend/tests/test_epistemic_humility_prompt.py` (stub `DATABASE_URL` at top per `test_course_intel_resilience.py:7`): `test_observed_reality_rule_in_realtime_prompt` (build minimal `CaddiePersonality`, assert the rule + "my map may have it mirrored" present); `test_observed_reality_rule_shared_constant_nonempty` ("trust your eyes" + "mirrored"). Assert `routes/caddie.py` imports the constant (text-mouth CI coverage via existing DB-backed voice tests).

## Files to touch
Prod: `course_intel.py` (delete 3 fns + param), `routes/caddie.py` (remove OSM fetch/import; add OBSERVED_REALITY_RULE), `guide_writer.py` (side validation), `voice_prompts.py` (constant + append). **`hazards.py` unchanged.**
Tests: `test_hazards.py`, `test_guide_writer.py`, `test_epistemic_humility_prompt.py` (new), `test_course_intel_resilience.py`, `tests/integration/test_caddie_profile_session.py`, `test_course_intel_static_read.py`.
Shared types: **no change** (`Hazard`/`HoleStrategyGuide` shapes unchanged). Grep-confirm nothing else constructs `Hazard` without `line_side`.

## Data-repair runbook (POST-SHIP — session owner runs, NOT the builder)
**Deploy the fix FIRST** — re-research must run against the fixed `validate_guide` or poison regenerates.
Storage: strategy guide lives in `public.hole_features.properties` JSONB on the `feature_type='green'` row, as `properties->'strategy_guide'` + negative-cache `properties->'strategy_guide_attempted_at'`. `_precompute_course_guides` skips if either is non-null → clear BOTH. Backfill entrypoint `run_guide_backfill()` (`course_guides.py:183`), env-gated `GUIDE_BACKFILL_COURSES` + `GUIDE_BACKFILL_MAX_COURSES` (default 1). Manual only. All on prod box via SSM (`file://` params, secrets from service env file, never echoed; no local Postgres/docker).
1. Confirm deploy landed.
2. Clear both keys for all green features on both courses:
   `UPDATE public.hole_features hf SET properties = properties - 'strategy_guide' - 'strategy_guide_attempted_at' FROM public.holes h WHERE hf.hole_id = h.id AND hf.feature_type = 'green' AND h.course_id IN ('2b8caab5-2c55-5752-8cda-336c3a396dac','f8d6b570-f54e-56d8-890c-000e85a42c95');`
3. Re-run backfill: `GUIDE_BACKFILL_COURSES="2b8caab5-...,f8d6b570-..."`, `GUIDE_BACKFILL_MAX_COURSES=2`, invoke `run_guide_backfill()` (~$3, owner-approved).
4. Verify Bethpage hole 4 names LEFT bunkers (or no side); spot-check Pebble.

## Gates
- `cd backend && ruff check .`
- `cd backend && pytest tests/test_hazards.py tests/test_guide_writer.py tests/test_epistemic_humility_prompt.py tests/test_course_intel_resilience.py tests/test_course_intel_static_read.py` (pure, no Postgres).
- DB-backed integration/voice/caching tests → CI.
- `cd frontend && npm run lint && npx tsc --noEmit && npm run build` (expect no-op; confirms no type drift).
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`.

## Risks
Under-rejecting (paraphrase escapes window) — ground-truth block + epistemic rule are backstops; accept residual. Over-rejecting → honest omission, never a placeholder; center-expansion + no-keyword-pass rules + tests pin it. Deletion regressions → ruff + updated mock tests catch. Ordering → runbook gated deploy-first.

## Classification
**NOTICEABLE.** Consistent with NORTHSTAR (voice-first, honest data, `[[no-fake-data-fallbacks]]`).
