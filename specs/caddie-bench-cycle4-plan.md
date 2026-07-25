# Caddie Bench Cycle 4 — Implementation Plan (builder's contract)

**Branch:** `caddie-bench-c4` (== `origin/integration/next` + diagnosis progress commits).
**Owner's bar (2026-07-25, verbatim-derived):** on a genuinely clear hole, DRIVER. Any sub-driver pick must be able to name punitive, high-probability evidence in one sentence. Both tails are failures: timid AND reckless. Standing goal: 100% on the bench.
**Owner directive #2 (2026-07-25):** the judge must grade against real satellite imagery ("the actual maps we see, not the yardage book paper map"). `GOOGLE_MAPS_KEY` is provisioned on the owner's runner box (NOT on the dev box — see §E).

The diagnosis is payload-verified and is NOT re-litigated here. This plan is the build contract. The builder implements; it does not re-plan.

---

## 0. Verified facts this plan is built on (measured in this worktree, 2026-07-25)

Bend geometry across every relevant fixture (`extract_hole_bend` + turn angle between the two legs at the bend vertex, measured with the module's own frame math):

| Hole | yards | bend@ | dev | **dev/dist** | turn° | verdict |
|---|---|---|---|---|---|---|
| `bethpage_black_h4` | 517 | 265 | 51 | **0.19** | 22.9 | FALSE POSITIVE (clear driver hole → currently 4iron w/ corner tree) |
| `pebble_beach_h3` | 381 | 265 | 48 | **0.18** | 32.2 | FALSE POSITIVE (→ 4iron) |
| `bethpage_black_h18` | 411 | 395 | 41 | **0.10** | 25.5 | FALSE POSITIVE (plays dead straight; bend vertex is 16y short of the green) |
| `bethpage_black_h7` | 553 | 210 | 110 | **0.52** | 50.8 | genuine sharp corner |
| `bethpage_red_h16` | 500 | 270 | 121 | **0.45** | 51.6 | genuine sharp corner |
| `bethpage_red_h6` (red_trees) | 287 | 195 | 83 | **0.43** | 62.3 | genuine — the PINNED legit cap (`test_13_red6_5iron_via_bend_cap_unchanged`) |
| synthetic `_BEND` (bend-cap tests) | 400 | 226 | 88 | **0.39** | n/a | PINNED legit cap |
| Pine Valley 9 | 554 | 175 | 43 | **0.25** | 20.2 | bogus-cap audit hole (already fixed via forward bound) |
| red_trees h5 | ~? | 295 | 64 | — | 32.0 | gentle sweep |

**Clean gap: false positives cluster at 0.10–0.19 (turn 20–32°); genuine corners at 0.39–0.52 (turn 51–62°).** Any threshold in ~0.25–0.35 separates with margin both ways.

Two structural facts (eng-lead verified, re-confirmed here):
- Every mapped tree hazard is hardcoded `penalty_severity="moderate"` (`hazards.py:121`, `_tree_hazard` at `hazards.py:846`) — the bend-cap's `>= _MODERATE_RANK` filter is satisfied by EVERY tree, unconditionally.
- `_tree_hazard` computes `_lateral_yards` from the observation tuple (`hazards.py:840`) and **discards it** — `Hazard` has no lateral-offset field, so the cap cannot know if "corner trees" are 5y or 65y off the line.

One decisive NEW measurement: **Red 6's corner-guarding trees are on the OUTSIDE of the bend** — `line_side="right"` at carries 195/225 on a LEFT dogleg, laterals 35y and 29y off the played line. A fly-through exits on the outside of the elbow, so an "inside-of-bend trees only" filter (considered in the brief) would break the pinned legit cap **on its merits** and is REJECTED. The honest danger signal is lateral proximity to the played line, not which side of the bend.

Bench-side facts: `run_caddie_bench.py --render-mode` already defaults to `satellite` (`run_caddie_bench.py:345-349`); `render.fetch_base_tile` raises on a missing key but a mid-run tile failure aborts the whole run uncontrolled with no per-case record and no report trace; `RunMeta`/`generate_report` never state the render mode. Fixture mix measured over the current 150 cases: fairway 50, rough 42, tee 28, bunker 24, greenside 3, recovery_trees 3 → 46% trouble lies. Corridor is non-`None` on exactly one fixture (`bethpage_black_h8`, a par 3 where it is structurally unused) → the tee-club machinery is inert across all 150 cases. `tests/fixtures/bethpage_red_trees.json` carries real OSM tree features for Red holes 1 (27 features), 5 (9), 6 (1); merged with the Overpass hole geometry, Red 1 yields a live corridor profile (31 samples, 1 known width — passes the all-or-nothing gate) and Red 6 yields real corner trees that legitimately arm the cap.

---

## A. The engine fix (`backend/app/caddie/aim_point.py`, `hazards.py`, `types.py`)

Root cause, one sentence: the bend-cap's arming condition — "centerline chord-deviation ≥ 15y anywhere + any tree mapped within a 60y window of that vertex" — carries zero information about corner sharpness or actual danger, and it then hard-caps to `corner − 5` BEFORE the E-model, becoming its ceiling, so a spurious cap is unrecoverable.

### A1. Corner criterion: deviation as a FRACTION of corner distance, in the cap gate (chosen), not `extract_hole_bend`

**New constant** (`aim_point.py`, next to `CORNER_MIN_DISTANCE_YDS`):

```python
# A corner only arms the cap when the bend vertex's chord deviation is a
# substantial FRACTION of its own tee-anchored distance — i.e. the hole
# genuinely TURNS there, rather than gently sweeping. Empirical table
# (specs/caddie-bench-cycle4-plan.md §0, measured on real fixtures
# 2026-07-25): clear holes the cap was ruining measure 0.10-0.19
# (Black 4, Pebble 3, Black 18); every genuine, pinned corner measures
# 0.39-0.52 (Red 6, Black 7, Red 16, the synthetic bend-cap fixture).
# 0.30 sits in the gap with >=0.09 margin both ways. A fixed yardage
# (_BEND_MIN_DEVIATION_YARDS=15) is the wrong SHAPE of criterion here:
# the corner distances are all similar while deviations differ 3x.
CORNER_MIN_DEVIATION_FRACTION: float = 0.30
```

**Gate change** (`generate_recommendation`, the `if` at `aim_point.py:1298-1304`) — add one conjunct:

```python
and bend.deviation_yards >= CORNER_MIN_DEVIATION_FRACTION * bend.distance_yards
```

Why the gate and not `extract_hole_bend`: `HoleBend.straight` is also consumed by `app/caddie/tools.py:786` (the spoken hole-shape note) and `aim_point.py:1524` (the P2 "corner is your landing zone" color line). Changing `straight` semantics would churn spoken output and its pinned tests across the product. The gate change confines the new criterion (the 0.30 fraction, A1) to exactly the decision that was wrong (the club cap). The fraction uses only `HoleBend`'s own fields, so it works identically for synthetic test fixtures (no polyline) and when `hole.yards` is None (red_trees h5).

**Builder correction (2026-07-25, eng-lead clarification, post-implementation):** this rationale applies to A1 (the 0.30 fraction) only, kept deliberately cap-local to avoid churning spoken output. A4's `_BEND_NEAR_GREEN_EXCLUDE_YDS` (below) is a DIFFERENT, DELIBERATE GLOBAL correction — it lives in `extract_hole_bend` itself and therefore does reach `tools.py:786`/`aim_point.py:1524`, on purpose: a phantom bend vertex near the green (Black 18's actual defect) is wrong everywhere it's spoken, not just in club selection, so silencing it everywhere is the correct behavior, not a side effect to avoid. The plan's original text did not state this distinction; it is recorded here rather than silently left implying A4 is cap-local too.

**Falsification test for the criterion:** a real hole with a genuinely blind, tree-walled, cappable corner measuring dev/dist < 0.30. The 166-hole prod audit sweep (`specs/caddie-tee-selector-audit-before.md`) is the search ground; if one is found, the criterion is wrong in shape and the fallback design is a `turn_angle_deg` field on `HoleBend` (additive, computed from the two legs `extract_hole_bend` already forms at `hazards.py:618-629`) with a 45° threshold (measured gap: sweeps 20–32°, corners 51–62°). Do not build the fallback now; name it in the constant's comment.

### A2. Danger-evidence arming: plumb the discarded lateral offset onto `Hazard`

**`types.py` `Hazard`** — one additive, defaulted field (cache-compatible, same pattern as `carry_yards`/`line_side` and `CorridorSample`):

```python
# Perpendicular offset (yards) of this hazard's observation point from the
# hole's played centerline — additive + defaulted so older cached
# HoleIntelligence JSONB still validates. None = not measured (legacy
# cache / hand-built fixture), never "on the line".
lateral_yards: Optional[float] = None
```

**`hazards.py`**: `_tree_hazard` (line ~829) stops discarding `_lateral_yards` — `lateral_yards=round(abs(_lateral_yards), 1)` on the constructed `Hazard`. Also set it in the bunker/water classify path where the projection already yields `lateral_m` (the `_classify` closure inside `extract_hole_hazards`) — same one-line addition; unmeasured paths leave the default.

**`aim_point.py`** — new constant + filter conjunct in the `corner_trees` comprehension:

```python
# A corner tree only counts as GUARDING the through-the-corner line when
# its observation sits within this lateral distance of the played line.
# Red 6 (the pinned legit cap) measures 29y/35y; the extraction cap
# (_TREE_MAX_LATERAL_YARDS) admits observations to 70y, and a tree edge
# 45+y off the line is ~2.6 sigma for a hcp-15 driver cone (width ~70y,
# sigma ~17.5) — sub-1% tail, not "guarding". None (legacy cache /
# hand-built fixture) never disqualifies — unknown is unknown.
CORNER_TREE_MAX_LATERAL_YDS: float = 45.0
```

Filter: `and (h.lateral_yards is None or abs(h.lateral_yards) <= CORNER_TREE_MAX_LATERAL_YDS)`.

**Explicitly rejected:** inside-of-bend side filtering (Red 6 evidence, §0) and requiring corridor-width corroboration as a hard conjunct (corridor is `None` on every real capping fixture — the all-or-nothing both-sides gate at `hazards.py:1458` — so it would silently delete the legit cap; corridor evidence stays what it already is, a post-cap refinement via the E-model ceiling). The severity filter (`>= _MODERATE_RANK`) stays as-is but gets a one-line comment stating it is currently vacuous for trees (every tree is "moderate") and is retained for future non-tree corner evidence.

### A3. The cap stays a hard structural cap (chosen) — NOT demoted to an E-model candidate

Reasoning, stated so the builder doesn't relitigate: the E-model prices lateral-corridor trouble at the landing distance; it has no through-the-corner cost model, and building one honestly requires corner geometry probabilities we cannot compute from present data (corridor is `None` at every real corner; inventing a probability violates [[no-fake-data-fallbacks]]). The diagnosis's own sweep proves E never lays up on width alone — so "demote the cap to a candidate E evaluates" is equivalent to deleting the cap, which breaks `test_corridor_caps_club_short_of_the_corner` and Red 6 **on their merits**. With A1+A2 the cap only arms on sharp (≥0.30), tree-guarded (≤45y lateral) corners — the "spurious cap is unrecoverable" problem is fixed at the arming layer, which is where the audit says every real-world false positive actually lived. The `corner − 5` target formula is unchanged: on a true 50°+ tree-walled corner you cannot cut through, laying to the corner IS the golf, even 6-iron/leave-355 on Black 7 (root cause #4's absurdity was spurious arming, not the target arithmetic). E-model precedence unchanged (runs after, ceiling composition, take-the-shorter).

**Falsification:** if a post-fix bench run shows a case where the cap armed with the new evidence in view and the judge flags `engine_looks_wrong` with a convincing reason, the target formula (not the arming) is the next suspect.

### A4. `bethpage_black_h18`'s bogus spoken bend: near-green vertex exclusion in `extract_hole_bend`

h18 reports `doglegs left at ~395` on a 411y hole that plays dead straight — the "bend vertex" is the green surround, 16y short of the green. In `extract_hole_bend`'s candidate loop (`hazards.py:589-597`), exclude vertices within 40y of the path's green end:

```python
# hazards.py, new constant near _BEND_MIN_DEVIATION_YARDS:
# A candidate vertex this close to the green end of the path describes the
# green surround / final approach curl, not a dogleg the tee shot faces.
# 40y ~ green-complex scale; Black 18's phantom "bend" sits 16y short of
# the green and is the convicting case (spoken "doglegs left at ~395" on
# a hole the owner calls dead straight).
_BEND_NEAR_GREEN_EXCLUDE_YDS: float = 40.0
```

Condition: skip candidates with `(total_path_len_from_tee - along_m) * _YARDS_PER_METER < _BEND_NEAR_GREEN_EXCLUDE_YDS`. Result: h18 → `straight=True` (remaining candidates deviate < 15y). Verified: no other fixture in §0 has its bend vertex within 40y of the green (closest: Red 6 at 92y). The builder must run `tests/test_hazards.py::TestExtractHoleBend` — if any synthetic fixture there places its intended bend vertex inside the last 40y, adjust that fixture's geometry (lengthen the second leg), never the assertion; the tests' intent is direction/threshold semantics, not near-green vertices.

### A5. Root cause #5 (tee-anchored geometry vs. par-5 second shots): OUT OF SCOPE, backlogged loudly

Do not silently fix. Add a `backlog.json` item (`caddie-shot-origin-offset-for-bend-and-corridor`): `HoleBend.distance_yards`/`CorridorSample.distance_yards` are tee-anchored (`types.py:157,169`) but `generate_recommendation`'s positioning branch is shared by mid-hole strokes with no shot-origin offset (grep confirms: no `already_played|from_tee|shot_origin` anywhere). Note in the item that the bench's fairway-lie par-5 cases are the observable surface. Add one code comment at the cap gate naming the limitation.

### A6. MUST-NOT-REGRESS walkthrough (each passes on its merits)

- `test_corridor_bend_cap.py::test_corridor_caps_club_short_of_the_corner`: `_BEND` 88/226 = 0.39 ≥ 0.30 ✓; hand-built hazards have `lateral_yards=None` → never disqualified ✓; caps to ≤221 as before. Siblings (`no_bend_data`, `corner_without_trees`, `straight_hole`, `corner_too_close`, `drive_landing_short`) unaffected (their gates trip earlier).
- `test_corner_tree_forward_bound.py`: after-fix Pine Valley 9 (0.25 < 0.30) and Pebble 3 (0.18) stay uncapped — now doubly protected ✓. **The two `before_fix_repro_via_monkeypatch` tests must additionally `monkeypatch.setattr(aim_point, "CORNER_MIN_DEVIATION_FRACTION", 0.0)`** to keep isolating the forward-bound mechanism they exist to prove (otherwise they fail for the new, correct reason). This is repro-harness maintenance, stated in their docstrings — not an assertion change. The synthetic boundary tests (`just_inside`/`just_outside`/`far_past`) use `_BEND` 0.39 + a single left tree with `lateral_yards=None` ✓.
- `test_tee_club_expected_strokes.py::test_05/test_05b` (water pinch lays up): pure E-model, no bend involvement ✓. `test_13` Red 6: 0.43 ✓, real corner trees at 29/35y lateral clear the 45y bound ✓ → still 5-iron/leave-100/corner note. `test_14` (all Red par-4/5 driver): those holes cap only if trees arm; overpass fixture has no trees ✓; A4 only makes bends *straighter* ✓. `test_12` Red 1 driver ✓ (measured straight).
- `test_tee_club_tree_severity_calibration.py` (hcp-30 chute + ceiling pins): corridor/E-model path, untouched ✓.
- `test_corridor_width_selection.py` (incl. `test_04` pathological 5y corridor): `_BEND` fixtures are 0.39 ✓; E-model untouched ✓. `test_corridor_profile.py`, `test_tee_shot_numbers.py`: untouched code paths ✓.
- Frontend: check `frontend/src/lib/types.ts` for a mirrored `Hazard` shape; if present add `lateral_yards?: number` (additive). If it moves shared types, frontend gates (`npx tsc --noEmit`, lint) run for that commit.

**New pinning tests (commit 1):** a `test_bend_cap_corner_sharpness.py` that (a) reproduces the owner's incident on the REAL committed bench fixtures — `bethpage_black_h4` + one injected moderate corner tree (lateral ~30y) with the owner bag → **driver** post-fix, and the pre-fix 4-iron via `monkeypatch(CORNER_MIN_DEVIATION_FRACTION, 0.0)`; same pair for `pebble_beach_h3`; (b) boundary tests at fraction 0.30 exactly-at/just-below; (c) lateral bound: identical corner tree at 44y caps, at 46y doesn't, at `None` caps; (d) h18 `extract_hole_bend` → `straight=True` with the near-green exclusion, plus a synthetic control whose bend at mid-hole is unaffected.

---

## B. New judged dimension: `aggression_realism` (2x weight class)

### B1. Schema (`schema.py`)

- `JudgeDimension.AGGRESSION_REALISM = "aggression_realism"` (11th member).
- Add to `CORRECTNESS_DIMENSIONS` (→ 7 members, weight 2). `report.CRUX_DIMENSIONS` is derived by complement → stays the same 4 crux dims automatically.
- New `FailureClass.TOO_TIMID = "too_timid"` so the Pareto can name the owner's exact complaint (the reckless tail already has `bad_club`/`missed_hazard`).

### B2. Rubric text (`judge.py::_RUBRIC_TEXT`), verbatim:

```
JudgeDimension.AGGRESSION_REALISM: (
    "Judge the RISK POSTURE of the recommended club/target against the PLAYER BAG "
    "(club distances + handicap) and the MAPPED HAZARD / CORRIDOR evidence below. "
    "FAIL (0) a conservative call — laying up or clubbing down off the tee, or laying "
    "back on an approach — that cannot point to specific, mapped, high-probability "
    "punishment for the longer club: on a clear hole the normal-golf aggressive play "
    "(driver off the tee) is the correct call, and 'safe' is not a reason. "
    "FAIL (0) an aggressive call that brings mapped water/OB/severe trouble into play "
    "at meaningful probability when a modest layback avoids it. "
    "Score the CLUB ACTUALLY RECOMMENDED, never the tone: hedging, 'smart play', or "
    "acknowledging the longer club without recommending it does NOT rescue a timid "
    "pick, and cautionary language does NOT rescue a reckless one. "
    "If the answer makes no club or risk decision at all (a pure factual readout), "
    "score 2 with confidence 1.0."
)
```

Anti-gaming guards: (a) the "score the CLUB, never the tone" sentence makes boilerplate hedging non-scoring by construction; (b) `_LENGTH_DISCLAIMER` already bars verbosity; (c) a pinned offline test asserts the rubric string contains both FAIL tails and the anti-hedging sentence, so a later edit can't quietly soften it; (d) a new **timid canary** (below) makes a judge that passes timidity fail the whole run. `CLUB_CORRIDOR`'s text is unchanged (it stays the geometric dimension; add a code comment noting the pair's division of labor: corridor = geometry respected, aggression_realism = risk posture calibrated).

### B3. Evidence the judge actually needs (`judge.py::judge_prompt`)

The judgment must be evidence-based, not vibes off a picture. Extend `judge_prompt` (and `judge_case`/`second_pass_if_needed` pass-throughs) with keyword params, all defaulted `None` (offline tests that don't pass them stay green):

- `bag_clubs: Optional[dict[str, int]]`, `bag_handicap: Optional[float]` → rendered into the SITUATION FACTS block as e.g. `Player bag (stored yards): driver 300, 3wood 270, 4iron 230, ... · handicap 3.0` — replacing today's label-only `Player bag: owner`. Source: `run_caddie_bench.run()` already holds `bags[case.bag]` (`PlayerBag.clubs/.handicap`, `run_caddie_bench.py:219`).
- `hazards_payload: Optional[list[dict]]` → rendered as `MAPPED HAZARDS (tee-anchored carry, side, severity): trees R 195y moderate; water C 260y death; ...` (compact, one line per hazard, cap ~12). Source: recompute in `run()` via `geo.hole_intel_from_fixture(fx).hazards` (deterministic, cheap — same call `harness.run_case` makes at `harness.py:396/411`; do NOT add it to `CaseResult`, judge evidence must not bloat results.jsonl).
- `corridor_summary: Optional[str]` → for positioning shots: `corridor at recommended club's landing (~232y): danger-to-danger width 40y (trees L 15y / trees R 25y)` built from `corridor_sample_at(intel.corridor, engine_ref["tee_shot_numbers"]["drive_total_yards"])`; when corridor/sample is absent: `corridor width at landing zone: unmapped — no danger-edge evidence (do not invent one)`. Honest-unknown wording is mandatory.
- `_format_engine_ref` (`judge.py:81-103`): additionally print `corridor_trouble_pct` / `corridor_alt_*` / the `corridor_note`-bearing fields when present on `tee_shot_numbers` — the engine's own risk numbers are exactly the "one sentence of punitive evidence" the bar demands.
- The instructions header string `"a fixed 10-dimension rubric"` (`judge.py:129`) becomes `f"a fixed {len(JudgeDimension)}-dimension rubric"`.

`should_second_pass` needs no change (new dim participates in the confidence floor automatically; no det-check overlaps it). `_judge_json_schema` picks up the enum automatically.

### B4. New timid canary (`questions.py::_CANARY_ANSWERS`)

Append a 5th entry:

```python
(QuestionType.TEE_STRATEGY,
 "Let's just take the 4-iron and lay it back safe out there, driver is way too "
 "risky on this hole, no reason to take on trouble even though there's nothing "
 "really out there, smart play is always the short club."),
```

The judge MUST score it bad (self-contradicting timidity: names no evidence, admits "nothing really out there"). `test_bench_offline.py`'s `len(canaries) == 4` → 5, plus a teeth-test asserting this canary's presence and that an all-pass verdict on it trips `canary_all_pass_gate`.

---

## C. Fixtures + scenario mix — make the bench SEE the defect

### C(i). Make the tee-club machinery live — real geometry only, no masquerading synthetics

Extend `extract_fixtures.py` with a `--merge-red-trees` mode (still gated on `CADDIE_BENCH_EXTRACT=1`): assemble Red holes 1, 5, 6 from the committed Overpass fixture exactly as today, then append the tree/woods features from the committed `tests/fixtures/bethpage_red_trees.json` (holes "1", "5", "6" — 27/9/1 features, real OSM data captured read-only) before writing. Output:

- **`bethpage_red_h1.json`** (NEW, par 4, yards derived-and-labeled): tree lines both sides, measured live corridor (31 samples, ≥1 known width) → the E-model path finally executes in the bench; a clear-driver hole with real tree color.
- **`bethpage_red_h5.json`** (NEW, par 4, yards derived): gentle 32° sweep with right-side trees at 105–170y → the "clear hole, trees present, bend below threshold → DRIVER" case, the owner's exact scenario.
- **`bethpage_red_h6.json`** (UPGRADED in place): the genuinely-tight case — real 0.43 corner with real guarding trees at 29/35y lateral → the bench now exercises a LEGIT bend-cap end-to-end (engine says 5-iron; the judge, given the evidence pack, should pass it on `aggression_realism` because the punitive evidence is nameable in one sentence).

`_provenance` must state the merge explicitly, e.g.: `"OSM geometry assembled from committed bethpage_overpass.json (Bethpage Red, hole N) via assemble_osm_course; tree/woods features merged verbatim from committed tests/fixtures/bethpage_red_trees.json (real OSM data, captured read-only). Yardage N DERIVED (straight-line tee->green) — labeled, not measured."` Per [[no-fake-data-fallbacks]]: **no synthetic holes enter the judged set** — a fabricated hole has no real satellite imagery, so under the owner's satellite directive it would force the judge to grade overlays against unrelated ground truth. (Synthetic geometry stays where it already lives: offline unit tests.) Together with `pebble_beach_h3` (which already carries real tree hazards), the bench then covers: clear-and-open (red_h1, red_h5, black_h4, pebble_h3), genuinely-tight (red_h6), and sharp-but-treeless (black_h7, red_h16).

Offline pinning test: for each of the three new/upgraded fixtures, assert the extraction invariants that make the machinery live (`red_h1`: `corridor is not None`; `red_h6`: cap arms for the owner bag and the recommendation is not driver with the corner note present; `red_h5`: driver for the owner bag) — these run in CI with zero network.

### C(ii). Slot rebalance toward ordinary golf (`questions.py`)

Exact new tuples:

```python
_PAR45_SLOTS = (
    (LieCategory.TEE, None, QuestionType.TEE_STRATEGY),
    (LieCategory.TEE, None, QuestionType.CHALLENGE_WHY),      # "why that club / why not go at it?" — the aggression surface
    (LieCategory.FAIRWAY, 0.35, QuestionType.LAYUP_VS_GO),
    (LieCategory.FAIRWAY, 0.65, QuestionType.CLUB_SELECTION),
    (LieCategory.ROUGH, 0.5, QuestionType.MISS_SIDE_BAIL),
    (LieCategory.BUNKER, 0.7, QuestionType.CARRY_QUESTION),
)
_PAR3_SLOTS = (
    (LieCategory.TEE, None, QuestionType.CLUB_SELECTION),
    (LieCategory.TEE, None, QuestionType.WIND_ADJUST),        # wind club-adjust is asked ON the tee
    (LieCategory.GREENSIDE, None, QuestionType.APPROACH_GREEN),
    (LieCategory.BUNKER, 0.9, QuestionType.CARRY_QUESTION),
)
```

The RECOVERY_TREES slot is removed (it substituted to ROUGH on 6 of 7 holes anyway — the mix's hidden rough inflation); `QuestionType.RECOVERY` remains in the bank (the bank-coverage test is bank-side) and recovery scenarios are noted in the backlog as a future dedicated suite. `CHALLENGE_WHY` phrasings have empty `lie_constraint` (verified: `questions_v1.jsonl:108-115`) so the tee slot resolves. `_LIE_FALLBACK`/`_QTYPE_FALLBACK_FOR_LIE` unchanged.

**Before → after mix.** Before (measured, 150 cases): fairway 50, rough 42, tee 28, bunker 24, greenside 3, recovery 3 — 46% trouble. After, with 10 fixtures (9 par-4/5 after C(i), 1 par-3), 3 bags: advice cases = 9·6·3 + 1·4·3 = **174**: tee 60, fairway 54, rough 27, bunker 30, greenside 3 → **tee+fairway 114/174 = 66%, trouble (rough+bunker) 57/174 = 33%**; + 10 FACT (fairway lie) + 5 canaries = **189 total**. The builder pins the exact totals in `test_build_cases_produces_the_planned_case_count` (update `len(canaries)` to 5; keep the `>= 100` floor; add the exact-count and per-lie-mix assertions so the mix can't silently regress).

---

## D. Dual-basis reporting (`report.py`)

Adding a 2x dimension changes the headline denominator (per fully-applicable case: 6·2·2+4·1·2 = 32 → 7·2·2+4·1·2 = 36). Both bases are reported; the 11-dim number is the honest basis going forward.

- `report.py`: `LEGACY_BASIS_EXCLUDED_DIMENSIONS = frozenset({JudgeDimension.AGGRESSION_REALISM})` next to `CRUX_DIMENSIONS`.
- `HeadlineStats`: new field `weighted_correctness_score_legacy10: float`. `compute_headline` (`report.py:134-249`) runs a second weighted accumulation over `dim_scores` skipping the excluded dim. Old-run JSONL (no `aggression_realism` key in `scores`) aggregates identically on both bases by construction — the loop iterates `r.judge.scores.items()`.
- `generate_report` headline block: `**Weighted correctness (11-dim, NEW basis — the honest number going forward): X%**` followed by `Old-basis weighted correctness (10-dim, comparable with runs <= cycle 3): Y%`. The `delta_against` hook (`report.py:284,389-395`): compare the prior run's `weighted_correctness_score` against THIS run's `weighted_correctness_score_legacy10` (like-for-like), labeled `(old basis)`; print the new-basis number alongside marked `(no prior — new basis starts this run)`.
- `RunMeta`: new fields `render_mode: str = ""` and `render_failure_count: int = 0`; `run()` populates both. Run header gains: ``- Render mode: `satellite` — judged against real imagery (owner directive 2026-07-25)``; when `vector`: ``- Render mode: `vector` — offline/CI substrate, NOT the owner's fidelity flow; do not compare against satellite-based runs``. When `render_failure_count > 0`, a loud warning line at the top of the report.
- State in the report (one line under Run header) that **satellite + the 11-dim rubric together constitute the new trajectory basis** — the first satellite run must present old-basis and new-basis side by side once (the delta section above does this).

---

## E. Satellite directives (owner: real maps, not the paper map)

Split per eng-lead: **(a) landable now** (all code below, no keys needed to build/test) vs **(b) execution gated on keys** (fidelity render + full run — `GOOGLE_MAPS_KEY`/`OPENAI_API_KEY` exist only on the owner-authorized runner box; do NOT attempt runs from the dev box, and never route around the permission system).

1. **Defaults**: `--render-mode` already defaults to `satellite` with a fail-fast key check (`run_caddie_bench.py:148-157,345-349`) — no change. Update `README.md`'s packaged run commands to show the satellite default explicitly and the `--render-mode vector` escape hatch labeled "offline/CI smoke only, never a judged basis". Vector remains the ONLY mode CI/offline tests touch (no key, no network) — unchanged contract.
2. **Fail LOUDLY per-case, never fall back to vector** (`render.py::fetch_base_tile` + `run_caddie_bench.run()`):
   - `fetch_base_tile`: after the fetch, verify `resp.headers.get("content-type", "").startswith("image/")`; a 200 with a non-image body (quota/billing HTML) raises the same redacted `RuntimeError` (status + content-type, never the key). There is already no vector fallback in this function — keep it that way; add a comment pinning "never fall back to vector: a mixed-basis run corrupts the comparison".
   - `run()`: wrap the `render.render_case` call (`run_caddie_bench.py:223`) in `try/except RuntimeError`; on failure append `{"case_id": ..., "error": "<redacted message>", "render_mode": args.render_mode}` to `runs/<run_id>/render_failures.jsonl`, print a loud stderr banner, and **abort the run** with new exit code `_EXIT_RENDER_FAILURE = 5` (documented in the module docstring's exit-code list). Rationale: results.jsonl is append-resumable, so aborting is cheap and a partial mixed run is never produced; the failed case is never judged without its composite. `RunMeta.render_failure_count` is set from the file when present so the report shows it (§D).
   - Pinning tests (offline): content-type guard raises on a text/html 200 (stubbed httpx); the runner's except-path writes the JSONL line and returns 5 (canned-synth harness, monkeypatched `render_case` raising).
3. **One-time composite fidelity check** (execution step, key-gated): new `--render-only` flag on `run_caddie_bench.py` — renders composites for the selected cases and exits 0 **without** requiring `CADDIE_EVAL_LIVE`/`OPENAI_API_KEY` (restructure `main()`'s gate: `--render-only` needs only the maps key). Packaged command for the owner's box:
   `cd backend && uv run python -m tests.eval.caddie_bench.run_caddie_bench --render-only --holes bethpage_black_h7 bethpage_red_h6 bethpage_black_h8 --max-cases 3`
   Verification checklist (goes in README): player pin on the sampled lie, green pin on the green, hazard outlines tracking real bunkers/water, centerline on the fairway, header/wind annotations legible — at the fitted zoom on a 553y hole (the long-hole case B1 fixed), a sharp dogleg, and a par 3. Georegistration has never run against real tiles at scale; a projection bug would mislead every judge call, so this gates the full run in §G's sequencing.

---

## F. Tests + gates (consolidated)

Every behavioral change above names its pinning test inline (§A6, §B4, §C, §D, §E2). Additional required maintenance:

- `test_bench_offline.py` hand-computed arithmetic — recompute honestly, never delete (per-case full-applicability denominator 32 → 36): the noise-stats assertions at ~475-481 (`30/32` → `34/36`; `band_pessimistic` `56/60` → `68/72`; `band_optimistic` stays 1.0) and the headline test at ~700-746 (`60/64` → `68/72` before-fix analog; after-fix stays 1.0). The builder derives each from the documented formulas and shows the derivation in the test docstrings, exactly as the current tests do.
- `test_build_cases_produces_the_planned_case_count`: canaries 4 → 5; exact case count for the 10-fixture matrix; per-lie mix assertions (§C(ii)).
- `test_question_bank_loads_and_covers_every_type`: no new `QuestionType` is introduced, so no new phrasings are required — verify it stays green after the slot changes.
- `test_bench_teeth.py`: iterates `JudgeDimension` dynamically — verify; add the timid-canary teeth case.
- Gates per commit: `cd backend && ruff check .` and the offline pytest suite (`uv run pytest tests/eval/caddie_bench tests/test_corridor_bend_cap.py tests/test_corner_tree_forward_bound.py tests/test_tee_club_expected_strokes.py tests/test_tee_club_tree_severity_calibration.py tests/test_corridor_width_selection.py tests/test_corridor_profile.py tests/test_tee_shot_numbers.py tests/test_hazards.py`). **No local Postgres** — DB-backed tests run in CI only, never spin up a container. Frontend gates only if `frontend/src/lib/types.ts` mirrors `Hazard` (check in commit 1; additive optional field + `npx tsc --noEmit` + lint if so).

---

## G. Sequencing — five commits, each independently green on `integration/next`

1. **engine: bend-cap arms on evidence, not vibes** — A1 (fraction gate) + A2 (`Hazard.lateral_yards` + lateral bound) + A4 (near-green vertex exclusion) + A6 test maintenance + new `test_bend_cap_corner_sharpness.py` + A5 backlog item + frontend type mirror check. This alone deletes the owner's 4-iron.
2. **bench: `aggression_realism` + evidence-based judging + dual-basis report** — B1-B4 + D + recomputed offline arithmetic + timid canary. (Rubric change needs reviewer sign-off before any live run, per the standing bench contract.)
3. **bench fixtures: make the tee-club machinery live + rebalance the mix** — C(i) `--merge-red-trees` + 2 new / 1 upgraded fixture + extraction-invariant pins; C(ii) slot tuples + count/mix test updates.
4. **bench render: satellite hardening + fidelity mode** — E2 fail-loud guard + exit code 5 + `render_failures.jsonl` + `--render-only` + README command/doc updates (E1, E3 checklist).
5. **records** — `tasks/progress.md`, backlog grooming (shot-origin item from A5, recovery-suite note from C(ii)).

Then, **key-gated execution on the owner's box** (not a commit): (a) `--render-only` fidelity check on 3 cases → eyeball → (b) full satellite run, which reports old-basis and new-basis side by side (§D) and becomes the new trajectory baseline.

Genuine uncertainty, named: the 0.30 fraction threshold rests on a 9-hole measured table with a wide gap; the falsification path (A1) is a real sub-0.30 blind corner from the 166-hole audit ground, and the pre-named fallback is the `turn_angle_deg` criterion at 45°. Build 0.30 now.
