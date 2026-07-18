# Caddie P0: Expected-Strokes Tee/Positioning Club Selection

Plan authored on the `fable` model (2026-07-18). This is the contract handed to the builder;
the builder implements it and does not re-plan.

## 0. Incident

Owner field report (live round, v1.1.15, verbatim): *"The caddie is extremely conservative.
Tells me to hit 7 iron instead of driver. How to fix this."*

## 1. Diagnosis (verified by code trace + offline reproduction)

`_select_club_fitting_corridor` (`backend/app/caddie/aim_point.py:695-764`, called from
`generate_recommendation` at ~line 909, positioning branch only) is a **hard fit constraint with
no expected-strokes tradeoff**. It walks the bag descending and accepts the first club whose
±1.5σ landing window (`_club_fit_window_yds` = 0.75 × `get_dispersion(club, hcp)["width_yards"]`)
is `<=` the corridor's danger-to-danger `width_yards` at that club's conditions total.

15-handicap windows (verified): driver 56.2y · 3wood 48.8 · 5wood 46.5 · hybrid 45.0 · long-iron
42.0 · mid-iron 36.0 · short-iron 30.0. Since the tree-span fix enriched
`extract_corridor_profile` danger edges, tree-lined production holes carry `width_yards` ≈ 40-55 —
so driver is rejected as a *wall*, cascading down the bag regardless of (a) distance sacrificed,
(b) actual trouble probability (a 56y window over a 50y corridor only clips the cone tails),
(c) hazard severity (trees == water).

**Reproduced cascade with the current code** (synthetic uniform corridors, 467y par-4, default
bag, hcp 15):

| corridor width | current club | leave |
|---|---|---|
| 55 | 3wood | 225 |
| 50 | 3wood | 225 |
| 45 | hybrid | 250 |
| 40 | **6-iron** | **290** |
| 38 | **6-iron** | **290** |

Width 38-40 (edges ~±20 — an ordinary tree-lined hole) → mid-iron off a par-4 tee leaving 290.
That is the owner's bug.

## 2. Before-table (real fixtures — partial reproduction, honestly labeled)

**`backend/tests/fixtures/bethpage_overpass.json` cannot reproduce the width cascade**: it
predates tree/woods fetching (`_parse_course_geometry_response` yields `woods: 0, trees: 0`), so
`extract_corridor_profile` returns `None` on every hole and the width rule never fires. Assembled
offline via `assemble_osm_course(geometry, ..., "Red")`, all 14 Red par-4/5s currently recommend
**driver** from that fixture (H1 467y→driver/leave 210, H2 386y→driver, H3 355y→driver,
H5 469y→driver, H6 287y→driver*, H8-H18 all driver) — i.e., the committed Overpass fixture is
blind to the production mechanism. Production PostGIS Red (what the owner played) has dense tree
rows → known widths → the cascade above.

**`backend/tests/fixtures/bethpage_red_trees.json`** (holes 1/5/6, geodesic ±5y ground truth)
reproduces the *machinery* partly:

| hole | par/yds | current club | why |
|---|---|---|---|
| Red 1 | 4 / 467 | driver (leave 210) | corridor: 31 samples, only ONE with known width (60y: 44) — sparse committed tree obs leave width unknown at driver's 259 landing → unknown-never-rejects accepts driver. Trees L 265-480 + R 385-475 all mapped as hazards. |
| Red 5 | 4 / 469 | driver (leave 210) | corridor `None` (right-side trees only → width needs both sides) |
| Red 6 | 4 / 287 | **5-iron (leave 100)** | **v1 bend-cap**: bend left@195 (dev 83y), moderate right trees at 195-310 → capped to land <190. Note: "Driver runs through the corner at ~195 into the trees — 5 Iron keeps you short of it, leaves about 100." |

So: real-fixture repro of the *width* rule is not possible offline today (fixture gap, stated
explicitly); the synthetic cascade table stands in and matches the diagnosed production
arithmetic exactly. **QA follow-up:** capture one production Red corridor dump (holes with dense
trees) into a committed fixture so the width path gets a real-geometry regression anchor.

## 3. The model (simple, monotone, explainable)

For each candidate club in the bag, descending by stored distance, skipping candidates whose
rounded conditions total exceeds the bend-cap ceiling (unchanged take-the-shorter composition):

```
total      = round(physics_drive_total(...))          # same call shape as today; competition_legal → stored number
leave      = max(0, to_green − total)
E_ap       = approach_expected_strokes(leave, hcp)    # NEW helper, see below
sample     = corridor_sample_at(corridor, total)
σ          = get_dispersion(club, hcp)["width_yards"] / 4     # width_yards = ±2σ spread
P_side     = 1 − Φ((width/2) / σ)   per side, via math.erf    # aim = midpoint of danger edges
E[club]    = E_ap + P_left·C(left_source) + P_right·C(right_source)
```

Pick the **minimum E; ties within 0.02 strokes go to the LONGER club**. Every choice states its
WHY from its own numbers.

Design decisions, precisely:

1. **Approach term** — `expected_strokes(leave, "fairway", handicap)` (`_FAIRWAY_TABLE` × handicap
   multiplier), **extended linearly beyond the table head (260y)** at the table's own terminal
   slope, 0.005 strokes/yd scratch (3.40→3.60 over 220→260). This extension is *required*:
   verified that the current clamp (flat 3.60 past 260) destroys monotonicity and makes an 8-iron
   "win" a water gauntlet because shorter clubs get free risk reduction at zero distance cost. New
   small helper `approach_expected_strokes(leave_yards, handicap)` in `strokes_gained.py` (module
   constant `_FAIRWAY_EXT_SLOPE = 0.005`).

2. **P(trouble)** — Gaussian lateral model, σ = width/4. **Aim assumption: the midpoint between
   the danger edges** (per-side clearance = `width_yards/2`), consistent with the landing advice
   the caddie already speaks ("favor the right half"); per-side tails computed separately so each
   side carries its own `left_source`/`right_source` cost. A side with an unknown edge contributes
   **0** (never penalize missing data — matches the existing unknown-never-rejects contract and
   [[no-fake-data-fallbacks]]). `sample is None` or `width_yards is None` → P = 0 both sides. Φ via
   stdlib `math.erf`: `phi(x) = 0.5*(1+math.erf(x/sqrt(2)))`. *Labeled modeling assumption:*
   lateral miss ~ N(0, σ²) about the aim; dispersion table is a TrackMan amateur reference, not
   measured for this player.

3. **E_penalty by severity tier** — `E[trouble] = E_ap(leave) + C(source)`:
   - `C("trees") = 0.7` — a punch-out ≈ 1 extra stroke minus the value of the ~70y it advances
     (`expected_strokes` fairway delta over 70y ≈ 0.35 scratch): 1 − 0.35 ≈ 0.65-0.7. *Modeling
     assumption, grounded on `_FAIRWAY_TABLE` deltas.*
   - `C("water") = 1.4` — stroke-and-distance/lateral drop: +1 penalty stroke + drop lie worse
     than fairway (`_ROUGH_TABLE` − `_FAIRWAY_TABLE` ≈ 0.2-0.3 at mid distances): ≈ 1.2-1.4; 1.4
     biases honestly away from water. *(OB would be ~2.0 but corridor sources are only
     "trees"/"water" today.)*
   - Unknown/other source → 0.7 (trees-level generic).
   - Constants are flat (not handicap-multiplied) — simplicity; noted as an assumption.

4. **Open/unknown-hole default falls out of the math** (verified numerically): width unknown →
   P=0 for every club → E strictly increases with leave → **driver, full stop**. Open 400y
   (width 80): driver P=0.033, E=3.52 vs 7-iron E=4.24 — driver by 0.7 strokes.

5. **Guardrail** — the extended-table math already produces it: laying back Δy costs ≈ 0.006·Δy
   strokes (hcp-15), so a 70y layback needs ΔP·C ≥ 0.43 — with trees (C=0.7) that needs ΔP ≥ 0.61,
   which the dispersion table cannot produce between adjacent-ish clubs (even a 10y-wide corridor
   gives driver-vs-7i ΔP ≈ 0.11). **Trees can never justify more than ~one club of layback;
   mid-iron requires provable high-probability water.** Backstop floor in code: candidates with
   `total < longest_club_total − 100` are excluded outright (never binds normal play; bend-cap
   ceiling is exempt — a different, through-the-corner mechanism). Tests pin both.

### Worked examples (verified numerically against the real tables/physics, hcp 15, default bag)

**Tight tree-lined 467y par-4 (width 40 everywhere — the exact profile that today yields
6-iron):**

| club | total | leave | E_ap | P | E |
|---|---|---|---|---|---|
| **driver** | 259 | 208 | 4.04 | 0.286 | **4.238 ← MIN** |
| 3wood | 243 | 224 | 4.17 | 0.218 | 4.325 |
| hybrid | 217 | 250 | 4.33 | 0.182 | 4.459 |
| 6iron | 175 | 292 | 4.59 | 0.096 | 4.654 |

Driver wins by 0.42 over today's pick. WHY: *"Driver leaves 208 with about a 29% tree risk —
laying back to 6-iron leaves 292 and still risks 10%; driver's the play."*

**Water pinch (wide 70y to 190, water width 28 from 200 on, 440y):** 5-iron (total 186, P=0.012,
E=4.373) genuinely beats driver (P=0.455 wet, E=4.451) — the honest layup case, and why the pick
rule is **strict min** (a "longest within 0.10" rule was tested and wrongly kept the 45%-wet
driver; ties only within 0.02 go long).

**Uniform water gauntlet 30y wide, 500y:** driver E=4.869 edges 3wood 4.872 — with danger
everywhere, shorter clubs still get wet 13-35% and surrender position; no layup exists, distance
keeps its value (DECADE-consistent). Only reached with the extended table; without it 8-iron
"wins" — the extension is load-bearing.

## 4. Composition & what the caddie says

- **v1 bend-cap stays as-is, as the pre-filter/ceiling** (aim_point.py ~870-901). Assessment: it
  models flying *through* a mapped corner — a straight ball leaves the centerline path, geometry
  the corridor cone (measured along the path) cannot see; Red 6 (bend dev 83y) capping to 5-iron
  on a 287y hole is defensible golf. It does not fold into the E-model in this slice. *Flagged
  follow-up:* if the owner reports over-lay-back on doglegs, fold it in via a straight-ray
  corridor sampler; not now.
- `_select_club_expected_strokes(...)` **replaces** `_select_club_fitting_corridor` (same
  signature shape + ceiling param; returns club, chosen sample, chosen P, best-rejected-longer-
  club + its P/leave for the note). Runs in the same `if hole.corridor:` block. `corridor=None` →
  block skipped → byte-identical v1 behavior (today's contract, kept).
- **`corridor_note` (the spoken WHY)** becomes the one-sentence tradeoff, numbers 1:1 with the
  payload:
  - No swap, known width: *"Driver leaves about 210 with roughly a 29% tree risk — nothing
    shorter beats that trade."*
  - Swap: *"5 Iron lays back short of the water pinch at 200 — about 1% wet versus 46% with
    Driver, leaves about 255."*
- **`TeeShotNumbers` fields**: keep `corridor_width_yards`; **add** (additive, defaulted `None`):
  `corridor_trouble_pct: Optional[int]` (chosen club), `corridor_alt_club: Optional[str]`,
  `corridor_alt_trouble_pct: Optional[int]`, `corridor_alt_leave_yards: Optional[int]`. **Retire**
  the pinch-shaped fields (`corridor_pinch_*`, `corridor_capped_from_*`,
  `corridor_club_window_yards`) — they narrate the hard-wall story; keep them present-but-None for
  cached-JSONB compatibility, or delete if no cached readers (grep shows only aim_point.py writes
  them). Verified: `tee_shot_numbers`/`corridor_*` do **not** appear in `frontend/src/lib/types.ts`
  or anywhere in `frontend/src` — **no frontend sync needed**; `backend/app/models.py` untouched
  (caddie shapes live in `app/caddie/types.py`).

## 5. Exact files to touch

1. `backend/app/caddie/strokes_gained.py` — add `approach_expected_strokes(leave_yards, handicap)`
   (+ `_FAIRWAY_EXT_SLOPE`); nothing else changes.
2. `backend/app/caddie/aim_point.py` — add `_phi`, `_trouble_probability(sample, club, handicap)
   -> tuple[float, float]`, `_PENALTY_COST = {"trees": 0.7, "water": 1.4}`,
   `_select_club_expected_strokes(...)`; replace the §4.4 block in `generate_recommendation`; new
   note wording; keep bend-cap block verbatim.
3. `backend/app/caddie/types.py` — `TeeShotNumbers` additive fields above.
4. Tests: rewrite `backend/tests/test_corridor_width_selection.py` (deliberate, justified — it
   pins the hard-wall behavior this P0 removes); new
   `backend/tests/test_tee_club_expected_strokes.py`.

## 6. Gates (the bar)

- **New unit suite** (`test_tee_club_expected_strokes.py`), pure/offline:
  - Synthetic open (w=80/unknown/`corridor=None`) 400-467y par-4 → **driver**, P≈0, note states
    leave + ~0% risk or is absent.
  - Tight trees w=40 @467y → **driver** (the before-table's 6-iron case) with E-ordering pinned.
  - Water pinch (70 short / 28 past 200) → layup club, both clubs' P in the payload, note numbers
    == payload numbers.
  - Guardrail: for every uniform tree corridor width 10-80, chosen club total ≥ driver_total − 40
    (trees never justify big layback); floor test (no club < longest−100 ever chosen absent
    bend-cap).
  - Monotone/extension tests on `approach_expected_strokes` (strictly increasing in leave;
    continuous at 260).
  - Real fixtures: `bethpage_red_trees.json` H1 → driver stays (unknown width at 259 never
    penalizes); H6 → 5-iron via bend-cap **unchanged**; assemble Red from `bethpage_overpass.json`
    → all 14 par-4/5 driver (corridor None path byte-identical).
  - Competition-legal: walk uses stored totals (assert same club chosen with
    `competition_legal=True` when weather=None).
- **Existing suites stay green or deliberately updated**: `test_corridor_bend_cap.py` (green,
  untouched), `test_aim_point.py`, `test_tee_shot_numbers.py`, `test_bethpage_validation.py`,
  `test_red1_acceptance.py` (Red 1 stays driver-favor-right), `test_positioning_shot.py`;
  `test_corridor_width_selection.py` rewritten with per-test justification (tests 3/5/6/7 —
  unknown-never-rejects, corridor-None byte-identity, reachable-branch-untouched, no-stale-note —
  carry over with the new selector; tests 1/2/4 re-pinned to E-model outcomes).
- **Par-3s never enter**: the selector lives inside the `not reachable` branch; add an explicit
  test that a 230y par-3 with a 250y driver stays on the reachable/distance-matched path with no
  `tee_shot_numbers`. (A genuinely unreachable 250y+ par-3 correctly gets positioning treatment —
  that's a feature.)
- **Bearing invariance**: the model adds no bearing-dependent input beyond the existing
  per-candidate `physics_drive_total` call — the bearing suites (`test_hazards.py`,
  `test_tree_hazards.py`, `test_slope_advice.py`) stay green untouched.

## 7. Risk / edge cases

- **Unknown corridor width** → P=0 → driver. Never lay back on missing data
  ([[no-fake-data-fallbacks]]).
- **Competition-legal** → totals are stored numbers (handled in the walk, as today).
- **Reachable/drivable holes** → selector never fires (outside the branch); Red 6 remains
  governed by bend-cap, not this model.
- **Very short par-4s** → either reachable, or bend-cap ceiling applies; floor exempts the
  ceiling.
- **Wind/elevation** → per-candidate totals move via `physics_drive_total`; leaves and P re-anchor
  automatically; `leave_plays_like_yards` untouched.
- **High handicaps** → wider σ raises P for all clubs; the flat C keeps ordering sane (at most ~1
  club shorter — intended).
- **Cached JSONB** → all new TeeShotNumbers fields defaulted `None`; older cached recommendations
  still validate.

## 8. DECISION_GROUNDING check

Verified: `DECISION_GROUNDING_RULE` (`voice_prompts.py:179-194`, imported by `strategy.py`'s
system prompt) already mandates *"the engine's recommendation IS the call — explain it, never
re-decide it"*, and no cautious/conservative framing exists in `personalities.py` or
`voice_prompts.py` that would stack conservatism on top. Two small adjustments: (a) the new
`corridor_trouble_pct` / alt-club numbers ride into the recommend payload so the brain can
*narrate* "about 29% tree risk — driver's still the play" instead of hedging without numbers;
(b) optional one-line addendum to `DECISION_GROUNDING_RULE`: *"An aggressive engine call on an
open hole is deliberate — never add caution the numbers don't show."* The `strategy.py`
driver-dispersion reference line (~345) already self-labels as reference-only; no change.
