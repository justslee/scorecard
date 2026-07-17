# Caddie hazard side + reach correctness — implementation plan

**Worktree:** `/Users/justinlee/projects/scorecard/.claude/worktrees/agent-afd3de02e2f7430e6`
**Bugs:** BUG 1 (Red-1, inverted miss side); BUG 2 (Red-2, greenside bunker spoken as tee-shot miss). v1.1.10, P0.
**Northstar rule in force:** honest degradation ("trouble both sides, commit to the fairway") is acceptable; a confident wrong single side is not. Never fabricate hazards.

## 0. Traced root causes (verified against code — do NOT flip any sign)

The base side math is correct and bearing-invariant. Verified:
- `backend/app/caddie/hazards.py:340` — `lateral = ux*(hy-ay) - uy*(hx-ax)` in `_project_onto_polyline` (positive = LEFT of travel), and the chord fallback at `hazards.py:596` — `ux*hy - uy*hx`. Pinned by `test_hazards.py::TestBearingSweptRegression` (8 bearings) and `test_tree_hazards.py::test_tree_side_at_all_eight_bearings`. **Any "fix" that flips a sign here is a regression and must be rejected in review.**

The three real defects:

1. **Finding A — wrong tee origin.** `hazards.py:249–255` (`_derive_tee_green`): the FIRST `featureType=="tee"` feature wins; the caller-supplied `tee=` arg is only a last resort (`hazards.py:275`). Red-1 stores 3 tee boxes (347/441/467y to green); the 347y forward tee is picked while the player is on the back tee → every `carry_yards` ~120y short (Red-2: 330 vs 374). Bearing shifts ~1°, so sides don't flip — but window membership and spoken carries are wrong. The frontend ALREADY resolves and sends the player's tee: `RoundPageClient.tsx:790–806` passes `tee: c.tee` from `applyTeeAnchors` (`frontend/src/lib/course/tee-anchor.ts:429`), and `routes/caddie.py:1298–1312` forwards it as `tee=hc.get("tee")` — the backend just ignores it. **Fixable inside `_derive_tee_green` alone; no caller signature change.** (Extraction happens at course-intel request time, not ingest — `osm_ingest.py` only stores features; `course_guides.py:99` is the one caller with no tee arg.)

2. **Finding B — the inversion mechanism.** `hazards.py:760–768` (`_extract_tree_line_hazards`): each side's tree line collapses to exactly two entries — min-carry (`side_obs[0]`) and max-carry (`side_obs[-1]`). Red-1's LEFT line spans carry 145→360, so its two survivors (145, 360) both fall OUTSIDE the drive window (~[235,315]); the RIGHT line's near entry (~270) falls inside. `drive_zone_hazards` (`decade_advice.py:444–449`) is a point-in-window filter, so `compute_positioning_miss_side` (`aim_point.py:296`, zone built at `aim_point.py:874`) sees only right-side trees → confident "favor left — miss right." Representation loss, not a sign flip.

3. **Finding C — no reach ceiling.** `decade_advice.py:437–449`: window = `[advance−50, advance+30]` around the selected club's stored distance with no cap tied to the player's actual reach. Called at `aim_point.py:874` and inside `decade_landing_advice` (`decade_advice.py:521`). A 374y-carry greenside bunker (dfg 19) can enter the tee-shot payload. The engine already computes the one-solve drive `(carry, total)` at `aim_point.py:730` (`physics_drive_total`) and reuses it in `tee_shot_numbers` — reuse THAT; never a second reach estimate. (The map's 100/330 floor/ceiling in `tee-shot-overlays.ts:87–88` is absolute; the caddie window must be player-relative.)

## 1. Canonical side-of-line audit (no code change required)

There is exactly ONE side convention, implemented as two pinned mirrors (cross-language, cannot literally share a function):
- Backend: `hazards.py::_project_onto_polyline` (:301–346) + chord `_classify` (:592–596). Positive lateral = LEFT.
- Frontend: `frontend/src/lib/map/tee-shot-overlays.ts::projectOntoPolyline` (:463–499, an explicit documented TS port of the backend function) + chord classify (:553–561); letter side at :670–675 (`'L'` when lateral > +10y). Uses the same anchored player tee (`args.tee`). `fcb-labels.ts` does no side math; `decade_advice.py`'s ±x frames consume `line_side` strings, not raw cross products.

They already agree; the inversion was never here. Action: none beyond keeping the existing cross-reference comments intact. Do not consolidate, do not flip.

## 2. Fix A — player-tee selection in `_derive_tee_green` (hazards.py)

Change tee derivation priority (green derivation unchanged: first green feature, then LineString end, then arg):

1. **NEW top priority — valid `tee` arg present** (`lat`/`lng` both present, non-None; reject `(0,0)`):
   - If stored `featureType=="tee"` features exist: select the stored tee whose `_feature_point` is NEAREST the arg (arg is a selector into curated geometry — it is itself a stored-box centroid computed by the frontend's `ringCentroid`, so this is an exact match in practice and tolerant of centroid drift; also protects against a sloppy `legacy`-source golfapi marker).
   - If no stored tee features: use the arg directly (today's last-resort path, promoted).
2. **No arg, multiple tee features, green derivable:** pick the tee FARTHEST (straight-line) from the derived green — the back tee. Deterministic, replaces file-order "first"; matches the card convention and the frontend tie rule ("never hand the golfer a shorter-than-actual number"). Requires deriving `green_pt` before selecting the tee (reorder the loop into two passes).
3. Hole-LineString fallback: unchanged.

This automatically fixes `extract_hole_hazards`, `extract_hole_bend`, and `extract_corridor_profile` together (all share `_derive_tee_green`) — required for coherence: Red-1's bend distance and corridor sample distances were also ~120y short. `course_guides.py:99` (tee=None) now researches guides from the back tee — the honest course-level default.

Docstring: update the priority list and the "tee-ordering dependency" note.

## 3. Fix B — gap-bounded span sampling for tree lines (hazards.py)

In `_extract_tree_line_hazards`, replace the near/far two-sample collapse (:760–768) with a **gap-bounded chain of REAL observations**:

- Sort the side's surviving observations by carry (as today).
- Spread < `_TREE_RANGE_MIN_SPREAD_YARDS` (30): emit the near entry only (unchanged).
- Otherwise emit a greedy chain: start at near; repeatedly jump to the FARTHEST observation with carry ≤ current + `_TREE_SPAN_MAX_GAP_YDS` (new constant, **40.0**); when none exists (a real mapped gap), jump to the next observation beyond it — the gap is preserved, never interpolated; always terminate at far. Emit each chain vertex via `_tree_hazard`.
- Replace `_TREE_ENTRY_CAP_PER_SIDE = 2` with a safety cap of **12**; if a chain exceeds it, double the gap and re-run (loop) so the near/far endpoints always survive.

Why 40: the drive window is 80y wide (`DRIVE_ZONE_SHORT_YDS` 50 + `DRIVE_ZONE_LONG_YDS` 30). A ≤40y step guarantees at least one emitted entry inside any 80y window overlapping a densely-observed span — a bracketing tree line can no longer be windowed away. Only a real observation gap can leave the window empty, and then exclusion is honest. This is why the consumer-side alternative (treating the near/far pair as an interval in `drive_zone_hazards`) was rejected: it would fabricate in-zone trees between two separate stands on the same side.

Blast-radius (verified):
- `format_hazards_line` groups by `(type, line_side)` and renders min–max — spoken hazard lines are byte-identical.
- Guide validator: `guide_writer.py` `_carry_runs` bridges `trees` carries unconditionally — extra interior samples cannot break persisted guides.
- Trees still can't evict bunker/water (appended after the cap, unchanged).
- Red-1 outcome: LEFT chain includes a landing-zone entry → zone has trees left AND right, equal moderate severity → existing tie logic (`aim_point.py:332–342`) → `preferred="center"`, "trouble both sides… commit to the fairway"; landing advice suppressed by the coherence guard (`aim_point.py:881–884`). Confident "miss right" structurally gone. All zone members are in-window by construction, so any carry `decade_landing_advice` speaks is landing-zone-relevant.

## 4. Fix C — player-relative reach cap on the drive window

- `decade_advice.py::drive_zone_hazards(hazards, expected_advance_yds, max_reach_yds: Optional[float] = None)`: when `max_reach_yds` is provided, the long edge becomes `min(expected_advance_yds, max_reach_yds) + DRIVE_ZONE_LONG_YDS` (short edge unchanged). Default `None` = today's behavior (back-compat for direct callers/tests).
- `decade_advice.py::decade_landing_advice(..., max_reach_yds: Optional[float] = None)`: pass through to its internal `drive_zone_hazards` call (:521).
- `aim_point.py` positioning branch: pass `max_reach_yds=float(tee_shot_numbers.drive_total_yards)` at BOTH call sites (:874 zone, :876 landing advice). This is the one-solve physics total computed once at :730 and already reused for reachability and the printed numbers — parity by construction; on the competition-legal path it is the stored club distance, still correct. `cross_hazard_line` (:931) consumes `zone`, so it is capped for free.
- Total (carry+roll) is the right ceiling — a hazard is in play if the ball can get there along the ground; the +30 long margin already covers roll/bounce variance.
- Red-2 arithmetic: player total ~285 → edge 315 < 374 → excluded; bomber total 350 → edge 380 ≥ 374 → included. The excluded bunker stays in `hole.hazards` with `distance_from_green=19 ≤ 20`, so `compute_miss_side` / `classify_pin_position` pick it up on the approach turn — it flows to approach advice with zero extra plumbing.

## 5. Tests — exact new/changed

New (backend, all pure/no-DB):

1. `test_hazards.py::TestTeeSelection` (Finding A):
   - 3 tee polygons at 347/441/467y from green + `tee=` arg at the 467 box → a landing bunker's `carry_yards` measured from the back tee (Red-1-shaped numbers).
   - `tee=` arg, no stored tee features → arg used directly.
   - Multiple tees, NO arg → farthest-from-green selected (back-tee default), asserted via a bunker carry.
   - Single tee, no arg → unchanged.
   - Polyline-present variant: same selection with a stored `hole` LineString — sides unchanged, carry shifts by the inter-box distance; and `extract_hole_bend` distance shifts with the same origin (coherence assertion).
2. `test_miss_side_grounding.py::test_red1_bracketing_left_tree_line_never_confident_right` (gate 1): synthetic 466y hole from the BACK tee frame; dense LEFT woods ring spanning carry 145→360 including landing-zone vertices (~250–280, lateral +20..40y); sparse RIGHT cluster (3 obs, 268–355). Through `extract_hole_hazards` → `drive_zone_hazards` → `compute_positioning_miss_side`: assert `miss.preferred in ("center", "right")` and NEVER `preferred == "left"` with "right" in `avoid`; when "center", description names both sides. Plus a `generate_recommendation`-level assertion that no reasoning string contains "favor the left".
3. `test_tree_hazards.py` additions (gate 2 + span tooth):
   - `test_bracketing_woods_left_stays_left_at_all_eight_bearings`: left woods span (carry 145→360) at N/NE/E/SE/S/SW/W/NW → every trees entry `line_side=="left"` AND ≥1 entry with carry in [235,315] at every bearing.
   - `test_real_gap_not_interpolated`: same-side stands at carries {140,150,160} and {350,360,370} → no emitted entry in (165, 345); `drive_zone_hazards` window [235,315] stays empty (honesty guard on the rejected interval approach).
4. `test_positioning_shot.py` additions (gate 3, Finding C):
   - `test_greenside_bunker_beyond_reach_excluded`: `Hazard(type="bunker", line_side="left", carry_yards=374, distance_from_green=19)`; `drive_zone_hazards([h], 350.0, max_reach_yds=285.0) == []`; `... max_reach_yds=350.0) == [h]` (bomber included).
   - `test_reach_cap_end_to_end`: 386y hole + that hazard + a ~285-total bag → `generate_recommendation` human strings never contain "bunker"; the same hazard still drives approach-frame logic (e.g. `classify_pin_position != "green"`).
   - `test_drive_zone_default_reach_is_legacy`: `max_reach_yds=None` keeps today's window (back-compat pin).

Changed existing tests (scrutinized; with justification):
- `test_tree_hazards.py::test_tree_point_cluster_becomes_tree_line_range` (T1): obs 220/240/260/300 → chain {220,260,300}; entry count 2→3. `test_woods_polygon_and_points_merge_per_side` (T12): obs 200..260 → chain {200,240,260}; 2→3. **Justification: the exact-2 count pinned the lossy min/max collapse — the root cause of BUG 1. The real contract (endpoints + formatted line "trees R 220-300y"/"trees R 200-260y") stays pinned and unchanged.** T5/T6/T7/T10 pass unchanged (chains reduce to endpoints at their spacings).
- `test_hazards.py::test_falls_back_to_tee_green_args_as_last_resort` (:305): still passes (fixture has no tee features) but rename/redoc — the arg is no longer "last resort" by priority.
- **No existing test asserts the first-tee/forward-tee convention** (`_base_hole_features` builds exactly one tee; no multi-tee fixture exists) — nothing must be deleted or inverted. `test_positioning_shot.py::test_drive_zone_hazards_window_boundaries_pinned` stays as-is (legacy-default pin). Builder must run `test_bethpage_validation`, `test_corridor_*`, `test_guide_writer`, `test_course_guides`-adjacent suites; single-tee fixtures mean no expected churn — any failure there is a real regression, not a test to edit.

Local sanity probes (dev-only, NOT tests — they hit live Overpass): `/private/tmp/claude-501/-Users-justinlee-projects-scorecard/0ca2062e-4a3c-4950-9d68-177b486e17ce/scratchpad/{red1_dump.py,red1_tees.py,red2.py,invariant.py,reversed.py}`. Do not re-fetch OSM in CI.

## 6. Shared-types impact

None. `Hazard` (`backend/app/caddie/types.py:58`) is unchanged — Fix B only changes how many entries exist; Fix C adds an optional Python function parameter, not a payload field; Fix A changes no shape. `backend/app/models.py` and `frontend/src/lib/types.ts` / `frontend/src/lib/caddie/types.ts` require no sync. No frontend product code changes.

## 7. Risks / edge cases

- **Doglegs:** carries/sides classify against the played polyline when stored (unchanged); span sampling runs through the same `_classify` closure (T7 pins the dogleg case). Chord-mirror exposure unchanged.
- **Holes with a real `golf=hole` polyline:** tee selection only moves the frame ORIGIN (`tee_along_m`); sides cannot change, carries shift consistently across hazards/bend/corridor. Covered by the polyline tee-selection test.
- **Single-tee holes / no-arg callers:** byte-identical behavior.
- **Center/deadband:** untouched (10y deadband; T10/center-bearing tests pin it).
- **Persisted strategy guides** researched under forward-tee carries may now fail read-time revalidation (`routes/caddie.py:1328`) against player-tee carries and be dropped — honest degradation (they were mis-anchored). Flag for owner; optional follow-up: clear `strategy_guide_attempted_at` for Bethpage to trigger re-research. Out of scope here.
- **Stale session `hole_intel` JSONB** keeps old carries until course-intel refires (each round mount) — acceptable.
- **Hazard prompt lines** (`format_hazards_line`) still list greenside bunkers with their (now-correct) carries; `HAZARD_GROUNDING_RULE` governs the model's use. If the realtime mouth still volunteers an unreachable bunker as a tee miss after this fix, that is a prompt-layer follow-up, not geometry.

## 8. Build order + ordered gate list

Implement A → B → C (A first so B/C fixtures assert back-tee-frame numbers), then run, in order:

1. `cd backend && ruff check .`
2. `cd backend && uv run pytest tests -q --ignore=tests/integration` (non-DB unit sweep; must include `test_hazards.py`, `test_tree_hazards.py`, `test_positioning_shot.py`, `test_miss_side_grounding.py`, `test_decade_advice.py`, `test_aim_point.py`, `test_corridor_profile.py`, `test_corridor_bend_cap.py`, `test_corridor_width_selection.py`, `test_tee_shot_numbers.py`, `test_bethpage_validation.py`, `test_guide_writer.py`)
3. The three new fixture gates green: Red-1 bracketing fixture; 8-bearing bracketing invariant; Red-2 reach fixture (subset of gate 2, called out as the P0 acceptance criteria)
4. `cd frontend && npm run lint`
5. `cd frontend && npx tsc --noEmit`
6. `cd frontend && npm run build`
7. `cd frontend && npx tsx voice-tests/runner.ts --smoke`
8. `cd frontend && npm run test:caddie-experience`

(4–8 run despite no expected frontend diff — bundle rule + regression safety; add `cd frontend && npm test` if any `.ts` under `lib/map`/`lib/caddie` is touched after all.)

## Critical files
- backend/app/caddie/hazards.py
- backend/app/caddie/decade_advice.py
- backend/app/caddie/aim_point.py
- backend/tests/test_tree_hazards.py
- backend/tests/test_positioning_shot.py
- backend/tests/test_hazards.py
- backend/tests/test_miss_side_grounding.py
