# Plan: Assign relation-MultiPolygon bunkers in the spatial join (Red-9 waste-bunker fix)

_Fable plan, 2026-07-16. Follow-up from the guide-safe prod re-ingest: the extended
osm.py query fetched the Red-9 waste complex (relation[golf=bunker] id 19545022, a
MultiPolygon) but the spatial-join assembly DROPPED it, so per-hole bunker counts came
out byte-identical._

## Problem (verified against the worktree)
`assign_features_to_holes` in `backend/app/services/course_spatial.py` dispatches on
`geom_type` at L399–415: `"Point"` and `"Polygon"` are handled; everything else hits the
`else` at L412–415 → `assignments[osm_id] = (None, None, float("inf")); continue`. A
relation bunker (e.g. relation/19545022) arrives as ONE Feature with
`geometry.type == "MultiPolygon"`, lands in the `else`, and is then filtered out by
`build_course_feature_collection` (L615: `course_name is None` → `continue`). Upstream
parse/fetch and downstream consumers are already MultiPolygon-correct; this dispatch is the
only gap.

## Change (one function + one tiny helper)

**File:** `backend/app/services/course_spatial.py`

1. **Helper `_ring_area(ring)`** — module-level, next to `_ring_centroid` (~L276), matching
   surrounding style. Returns the absolute planar shoelace magnitude of a ring (exclude the
   closing duplicate vertex the same way `_ring_centroid` does). No latitude scaling — it is
   only used to *rank* member polygons of one complex, whose members share a latitude; an
   unscaled magnitude orders them correctly. Say so in the docstring so nobody "fixes" it.

2. **New `elif geom_type == "MultiPolygon":` branch** between the `Polygon` branch (ends
   L411) and the `else` (L412):
   - `coords_raw` is a list of polygons, each a list of rings. Iterate members; a member is
     *usable* if it is non-empty, its outer ring `member[0]` is non-empty and has ≥ 4 points.
   - Pick the usable member whose outer ring has the largest `_ring_area`; set
     `outer_ring = largest_member[0]` and `clon, clat = _ring_centroid(outer_ring)`.
   - If **no** usable member exists, keep the existing drop:
     `assignments[osm_id] = (None, None, float("inf")); continue`.
   - Then fall through — Tier 1 (centerline-through-polygon overlap, L420–449), Tier 2
     (ring-vertex voting, L451–497), Tier 3 (centroid-nearest-line, L499–517) run
     **unchanged** on the representative ring. The Red-9 complex's main sand body straddles
     hole 9's centerline, so Tier 1 assigns it to hole 9; the existing bunker corridor cap
     (`_CORRIDOR_CAPS_M["bunker"] = 150.0`, L71) still applies at emission.

3. **Doc touch-ups (no behavior):** the `polygons` arg docstring L376–378 says
   `geometry.type == "Polygon"` — extend to "Polygon or MultiPolygon". Optionally amend the
   Tier-1 header comment "(Polygon only)" at L420.

**Verified non-changes (leave alone):**
- `build_course_feature_collection` woods/rough size filter (L637–649) reads
  `geom["coordinates"][0]` as a ring, wrong for a MultiPolygon — but it only runs for
  `feature_type in ("woods", "rough")`; relation bunkers carry `featureType == "bunker"` and
  never reach it.
- Assemble path: `osm_ingest.assemble_osm_course` flattens the `bunkers` bucket into
  `polygons` → `build_course_feature_collection`'s `poly_by_id` keys on `properties.osm_id`
  (which relation Features carry, `relation/<id>`); emission copies `geometry` verbatim, so the
  MultiPolygon flows to storage intact. No change needed.
- `osm.py` fetch/parse (relation golf=bunker + natural=sand) — already correct, out of scope.

## Tests

**File:** `backend/tests/test_course_spatial.py` — reuse `_make_hole` (L51) and
`_make_polygon` (L74); add a small `_make_multipolygon_bunker(osm_id, members)` local helper
(members = list of (center_lon, center_lat, half_deg) squares) emitting
`{"type": "MultiPolygon", "coordinates": [[ring], ...]}`.

New test class `TestMultiPolygonBunkerAssignment` with a self-contained hole-9 fixture:

1. **RED→GREEN:** MultiPolygon bunker with ≥ 2 members, largest member square straddling
   hole 9's centerline → `assign_features_to_holes` returns `("9", "Red", d)` with `d` under
   the 150 m bunker cap; and `build_course_feature_collection(holes, polys, "Red")` emits it
   under hole number 9 with `geometry.type == "MultiPolygon"` preserved.
2. **Multi-member correctness:** same complex plus a small decoy member nearer the neighbouring
   hole's line → still assigned to hole 9 (largest-member rule + Tier 1).
3. **Degenerate guard:** MultiPolygon whose members are all empty/`< 4`-point rings →
   `(None, None, inf)` (existing drop preserved).
4. **Regression pin:** run `assign_features_to_holes(ALL_HOLES, ALL_POLYGONS)` and the same
   call with the MultiPolygon bunker appended; assert the assignments for every pre-existing
   osm_id are **equal** in both runs (byte-identical way-bunker behavior, no cross-hole spam).

**Parse side:** `backend/tests/test_osm_parsing.py` already asserts relation golf=bunker /
natural=sand land in the `bunkers` bucket (v1.1.9 field-test fix). Confirm those pass; add a
one-line assertion that the relation bunker Feature's `geometry.type == "MultiPolygon"` only if
not already asserted there.

## Gates
- `cd backend && ruff check .`
- `cd backend && uv run pytest tests/test_course_spatial.py tests/test_osm_parsing.py` — pure
  logic, no DB required locally.
- CI's backend gate runs the full `uv run pytest` with the Postgres+PostGIS service, which
  includes DB-backed ingest tests (`tests/test_ingest_osm_course.py`, `tests/integration/`)
  exercising the assemble path end-to-end — must stay green; no local DB run needed.

Scope: one `elif` branch + one ~10-line helper + docstring touch-ups in one function, plus one
test class. No API, schema, or consumer changes. SILENT (ingest correctness); the visible
payoff needs the Red-only data re-run (backlog `red9-relation-bunker-rerun`).
