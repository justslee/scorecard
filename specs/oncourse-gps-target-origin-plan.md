# On-course GPS target origin — leg-1 anchors to the golfer (readiness finding #8)

## Problem
On the satellite hole map, the target reticle's WHITE line (leg 1) and its carry
number always anchor at the TEE, even when the golfer is standing mid-fairway with
a good GPS fix. A rangefinder-honest map should draw leg 1 + the carry number FROM
WHERE THE GOLFER STANDS when a plausible on-hole GPS position exists. The amber
TO-GREEN leg (leg 2) is correct and stays unchanged.

The plumbing already exists: `tapTargetDistances(tap, green, origin, fromGps, distFn)`
and `interface TapTarget { carry, toGreen, fromGps }` already take a GPS origin + a
`fromGps` flag, and the pill already renders `tapTarget.fromGps ? "Carry" : "From tee"`.
It is simply never fed GPS. This is a wiring fix on existing plumbing, not a new
subsystem.

## Ground truth (verified in this worktree)
- `frontend/src/components/GoogleSatelliteMap.tsx`
  - `tapTargetForPos(pos, hd)` (line ~126) hard-codes `hd.tee ?? null` as origin and
    `false` for `fromGps`. **This is the gap.**
  - `placeTarget(pos)` (line ~477) is THE shared seam for tap + drag-end. Line ~481
    calls `setTapTarget(tapTargetForPos(pos, hd))`. Leg-1 (white) at ~490-498 hard-codes
    `hd.tee`. Leg-2 (amber) at ~499-507 is correct — leave it. Tap-line/reticle id space
    (`tapLineIdsRef` / `tapMarkerIdRef`) is written ONLY by `placeTarget` / `clearTapMarker`
    (single writer) — keep it that way.
  - Tap handler ~909-912; drag-start ~917; drag-tick ~926-931 (calls `tapTargetForPos`);
    drag-end ~935-938 (calls `placeTarget`).
  - `handlePositionUpdate(pos)` ~987 sets `positionRef.current = pos`; hole-overlay
    redraws route through `cameraQueueRef.current.request({hd, reason:'gps', pos})`.
    `positionRef` is `Position | null` and `Position` is `{ lat, lng, accuracy?, ... }`
    (`frontend/src/lib/gps.ts` line 20) — lat/lng live directly on it, no unwrapping.
  - Pill render ~1231-1263: label `{tapTarget.fromGps ? "Carry" : "From tee"}`.
- `frontend/src/lib/map/google-map-helpers.ts` — `tapTargetDistances` (~313) and
  `TapTarget` (~297) already support origin + fromGps. `movedBeyondYards(from,to,yds)`
  (~138) is the reusable movement throttle.
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — the plausibility gate to REUSE,
  `posOnHole` (~1193-1199): `const d = yardsDistance(playerPos, green); return d >= 5 && d <= 800;`
  (currently INLINE).
- **Distance-basis check (done):** `yardsDistance` (`hole-projection.ts` ~382) is
  `Math.round(turf.distance(a,b,{meters}) * 1.09361)`. `calculateDistance(a,b).yards`
  (`gps.ts` ~70) is the SAME: `Math.round(turf.distance(...meters) * 1.09361)`. Identical
  basis — the shared helper cannot change `posOnHole`'s number, and injecting the distance
  fn makes that provable.
- **Type-crossing check (done):** `TapTarget` is map-local. No `TapTarget` / `fromGps` /
  `toGreen` in `backend/app/models.py`. No `frontend/src/lib/types.ts` ↔ `models.py` sync
  needed.

## Design

### 1. Shared plausibility helper (ONE seam, no fork)
Add a pure helper. **Home: `frontend/src/lib/course/course-coordinates.ts`** — it already
`import`s `yardsDistance` from `./hole-projection` and is already imported by
RoundPageClient right next to `posOnHole` (via `computeFCBDistances`), so the byte-identical
caller gains zero new coupling. (`satellite-helpers.ts`, home of the sibling `isGpsOnHole`,
is an acceptable alternative, but it would add a fresh import to the must-not-change caller.)

```ts
/**
 * Is a live GPS fix a plausible ON-HOLE origin for a shot to this green?
 * Plausible = 5..800 yards to the green (too close = on/at the green; too far =
 * home testing / wrong hole). distanceYards is injected so callers reuse their own
 * (identical-basis) turf distance fn; defaults to yardsDistance so posOnHole stays
 * byte-identical.
 */
export function isGpsPlausibleToGreen(
  pos: { lat: number; lng: number },
  green: { lat: number; lng: number },
  distanceYards: (a: {lat:number;lng:number}, b: {lat:number;lng:number}) => number = yardsDistance,
): boolean {
  const d = distanceYards(pos, green);
  return d >= 5 && d <= 800;
}
```

Refactor `posOnHole` to call it with ZERO behavior change — default fn = `yardsDistance`,
so it is literally the same computation:
```ts
const posOnHole =
  playerPos && holeCoordsForTiles?.green
    ? isGpsPlausibleToGreen(playerPos, holeCoordsForTiles.green)
    : false;
```
Reviewer check: `d = yardsDistance(pos, green); d >= 5 && d <= 800` is preserved exactly.

Note this gate is DELIBERATELY not `isGpsOnHole` (the ~660m BBOX gate in
`satellite-helpers.ts`). That one gates the "you" dot / camera; the target origin uses the
same 5/800-to-green rule as the yardage card so the map and card never disagree.

### 2. Origin-selection seam in the map (extend the SHARED seam, not the callers)
Resolve the plausible GPS origin ONCE, inside the shared seam. Add a tiny private resolver
in `GoogleSatelliteMap.tsx` that reads the refs both `placeTarget` and `tapTargetForPos`
already have access to:

```ts
// null unless a plausible on-hole GPS fix exists for the current hole.
function resolveGpsOrigin(hd: CourseCoordinates): { lat: number; lng: number } | null {
  const p = positionRef.current;
  if (!p || !hd.green) return null;
  return isGpsPlausibleToGreen(
    { lat: p.lat, lng: p.lng },
    hd.green,
    (a, b) => calculateDistance(a, b).yards,   // map's own fn; identical basis
  ) ? { lat: p.lat, lng: p.lng } : null;
}
```

Thread a resolved `gpsOrigin` into `tapTargetForPos` so it stops hard-coding tee:
```ts
function tapTargetForPos(
  pos: { lat: number; lng: number },
  hd: CourseCoordinates,
  gpsOrigin: { lat: number; lng: number } | null,
): TapTarget {
  const origin = gpsOrigin ?? hd.tee ?? null;
  return tapTargetDistances(pos, hd.green, origin, gpsOrigin != null,
    (a, b) => calculateDistance(a, b).yards);
}
```
Update the THREE existing callers to pass the resolved origin (the callers stay one-liners —
the logic lives in the seam/resolver, not duplicated in each caller):
- `placeTarget` (~481): `const gpsOrigin = resolveGpsOrigin(hd); setTapTarget(tapTargetForPos(pos, hd, gpsOrigin));`
- drag-tick (~930): `setTapTarget(tapTargetForPos({lat,lng}, hd, resolveGpsOrigin(hd)));`
  (drag also becomes you-anchored — matches requirement #2).

In `placeTarget`, leg-1 uses the SAME resolved origin instead of `hd.tee`:
```ts
const leg1Origin = gpsOrigin ?? hd.tee ?? null;   // reuse the value already resolved above
if (leg1Origin) {
  // white polyline path: [leg1Origin, pos]   (was [tee, pos])
}
```
Leg-2 (amber, `[pos, hd.green]`) is untouched. `fromGps = gpsOrigin != null` flows into the
pill so it switches "From tee" -> "Carry" automatically.

`resolveGpsOrigin` is called once per `placeTarget` and once per drag-tick; put the
`gpsOrigin` const at the top of `placeTarget` and reuse it for both `setTapTarget` and leg-1
(single resolve, no drift between the number and the line).

### 3. Live update after placement (requirement #3)
When the golfer walks after placing a target, leg-1 + the carry number must follow. Add:
- `tapTargetPosRef = useRef<{lat:number;lng:number} | null>(null)` — set to `pos` at the end
  of `placeTarget`, cleared in `clearTapMarker` (and where `setTapTarget(null)` happens on
  hole-change).
- `draggingRef = useRef(false)` — set `true` in the drag-START listener (~917), `false` in
  drag-END (~937). (Guards against re-placing under the user's finger.)

In `handlePositionUpdate`, AFTER `positionRef.current = pos` and the existing on-hole/camera
work, add a single re-place block:
```ts
const placed = tapTargetPosRef.current;
if (placed && hd && !centerOnly && !draggingRef.current) {
  // re-run when GPS moved meaningfully OR plausibility flipped since the last placement.
  const moved = movedBeyondYards(lastOriginRef.current, pos, /*threshold*/ 20);
  const plausibleNow = resolveGpsOrigin(hd) != null;
  const flipped = plausibleNow !== lastPlausibleRef.current;
  if (moved || flipped) {
    lastPlausibleRef.current = plausibleNow;
    await placeTarget(placed);   // re-runs the SINGLE writer; reticle stays at `placed`
  }
}
```
- `lastOriginRef` / `lastPlausibleRef` are refs updated inside `placeTarget` (so a manual tap
  also resets the throttle baseline). Reuse `movedBeyondYards` — do NOT invent a new
  threshold; 20 yd matches the camera-follow throttle already in this function.
- **Single-writer preserved:** re-place calls `placeTarget`, the ONLY writer of
  `tapLineIdsRef`/`tapMarkerIdRef`. Do NOT route this through `cameraQueueRef` and do NOT add
  a second writer to that id space.
- **Redraw choice — recommend the simple full `placeTarget` redraw.** A leg-1-only redraw
  would fork the seam (a second code path writing `tapLineIdsRef`), which is exactly what the
  Item-4 field-test fix forbids. GPS ticks are throttled to >=20 yd of movement, so the
  reticle-remove/re-add flicker is at most once per ~20 yd walked — acceptable and calm.
  The reticle POSITION does not move on a GPS tick (it stays at `placed`); only the white
  leg-1 line, the carry number, and the pill label change.
- **Re-entrancy / race:** a GPS-tick `placeTarget` could interleave with a tap/drag-end
  `placeTarget` (both `await` plugin add/remove). Guard with an `inPlaceRef` boolean: set
  true at the top of `placeTarget`, false in a `finally`; the GPS-tick re-place is SKIPPED
  when `inPlaceRef.current` is already true (a fresh tap/drag will render the latest origin
  anyway). This keeps a strict single in-flight `placeTarget`. `draggingRef` already excludes
  the mid-drag case.

### 4. Label copy (designer-BLOCKING — wire it, don't decide it)
Today: `fromGps ? "Carry" : "From tee"`. The brief wants the on-you case to read
rangefinder-honest ("FROM YOU" / "Carry" / calmer). This is a copy decision owned by the
`designer` agent per NORTHSTAR (quiet, yardage-book). **Do NOT hard-code a new word here** —
wire `fromGps` correctly (done above) so the pill switches, and leave a
`// designer: on-GPS label copy` marker at the pill. Ship with the existing "Carry" until the
designer confirms.

## Edge cases (all fall out of `gpsOrigin ?? hd.tee ?? null`)
- No tee AND no GPS -> `origin = null` -> leg-1 skipped, `carry = null`, pill shows "—".
  (Identical to today.)
- GPS present but implausible (>800y or <5y to green) -> `resolveGpsOrigin` returns null ->
  tee-anchored, `fromGps=false` -> BYTE-IDENTICAL to today.
- Plausible -> implausible while a target is placed -> next qualifying GPS tick sets
  `plausibleNow=false`, `flipped=true`, re-places tee-anchored. Reverts cleanly.
- Drag in progress when a GPS tick fires -> `draggingRef.current` true -> re-place skipped;
  drag-end's `placeTarget` renders the final origin.

## Files to touch
- `frontend/src/lib/course/course-coordinates.ts` — add `isGpsPlausibleToGreen` (pure).
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — refactor `posOnHole` to call it
  (default distance fn -> byte-identical).
- `frontend/src/components/GoogleSatelliteMap.tsx` — `resolveGpsOrigin`; extend
  `tapTargetForPos` (3rd arg) + its 2 callers; leg-1 origin in `placeTarget`;
  `tapTargetPosRef` / `draggingRef` / `inPlaceRef` / `lastOriginRef` / `lastPlausibleRef`;
  live re-place block in `handlePositionUpdate`; drag-start/end ref toggles; designer copy
  marker at the pill.
- `frontend/src/lib/course/course-coordinates.test.ts` (or `.../map/google-map-helpers.test.ts`)
  — see tests below.

No shared-type / backend / migration changes (`TapTarget` is map-local — verified).

## Sequencing
1. Add `isGpsPlausibleToGreen` + unit tests (pure, no UI risk).
2. Refactor `posOnHole` to call it; run gates — prove the card is unchanged.
3. Extend `tapTargetForPos` + `resolveGpsOrigin` + leg-1 origin (tap/drag place from you).
4. Add the live re-place block + refs/guards (requirement #3).
5. Run gates; flag the label copy to the designer.

## Verification gates
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`
- New unit tests (pure seam; `placeTarget` stays covered by the existing structural/grep
  assertions in `google-map-helpers.test.ts` ~913, since it's component-bound):
  - `isGpsPlausibleToGreen`: true at 5 and 800 (inclusive boundaries), false at 4 and 801,
    false when far (home testing).
  - `tapTargetDistances` with a GPS origin: `origin = gps`, `fromGps = true`, `carry` measured
    from gps->tap.
  - `tapTargetDistances` with `gpsOrigin = null` -> tee path: `origin = tee`, `fromGps = false`,
    carry from tee->tap — asserts the no/implausible-GPS path is byte-identical.
  - Optional structural assertion: `tapTargetForPos` is the only site building the
    `tapTargetDistances(pos, green, origin, fromGps, fn)` arg pattern (guards the no-fork
    contract, matching the existing Item-4 gate).

## Consistency with NORTHSTAR
Rangefinder-honest (leg-1 + carry from where you actually stand), quiet (throttled redraw, no
new chrome, no notification), reuses existing plumbing (`tapTargetDistances`/`TapTarget`, the
single `placeTarget` writer, `movedBeyondYards`) rather than adding a subsystem. The one
user-facing copy nuance is deferred to the `designer` agent.

## Biggest risk
The live re-place path is the only new moving part: an unguarded GPS-tick `placeTarget`
racing a tap/drag `placeTarget` on the shared `tapLineIdsRef`/`tapMarkerIdRef` id space could
orphan a polyline/marker (the exact class of bug the v1.1.9 single-writer fix closed).
Mitigation is strict and cheap: single writer (`placeTarget` only), `inPlaceRef` in-flight
guard with `finally`, `draggingRef` mid-drag exclusion, and the `movedBeyondYards` throttle so
re-places are rare. Everything else is arithmetic through already-tested pure helpers.
