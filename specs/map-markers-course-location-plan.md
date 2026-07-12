# Plan: CourseScoutMap markers, my-location, initial fetch, and POI suppression

_Fable-authored implementation plan (cycle 106). Contract for the builder — implement this, do not re-plan._

**Bug (owner, v1.1.3):** In B2 map mode, searching "Marine" pans correctly but (1) no marker on the searched course, (2) no user-location dot, (3) in-bounds golf pins not visibly rendering, (4) Google POI clutter (museums, restaurants, IKEA) shows through — noisy, not the calm golf-focused yardage-book map per NORTHSTAR.md.

**Scope:** `frontend/src/components/CourseScoutMap.tsx` (primary), `frontend/src/components/CourseSearch.tsx` (panTarget shape), one new pure module + test. **No new binary asset** (see §1.4). **Budget invariant preserved:** the only data call remains `fetchCoursesInBounds` (B1 `/api/courses/in-bounds`); no Google Places / GolfAPI / Mapbox call is introduced anywhere in this plan.

---

## 0. Verified facts (read from source, not guessed)

- `panTarget` today is `{ id, center } | null`, built at `frontend/src/components/CourseSearch.tsx` L635-639 from `topHit = searchResults[0]`; `topHit.name` and `topHit.source` are available on `CourseSearchResult` (golf-api.ts L399-409). `CourseSearch.test.tsx` L274 asserts the exact panTarget shape and must be updated.
- The panTarget effect (`CourseScoutMap.tsx` L260-267) only calls `setCamera`; `lastPanIdRef` (L100) dedupes by id and is **never reset**, so clear-then-retype the same course currently would not re-pan.
- Plugin 8.0.1 (patched via `frontend/patches/@capacitor+google-maps+8.0.1.patch`, applied by `postinstall: patch-package`):
  - `enableCurrentLocation(enabled: boolean)` exists (map.d.ts L221); iOS impl is `GMapView.isMyLocationEnabled = enabled` (Map.swift L559-563) — `GMapView` is force-unwrapped, so calling pre-ready is the SIGTRAP class of crash; post-ready it's safe. If OS location permission is denied, GMS simply shows no dot (no throw on iOS; Android may reject → catch it).
  - `getMapBounds(): Promise<LatLngBounds>` exists (map.d.ts L234); iOS impl (CapacitorGoogleMapsPlugin.swift L877-902) guards nil bounds with a **catchable** thrown error — safe post-ready.
  - `styles?: google.maps.MapTypeStyle[]` on the create config is supported natively since 4.3.0 (definitions.d.ts L160); iOS applies it via `GMSMapStyle(jsonString:)` (GoogleMapConfig.swift L54-57, Map.swift L154-158) — works on `MapType.Normal`, **no mapId needed** (mapId is web-only, definitions.d.ts L166-170).
  - `Marker.zIndex` is supported (definitions.d.ts L415); `removeMarker(id)` exists (map.d.ts L159).
  - Marker `iconUrl` on iOS resolves non-https paths as `UIImage(named: "public/\(iconUrl)")` (Map.swift L741); a load failure logs `"CapacitorGoogleMaps Warning: could not load image"` and falls back to the **default red marker** — i.e. a bad icon path produces a *visible wrong* marker, not an invisible one.
  - iOS fires `onCameraIdle` from the `GMSMapViewDelegate` `idleAt` callback (CapacitorGoogleMapsPlugin.swift L1053-1073). The initial-settle idle fires around map creation — **before** our JS `setOnCameraIdleListener` attaches (it attaches after the 13s ready race, L222-230), so the initial viewport's idle is lost → the coordinator never gets an initial bbox → **no pins on first load until the first pan**. This is the primary confirmed cause for §3.
- `course-flag.png` exists in both `frontend/public/assets/` and `frontend/ios/App/App/public/assets/`; the same `iconUrl: "assets/…"` pattern is proven in production by GoogleSatelliteMap.tsx (L379 tee markers, L642 tap-target).
- Backend zoomIn gate: `IN_BOUNDS_MAX_AREA_SQDEG = 0.25` (course_search.py, gate at ~L611). Phone viewport at zoom 12 (initial): lng span ≈ 360 × 390 / (256 × 2¹²) ≈ 0.13°, lat span ≈ 0.29° → area ≈ 0.039 sq° ≪ 0.25. At pan zoom 13 it's ~¼ of that. **The gate is not the cause** — record this, no backend change.
- `createCameraQueue` (google-map-helpers.ts L374-404) is a generic coalescing async serializer — trailing target wins; already used for the pin batch queue. Perfect for the highlight marker (rapid re-pans coalesce; no interleaved remove/add).

---

## 1. Highlight the searched (panTarget) course

### 1.1 panTarget carries name + source

`frontend/src/components/CourseSearch.tsx` L636-639:

```ts
const panTarget =
  mode === "map" && query.length >= 2 && topHit?.center
    ? { id: topHit.id, name: topHit.name, source: topHit.source, center: topHit.center }
    : null;
```

`name` is needed for the marker title; `source` lets the highlight marker participate in the tap card → Add flow through the **same identity seam** (`markerIndexRef` → `pinToSearchResult` → `resultToPayload`, pin-payload.ts — reused, not forked). Update `CourseScoutMapProps.panTarget` accordingly (CourseScoutMap.tsx L56) and the shape assertion in `CourseSearch.test.tsx` L274.

### 1.2 Pure logic — new module `frontend/src/lib/course/scout-map-config.ts`

Zero DOM/plugin/React imports, mirroring scout-viewport.ts, so it's Node-unit-testable (importing CourseScoutMap.tsx in vitest would drag in framer-motion + the plugin):

- `deriveHighlightAction(currentCourseId: string | null, targetCourseId: string | null): "none" | "remove" | "add" | "replace"` — the drop/replace/remove decision table.
- `highlightMarkerFor(target: { name, center }): Marker`-shaped object (plain data): `iconUrl: "assets/course-flag.png"`, `iconSize: { width: 40, height: 40 }`, `iconAnchor: { x: 8, y: 40 }` (5/26 and 26/26 of the quiet pin's anchor, scaled), `zIndex: 2`, `title: target.name`.
- `boundsToBBox(b: { southwest: {lat,lng}; northeast: {lat,lng} }): BBox` (for §3).
- `SCOUT_MAP_STYLES` (§4) exported here so its invariants are testable.

### 1.3 Native wiring in CourseScoutMap.tsx

New refs next to L97-100: `highlightRef = useRef<{ markerId: string; courseId: string } | null>(null)` and a dedicated `highlightQueueRef = useRef(createCameraQueue<PanTarget | null>(run))` where `run(target)`:

1. Bail unless `googleMapRef.current && mapReadyRef.current`.
2. Compute `deriveHighlightAction(highlightRef.current?.courseId ?? null, target?.id ?? null)`.
3. On `remove`/`replace`: `markerIndexRef.current.delete(prev.markerId)`; if `selectedPin?.id === prev.courseId` → `setSelectedPin(null)` (don't leave a card open for a removed marker); `await m.removeMarker(prev.markerId).catch(() => {})`; `highlightRef.current = null`.
4. On `add`/`replace`: `const id = await m.addMarker(highlightMarkerFor(target)).catch(() => null)`; if id: set `highlightRef.current = { markerId: id, courseId: target.id }` and `markerIndexRef.current.set(id, { id: target.id, name: target.name, center: target.center, source: target.source })` — a synthesized `InBoundsCourse` (address omitted; the card subline falls back to `sourceLabelFor(source)`, already handled at L287). Tapping the highlight now opens the card and "Add" funnels through the existing `pinToSearchResult` seam unchanged.

Because `createCameraQueue` coalesces to the trailing target, rapid re-pans ("Mar" → "Marine" → "Maria…") serialize remove→add with exactly one surviving highlight — **no dupes, no leaked marker ids**.

Rework the panTarget effect (L260-267):

```ts
useEffect(() => {
  if (!ready) return;
  if (!panTarget) {
    if (lastPanIdRef.current !== null) {
      lastPanIdRef.current = null;                 // clear → retype same course re-pans
      highlightQueueRef.current.request(null);     // remove highlight, DO NOT move camera
    }
    return;
  }
  if (lastPanIdRef.current === panTarget.id) return;
  lastPanIdRef.current = panTarget.id;
  const m = googleMapRef.current;
  if (!m || !mapReadyRef.current) return;
  m.setCamera({ coordinate: panTarget.center, zoom: 13, animate: true, animationDuration: 600 }).catch(() => {});
  highlightQueueRef.current.request(panTarget);
}, [ready, panTarget]);
```

**Decision — search cleared (query < 2 chars):** remove the highlight, keep the camera where it is. The flag means "the course you searched"; when the search is gone the flag goes quietly. No camera move on clear (calm).

**Decision — highlight vs in-bounds double pin:** accept both, highlight on top. Never remove or touch the in-bounds pin (owner's no-reshuffle law; also the coordinator's `seenIds` would permanently suppress its re-add, vanishing the course after the highlight clears). With `zIndex: 2` and the 40px size, a coincident quiet pin is occluded; when centers differ slightly (search-API center vs OSM/DB center) two flags near each other is honest — two sources, both real. Zero coordinator/marker-index corruption.

### 1.4 Asset decision — no new binary

Reuse `course-flag.png` at 40×40 (vs the quiet pins' 26×26) with `zIndex: 2`. On a POI-suppressed map (§4) a ~1.5× ink flag reads clearly primary while staying the same hand — larger of the same mark, not a different (SaaS) language. **Not designer-blocking.** Fallback, only if the sim check says it doesn't read primary: a filled-silhouette variant (`course-flag-solid.png`, same geometry, solid `T.ink` fill, same 3 sizes/anchor family, mirrored to `ios/App/App/public/assets/`) — that path IS designer-blocking and should be flagged, not shipped unilaterally (NORTHSTAR: flag feel-compromises to the owner).

---

## 2. My-location marker — native `enableCurrentLocation(true)`

In the mount effect, immediately after the listeners block (after L238 `setOnMapClickListener`, before `setReady(true)` at L240) — i.e. strictly after `mapReadyRef.current = true` (L220):

```ts
// Standard subdued my-location dot. Permission denied / unavailable →
// no dot, no crash, no error surfaced (the one-shot GPS fix in
// CourseSearch usually means permission is already granted).
await gMap.enableCurrentLocation(true).catch(() => {});
```

**Recommendation: native, not a manual "You" marker** (GoogleSatelliteMap.tsx L714-717 pattern), because: (a) zero GPS plumbing in this component — no watcher, no marker lifecycle, no remove/re-add churn on every fix; (b) the dot self-updates and is not a marker, so it can never collide with `markerIndexRef` or fire `setOnMarkerClickListener`; (c) the platform-standard subdued blue dot is a calm, recognized affordance — not SaaS chrome. The satellite map's manual marker exists only because it's conditional on `isGpsOnHole`; no such condition here. iOS impl is a plain property set (no permission throw); the `.catch` covers Android's permission rejection and any bridge error. **Discipline:** the call sits inside the ready-gated async block after L220, is skipped by the `destroyed` early-returns above it, and is destroyed with the map — never callable pre-ready (SIGTRAP rule respected).

---

## 3. In-bounds pins not rendering — cause analysis + fix

**Primary confirmed cause — lost initial camera-idle.** iOS fires `idleAt` when the initial camera settles, which happens before our JS listener attaches (attached only after the 13s ready race, L222). The coordinator never receives the initial bbox, so no fetch runs until the user pans. Note the owner's repro likely compounds: after the pan to Marine Park an idle *should* fire and fetch — but any pins that did land were 26px hollow ink flags underneath Google's own POI icon layer (candidate 3/4 below), reading as "nothing rendered".

**Fix — one-shot initial prime**, right after `setOnCameraIdleListener` (insert after L230, still inside the ready-gated block):

```ts
// The initial-settle idle fires before this listener attaches (iOS
// GMSMapViewDelegate idleAt) — prime the coordinator with the starting
// viewport once, through the same debounce/coverage path as a real pan.
try {
  const b = await gMap.getMapBounds();
  if (!destroyed && mapReadyRef.current) {
    coordinatorRef.current?.onCameraIdle(boundsToBBox(b));
  }
} catch { /* first user pan covers it */ }
```

No coordinator change: the prime flows through the existing 600ms debounce, cell-coverage dedupe, abort/generation guards. If a real idle also arrives (Android does re-fire), the debounce coalesces them — one fetch.

**Other candidates — confirm in the iOS simulator (ios-simulator-map-testing procedure), in this order:**

1. **Icon load** — watch the Xcode console for `CapacitorGoogleMaps Warning: could not load image 'assets/course-flag.png'`. Expected fine (identical pattern to shipped tee markers/tap-target; PNG present in `ios/App/App/public/assets/`). A failure here would show *default red* markers, not invisible ones — the owner saw neither, consistent with "no fetch ever ran". Fallback if it somehow fails: run `npx cap sync ios` to re-mirror `public/`, and verify the Xcode `public` folder reference includes `assets/`.
2. **Z-order / POI burial** — 26px hollow flags under Google's POI icons. Fixed structurally by §4; verify visually post-suppression.
3. **zoomIn gate** — ruled out by arithmetic (§0: ≈0.039 sq° at zoom 12, ≈0.01 at zoom 13, vs 0.25 limit). Verify once in-sim: pan at zoom 13 over Marine Park and confirm no "Zoom in to see courses" pill and a non-empty `/api/courses/in-bounds` response.
4. **Fetch failure** (API base/auth from the native shell) — would show the existing "Couldn't check this area" pill; check the network log in-sim if pins still don't land.

**Budget invariant:** unchanged — the prime calls the coordinator, whose only fetch is `fetchCoursesInBounds`. Grep gate from the file header still passes.

---

## 4. Suppress Google POI clutter via `styles`

Add to the create config (CourseScoutMap.tsx L192-197):

```ts
config: {
  center: initialCenter,
  zoom: 12,
  mapTypeId: MapType.Normal,
  disableDefaultUI: true,
  styles: SCOUT_MAP_STYLES,
},
```

`SCOUT_MAP_STYLES` in scout-map-config.ts (typed `google.maps.MapTypeStyle[]` — the namespace resolves via the plugin's `@types/google.maps` dependency):

```ts
export const SCOUT_MAP_STYLES: google.maps.MapTypeStyle[] = [
  // All POI icons + names (museums, restaurants, hospitals, stores) — off.
  // labels only: park/golf GREEN GEOMETRY stays (a golf map needs its fairways).
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  // Businesses entirely (belt over the labels rule).
  { featureType: "poi.business", stylers: [{ visibility: "off" }] },
  // Transit stations/lines clutter.
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];
```

Deliberately **not** styled: `road` (all), `water`, `administrative`, `landscape` — road/water/neighborhood labels stay legible; this hides only the POI icon layer. `featureType: "poi"` scoped to `elementType: "labels"` (not the whole feature) so park/golf-course green fills survive — hiding poi geometry would gray-out the courses themselves. Confirmed native path: config `styles` → JSON string → `GMSMapStyle(jsonString:)` at map init (GoogleMapConfig.swift L54, Map.swift L154), applies to `MapType.Normal`, no mapId involved. Invalid JSON only logs "Invalid Google Maps styles" — no crash path.

---

## 5. Implementation order

1. `frontend/src/lib/course/scout-map-config.ts` (new, pure): `SCOUT_MAP_STYLES`, `deriveHighlightAction`, `highlightMarkerFor`, `boundsToBBox` + `frontend/src/lib/course/scout-map-config.test.ts`.
2. `CourseSearch.tsx` L636-639: panTarget gains `name`, `source`. Update `CourseSearch.test.tsx` L256-282 shape assertions; add an assertion that name/source flow through.
3. `CourseScoutMap.tsx`:
   - L56: widen `panTarget` prop type.
   - L192-197: add `styles: SCOUT_MAP_STYLES`.
   - After L230: initial-bounds prime (§3). After L238: `enableCurrentLocation(true).catch(() => {})` (§2).
   - New `highlightRef` + `highlightQueueRef` (§1.3); rework the panTarget effect (L260-267).
4. Gates + sim verification (§7).

## 6. Pure vs native — test prescription

**Pure (vitest, Node):**
- `deriveHighlightAction`: all five cases — (null,null)→none, (A,null)→remove, (null,A)→add, (A,A)→none, (A,B)→replace.
- `highlightMarkerFor`: 40×40, anchor {8,40}, zIndex 2, title = name, iconUrl unchanged asset.
- `boundsToBBox`: southwest/northeast → {swLat,swLng,neLat,neLng}.
- `SCOUT_MAP_STYLES` invariants: every rule targets only `poi`/`poi.business`/`transit`; every styler is `visibility: "off"`; **no** rule targets `road`, `water`, `administrative`, or bare `all` (guards against blanket label-hiding regressions).
- `CourseSearch.test.tsx`: panTarget shape carries id/name/source/center; still null when no center / query < 2.
- Existing `scout-viewport.test.ts` untouched (coordinator unchanged — the prime reuses `onCameraIdle`).

**Native-only (iOS simulator, not unit-testable):** marker rendering, icon load, my-location dot, style application, camera/idle timing. Everything behind the plugin bridge.

## 7. Verification gates

```
cd frontend && npm run lint && npx tsc --noEmit && npx vitest run && npm run build && npx tsx voice-tests/runner.ts --smoke
cd backend && ruff check .
```

iOS-sim visual checks (per ios-simulator-map-testing; simulate location near a course, e.g. Custom Location over Brooklyn):
1. Open map mode cold → within ~2s of ready, quiet ink flags appear for in-bounds courses **without any pan** (initial-prime fix).
2. Blue my-location dot visible; then reset sim location permission → deny → map loads with no dot, no crash, no error pill.
3. Type "Marine" → camera pans, one larger primary flag on Marine Park Golf Course; tap it → card shows name + source label → Add works. Retype a different course → old highlight gone, exactly one new one (spam-type to check rapid re-pans). Clear the query → highlight disappears, camera stays.
4. No museum/restaurant/hospital/IKEA POI icons; roads, water, and neighborhood labels still legible; park/course greens still green.
5. Xcode console: no `could not load image` warning, no SIGTRAP across mount → search → clear → unmount → remount (StrictMode).

**Not sandbox-verifiable here:** everything in the sim list above (native plugin bridge — no simulator in this environment), the real-device permission prompt flow, and GMS's visual style application. The unit gates verify all decision logic; the sim pass is the evidence for "done" (CLAUDE.md: show evidence, don't assert).

## 8. Edge cases / risks

- **Highlight leak/dupe on rapid re-pans** — coalescing serializer (trailing target) makes remove→add atomic per transition; `highlightRef` is the single source of truth for the live marker id.
- **Permission denied** — native dot simply absent; `.catch(() => {})` swallows any bridge rejection; no pill, no crash.
- **Re-mount / StrictMode** — highlight state lives in refs; map destroy drops all markers; `createInProgressRef` guard unchanged; `highlightRef`/`lastPanIdRef` are per-mount refs so a remount starts clean.
- **Query cleared** — highlight removed, `lastPanIdRef` reset (so re-searching the same course re-pans + re-highlights, fixing a latent staleness bug), camera untouched.
- **Highlight vs in-bounds double pin** — accepted, occluded via zIndex/size; in-bounds layer never mutated (no-reshuffle law, coordinator `seenIds` integrity).
- **Card open when highlight replaced** — `setSelectedPin(null)` if the card was showing the removed highlight.
- **Style regression** — invariant unit test prevents accidental blanket `visibility: off`.
- **`getMapBounds` failure at prime** — caught; first user pan recovers via the normal idle path.
