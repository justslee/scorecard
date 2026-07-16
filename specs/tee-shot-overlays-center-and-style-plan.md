# Tee-Shot Overlays Polish: Fairway-Centered Plates + Distinct Bunker Glyph — Implementation Plan

Owner-invited polish on the SHIPPED tee-shot yardage overlays (specs/tee-shot-yardage-overlays-plan.md). Two asks, verbatim intent:

1. "Ideally the markers are always in the CENTER OF THE FAIRWAY." — the 200/150/100 plates sit on the raw `golf=hole` centerline, which on Bethpage Red hugs one side of / drifts off the fairway. Move them to the fairway's lateral center at the same distance band. Distance to green stays exactly true.
2. "The BUNKER markers should look DIFFERENT from the yardage markers. The white marker gets confusing. That UI could look cooler." — the bunker near-edge dot is today a white radius-3 native circle, visually identical to the white 150 plate. Give bunkers a distinct glyph in the yardage-book language, and clean up the overlay UI, restrained.

NORTHSTAR constraint: printed-yardage-book feel — ink/paper/tee palette, calm, never SaaS/neon. The designer reviews the RENDERED result as a BLOCKING gate.

---

## Part A — Fairway-center the plates (pure geometry)

### A.0 Module + reuse decision

All new math goes in `frontend/src/lib/map/tee-shot-overlays.ts`, which is import-free by design and mirrors `backend/app/caddie/hazards.py` conventions (it already ports `_project_onto_polyline`, hazards.py:261). Checked `frontend/src/lib/course/hole-projection.ts` for reusable helpers: it has `pointToSegmentDistanceM` (line 209) and corridor predicates (`isInHoleCorridor`, line 250) — point-to-segment DISTANCE math, not line/ring INTERSECTION math, and it lives in a different projection family (`projectLatLng`, its own metre frame). **Decision: do not import from hole-projection.ts. Port the backend's own ray/ring helpers locally** — the backend already has exactly this engine in `extract_corridor_profile` (hazards.py:991): `_ray_segment_distance` (838, Cramer's rule), `_cast_ray_to_ring` (858), `_point_in_ring_xy` (816), `_sample_point_and_heading` (887, local heading at a station). Keeps frontend/backend as the same math, same as the rest of the module.

### A.1 New constants (tee-shot-overlays.ts, Constants section after line 93)

```ts
/** Perpendicular cast cap, each side — mirrors backend _CORRIDOR_MAX_CAST_YDS
 *  (hazards.py:128). Bounds work and degenerate-geometry runaway. */
const FAIRWAY_CAST_CAP_YARDS = 100;
/** Max gap between a plate's centerline station and the nearest fairway
 *  cross-section span before we refuse to re-center (honesty guard: a
 *  centerline >20y off the mapped fairway is suspect data — leave the plate
 *  where the honest centerline math put it). */
const FAIRWAY_SNAP_MAX_GAP_YARDS = 20;
```

### A.2 New exported helpers (tee-shot-overlays.ts, "Internals (exported for tests)" section)

```ts
/** Outer rings of every featureType==="fairway" Polygon/MultiPolygon —
 *  mirrors backend extract_corridor_profile's ring collection
 *  (hazards.py:1056-1082): Polygon -> coordinates[0]; MultiPolygon -> each
 *  member's outer ring as an independent polygon; closing vertex deduped;
 *  rings with <3 vertices dropped. */
export function fairwayRingsFromFeatures(features: GeoJSON.Feature[]): LatLng[][]

/** Even-odd point-in-ring test on LatLng, evaluated in a local
 *  equirectangular frame anchored at p (cosLat = cos(p.lat)) — TS port of
 *  backend _point_in_ring_xy (hazards.py:816). Exported for tests and used
 *  as the final "midpoint inside fairway" guard. */
export function latLngInRing(p: LatLng, ring: ReadonlyArray<LatLng>): boolean

/** Lateral fairway midpoint on the perpendicular cross-section through
 *  `station`, or null (caller falls back to `station`). segA->segB is the
 *  centerline segment the station lies on — its direction is the LOCAL hole
 *  heading (dogleg-correct, never a tee->green chord). */
export function fairwayCenterAtStation(
  station: LatLng,
  segA: LatLng,
  segB: LatLng,
  fairways: ReadonlyArray<ReadonlyArray<LatLng>>,
): LatLng | null
```

### A.3 The cross-section math (exact — builder must not re-derive)

All in ONE local equirectangular XY frame, the module's existing convention (`LAT_M = 111_320`, cosLat pattern of `greenEndLateralOffsetMeters`, lines 174-188). No second projection.

**Frame** — origin at the station P, cosLat at the station's own latitude:

```
cosLat = cos(P.lat · π/180)
toXY(q) = ( (q.lng − P.lng) · LAT_M · cosLat,  (q.lat − P.lat) · LAT_M )      // P maps to (0,0)
```

**Local heading and normal** — from the segment the plate landed in:

```
(ax,ay) = toXY(segA); (bx,by) = toXY(segB)
(dx,dy) = (bx−ax, by−ay);  L = hypot(dx,dy);  if L ≤ 0 → return null
u = (dx/L, dy/L)          // local hole heading (sign irrelevant: a line, not a ray)
n = (−uy, ux)             // left-perpendicular (module-pinned convention, hazards.py:1105)
```

**Line–edge intersection** (two-sided version of backend `_ray_segment_distance`, hazards.py:838; Cramer's rule on `P + t·n = a + s·(b−a)` with P at the origin). For each ring, iterate its edges with closed wrap-around (`b = ring[(i+1) % nVerts]` after dedupe), each vertex pair mapped by `toXY`:

```
(ex,ey) = (bx−ax, by−ay)
det = ex·ny − ey·nx;              if |det| < 1e-9 → skip (parallel)
t = (ex·ay − ey·ax) / det         // signed offset along n from the station
s = (nx·ay − ny·ax) / det         // position along the edge
accept t iff  0 ≤ s < 1  AND  |t| ≤ FAIRWAY_CAST_CAP_YARDS · 0.9144
```

The half-open `0 ≤ s < 1` prevents double-counting shared vertices (same rule as backend).

**Interior spans per ring** — sort the accepted `t` values ascending. If the count is ODD (tangency/vertex-graze degeneracy) → skip this ring entirely. Consecutive pairs `(t0,t1), (t2,t3), …` are the fairway's interior spans on the cross-section line (even-odd parity).

**Span selection across all rings** (rule, pinned):
1. A span with `t_lo ≤ 0 ≤ t_hi` (the station is INSIDE that fairway ring on this cross-section) wins. If more than one ring yields a containing span (overlapping rings), take the FIRST in `fairways` array order — mirrors the backend's first-inside-ring `break` (hazards.py:1104-1108).
2. Otherwise (station off the fairway — the Bethpage "drifts off" case): among all spans of all rings, compute `gap = t_lo > 0 ? t_lo : −t_hi` (distance from the station to the span's near edge). Take the span with minimal gap iff `gap ≤ FAIRWAY_SNAP_MAX_GAP_YARDS · 0.9144`; ties → first in array order. This moves the plate INTO the real fairway across a real, measured edge crossing — never fabricated.
3. No span at all, or nearest gap over the cap → return null.

**Midpoint and inverse frame**:

```
m = (t_lo + t_hi) / 2
Q.lat = P.lat + (m · ny) / LAT_M
Q.lng = P.lng + (m · nx) / (LAT_M · cosLat)
```

**Final guard**: `latLngInRing(Q, selectedRing)` must be true, else return null. (For the nearest-pair-around-an-interior-point case this holds by construction; the check is numerical-edge insurance and the spec's explicit "never outside the fairway" promise.)

**Distance honesty (state in the module docstring):** the station's along-centerline arc distance to green center — the plate's semantic (the module already prefers along-path over straight-line on doglegs; test 2 requires >20y divergence from the chord) — is EXACTLY unchanged: we move only along the perpendicular through the station. The straight-line distance from the plate to green center changes by `√(D² + d²) − D ≤ d²/(2D)` (second order): a 10y lateral shift at the 100 plate is +0.5y; even a worst-case 25y shift at 100y is +3.1y. The heading is the LOCAL segment direction, so on a dogleg the cross-section is perpendicular to the correct leg.

### A.4 Integration point (chosen signature)

Extend `distanceMarkersFromGreen` with an optional 4th parameter — NOT a wrapper (a wrapper would have to re-discover which segment each marker lies on via projection, duplicating work and adding vertex-boundary edge cases; the segment `(a, b)` is already in hand at the push site, line 227-238):

```ts
export function distanceMarkersFromGreen(
  centerline: LatLng[],
  greenCenter: LatLng,
  distancesYds: readonly number[] = [100, 150, 200],
  fairways?: ReadonlyArray<ReadonlyArray<LatLng>>,   // NEW, optional
): DistanceMarker[]
```

At the push site (inside the `if (cum + segLen >= targetM)` block, ~line 229):

```ts
const position = { lat: a.lat + t*(b.lat-a.lat), lng: a.lng + t*(b.lng-a.lng) };
const centered = fairways && fairways.length > 0
  ? fairwayCenterAtStation(position, a, b, fairways)
  : null;
markers.push({ yards: targetYd as 100|150|200, position: centered ?? position });
```

All existing call sites (every test, `computeTeeShotOverlays`) pass ≤3 args → `fairways` undefined → **byte-identical output** to today.

`computeTeeShotOverlays` (line 468-469) becomes:

```ts
const markers = centerline
  ? distanceMarkersFromGreen(centerline, args.green, [100, 150, 200], fairwayRingsFromFeatures(features))
  : [];
```

Update the `DistanceMarker.position` doc comment (line 45): "At the plate's distance station — laterally centered in the fairway when fairway geometry allows it, else the interpolated point ON the hole centerline."

### A.5 Honesty / fallback table (every row byte-identical to today's output when it fires)

| Condition | Behavior |
|---|---|
| `fairways` omitted (all existing callers/tests) | identical to today |
| No `featureType:"fairway"` feature in the hole | `fairwayRingsFromFeatures` → `[]` → identical to today |
| Ring < 3 vertices / Point/LineString fairway geometry | ring dropped at extraction |
| Degenerate segment at the station (`L ≤ 0`) | null → centerline position |
| Odd crossing count on a ring (tangency) | that ring skipped |
| Perpendicular crosses no fairway within ±100y | null → centerline position |
| Station outside fairway and nearest span gap > 20y | null → centerline position |
| Computed midpoint fails `latLngInRing` | null → centerline position |
| Any null from the helper | plate keeps today's exact centerline point; distance semantics unchanged in every branch |

Never fabricate a center. Never move a plate outside the fairway. Never change the along-hole distance.

### A.6 Pure tests (append to `frontend/src/lib/map/tee-shot-overlays.test.ts`, existing `destPoint`/`northOf`/`eastOf`/`makeHoleLine` fixture style; add a `makeFairwayPolygon(points: LatLng[])` builder identical to `makeBunkerPolygon` but `featureType:"fairway"`)

- **14a. Straight hole, offset fairway → plates move to the lateral center; distance unchanged.** `buildStraightHole(400, 10)` (due-north centerline). Fairway rectangle: along 60→360y south of green, lateral span [−35y, +15y] east of the centerline → lateral center at −10y (10y west). Assert for each of 100/150/200: (i) `perpDistanceYards(m.position, tee, green)` ≈ 10 (±0.5) and the shift is westward; (ii) `|metersBetween(m.position, green)/YD − m.yards| < 1` (√(100²+10²) = 100.5 — the second-order bound in action); (iii) result differs from the 2-arg (uncentered) call.
- **14b. Dogleg → centered using the LOCAL leg heading, not the chord.** Test-2 fixture (green; corner 130y south; tee 300y east of corner — leg 2 runs east-west). Fairway rectangle along leg 2 (20→280y east of corner), lateral span [−6y south, +18y north] of the leg-2 line → center +6y north. Assert for the 200 plate: (i) lateral distance from the corner→tee line ≈ 6y; (ii) `metersBetween(centered, uncentered)` ≈ 6y and the displacement is due NORTH (Δlng < 0.1y) — a tee→green-chord perpendicular would have a large east-west component, so this proves the local heading; (iii) the along-leg position preserved.
- **14c. No fairway → byte-identical.** `distanceMarkersFromGreen(cl, green, [100,150,200], [])` and the same with a features list containing no fairway `toEqual` the 2-arg call, element by element.
- **14d. Perpendicular misses / gap too large → fallback.** (d1) fairway rectangle entirely 30→60y east of the centerline (gap 30 > 20) → every plate equals the uncentered plate exactly. (d2) fairway along-range 220→360y only → 100/150 plates (perpendicular misses the polygon) equal uncentered; the 200 plate centers.
- **14e. Result proven INSIDE the fairway.** For every centered plate in 14a/14b/14f: `expect(latLngInRing(m.position, fairwayRing)).toBe(true)`.
- **14f. Off-fairway snap (Bethpage "drifts off" case).** Fairway lateral span [+5y, +45y] east — station 5y outside (≤ 20y cap) → plate centers at +25y east (span midpoint, ±0.5y), and `latLngInRing` true.
- **14g. Split fairway (MultiPolygon / two polygons).** Two rectangles, lateral spans [−25, +5] and [+15, +40]; station at 0 is inside the first → centered at −10y in the FIRST polygon; the second is ignored (containing-span rule beats nearest-gap).

---

## Part B — Distinct bunker glyph + cooler overlay UI (render layer)

### B.1 Glyph concept: a small sand "bean" with an ink outline (bundled PNG marker)

Printed yardage books draw bunkers as **outlined sand shapes** — that is the canonical symbol in this design language. Recommended glyph: an asymmetric rounded bean/kidney of muted sand tone, thin `T.ink` outline, 2–3 tiny ink stipple dots, soft ink halo for satellite contrast (same halo idiom as the tee markers).

Why this over the alternatives:
- **Open ink ring** — still round; at 20px on satellite it stays in the same shape family as the plates, so the confusion survives at a glance. Rejected.
- **Stipple-only cluster** — disappears against busy fairway/sand imagery at chip size. Rejected.
- **Sand bean + ink outline** — distinct at the SHAPE level (works over any imagery and for colorblind users, not just a color swap), literal yardage-book symbolization, and the ink outline carries contrast even when the marker sits on real bright sand.

Rendering idiom: **bundled PNG via `addMarker({ iconUrl })`, exactly the tee-marker idiom** (`teeMarkerIconUrl`, google-map-helpers.ts:462-466). Bundled PNGs DO load on iOS; runtime data-URL/canvas icons do NOT (documented platform constraint in `addTeeShotOverlays`, GoogleSatelliteMap.tsx ~486). Tradeoff vs today's native circle: a circle's radius is metres (scales with zoom); a marker's `iconSize` is screen px (constant) — constant size keeps the glyph legible at hole-framing zoom and matches the tee marker, so the two read as one family. Cost: a second id-tracking path (markers, not circles) — handled in B.4.

### B.2 New script: `frontend/scripts/generate-bunker-marker.py`

Mirror `generate-tee-markers.py` exactly — python3 stdlib only (`zlib`, `struct`), reuse its `coverage`, `over`, `_chunk`, `write_png` patterns. Output: `frontend/public/assets/bunker-marker.png`, SIZE 96 canvas (~4.4× the 22px display size, crisp on 3× retina).

Shape as a signed-distance union of two circles (exact for circle unions):

```
sd(p) = min( hypot(p − c1) − r1,  hypot(p − c2) − r2 )
c1 = (38, 52), r1 = 20;  c2 = (58, 46), r2 = 15      # tilted bean, ~55px wide
```

Layer stack (bottom → top), Porter-Duff `over` like the tee script:
1. Soft ink halo: `INK=(26,42,26)`, alpha `0.25 · cov(sd ≤ +8, feather 2.5)`.
2. Ink outline: full alpha at `cov(sd ≤ +4)` (≈1 display px of outline).
3. Sand fill: `SAND = (0xd9, 0xc4, 0x92)` (muted sand between T.gold `#c99a2e` and T.paperEdge `#d9d2c0` — calm, never neon) at `cov(sd ≤ 0)`.
4. Three ink stipple dots r 2.5 at (36, 50), (48, 47), (58, 44), alpha 0.55.

Exact coordinates/tones are builder+designer latitude (designer review is the blocking gate); the non-negotiables are: asymmetric NON-ROUND silhouette, sand fill + ink outline, soft halo, ≤22px display footprint.

### B.3 New helper: `bunkerMarkerIconUrl()` (google-map-helpers.ts, next to `teeMarkerIconUrl` ~line 462)

```ts
/** Bundled bunker-glyph asset (generated by scripts/generate-bunker-marker.py). */
export function bunkerMarkerIconUrl(): string {
  return 'assets/bunker-marker.png';
}
```

### B.4 GoogleSatelliteMap.tsx render changes

- **New id ref** (~line 271, beside `teeShotCircleIdsRef`): `const teeShotMarkerIdsRef = useRef<string[]>([]);` — a NEW ref, not folded into `holeMarkerIdsRef` (that one is owned by the per-hole `clearHoleOverlays`/`addHoleOverlays` pair; tee-shot overlays also add/remove on tee-zone visibility flips, a different lifecycle — same reasoning that split `teeShotCircleIdsRef` from `holeCircleIdsRef`).
- **`clearTeeShotOverlays`** (~line 440): additionally `await m.removeMarkers(teeShotMarkerIdsRef.current).catch(() => {})` when non-empty, then reset the ref. All hole-change and visibility-flip paths already route through this function (camera queue ~line 594, GPS-tick handlers ~lines 755/917), so no new call sites.
- **`addTeeShotOverlays`** (~line 490): keep the plate loop (native circles). Replace the bunker circle loop with a `Marker[]` built as:
  ```ts
  { coordinate: bunker.nearEdge, iconUrl: bunkerMarkerIconUrl(),
    iconSize: { width: 22, height: 22 }, iconAnchor: { x: 11, y: 11 },
    isFlat: true, zIndex: 4 }   // under the tee marker's zIndex 5
  ```
  Add via one batched `m.addMarkers(markers)` (plugin API confirmed: `addMarkers(markers: Marker[]): Promise<string[]>`), store ids in `teeShotMarkerIdsRef`. Restructure the existing `circles.length === 0` early-return so each collection (circles / markers) is added iff non-empty and BOTH refs are reset when their collection is empty. The whole function already begins with `if (!m || !mapReadyRef.current) return;` — every native call stays onMapReady-gated (google-maps-onmapready-crash: never touch the plugin before onMapReady; JS cannot catch the native SIGTRAP).
- **Optional restrained polish** (concept only — builder+designer latitude, blocking designer review of the rendered result):
  - Plate dots (`addTeeShotOverlays` circle spec, ~line 497 + `PLATE_FILL_BY_YARDS`, line 179): KEEP the 200=blue `#2e5aa8` / 150=white `#f2efe6` / 100=red `#b23a2e` convention. Suggest strokeWeight 1 → 1.5 and strokeColor `rgba(26,42,26,0.55)` → `rgba(26,42,26,0.65)` on all three so the white 150 plate holds its edge on light fairway imagery.
  - Bunker DOM carry chips (~lines 1140-1180): add a small inline sand-bean swatch (8–10px, inline SVG or the PNG as `<img>` — DOM, so no iOS icon constraint) before the "L CARRY" label to visually bind chip ↔ map glyph; consider softening the shadow `0 4px 14px rgba(0,0,0,0.22)` → `0 2px 8px rgba(0,0,0,0.18)`. Keep `T.paper`/`T.hairline`/mono-label/serif-number exactly as they are — calm, print-like.

### B.5 Native-map discipline / honest verification limits

Every native draw already rides the serialized camera queue or the mapReady-gated callbacks — the new marker calls change nothing structural. Verify in the iOS simulator with a screenshot of a mapped hole from the tee zone (confirms the bundled PNG actually loads — the whole reason for the PNG idiom). Be honest in the PR: the on-satellite pinch-zoom look and sunlight legibility need the owner's device; simulator screenshots are the floor, not the ceiling.

---

## Files to touch

| File | Change |
|---|---|
| `frontend/src/lib/map/tee-shot-overlays.ts` | Part A: constants (after line 93); `fairwayRingsFromFeatures`, `latLngInRing`, `fairwayCenterAtStation` (new exports); `distanceMarkersFromGreen` optional 4th param + push-site hook (lines 203-245); `computeTeeShotOverlays` wiring (line 468); doc comment on `DistanceMarker.position` (line 45) |
| `frontend/src/lib/map/tee-shot-overlays.test.ts` | New describe blocks 14a-14g + `makeFairwayPolygon` fixture builder |
| `frontend/src/components/GoogleSatelliteMap.tsx` | `teeShotMarkerIdsRef` (~271); `clearTeeShotOverlays` (~440); `addTeeShotOverlays` bunker loop → `addMarkers` (~490-525); optional plate stroke (~497/179) + chip polish (~1140-1180); import `bunkerMarkerIconUrl` |
| `frontend/src/lib/map/google-map-helpers.ts` | `bunkerMarkerIconUrl()` next to `teeMarkerIconUrl` (~462) |
| `frontend/scripts/generate-bunker-marker.py` | NEW — stdlib-zlib PNG generator per B.2 |
| `frontend/public/assets/bunker-marker.png` | NEW — generated once by the script, committed |

No backend changes.

## Gates (all must pass)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npm test                        # vitest run — includes the new 14a-14g tests
  # targeted: npx vitest run src/lib/map/tee-shot-overlays.test.ts
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd backend  && ruff check .
python3 frontend/scripts/generate-bunker-marker.py   # once; commit the PNG; re-run is idempotent
```

Plus: iOS simulator build + screenshot of a mapped hole from the tee zone (bunker glyph visibly loads and is unmistakably not a plate dot; plates sit in the fairway on a hole with offset centerline). **Designer review of the rendered result — BLOCKING.** On-device satellite pinch-zoom check — owner's device, flagged honestly in the PR.
