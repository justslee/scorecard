# Plan: Caddie shot-context reachability — positioning shots stop aiming at the flag

> Source: owner feedback 2026-07-06 (screenshot, ~400y par 4, blue tees). Plan authored by
> the Plan agent on the `fable` model. This is the build contract for the builder.

## 0. The bug, verified in code

Owner incident: on a ~400y par 4 (blue tees), asked "What club should I hit?", the caddie said
*"Driver's the call. Aim about 9 yards left of the flag to stay away from those right-side trees."*
The green is unreachable off the tee, so any pin-relative aim is wrong golf reasoning.

Root cause, confirmed exactly:

- `backend/app/caddie/aim_point.py::generate_recommendation` (the main entry, line 247) calls
  `compute_aim_point(hole, player_stats, handicap)` **unconditionally at line 294**.
  `compute_aim_point` (line 103) knows only the pin traffic light — every branch produces
  flag-relative text ("Aim at the flag", "between the pin and center", "center of green").
- Line 289 `is_tee_shot = hole.yards is not None and distance_yards >= hole.yards * 0.85` exists
  but only flips the `select_club` bias (`moderate` vs `conservative`, lines 290-291). It never
  changes the target.
- The literal sentence from the screenshot — "aiming ~9y left of the flag … trees guards the
  right" — is `decade_aim_advice` (`backend/app/caddie/decade_advice.py:326`, wired at
  `aim_point.py:366`), which optimizes lateral offsets **around the pin** using green-frame
  half-planes (`side` + `distance_from_green`). On a 400y tee shot that frame is meaningless.
- `compute_miss_side` (line 136) likewise only looks at hazards with `distance_from_green <= 20`
  — green-side hazards — on every shot.
- No reachability concept exists anywhere (`grep positioning/shot_kind` → zero hits in backend).
- The LLM then parrots it: `tools.py::recommend_payload` returns `rec.model_dump()`;
  `voice_prompts.py:183-188` and `routes/caddie.py:755-760` put `aim: {rec.aim_point.description}`
  into the prompt; no prompt rule forbids pin-relative talk on an unreachable shot.

Everything below is backend-caddie; one optional-field mirror in `frontend/src/lib/caddie/types.ts`.

---

## 1. Reachability classification

**Location:** `backend/app/caddie/aim_point.py`, new module-level constants + one pure helper,
called from `generate_recommendation` right after club selection (after current line 291, where
`adjusted_yards` and `clubs` are both in scope).

```python
# Distance-to-green is (nearly always) to the CENTER of the green; a ball
# finishing on the front edge has still reached it. Half a typical green
# depth; overridden by the hole's real measured depth when mapped.
GREEN_REACH_MARGIN_YDS: int = 15

def is_green_reachable(
    adjusted_yards: int,
    clubs: dict[str, int],
    green_depth_yards: float | None = None,
) -> bool:
    distances = clubs or DEFAULT_CLUB_DISTANCES
    max_reach = max(distances.values())
    margin = (green_depth_yards / 2.0) if green_depth_yards else GREEN_REACH_MARGIN_YDS
    return max_reach + margin >= adjusted_yards
```

Call as `reachable = is_green_reachable(adjusted_yards, clubs, hole.green_depth_yards)`.

**Why this exact threshold — spelled out:**

- **"Best club carry" = the max stored bag number, compared against `adjusted_yards`, NOT a
  second physics solve.** `adjusted_yards` is already the physics plays-like from
  `compute_adjustments` (`club_selection.py:137`, one combined `physics_plays_like` solve of
  wind + elevation + temp + altitude + firmness, anchored to this player's bag). Plays-like is
  defined in *stored-club-number space* — `plays_like = target × stored/achieved`
  (`physics.py:566-610`, total basis for woods, carry basis for irons) — i.e. "the still-air
  stored number you'd need". So `max(stored) >= adjusted_yards` is exactly the question "does ANY
  club in the bag fit this shot", the same comparison `select_club` already makes. Wind and
  elevation move `adjusted_yards`, so they move the reachability verdict with zero extra
  machinery, and `get_shot_distance` / `get_recommendation` can never disagree about it within a
  turn (the invariant `club_selection.py`'s docstring pins).
- Bag fallback is `DEFAULT_CLUB_DISTANCES` (`club_selection.py:20`, driver 250) — the same
  fallback `select_club` has always used; never a fabricated number.
- Margin = front-edge allowance: `hole.green_depth_yards / 2` when the green is mapped
  (`HoleIntelligence.green_depth_yards`, `types.py:130`), else 15y. Reachable → **today's flag
  path runs byte-identically** (no regression on par 3s, drivable par 4s, all approaches — every
  existing test uses 150y and stays on this path). Not reachable → positioning path.

Worked checks: 400y hole / 250 driver → 250+15 < 400 → positioning (leave 150). Drivable 280y
par 4 / 290 driver → reachable. 265y / 250 driver → 265 ≤ 265 → reachable (going for it; a miss
is a chip). 270y / 250 driver → positioning, "leaves about 20". Par-5 second shot from 270 with
230 max → positioning again; from 240 → 230+15 ≥ 240 → reachable → flag path. DECADE-correct at
every boundary.

**Leave math — spelled out:**

```python
expected_advance = club_dist          # the selected club's stored distance (line 291)
leave_yards = round(max(0, adjusted_yards - club_dist) / 5) * 5   # nearest 5, voice-calm
```

Identity making this honest under conditions: `adjusted_yards − stored ≈ raw_distance −
achieved_total_under_conditions` (from the plays-like definition above), so `leave = what the
drive actually leaves on the ground, expressed as a plays-like approach number` — the number the
player's next club choice wants. Still air: 400 − 250 = 150 → "leaves about 150 in". Owner's own
example (300y carry on 400) → 100. Only ever computed from `distance_yards`, a required argument
of `generate_recommendation` — the engine can structurally never fabricate a leave for an unknown
distance (see §5).

## 2. Positioning-shot advice (out-of-reach path)

### 2a. `decade_landing_advice` — the landing-zone DECADE engine
**New function in `backend/app/caddie/decade_advice.py`** (sits beside `decade_aim_advice`,
reuses `optimize_aim`, `Dispersion`, `LandingArea`, `dispersion_for_handicap`, `_hazard_to_area`,
`_friendly_hazard_name`, `_SEVERITY_ORDER`, `_CANDIDATE_OFFSETS_YDS`, `AIM_THRESHOLD_YDS`):

```python
# Driving-zone window around the expected advance: ~±2-3 σ_long of an
# amateur full shot plus roll variance. A hazard outside it isn't in play
# on THIS swing.
DRIVE_ZONE_SHORT_YDS: float = 50.0   # window behind the landing point
DRIVE_ZONE_LONG_YDS: float = 30.0    # window past it
_FAIRWAY_HALF_WIDTH_YDS: float = 16.0  # hazards.py's 10y deadband + fairway shoulder

def drive_zone_hazards(hazards: list[Hazard], expected_advance_yds: float) -> list[Hazard]:
    """Hazards in play at THIS shot's distance — carry_yards frame (the
    tee-anchored along-played-line number hazards.py computed), never
    distance_from_green. carry_yards <= 0 entries (green-frame-only /
    degenerate) are excluded, not guessed at."""
    return [
        h for h in hazards
        if h.carry_yards > 0
        and expected_advance_yds - DRIVE_ZONE_SHORT_YDS
            <= h.carry_yards <= expected_advance_yds + DRIVE_ZONE_LONG_YDS
    ]

def decade_landing_advice(
    hazards: list[Hazard],
    expected_advance_yds: float,
    leave_yds: float,
    handicap: Optional[float] = None,
) -> Optional[str]: ...
```

Mechanics (all reuse, no parallel optimizer):
1. `zone = drive_zone_hazards(...)`; empty → `None` (silent, like `decade_aim_advice`).
2. Build a **landing-frame** classifier (small private `_build_landing_classify(zone,
   expected_advance_yds)` — `build_classify_point`'s green-at-origin default is wrong here, so
   this is a sibling ~15-line builder, not a fork of the optimizer): origin = the landing target
   on the hole line at `expected_advance` (the carry_yards frame IS the played polyline/bend line
   from `hazards.py::_project_onto_polyline`, so "along the hole line" comes for free).
   Left/right hazards (by `line_side`) → half-planes at `|x| > _FAIRWAY_HALF_WIDTH_YDS` with
   `_hazard_to_area` areas, severity-ordered; center hazards → a band `|x| <=
   _FAIRWAY_HALF_WIDTH_YDS`, `|y − (carry − advance)| <= 15`; default `FAIRWAY` within the
   half-width, `ROUGH` outside. Document the half-plane simplification exactly as
   `decade_advice.py`'s module docstring already does for the pin frame.
3. `optimize_aim(candidates, dispersion, classify, pin=(0.0, leave_yds))` with `candidates =
   [(dx, 0.0) for dx in _CANDIDATE_OFFSETS_YDS]` and `dispersion =
   dispersion_for_handicap(handicap, expected_advance_yds)` (or the fixed fractions when
   `handicap is None`, mirroring `decade_aim_advice`). Putting the pin at `(0, leave)` makes
   `expected_strokes_from` price a layup correctly out of the box (fairway-at-150 vs
   rough-at-150 vs water+drop).
4. Offset `< AIM_THRESHOLD_YDS` → `"Middle of the fairway is the play"`-class `None`/neutral;
   otherwise return e.g. `"Favor the right half of the fairway — water at ~240 on the left."`
   (via `_friendly_hazard_name` + the worst in-zone hazard on the danger side). **The words
   "flag" and "pin" must be unreachable from this function.**
5. Additionally expose `cross_hazard_line(zone, expected_advance)`: any `line_side == "center"`
   severe/death hazard with carry within `[advance − 15, advance + 25]` → `"Water crosses at
   ~240 — driver brings it in play."` (advisory only; club change stays out of scope, matching
   the repo's additive-advice tradition).

### 2b. `compute_positioning_miss_side` — in `aim_point.py`
Sibling of `compute_miss_side`, but over `drive_zone_hazards` grouped by `line_side` with the
same `severity_score` idiom (reuse the `{"mild":1,...,"death":5}` map): preferred = the cheaper
lateral side, `avoid = f"Don't miss {worst_side} — {hazard types}"`. No in-zone hazards →
`MissSide(preferred="short", description="No mapped trouble in the driving zone — worst case is a
longer approach", avoid="Don't chase distance you don't need")` — generic, nothing fabricated.

### 2c. The positioning `AimPoint`
`compute_positioning_aim(...)` in `aim_point.py` composes the description shown in CaddiePanel and
spoken via the "Last recommendation" prompt lines:

> `"Positioning shot — green's out of reach. {side_phrase}; leaves about {leave} in."`

where `side_phrase` = the landing-advice side ("favor the right half of the fairway") or, with no
in-zone hazard data, `"middle of the fairway"`. `lat/lng/bearing` stay `None` (as today).

## 3. Wiring inside `generate_recommendation` (exact anchors)

All in `aim_point.py:247-428`:

- **Keep lines 267-291 unchanged** (adjustments, `is_tee_shot`, bias, `select_club`).
- After line 291: `reachable = is_green_reachable(adjusted_yards, clubs, hole.green_depth_yards)`;
  on the positioning path compute `leave_yards` per §1.
- **Lines 293-300** (`aim`, `miss`, `pin_light`): branch. Reachable → exactly today's calls.
  Positioning → `compute_positioning_aim`, `compute_positioning_miss_side`; skip
  `classify_pin_position` (pin light is a green concept).
- **Reasoning assembly (306-368):** the P0 club line (324) and the adjustments lines (309-320)
  stay on both paths. Gate behind `reachable`: the pin-light P1 lines (327-331),
  `slope_miss_advice` (349-353, green-slope = approach frame), `shot_line_advice` (357-361,
  terminal-terrain/green color — skip so the "zero flag/green-frame reference" gate is clean),
  and `decade_aim_advice` (363-368 — the incident sentence). Positioning path appends instead:
  - P1 `f"Green's out of reach ({adjusted_yards}y; your longest club is {max_reach}y) —
    positioning shot, leaves about {leave_yards} in"`
  - P1 `decade_landing_advice(...)` if any; P1 cross-hazard line if any
  - P2 bend-in-window line: if `hole.bend` and not `bend.straight` and `bend.distance_yards`
    within `[expected_advance − 60, expected_advance + 60]` → `f"Fairway bends {bend.direction}
    at ~{bend.distance_yards} — that corner is your landing zone"` (honest reuse of `HoleBend`;
    omitted when `bend is None`, per the unmapped-vs-straight discipline in `hazards.py`)
  - P2 miss-tendency line (333-338) stays.
  - The `MAX_REASONING_ITEMS=4` cap + `prioritize_reasoning` need no change (P0 + up to 3 P1s).
- **Aggressiveness (397-402):** positioning → `"conservative"` if any death hazard in the drive
  zone else `"moderate"`; reachable path unchanged.
- **Return (416-428):** add `shot_kind="positioning" if not reachable else "approach"` and
  `leave_yards=leave_yards if not reachable else None`.
- `compute_aim_point`, `compute_miss_side`, `classify_pin_position` themselves are **not
  modified** — the reachable path stays byte-identical.

## 4. Return type / plumbing — shared-type sync verdict

- `backend/app/caddie/types.py::CaddieRecommendation` (line 206): add two **defaulted** fields —
  `shot_kind: str = "approach"` (`"approach" | "positioning"`) and `leave_yards: Optional[int] =
  None`. Defaulted ⇒ persisted `session.last_recommendation` JSONB from older rounds still
  validates (the repo's established additive-field convention, see `HoleBend`'s comment).
- **Verdict:** `CaddieRecommendation` does NOT live in `backend/app/models.py` or
  `frontend/src/lib/types.ts` (grep-verified). Its mirror is
  `frontend/src/lib/caddie/types.ts:22` — add `shot_kind?: 'approach' | 'positioning';
  leave_yards?: number | null;` there (optional fields, no UI change required;
  `CaddiePanel.tsx:1053` already renders the new description via `aim_point.description`). Nothing
  else to sync.
- `tools.py::recommend_payload` (line 254) returns `rec.model_dump()` — the new fields reach the
  LLM automatically on both mouths. Update the `get_recommendation` tool description
  (`tools.py:137-152`) to add: *"If the result has shot_kind 'positioning', the green is out of
  reach on this swing — give landing-zone advice and state the leave_yards; never a pin-relative
  aim."* (Module-level constant stays byte-stable per process; check
  `test_caddie_tools.py`/`test_realtime_payload.py` for any pinned description strings and update
  in the same commit.)
- The situation lines that speak the last rec (`voice_prompts.py:183-188`,
  `routes/caddie.py:755-760`) need no code change — the positioning description flows through them.

## 5. Edge cases — each reasoned

1. **Drivable par 4** (best ≥ distance − margin): reachable → flag path untouched, including
   `decade_aim_advice`. Correct: the flag *is* the target.
2. **Par 5, both tee shot and layup out of reach:** classification is per-`generate_recommendation`
   call on the *current* `distance_yards`, not per-tee — 520y tee shot (250 driver) → positioning,
   leave 270; second shot from 270 (max 230) → positioning again, leave 40; from 240 → reachable →
   flag aim. Only the shot that can reach the green ever gets flag language. No hole-state machine.
3. **Wind/elevation across the threshold:** conditions are folded into `adjusted_yards` before the
   check, so a 260y hole reachable in still air flips to positioning into a stiff headwind/uphill,
   and a 270y hole flips to reachable downwind. Tested with a large elevation delta (§7, T10).
4. **No geometry / no hazard data:** `drive_zone_hazards` filters `carry_yards > 0` —
   `course_intel`-style green-frame hazards (default `carry_yards=0`) and unmapped holes drop out,
   so `decade_landing_advice` returns `None`, miss-side goes generic, bend line is omitted when
   `bend is None`. Result: *"Positioning shot — green's out of reach. Middle of the fairway;
   leaves about 150 in"* — honest generic, **no fabricated hazard**. The leave is always
   legitimate because `distance_yards` is a required engine argument; the unknown-distance case is
   already gated upstream — `tools.py::resolve_tool` (lines 864-877) returns an error asking the
   player before the engine is ever called, and the stateless `/voice` mouth with `yards=None`
   builds no recommendation at all. The prompt rule (§6) additionally forbids the LLM from
   inventing a leave when none is provided.
5. **`hole.yards is None`:** irrelevant to reachability (it uses `distance_yards`); the existing
   `is_tee_shot` None-guard (line 289) is untouched — `test_none_yards_never_throws` keeps passing.
6. **Empty bag:** falls to `DEFAULT_CLUB_DISTANCES` in both `is_green_reachable` and `select_club`
   — consistent by construction.

## 6. Prompt guard

New constant in `backend/app/caddie/voice_prompts.py` (directly below `YARDAGE_GROUNDING_RULE`,
line 87, same voice):

```python
# Positioning-shot rule (owner incident 2026-07-06, ~400y par 4: "Aim about
# 9 yards left of the flag" off the tee — the green was out of reach, so the
# flag was irrelevant). Shared by BOTH mouths so wording never drifts.
POSITIONING_SHOT_RULE = (
    "When the recommendation marks a shot as a positioning shot (shot_kind "
    "'positioning', or its aim says the green is out of reach), the flag does "
    "not exist for that swing: never give a pin-relative aim ('X yards left of "
    "the flag', 'take dead aim at the pin') and never reason from the pin "
    "position. Talk landing zone instead — which side of the fairway to favor, "
    "what's in play at the shot's own distance, and the approach it leaves "
    "(speak the engine's leave number; if none is provided, do not invent "
    "one). Pin-relative aim returns only on a shot the engine marks reachable."
)
```

Wire in three places, mirroring `YARDAGE_GROUNDING_RULE` exactly:
1. `build_realtime_instructions` behavior block (`voice_prompts.py:127-135`) — append after
   `YARDAGE_GROUNDING_RULE`.
2. Both `stable_text` blocks in `backend/app/routes/caddie.py` (after line 806 and after line
   1454) + the import at lines 33-38.
3. Register for the eval harness: add `"POSITIONING_SHOT_RULE"` to `backend/tests/eval/schema.py:91`'s
   rule list and the map in `backend/tests/eval/checks.py:180`; add one golden fixture to
   `backend/tests/eval/caddie_advice.jsonl` (source: this incident; situation = par 4, 400y,
   driver 250, trees R in the driving zone; tier1 `prompt_contains_rule: POSITIONING_SHOT_RULE`;
   tier2 `must_not_mention: ["of the flag", "at the pin", "left of the flag", "right of the flag"]`).

## 7. Tests (pure engine — no DB, no network; the gates)

**New file `backend/tests/test_positioning_shot.py`** (helper style copied from
`test_aim_point.py`; standard bag `{"driver": 250, "3wood": 230, "7iron": 160, "9iron": 140,
"pw": 130, "sw": 100}`). Human-string scan helper: collect `rec.aim_point.description`, every
`rec.reasoning` line, `rec.miss_side.description`, `rec.miss_side.avoid`; assert no
`re.search(r"\b(flag|pin)\b", s, re.I)` (word-boundary — "positioning" must not trip it;
deliberately excludes internal keys like `pin_traffic_light`).

- **T1 `test_400y_tee_shot_is_positioning_with_leave`** — 400y par 4, still air: `rec.shot_kind
  == "positioning"`, `rec.leave_yards == 150`, the string scan passes (ZERO flag/pin), `"150"`
  appears in `aim_point.description` or a reasoning line, `"fairway"` appears in
  `aim_point.description`.
- **T2 `test_positioning_with_drive_zone_trees_favors_safe_side`** — the incident shape: add
  `Hazard(type="trees", side="right", line_side="right", carry_yards=250, distance_from_green=150,
  penalty_severity="moderate")`: string scan passes; some human string contains `"left"` (favor)
  and `"trees"`; `miss_side.avoid` mentions right.
- **T3 `test_green_side_hazard_not_in_positioning_advice`** — 400y with only a
  `distance_from_green=5, carry_yards=395` water: no reasoning/aim line names water (it's outside
  the drive window) — driving-zone-only reasoning pinned.
- **T4 `test_par3_flag_path_unchanged`** (regression guard) — par 3, 165y, no hazards: `shot_kind
  == "approach"`, `leave_yards is None`, `aim_point.description == compute_aim_point(hole,
  None).description` (byte-equality with the legacy path), `"flag"` present.
- **T5 `test_short_approach_unchanged`** — 150y on a 400y par 4 (approach): `shot_kind ==
  "approach"`; with a yellow-pin hazard the existing "Yellow light pin" reasoning line still appears.
- **T6 `test_drivable_par4_reachable_flag_ok`** — 280y hole, bag with driver 290: `shot_kind ==
  "approach"`.
- **T7 `test_reach_margin_boundary`** — pins the threshold: 265y with 250 driver → `"approach"`;
  270y → `"positioning"` (constant `GREEN_REACH_MARGIN_YDS == 15` asserted directly too).
- **T8 `test_green_depth_overrides_margin`** — 268y, driver 250, `green_depth_yards=40` → margin
  20 → `"approach"`; same hole without depth → `"positioning"`.
- **T9 `test_par5_layup_positioning_then_go_zone`** — distance 270 with max 230 → positioning,
  `leave_yards == 40`, string scan passes; distance 240 same bag → approach.
- **T10 `test_elevation_flips_reachability`** — 262y flat → approach; 262y with
  `elevation_change_ft=60` (uphill, comfortably crossing the margin) → positioning. Asserts the
  flip, not exact adjusted numbers (physics-solve tolerant).
- **T11 `test_no_geometry_honest_generic`** — 400y, `hazards=[]`, `bend=None`: positioning; no
  `"bunker"|"water"|"trees"|"dogleg"|"bend"` in any human string; leave still stated (150);
  `"fairway"` present.
- **T12 `test_positioning_no_decade_pin_advice`** — 400y with the T2 trees hazard: no reasoning
  line contains `"of the flag"` / `"percentages favor aiming"` (the exact incident sentence class
  is dead on this path).
- **T13-T15 `decade_landing_advice` unit tests** (same file or appended to
  `test_decade_advice.py`): water `line_side="left"` at `carry_yards=240`, advance 250, leave 150
  → returned string contains `"right"` and `"water"` and no flag/pin; hazards outside `[200, 280]`
  window → `None`; `carry_yards=0` hazards → `None`; `drive_zone_hazards` window boundaries pinned
  exactly (`advance−50`, `advance+30`).

**New file `backend/tests/test_positioning_prompt.py`** (mirror
`test_epistemic_humility_prompt.py`, including the `DATABASE_URL` stub-before-import pattern):
- rule constant non-empty and contains `"positioning"`, `"never"`, `"leave"`;
- `POSITIONING_SHOT_RULE in build_realtime_instructions(personality)` and it appears after
  `YARDAGE_GROUNDING_RULE` in the behavior block;
- `from app.routes import caddie as caddie_routes; assert caddie_routes.POSITIONING_SHOT_RULE is
  POSITIONING_SHOT_RULE` plus source-level assertion it's interpolated in both `stable_text`
  builders (the `test_routes_caddie_imports_observed_reality_rule` pattern).

**Existing suites must stay green untouched** (they all call `generate_recommendation` at 150y →
approach path): `test_aim_point.py`, `test_decade_advice.py`, `test_slope_advice.py`,
`test_competition_legal.py`, `test_reasoning_priority.py`, `test_caddie_tools.py`,
`test_realtime_payload.py` (re-run the last two for tool-description pins). Never edit a test to
make it pass.

## 8. Build order + gates

1. `types.py`: `shot_kind` + `leave_yards` (defaulted).
2. `decade_advice.py`: constants, `drive_zone_hazards`, `_build_landing_classify`,
   `decade_landing_advice`, cross-hazard line.
3. `aim_point.py`: `GREEN_REACH_MARGIN_YDS`, `is_green_reachable`, `compute_positioning_miss_side`,
   `compute_positioning_aim`, branch wiring per §3.
4. `tools.py`: `get_recommendation` description addendum.
5. `voice_prompts.py` + `routes/caddie.py`: `POSITIONING_SHOT_RULE` wiring; eval schema/checks
   registration + one golden fixture.
6. `frontend/src/lib/caddie/types.ts`: two optional fields (silent rider, no UI change).
7. Tests per §7.

Gates before done: `cd backend && ruff check .`; `pytest tests/test_positioning_shot.py
tests/test_positioning_prompt.py tests/test_aim_point.py tests/test_decade_advice.py
tests/test_competition_legal.py tests/test_reasoning_priority.py tests/test_caddie_tools.py -q`
(all pure/no-DB locally; full suite in CI); `cd frontend && npx tsc --noEmit && npm run lint`;
voice-tests smoke. Land on `integration/next`. Northstar note: all new spoken strings are one
calm sentence each, capped by the existing `prioritize_reasoning`; nothing user-facing changes
visually beyond the aim text, so no designer flag needed.

### Critical Files for Implementation
- backend/app/caddie/aim_point.py
- backend/app/caddie/decade_advice.py
- backend/app/caddie/types.py
- backend/app/caddie/voice_prompts.py (+ the two `stable_text` blocks in backend/app/routes/caddie.py)
- backend/tests/test_positioning_shot.py (new; assertions specified in §7)
