# Persistent round map + colored tee marker

Owner (2026-07-06, screenshots): (A) "Loading map…" on every hole swipe — prevent it (preload); (B) a clean/modern colored tee marker on the actual tee box for the round's chosen tee.

## Root cause (recon-verified)
GoogleSatelliteMap.tsx is ALREADY a single persistent instance: native map created once in a []-deps effect (~359), camera moved on hole change by a [currentHoleData] effect (~587), every native call gated on mapReadyRef (SIGTRAP lesson). The bug is the PARENT: RoundPageClient.tsx renders the inline map inside `<AnimatePresence mode="wait"><motion.div key={currentHole} drag="x">` (~1305) — every hole change destroys + recreates the native map → isLoading=true → the "Loading map…" overlay (~863-878) on every swipe. The fullscreen blow-up map (~1935) sits OUTSIDE the AnimatePresence with no key and is already persistent — confirms the fix direction.

## Part A — persistent inline map

### A1. Stop the remount (the actual fix)
- Move the map branch (mappedCourse || roundAnchor) OUT of the keyed motion.div: render InlineHoleDiagram in a stable un-keyed container mounted once per round. Hole transitions = the existing camera pan.
- The paper-fallback branch KEEPS the keyed slide (cheap SVG; remount fine).
- Preserve the flick gesture verbatim (onTouchStart/onTouchEnd ~1354-1371 + onPointerDownCapture stop-propagation ~1347-1352) on the persistent container.
- Overlay chrome (hole-picker chip, stats, F/C/B tiles) stays sibling and re-reads currentHole in place; if a transition is wanted, keyed fade on the STATS TEXT only, never the map.
- No loader JSX change needed — killing the remount makes it first-init-only.

### A2. Camera queue — ready-gating + serialization for rapid swipes
The [currentHoleData] effect runs clearHoleOverlays → fitCameraToHole → addHoleOverlays as un-serialized async; rapid swipes race. Add a pure coalescing serializer in lib/map/google-map-helpers.ts:

```
createCameraQueue(run: (target: T) => Promise<void>) → { request(target: T): void }
```
- request() overwrites pendingTarget (coalesces skipped holes); one run in flight; on resolve, re-run with the newest pending if it changed; else idle. Rapid 1→4 settles with a single trailing camera move on 4.
- Keep the mapReadyRef gate inside run (belt+braces): not ready → no-op, re-request on ready.

### A3. Lifecycle
- Create once per round mount / destroy on unmount (existing shape — A1 stops the churn).
- Two instances max by design (inline + fullscreen while open — plugin binds one native map per element). Keep the inline map alive while fullscreen is open (destroying reintroduces a spinner on close). NOT 18 instances.
- Background/foreground: @capacitor/app appStateChange listener; on resume, if ready, re-request(currentHole) once (re-assert framing after GMSMapView pause); never destroy/recreate on background. iOS WebView cold-reload → natural remount, first-init loader correct.

### A4. Tile pre-warm — REJECTED
No off-screen prefetch API in @capacitor/google-maps; the only lever is the visible camera → visible jumps or broken tight framing, plus extra native churn on the exact path A2 serializes. Persistent instance + camera pan already streams tiles into the live view fast.

## Part B — colored tee marker

### B1. Data flow
- Pure helper `teeColorFor(teeName?: string)` in lib/map/google-map-helpers.ts → {slug, rgb}: black/blue/white/gold|yellow/red/green/silver|gray/combo|orange → canonical colors; unknown/absent → neutral (calm ink/graphite). Case/whitespace-insensitive.
- New `teeMarker` prop threaded: RoundPageClient derives from round.teeName → InlineHoleDiagram (new pass-through) + the fullscreen GoogleSatelliteMap. /map/course (no round) passes null → no marker there.

### B2. Rendering
- In the currently no-op addHoleOverlays(hd) (~334-338): if teeMarker && hd.tee → addMarker({coordinate: hd.tee, iconUrl, iconSize, iconAnchor centered, isFlat: true, zIndex}), id pushed into holeMarkerIdsRef so clearHoleOverlays removes it per hole. Inherits A2 serialization + ready-gating.
- **Bundled per-color PNGs** at public/assets/tee-marker-{black,blue,white,gold,red,green,neutral}.png — a small refined dot with a thin white ring (yardage-book calm, NOT a Google pin). Proven on-device path (identical to assets/tap-target.png). Generate the PNGs programmatically (e.g. a python3-stdlib script computing an anti-aliased circle per pixel + zlib PNG encode) — do not add an image dependency.
- Rejected: grayscale PNG + tintColor (tint-on-custom-iconUrl semantics unverified on iOS — this plugin has burned us); native default pin (gaudy); runtime canvas data-URI (unproven on iOS).

### B3. Edge cases
Anchor-only round (no hd.tee) → no marker, camera on center (unchanged). Legacy round without teeName → neutral marker on hd.tee (honest). Hole missing tee coord → skip marker, camera falls back per cameraForHole. 9-hole: fix the pre-existing hardcoded `currentHole < 18`/`> 1` fullscreen nav bounds (GoogleSatelliteMap.tsx ~709-710) → holeCoordinates.length. Memory: ≤2 native maps; one marker per hole, removed on change.

## Tests & gates
- Pure unit tests (extend lib/map/google-map-helpers.test.ts): createCameraQueue (single in-flight, coalescing 1..4 → trailing run on 4, ordering, not-ready no-op then flush); teeColorFor mapping + neutral fallback; existing camera framing tests stay green.
- Native behavior: iOS Simulator Debug ungated build per frontend/ios/SIMTEST.md + ios-simulator-map-testing memory — screenshots: hole 1 satellite + colored tee marker; swipe to hole 4 → NO "Loading map…", camera framed, marker moved; rapid-swipe 1→4 settles cleanly.
- Gates: tsc, lint, vitest, voice smoke, build; /code-review + /security-review (new user-facing capability per CLAUDE.md); designer review (marker aesthetics vs NORTHSTAR).

## Files
- frontend/src/app/round/[id]/RoundPageClient.tsx (un-key the map branch; thread teeName/teeMarker)
- frontend/src/components/GoogleSatelliteMap.tsx (camera queue, appStateChange, tee marker in addHoleOverlays, 9-hole nav bounds, teeMarker prop)
- frontend/src/components/course/InlineHoleDiagram.tsx (prop pass-through)
- frontend/src/lib/map/google-map-helpers.ts (+ .test.ts) (createCameraQueue, teeColorFor)
- public/assets/tee-marker-*.png (generated)
