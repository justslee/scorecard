# Tee-Shot Yardage Overlays — Implementation Plan

**Surface:** `frontend/src/components/GoogleSatelliteMap.tsx` (in-round satellite hole map, inline + fullscreen blow-up)
**Owner intent:** yardage-book detail for TEE SHOTS ONLY — blue/white/red 200/150/100 plates from green center along the hole line, fairway-bunker front/back carries from the selected tee, visible only in tee-shot context. Calm, honest, no invented geometry.

## 0. Verified platform constraint (load-bearing, drives the design)

`@capacitor/google-maps@8.0.1` iOS (`node_modules/@capacitor/google-maps/ios/Sources/CapacitorGoogleMapsPlugin/Map.swift:726-753`): marker `iconUrl` is loaded either via `https:` download or `UIImage(named: "public/<path>")` — **bundled assets only. Data-URL / canvas-generated icons do NOT work on iOS** (falls back to the default red Google pin — worse than nothing). Therefore:

- The 200/150/100 plates are **native circles** (`m.addCircles`) — paintable fill/stroke, no assets, already used machinery (`holeCircleIdsRef`/`removeCircles` exist).
- Dynamic **text** ("230 / 260") cannot be a native map label. Bunker carries render as **DOM paper chips** (React siblings over the transparent WebView — the exact pattern of the existing tap-target pill), paired with a small native dot on each listed bunker's near edge for visual association.

Also verified: `Circle` extends `google.maps.CircleOptions` (`dist/typings/definitions.d.ts:65`) — `fillColor`, `fillOpacity`, `strokeColor`, `strokeWeight`, `radius` (meters), `center` all available.

## 1. Architecture decision: FRONTEND pure module

**Decision: frontend pure module `frontend/src/lib/map/tee-shot-overlays.ts`.** No backend changes, no `types.ts`<->`models.py` sync.

Why (vs. a backend endpoint reusing `backend/app/caddie/hazards.py`):
- The GeoJSON FeatureCollection is **already client-side** on this exact screen: `InlineHoleDiagram.tsx` fetches `fetchMappedCourse` -> `CourseData.holes[i].features`, and `RoundPageClient.tsx` already holds the same data as `courseHoles: HoleData[]` via `useHoleCoordinates` (`frontend/src/lib/map/use-hole-coordinates.ts:63`). Zero new fetches (cache-first doctrine holds).
- The math needed is **scalar** (along-line carry min/max, walk-back distance from green) — no signed-lateral left/right classification, which is where the backend's dogleg sign-flip incidents lived. Lateral is used here only as an **absolute** corridor filter (`|lateral| <= cap`), which is sign-safe by construction.
- A backend endpoint would add: a new route, response models, offline-bundle plumbing, and a network dependency for an overlay that must appear instantly on hole swipe.
- **Convention pinned to the backend anyway:** carry = cumulative along-path projection onto the `featureType:"hole"` LineString when present (matching `_project_onto_polyline`, hazards.py:253), chord `dot(v-tee, u)` fallback for bunkers otherwise; equirectangular meters with cosLat correction (matching `_xy_m` and hole-projection's `LAT_M = 111_320`); rounding to nearest 5 (matching `_round_to_5`).

The module is pure (no DOM, no plugin, no React), unit-tested with fabricated GeoJSON fixtures.

## 2. New pure module: `frontend/src/lib/map/tee-shot-overlays.ts`

```ts
export interface LatLng { lat: number; lng: number }

export interface DistanceMarker {
  yards: 100 | 150 | 200;
  position: LatLng;          // interpolated point ON the hole centerline
}

export interface BunkerCarry {
  front: number;             // yards from selected tee to nearest bunker edge, rounded to 5
  back: number;              // yards to farthest edge, rounded to 5
  side: 'L' | 'R' | 'C';     // |lateral| <= 10y deadband -> 'C' (matches backend deadband)
  nearEdge: LatLng;          // ring vertex with min carry — anchor for the native dot
}

export interface TeeShotOverlays {
  markers: DistanceMarker[]; // 0–3 plates
  bunkers: BunkerCarry[];    // 0–4 chips, sorted ascending by front carry
}

// ── Internals (exported for tests) ──
/** UNROUNDED haversine yards. CRITICAL: yardsDistance (hole-projection.ts:382) and
 *  haversineYards (google-map-helpers.ts:112) both Math.round — summing rounded
 *  segment lengths over a 20-vertex centerline accrues up to +/-10y error. This
 *  module walks with float meters and rounds ONCE at the end. */
function metersBetween(a: LatLng, b: LatLng): number

/** Find the featureType==="hole" LineString (>=2 vertices; first match, like
 *  backend _hole_polyline) and return it GREEN-FIRST: the endpoint nearer to
 *  greenCenter becomes index 0. HONESTY GUARD: if the nearer endpoint is
 *  > 60y from greenCenter the way is suspect (mis-tagged / wrong hole) -> null. */
export function greenFirstCenterline(
  features: GeoJSON.Feature[], greenCenter: LatLng,
): LatLng[] | null

/** Walk the centerline from the green end, cumulative float meters; linear
 *  lat/lng interpolation inside the segment containing each target distance.
 *  A target beyond total path length is OMITTED (a 160y-line hole has no 200
 *  plate). Distances measured from GREEN CENTER: the walk starts with an
 *  offset = metersBetween(greenCenter, line[0]) so plates are true
 *  to-green-CENTER numbers even though the way ends at the green edge/pin. */
export function distanceMarkersFromGreen(
  centerline: LatLng[], greenCenter: LatLng,
  distancesYds?: readonly number[],          // default [100, 150, 200]
): DistanceMarker[]

/** Per-bunker carry + fairway classification. See section 4 for the predicate. */
export function fairwayBunkerCarries(args: {
  features: GeoJSON.Feature[];
  tee: LatLng;                // the SELECTED/anchored tee (hd.tee)
  green: LatLng;              // green CENTER
}): BunkerCarry[]

/** Orchestrator — the only function the component calls for geometry. */
export function computeTeeShotOverlays(args: {
  features: GeoJSON.Feature[] | null;   // hole's FeatureCollection features, or null
  tee: LatLng | null;                    // hd.tee (selected tee) — null => no bunkers
  green: LatLng;                         // hd.green (center — reliable)
  par: number | null;                    // mapped CourseData.holes[i].par
}): TeeShotOverlays

/** Pure visibility predicate — see section 5. */
export function teeShotOverlaysVisible(args: {
  position: LatLng | null;   // latest GPS fix (null = none yet / just opened)
  gpsOnHole: boolean;        // isGpsOnHole result (false when position null)
  tee: LatLng | null;
}): boolean
```

**Geometry frame** (pinned, matches backend): local equirectangular meters, origin at the tee, `x = (lng-teeLng)*LAT_M*cos(midLat)`, `y = (lat-teeLat)*LAT_M`, `LAT_M = 111_320`, `midLat = (tee.lat + green.lat)/2`. Yards = meters / 0.9144 (`METRES_PER_YARD`).

**Do NOT use `hd.front`/`hd.back` anywhere** — they are synthesized +/-15y offsets on tokenless installs (`course-coordinates.ts`). Plates measure from `hd.green` (center, always real).

## 3. 200/150/100 plate placement

Algorithm (in `distanceMarkersFromGreen`):
1. `greenFirstCenterline`: pick the `featureType:"hole"` LineString; orient green-first by nearest endpoint to `hd.green`; reject (return null) if that endpoint is > 60y from green center.
2. Compute `offset = metersBetween(greenCenter, line[0])` (typically 5–25y — the way ends at the green, not its center). Walking distance for target `d` yards is `d*0.9144 - offset` meters along the path. If that is <= 0 (degenerate: way starts past the target) omit the plate.
3. Accumulate unrounded segment lengths; when the target falls inside segment `[vi, vi+1]`, lerp: `t = (target - cum)/segLen`, `pos = vi + t*(vi+1 - vi)` (component-wise lat/lng lerp — fine at hole scale).
4. Target beyond total path length -> omit (a 380y hole shows all three; a 165y line shows 100+150 only — moot on par 3s, see section 6).

**No chord fallback. Decision: centerline REQUIRED.** A straight green->tee bearing puts the 200 plate in the trees on any dogleg — exactly the Bethpage Black 4 class of error, on a trust-critical printed number. Missing/degenerate centerline => zero plates, silently (no-fake-data rule). Non-mapped courses have no FeatureCollection => silently absent, honest.

## 4. Fairway-bunker selection + front/back carries

For each feature with `properties.featureType === "bunker"` **and Polygon geometry** (outer ring, closing duplicate deduped, >= 3 distinct vertices):

- Project every ring vertex to the tee-origin meter frame.
- **Carry per vertex:** if the hole centerline exists, cumulative along-path carry via a TS port of `_project_onto_polyline` (nearest-segment projection, first/last segments extrapolate, carry relative to the tee's own projection onto the path — subtract `carry(tee)`); else chord: `carry = dot(v, u)`, `u = unit(green - tee)`. Same-file convention as backend hazards.py — the dogleg-aware frame.
- **Lateral per vertex:** perpendicular distance to the played line (`|cross|` — absolute value only; we never speak left-of/right-of a dogleg from the chord). `side` for the chip uses the sign at the min-carry vertex with the backend's 10y deadband -> 'C'.
- `front = round5(min carry)`, `back = round5(max carry)` (negatives clamped to 0 before rounding, per backend convention).

**Fairway / in-tee-shot-range predicate** (a bunker qualifies iff ALL hold):

| Test | Threshold | Justification |
|---|---|---|
| Tee-shot floor | `min carry >= 100y` | Nothing shorter is a tee-shot carry decision; excludes tee-side waste areas. |
| Tee-shot ceiling | `min carry <= 330y` | Beyond any tee shot in this app's audience; keeps par-5 mid-hole bunkers out. |
| NOT greenside | `min over vertices of metersBetween(vertex, greenCenter) >= 45y` | Green center->edge ~= 15y; greenside bunkers sit within ~30y of the edge => <= 45y of center. Radial from green center (not along-line) so it's dogleg-safe. |
| In the corridor | `min over vertices of |lateral| <= 45y` | Fairway half-width ~= 20y + flanking bunker up to ~25y off the edge. Matches the spirit of hole-projection's 60 m display corridor but tighter — carry relevance, not display. |

**Honesty rules:**
- Centroid-only bunkers (Point geometry, or `hd.hazards` centroids) are **SKIPPED entirely** — a single centroid cannot honestly answer "can I carry it" (centroid != back edge) and fabricating a front/back range is forbidden. We never touch `hd.hazards` in this feature.
- `front === back` after rounding -> chip shows the single number ("245"), not a fake range.
- Cap at **4 chips**: if more qualify, keep the 4 with smallest `min |lateral|` (most in-play), then display sorted ascending by `front`. More than 4 is not "calm".

Rounding: **nearest 5** (`round5 = Math.round(y/5)*5`), matching backend `_round_to_5` and honest about OSM polygon precision. The owner's "231 / 260" example renders as "230 / 260".

## 5. Visibility trigger

```ts
teeShotOverlaysVisible = ({ position, gpsOnHole, tee }) =>
  tee != null && (
    position == null            // just opened / no fix yet — reading the hole
    || !gpsOnHole               // fix far from hole (map already shows tee distances)
    || haversineYards(position, tee) <= 40   // physically in the tee zone
  );
```

- 40y tee-zone radius: tee boxes are ~10–30y deep; 40 covers walking between markers without reaching the fairway.
- Stateless and re-evaluated on every GPS tick and hole change — **but native overlays are only touched when the boolean CHANGES** (compared against `teeShotVisibleRef`), so GPS jitter never causes redraw churn. No hysteresis, no timers, no shot-state machine (owner: don't over-engineer). Walking back to the tee honestly re-shows.
- Fresh hole (swipe / auto-advance): the hole-change path recomputes from the current fix — on the new tee (or with no fix) it shows; standing mid-fairway of that hole it doesn't.
- `tee == null` (no anchored tee) => hidden — no honest origin for carries, and "tee-shot context" is defined relative to the tee; without one we cannot know the golfer is on it (single trigger gates BOTH plates and chips — simple).

## 6. Par-3 handling

**Decision: suppress everything on par 3** (`computeTeeShotOverlays` returns empty when `par === 3`).
- Bunker carries: a par 3's bunkers are greenside by definition (and the 45y green band would exclude them anyway) — suppression is belt-and-braces.
- 200/150/100 plates: the tee shot IS the approach; F/C/B center distances already own that decision (`YardageStat` panel / round tiles). Plates mid-flight on a 180y hole are clutter with zero decision value — against "quiet".
- `par == null` (unmapped par) -> treat as non-par-3: the geometry predicates still hold and drawing true geometry is honest. Par comes from the mapped `CourseData.holes[i].par` (same source as the features themselves — internally consistent; no `RoundPageClient` par threading needed: `HoleData` in `frontend/src/lib/courses/types.ts:16-23` carries `par`).

## 7. Design language (NORTHSTAR)

**Plates — native circles via `addCircles` (decision: circles, not marker PNGs).** No new assets, paintable, and meter-radius circles scale with zoom exactly like painted plates on turf — calm at framing zoom, legible when the golfer pinches in. Marker PNGs would need 3 new generated assets and stay screen-fixed-size (louder when zoomed out).
- Radius **3 m** each; `fillOpacity 0.92`; `strokeColor "rgba(26,42,26,0.55)"` (T.ink at ~55% — the hairline that keeps the white plate readable on sunlit fairway), `strokeWeight 1`.
- Colors reuse the **existing tee palette** (`TEE_COLOR_RULES`, google-map-helpers.ts:436): 200 = `#2e5aa8` (blue), 150 = `#f2efe6` (white), 100 = `#b23a2e` (red). Classic course convention, zero new colors.
- Bunker near-edge dots: radius **2 m**, fill `#f2efe6` at 0.9, same ink stroke — a quiet tick that pairs the chip to its bunker.

**Bunker carry chips — DOM (forced by section 0), styled exactly like the tap-target pill** (GoogleSatelliteMap.tsx:914-946): `background: T.paper`, `border: 1px solid ${T.hairline}`, `borderRadius 10`, shadow `0 4px 14px rgba(0,0,0,0.22)`; label row `T.mono` 8px letterSpacing 1 uppercase `T.pencil` — `"L CARRY"` / `"R CARRY"` / `"CARRY"`; value `T.serif` 18px `T.ink` — `"230 / 260"`. Stacked column (gap 4) anchored **right edge** (`right: 12`; `top: 12` inline, `top: max(120px, safe-area+108px)` fullscreen to clear the wind badge) — opposite side from the tap pill, off the fairway which runs up center-screen. `pointer-events: none` (read-only, not chrome). Fade in/out with `AnimatePresence` opacity 0.25s. Max 4, typically 1–2. This is *less* than a printed book page — per the owner's "too much" rejection.

## 8. Wiring (exact changes)

**`frontend/src/components/GoogleSatelliteMap.tsx`**
1. New optional prop: `mappedHoles?: ReadonlyMap<number, Pick<HoleData, 'par' | 'features'>>` (type-only import from `@/lib/courses/types`). Absent => feature entirely inert (CourseSearch / CourseScoutMap / map-course page unaffected).
2. New refs: `teeShotCircleIdsRef = useRef<string[]>([])`, `teeShotVisibleRef = useRef<boolean>(false)`. Separate from `holeCircleIdsRef` so mid-hole hiding never touches the tee dot, and the per-GPS-tick `clearHoleOverlays()`/`addHoleOverlays()` refresh (line 737-740) never flickers the plates.
3. New memo: `teeShotData = useMemo(() => { const h = mappedHoles?.get(currentHole); if (!h || !currentHoleData) return EMPTY; return computeTeeShotOverlays({ features: h.features?.features ?? null, tee: currentHoleData.tee ?? null, green: currentHoleData.green, par: h.par ?? null }); }, [mappedHoles, currentHole, currentHoleData])` — mirrored into a ref for the queue/GPS closures.
4. `addTeeShotOverlays` callback: gate `if (!m || !mapReadyRef.current) return;` then one `m.addCircles([...plates, ...bunkerDots]).catch(() => [])`, ids into `teeShotCircleIdsRef`. `clearTeeShotOverlays`: `removeCircles` + reset ref (catch-swallowed, like `clearHoleOverlays`).
5. **Hole change (serialized):** extend the camera-queue `run` (line 434-446) and `overlayFnsRef` to: `clearHoleOverlays -> clearTeeShotOverlays -> fitCameraToHole -> addHoleOverlays -> if (teeShotOverlaysVisible(...)) addTeeShotOverlays()`, and set `teeShotVisibleRef` + a `setTeeShotChips` state accordingly. Initial-mount draw block (line 589-592) does the same after `addHoleOverlays`.
6. **GPS tick:** in `handlePositionUpdate`, after the existing overlay refresh, compute `visible = teeShotOverlaysVisible({ position: pos, gpsOnHole: onHole, tee: hd?.tee ?? null })`; only when `visible !== teeShotVisibleRef.current`: update ref/state, then `clearTeeShotOverlays()` or `addTeeShotOverlays()` (both gated on `mapReadyRef`). No new effects, no timers.
7. Chips JSX: render when `!centerOnly && teeShotChips.visible && teeShotChips.bunkers.length > 0`, per section 7.

**`frontend/src/components/course/InlineHoleDiagram.tsx`** — already holds `holeIndex: Map<number, HoleData>`; pass `mappedHoles={holeIndex}` to the inline `<GoogleSatelliteMap …>` (line 298).

**`frontend/src/app/round/[id]/RoundPageClient.tsx`** — already holds `courseHoles` from `useHoleCoordinates` (line 368); add `const mappedHolesIndex = useMemo(() => indexByHoleNumber(courseHoles), [courseHoles])` (`@/lib/hole-index`, already used by InlineHoleDiagram) and pass `mappedHoles={mappedHolesIndex}` to the fullscreen blow-up `<GoogleSatelliteMap …>` (line ~2445). No new fetch — data already in memory.

**No backend changes. No `types.ts`<->`models.py` sync. No new dependencies. No new assets.**

## 9. Tests — `frontend/src/lib/map/tee-shot-overlays.test.ts` (vitest, fabricated GeoJSON fixtures)

1. **Straight 400y hole:** plates exist at 100/150/200; assert `metersBetween(plate, greenCenter)/0.9144` within +/-1y of target (validates the green-center offset handling).
2. **Dogleg centerline** (L-shaped LineString): the 200 plate lies on the second leg — assert along-path distance = 200 AND its perpendicular distance from the straight tee->green chord > 20y (would fail under any chord fallback).
3. **Too-short line:** 160y centerline -> 100 & 150 only, 200 omitted; 90y -> 100 only (par-3 suppression normally hides these; test the pure fn directly).
4. **No/degenerate centerline** or green-end endpoint > 60y from green -> `markers: []`.
5. **Reversed LineString** (tee-first order) -> identical plate positions (green-first orientation works).
6. **Bunker front/back:** square ring straddling 230–260y at 15y lateral -> `front 230, back 260`, included; identical result with and without a straight centerline present (chord/path agreement on a straight hole).
7. **Greenside exclusion:** ring 25y from green center -> excluded even though carry in [100, 330].
8. **Corridor exclusion:** ring at 70y lateral -> excluded; floor/ceiling: rings at 60y and 360y carry -> excluded.
9. **Centroid-only (Point) bunker -> skipped**, never a fabricated range.
10. **Rounding + equal-edge:** 231.4/259.8 -> 230/260; a 4y-deep pot bunker -> `front === back`.
11. **Cap:** 6 qualifying bunkers -> 4 kept (smallest lateral), sorted by front carry.
12. **Par 3** -> `computeTeeShotOverlays` fully empty despite valid geometry; `par: null` -> not suppressed.
13. **Visibility:** `position null -> true`; on tee (10y) -> true; 120y down fairway on-hole -> false; off-hole fix -> true; `tee null -> false`; boundary 40y -> true / 41y -> false.

## 10. Gates

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx vitest run          # includes the new tee-shot-overlays suite
cd frontend && npx tsx voice-tests/runner.ts --smoke
```
Backend untouched => no `ruff` gate. Sim visual check (ios-simulator-map-testing lesson): launch a round on a mapped course (Bethpage Black), confirm (a) tee view shows 3 plates on the centerline + carry chips, (b) simulated GPS 150y down the fairway removes them, (c) hole swipe re-shows on the next tee, (d) par-3 hole shows nothing. **Honesty note:** Google satellite tiles have historically failed to render in the sandbox sim (Maps-key credential policy); plate/chip presence and the pure math are sandbox-verifiable via the vitest suite + web renderer; final tile-level visual sign-off needs the owner's device.

## 11. Risks / edge cases

- **Rounded-segment accumulation bug** (section 2): must use unrounded meters when walking the centerline — the existing `yardsDistance`/`haversineYards` both round per-call. Pinned by test 1.
- **OSM `golf=hole` way quality:** mis-tagged or truncated ways -> the 60y green-end guard nulls the centerline (plates silently absent, honest). Bunker carries then fall back to chord projection — still correct front/back scalars on straight holes; on hard doglegs, chord carry to a corner bunker understates by a few yards but never mirrors sides (we don't use signed lateral for inclusion).
- **Per-GPS-tick redraw churn:** avoided by the boolean-change gate (`teeShotVisibleRef`) and by keeping plates out of `addHoleOverlays`.
- **Crash safety:** every native call added is gated on `mapReadyRef.current` and routed through the existing id-ref clear/add pattern; hole-change work rides the coalescing camera queue — no unserialized chains, no leaks across rapid swipes.
- **Chip/tap-pill collision:** chips right, tap pill left — disjoint.
- **`teeOverrideByHole`:** already merged into `hd.tee` before this component sees coords — carries automatically measure from the player's selected tee.

## Critical Files for Implementation
- `frontend/src/lib/map/tee-shot-overlays.ts` (new, + `tee-shot-overlays.test.ts`)
- `frontend/src/components/GoogleSatelliteMap.tsx`
- `frontend/src/components/course/InlineHoleDiagram.tsx`
- `frontend/src/app/round/[id]/RoundPageClient.tsx`
- `backend/app/caddie/hazards.py` (read-only math-convention reference)
