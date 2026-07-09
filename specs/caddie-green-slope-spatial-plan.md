# Implementation Plan — Green-Slope Spatial Reasoning (`get_green_read`)

**Spec:** `specs/caddie-physics-engine.md` §P1 "Green-slope spatial reasoning" (Sequencing item 2).
**Model:** produced by the Fable Plan agent (2026-07-09, cycle 42). This is the contract the
builder implements; it does not re-plan.
**Incident:** owner's 4-screenshot session, 2026-07-09 — the caddie stored "slopes west,"
could not map it to the player's LEFT/RIGHT, and butchered the slope→miss-side→uphill-putt
chain. 4th geometry-incident class (after dogleg side-mirroring, phantom left bunker,
multi-tee anchor).
**Fix pattern (proven twice):** a deterministic pure engine the LLM CITES and is forbidden
from re-deriving — `hazards.py` (HAZARD_GROUNDING_RULE) and `physics.py`
(PHYSICS_GROUNDING_RULE) are the precedents. This slice adds `green_geometry.py` +
`GREEN_GROUNDING_RULE` + a `get_green_read` tool.

---

## 0. RESOLVED SIGN DECISION — the spec's worked chain is inverted; build the PHYSICALLY CORRECT rule.

The spec (`caddie-physics-engine.md` §P1) and cycle-42 directive state:
> "slope-falls-left ⇒ high side is RIGHT ⇒ approach miss RIGHT ⇒ uphill putt" / golden case
> "slope-left → recommends right-side leave for an uphill putt".

The first arrow is correct; the **last link is inverted** and is exactly the sign-bug class
this project exists to stop. Tilted-plane physics:
- "Falls left" = downhill points LEFT ⇒ elevation decreases leftward ⇒ **LEFT is the LOW
  side, RIGHT is the HIGH side** (spec agrees this far).
- Miss **RIGHT** ⇒ ball on the HIGH side ⇒ ABOVE the hole ⇒ putt back is **DOWNHILL** (feared).
- Miss **LEFT** ⇒ ball on the LOW side ⇒ BELOW the hole ⇒ putt back is **UPHILL** (the leave
  you want — "leave it below the hole").

**Correct rule (plan of record): `uphill_leave_side == fall_side` (the low side / below the
hole); `downhill_leave_side == high_side`.** Falls-left ⇒ leave/miss **LEFT** for the uphill putt.

Corroboration in-repo: `slope_advice.py` (rel≈180°, drops toward the FRONT/player) already says
"back is high, front is low → below-the-hole side is short/front → leave it below the hole; miss
short." Drop-toward side = miss side. green_geometry is the 90°-rotated lateral case of the same
logic. eng-lead confirmed this independently (universal "leave it below the hole" green
management). **The eng-lead is surfacing this discrepancy loudly on the bundle PR + board so the
owner confirms before merge** (bundle #119 already gates on the owner's "ship it" — nothing
merges unseen). Also correct the spec's §P1 prose in the same commit (one-line edit). Do NOT code
the inverted rule.

---

## 1. Ground truth in the code

### 1a. Slope data source — already stored, convention pinned
- Producer: `backend/app/services/elevation.py::_compute_slope_from_grid` — 3×3 Sobel over 3DEP
  elevations around green center. Returns `{direction, severity, percent_grade, description,
  center_elevation_ft}`.
- **ASPECT PIN (critical):** `direction` is the **DOWNHILL azimuth — the compass direction the
  surface falls TOWARD (water-flow-off direction)**. 0°=N, 90°=E, clockwise. NOT the up-slope
  facing. Source: elevation.py ~L345-352, `direction = atan2(-dzdx, -dzdy)` (both gradients
  point uphill so downhill vector = `(-dzdx,-dzdy)`), with a comment noting an earlier sign bug
  gave the wrong quadrant for E/W. `slope_advice.py` docstring pins the same ("direction water
  flows off the green"). green_geometry.py MUST restate this pin in its docstring and encode it
  in tests (an up-slope reading flips all 12 sided rows).
- Persistence/flow: green feature JSONB `properties.green_slope` → `course_intel.build_hole_
  intelligence` → `GreenSlope` (types.py: `direction, severity ∈ flat|mild|moderate|severe,
  percent_grade, description`) → cached on `HoleIntelligence.green_slope` in the session.
- Severity thresholds (elevation.py): flat <1%, mild <2.5%, moderate <5%, severe ≥5%.

### 1b. Pinned LEFT/RIGHT convention to reuse (hazards.py)
- `_xy_m(base_lat, base_lon, lat, lon)` → local **(x=east, y=north)** metres (equirectangular,
  cos(mid-lat) longitude scaling).
- Sign convention (pinned by `test_hazards.py::test_left_is_positive_cross_convention`): for
  travel unit vector `u` and offset `h`, `cross(u,h) = ux*hy − uy*hx`; **POSITIVE = LEFT of
  travel, negative = RIGHT**. (Check: north `u=(0,1)`, west `h=(−1,0)` → +1 → left.)
- GeoJSON coords are **[lon, lat]** (the classic swap hazard).

### 1c. Missing piece: approach bearing
`HoleIntelligence` does not store tee→green bearing, but `build_hole_intelligence` receives
`hole_coords` with `green:{lat,lng}` and `tee?:{lat,lng}`. No live ball position exists, so
**v1 approach frame = tee→green**, surfaced as an assumption; shot→green is a documented
follow-up. State this in the payload `assumptions`.

### 1d. Tool plumbing reality (confirmed)
- Schema: one `CADDIE_TOOLS` entry covers both mouths — `realtime_tools()` and
  `anthropic_tools()`/`TEXT_TOOLS` both iterate `CADDIE_TOOLS` (tools.py ~L175-203).
- Execution is TWO paths: text mouth resolves server-side via `resolve_tool`; the Realtime orb
  dispatches from the BROWSER (`frontend/src/lib/voice/realtime.ts::dispatchTool` → `api.ts` →
  an HTTP route in `app/routes/caddie.py`). `get_shot_distance` has all three (request model +
  `POST /session/shot-distance` route, `api.ts` `getSessionShotDistance`, a `dispatchTool` case).
  **`get_green_read` needs all three — this slice DOES touch the frontend (plumbing only, no UI).**
- Grounding-rule wiring = THREE sites: `voice_prompts.py` behavior block (~L90-93) AND the two
  text-mouth `stable_text` blocks in `routes/caddie.py` (~L740-743 and ~L1344-1346).
- Pinned tool-surface tests: `tests/test_realtime_tools.py::EXPECTED_TOOL_NAMES` (4 sites) must
  gain `get_green_read`; `tests/test_caddie_tools.py::test_resolve_tool_stateless_ctx_answers_
  honestly_for_every_tool` is parametrized over the registry and auto-covers the new tool.

---

## 2. Rotation math, worked (every sign stated)

Frame: local ENU from `hazards._xy_m` (x=east, y=north, m). Compass→vector: bearing θ (deg CW
from north) ⇒ `v(θ)=(sin θ, cos θ)` (θ=0→north, θ=90→east).

- Approach β (tee→green): `(gx,gy)=_xy_m(tee_lat,tee_lon,green_lat,green_lon)`;
  `β = atan2(gx,gy) mod 360`; `u=(gx,gy)/‖·‖`. Degenerate tee==green ⇒ `None`.
- Downhill aspect α (`GreenSlope.direction`, falls-toward): `d=(sin α, cos α)`.

Signed lateral (hazards convention, h=d):
```
s = cross(u,d) = ux·dy − uy·dx = sinβ·cosα − cosβ·sinα = sin(β − α)
c = dot(u,d)   = cos(β − α)        (+1 falls away from player, −1 falls toward player)
```
Sign chain (each link falsifiable):
1. `s>0` ⇒ d points LEFT of travel ⇒ **slope falls LEFT**.
2. Falls left ⇒ low side LEFT, high side RIGHT.
3. Ball on LOW side is BELOW hole ⇒ putt UPHILL ⇒ **uphill_leave_side = LEFT = fall_side**;
   downhill_leave_side = high_side = RIGHT.
4. `s<0` mirrors: falls RIGHT ⇒ high LEFT ⇒ uphill leave RIGHT.
5. `|s| ≤ sin(DEADBAND_DEG)` ⇒ slope along the line ⇒ `fall_side="none"`; then `c<0` ⇒ falls
   toward player ⇒ `uphill_leave_depth="short"` (below the hole); `c>0` ⇒ `"long"`.

Owner check: green "slopes west" (α=270), approach due north (β=0): `s=sin(0−270)=sin(90)=+1>0`
⇒ falls LEFT ⇒ high RIGHT ⇒ **uphill leave LEFT**. ✓

Equivalence w/ slope_advice: its `rel=(α−β)%360` gives `s=−sin(rel)`, so rel≈90 (drops right)
⇒ s=−1 (right), rel≈270 (drops left) ⇒ s=+1 (left). Consistency test pins this (§6d).

Magnitudes: `cross_grade_pct=percent_grade·|s|`, `along_grade_pct=percent_grade·|c|`.
Deadband: `DEADBAND_DEG=20.0` (`|s|≤sin20°≈0.342`). Table aspects all at 45° multiples,
outside deadband. Severity gating: flat/grade<1% ⇒ all "none", "green effectively flat"; mild
⇒ sides with `confidence:"low"`; moderate|severe ⇒ `confidence:"high"`.

---

## 3. New pure module — `backend/app/caddie/green_geometry.py`

Stdlib-only (math, dataclasses, typing) + `from app.caddie.hazards import _xy_m` (REUSE, don't
reinvent — hazards is pure, no DB). Docstring mirrors hazards.py: incident record, aspect pin
(downhill-toward, cites elevation.py `atan2(-dzdx,-dzdy)`), sign convention (positive cross =
LEFT), and the full §2 sign chain.

```python
DEADBAND_DEG = 20.0

def approach_bearing_deg(tee_lat, tee_lng, green_lat, green_lng) -> Optional[float]
    # _xy_m → atan2(x_east, y_north) % 360; None when degenerate (<1 m).

@dataclass(frozen=True)
class GreenRead:
    fall_side: str            # "left"|"right"|"none" (falls-TOWARD, player frame)
    high_side: str            # opposite of fall_side; "none" when none
    uphill_leave_side: str    # == fall_side (LOW side / below the hole)  ← §0
    downhill_leave_side: str  # == high_side
    uphill_leave_depth: Optional[str]  # "short"|"long" when fall_side=="none" & meaningful
    cross_grade_pct: float
    along_grade_pct: float
    rel_angle_deg: float      # (α − β) % 360, diagnostics
    severity: str
    confidence: str           # "high"|"low"|"none"
    read_line: str            # one spoken-style sentence, player frame

def green_read(slope_direction_deg, percent_grade, severity, approach_bearing_deg) -> GreenRead
    # pure trig on bearings — §2 verbatim.

GREEN_GROUNDING_RULE = (
    "Never derive green break, slope side, or uphill/downhill putt direction yourself, "
    "and never translate a compass slope description (\"slopes west\") into the player's "
    "left or right on your own. Any statement about which side is high or low, which miss "
    "leaves an uphill putt, or how a putt breaks must come verbatim from the get_green_read "
    "tool. If it returns available:false or side \"none\", say the green read isn't mapped "
    "or the slope runs along your line — never fabricate a side."
)
```
`read_line` examples: falls-left ⇒ "Green falls to your left — right side is the high side; a
miss left leaves the uphill putt."; toward-player ⇒ "Green runs back to front, toward you —
short is below the hole."; flat ⇒ "Green is close to flat — no strong side." Core `green_read`
takes bearings (not coords) so it's table-testable; `approach_bearing_deg` is the only
coordinate-touching fn (where a lat/lng swap would live — §6b). No DB/async/network → pytest
runs locally without Postgres.

---

## 4. Wiring (mirror the `get_shot_distance` precedent exactly)

- **4a. `types.py`** — additive `HoleIntelligence.approach_bearing_deg: Optional[float] = None`
  (defaulted so stale cached session JSONB still validates).
- **4b. `course_intel.py`** — in `build_hole_intelligence`, when tee+green coords exist:
  `approach_bearing_deg(tee.lat,tee.lng,green.lat,green.lng)` → pass into `HoleIntelligence`.
  No tee ⇒ `None`. No new I/O.
- **4c. `tools.py`** — registry entry `get_green_read` inserted in ALPHABETICAL position
  (between `get_conditions` and `get_player_profile` — keep CADDIE_TOOLS sorted per D7). Desc
  modeled on `get_shot_distance`: "Which side of the green leaves the uphill putt, from the
  deterministic green-slope engine in the player's own left/right frame. ALWAYS call this before
  discussing green slope, break, high/low side, or where to leave an approach — never convert a
  compass slope direction to left/right yourself. If available:false, say the green isn't mapped
  for slope — never invent a read." Params: `hole_number` (integer, optional → current hole).
  `green_read_payload(session, hole_number=None) -> dict` (pure, mirrors `shot_distance_payload`):
  - intel None or `intel.green_slope` None ⇒ `{**base, available:False, reason:"No green slope
    mapped for this hole."}`.
  - `intel.approach_bearing_deg` None ⇒ `available:False`, reason "tee position unknown — can't
    orient the slope to your line" (compass description may be included, clearly labeled).
  - else ⇒ `green_read(gs.direction, gs.percent_grade, gs.severity, intel.approach_bearing_deg)`
    → payload `{available:True, hole_number, fall_side, high_side, uphill_leave_side,
    downhill_leave_side, uphill_leave_depth, cross_grade_pct, along_grade_pct, severity,
    confidence, read_line, slope_compass: gs.description, approach_bearing_deg, assumptions:[...]}`.
  `resolve_tool` branch before the `get_carries` tail: `if name=="get_green_read": return
  green_read_payload(session, hole_number=_as_int(args.get("hole_number")) or ctx.default_hole)`.
- **4d. `routes/caddie.py`** — `POST /session/green-read` mirroring `/session/shot-distance`
  (request `{round_id, hole_number:Optional[int]}`, `get_owned_session`, delegate to
  `caddie_tools.green_read_payload`). Append `GREEN_GROUNDING_RULE` to BOTH text-mouth
  `stable_text` blocks (~L740-743, ~L1344-1346).
- **4e. `voice_prompts.py`** — import `GREEN_GROUNDING_RULE` alongside HAZARD/PHYSICS (~L15-17);
  append in behavior block (~L90-93) after `PHYSICS_GROUNDING_RULE`.
- **4f. Frontend (plumbing only, no UI):** `lib/caddie/api.ts` `getSessionGreenRead(params)` →
  `post('/caddie/session/green-read', params)`; `lib/voice/realtime.ts::dispatchTool`
  `case 'get_green_read'` (mirror `get_shot_distance`); `lib/voice/realtime-dispatch.test.ts`
  case asserting the dispatch hits the endpoint. **No `types.ts`↔`models.py` shape change** (LLM
  consumes the payload as tool_result, typed `unknown`); no DB schema change (`green_slope` JSONB
  exists).

---

## 5. Sequence
1. `green_geometry.py` + `GREEN_GROUNDING_RULE` + `tests/test_green_geometry.py` (§6 table green
   first).
2. `types.py` field + `course_intel.py` bearing (+ a pure bearing-helper test; one intel-level
   test via the persisted-elevation fast path — no network).
3. `tools.py` registry + `green_read_payload` + `resolve_tool` + tests (test_caddie_tools.py).
4. `routes/caddie.py` endpoint + text-mouth rule wiring; `voice_prompts.py` rule + prompt tests.
5. `test_realtime_tools.py::EXPECTED_TOOL_NAMES` update; confirm `tests/eval/test_tool_parity.py`.
6. Frontend dispatch plumbing + voice test.
7. Same commit: one-line spec §P1 correction (§0); a Tier-1 golden eval scenario encoding the
   owner chain.

---

## 6. Adversarial test table (the teeth)

### 6a. Rule-engine matrix — `green_read` on bearings, grade=3.0 (moderate). `s=sin(β−α)`.
**β=0° (north):**
| # | α (downhill) | s | fall_side | high_side | uphill_leave_side | depth |
|---|---|---|---|---|---|---|
| 1 | N 0° (away) | 0 | none | none | none | long |
| 2 | NE 45° | −.707 | right | left | right | — |
| 3 | E 90° | −1.0 | right | left | right | — |
| 4 | SE 135° | −.707 | right | left | right | — |
| 5 | S 180° (toward) | 0 | none | none | none | short |
| 6 | SW 225° | +.707 | left | right | left | — |
| 7 | W 270° | +1.0 | left | right | left | — |
| 8 | NW 315° | +.707 | left | right | left | — |

**β=225° (southwest):** `s=sin(225−α)`
| # | α | s | fall_side | high_side | uphill_leave_side | depth |
|---|---|---|---|---|---|---|
| 9 | N 0° | −.707 | right | left | right | — |
| 10 | NE 45° | 0 (c=−1) | none | none | none | short |
| 11 | E 90° | +.707 | left | right | left | — |
| 12 | SE 135° | +1.0 | left | right | left | — |
| 13 | S 180° | +.707 | left | right | left | — |
| 14 | SW 225° | 0 (c=+1) | none | none | none | long |
| 15 | W 270° | −.707 | right | left | right | — |
| 16 | NW 315° | −1.0 | right | left | right | — |

Fault-detection (why it has teeth):
- Global sign flip (or `cross=uy·dx−ux·dy`): 12 sided rows flip → red.
- Uphill/downhill inversion (the §0 spec bug: `uphill_leave=high_side`): fall/high cols stay
  green but uphill_leave_side red in all 12 sided rows — separates rotation bug from gravity bug.
- Consistent lat/lng (x/y) swap in vector build: `v(θ)→v(90−θ)` reflection (det −1) ⇒ cross
  flips ⇒ 12 red.
- Partial swap (only u or d built swapped): `s'=sin(β+α−90)`; β=0: row 3→"none"(red), row
  1→"right"(red); diagonals stay green — why the table has cardinals AND diagonals AND two β.
- Degrees/radians confusion: breaks ±.707 rows non-uniformly.
- Deadband boundary: α=β±10° ⇒ "none"; α=β±25° ⇒ sided; flat (0.5%) ⇒ all "none", conf "none";
  mild (2%) ⇒ sided, conf "low".

### 6b. Coordinate-level — `approach_bearing_deg` (lat/lng-swap trap)
Reuse test_hazards helper style: tee fixed, green 300y north⇒0, east⇒90, southwest⇒225 (±0.5°).
Arg swap ⇒ 90−θ (east returns 0 → red). Degenerate tee==green ⇒ None. Plus one end-to-end coord
test: tee south of green (approach north) + α=270 + coords only ⇒ uphill_leave_side "left".

### 6c. Owner golden case (pinned)
`test_owner_golden_slope_falls_left_uphill_leave_is_the_low_side`: β=0, α=270 ("slopes west")
⇒ fall_side="left", high_side="right", **uphill_leave_side="left"**, read_line contains "left"
as the leave side and never the bare compass word as a side. Docstring: cites the 2026-07-09
session; cites §0 (spec prose "miss RIGHT" is the high/downhill side — MUST NOT be "fixed" by
flipping the engine to match the spec without owner sign-off); notes this fails against pre-fix
by construction (no tool/module existed). A Tier-1 golden eval scenario makes it executable
against the live prompt+tool loop.

### 6d. Other
- `GREEN_GROUNDING_RULE` present exactly once in realtime instructions (mirror
  `test_realtime_grounding.py` HAZARD pattern) and in both text stable_text blocks.
- test_caddie_tools: registry presence in TEXT_TOOLS; resolve happy path; honest fallbacks
  (no intel / intel w/o green_slope / slope w/o bearing ⇒ available:false, distinct reasons);
  parametrized stateless-ctx test auto-covers.
- test_realtime_tools: add `get_green_read` to EXPECTED_TOOL_NAMES (4 sites).
- Cross-consistency w/ slope_advice at quadrant centers: rel=90 (falls right) ⇒ slope_advice
  "left is HIGH" and green_read `high_side="left"` — never disagree on which side is high.
- Frontend: realtime-dispatch.test.ts case for the new branch.

---

## 7. Edge cases & risks
| Risk | Handling |
|---|---|
| Aspect convention (downhill-toward vs up-facing) | PINNED §1a; docstring + every table row (up-slope reading flips 12 rows). |
| Spec's inverted uphill chain | §0 — physically-derived rule of record; golden test docstring guards a "helpful" flip; owner confirms on the bundle. |
| Lat/lng ordering (GeoJSON [lon,lat]) | Core engine takes bearings; single coord fn swap-tested (§6b); `_xy_m` reused. |
| Slope straight toward/away | `|s|` deadband ⇒ "none" + honest depth — never a fabricated side. |
| Near-flat green | severity/grade gating ⇒ all "none", conf "none", read_line flat. |
| Missing slope data | available:false + reason; rule keeps caddie general. |
| Missing tee coords (no bearing) | available:false "can't orient to your line"; compass-only, labeled. |
| shot→green vs tee→green | v1 = tee→green (no ball-position source); in `assumptions`; documented follow-up (polyline last segment via `_hole_polyline` is a future refinement). |
| Stale cached HoleIntelligence JSONB | `approach_bearing_deg` defaulted None ⇒ validates; degrades honestly. |
| Sorted-registry / prompt-cache (D7) | Alphabetical insert; module-level constant unchanged per request. |
| Two-mouth drift | Schema single registry (both renderers iterate); execution route+resolve share `green_read_payload`; eval `test_tool_parity.py` covers. |

---

## 8. Gates
- `cd /Users/justinlee/projects/scorecard/backend && ruff check .`
- `cd /Users/justinlee/projects/scorecard/backend && python -m pytest tests/test_green_geometry.py
  tests/test_caddie_tools.py tests/test_realtime_tools.py tests/test_realtime_grounding.py
  tests/test_slope_advice.py -q` — all pure/no-DB, run LOCALLY (no local Postgres; green_geometry
  has zero DB/network imports by design). DB-backed suites run in CI only.
- Frontend IS touched (dispatch plumbing): `cd frontend && npx tsc --noEmit`, `npm run lint`,
  `npm run build`, voice tests (`npx tsx voice-tests/runner.ts --smoke` + `realtime-dispatch.test.ts`).
- NORTHSTAR: voice-first, calm; tool-only, NO UI — the caddie gets grounded ("miss it left,
  that's your uphill putt") instead of compass-fluent. Nothing dashboard-y.

### Critical files
- `backend/app/caddie/green_geometry.py` (NEW — pure engine + GREEN_GROUNDING_RULE)
- `backend/app/caddie/tools.py` (registry, green_read_payload, resolve_tool)
- `backend/app/caddie/hazards.py` (reused `_xy_m` + positive-cross-=-LEFT convention)
- `backend/app/caddie/course_intel.py` + `types.py` (approach_bearing_deg plumbing)
- `backend/app/routes/caddie.py` + `voice_prompts.py` (endpoint + rule wiring)
- `frontend/src/lib/caddie/api.ts` + `lib/voice/realtime.ts` (dispatch plumbing)
- `backend/tests/test_green_geometry.py` (NEW — §6 adversarial table + golden case)
