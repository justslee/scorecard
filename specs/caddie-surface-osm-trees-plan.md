# caddie-surface-osm-trees — Implementation Plan

Slice: NOTICEABLE, backend-only. No ML, no satellite CV, no new dependency, no DB schema change,
no new API field. The app already ingests OSM trees (`featureType == "tree"`, Point) and woods
(`featureType == "woods"`, Polygon) and corridor-joins them per hole
(`course_spatial._CORRIDOR_CAPS_M`: woods 150 m, tree 120 m; woods also pass the
`_WOODS_MAX_SPAN_M` bbox filter). The caddie ignores them solely because
`backend/app/caddie/hazards.py::_HAZARD_FEATURE_TYPES = frozenset({"bunker", "water"})`.
This plan gates tree/woods into the SAME hazard pipeline — same played-polyline carry+side math,
same `Hazard` model, same three caddie mouths — with an honest per-hole coverage guard.

NORTHSTAR alignment: voice-first (the output is one more clause in the existing spoken hazards
line), honest (a hole with insufficient tree data says nothing and, when asked, the caddie says
trees aren't in its mapped data — never an invented tree line), quiet (aggregation rules exist
specifically so 537 Bethpage tree nodes never become a wall of numbers).

---

## 1. Approach

All tree/woods surfacing happens inside `extract_hole_hazards` in
`backend/app/caddie/hazards.py`, as an additional pass appended AFTER the existing bunker/water
loop and its cap. Because every consumer — `routes/caddie.py:1236` (intel-time extraction →
`HoleIntelligence.hazards` → session JSONB), `voice_prompts.py:153` (realtime mouth),
`routes/caddie.py:722` (text mouth), `tools.py:403`/`carries_payload` (tool mouth), and
`services/course_guides.py:99` (guide writer ground truth) — flows through this one function,
NO caller changes are needed. The canonical hazard type string is `"trees"` — it is already in
the `Hazard.type` comment (`types.py:60`), already handled by `decade_advice._hazard_to_area`
("trees" → `LandingArea.RECOVERY`), `decade_advice._friendly_hazard_name`, `aim_point.py:220`,
and the frontend union (`frontend/src/lib/caddie/types.ts:59`). Both `"tree"` points and
`"woods"` polygons produce `Hazard(type="trees")`.

### The observation model (the core mechanism)

Individual hazards-per-feature would be noise (hundreds of tree Points) and a woods polygon's
centroid is deep inside the stand. Instead, tree features are reduced to OBSERVATION POINTS,
each classified through the EXACT same frame as bunkers, then aggregated per side into at most
two "tree line" entries (a start/end carry pair the existing formatter renders as a range):

1. **Observations.**
   - `featureType == "tree"` (Point): the point itself is one observation.
   - `featureType == "woods"` (Polygon): every outer-ring vertex is an observation (the OSM
     woods boundary literally traces the tree line — the ring IS the leading edge). The
     closing (repeated) vertex is deduped.
2. **Classification.** Each observation is projected with the same math as a bunker centroid:
   `_xy_m` into the tee-anchored local frame, then `_project_onto_polyline` against the played
   `golf=hole` way when present (with the same `tee_along_m` subtraction), else the tee→green
   chord. Positive lateral = LEFT. No second side convention exists anywhere in this plan.
3. **Relevance filters (per observation).**
   - Drop observations with raw `carry_m < 0` (behind the tee — with many observations per
     feature, dropping behind-tee ones loses nothing and keeps range starts meaningful; this
     differs deliberately from the single-centroid clamp-to-0 used for bunkers).
   - Drop observations with `|lateral_yards| > _TREE_MAX_LATERAL_YARDS = 70.0`. The corridor
     join already caps at ~131 y; 70 y is still far outside any real shot cone, and this window
     is what makes woods handling near-EDGE by construction: the deep/far-side ring vertices of
     a big stand fall outside the window, so only the edge facing the played line contributes.
4. **Per-side aggregation + coverage guard.** Group surviving observations by `line_side`
   (same 10 y deadband). A side QUALIFIES iff it has `>= _TREE_MIN_OBS = 3` observations.
   Every real woods polygon (ring of >= 4 vertices near the line) qualifies on its own;
   1–2 isolated volunteer-mapped tree points never speak — that is the coverage guard.
5. **Emission.** For each qualifying side, emit:
   - `Hazard(type="trees", line_side=side, side=side, penalty_severity="moderate",
     carry_yards=_round_to_5(min carry), distance_from_green/lat/lng from the min-carry
     observation)`, and
   - a second entry at `_round_to_5(max carry)` (from the max-carry observation) ONLY when
     `max − min >= _TREE_RANGE_MIN_SPREAD_YARDS = 30.0`. `format_hazards_line` already merges
     same-(type, side) entries into a range, so this renders as `trees R 220-300y` with ZERO
     formatter logic added — the "tree line runs from X to Y" spoken shape falls out of the
     existing grouping. Max 2 entries per side (`_TREE_ENTRY_CAP_PER_SIDE = 2`), max 6 total.
6. **Cap independence.** Tree entries are computed separately and appended AFTER the
   bunker/water list has been sorted and capped at `cap` (default 5). The combined list is then
   re-sorted by `carry_yards` (preserving the documented ascending order). A tree can therefore
   NEVER evict a bunker or water hazard from the extraction result, structurally.

A useful emergent property: because aggregation is per side over all observations, the output
is independent of how OSM happens to split one forest into several polygons (Bethpage's 73
woods polygons collapse to at most a handful of spoken groups).

---

## 2. Exact files to touch

### `backend/app/caddie/hazards.py` (the whole change surface for behavior)
- **Module docstring**: add a paragraph documenting the tree observation model, the near-edge
  (lateral-window) woods semantics, the coverage guard, and that trees inherit the
  played-polyline frame — including the reversed-way exposure — unchanged.
- **New constants** (place beside the existing ones):
  - `_TREE_FEATURE_TYPES: frozenset[str] = frozenset({"tree", "woods"})`
  - `_TREE_MIN_OBS: int = 3`
  - `_TREE_MAX_LATERAL_YARDS: float = 70.0`
  - `_TREE_RANGE_MIN_SPREAD_YARDS: float = 30.0`
  - `_TREE_ENTRY_CAP_PER_SIDE: int = 2`
- **`_SEVERITY_BY_TYPE`**: add `"trees": "moderate"`.
- **`_TYPE_ORDER`**: add `"trees": 2` (after water — see decision 5).
- **`format_hazards_line`**: replace the literal group cap `5` with a named
  `_FORMAT_GROUP_CAP: int = 6` (see decision 6). Docstring updated with a trees example.
- **`extract_hole_hazards`**: refactor the per-point classification (project-or-chord +
  deadband) into a small local closure/helper `_classify(hx, hy) -> (carry_m, lateral_m)`
  built once after `path_xy`/`tee_along_m`/`ux,uy` are computed, used by both the existing
  bunker/water loop and a new tree pass `_extract_tree_line_hazards(feature_list, classify)`
  implementing §1 steps 1–5. Append its result after the existing `hazards[:cap]`, re-sort the
  combined list by `carry_yards`, return. Update the docstring's Returns contract:
  "bunker/water sorted nearest-first and capped at `cap`, plus up to 6 aggregated tree-line
  entries; combined list sorted by carry_yards ascending."
- **`HAZARD_GROUNDING_RULE`**: append (additive — the two substrings pinned by
  `test_grounding_rule_forbids_inventing_hazards` must survive verbatim):
  `' Tree lines and woods appear in the hazard data as "trees" entries whose yardage is where '
  'the tree line runs along or across the hole. If the player asks about trees and no "trees" '
  'entry is in the hazard data for this hole, say the trees are not in your mapped data — '
  'never estimate a tree-line distance.'`
  This constant is embedded verbatim in both mouths (`routes/caddie.py:797,1409`,
  `voice_prompts.py:110`) and referenced — never copied — by the eval checks, so the amendment
  propagates everywhere with this single edit.

### `backend/app/caddie/tools.py`
- `carries_payload` note string (line 567): `"No mapped bunkers or water in play on this hole."`
  → `"No mapped bunkers, water, or tree lines in play on this hole."` (the note only renders
  when the hole has intel but zero in-play carries; trees flow into the carries list itself
  automatically since it iterates `intel.hazards`).

### `backend/app/caddie/types.py`
- NO field changes (`type`/`carry_yards`/`line_side` already carry everything needed — the
  comment on `type` already lists `trees`). Zero schema change means old cached
  `HoleIntelligence` JSONB validates untouched, and holes re-extract trees the next time intel
  is built (course-intel runs per round start — NOTICEABLE without a migration).

### Tests (see §5): `backend/tests/test_tree_hazards.py` (new),
`backend/tests/test_hazards.py` (cap-test update), `backend/tests/test_caddie_tools.py`
(note-string pins at lines 72 and 92), `backend/tests/test_bethpage_validation.py` (real-fixture
tree assertions), `backend/tests/eval/golden/caddie_advice.jsonl` +
`backend/tests/eval/test_harness_has_teeth.py` (eval teeth, §6).

### Explicit non-goals (do NOT touch)
- `backend/app/services/osm.py`, `course_spatial.py` — ingest/join already correct; verified:
  `"tree"` Points (osm.py:188-198), `"woods"` Polygons from `natural=wood`/`landuse=forest`/
  `natural=scrub`/closed `tree_row` (osm.py:304-317), corridor caps include both types.
- `guide_writer._HAZARD_KEYWORD_TO_TYPE` / side-flip validation: do NOT add tree keywords.
  The validator's premise — "keyword whose type is absent from our geometry ⇒ the guide asserts
  something false ⇒ reject" — does NOT hold for trees: OSM tree coverage is systematically
  incomplete, so absence-of-mapping ≠ absence-of-trees, and adding "trees/woods/pines" keywords
  would fail-closed-reject honest "tree-lined fairway" guides on most courses. Trees DO flow
  into `build_ground_truth_block` and `validate_guide`'s hazard set automatically via
  `extract_hole_hazards` (a benefit: the guide writer now sees real tree lines); the keyword
  map stays bunker/water/ob. Documented here so the reviewer knows it is a decision, not an
  omission.
- `aim_point.py` / `decade_advice.py`: already trees-aware; `"moderate"` severity means trees
  never trigger the severe/death aim-shift paths (correct for this slice).

---

## 3. The six design decisions — RESOLVED

1. **Woods carry semantics: near-edge, not centroid.** A woods polygon's centroid sits deep in
   the stand — on a Bethpage-scale polygon it can misstate the carry by 50–100+ y and, for a
   stand wrapping a dogleg corner, land on the wrong side of the played line. Chosen mechanism:
   every outer-ring vertex is an observation, and the `|lateral| <= 70y` window discards the
   deep/far-side vertices, so only the edge FACING the played line contributes; the emitted
   carries are the along-path start (and end, when spread >= 30 y) of that near edge. The number
   the caddie cites — "tree line at ~230 on the right" — is thus geometrically "the along-path
   carry range over which the mapped tree boundary runs within 70 y of your line". Honest and
   defensible; pinned by a diagonal-woods test where the centroid answer (~315 y) and near-edge
   answer (~150 y) differ materially (§5 T4). We deliberately do NOT claim a "clears it" number:
   truly clearing woods depends on the aim line, which this 1-D frame doesn't model; the
   grounding-rule amendment frames tree yardages as WHERE the tree line runs.
2. **Point trees → a tree line, never 537 points.** Aggregation rule (contract): group
   qualifying observations by `line_side`; per qualifying side emit min-carry entry + max-carry
   entry (only when spread >= 30 y); at most 2 entries/side, 6 total. Formatting REUSES
   `format_hazards_line`'s existing (type, line_side) grouping and range merge — no dedicated
   tree formatter. Spoken result: `trees R 220-300y`, at most 3 tree groups per hole.
3. **Coverage guard + honest fallback: hybrid (silent line + explicit on-demand rule).**
   Threshold: a side speaks iff >= 3 observations survive the filters (any mapped woods polygon
   qualifies alone; 1–2 stray tree points never do). Below threshold → NO tree hazards → the
   hazards line simply omits trees, identical to the bunker/water/bend/slope empty-state
   convention. The EXPLICIT honesty signal lives in the amended `HAZARD_GROUNDING_RULE`: when
   asked about trees with no `"trees"` entry in the data, the caddie must SAY trees aren't in
   its mapped data rather than estimating. Why this split instead of a per-hole "trees aren't
   mapped here" context line: (a) the rule text is static — it lives in the prompt-cache-stable
   BLOCK 0 and adds zero per-hole prompt bloat across two mouths; (b) a per-hole line would fire
   on nearly every hole of most courses (tree mapping is sparse globally), violating "quiet";
   (c) unlike silence alone, the rule produces the honest utterance exactly when the player asks
   — which is the moment honesty is on the line ("how far to clear the trees" implies the player
   can SEE trees; the honest answer is "they're not in my map", never silence-then-guess). The
   wording must be "not in my mapped data", never "there are no trees" — OSM absence is absence
   of MAPPING, not absence of trees.
4. **Sign/side correctness.** Tree observations go through the SAME `_classify` closure —
   `_project_onto_polyline` (cumulative carry, positive lateral = LEFT, tee-projection anchor
   subtraction) with chord fallback — as bunkers. No new convention, no new math path. The
   dogleg chord-mirror exposure (Bethpage 4) and the reversed-way exposure (a green→tee
   digitized `golf=hole` way mirrors every side, guarded by the ingest-time "GROSS REVERSED"
   yardage validation in `test_bethpage_validation`) are inherited SHARED risks, called out in
   the docstring, not new surface. Pinned by the 8-bearing sweep and dogleg tests (§5 T6, T7).
5. **Severity / ordering.** `_SEVERITY_BY_TYPE["trees"] = "moderate"`: trees are punch-out /
   recovery territory (`decade_advice` maps type "trees" → `LandingArea.RECOVERY` regardless of
   severity), clearly not `death` (water), and `severe` would wrongly trigger `aim_point`'s
   severe/death avoidance paths (aim_point.py:86). `_TYPE_ORDER["trees"] = 2`: trees sort after
   bunker and water in the spoken line, so a tree line can never outrank a real water hazard.
6. **Cap interaction: separate cap, append-after, plus formatter headroom.** Extraction: trees
   never compete with bunker/water for the `cap=5` slots (append-after-cap, §1 step 6).
   Formatting: the group cap rises 5 → 6 (`_FORMAT_GROUP_CAP`). Justification: groups sort by
   `(_TYPE_ORDER, min carry)` — type order FIRST — so bunker/water groups always occupy the
   front; trees can only fill trailing slots and can never displace a bunker/water group at
   either cap value. But at cap 5, a hole with 5 bunker/water groups (common on exactly the
   stadium courses this feature targets) would structurally silence trees forever — defeating
   the slice. Cap 6 gives trees at most one-to-three trailing slots while "a real water hazard
   is never dropped in favor of a tree" remains provable (§5 T8/T9). Existing
   `test_groups_capped_at_five` is updated to pin the new boundary (7 groups in → 6 rendered).

---

## 4. Edge cases & risks

- **Chord-fallback side mirroring for trees on doglegs**: identical to bunkers; corrected
  whenever the stored FeatureCollection carries the `golf=hole` way (which
  `assemble_osm_course` stores). Not new; pinned by T7.
- **Reversed-way digitization**: mirrors tree sides along with every bunker side, consistently;
  existing ingest-time guard covers it. Documented, no new code.
- **Tee-flanking tree lines**: a hole tree-lined from the tee emits `trees L 0-280y` (min carry
  0 after the behind-tee observation drop). Accepted: truthful, and the model phrases it
  naturally ("trees all down the left"); `carries_payload` already filters `carry <= 0` entries
  so the tool mouth never says "clubs that clear 0y".
- **Crossing woods**: a stand crossing the hole reads as center entries when >= 3 ring vertices
  sit within the 10 y deadband (T10), else as flanking left+right groups — imperfect but honest;
  noted in the docstring.
- **One polygon, three groups**: a crossing woods can emit C, L, and R groups — rare, honest,
  bounded by the 6-entry cap.
- **Multiple polygons for one forest**: per-side aggregation makes output independent of OSM
  polygon splitting.
- **Performance**: observations are per-hole corridor-capped lists; O(vertices × path segments)
  per hole is microseconds at Bethpage scale (~30 trees + a few woods rings per hole).
- **Cached sessions**: `HoleIntelligence` JSONB predating this change validates unchanged (no
  new fields); trees appear on next intel build. No migration.
- **`aim_point` side-severity aggregation** (aim_point.py:161) now sees `moderate` tree entries
  — may mildly influence miss-side prose. Intended (NOTICEABLE), and bounded: never the
  severe/death paths.
- **Prompt-line growth**: worst case one hazards line gains up to 3 tree groups; group cap 6
  bounds it.

## Shared-type sync verdict

**No frontend change required.** No new backend field is added anywhere (`Hazard` and
`HoleIntelligence` shapes are untouched); the tree data surfaces as additional `Hazard` list
entries plus prompt text. `frontend/src/lib/caddie/types.ts:59` already includes `'trees'` in
the `Hazard.type` union, so even typed consumers of the course-intel response
(`hole-intel-cache.ts`, `OfflineCaddieCard`, `CaddiePanel`) are already valid. (Pre-existing,
out of scope: the frontend `Hazard` interface has never mirrored the additive backend
`carry_yards`/`line_side` fields; TS consumers tolerate extra runtime fields, and this item
adds no new ones.) `frontend/src/lib/types.ts` contains no Hazard/HoleIntelligence mirror at
all (verified by grep).

---

## 5. Deterministic tests

**New file: `backend/tests/test_tree_hazards.py`** — mirrors `test_hazards.py`'s idioms exactly
(due-north base fixtures, `_point_north_east`/`_rotate`/`_square_polygon`/`_point_feature`/
`_fc`, `_dogleg_hole`; copy the small helpers into the new file — they are file-local by
convention there). All expected numbers below are DERIVED from the fixture geometry, not
assumed:

- **T1 `test_tree_point_cluster_becomes_tree_line_range`**: due-north hole, 4 `"tree"` Points
  at along 220/240/260/300 y, lateral −25..−35 y (east = right) → exactly two `trees` hazards
  (carry 220 and 300, both `line_side == "right"`), and
  `format_hazards_line(...) == "Hole N hazards: trees R 220-300y"`.
- **T2 `test_two_isolated_trees_never_speak`**: same hole, only 2 tree Points right + 1 bunker
  left → hazards contain the bunker and NO `trees` entry (coverage guard is per-type: bunker
  still speaks).
- **T3 `test_no_tree_data_is_silent`**: bunker/water-only FC → no `trees` entries; formatted
  line contains no `"trees"` token (honest omission — the grounding rule covers the utterance).
- **T4 `test_woods_near_edge_not_centroid` (the decision-1 tooth)**: a diagonal/triangular
  woods Polygon with its nearest vertex at (along 150 y, lateral −20 y) and its bulk running
  away to (along 400 y, lateral −90..−120 y), so the ring centroid sits at along ≈ 315 y and the
  far vertices are outside the 70 y window → asserts the emitted trees carry ≈ 150 (± 5) and
  asserts NO entry within ± 25 y of the centroid's 315 — a centroid implementation goes RED.
- **T5 `test_behind_tee_observations_dropped`**: woods ring with vertices behind the tee →
  range starts at the first forward observation, never a clamped 0 from behind-tee vertices.
- **T6 `test_tree_side_at_all_eight_bearings`** (parametrized `_BEARINGS`): right-side tree
  cluster stays `"right"` with stable carry at every compass heading — trees inherit the frame.
- **T7 `test_dogleg_tree_line_uses_played_line`**: `_dogleg_hole()` fixture, tree cluster 30 y
  LEFT of the first leg at along 200 y → with the hole way: `trees` `line_side == "left"`,
  carry ≈ 200; without it (chord fallback) the side mirrors to `"right"` — pins that trees
  share the polyline frame AND the documented chord exposure, exactly like the bunker test.
- **T8 `test_trees_never_evict_bunker_water`**: 5 bunkers + 1 water (6 bunker/water, cap 5) +
  a qualifying tree cluster → result contains the 5 nearest bunker/water AND the tree entries;
  the same 5 bunker/water survive with and without the trees in the FC.
- **T9 `test_format_orders_trees_last_and_water_never_dropped`**: groups bunker×3 + water×2 +
  trees×2 → line renders 6 groups, water groups present, the dropped group (if any) is trees.
- **T10 `test_crossing_woods_center_band`**: woods ring with >= 3 vertices within the 10 y
  deadband spanning along 180–220 y → `trees C 180-220y` (the honest forced-carry band).
- **T11 `test_far_lateral_trees_ignored`**: 4 tree Points at lateral −90 y (outside 70 y) →
  no trees entries.
- **T12 `test_woods_polygon_and_points_merge_per_side`**: a woods polygon + 2 tree points on
  the same side → one merged range (output independent of feature mix).

**Updates to existing tests:**
- `backend/tests/test_hazards.py::TestFormatHazardsLine::test_groups_capped_at_five` → renamed
  `test_groups_capped_at_six`, 7 distinct groups in, 6 rendered, last-sorted dropped.
- `backend/tests/test_caddie_tools.py` lines 72/92: the carries note string pins updated to
  `"No mapped bunkers, water, or tree lines in play on this hole."`.
- `backend/tests/test_bethpage_validation.py`: new test
  `test_trees_hazards_surface_on_real_bethpage_hole` — assemble from the committed
  `tests/fixtures/bethpage_overpass.json` (offline), pick a Black hole that carries woods/tree
  features in the assembled output (implementation selects it from the fixture, then PINS hole
  number, side, and a ± 15 y carry band computed from the real geometry), assert
  `extract_hole_hazards` emits >= 1 `trees` hazard matching; plus assert a fixture hole with no
  tree features emits none.

## 6. Eval teeth (adversarial, with a RED proof)

**New golden scenarios** in `backend/tests/eval/golden/caddie_advice.jsonl` (schema needs no
changes — `context_hazards_match` / `hazards_line_only_from_input` are type-agnostic):

- **`trees-carry-cited-from-geometry`** (source: `synthetic`): `situation.hole.features` is a
  real GeoJSON FC (tee, green, hole LineString, 4 right-side tree Points at derived carries
  220–300 y) so the PRODUCTION extraction runs; question: `"How far to clear the trees on the
  right?"`. tier1: `context_hazards_match` `[{"type": "trees", "side": "R", "carry": 220}]`,
  `hazards_line_only_from_input`, `prompt_contains_rule HAZARD_GROUNDING_RULE` (both mouths),
  `carries_tool_matches_hazards` (proves the tool mouth carries the tree numbers too).
  tier2_deterministic: `must_mention_any ["220", "300", "tree line", "trees"]`.
  tier2_judge: `grounded_in_hole`.
- **`trees-not-mapped-honest`** (source: `synthetic`): hole with one bunker hazard, zero tree
  data; question: `"How far to carry the trees down the left?"`. tier1:
  `hazards_line_only_from_input`, `prompt_contains_rule HAZARD_GROUNDING_RULE`.
  tier2_deterministic: `must_mention_any ["not mapped", "not in my", "don't have the trees",
  "no tree data"]`. tier2_judge: `grounded_in_hole` ("cites no tree yardage; says tree data
  isn't mapped rather than estimating").

**Mutation test (the PROVABLY-RED requirement)** in
`backend/tests/eval/test_harness_has_teeth.py`:
- `test_context_hazards_match_goes_red_when_trees_stripped_from_features`: build the
  `trees-carry-cited-from-geometry` scenario's Tier1 context twice — once from its FC verbatim
  (check passes), once from a mutated FC with all `featureType in {"tree", "woods"}` features
  removed (check MUST fail). This is the machine-checked proof that the eval detects the exact
  regression this item fixes (re-adding `"tree"`/`"woods"` exclusion, or any future gate that
  drops trees from the data path).

## 7. Gates (exact commands QA runs)

```bash
cd backend && ruff check .
cd backend && python -m pytest tests/test_hazards.py tests/test_tree_hazards.py \
  tests/test_caddie_tools.py tests/test_bethpage_validation.py tests/eval \
  tests/test_voice_stream.py tests/test_realtime_grounding.py tests/test_realtime_tools.py \
  tests/test_epistemic_humility_prompt.py tests/test_input_grounding_prompt.py \
  tests/test_guide_writer.py -q
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npx tsx voice-tests/runner.ts --smoke   # backend-only change: must stay green
```
No docker / no local Postgres: every test above is pure-unit (`_fc(...)` fixtures, the
committed Bethpage Overpass JSON, monkeypatched prompt builders) — DB-backed integration runs
in CI only.

## 8. What the Fable reviewer must falsify

1. **Carry/side across bearings**: T6 (8-bearing sweep) and T7 (dogleg played-line vs chord) —
   try to construct a bearing or dogleg where a tree observation's side flips against the
   pinned LEFT=positive convention or diverges from what an identically-placed bunker reports.
2. **Woods near-edge vs centroid**: T4 — verify the emitted carry tracks the near edge under
   the 70 y lateral window on shapes where centroid and edge diverge (diagonal stands, corner
   wraps); check the window doesn't accidentally silence a legitimately near stand or admit a
   far one.
3. **Coverage-guard threshold honesty**: 3 observations / woods-auto-qualify — probe both
   failure directions: 2 real trees stay silent (no invented line) AND a single mapped woods
   speaks; confirm the asked-about-unmapped-trees path produces "not in my mapped data", never
   "there are no trees", and never a number.
4. **Cap crowding**: T8/T9 — try to construct any input where a bunker or water hazard present
   without trees disappears when trees are added (extraction or formatting).
5. **Additive safety**: old cached `HoleIntelligence` JSONB still validates; the two pinned
   `HAZARD_GROUNDING_RULE` substrings survive; `carries_tool` and guide ground-truth pick up
   trees with no caller edits.
