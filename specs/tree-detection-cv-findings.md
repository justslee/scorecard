# Tree detection from satellite — feasibility spike FINDINGS

**Date:** 2026-07-09 · **Classification:** SILENT (research spike, no user-visible change)
**Question (owner):** *"Can't you detect trees from the satellite map so the caddie can
say how far to clear the trees — do we need to train an ML model?"*
**Plan:** `specs/tree-detection-cv-spike-plan.md` · **Spec:** `specs/caddie-physics-engine.md` §P2

---

## Verdict (one line)

**Classical CV over the satellite tile is NOT reliable enough to feed the caddie tree
carry numbers unattended — DISPROVEN on real Bethpage data. No ML model needs to be
*trained*. The owner's goal is far better served, and much cheaper, by surfacing the
tree/woods data OSM ALREADY gives us and the app ALREADY ingests (a ~2-line gate change),
with a pretrained crown-detector (DeepForest, no training) held in reserve only if
measured OSM coverage proves inadequate.**

Go/no-go: **NO-GO** on building satellite-CV canopy detection now. **GO** (as a separate
small feature) on surfacing existing OSM trees to the caddie.

---

## What was tested (real, reproducible)

- **Tile source:** ESRI World Imagery XYZ, **no API key**, fetched server-side. Confirmed
  working: `.../World_Imagery/MapServer/tile/{z}/{y}/{x}`, 256×256 JPEG, z19 ≈ 0.23 m/px,
  z18 ≈ 0.45 m/px at Bethpage's latitude. (Google Maps tiles are client-SDK-only and the
  ToS forbids server scraping — ESRI is the realistic ingest source.)
- **Holes:** 3 real Bethpage Black corridors (tee→green from OSM Overpass): Black 1
  (390 yd), Black 15 (473 yd), Black 18 (414 yd). Bethpage Black is a classic tree-lined
  parkland course — a fair, generous test for tree detection.
- **Detector (classical, no ML):** Excess-Green (ExG = 2G−R−B) vegetation gate ∧ high
  local-texture (std-dev of luminance in a 9-px window), morphological cleanup. Method +
  code: `backend/scripts/tree_detect_spike.py`.
- **Evidence figures** (raw | CV canopy | OSM trees+woods), committed:
  `specs/tree-detection-cv-figures/black_{1,15,18}_compare.jpg`.

## Measured results

All numbers below are the actual stdout of `backend/scripts/tree_osm_compare.py` on the
three corridors (see Reproduce). OSM is a live database, so the tree-node/woods-poly
counts drift by a few as volunteers edit — the counts here are a representative query
(2026-07-09); the CV and ExG numbers are deterministic from the tiles.

| Hole | CV canopy % | OSM tree nodes | OSM woods polys | mean ExG (corridor / in-woods) | CV recall inside OSM woods |
|------|-------------|----------------|-----------------|-------------------------------|----------------------------|
| Black 1  | 12.5% | ~63 | 0 | 63.8 / — | — (no woods poly) |
| Black 15 | 10.0% | ~62 | 3 | 55.6 / **20.2** | **11.6%** |
| Black 18 | 10.9% | ~43 | 2 | 60.5 / **31.4** | **14.3%** |

Greenness check (ExG on 0–255 channels): whole-corridor mean ExG 55.6–63.8, but inside
OSM-mapped woodland ExG 20.2–31.4 — i.e. **tree canopy is LESS green than the fairway**.
A green-index gate therefore keeps turf strongly and trees weakly — backwards from what
we want, and exactly why classical colour segmentation fails here.

## Why classical CV fails (honest, evidence-backed)

1. **Systematic false positives on man-made edges.** Every bunker gets a red canopy ring
   in the overlays (the grass↔sand transition pixels are green *and* high-texture); the
   clubhouse and cart-path edges also fire. A false positive on the shot line would invent
   a *fictional* "carry to clear the trees" number — worse than the honest "trees aren't
   mapped here" (violates the NORTHSTAR no-fake-data rule). See `black_1_compare.jpg`,
   `black_18_compare.jpg` (middle panel — red rings around all bunkers).
2. **Leaf-off imagery breaks it.** The Black 15 tile is a winter/leaf-off capture: bare
   brown deciduous canopy. ExG collapses on brown trees, so CV caught only ~12% of the
   dense woodland the human eye sees. ESRI's capture date is not controllable and is often
   winter in the northeast — a fundamental limit of a greenness-based method.
   See `black_15_compare.jpg` (dense bare trees top/right; sparse red detection).
3. **Under-detection of real canopy.** Inside OSM-mapped woodland, CV flagged only
   **11–14%** of pixels as canopy. (Reference is coarse — OSM woods polygons include some
   scrub/gaps — but the direction is unambiguous.)
4. **Parameter fragility.** Raising texture/veg thresholds to recover canopy recall
   explodes the bunker/edge false positives; there is no single threshold set that is both
   sensitive to canopy and clean on turf edges across the three holes. Per-hole hand-tuning
   is infeasible at ingest scale.

CV does show real signal — it catches in-leaf tree lines (Black 1 right side, Black 18
left side) and standalone dark-green trees — but not cleanly enough to trust unattended.

## The cheaper answer the spike uncovered

**Trees are already in our pipeline.** `backend/app/services/osm.py` already fetches
`natural=tree` (→ `featureType:"tree"` points) and `natural=wood`/`landuse=forest`
(→ `featureType:"woods"` polygons), and `osm_ingest.py` stores them per hole in PostGIS
`hole_features`. A course-wide Overpass query of the Bethpage State Park bbox returned
**537 tree nodes + 73 woods/scrub polygons (~1.01 km²)** (live count, 2026-07-09). They
are simply **excluded from the caddie** by two lines in
`backend/app/caddie/hazards.py`:

```
_HAZARD_FEATURE_TYPES = frozenset({"bunker", "water"})   # add "tree"/"woods"
_SEVERITY_BY_TYPE = {"water": "death", "bunker": "moderate"}  # + a tree severity
```

Adding `tree`/`woods` there routes them through the **same** `extract_hole_hazards` carry/
side math and `format_hazards_line` spoken output as water and bunkers — the caddie could
answer "trees down the right from ~230" with zero new dependency, zero new tile fetch, and
season-independent data. OSM tree coverage is **incomplete** (volunteer-mapped; the
per-hole comparison shows real gaps on continuous tree lines), so the honest
"trees aren't mapped here" fallback must stay where coverage is thin.

## Do we need to train a model? — No.

- **No custom training** is warranted or needed.
- **Best first step (recommended):** surface the OSM tree/woods we already have (small
  feature — the gate change above + a per-hole coverage guard + the honest fallback).
- **Reserve, only if OSM coverage proves inadequate on courses we care about:** a
  **pretrained** tree-crown detector — **DeepForest** (RetinaNet trained on NAIP aerial
  imagery). It keys on crown *shape/texture*, not greenness, so it degrades more gracefully
  on leaf-off imagery and does not false-fire on bunkers. **Cost, honestly:** `deepforest`
  + `torch` + `torchvision` ≈ 2+ GB of wheels, model-weight download, slow CPU inference —
  a real dependency and deploy-weight decision. **NOT added by this spike.** If pursued, it
  reuses this spike's tile-fetch / corridor / overlay / carry-to-clear harness verbatim.

## Recommendation / go-no-go for a full feature

1. **NO-GO** on a satellite-CV canopy feature at ingest — classical CV is too noisy
   (fictional carry numbers, leaf-off failure) to ship unattended.
2. **GO** (separate small ticket) on *"surface existing OSM trees to the caddie"*: the
   2-line hazard gate + coverage guard + honest fallback + a couple of hazards.py tests.
   This directly answers "how far to clear the trees" on well-mapped courses, today, for
   free.
3. If, after (2), a target course has poor OSM tree coverage, open a **second spike** to
   evaluate pretrained **DeepForest** on this harness — a scoped inference cost, still no
   training. Only then is any ML dependency justified.

## Reproduce

```
python3 -m venv /tmp/tree-spike-venv
/tmp/tree-spike-venv/bin/pip install numpy Pillow requests

# CV-only (raw + canopy overlay, canopy %):
/tmp/tree-spike-venv/bin/python backend/scripts/tree_detect_spike.py \
  --tee 40.742998,-73.454575 --green 40.745071,-73.451351 --label black-1 \
  --zoom 19 --out /tmp/tree-spike-out

# The FULL comparison behind every number + figure in this doc (CV %, OSM node/poly
# counts, mean ExG corridor vs in-woods, CV recall inside OSM woods, 3-panel figure):
/tmp/tree-spike-venv/bin/python backend/scripts/tree_osm_compare.py \
  --tee 40.745894,-73.450704 --green 40.749638,-73.452077 --label black-15 \
  --out /tmp/tree-spike-out
```

`tree_osm_compare.py` is the source of the results table and the committed figures in
`specs/tree-detection-cv-figures/` (it hits Overpass live, so tree/woods counts may drift
a few). The pure geometry helpers (`backend/scripts/tree_spike_geometry.py`) are covered
by `backend/tests/test_tree_spike_geometry.py` (runs in CI, no numpy/DB/network).
