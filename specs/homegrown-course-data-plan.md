# Homegrown course data (no GolfAPI) — plan + Bethpage Black POC

Owner direction (2026-06-28): stop relying on GolfAPI (metered/expensive); build an
18Birdies-like course-data system from free public data. POC = **Bethpage Black**.

## Feasibility verdict
**Feasible; Bethpage Black ≈ a few focused days** because OSM coverage there is a best case.
**Generalizing to many courses = multi-month** (long tail of poorly-mapped courses →
NAIP digitization / ML). POC the easy case first; treat scale as a separate later track.

## Key empirical findings (live Overpass + service checks)
- **Bethpage Black routing in OSM is excellent:** 90 `golf=hole` ways (5 courses × 18);
  filter `golf:course:name=Black` → all 18 holes with `ref`, `par`, `handicap`. Par
  sequence = 71, matches the published card. **No yardage tags** (get yards from the card).
- **Feature polygons present but UNLABELED:** `golf=green/fairway/tee/bunker` polygons exist
  but carry no course/hole tag → the one new algorithm is a **spatial join** (assign each
  polygon to the nearest Black hole centerline; reject polygons nearest a non-Black hole).
- **3DEP elevation:** USGS 3DEP Elevation ImageServer (`exportImage` AOI GeoTIFF, F32; 1m
  where LIDAR exists — Long Island covered). EPQS point query already in prod (`elevation.py`).
- **NAIP imagery:** USDA NAIP via Microsoft Planetary Computer STAC (COG by bbox); **public
  domain** (matches our "NAIP not Google/Mapbox" rule). Used as the viz/digitization canvas.
- **Licensing nuance:** mapbox-gl as a *renderer* is fine; the rule forbids *digitizing
  geometry from* Mapbox/Google imagery. NAIP raster under the GL layers is compliant.

## Already built + reusable (don't rebuild)
- PostGIS store `courses/tee_sets/holes/hole_yardages/hole_features` (geometry + feature_type
  + jsonb), via `backend/app/services/courses_mapped.py` (`upsert_course` ingests per-hole
  GeoJSON FeatureCollection; `get_course` emits it).
- `backend/app/services/osm.py` (OSM search + live feature fetch — today centroids only).
- `backend/app/services/elevation.py` (EPQS point + `elevation_cache` + green-slope sampler).
- `backend/app/caddie/course_intel.py` `build_hole_intelligence()` (consumer).
- `frontend/src/components/GPSMapView.tsx` (mapbox-gl + turf renderer of CourseCoordinates).
- Stable identity: deterministic UUID v5 from `golfapi-<id>`; reviews key on `course_key`.

## GolfAPI coexistence (load-bearing)
Write homegrown geometry into the **same `courses` row id** (UUID from the course's existing
`golfApiCourseId`). Reviews/identity stay stable (`course_key` untouched). Yardages keep
coming from the card (`hole_yardages`); geometry+elevation become homegrown. A course is
"homegrown" once it has `hole_features` rows; else caddie falls back to GolfAPI + live OSM.
→ **per-course cutover, no big-bang** — stop paying for GolfAPI geometry course-by-course.

## Iterations
### Bethpage POC (prove it)
- **I0** OSM polygon fetch + Black filter — extend `osm.py` `fetch_course_features` to return
  full polygon geometry (`out geom`) + filter holes by `golf:course:name`; add a `User-Agent`
  (Overpass 406'd without one). BE/data, headless.
- **I1** Spatial join: assign polygons → Black holes (nearest hole-line, cross-course
  rejection). Prefer PostGIS `ST_Distance`/`ST_ClosestPoint` (no new dep) over shapely.
  BE/data, headless. (the core new algorithm)
- **I2** Store + render Black: `upsert_course` under Black's deterministic UUID + card
  yardages; render in `GPSMapView` (+ optional NAIP raster). FE+BE.
- **I3** Validate vs published card — par+handicap exact, tee→green yardage within tolerance,
  flag mis-joins. **This is the feasibility gate.** data/QA, headless.
- **I4** 3DEP AOI elevation for Black — one bbox GeoTIFF via ImageServer → sample tee→green +
  green grid → store profile; feed `course_intel`. (maps to `dem-3dep-ingestion` slim +
  `dem-hole-profiles`). BE/data, headless.

### Generalize (the hard, later part)
- **I5** caddie consumes `hole_features` polygons (= `caddie-licensed-hazard-polygons`).
- **I6** per-course homegrown/GolfAPI cutover flag.
- **I7** ingestion pipeline + COG/S3 (= full `dem-3dep-ingestion`); self-host Overpass for bulk.
- **I8** long-tail manual NAIP digitization editor.
- **I9** `dem-nationwide-ml` (ML extraction from NAIP — NEVER Google/Mapbox; defer).
- **I10** on-device plays-like elevation blob.

## Honest risks
Coverage cliff (most courses lack Bethpage's per-hole tags → manual/ML digitization);
multi-course disambiguation where holes interweave; yardages never in OSM (always need a card
source); validation-at-scale QA; compute/cost at scale (S3 COGs, Overpass rate limits, GPU
for ML). POC is ~free; scale is the real spend.

## Critical files
`backend/app/services/osm.py` (I0), `…/courses_mapped.py` (I2 store), `…/elevation.py` (I4),
`backend/app/caddie/course_intel.py` (I5), `frontend/src/components/GPSMapView.tsx` (I2 render),
`backend/supabase/migrations/001_course_mapping_schema.sql` (hole_features schema — reference).
