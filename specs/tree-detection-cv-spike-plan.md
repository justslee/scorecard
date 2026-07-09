# Feasibility Spike Plan — Tree detection from satellite imagery (classical CV)

> Contract for the spike build (2026-07-09). This is a RESEARCH SPIKE, not a feature.
> Nothing here wires into the live caddie. Classification: **SILENT** — no user-visible
> change; committed surface is one script, one pure-geometry helper module, its tests,
> and the findings doc.

Owner question this answers: *"Can we detect trees from the satellite map so the caddie
can say how far to clear the trees — do we need to train an ML model?"*
Spec source: `specs/caddie-physics-engine.md` §"P2 — Tree detection (satellite CV)".
An honest **DISPROVE** ("classical CV can't separate trees from turf reliably; here's
the evidence; the pretrained-model path would cost X") is a fully valid outcome.

---

## 0. Verified ground truth

- Trees are NOT surfaced to the caddie today. The hazard path handles only `bunker`/`water`:
  `backend/app/caddie/hazards.py` `_HAZARD_FEATURE_TYPES = frozenset({"bunker", "water"})`,
  `_SEVERITY_BY_TYPE = {"water": "death", "bunker": "moderate"}`, consumed inside
  `extract_hole_hazards`. `HAZARD_GROUNDING_RULE` already names "trees" as a thing the
  model may only speak about when data exists — the honest fallback is live.
- **BUT the OSM ingest already fetches trees** (`backend/app/services/osm.py`:
  `natural=tree` → `featureType:"tree"` Points, `natural=wood`/`landuse=forest` →
  `featureType:"woods"` Polygons) and stores them in PostGIS `hole_features`. They are
  simply excluded from the caddie by the two-line gate above.
- Hole features persist in PostGIS `public.hole_features (hole_id, feature_type, tee_set_id,
  geom, properties)` via `backend/app/services/courses_mapped.py`; ingest runs once per
  course and already does cached-forever enrichment (elevation) — the exact pattern tree
  canopy would follow if a CV path were feasible.
- **Tile source (probed, works):** ESRI World Imagery XYZ, server-side, **no API key**:
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
  — note **y before x**. 256×256 JPEG. Ground resolution `156543.03392 · cos(lat) / 2^z`
  m/px → at Bethpage (40.744°), z18 ≈ **0.45 m/px**, z19 ≈ **0.23 m/px**. Google Maps tiles
  are client-SDK-only; ToS forbids server scraping — ESRI is the realistic ingest source.
- **Test corridors (real, from OSM Overpass):** Bethpage Black — classic tree-lined
  parkland. Black 1: tee (40.742998, −73.454575) → green (40.745071, −73.451351). Also
  Black 15, 18 tee/green coords.
- Backend deps (`backend/pyproject.toml`): NO numpy/Pillow/opencv/torch — that stays true.
  The spike runs in an isolated venv. No local Postgres; committed tests must be pure.

## 1. The key technical tension (confront it, don't dodge it)

A golf course is ALL green. Fairway, rough, and greens are grass; trees are also green.
RGB tiles have **no near-infrared band**, so true NDVI is impossible, and any
vegetation-index threshold (ExG = 2G−R−B) segments *vegetation* — it CANNOT separate
canopy from mown turf. Color is only useful as a NEGATIVE filter (exclude sand, cart
paths, water, buildings).

The real discriminators at 0.2–0.5 m/px are:
1. **Texture** — tree canopy is bumpy: high local variance from crown structure and
   inter-crown gaps. Mown turf is the smoothest surface on the property.
2. **Shadow** — crowns cast hard dark shadows and adjacent-crown gaps read near-black.

The classical baseline is therefore **color ∧ texture (∨ shadow adjacent to textured
vegetation)** — if that cannot find Bethpage Black's tree lines cleanly, the verdict
section says so with pictures, and the pretrained-model fallback (§3) is discussed with
its dependency cost stated honestly.

## 2. Classical-CV baseline — exact math

All raster work in the spike script only (numpy + Pillow, isolated venv).
- **Vegetation gate (color, negative filter):** `ExG = 2G − R − B`; vegetation := `ExG > T_exg`.
  Excludes bunkers, paths, roofs, water; keeps ALL grass and trees.
- **Texture (the discriminator):** local std-dev of luminance `L = 0.299R+0.587G+0.114B`
  in a `w×w` window (`w = 9` px, ≈ crown scale), via integral-image box filter (pure numpy).
  textured := `std > T_tex`.
- **Combination + morphology:** `canopy = veg ∧ textured`, then binary open (despeckle) +
  close (bridge crown gaps); drop tiny components.
- **Carry-to-clear geometry:** sample the tee→green line, record contiguous canopy runs
  `[start_yd, end_yd]`; carry-to-clear = far edge of the run on the line. Same carry/side
  vocabulary `hazards.py` uses.

## 3. Pretrained-model fallback — named, costed, NOT added

Only if the baseline is inadequate:
- **DeepForest** (tree-crown detection, RetinaNet, trained on NAIP aerial imagery — the
  closest match). Cost: `deepforest` + `torch` + `torchvision` ≈ 2+ GB of wheels, weights
  download, slow CPU inference — a real dependency and deploy-weight decision. **NOT
  installed** in the spike. It detects crown *shape/texture*, not greenness, so it degrades
  more gracefully on leaf-off imagery and does not false-fire on bunkers — the honest
  answer to "do we need a model?" is: no *training* either way; the real question is
  pretrained-model *inference* vs. classical CV vs. just using the OSM data we already have.

## 4. Deliverables — files and exact split

**Committed (minimal, pure, tested):**
1. `backend/scripts/tree_spike_geometry.py` — pure stdlib math, **no numpy** (importable
   under the app venv so tests run in CI with zero new deps): slippy `latlng↔tile` math,
   `meters_per_pixel`, `corridor_bbox`, `carry_yards`, `runs_from_bools` (carry-to-clear
   interval math).
2. `backend/tests/test_tree_spike_geometry.py` — pure unit tests, NO DB / NO network.
3. `backend/scripts/tree_detect_spike.py` — the harness (numpy/Pillow, isolated venv only;
   guarded imports with a friendly "create the spike venv first" message). Fetches ESRI
   tiles for a corridor, runs the detector, writes raw + overlay PNGs + a stats line.
4. `specs/tree-detection-cv-findings.md` — the real findings + verdict.

**NOT committed:** the spike venv, tiles, PNGs (under gitignored `backend/data/`).
**No change to `backend/pyproject.toml` or `uv.lock`. No app code touched.**

## 5. What to MEASURE for the verdict (pre-committed criteria)

1. Recall on the tree lines a golfer cares about (human judgment vs raw tile).
2. False positives — what got labeled canopy that isn't (bunker edges, buildings, paths).
3. Is carry-to-clear usable, or does a false positive invent a fictional number (worse
   than "trees aren't mapped here" per the NORTHSTAR no-fake-data rule)?
4. Parameter fragility across holes.
5. Verdict: FEASIBLE (classical) / FEASIBLE-WITH-MODEL (name DeepForest cost) / INFEASIBLE.

## 6. How it WOULD feed the caddie IF feasible (sketch only — DO NOT build)

Ingest step writes canopy polygons to `hole_features` with `feature_type='tree'`; read
path adds `"tree"` to `_HAZARD_FEATURE_TYPES` + a severity, and `extract_hole_hazards`
emits tree carry/side through the SAME polyline-frame math as bunkers/water. None of this
is in the spike diff — it is the integration contract to verify against.

## 7. Risks / edge cases

Tile ToS (bulk scraping restricted; ingest volume tiny but needs a production ToS read);
zoom vs crown size; **shadow direction bias**; corridor-width assumption (chord misses
dogleg-corner trees); coordinate registration offset; **seasonality — leaf-off deciduous
canopy loses ExG and texture contrast**; dark water / cloud shadow; JPEG blockiness.

## 8. Gates

1. `cd backend && uv run ruff check scripts/tree_spike_geometry.py scripts/tree_detect_spike.py tests/test_tree_spike_geometry.py`
2. `cd backend && uv run pytest tests/test_tree_spike_geometry.py` — pure, no DB, no network.
3. Spike run evidence: raw + overlay PNGs + stats for ≥ 2 real Bethpage holes, recorded in
   `specs/tree-detection-cv-findings.md`.
4. `git diff` sanity: `pyproject.toml`/`uv.lock` untouched; no `backend/app/` change.
Classification: **SILENT** (research spike; zero user-visible change).
