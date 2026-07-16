# Map Marker Craft — ink pin with paper flag cutout (owner visual-polish)

Owner-flagged: the scout map's marker is a thin flag glyph + the stock Google
info-window box. Designer's committed treatment: Google's weighted
balloon-with-point silhouette, recolored ink/paper, with a mini golf-flag
glyph in a paper cutout. Two tiers (quiet in-bounds / search highlight), two
committed PNGs, `title` dropped from BOTH markers so the existing bottom DOM
tap-card is the sole name surface. No runtime name-baking this pass.
My-location dot untouched. NORTHSTAR: ink/paper, never a red teardrop — the
only red is the T.flag triangle inside the highlight pin's paper cutout.

## §0 The committed geometry (the whole ballgame)

### 0.1 Anchor semantics (verified in vendored plugin source)
`@capacitor/google-maps` iOS (`ios/Sources/CapacitorGoogleMapsPlugin/Marker.swift`
lines 33–43): `groundAnchor = (iconAnchor.x / iconSize.width, iconAnchor.y /
iconSize.height)` — iconAnchor is expressed in the DISPLAYED icon's logical-pt
space, {0,0} = top-left, {w,h} = bottom-right; the anchor point sits ON the
course coordinate. CRITICAL: the plugin computes the anchor **only inside
`if let size = iconSize`** — iconAnchor without iconSize is silently ignored.
Always pass both (we do, on both tiers). Android
(`CapacitorGoogleMapMarker.kt` `buildIconAnchorPoint`) divides identically.
Fractional values are fine (bridged as Double; GMS groundAnchor is a
normalized CGPoint).

### 0.2 Tip decision: KEEP the shadow gap, anchor on the true tip
The grounding shadow is a blurred ellipse rendered AROUND/BELOW the tip, so
the tip cannot sit at the viewBox bottom without clipping the shadow. We keep
the designer's 2-unit shadow room and compute the anchor from the true tip.

**Committed: viewBox `0 0 32 40`; visual tip at exactly (16, 38)**
→ normalized tip = (16/32, 38/40) = **(0.5, 0.95)**.
A naive `{x: w/2, y: h}` anchor would float the pin 5% of its height above
the course — that is the bug this section exists to prevent.

### 0.3 Committed SVG source (both tiers; ONLY the triangle fill differs)
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40">
  <defs>
    <filter id="gs" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="0.6"/>
    </filter>
  </defs>
  <!-- grounding shadow: T.ink @ 16%, blurred. Spans y 35.7-39.3; the blur's
       faintest edge (<2% alpha) clips ~0.3u at the viewBox floor — invisible,
       accepted, and it never extends the opaque silhouette below y ~= 39.5. -->
  <ellipse cx="16" cy="37.5" rx="6.5" ry="1.8" fill="#1a2a1a" opacity="0.16" filter="url(#gs)"/>
  <!-- pin body: head = circle c(16,16) r14 (kappa 7.73), tapering to the tip
       at EXACTLY (16,38). Fill T.ink. -->
  <path fill="#1a2a1a" d="M16 2 C8.27 2 2 8.27 2 16 C2 22.6 6.43 26.96 10.9 31.24 C13.03 33.28 15.06 35.35 16 38 C16.94 35.35 18.97 33.28 21.1 31.24 C25.57 26.96 30 22.6 30 16 C30 8.27 23.73 2 16 2 Z"/>
  <!-- paper cutout (designer: cx16 cy14.6 r8.2), T.paper -->
  <circle cx="16" cy="14.6" r="8.2" fill="#f4f1ea"/>
  <!-- mini golf flag: ink pole + tier-colored pennant (designer's coords).
       Glyph extremes (13,9.4)/(13,19.6)/(20,11.8) are all <=6.0u from the
       cutout center — fully inside r8.2. -->
  <line x1="13" y1="9.4" x2="13" y2="19.6" stroke="#1a2a1a" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M13 9.4 L20 11.8 L13 14.2 Z" fill="{{FLAG_FILL}}"/>
</svg>
```
`{{FLAG_FILL}}`: quiet = `#6b6558` (T.pencil); highlight = `#c1332c`
(T.flag `oklch(0.54 0.18 28)` converted via reference OKLab->sRGB — inlined hex
with a token comment, matching the SCOUT_MAP_BASE_TONE convention, so the
render is Chromium-version independent).

### 0.4 Render scale and output pixels
Render BOTH tiers at **SCALE = 4** → both PNGs are **128×160 px**
(32×40 viewBox × 4). Coverage: quiet displays at 22×27.5pt → 66×82.5 device px
@3x; highlight 36×45pt → 108×135 px @3x, still under 128×160. One scale for
both keeps the script a single loop. (iOS `resizeImageTo` re-renders at
iconSize points via UIGraphicsImageRenderer at device scale — source just
needs >=3x headroom, which this has.)

### 0.5 Committed tier numbers (aspect 32:40 = 0.8 preserved exactly — no distortion)
Anchor arithmetic: `anchor = tip_source × (iconSize / viewBox)`; multiply
before dividing so every value below is exact in IEEE-754 binary.

| tier      | asset                        | iconSize (w×h) | anchor.x = 16·w/32 | anchor.y = 38·h/40        | zIndex |
|-----------|------------------------------|----------------|--------------------|---------------------------|--------|
| quiet     | assets/course-flag.png       | **22 × 27.5**  | **11**             | 38·27.5/40 = **26.125**   | (none) |
| highlight | assets/course-flag-highlight.png | **36 × 45** | **18**             | 38·45/40 = **42.75**      | 2      |

- 27.5pt tall sits in the designer's ~26-28 quiet band (current asset is 26).
- 45pt tall sits in the ~44-48 highlight band (up from today's 40).
- 22 = 27.5·32/40 and 36 = 45·32/40 — exact, so w/h = 0.8 for both.
- 26.125 (26+1/8) and 42.75 (42+3/4) are exactly representable doubles;
  vitest `toEqual` on these literals is safe.

## §1 `frontend/scripts/render-course-flag.mjs` — emit both tiers

Rework the single-asset script into a loop (same Playwright pattern, no new
deps, one `chromium.launch()`):

- `const VB = { w: 32, h: 40 }; const SCALE = 4;` → page viewport and svg CSS
  size = 128×160.
- `const svgFor = (flagFill) => ...` — the §0.3 template with the pennant
  fill interpolated.
- `const ASSETS = [
    { file: "course-flag.png",           flag: "#6b6558" /* T.pencil */ },
    { file: "course-flag-highlight.png", flag: "#c1332c" /* T.flag oklch(0.54 0.18 28) -> sRGB */ },
  ];`
- For each: `page.setContent(html)`, `(await page.$("svg")).screenshot({ omitBackground: true })`,
  write to `public/assets/<file>`.
- Post-write sanity assert (throw on mismatch): parse PNG IHDR
  (`buf.readUInt32BE(16)`/`readUInt32BE(20)`) and require exactly 128×160 —
  this makes "eyeball dimensions" mechanical.
- Update the header comment: two committed assets, viewBox 0 0 32 40, tip at
  (16,38) -> normalized (0.5, 0.95), regenerate via
  `cd frontend && node scripts/render-course-flag.mjs`, and point at this spec.

Both PNGs are committed binaries (old 78×78 course-flag.png is overwritten).

## §2 `frontend/src/lib/course/scout-map-config.ts` — geometry lives here, once

1. Add the committed constants + a pure geometry helper so BOTH tiers derive
   from one tip definition (unit-testable, matching this module's charter):
   ```ts
   /** Source geometry of the committed pin SVG (scripts/render-course-flag.mjs):
    *  viewBox 0 0 32 40; the visual tip is at (16, 38) — NOT the viewBox
    *  bottom (2 units of baked shadow room). Anchoring at {w/2, h} would
    *  float the pin 5% above the course coordinate. */
   export const PIN_VIEWBOX = { width: 32, height: 40 };
   export const PIN_TIP = { x: 16, y: 38 };

   /** Displayed size + tip anchor for a pin of the given height (pt).
    *  Multiply-then-divide keeps the committed heights (27.5, 45) exact. */
   export function pinIconGeometry(height: number): {
     iconSize: { width: number; height: number };
     iconAnchor: { x: number; y: number };
   } {
     const width = (height * PIN_VIEWBOX.width) / PIN_VIEWBOX.height;
     return {
       iconSize: { width, height },
       iconAnchor: {
         x: (PIN_TIP.x * width) / PIN_VIEWBOX.width,
         y: (PIN_TIP.y * height) / PIN_VIEWBOX.height,
       },
     };
   }

   /** Quiet in-bounds pin icon (shared by CourseScoutMap.pinToMarker). */
   export const QUIET_PIN_ICON = {
     iconUrl: "assets/course-flag.png",
     ...pinIconGeometry(27.5),   // -> 22×27.5, anchor {11, 26.125}
   };
   ```
2. `HighlightMarker`: **delete the `title: string` field** (plugin `Marker.title`
   is optional — verified in `dist/typings/definitions.d.ts`).
3. `highlightMarkerFor()`: `iconUrl: "assets/course-flag-highlight.png"`,
   `...pinIconGeometry(45)` (-> 36×45, anchor {18, 42.75}), `zIndex: 2`, **no
   `title`**. `target.name` is no longer read here — the name reaches the
   tap-card through the synthesized `InBoundsCourse` in `markerIndexRef`
   (CourseScoutMap, unchanged). Update the JSDoc (it still claims "reuses
   course-flag.png at 1.5x / 26->40").

### 2.1 `frontend/src/lib/course/scout-map-config.test.ts`
Update `highlightMarkerFor` expectation to the new exact object (iconUrl
`assets/course-flag-highlight.png`, iconSize {36,45}, iconAnchor {18,42.75},
zIndex 2, NO title key — keep `toEqual`, which fails if `title` sneaks back).
Add geometry invariants that lock the tip math for BOTH tiers:
- `pinIconGeometry` preserves the source aspect: `iconSize.width / iconSize.height === 32/40` for heights 27.5 and 45.
- anchor sits on the tip: `iconAnchor.x === iconSize.width / 2` and
  `iconAnchor.y === 0.95 * iconSize.height` (i.e. 38/40) for both tiers.
- `QUIET_PIN_ICON` equals `{ iconUrl: "assets/course-flag.png", iconSize: {22, 27.5}, iconAnchor: {11, 26.125} }` exactly.
- neither `QUIET_PIN_ICON` nor `highlightMarkerFor(...)` has a `title` property
  (`expect("title" in marker).toBe(false)`) — the info-window kill is a tested
  invariant, not a hope.

## §3 `frontend/src/components/CourseScoutMap.tsx` — consume, don't re-state

- Import `QUIET_PIN_ICON` from scout-map-config; `pinToMarker` becomes
  `{ coordinate: pin.center, ...QUIET_PIN_ICON }` — **no `title`**. (Spreading
  the const into the plugin's mutable `Marker` type is fine; readonly-ness
  doesn't survive a spread.)
- Update the `PanTarget` doc comment (it says name/source "feed the marker
  title" — now they feed only the synthesized `InBoundsCourse` for the
  tap-card) and the file-header line about pins if wording references the old
  glyph.
- NOTHING else changes: pinQueueRef batching, highlightQueueRef
  remove/add/replace, markerIndexRef bookkeeping, camera discipline, listeners,
  `enableCurrentLocation` all untouched.

## §4 Correctness confirmations (the brief's a–e)

(a) **Dropping `title` is safe.** Tap resolution is
`setOnMarkerClickListener(({ markerId }) => markerIndexRef.current.get(markerId))`
— marker ids come from `addMarkers`/`addMarker` return values; `title` is never
read anywhere in the flow (grep: the only `title` uses are the two marker
literals + the test). iOS `didTap` fires regardless of title; a nil title just
suppresses the stock info window — exactly the owner's complaint. A11y: the
GMSMarker loses its VoiceOver label, but the DOM tap-card (serif name +
44pt-min Add button) remains the accessible name surface — accepted trade.

(b) **No lifecycle regressions.** Only the marker PAYLOADS change;
`deriveHighlightAction` and both coalescing queues are untouched, so
remove->add/replace still yields exactly one live highlight. Budget invariant
holds: no import/data-path changes — `fetchCoursesInBounds` remains the only
network call (header grep guard still passes). Initial-bounds prime
(`getMapBounds` -> `boundsToBBox` -> `onCameraIdle`) untouched. The two
iconUrls occupy separate entries in the plugin's per-URL icon cache — no
cross-tier contamination.

(c) **No shared-type sync.** `HighlightMarker` is local to scout-map-config.ts
(imported nowhere else — verified); `frontend/src/lib/types.ts` and
`backend/app/models.py` are untouched.

(d) **Gates (all from `frontend/`):**
1. `node scripts/render-course-flag.mjs` -> writes both PNGs; script self-asserts
   128×160. Eyeball: open both, confirm ink balloon + paper cutout + pennant
   color difference + baked shadow, transparent background.
2. `npm run lint`
3. `npx tsc --noEmit`
4. `npx vitest run src/lib/course/scout-map-config.test.ts` (or `npm test`) —
   updated expectations green.
5. `npm run build`
6. `npx tsx voice-tests/runner.ts --smoke`

(e) **Native render verification is device/simulator-only** (per the
google-maps-onmapready-crash + ios-simulator-map-testing memories — web build
cannot exercise GMSMarker icon scaling/anchoring). BLOCKING final gate:
designer screenshots the scout map in the iOS simulator at 2-3 zoom levels
(e.g. z10/z12/z14), checking (1) quiet-pin tips sit exactly on course points
across zooms (anchor proof — pan so a pin crosses screen center; it must not
slide), (2) highlight pin reads larger with the T.flag pennant, (3) tapping a
pin shows ONLY our bottom card — no white Google info box, (4) shadow grounds
the pin without reading as a smudge.

## §5 Sequencing
1. render-course-flag.mjs rewrite -> run -> commit both PNGs with it.
2. scout-map-config.ts (+ test) — constants, helper, highlightMarkerFor, no title.
3. CourseScoutMap.tsx — QUIET_PIN_ICON spread, no title, comments.
4. Gates (d), then simulator verification (e).
One commit on `integration/next`; owner-noticeable -> rides the approval bundle.
