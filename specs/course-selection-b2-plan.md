# B2 Implementation Plan — Map mode in CourseSearch (map-based course search UI)

**Slice:** B2 of `specs/course-selection-ux-plan.md` (§B.2, §B.3 identity parity). Frontend only — the data source is the already-shipped B1 endpoint `GET /api/courses/in-bounds` (`backend/app/routes/course_search.py:547-649`). No backend changes. B3 (pin-cap copy polish, viewport persistence, favorites star on map, map-follows-query nicety) is explicitly OUT of scope.

**Goal:** a Map mode toggle inside the shared `CourseSearch.tsx` surface. Map mode shows quiet ink golf-flag pins for real courses in the current viewport (B1 `/in-bounds` only), tap-a-pin → one-row yardage-book card → "Add" fires the exact same `onSelectCourse(CourseSelectPayload)` the list/voice paths fire. List mode stays the default; no Maps key → the toggle never renders and the surface is byte-identical to today.

---

## 0. Confirmed ground truth (verified in source, not assumed)

- **`/in-bounds` response** (`course_search.py:649`): `{ "courses": [...], "degraded": bool, "zoomIn": bool }` — always all three keys.
  - DB pins (`_db_courses_in_bounds`, `:266-283`): `{id: str, name, address, center: {lat,lng}, source: "local"}`.
  - OSM pins (`osm.search_golf_courses` output + `attach_stable_ids`): `{osm_id: "way/123", name, address: str|null, center: {lat,lng}, phone?, source: "osm", id: <deterministic UUID>}` — `attach_stable_ids` (`course_finder.py:216-227`) is applied to cold-cell hits before caching AND to the merged list (`course_search.py:637,643`), so **every pin on the wire carries a stable `id`**; `osm_id` rides along on OSM pins. `name` defaults to `"Golf Course"` for unnamed OSM ways; `address`/`center` can theoretically be null on malformed rows — the client mapper must filter rows lacking `id`, `name`, or a finite `center`.
  - `zoomIn: true` ⇢ bbox area > 0.25 sq° (`IN_BOUNDS_MAX_AREA_SQDEG`), `courses: []`, no leg ran.
  - `degraded: true` ⇢ a cold OSM cell **raised**; DB pins still present. degraded ≠ empty.
  - Cap 40 pins (`IN_BOUNDS_MAX_PINS`), DB-first ordering. Backend cell size `IN_BOUNDS_CELL_DEG = 0.05`, floor-indexed integer cells (`_cells_for_bbox`, `:110-131`). Auth: none (no paid API on this path); `fetchAPI` attaching a Bearer anyway is harmless.
- **No frontend client exists** — `grep fetchCoursesInBounds|in-bounds` in `frontend/src/lib/golf-api.ts` returns nothing. New client needed.
- **`CourseSelectPayload`** (`CourseSearch.tsx:64-80`) and **`resultToPayload`** (`:154-168`): for non-golfapi sources → `id = r.id`, `clubId = r.golfApiClubId ?? r.id` (= `r.id` for pins), `clubName = r.clubName ?? r.name` (= `r.name`), `location = [city,state] || address`, `source`, `center`. `resultToPayload` is currently module-private (not exported).
- **`searchAllCourses` row mapping** (`golf-api.ts:558-570`): `id: c.id ?? c.osm_id ?? ''`, `source: normalizeSource(c.source)`, `sourceLabel: sourceLabelFor(...)` — this is the shape the list path feeds `resultToPayload`. `"local"` → label `MAPPED`, `"osm"` → `OSM` (`SOURCE_LABELS`, `:441-447`).
- **Native map precedent** (`GoogleSatelliteMap.tsx`): dynamic `import("@capacitor/google-maps")` inside `useEffect` (module references `HTMLElement` at eval time — top-level import crashes SSR/static build); `<capacitor-google-map>` custom element (NOT a div — iOS native side binds to the element's WKChildScrollView, `:75-89`) + `customElements.whenDefined` before `create`; **onMapReady promise gate before ANY native call** (`:515-577`) because the plugin force-unwraps a nil `GMSMapView` in every method → uncatchable SIGTRAP; 13s ready timeout → graceful fallback, never a forced proceed; `destroyed` flag + `createInProgressRef` StrictMode guard; unique map id counter; **never `fitBounds`** (`:398-403` — nil-unwrap crash, use `setCamera`); key gating = `(process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "").trim()` (`:457`).
- **Plugin API** (verified in `node_modules/@capacitor/google-maps/dist/typings`): `setOnCameraIdleListener(cb)` delivers `CameraIdleCallbackData { bounds: {southwest:{lat,lng}, northeast:{lat,lng}, center}, zoom, ... }` — the bbox comes free with the idle event, **no extra native `getMapBounds()` call needed**. `setOnMarkerClickListener(cb)` delivers `{markerId, latitude, longitude, title, snippet}` — keep a `Map<markerId, pin>` ref. `addMarkers(Marker[])/removeMarkers(string[])` batch. `Marker.iconUrl` is a path relative to the web public dir (`assets/...` convention, cf. `teeMarkerIconUrl` → `assets/tee-marker-*.png`); **SVGs not supported on native — PNG required**. Roadmap type = `MapType.Normal`.
- **Test infra:** vitest (`npm test` = `vitest run`); jsdom component-test precedent with full module mocking already exists at `frontend/src/components/CourseSearch.test.tsx`; pure-helper test homes: `frontend/src/lib/course/*.test.ts`, `frontend/src/lib/map/google-map-helpers.test.ts` (includes `createCameraQueue`).
- **Sim workflow:** `frontend/ios/SIMTEST.md` (build → `cap sync ios` → `xcodebuild ... -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO` → `simctl install/launch --console-pty` → `simctl io booted screenshot`).

---

## 1. Architecture decision: full-screen map region, not an in-sheet overlay

Spec §Risks flags native layering inside the fixed course-search frame as "proven but finicky". The finicky part is concrete: the CourseSearch outer frame paints an opaque `PAPER_NOISE + T.paper` background across the whole `position:fixed; inset:0; 100dvh` surface (`CourseSearch.tsx:593`), and the native GMSMapView shows through only where the DOM above it is transparent. A partial in-sheet map (list + map sharing the scroll region, or a map peeking under rows) would require punching a transparent hole through animated, keyboard-shifting content — fragile.

**Decision (recommended from the start, per the brief):** in map mode the map **replaces the entire scroll region** — the frame becomes: opaque paper search-bar header on top (unchanged), `<CourseScoutMap>` filling `flex: 1` below it. While `mode === "map"`:

- the outer `motion.div` background switches to `"transparent"` (no paint behind the map region),
- the header row carries its own `background: ${PAPER_NOISE}, ${T.paper}` + `backgroundBlendMode: "multiply"` so it stays visually identical,
- all map chrome (mode toggle, status one-liners, the tap card) are absolutely-positioned React siblings ON TOP of the map element — the standard Capacitor layering pattern from `GoogleSatelliteMap.tsx`.

The list region and all its state (favorites/recent/nearby/searchResults/session) stay in `CourseSearch` state — toggling back to list restores it exactly (no refetch, no reshuffle). The list subtree is simply not rendered while in map mode.

Mode always **starts as `"list"`** (default + fallback). Because the frame's framer-motion entry animation runs once at mount (key `cs-surface`, before the map can ever mount), no transform is ever animating on a map ancestor while the native view is attaching — this avoids native-view/DOM position desync.

---

## 2. Files to create / edit

### 2.1 `frontend/src/lib/golf-api.ts` — EDIT: typed `/in-bounds` client

Add next to `searchNearbyDetailed`:

```ts
/** One pin from GET /api/courses/in-bounds (course-selection B1). */
export interface InBoundsCourse {
  id: string;                          // stable UUID (attach_stable_ids) or DB id — always present on the wire
  name: string;
  address?: string | null;
  center: { lat: number; lng: number };
  source: string;                      // "local" | "osm" (defensive: string)
  osm_id?: string;                     // OSM passthrough, unused by B2
}

export interface InBoundsResponse {
  courses: InBoundsCourse[];
  degraded: boolean;
  zoomIn: boolean;
}

export interface BBox { swLat: number; swLng: number; neLat: number; neLng: number; }

export async function fetchCoursesInBounds(bbox: BBox, signal?: AbortSignal): Promise<InBoundsResponse>
```

Implementation: `fetchAPI<...>('/api/courses/in-bounds?swLat=...&swLng=...&neLat=...&neLng=...', { signal: combineSignals(signal, AbortSignal.timeout(10000)) })` (reuse the module's existing `combineSignals`, `:472-483`; 10s internal timeout covers the worst cold-cell case: 4 concurrent OSM fetches ≤ ~5.5s each). Defensively normalize the raw payload: drop rows missing `id`, non-empty `name`, or finite `center.lat/lng` (honesty: never render a pin without a real center); coerce `degraded`/`zoomIn` with `Boolean(...)`; missing keys → `{courses: [], degraded: false, zoomIn: false}` is NOT synthesized from an error — a thrown/aborted fetch propagates to the coordinator (which treats it as a failed fetch, below). **No new shared type in `types.ts`** — wire-response types for course search live in `golf-api.ts` by existing convention (`CourseSearchApiResponse`, `MappedCourseApiResponse`); note this in the PR so the types.ts↔models.py sync rule is visibly considered.

### 2.2 `frontend/src/lib/course/scout-viewport.ts` — NEW: pure viewport-fetch helpers (the QA surface)

Pure TS, zero DOM/plugin/React imports — unit-testable in Node exactly like `google-map-helpers.ts`. Contents:

```ts
export const SCOUT_CELL_DEG = 0.05;          // MUST mirror backend IN_BOUNDS_CELL_DEG
export const SCOUT_DEBOUNCE_MS = 600;        // spec: 500–700ms

/** Floor-indexed integer cell keys ("ilat:ilng") intersecting the bbox —
 *  same flooring as backend _cells_for_bbox (course_search.py:110-131),
 *  so client coverage aligns with server cache cells. Pure. */
export function bboxToCells(bbox: BBox): string[]

/** True when every cell of the bbox is already in `covered`. Pure. */
export function bboxFullyCovered(bbox: BBox, covered: ReadonlySet<string>): boolean

export interface ScoutFetchResult {
  newPins: InBoundsCourse[];   // deduped: only ids never delivered before
  zoomIn: boolean;
  degraded: boolean;
}

export interface ScoutCoordinator {
  /** Feed every camera-idle bbox here. Debounced internally. */
  onCameraIdle(bbox: BBox): void;
  /** Cancel timer + abort in-flight fetch (mode-leave/unmount). */
  cancel(): void;
}

export function createScoutCoordinator(deps: {
  fetchInBounds: (bbox: BBox, signal: AbortSignal) => Promise<InBoundsResponse>; // injected — testable without network
  onResult: (r: ScoutFetchResult) => void;
  onError?: () => void;              // non-abort failure (quiet note, never fake-empty)
  onLoading?: (loading: boolean) => void;
  debounceMs?: number;               // default SCOUT_DEBOUNCE_MS
}): ScoutCoordinator
```

`createScoutCoordinator` semantics (each one is a unit test, §5):

1. **Debounce (trailing):** every `onCameraIdle` clears the pending timer and re-arms `debounceMs` with the LATEST bbox — a rapid pan burst coalesces to one fetch.
2. **Covered-cell skip:** when the timer fires, if `bboxFullyCovered(bbox, covered)` → no fetch, no abort of anything, `onLoading` untouched. Panning back into seen territory costs zero network.
3. **Abort-hardened:** before starting a fetch, `abort()` the previous in-flight controller; create a fresh `AbortController` per fetch. Additionally keep a monotonically increasing generation counter — a resolution whose generation ≠ latest **never delivers** (belt for abort losing the race, same guarantee `course-search-session.ts` documents).
4. **Coverage marking:** on success, `bboxToCells(bbox)` are added to `covered` **only when `!degraded && !zoomIn`** — a degraded viewport must retry on the next pan (never freeze a lie into the coverage set); a zoomIn response covered nothing.
5. **Pin dedupe:** maintain `seenIds: Set<string>`; `onResult.newPins` contains only pins whose `id` was never delivered — the map layer is append-only (pins from earlier viewports stay; a re-pan never re-adds or reshuffles).
6. **Errors:** `AbortError` → silent. Anything else → `onError()` (and cells NOT covered). Never synthesize an empty-success.
7. `cancel()` clears the timer, aborts in-flight, bumps the generation (so a late resolve after cancel is dead).

**Budget invariant by construction:** the coordinator's only I/O is the injected `fetchInBounds`; `CourseScoutMap` injects `fetchCoursesInBounds` and imports nothing else network-shaped. The map path can only ever hit B1 `/in-bounds` — no Places/GolfAPI/Mapbox call is reachable from this component (mirror the B1 docstring wording in the component header comment; verify with `grep -n "fetchAPI\|searchAll\|searchNearby" CourseScoutMap.tsx` → only `fetchCoursesInBounds` via props/import).

### 2.3 `frontend/src/lib/course/pin-payload.ts` — NEW: pin → identity mapping (the B.3 parity crux)

```ts
/** Map an /in-bounds pin into the SAME CourseSearchResult shape
 *  searchAllCourses emits (golf-api.ts:558-570) — so the marker Add path can
 *  funnel through the identical resultToPayload the list path uses. */
export function pinToSearchResult(pin: InBoundsCourse): CourseSearchResult {
  return {
    id: pin.id,                        // stable UUID — same id the list path gets for this course
    name: pin.name,
    address: pin.address ?? undefined,
    center: pin.center,
    source: normalizeSourceForPin(pin.source),  // "local" | "osm" (unknown → "local", same rule as golf-api normalizeSource)
    sourceLabel: pin.source === "osm" ? "OSM" : "MAPPED",
  };
}
```

To avoid duplicating `normalizeSource`/`sourceLabelFor` (currently module-private in `golf-api.ts`): **export them from `golf-api.ts`** (pure, zero-risk export) and reuse — do not re-implement.

**Identity path (byte parity):** `pin → pinToSearchResult → resultToPayload → onSelectCourse`. Because pins are only `local`/`osm` (never `golfapi`), `resultToPayload` yields `id = pin.id` (the deterministic write-through UUID for OSM hits — the same UUID `resolve_selectors` reconciles, spec §B.3), `clubId = pin.id`, `clubName = pin.name`, `location = pin.address` (pins carry no city/state fields, so the `[city,state] || address` chain resolves to `address` — same as an OSM list row), `source`, `center`. A course added from the map is **indistinguishable** from the same course added from the list because both literally run through the same mapper on the same wire fields. To make this testable, add `export` to `resultToPayload` in `CourseSearch.tsx` (one-word change; no import cycle — the parity **test** imports both, `CourseScoutMap` imports neither, see §2.5 wiring).

### 2.4 `frontend/public/assets/course-flag.png` — NEW: quiet ink golf-flag marker

- Design: minimal golf flag — a thin flagstick with a small triangular pennant, drawn in `T.ink` (`#1a2a1a`) with the pennant filled `T.pencil` (`#6b6558`) at ~90% opacity, on a transparent background. No teardrop, no drop shadow, no white halo. Rendered at 78×78 px (3×), displayed via `addMarkers` at `iconSize: {width: 26, height: 26}`, `iconAnchor: {x: 5, y: 26}` (anchor = base of the stick, so the flag "stands" on the course center), `isFlat: false`.
- Generation (no new deps): one-off script `frontend/scripts/render-course-flag.mjs` using **playwright chromium** (already a devDependency, same as `ios/simtest-headless.mjs`): load a data-URL SVG at 78×78, `page.screenshot({ omitBackground: true })` → PNG. Commit the PNG; the script is checked in for regeneration. Exact SVG (26×26 viewBox, scaled 3×):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26">
  <line x1="5" y1="2.5" x2="5" y2="26" stroke="#1a2a1a" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M6 2.5 L20 6.5 L6 10.5 Z" fill="#6b6558" fill-opacity="0.92" stroke="#1a2a1a" stroke-width="1.2" stroke-linejoin="round"/>
</svg>
```

- **If the icon fails to load, the plugin silently falls back to the red default teardrop** — that is a design regression, not a crash; the sim screenshot step (§6) explicitly checks pin appearance, and the designer review gate covers it.

### 2.5 `frontend/src/components/CourseScoutMap.tsx` — NEW: the native map mode

Props (narrow; no `onSelectCourse` here — identity mapping stays in `CourseSearch` so this component never imports from `CourseSearch.tsx`, avoiding a cycle):

```ts
interface CourseScoutMapProps {
  /** Fires with the tapped pin when the golfer hits "Add" on the card. */
  onAddPin: (pin: InBoundsCourse) => void;
  /** Initial camera center (GPS fix, else a sensible fallback — see below). */
  initialCenter: { lat: number; lng: number };
  /** Typed/voice query top hit — camera pans here when it changes. Never reshuffles anything. */
  panTarget: { id: string; center: { lat: number; lng: number } } | null;
}
```

**Structure & lifecycle (copy the `GoogleSatelliteMap` discipline literally):**

1. Render `<capacitor-google-map ref=... style={{display:"block", width:"100%", height:"100%", background:"transparent"}} />` filling the component (which fills the frame's `flex:1` region). Reuse the existing `declare module "react"` JSX augmentation by declaring it identically in this file (or hoist the augmentation — it's global either way; simplest: it is already globally declared by `GoogleSatelliteMap.tsx`'s module augmentation, but do not rely on incidental import order — redeclare locally, TS merges).
2. Mount effect (deps `[]`), guarded by `createInProgressRef` (StrictMode) and a `destroyed` flag:
   - key check is the **caller's** job (toggle doesn't render without it), but keep the same defensive trim-check + bail as `GoogleSatelliteMap.tsx:457-464`.
   - zero-size container check (`getBoundingClientRect`).
   - `const { GoogleMap, MapType } = await import("@capacitor/google-maps")`; `await customElements.whenDefined("capacitor-google-map")`.
   - `GoogleMap.create({ id: nextScoutMapId(), element, apiKey, config: { center: initialCenter, zoom: 12, mapTypeId: MapType.Normal, disableDefaultUI: true }, forceCreate: true }, () => signalReady())`. **Roadmap = `MapType.Normal`.** Zoom 12 ⇒ iPhone viewport ≈ 0.11° × 0.05° ≈ 0.006 sq° — comfortably under the 0.25 sq° zoomIn ceiling, so the first idle always yields pins where courses exist.
   - **Ready gate:** `await Promise.race([mapReadyPromise, 13s timeout])`; on timeout → destroy, set an honest error state (`"Map couldn't load"` one-liner + the parent's toggle still works to go back to list), never proceed. Only after ready: `mapReadyRef.current = true`.
   - Register `setOnCameraIdleListener((ev) => { if (!mapReadyRef.current) return; coordinatorRef.current.onCameraIdle({ swLat: ev.bounds.southwest.lat, swLng: ev.bounds.southwest.lng, neLat: ev.bounds.northeast.lat, neLng: ev.bounds.northeast.lng }); })` — the bbox comes from the idle payload; **no `getMapBounds()` native round-trip**. The idle listener also fires after `create` settles and after programmatic `setCamera`, so the initial viewport and every pan-to-hit fetch pins with zero special-casing.
   - Register `setOnMarkerClickListener(({ markerId }) => setSelectedPin(markerIndexRef.current.get(markerId) ?? null))` and `setOnMapClickListener(() => setSelectedPin(null))` (tap empty map dismisses the card).
3. **Gating contract (the crash rule):** every native call sits behind `if (!googleMapRef.current || !mapReadyRef.current) return;`. Calls that can arrive early (coordinator results, panTarget effect) **skip** rather than queue — the camera-idle loop is self-healing (the next idle re-fetches anything missed), and `panTarget` re-applies via its effect once ready flips (include a `ready` state bump so effects re-run). Never substitute a different plugin method to dodge the gate (the `fitBounds` lesson: EVERY method nil-unwraps).
4. **Marker application — serialized:** reuse `createCameraQueue` from `@/lib/map/google-map-helpers` (it is a generic coalescing async serializer) instantiated over "apply pending pin batch": `addMarkers(newPins.map(pinToMarker))` → store returned ids into `markerIndexRef: Map<string /*markerId*/, InBoundsCourse>`. Pins are append-only (coordinator already dedupes by course id) — **no removeMarkers during a session**; the whole set dies with `destroy()`. `pinToMarker(pin)` = `{ coordinate: pin.center, iconUrl: "assets/course-flag.png", iconSize: {width:26,height:26}, iconAnchor: {x:5,y:26}, title: pin.name }`. No clustering (`enableClustering` is never called — no SaaS pin-clumps; B1's 40-pin cap keeps density sane).
5. **Coordinator wiring:** `coordinatorRef` created once with `fetchInBounds: fetchCoursesInBounds`, `onResult: ({newPins, zoomIn, degraded}) => { queue.request(newPins); setZoomInNote(zoomIn); setDegradedNote(degraded); setEmptyHonest(!zoomIn && !degraded && newPins.length === 0 && markerIndexRef.current.size === 0); }`, `onLoading: setScouting`.
6. **panTarget effect:** when `panTarget?.id` changes (compare ids, not object identity) and the map is ready → `setCamera({ coordinate: panTarget.center, zoom: 13, animate: true, animationDuration: 600 }).catch(() => {})`. **Pan only — never touches markers, never clears, never reorders** (course-search-ux-requirements: typed query pans to the top hit, NEVER reshuffles). The resulting camera-idle then quietly fetches that viewport's pins.
7. **Unmount cleanup:** `destroyed = true; mapReadyRef.current = false; googleMapRef.current = null; createInProgressRef.current = false; coordinatorRef.current.cancel(); gMap?.destroy().catch(() => {})`. Unique id per mount (`scout-map-${++counter}` — the module counter pattern from `GoogleSatelliteMap.tsx:190-194`) + `forceCreate: true` means a list⇄map⇄list⇄map toggle can never collide with or leak a previous native instance; the destroy is fire-and-forget exactly like the precedent.

**Chrome (all T.\* tokens, absolutely positioned over the map):**

- **Status one-liners** (bottom-center, above the card zone, `T.mono` 8.5px letterSpacing 1.1 uppercase on a `${T.paper}e8` pill — the quiet idiom from `GoogleSatelliteMap`'s center-only note):
  - `zoomIn` → "Zoom in to see courses". **Existing pins are kept** (they are real courses already verified — removing them would be dishonest churn; the note explains why nothing new appears).
  - `degraded` → "Some courses may be missing here" (DB pins shown; NEVER treated as empty). Clears on the next non-degraded result.
  - honest empty (successful fetch, zero pins ever, not zoomIn/degraded) → "No courses in this view." — one calm line, no invented pins, no retry button (no-fake-data-fallbacks).
  - fetch error (`onError`) → "Couldn't check this area" (matches the list's `Couldn't load nearby courses` tone). Never rendered as an authoritative empty.
  - Only one line renders at a time (priority: zoomIn > degraded > error > empty).
- **Scouting indicator:** while a fetch is in flight, the same pulsing-dot idiom as the search bar (`motion.div opacity [0.3,0.8,0.3]`) inside the status pill area — never a spinner, never a layout shift.
- **The tap card** (bottom, one row, matches `CourseRow` feel): fixed at `bottom: max(14px, env(safe-area-inset-bottom))`, left/right 14px; `background: T.paper`, `border: 1px solid T.hairline`, `borderRadius: 12`, subtle shadow; grid `1fr auto`; left: `T.serif` 16px `T.ink` name + `T.mono` 8.5px uppercase `T.pencilSoft` subline via the existing `buildRowSubline({ name, clubName: undefined })` pattern — subline = `pin.address ?? sourceLabel` ("MAPPED"/"OSM", reuse `resultSourceLabel` semantics); right: an **"Add"** button — `T.ink` background, `T.paper` text, `T.mono` 10px letterSpacing 1.2 uppercase, borderRadius 99, `padding: 8px 16px`, min tap target 44px. Card enter/exit via `AnimatePresence` y-fade (framer-motion, 0.2s, `T.ease`). Tapping Add → `onAddPin(selectedPin)`. Tapping the map elsewhere or another pin replaces/dismisses it. (Framer animation on the card is fine — it's a sibling overlay, not a map ancestor.)

### 2.6 `frontend/src/components/CourseSearch.tsx` — EDIT: mode toggle + map region

1. `export` `resultToPayload` (parity test import; no other change to it).
2. Key gating: `const hasMapsKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "").trim().length > 0;` (module scope — mirrors `GoogleSatelliteMap.tsx:457`; do NOT use `mapRendererFor` since that also folds in the satellite-vs-paper user pref, which is unrelated).
3. `const [mode, setMode] = useState<"list" | "map">("list");` — list is always the initial mode.
4. **Toggle button** in the header row, after the mic slot: rendered **only when `hasMapsKey`** — absent key ⇒ no toggle node at all, the surface renders byte-identically to today (graceful; zero dead tap targets, same rule as the mic button `:689`). Same 40×40 round button idiom as mic/back: inline SVG map icon in list mode (folded-map glyph, `strokeWidth 1.8`, `T.pencil`), list-lines glyph in map mode; `aria-label={mode === "list" ? "Map view" : "List view"}`; active style mirrors the listening-mic treatment (ink fill) when in map mode. `data-testid="course-search-mode-toggle"`.
5. Render switch in the content area: `mode === "list"` → existing scroll region untouched; `mode === "map"` → `<CourseScoutMap onAddPin={...} initialCenter={...} panTarget={...} />` in a `flex:1, minHeight:0, position:relative` wrapper. Outer frame background becomes `"transparent"` and the header gets its own paper background while in map mode (§1).
6. `onAddPin` handler: `(pin) => onSelectCourse(resultToPayload(pinToSearchResult(pin)))` — the single identity seam (§2.3). No `onClose()` call beyond whatever the caller's `onSelectCourse` already does — identical to a list-row select.
7. **initialCenter:** lift the mount GPS fix into state (the existing one-shot GPS effect `:446-477` already gets `pos` — additionally `setGpsCenter(pos)`); `initialCenter = gpsCenter ?? idle.nearby[0]?.center ?? favorites[0]?.center ?? { lat: 40.7128, lng: -74.006 }` (the precedent's last-resort placeholder — a map centered somewhere honest with zero fake pins is acceptable; the camera-idle loop tells the truth about what's there).
8. **panTarget:** `const topHit = searchResults[0]; const panTarget = mode === "map" && query.length >= 2 && topHit?.center ? { id: topHit.id, center: topHit.center } : null;` — the existing debounced session (`:505-515`) keeps running in map mode untouched (voice dictation types into the same query, so voice works in map mode for free). The list of results is NOT rendered in map mode; only the top hit's center steers the camera. No camera move when the top hit lacks a center (honest no-op).
9. Keyboard/`autoFocus`: unchanged — input keeps focus behavior; in map mode the iOS keyboard overlays the map region (frame is fixed 100dvh; nothing resizes — the structural fix is preserved because the map region, like the scroll region, is the only flexible child).

### 2.7 Tests — NEW/EDIT

- `frontend/src/lib/course/scout-viewport.test.ts` (NEW)
- `frontend/src/lib/course/pin-payload.test.ts` (NEW)
- `frontend/src/components/CourseSearch.test.tsx` (EDIT — add toggle-gating cases; mock `./CourseScoutMap` to a stub div so no plugin import runs in jsdom)

Details in §5.

---

## 3. Implementation order (builder's sequence)

1. `golf-api.ts` client (`fetchCoursesInBounds` + types + export `normalizeSource`/`sourceLabelFor`).
2. `scout-viewport.ts` + its tests (pure, red→green before any UI exists).
3. `pin-payload.ts` + export `resultToPayload` + parity test.
4. Flag asset + generator script.
5. `CourseScoutMap.tsx`.
6. `CourseSearch.tsx` toggle wiring + component-test additions.
7. Gates (§7), then sim verification (§6), then designer review (B2 sequencing note in the parent spec).

---

## 4. Edge cases & risks (each with its handling)

| Risk | Handling |
|---|---|
| **onMapReady race / nil GMSMapView SIGTRAP** | Ready-promise gate before ANY native call; 13s timeout → honest error state, never forced proceed; every callback/effect re-checks `mapReadyRef`; early calls SKIP (idle loop self-heals), never method-swapped. `fitBounds` is banned; camera moves via `setCamera` only. |
| **Abort races on rapid pan** | Coordinator: trailing debounce + per-fetch AbortController + generation counter — a stale resolve can never deliver (tested). |
| **No-reshuffle on typed query** | Map mode: typed/voice query only pans the camera to the top hit (id-change-gated); markers are append-only; nothing is removed/reordered. List mode behavior untouched. |
| **zoomIn** | Note "Zoom in to see courses", existing pins kept, no cells covered, no fetch churn (0.25 sq° matches backend ceiling). |
| **degraded ≠ empty** | Quiet "some courses may be missing" note; DB pins render; cells NOT marked covered so a re-pan retries; never an authoritative empty. |
| **Native map instance leak on list⇄map toggles** | Unique map id per mount + `forceCreate` + destroy-on-unmount + StrictMode re-entry guard + `destroyed` flag on the async create path (exact `GoogleSatelliteMap` pattern). |
| **Overpass cold-viewport latency (first pan into a cold metro)** | 10s client timeout ≥ backend worst case; pulsing-dot scouting indicator; DB pins arrive in the same response regardless; skipped cold cells warm on later pans (backend behavior) — the UI just quietly gains pins next idle. |
| **Budget invariant** | Map path calls ONLY `fetchCoursesInBounds` → `/in-bounds` (OSM+DB only, enforced server-side by construction). `CourseScoutMap` has no other data import; the typed-query pan reuses the pre-existing list search session (no NEW spend introduced by B2). Reviewer check: grep `CourseScoutMap.tsx` for `fetchAPI|searchAll|searchNearby|golfapi|places|mapbox` → only the injected client. |
| **Opaque-frame occlusion of the native map** | §1 restructure: transparent outer frame in map mode, opaque header, overlay chrome. If the sim still shows paper over the map (WKWebView compositing surprise), the escape hatch is already the architecture: map mode is full-region, so the only remaining fix is moving the background one level down — no overlay redesign needed. |
| **Marker icon load failure → red teardrop** | Sim screenshot check + designer review; asset committed (not runtime-generated). |
| **Pins without name/center from a stale cache** | Client-side filter in `fetchCoursesInBounds` normalization (never render a pin at a nonexistent center). |
| **jsdom tests importing the plugin** | `CourseScoutMap` is mocked in component tests; the plugin import stays dynamic inside the mount effect (also keeps `npm run build` SSR-safe — same reason as the precedent). |

---

## 5. Unit tests (the QA gates for logic)

**`scout-viewport.test.ts`** (vitest, `vi.useFakeTimers`, injected fake `fetchInBounds`):
1. `bboxToCells`: known bbox `{sw:40.70,-73.50 → ne:40.78,-73.42}` → exact expected `ilat:ilng` keys (floor of value/0.05); negative-coordinate flooring (`-0.01` → cell `-1`, not `0`); single-cell bbox → 1 key. Cross-checkable by hand against backend `_cells_for_bbox` flooring.
2. **Debounce coalescing:** 3 `onCameraIdle` calls within 600ms → after `advanceTimersByTime(600)`, exactly ONE fetch, with the LAST bbox.
3. **Covered-cell skip:** successful clean fetch → same bbox idle again → timer fires → NO second fetch. Overlapping-but-extending bbox → fetch DOES fire (some cells uncovered).
4. **Degraded doesn't cover:** fetch resolves `degraded: true` → same bbox again → fetch fires again.
5. **zoomIn:** resolves `zoomIn: true, courses: []` → `onResult` sees `zoomIn: true`, no cells covered, no pins.
6. **Abort-cancels-stale:** first fetch pending (unresolved promise) → new idle + timer → first controller's `signal.aborted === true`; then resolve the FIRST promise → its result never reaches `onResult` (generation guard).
7. **Pin dedupe:** two fetches returning an overlapping course id → second `onResult.newPins` excludes it.
8. **Error honesty:** rejecting fetch (non-abort) → `onError` fired, `onResult` NOT fired, cells not covered. AbortError → neither fired.
9. `cancel()`: pending timer cleared; in-flight aborted; late resolve dead.

**`pin-payload.test.ts`** — the parity crux:
1. OSM pin `{id: "u-1", name: "Marine Park GC", address: "Brooklyn, NY", center, source: "osm", osm_id: "way/9"}`: `resultToPayload(pinToSearchResult(pin))` **deep-equals** `resultToPayload(<CourseSearchResult built exactly as golf-api.ts:558-570 builds it from the same wire fields>)` — i.e. `{id: "u-1", name, clubName: name, clubId: "u-1", location: "Brooklyn, NY", source: "osm", center}`.
2. Same for a `local` DB pin (address null → `location: undefined`).
3. Unknown `source` string normalizes to `"local"` (mirrors `normalizeSource`).
4. `pinToSearchResult` never fabricates `golfApiClubId`/`golfApiCourseId` (so `clubId` derivation stays `id`).

**`CourseSearch.test.tsx` additions** (jsdom, `vi.mock("./CourseScoutMap")` → stub with `data-testid="course-scout-map"` that exposes its props via a spy):
1. `vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", "")` → `course-search-mode-toggle` NOT in the document; list renders as before. (Env is read at module scope — use `vi.resetModules()` + dynamic import per case, the established pattern for env-gated modules.)
2. Key set → toggle renders; initial mode is list (scroll region present, scout map absent).
3. Click toggle → scout map stub mounts, scroll region gone; click again → list restored (favorites/recent still rendered from preserved state — assert a seeded favorite row survives the round-trip).
4. Stub's `onAddPin` invoked with a pin → `onSelectCourse` called with the exact parity payload.
5. In map mode, driving the captured session `onResults` with a top hit carrying a center → stub receives `panTarget` with that id/center; driving it with a hit WITHOUT a center → `panTarget` stays null (and nothing throws).

---

## 6. iOS Simulator verification (REQUIRED — web preview cannot exercise this)

**Web preview / jsdom CANNOT render the native map** — `@capacitor/google-maps` on the web dev server uses the Maps JS API path and, more importantly, none of the native layering/onMapReady/SIGTRAP behavior exists there. Sim verification is mandatory; the builder's report must state explicitly what was and wasn't verified.

Per `frontend/ios/SIMTEST.md` + the `ios-simulator-map-testing` precedent (Debug ungated sim build, screenshots as evidence — cf. `specs/persistent-map-tee-marker-plan.md` §verification):

1. **Backend:** run locally (`cd backend && python -m uvicorn app.main:app --reload`) with a real `DATABASE_URL` so `/in-bounds` returns genuine DB pins; the iOS simulator shares the host network, so `http://localhost:8000` is reachable. Sanity-check the endpoint first from the shell: `curl 'http://localhost:8000/api/courses/in-bounds?swLat=40.70&swLng=-73.52&neLat=40.78&neLng=-73.40'` (Farmingdale/Bethpage box) → non-empty `courses`, note the exact ids/names for step 6. (If local DB isn't available, point at staging and say so in the report.)
2. **Build:** `cd frontend && export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=… NEXT_PUBLIC_GOOGLE_MAPS_KEY=<the key> NEXT_PUBLIC_API_URL=http://localhost:8000 && npm run build && npx cap sync ios` — **the Maps key must be exported at build time** (it's inlined; forgetting it makes the toggle invisible, which would falsely "pass" the no-key gating and fail everything else).
3. **Sim app:** `xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath /tmp/looper-sim -skipPackagePluginValidation CODE_SIGNING_ALLOWED=NO build`; `simctl install booted`; `simctl launch --console-pty booted com.looperapp.app > /tmp/looper-stdout.txt 2>&1 &`.
4. **Drive** to the course-search surface (courses tab → search affordance), then tap the Map toggle. Simulator taps are injected by clicking the Simulator window (AppleScript/`cliclick` at screenshot-derived coordinates) — screenshot before/after every tap (`xcrun simctl io booted screenshot /tmp/b2-<step>.png`) so coordinates are verifiable and the evidence trail is honest.
5. **Screenshot (a):** map mode renders — roadmap tiles visible under the paper header, toggle in map state, no paper sheet occluding the map region, no "Loading map…"-style hang. Also grep `/tmp/looper-stdout.txt` for the plugin's console errors and for any `[error]` lines.
6. **Screenshot (b):** pan/settle on the known-course viewport (Farmingdale box from step 1; drive there by typing "Bethpage" — which ALSO verifies typed-query-pans-to-top-hit) → ink flag pins appear at the known centers; verify pin count is plausible vs the curl from step 1; verify pins are the flag asset, NOT red teardrops.
7. **Screenshot (c):** tap a pin → one-row card with the course name; tap **Add** → the course lands in the caller (visible selected state on the courses/tee-time surface); cross-check the backend access log shows ONLY `/api/courses/in-bounds` (+ the one `/api/courses/search` for the typed query) — no Places/GolfAPI/Mapbox-triggering routes on the map path.
8. **Toggle stress:** list⇄map⇄list⇄map twice, then background/foreground the app once — no crash in stdout, map re-renders (screenshot), confirming no leaked/colliding native instances.
9. **Report honestly:** which screenshots were captured, which checks passed, and explicitly which behaviors were NOT verified (e.g. real-device GPS, Android, cold-Overpass latency if all cells were warm).

---

## 7. Gates (all must be state:SUCCESS before done)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm test                      # includes scout-viewport, pin-payload, CourseSearch toggle tests
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npm run build                 # SSR/static-export safety (dynamic plugin import)
```

plus the §6 sim smoke (screenshots a/b/c + toggle stress) and the designer review (parent spec sequences B2 with designer review; NORTHSTAR: calm, yardage-book, no SaaS chrome — the reviewer's parity crux is §2.3's identity path and the reshuffle/honesty rules).

---

### Critical Files for Implementation

- /Users/justinlee/projects/scorecard/frontend/src/components/CourseSearch.tsx — mode toggle host; `resultToPayload` export; the one identity seam
- /Users/justinlee/projects/scorecard/frontend/src/components/CourseScoutMap.tsx — NEW native map mode (create/onMapReady-gate/idle-loop/markers/card, per GoogleSatelliteMap discipline)
- /Users/justinlee/projects/scorecard/frontend/src/lib/course/scout-viewport.ts — NEW pure debounce + bbox→cells + covered-skip + abort coordinator (the unit-test surface)
- /Users/justinlee/projects/scorecard/frontend/src/lib/golf-api.ts — NEW `fetchCoursesInBounds` client + `InBoundsCourse` types; export `normalizeSource`/`sourceLabelFor`
- /Users/justinlee/projects/scorecard/frontend/src/components/GoogleSatelliteMap.tsx — the lifecycle/layering/ready-gate precedent to copy (read-only reference)
