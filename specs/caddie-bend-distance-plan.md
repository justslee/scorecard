# Implementation Plan — caddie-bend-distance ("how far is it to the bend?")

> Fable plan (2026-07-09, cycle 46). Contract for the builder — implement it, do not re-plan.

**Correctness crux flagged up front:** the spoken bend direction is **NOT** the sign of the
vertex's chord deviation. For the Bethpage-4 shape (first leg NE, second leg N = dogleg LEFT),
the corner vertex sits **right** of the tee→green chord. The deviation cross SELECTS the bend
vertex; the **turn cross** (tee→bend × bend→green) gives the spoken direction. A naive
implementation that reports the deviation sign would say "bends right" on every dogleg-left
hole — the exact incident class this repo has been burned by twice. The plan pins that with tests.

Spec: `specs/caddie-physics-engine.md` §P2. Deterministic geometry the LLM CITES, never computes
(the pattern that fixed hazards). No ML, no new data, no UI. Honest-or-absent per NORTHSTAR /
`[[no-fake-data-fallbacks]]`.

---

## 0. Verified ground truth (what exists today)

- **The frame** lives in `backend/app/caddie/hazards.py`: `_xy_m` (L71–80, tee-based east/north metres), `_derive_tee_green` (L103–158, tee/green priority + the documented tee-ordering dependency), `_hole_polyline` (L161–176, the `featureType=="hole"` LineString as `[(lon,lat),…]`), `_project_onto_polyline` (L179–224, cumulative carry + per-segment cross), the chord unit `(ux,uy)` and the `tee_along_m` anchor idiom (L267–292: carry is measured relative to the TEE's own projection onto the way, because the `golf=hole` way often starts at the back tee behind the derived tee), `_YARDS_PER_METER` (L48), `_round_to_5` (L83). Sign convention pinned by `tests/test_hazards.py::test_left_is_positive_cross_convention` (L203): `lateral = ux*(hy-ay) - uy*(hx-ax)`, **positive = LEFT of travel**.
- **Intel build call site**: `backend/app/routes/caddie.py::get_course_intel` L1183–1210 — the ONLY place `extract_hole_hazards` runs in the app (`intel.hazards = extract_hole_hazards(stored_features, tee=hc.get("tee"), green=hc.get("green"))`, L1204–1208).
- **Multi-tee anchor (shipped, frontend)**: `frontend/src/lib/course/tee-anchor.ts` → `applyTeeAnchors` applied in `RoundPageClient.tsx` L350–352; the anchored coords are what `fetchCourseIntel` sends (L752–767), so the backend receives the player-selected tee as `hole_coordinates[].tee` → `hc["tee"]`. Inside `extract_hole_hazards`, `_derive_tee_green` prefers a stored tee **polygon** over that arg (priority 1 at L127–133; the arg is last resort, L153–156). Live GPS (`fcbLive`, RoundPageClient ~L1088–1121) never reaches the backend session.
- **Tool machinery**: one registry `CADDIE_TOOLS` in `backend/app/caddie/tools.py` (L47–192, sorted by name, module-constant — prompt-cache guard D7), rendered by `realtime_tools()` (L195) and `anthropic_tools()`/`TEXT_TOOLS` (L209–223); dispatcher `resolve_tool` (L754–824); orb dispatch is browser-side `frontend/src/lib/voice/realtime.ts::dispatchTool` (L93–167) hitting HTTP session endpoints (e.g. `GET /session/{round_id}/carries`, routes/caddie.py L473–488). Parity tripwires: `tests/eval/test_tool_parity.py`, `tests/test_realtime_tools.py::EXPECTED_TOOL_NAMES`.
- **Grounding injection sites**: text session `_build_session_voice_prompt` (routes/caddie.py — hazards line at L694–697, rules block L767–771), stateless twin `_build_voice_prompt` (rules at ~L1372), realtime mint `voice_prompts.py::build_realtime_instructions` (rules L90–95) + `_situation_block` (hazards line L131–134). Eval harness: `tests/eval/schema.py::_VALID_RULE_NAMES` (L87), `tests/eval/checks.py::_RULE_TEXT` (L162), golden set `tests/eval/golden/caddie_advice.jsonl`.
- **Frontend type mirror**: `HoleIntelligence` crosses the wire via `fetchCourseIntel` → mirrored in `frontend/src/lib/caddie/types.ts` L83–102 (NOT `lib/types.ts`; precedent comment on `HoleStrategyGuide` L67–71: "mirrors backend/app/caddie/types.py exactly"). `backend/app/models.py` does not contain `HoleIntelligence` — no change there.
- **Real dogleg fixture**: `tests/fixtures/bethpage_overpass.json` + `tests/test_bethpage_validation.py` (hole 4 doglegs LEFT; every assembled hole carries its `golf=hole` way — asserted at L374–382).

---

## 1. Approach & exact math

All math in `hazards.py`'s existing tee-based local frame — no new projection, no new constants except the threshold.

**Inputs** (identical derivation to `extract_hole_hazards`):
1. `tee_pt, green_pt = _derive_tee_green(feature_list, tee, green)`; either `None` → return `None` (never guess a bearing).
2. `path = polyline arg or _hole_polyline(feature_list)`; `None` → **return `None`** — the chord fallback has no interior vertices, so "no polyline" is honest *unknown*, never "straight".
3. `path_xy = [_xy_m(tee_lat, tee_lon, lat, lon) for lon, lat in path]` — tee is the frame origin `(0,0)`.
4. Chord: `gx, gy = _xy_m(tee…, green…)`; `length_m = hypot(gx, gy)`; `0` → `None`; `ux, uy = gx/length_m, gy/length_m`.
5. `tee_along_m = _project_onto_polyline(path_xy, 0.0, 0.0)[0]` — same anchor idiom as hazards.py L285–292 (`None` from a degenerate polyline → return `None`), so bend distance and hazard `carry_yards` are measured from the SAME origin by construction and "clear the bunker at 245, bend's at 250" is internally coherent.

**Candidate vertices**: interior vertices only, `path_xy[1:-1]`. Justification: a bend is a direction *change*; endpoints cannot be one, and the way's first/last vertices are back-tee/green-center anchor offsets, not fairway shape. Additionally require `along_m(i) - tee_along_m > 0` (a kink behind the player's tee — back-tee routing jitter — is not a bend the player faces) and `hypot(gx - vx, gy - vy) > 1.0` m (a vertex coincident with the green cannot define an outgoing leg).

**Deviation metric (selection + threshold)**: signed perpendicular deviation of vertex `v=(vx,vy)` from the tee→green chord anchored at the tee (frame origin): `dev_m = ux*vy - uy*vx` — byte-identical cross form to hazards.py L218/L312 (positive = LEFT of the chord). Bend vertex = **argmax |dev_m|**; exact tie → the earlier vertex (smaller along-path distance; deterministic, and the first corner is the one the player faces).

**Straight-hole threshold**: `_BEND_MIN_DEVIATION_YARDS: float = 15.0` (module constant, hazards.py, next to `_LATERAL_DEADBAND_YARDS`). If `max |dev_m| * _YARDS_PER_METER < 15.0` → the hole is measured-straight: return `HoleBend(straight=True, deviation_yards=<rounded max>)`. 15y ≈ 13.7 m: comfortably above OSM digitization jitter and the 10y hazard lateral deadband, comfortably below any bend a caddie would name; a gentle 15y sweep over 400y is "plays straight" in spoken guidance.

**Along-path distance**: `dist_m = (Σ segment lengths from path start to the bend vertex) - tee_along_m`; `distance_yards = _round_to_5(dist_m * _YARDS_PER_METER)` — same rounding as hazard carries ("bends right at about 250").

**Direction — the turn cross, NOT the deviation sign (the correctness crux)**:
- `u1 = v / |v|` (tee→bend), `u2 = (g - v) / |g - v|` (bend→green).
- `turn = u1x*u2y - u1y*u2x` — the pinned cross form again; `turn > 0` → `"left"`, `turn < 0` → `"right"`.
- Proof it's needed: `_dogleg_hole()` in test_hazards.py (leg1 bearing 45°, leg2 due N — the documented Bethpage-4 dogleg-LEFT shape, hazards.py L22–24): corner `v ≈ (191y E, 191y N)`, chord `u ≈ (0.439, 0.898)`, `dev = 191*(0.439-0.898) < 0` = **right of chord**, while `turn = cross((0.707,0.707),(0,1)) = +0.707` = **LEFT** — the true spoken answer. Reporting the deviation sign is the sign-flip incident all over again; a dedicated test pins this (§7, test 10).
- `turn == 0` is unreachable for a vertex whose chord deviation ≥ threshold (tee/v/green collinear ⇒ deviation 0); no branch, note in a comment.
- The two-leg abstraction (tee→bend, bend→green) rather than adjacent-segment directions makes the direction robust to densely-sampled smooth curves, where the per-vertex turn is noise.

**Double dogleg (honesty decision)**: "the bend" = the single max-|deviation| vertex — that is the spec's definition and the dominant feature a golfer means. But silently reporting one bend on an S-hole invites the model to describe the hole as a simple dogleg — dishonest by omission. Decision: scan the candidates for any vertex with **opposite deviation sign** and `|dev| ≥ threshold`; if found set `double_dogleg=True`. The payload and grounding line carry the flag ("double dogleg — biggest turn right at 250") so the mouths qualify honestly. No second distance in v1 (keeps the contract small); noted as a possible follow-up.

**Units**: everything internal in metres; convert once at the boundary via `_YARDS_PER_METER` (threshold defined in yards, compared in yards: `abs(dev_m) * _YARDS_PER_METER < _BEND_MIN_DEVIATION_YARDS`).

---

## 2. Where the pure function lives + signature

In `backend/app/caddie/hazards.py`, directly below `_project_onto_polyline` — it reuses five module-private helpers plus the module's pinned sign-convention docstring; a new module would either re-export privates or duplicate the frame (the exact anti-pattern the 2026-07-08 deletion of `course_intel._classify_side` fixed). Extend the module docstring's "Math convention" block with the bend/turn-cross paragraph from §1.

```python
def extract_hole_bend(
    features: Optional[dict],
    *,
    tee: Optional[dict] = None,
    green: Optional[dict] = None,
    polyline: Optional[list] = None,
) -> Optional[HoleBend]:
```

Mirrors `extract_hole_hazards`' signature so the one call site passes identical args. Pure, no I/O, unit-testable. Returns:
- `None` — cannot determine (no tee/green, no/degenerate polyline, zero-length chord). Honest *unknown*.
- `HoleBend(straight=True, deviation_yards=n)` — measured straight (max deviation below threshold).
- `HoleBend(straight=False, direction="left"|"right", distance_yards=250, deviation_yards=38, double_dogleg=False)`.

Also new in hazards.py: `BEND_GROUNDING_RULE` (module constant, §6) and `format_bend_line(hole_number, bend) -> str` (§6).

---

## 3. Tee/GPS anchor — exact call sites

- **Compute site**: `routes/caddie.py::get_course_intel`, immediately after the `intel.hazards` assignment (L1204–1208), inside the same `if stored_features and stored_features.get("features")` guard:
  `intel.bend = extract_hole_bend(stored_features, tee=hc.get("tee"), green=hc.get("green"))`.
- **Selected-tee composition**: `hc["tee"]` IS the multi-tee anchored tee — RoundPageClient L350–352 (`applyTeeAnchors`) → `fetchCourseIntel(anchoredCoords…)` L752–767 → `CourseIntelRequest.hole_coordinates[].tee`. Inside, `_derive_tee_green` prefers a stored tee polygon over the arg (hazards.py L127–133) — **identical to hazard carries**, so bend distance and `carry_yards` share one anchor by construction and can never disagree with each other. Flag for the owner (do NOT change here): on courses whose FeatureCollection stores multiple tee polygons, the derived backend anchor is the first tee feature, not the selected tee — that priority predates this feature, affects hazards equally, and reordering it is a separate change with its own teeth (`_derive_tee_green`'s docstring dependency, L113–119).
- **GPS**: live position (`fcbLive`) is frontend-only and never enters the backend session — there is nothing to compose with. v1 is tee-anchored, and the tool payload says so explicitly via an `assumptions` entry (mirroring `green_read_payload`'s assumptions, tools.py L452–456): `"distance measured from the tee along the hole centerline; from mid-hole the bend is closer than this"`. GPS-relative bend = future work, noted, not built.

---

## 4. Type changes

`backend/app/caddie/types.py` — new model + one additive field (defaulted, like `hazards`/`approach_bearing_deg`, so cached session `hole_intel` JSONB predating it still validates):

```python
class HoleBend(BaseModel):
    straight: bool = False
    direction: Optional[str] = None        # "left" | "right"; None when straight
    distance_yards: Optional[int] = None   # tee-anchored along-path, rounded to 5
    deviation_yards: int = 0               # max |perpendicular deviation| off the chord
    double_dogleg: bool = False

class HoleIntelligence(BaseModel):
    ...
    bend: Optional[HoleBend] = None        # None = centerline unmapped (honest unknown)
```

Frontend: `HoleIntelligence` crosses the wire (`fetchCourseIntel` → `CourseIntelResult.holes`), so mirror in **`frontend/src/lib/caddie/types.ts`** (add `HoleBend` interface + optional `bend?: HoleBend` on `HoleIntelligence`, with the same "mirrors backend/app/caddie/types.py exactly" comment style as `HoleStrategyGuide` L67–81). Also extend the `getSessionConditions` payload type in `frontend/src/lib/caddie/api.ts` (~L251–263) with `bend: HoleBend | null`, and add a `BendPayload` type for the new endpoint. **`frontend/src/lib/types.ts` and `backend/app/models.py` are untouched** — `HoleIntelligence` lives in the caddie type pair, verified. A future tile could surface `bend` (note only — NO UI in this change; designer review not needed since nothing user-visible renders).

---

## 5. Tool wiring — new `get_bend` tool (decision + full parity)

**Decision: a new `get_bend` tool, not folding into `get_carries`.** Justification: (a) `get_carries`' contract and honest-failure reason are hazard-specific ("No mapped hazard data") — a hole with a mapped centerline but zero bunkers answers `carries: []`, and a bend fact buried there is both semantically wrong and undiscoverable; (b) realtime models route by name/description — "how far to the bend" → `get_bend` is direct; (c) precedent: `get_shot_distance` and `get_green_read` each shipped as single-fact tools; (d) the D7 prompt-cache guard requires per-request stability, not cross-deploy stability — adding a registry entry invalidates the cached prefix exactly once at deploy, same as every prior tool addition. Additionally, add `bend` to `conditions_payload` (tools.py L358–399, next to `green_slope`) so the hole-level aggregate stays complete — one line, additive.

Changes, all in the established pattern:
1. **Registry** (`tools.py::CADDIE_TOOLS`): insert `get_bend` FIRST (sorted: `get_bend` < `get_carries`; `test_text_tools_are_deterministically_ordered` enforces placement). Description (honest contract, mirrors get_carries' style): *"Where and how far the fairway bends (the dogleg) on a hole, measured from the tee along the hole's mapped centerline. Call this when the player asks about the bend, corner, or dogleg. If it returns straight:true, the hole has no significant bend — say it plays straight. If available:false the hole's centerline isn't mapped — say you don't know the shape and NEVER invent a dogleg or a distance to one."* `input_schema`: optional `hole_number` integer, "Hole to evaluate (1-18). Omit for the current hole." (mirrors `get_conditions`). While touching the file, fix the stale "six caddie tools" wording in the module docstring (L3) to be count-neutral.
2. **Payload** (`tools.py`), pure:
   ```python
   def bend_payload(session: RoundSession, hole_number: Optional[int] = None) -> dict
   ```
   - no intel → `{available: False, reason: "No mapped course data for this hole."}`
   - `intel.bend is None` → `{available: False, reason: "Hole centerline not mapped — can't measure the bend."}` (unknown ≠ straight — the honesty distinction, tested)
   - `bend.straight` → `{available: True, straight: True, direction: None, distance_yards: None, note: "No significant bend — this hole plays straight."}` (a TRUE statement, distinct from unknown — the `carries_payload` note pattern, L541)
   - else → `{available: True, straight: False, direction, distance_yards, deviation_yards, double_dogleg, assumptions: [tee-anchored line from §3]}` — fields verbatim from `intel.bend`, never recomputed.
3. **`realtime_tools()` / `anthropic_tools()` / `TEXT_TOOLS`**: automatic — both render from the registry; `tests/eval/test_tool_parity.py` proves parity by construction stays intact.
4. **Resolver** (`tools.py::resolve_tool`, L754–824): add the `get_bend` branch (`bend_payload(session, _as_int(args.get("hole_number")) or ctx.default_hole)`) above the closing `get_carries` fall-through; stateless `ctx.session is None` already answers `_NO_SESSION_PAYLOAD` honestly.
5. **Orb HTTP path**: new route `GET /session/{round_id}/bend` in `routes/caddie.py` mirroring `get_session_carries` (L473–488: `get_owned_session` + payload helper); frontend `getSessionBend(roundId, holeNumber?)` in `lib/caddie/api.ts` (mirror `getSessionCarries`, L304); `case 'get_bend'` in `realtime.ts::dispatchTool` (after `get_carries`, L129–136 pattern, with the same "never invent" comment).

---

## 6. Grounding — the bend fact in both mouths' context

New constant in `hazards.py`, exported beside `HAZARD_GROUNDING_RULE`:

```python
BEND_GROUNDING_RULE = (
    "Only say the fairway bends or doglegs — or give a distance to a bend — if the "
    "hole-shape data for this hole or the get_bend tool provides it. If the data says "
    "the hole plays straight, say it plays straight. If no hole-shape data is given, "
    "never guess a dogleg direction or a distance to a bend."
)
```

New formatter `format_bend_line(hole_number, bend)` in hazards.py: `None` → `""` (line omitted — unknown says nothing, the rule covers it); straight → `"Hole 4 shape: plays straight — no significant bend"`; bend → `"Hole 4 shape: doglegs right at ~250y"` (+ `" (double dogleg)"` when flagged).

Injection (all three prompt sites, guarded "if present" like every peer):
1. `routes/caddie.py::_build_session_voice_prompt` — context line after the hazards line (L694–697): `bend_line = format_bend_line(request.hole_number, hole_intel.bend)`; rule appended in `stable_text` after `HAZARD_GROUNDING_RULE` (L767–771 block).
2. `routes/caddie.py::_build_voice_prompt` (stateless twin) — rule in its rules block (~L1372), mirroring how HAZARD_GROUNDING_RULE appears there.
3. `voice_prompts.py::build_realtime_instructions` — rule in the Behavior block (L90–95); bend line in `_situation_block` after the hazards line (L131–134).

Eval-harness registration: `tests/eval/schema.py::_VALID_RULE_NAMES` += `"BEND_GROUNDING_RULE"` (L87); `tests/eval/checks.py::_RULE_TEXT` += entry (L162–167); `checks.build_round_session` sets `intel.bend = extract_hole_bend(hole.features)` when a scenario supplies `features` (additive; scenarios without features keep `bend=None`).

---

## 7. Deterministic tests with TEETH

**`backend/tests/test_hazards.py` — new `class TestExtractHoleBend`** (reuse `_rotate`, `_point_north_east`, `_dogleg_hole`, `_square_polygon`, `_fc`; due-north convention documented at top of file):

1. **Right dogleg**: way tee→(0,250y N)→green(180y E, 250y N); asserts `direction == "right"` and `distance_yards == 250 ±5` and `straight is False`. RED if: threshold logic inverted, or distance measured to the wrong vertex.
2. **Left dogleg** (the `_dogleg_hole()` Bethpage-4 shape, legs 45°→0°): `direction == "left"`, `distance_yards == 270 ±5`. **RED under the deviation-sign implementation** (which reports "right" — see test 10).
3. **The mirror-trap pin**: same fixture — assert the bend vertex's *chord deviation* is negative/right-of-chord (recomputed inline in the test, the way `test_dogleg_outside_corner_bunker…` pins the chord's failure mode at L449–450) while the reported `direction == "left"`. This documents WHY direction = turn cross and makes the naive impl fail with a self-explaining assertion.
4. **Straight hole**: 2-vertex way AND a many-vertex way with ≤8y lateral jitter → `straight is True`, `direction is None`. RED if the implementation invents a bend or drops the threshold.
5. **Threshold boundary**: single interior vertex at 12y deviation → straight; at 18y → bend. Pins the 15y value; RED on any threshold drift.
6. **Bearing invariance** (the reviewer's falsification): parametrize the 8 `_BEARINGS`; rotate the right-dogleg shape via `_rotate` to each heading; `direction == "right"` at ALL bearings. RED on any east/north sign slip (the `TestBearingSweptRegression` pattern, L349+).
7. **No polyline**: tee/green polygons only → `extract_hole_bend(...) is None` (never "straight", never a bend). RED if the chord fallback fabricates anything.
8. **Tee-anchor subtraction**: way starts 30y BEHIND the tee polygon (back-tee vertex), bend vertex at true 250y from the tee → `distance_yards == 250`, not 280. RED if `tee_along_m` isn't subtracted (mirrors hazards.py L285–292).
9. **Multi-bend / double dogleg**: S-shape — bend A dev +40y (left of chord) at ~200y along, bend B dev −25y at ~350y along → primary is A's vertex (max |dev|), `double_dogleg is True`, and B-side distance checks pin that along-path distance to a second-leg vertex is CUMULATIVE (leg1 + partial leg2 > straight-line) — RED on a straight-line-to-vertex implementation.
10. **Degenerate/behind-tee**: all-identical-vertex polyline → `None`; a large kink entirely behind the tee → not reported as the bend.

**`backend/tests/test_bethpage_validation.py`** — real-fixture lock, new class next to `TestHole4PolylineSides`: `extract_hole_bend(hole4["features"])` → `direction == "left"` (the documented dogleg, hazards.py L22–24) and `200 <= distance_yards <= 350` (landing-zone band; builder pins the measured value ±10y with a comment after first green run — the hard tooth is the direction, which goes RED on any sign error against real OSM data).

**`backend/tests/test_caddie_tools.py`** — `bend_payload` honest matrix (mirror the carries matrix): no-intel → available:false; `bend=None` → available:false "centerline not mapped" (RED if conflated with straight); straight → available:true + note + `direction is None`; real bend → fields verbatim; `resolve_tool("get_bend")` dispatch with `default_hole`; `conditions_payload` includes/omits `bend` correctly.

**`backend/tests/test_realtime_tools.py`** — add `"get_bend"` to `EXPECTED_TOOL_NAMES` (L31–41; the set-equality asserts force this consciously). **`backend/tests/test_realtime_grounding.py`** — `_situation_block` contains the bend line when `intel.bend` is set, absent when `None`; `build_realtime_instructions` contains `BEND_GROUNDING_RULE`; route-level `GET /session/{id}/bend` test with monkeypatched `get_owned_session` (the file's established pattern).

**Eval teeth** (`tests/eval/golden/caddie_advice.jsonl` + schema/checks changes from §6):
- `"bend-dogleg-cites-geometry"`: `situation.hole.features` = synthetic dogleg FC (exercises production geometry via `resolve` path); tier1: `prompt_contains_rule BEND_GROUNDING_RULE` (both mouths), `context_contains` the exact bend line; tier2_deterministic: `must_mention_any ["bends left","doglegs left","dogleg left"]`, `must_not_mention ["bends right","doglegs right"]`.
- `"bend-straight-hole-never-invented"`: straight-features scenario; tier1 `context_contains "plays straight"`; tier2 `must_not_mention ["dogleg","bends left","bends right"]`.
- No new check *family* → no new `test_harness_has_teeth.py` mutant required (`prompt_contains_rule`/`context_contains`/`must_not_mention` are already teeth-proven). If the builder does add a family, a mutant is mandatory.

**Frontend**: `frontend/src/lib/voice/realtime-dispatch.test.ts` — `get_bend` dispatches to `GET /caddie/session/{id}/bend` (existing per-tool pattern).

---

## 8. Gates (all must pass; show output)

```bash
cd /Users/justinlee/projects/scorecard/backend && ruff check .
cd /Users/justinlee/projects/scorecard/backend && uv run pytest tests/test_hazards.py tests/test_caddie_tools.py \
  tests/test_realtime_tools.py tests/test_realtime_grounding.py tests/test_bethpage_validation.py tests/eval -q
cd /Users/justinlee/projects/scorecard/backend && uv run pytest -q   # full suite; DB-backed integration tests
  # (tests/integration/*) run in CI's Postgres/PostGIS job — no local Postgres; do not fake them locally
cd /Users/justinlee/projects/scorecard/frontend && npm run lint && npx tsc --noEmit && npm run test && npm run build
cd /Users/justinlee/projects/scorecard/frontend && npx tsx voice-tests/runner.ts --smoke   # required: types + dispatch changed
```

Per CLAUDE.md: new user-facing capability → `/code-review` + `/security-review` before the PR is ready (new endpoint is read-only, `get_owned_session`-gated like its five siblings — call that out in the review).

---

## 9. Edge cases & risks

- **Green→tee-digitized ways**: `_derive_tee_green`'s documented dependency (hazards.py L113–119) — a reversed way flips the travel direction and would mirror the bend direction *and* hazard sides together. Guard = the ingest-time "GROSS REVERSED" yardage validation (test_bethpage_validation). Bend inherits the exact same exposure as hazards, consistently — no new risk surface, documented in the function docstring.
- **Near-collinear polylines**: handled by the 15y threshold → honest "straight"; degenerate (zero-length chord, all-identical vertices) → `None`.
- **Bend vertex ≈ green**: excluded by the `|g−v| > 1 m` candidate guard; a legitimate late bend near the green still reports (true information).
- **Very short holes / par 3s**: interior vertices with sub-threshold jitter → "straight"; no minimum-length special case needed (the threshold is absolute, not proportional — a 15y bend on a 120y par 3 is real and reportable).
- **Unit confusion**: single conversion boundary (`_YARDS_PER_METER`), threshold declared in yards and compared in yards, distance rounded with the same `_round_to_5` as carries — tests 1/5/8 pin the numerics.
- **Double dogleg honesty**: single-max primary + `double_dogleg` flag (§1 decision); the grounding line and tool payload both carry it so neither mouth describes an S-hole as a simple dogleg.
- **Backend tee-anchor priority**: stored tee polygon beats the anchored `tee=` arg (pre-existing, shared with carries) — flagged to the owner in §3, not changed here.
- **Prompt-cache**: registry + stable-text changes invalidate the cached prefix once at deploy — expected, same as every prior tool/rule addition (D7 guards per-request stability only).

---

## 10. Shared-type sync checklist

| Location | Change |
|---|---|
| `backend/app/caddie/types.py` | `HoleBend` (new), `HoleIntelligence.bend` (additive, defaulted) |
| `frontend/src/lib/caddie/types.ts` | mirror `HoleBend` + `HoleIntelligence.bend?` (exact-mirror comment, HoleStrategyGuide precedent) |
| `frontend/src/lib/caddie/api.ts` | `ConditionsPayload.bend`, new `BendPayload` + `getSessionBend` |
| `backend/app/models.py` | **no change** (HoleIntelligence not defined there — verified) |
| `frontend/src/lib/types.ts` | **no change** (round/scorecard shapes untouched) |

Build order: types → `extract_hole_bend` + `format_bend_line` + rule (tests 1–10 red→green) → intel call site → tool registry/payload/resolver/route → frontend api/dispatch/mirrors → grounding injections → eval scenarios → gates.

### Critical Files for Implementation
- /Users/justinlee/projects/scorecard/backend/app/caddie/hazards.py (the pure function, formatter, rule — the frame lives here)
- /Users/justinlee/projects/scorecard/backend/app/caddie/tools.py (registry entry, `bend_payload`, `resolve_tool` branch)
- /Users/justinlee/projects/scorecard/backend/app/routes/caddie.py (intel call site L1204, new `GET /session/{round_id}/bend`, both prompt builders)
- /Users/justinlee/projects/scorecard/backend/tests/test_hazards.py (the teeth: sign, threshold, bearing sweep, anchor subtraction)
- /Users/justinlee/projects/scorecard/backend/app/caddie/types.py + /Users/justinlee/projects/scorecard/frontend/src/lib/caddie/types.ts (the synced `HoleBend` shape)
