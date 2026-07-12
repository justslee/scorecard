# Corridor-Width-Aware Tee Club Selection — Implementation Plan (backlog §4.4)

**Follow-up to corridor v1 (cycle 114 bend-cap).** Owner complaint: "driver doesn't
seem like the play at all and brings in the danger." Deliverable: recommend the longest
club whose dispersion-informed landing zone fits the effective corridor at its landing
distance; driver only when driver's zone genuinely fits. The shipped contract in
`specs/caddie-numbers-coherence-plan.md` §4.4 is honored, with one geometry correction
documented below (fairway edges must NOT be the fit constraint — arithmetic proof in the
Honesty section).

Plan authored on the `fable` model (owner directive: plan quality gates downstream).

---

## 1. Approach

Three layers, all additive:

1. **Geometry (`hazards.py`)** — new pure function
   `extract_corridor_profile(features, *, tee=None, green=None, polyline=None) -> Optional[list[CorridorSample]]`
   that samples perpendicular cross-sections along the `golf=hole` centerline every 10
   yards and records, per sample, per side: the fairway edge (from the fairway polygon)
   AND the danger edge (nearest trees/woods/water evidence). Computed once per hole in the
   `/course-intel` loop in `routes/caddie.py` (the same place `extract_hole_hazards`/
   `extract_hole_bend` already run — `course_intel.build_hole_intelligence` never sees the
   FeatureCollection, so the profile cannot live there), stored as a new
   additive+defaulted `HoleIntelligence.corridor` field, cached in session `hole_intel`
   JSONB like `bend`.

2. **Decision rule (`aim_point.py`)** — in the positioning branch of
   `generate_recommendation`, AFTER the v1 bend-cap block and BEFORE the `zone`/`miss`/
   `landing_advice` computation: if `hole.corridor` is present, walk the bag descending
   (the `_select_club_capped_at` pattern, same per-candidate `physics.shot_distance_for_club`
   call) with the current (possibly bend-capped) club's total as a **ceiling**, and pick
   the longest candidate whose fit window (±1.5σ, i.e.
   `0.75 × get_dispersion(club, handicap)["width_yards"]`) fits the **danger-to-danger**
   corridor width at that candidate's conditions total. Unknown width at a candidate's
   distance → candidate allowed (never reject on unknown). Profile `None` → the block never
   executes → v1 byte-identical.

3. **Payload + WHY** — additive `Optional` fields on `TeeShotNumbers` carrying the pinch
   width/distance and the club windows; `corridor_note` (existing P1 mechanism) speaks ONLY
   those payload numbers; `format_tee_numbers_line` gains an append-only corridor clause so
   the realtime mouth can re-derive under challenge (same coherence contract as cycle 114).

**Precedence: width selection runs alongside v1, take-the-shorter.** It does NOT replace
the bend-cap, for two reasons: (a) the bend-cap is a *longitudinal* rule (don't fly through
the corner) — a drive landing in a wide area past the corner passes a width-at-landing test
yet still flew over the tree wall; (b) the profile can be absent where `bend` is known, and
the no-regression guarantee requires v1 untouched. Composition: v1 block runs first exactly
as today; width selection then walks only candidates with `total <= current_total`
(ceiling), so it can only shorten further. Result is at least as safe by construction.

---

## 2. Geometry algorithm (precise)

New code in `backend/app/caddie/hazards.py`, reusing the module's existing primitives
(`_xy_m`, `_derive_tee_green`, `_hole_polyline`, `_project_onto_polyline`,
`_tree_observations`, `_YARDS_PER_METER`). No new geo library.

### Constants

```python
_CORRIDOR_SAMPLE_START_YDS = 60      # below the shortest club total (~85y stored)
_CORRIDOR_SAMPLE_STEP_YDS  = 10
_CORRIDOR_SAMPLE_MAX_YDS   = 360     # past any real drive total
_CORRIDOR_EVIDENCE_WINDOW_YDS = 20   # ±20y along-path, per §4.4 contract
_CORRIDOR_MAX_CAST_YDS     = 100     # perpendicular ray cap for fairway-edge cast
# reuse: _TREE_MIN_OBS (3), _TREE_MAX_LATERAL_YARDS (70)
```

### `extract_corridor_profile(features, *, tee=None, green=None, polyline=None)`

1. **Frame setup** — identical to `extract_hole_bend`: `_derive_tee_green` for tee/green;
   **no usable polyline (explicit arg or `featureType=="hole"` LineString) → return `None`**
   (honest unknown; a chord has no bends and no local headings — never fabricate a corridor
   from a chord). Project the path into the tee-anchored local metre frame with `_xy_m`;
   compute `tee_along_m = _project_onto_polyline(path_xy, 0, 0)[0]` (degenerate polyline →
   `None`).

2. **Sample points** — precompute cumulative segment lengths. For each `d` in
   `range(60, min(path_len_from_tee_yds, 360)+1, 10)`: arc position
   `s_m = tee_along_m + d / _YARDS_PER_METER`; find the containing segment (skip zero-length
   segments); sample point `p = a + t·(b−a)`; local heading `u = (b−a)/|b−a|`; **left normal
   `n = (−uy, ux)`** — consistent with the module's pinned positive-lateral-is-LEFT cross
   convention (`lateral = ux·dy − uy·dx`).

3. **Fairway edges per side** — collect all `featureType == "fairway"` features; for each,
   outer ring(s): `geometry.type == "Polygon"` → `coordinates[0]`; `MultiPolygon` → each
   member's `[0]` ring (treat each as an independent polygon). Dedupe the closing vertex;
   project all vertices into the same local frame. For sample `p`:
   - Containment test: even-odd ray-cast **in the local xy frame** (a small
     `_point_in_ring_xy(px, py, ring_xy)` mirroring `course_spatial._point_in_ring`'s
     algorithm — that function works in lon/lat+cos_lat, so it is re-derived, not imported).
   - If `p` is inside a fairway ring: cast the two rays `p + t·n` (left) and `p − t·n`
     (right), `t ∈ (0, _CORRIDOR_MAX_CAST_YDS/1.09361]`. For each ring segment `(a, b)`
     solve `p + t·n = a + s·(b−a)` (2×2 linear solve; denominator `cross(n, b−a)`; accept
     `0 ≤ s < 1`, `t > 0`). `left_fairway_yds = min t × 1.09361`, same for right. Multiple/
     split fairway polygons: use the polygon that contains `p` (a split fairway's gap
     naturally yields "not inside any").
   - If `p` is inside **no** fairway polygon → fairway edges are `None` at this distance
     (rough crossing between split fairways, or unmapped) — never fabricated.

4. **Danger edges per side** — the fit-rule constraint (see Honesty section for why fairway
   edges are NOT it):
   - **Trees/woods**: reuse `_tree_observations(feature_list)` and classify each observation
     with the exact same project-onto-polyline math as `extract_hole_hazards`' `_classify`
     closure (carry = along-path − `tee_along_m`; lateral sign per segment cross). Drop
     behind-tee and `|lateral| > _TREE_MAX_LATERAL_YARDS`. For sample `d`: window =
     observations with `|carry_yds − d| ≤ 20`. **Coverage guard: a side's tree edge is known
     only when ≥ `_TREE_MIN_OBS` (3) observations fall in the window on that side** (same
     discipline as the spoken tree hazards: a woods polygon's ring easily supplies 3; 1–2
     stray volunteer points stay silent). Side assignment uses the RAW lateral sign (no 10y
     deadband — the deadband is a speech de-jitter, not geometry; `lateral == 0` counts
     toward both sides). Tree edge = `min |lateral|` in the qualifying window.
   - **Water**: new sibling `_water_observations` — outer-ring vertices of
     `featureType == "water"` polygons (plus Points if any), same dedupe. Min-obs **1**
     (water polygons are deliberately mapped; a single in-window ring vertex is the traced
     pond edge), same 70y lateral cap and ±20y window.
   - `left_danger_yds = min(tree_edge_left, water_edge_left)` over whichever exist; `None`
     when neither. Record `left_source`/`right_source` ∈ `{"trees","water"}` for the winning
     evidence.

5. **Sample emission** — `width_yards = round(left_danger + right_danger)` when BOTH sides
   known, else `None`. Emit `CorridorSample(distance_yards=d, left_yards, right_yards,
   left_fairway_yards, right_fairway_yards, width_yards, left_source, right_source)` (edges
   rounded to int yards).

6. **All-or-nothing gate** — return `None` unless **at least one sample has `width_yards`
   not None**. A fairway-only profile (no danger evidence anywhere) cannot constrain the fit
   rule, so it is treated as absent — this keeps "profile present ⇔ the decision may differ"
   crisp and the regression test well-defined. Within a returned profile, per-distance
   `None` samples are the partial-knowledge representation.

### Consumer lookup (in `aim_point.py` or exported from `hazards.py`)

`corridor_sample_at(corridor, d)`: nearest sample by `|sample.distance_yards − d|`; return
`None` if the nearest is more than 5y away (i.e. `d` is outside the sampled range). No
interpolation — the ±20y evidence window already smooths.

---

## 3. Honesty assessment + recommended scope (read this before building)

**Fairway polygons are NOT rare.** The repo's real-course snapshot
(`backend/tests/fixtures/bethpage_overpass.json`) contains **99 `golf=fairway` polygons for
90 holes** — effectively complete coverage of the owner's home facility, and
`osm_ingest.assemble_osm_course` spatially joins them into each stored hole's
FeatureCollection today (`featureType: "fairway"`, corridor cap 200m). Computing fairway
cross-sections is real, not pseudo-precision.

**BUT fairway edges must not be the fit constraint — that would be wrong golf, provably.**
`get_dispersion` widths are the ±2σ spread (scratch driver 42y ⇒ σ≈10.5y, matching real
amateur data; 15-hcp driver 75y ⇒ σ≈18.75y). The §4.4 fit window is ±1.5σ = 0.75 ×
`width_yards`: 15-hcp driver needs **56y**, hybrid 45y, mid-iron 36y, short-iron 30y. A
typical fairway is 30–40y wide — under a fairway-edge rule a 15-handicap would be capped to
an 8-iron on essentially every tee, and even a scratch driver (31.5y) would rarely "fit".
Missing fairway into open rough is normal golf; the owner's complaint is about **danger**.
The corridor of consequence is danger-to-danger (tree line to tree line, water to trees),
exactly what §4.4's shipped contract specifies. **Therefore: the fit rule uses danger edges
only; fairway edges are stored in the profile as grounded color (and future UI use), never
the constraint.** The brief's "take the tighter of fairway-edge vs tree-edge" is amended on
this evidence — taking the tighter would make the fairway edge always win and reproduce the
8-iron-everywhere absurdity.

**Danger-evidence coverage is the real uncertainty — be blunt.** The Bethpage fixture
contains **zero** `natural=wood`/`natural=tree` features (only 50 `natural=water`, mostly
other holes' features, plus 2 golf water hazards). That snapshot predates the woods/tree
Overpass query terms added in the trees cycle (`osm.py` now fetches `natural=wood`,
`landuse=forest`, `natural=scrub`, closed `tree_row`, `natural=tree`), and cycle 114's
backlog note says trees ARE in prod drive-zone evidence ("verified") — but this repo cannot
prove prod woods coverage per hole. Consequences and recommendation:
- Build the danger-edge profile as specified — it is honest at every coverage level: no
  woods data → profile `None` → v1 byte-identical; partial data → per-distance honesty; and
  it activates automatically as ingest data improves. Water-hole pinches work today.
- **Builder verification step (read-only, staging, in the PR description like §4.3's par
  check):** count `featureType in ("woods","tree","fairway")` per Bethpage Red hole in the
  stored course rows. If woods are absent in prod, say so in the PR and file a Bethpage
  re-ingest follow-up (the Overpass query already asks for them) — do NOT widen the rule to
  fairway edges to force the feature to "do something".
- Realistic ceiling statement for the plan record: on holes with no mapped woods/water near
  the landing zone, v1 bend-cap + miss-side honesty remains the ceiling, and that is correct
  behavior, not a gap.

---

## 4. Files to touch (exact paths)

| File | Change |
|---|---|
| `backend/app/caddie/hazards.py` | `extract_corridor_profile`, `_water_observations`, `_point_in_ring_xy`, ray-cast helper, constants, `corridor_sample_at` |
| `backend/app/caddie/types.py` | `CorridorSample` model; `HoleIntelligence.corridor: Optional[list[CorridorSample]] = None`; 6 new `Optional` fields on `TeeShotNumbers` |
| `backend/app/caddie/aim_point.py` | `_club_fit_window_yds`, `_select_club_fitting_corridor`, integration block in the positioning branch, width `corridor_note` template |
| `backend/app/caddie/voice_prompts.py` | append-only corridor clause in `format_tee_numbers_line` |
| `backend/app/routes/caddie.py` | `/course-intel` loop: `intel.corridor = extract_corridor_profile(stored_features, tee=…, green=…)` inside the existing `if stored_features` block (~line 1292); rider: `RecommendationRequest.yards → Optional[int] = None` + honest-error ladder in `get_recommendation` (~line 1348) |
| `frontend/src/lib/caddie/types.ts` | mirror `corridor` on `HoleIntelligence` + new `tee_shot_numbers` fields (CaddiePanel round-trips intel back into `/caddie/recommend`, so the shape must be declared) |
| `frontend/src/lib/caddie/api.ts` | drop `yards: params.yards || 400` → pass `params.yards` through (line 123) |
| Tests | see §9 |

No change to `dispersion.py` (consumed as-is), `physics.py`, `club_selection.py`,
`course_intel.py`, or the reachable branch of `generate_recommendation`.

---

## 5. Data-model changes (additive / defaulted — cache-safe)

```python
class CorridorSample(BaseModel):
    """One perpendicular cross-section of the playing corridor, sampled along
    the hole's mapped centerline (hazards.extract_corridor_profile). Additive
    on HoleIntelligence, defaulted, so cached session hole_intel JSONB
    predating this field still validates. None-valued sides/widths are honest
    unknowns — the consumer must never reject a club on an unknown width."""
    distance_yards: int                      # tee-anchored along-path (multiple of 10)
    left_yards: Optional[int] = None         # centerline -> nearest LEFT danger edge (trees/water)
    right_yards: Optional[int] = None
    width_yards: Optional[int] = None        # left+right; None unless BOTH sides known
    left_fairway_yards: Optional[int] = None # fairway-edge cross-section (color, never the fit constraint)
    right_fairway_yards: Optional[int] = None
    left_source: Optional[str] = None        # "trees" | "water" (winning evidence)
    right_source: Optional[str] = None

# HoleIntelligence — additive, follows the `bend` precedent exactly:
corridor: Optional[list[CorridorSample]] = None   # None = unmapped/uncomputable (v1 behavior)
```

`TeeShotNumbers` additions (all `Optional[...] = None`; populated ONLY on profile-present
turns — this is what makes the no-regression test well-defined):

```python
corridor_pinch_width_yards: Optional[int] = None    # danger width at the pinch that rejected the longest club
corridor_pinch_distance_yards: Optional[int] = None # along-path distance of that pinch (== rejected club's total's sample)
corridor_capped_from_club: Optional[str] = None     # rejected longest club key ("driver")
corridor_capped_from_window_yards: Optional[int] = None  # its ±1.5σ window (rounded)
corridor_club_window_yards: Optional[int] = None    # CHOSEN club's ±1.5σ window
corridor_width_yards: Optional[int] = None          # danger width at the CHOSEN club's landing distance, when known (§4.4's named field)
```

(`corner_distance_yards` from the §4.4 sketch is intentionally NOT populated on
profile-absent bend-cap turns — populating it there would break byte-identical v1 payloads;
the bend distance already lives in `HoleIntelligence.bend` and the v1 note.)

Serialization: `session.py` round-trips `hole_intel` via `model_dump()` /
`HoleIntelligence(**v)` (lines 78–96, 287) — nested model lists already work (`hazards`);
defaulted `None` validates old blobs; pydantic v2 ignores unknown keys if an old process
reads a new blob.

---

## 6. Decision rule + margin

**Fit window**: `width_yards` from `get_dispersion(club, handicap)` is the ±2σ lateral
spread (σ = width/4 — scratch driver 42y ⇒ σ 10.5y, consistent with measured amateur data).
Per §4.4's contract the landing window is ±1.5σ:

```python
def _club_fit_window_yds(club: str, handicap: float) -> float:
    return 0.75 * get_dispersion(club, handicap)["width_yards"]   # 2 × 1.5σ where width = 4σ
```

Justification: demanding the full ±2σ (95%) cone would bench driver on virtually every
tree-lined hole (15-hcp cone = 75y — wider than most danger corridors) — pseudo-safety;
±1.5σ (~87% of shots inside) is the contract's calibrated line between "driver only when it
genuinely fits" and over-clubbing-down everywhere. **Default when stats absent**: `handicap`
already defaults to 15.0 through the whole call chain and `get_dispersion(None) → 15.0` — no
new default invented. Sanity anchors (15 hcp): driver needs 56y, 3-wood 49y, hybrid 45y,
long-iron 42y, mid-iron 36y.

**Selection walk** (mirrors `_select_club_capped_at`; same physics call per candidate):

```python
def _select_club_fitting_corridor(clubs, corridor, handicap, weather, shot_bearing,
                                  elevation_change_ft, competition_legal,
                                  ceiling_total_yards) -> Optional[CorridorFit]:
    # bag descending; per candidate: total = stored (competition_legal) or
    # physics.shot_distance_for_club(...).total_yards  — EXACT _select_club_capped_at shape
    # skip candidates with total > ceiling_total_yards          (never undo the bend cap)
    # sample = corridor_sample_at(corridor, round(total))
    # sample is None or sample.width_yards is None  -> ACCEPT    (unknown never rejects)
    # _club_fit_window_yds(candidate, handicap) <= sample.width_yards -> ACCEPT
    # else record the FIRST rejection (longest rejected club + its total + sample) and continue
    # returns (club, dist, first_rejection|None); None when nothing fits (caller keeps current club)
```

**Integration** (positioning branch, immediately after the v1 bend-cap block, before
`leave_yards = tee_shot_numbers.leave_yards` so `zone`/`miss`/`landing_advice`/`aim`
downstream see the final club — same ordering trick v1 relies on):

```python
if hole.corridor:
    fit = _select_club_fitting_corridor(clubs, hole.corridor, handicap, weather, shot_bearing,
                                        hole.elevation_change_ft, competition_legal,
                                        ceiling_total_yards=tee_shot_numbers.drive_total_yards)
    if fit is not None:
        if fit.club != club:
            club, club_dist = fit.club, fit.dist
            tee_shot_numbers = compute_tee_shot_numbers(...)     # fresh physics, as v1 does on cap
            corridor_note = <width template, §7>                  # width note wins (it caused the final club)
        # populate the corridor_* payload fields from fit (pinch + windows + width-at-chosen) —
        # also on the no-change path when width at the chosen club's distance is known (grounding)
```

Rules pinned:
- Ceiling = the current (post-bend-cap) club's `drive_total_yards` ⇒ bend-cap is never
  relaxed; final result ≤ both caps (take-the-shorter).
- `fit is None` (no club in the bag fits anywhere) → keep the current club and note — same
  "no club helps, don't fabricate a cap" philosophy as `_select_club_capped_at` returning
  `None`; v1's both-sides miss/landing honesty already covers the speech.
- `hole.corridor` falsy (None or `[]`) → block skipped entirely → **byte-identical v1**
  (club, reasoning, note, leave; payload identical except the new keys, which are `None`).
- Reachable branch: untouched — the block lives inside the existing `else:` (not-reachable)
  arm only.
- Parity: every candidate total goes through the same `physics.shot_distance_for_club` call
  shape as `physics_drive_total`/the `get_shot_distance` tool; the final club's
  `TeeShotNumbers` is recomputed through `compute_tee_shot_numbers`, so the closing invariant
  `to_green − drive_total == leave_exact` holds by construction.

---

## 7. Payload / WHY extension

**P1 reasoning line (`corridor_note`) when the width cap changed the club** — every number
token maps 1:1 to a `TeeShotNumbers` field:

```
f"{old_display}'s shot zone needs ~{n.corridor_capped_from_window_yards} yards but the "
f"{pinch_word} pinches the corridor to ~{n.corridor_pinch_width_yards} at "
f"{n.corridor_pinch_distance_yards} — {new_display}'s ~{n.corridor_club_window_yards}-yard "
f"zone fits at {n.drive_total_yards}, leaves about {n.leave_yards}."
```

`pinch_word`: `"tree lines"` when both winning sources at the pinch sample are `"trees"`,
`"water"` when both are water, else `"trouble"` — feature words justified by the hazard/
corridor data in the same payload, numbers strictly from `TeeShotNumbers`. `old_display`/
`new_display` via `CLUB_DISPLAY_NAMES` (same as v1). If BOTH v1 and the width cap fired, the
width note replaces the v1 note (it explains the final club); if only v1 fired, the v1 note
is untouched (byte-identical requirement).

**`format_tee_numbers_line` (voice_prompts.py)** — append-only clause so the realtime mouth
can re-derive on challenge, never invent:

```
if n.corridor_pinch_width_yards is not None:
    "... Corridor: pinches to ~{pinch_width} at {pinch_distance}; "
    "{capped_from_display}'s zone needs ~{capped_from_window}, "
    "{club_display}'s ~{club_window} fits."
```

Existing sentence unchanged when the fields are `None` (pinned by test). `NUMBERS_COHERENCE_RULE`
already mandates block-only yardages — no prompt-rule change needed; the new numbers ride
inside the block.

---

## 8. Rider — kill the hardcoded 400

`backend/app/routes/caddie.py`:
- `RecommendationRequest.yards: int = 400` → `yards: Optional[int] = None` (**Optional +
  honest error, NOT required** — a required field would 422 legitimate callers that send
  only `distance_yards`; Optional mirrors `SessionRecommendRequest`/`recommend_payload`
  exactly).
- `get_recommendation`: replace `distance = request.distance_yards or request.yards` with
  the explicit is-None ladder (`distance_yards` → `yards` → `request.hole_intelligence.yards`
  when provided), then `if distance is None: raise HTTPException(400, "No distance known for
  this hole — send distance_yards or yards.")`. The `HoleIntelligence(...)` fallback
  constructor already accepts `yards=None`.

`frontend/src/lib/caddie/api.ts` line 123: `yards: params.yards || 400` → `yards:
params.yards` (undefined omitted from JSON). **Caller verification (done)**:
`CaddiePanel.getRecommendation` (line ~305) sends `yards: hole.yards` and `distance_yards:
distanceToPin`; `CaddieSheet` tap path prefers `/session/recommend` and only falls back with
real yards — no caller depends on the 400. Note for the builder: `CaddiePanel` line 113 has
its own display-side `?? 400` fallback in the `hole` object — out of scope here
(display-coupled), flag it in the PR as a residual honesty item rather than silently
changing round display.

---

## 9. Test matrix (pure, deterministic, no DB)

**A. `backend/tests/test_corridor_profile.py` (new — geometry, mirrors `test_hazards.py`
synthetic style):**
1. Straight-east hole (LineString), 40y-wide rectangular fairway, woods polygon left edge at
   25y off centerline spanning 240–320y, ≥3 tree points right at ~26y around 270y → sample
   at 270: `left_yards≈25`, `right_yards≈26`, `width_yards≈51`, fairway edges ≈20/20, sources
   "trees".
2. Same hole, sample at 100 (no danger evidence in window) → `width_yards is None` at that
   sample; profile still returned (some samples known).
3. No `hole` LineString → `extract_corridor_profile(...) is None`.
4. Fairway-only (zero danger evidence anywhere) → `None` (the all-or-nothing gate).
5. 1–2 stray tree points in window (below `_TREE_MIN_OBS`) → that side `None` (coverage
   guard); a water polygon with 1 in-window ring vertex DOES set the edge.
6. L-shaped dogleg polyline, woods on the outside of the corner → post-corner sample's
   perpendicular uses the SECOND leg's heading (assert the width there, not the chord frame's)
   — the sign/frame discipline this module has been burned on twice.
7. Split fairway with a gap → sample in the gap has fairway edges `None`, danger edges still
   computed.

**B. `backend/tests/test_corridor_width_selection.py` (new — engine, mirrors
`test_corridor_bend_cap.py` fixture style):**
1. **Straight WIDE hole**: profile width 80y across 200–300y, 15-hcp bag (driver window
   56.25 ≤ 80) → `club == "driver"`; numbers close exactly.
2. **Pinching hole (Red-3-like)**: `_BEND` corner @226 + trees both sides (v1 inputs) PLUS a
   profile pinching to ~30y at 270+ and ~55y at ≤220 → final club respects BOTH caps
   (`drive_total_yards <= 221`), correct leave (`to_green − drive_total == leave_exact`), and
   the WHY: extract every integer from `corridor_note` and assert each ∈ {payload field
   values} (the numbers-only-from-payload guard).
3. **Unknown never rejects**: width `None` at driver's total, narrow at shorter distances →
   driver stays.
4. **No club fits** (width 5y everywhere) → club unchanged, no width note, no fabricated cap.
5. **Regression guard (byte-identical v1)**: run the exact `test_corridor_bend_cap.py` Red-3
   fixture with `corridor=None` → identical `club`, `reasoning` list, `leave_yards`,
   `corridor_note` text vs pre-change expectation, AND every new `TeeShotNumbers` corridor
   field is `None`. Also: the existing `test_corridor_bend_cap.py` must pass **unmodified**.
6. Reachable-branch guard: a reachable fixture with a corridor present →
   `tee_shot_numbers is None`, approach output unchanged.

**C. `backend/tests/test_recommend_tap_path.py` (new — rider):** construct
`RecommendationRequest` with no `yards`/`distance_yards`/intel-yards → handler raises
HTTPException 400 (call the coroutine directly, as `test_course_intel_resilience.py` does);
with `yards=466` only → solves 466 (never 400); with `distance_yards` only → unaffected.

**D. Extend `backend/tests/test_tee_shot_numbers.py`:** `format_tee_numbers_line` with
corridor fields set → clause appended with exactly those numbers; with fields `None` →
output byte-identical to today's string.

**E. Frontend:** no behavior test needed beyond existing suites; `api.ts` change is covered
by tsc + existing CaddieSheet/Panel tests (they mock `fetchRecommendation`).

---

## 10. Gates & shared-type sync

- `cd backend && ruff check .`
- `cd backend && python -m pytest tests` (pure unit tests run locally; DB-integration lives
  in `tests/integration` and runs in CI — do NOT stand up local Postgres)
- `CaddieRecommendation`/`TeeShotNumbers` do **not** live in `backend/app/models.py` /
  `frontend/src/lib/types.ts` (grep-verified; same verdict recorded in the §5 shared-shape
  note of the cycle-114 spec). The mirror is `frontend/src/lib/caddie/types.ts` — add the
  optional `corridor` array on `HoleIntelligence` and the six optional `tee_shot_numbers`
  fields there.
- Frontend is touched (`api.ts`, `types.ts`) → run `cd frontend && npm run lint && npx tsc
  --noEmit`, vitest, and the voice smoke `npx tsx voice-tests/runner.ts --smoke` (shapes
  feed the voice grounding fixtures).

---

## 11. Risks / edge cases

- **The fairway-as-constraint trap** (§3) — the single biggest way to ship a wrong geometry
  fix; the plan's fit rule is danger-edge only, on arithmetic evidence. Do not "simplify"
  back.
- **MultiPolygon / multiple fairways**: handled per-polygon; containment picks the polygon
  under the sample; gaps → honest `None`.
- **Missing centerline / degenerate polyline**: `None` profile (never a chord-frame
  corridor); zero-length segments skipped as in `_project_onto_polyline`.
- **Reversed `golf=hole` way**: same documented exposure as hazards/bend (sides mirror
  consistently); guarded by the ingest "GROSS REVERSED" yardage validation — no new risk
  surface, note it in the module docstring.
- **Cached-blob validation**: `corridor` defaulted `None` (old blobs validate); new fields
  on `TeeShotNumbers` defaulted (old `last_recommendation` blobs validate); pydantic ignores
  extra keys if old code reads a new blob.
- **No-regression proof**: structural — the new block is gated on `hole.corridor`
  truthiness; profile-absent turns execute exactly the pre-change code path; the only payload
  difference is new always-`None` keys (pinned by test B5).
- **Both-sides evidence requirement**: one-sided tree lines never constrain width (per
  contract) — the existing `compute_positioning_miss_side`/`decade_landing_advice` already
  speak the one-sided danger; no double-speak.
- **Performance**: ~30 samples × ring segments per hole, once per `/course-intel` —
  negligible; pure math, no I/O.
- **Sample range**: drive totals beyond 360y or short holes → lookup returns `None` →
  allowed (honest).
- **Voice coherence**: the width note and the `format_tee_numbers_line` clause share the
  same payload fields — challenged numbers re-derive, never invent (NUMBERS_COHERENCE_RULE
  unchanged).
