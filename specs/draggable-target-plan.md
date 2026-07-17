# Draggable Aim Target — Map (verify) + Yardage Book (build)

Owner ask (2026-07-17): "Can you make the target draggable? The one on the yardage
book and map?" — grab the aim/target reticle and drag it on BOTH hole views, with
the yardage readout updating live.

Status of the two surfaces after code exploration:

| Surface | File(s) | Verdict |
|---|---|---|
| Satellite map | `frontend/src/components/GoogleSatelliteMap.tsx` | **Already built and solid** (v1.1.9 Item 4 + readiness finding #8). Verify only — no redesign. |
| Yardage book | `frontend/src/components/yardage/HoleIllustration.tsx` (+ `HoleCard.tsx`) | **New work.** Static SVG today; passive `shotPoint` dot, no drag. |

---

## 1. Satellite map — VERIFICATION CHECKLIST ONLY (no redesign)

The draggable target already exists end-to-end, and the architecture is deliberately
single-seam:

- `tapTargetForPos` (GoogleSatelliteMap.tsx ~line 133) is the ONE arg-building call
  site for the carry / to-green numbers, shared by `placeTarget` (tap + drag-END)
  and the live-drag tick — enforced by source-contract tests in
  `frontend/src/lib/map/google-map-helpers.test.ts` ("Item 4 — draggable aim
  reticle shares ONE seam").
- `placeTarget` (~line 567) runs on a strict FIFO mutex (`tapWriterRunnerRef`),
  redraws the white origin→point and amber point→green polylines, and places the
  reticle marker (`assets/tap-target.png`, 38×38, `draggable: true`).
- Drag listeners (~lines 1024–1047): drag-start sets `draggingRef` + one haptic;
  the live tick recomputes NUMBERS ONLY via `tapTargetForPos` (polylines are
  deliberately NOT redrawn per tick — perf); drag-end funnels through the same
  `placeTarget` as a tap.
- GPS origin: `resolveGpsOrigin` (~line 538) — live position when plausible
  (`isGpsPlausibleToGreen`, 5..800y), else tee; readout label flips
  "From you" / "From tee" (finding #8).
- `clearTapMarker` resets `draggingRef` if the marker is removed mid-drag (hole
  change under the finger) — the permanent-disable bug is already guarded.

**Verdict: already solid. Scope = verification, fix only real roughness found on
device.** Checklist:

1. **Touch-native drag on device.** The reticle is a native Capacitor Google Maps
   marker with `draggable: true` — drag is handled by the native iOS/Android SDK,
   so it is touch-native by construction. CONFIRM on device. Known native SDK
   behavior to evaluate (not a bug we introduced): native marker drag engages via
   **press-then-drag** and the marker lifts above the finger. If the engage delay
   feels rough to the owner, document it as a plugin/native limitation and tune
   nothing — do NOT rebuild this surface with a DOM overlay.
2. **Live readout mid-drag.** Drag the reticle around; the left-edge paper pill
   ("From you/From tee" carry + "To green") must tick continuously and match the
   settled numbers at release (same seam ⇒ must agree; confirm visually).
3. **Polylines settle on release.** Mid-drag the two leg lines intentionally stay
   at the old position and snap to the release point (documented perf choice).
   Verify it reads as intentional, not broken. Only if the owner flags it: an
   optional ~100ms-throttled leg-line redraw during drag is the fix — flag first,
   don't preemptively build.
4. **No regressions around the drag:** tee-shot overlays/chips unaffected during
   and after a drag; camera does not move during a drag; hole change mid-drag
   clears cleanly (drag again on the new hole works); "×" pill clears marker +
   lines + readout; GPS tick during a drag does not re-place the target
   (`draggingRef` guard).
5. **Run the existing suites** (offline): `google-map-helpers.test.ts`,
   `satellite-helpers.test.ts`, `tee-shot-overlays.test.ts` — all green, untouched.
   Do NOT refactor `placeTarget`/`tapTargetForPos`; the source-contract tests pin
   their shape on purpose.

No code changes are planned for this surface unless the on-device pass surfaces a
concrete defect.

---

## 2. Yardage book — NEW: draggable aim reticle on the SVG hole schematic

### 2.1 Where it lives today

- `HoleIllustration.tsx`: raw `<svg viewBox="0 0 100 100">` rendered at
  `size` px (190 collapsed / 340 expanded). Geometry is the ABSTRACT `HOLES`
  array — normalized [0,1] `path` polyline scaled ×100; `tee = path[0]`,
  `green = path[last]`. Only real scalars: `hole.yards`, `hole.par`. Renders a
  passive animated `shotPoint` dot (prop, currently fed by
  `shotPointForPath(hole.path)` from `RoundPageClient.tsx` line ~1349/2242).
- `HoleCard.tsx`: wraps the illustration in a `motion.div` with
  `onClick={expanded ? onZoom : onExpand}` — a tap on the picture expands/zooms.
- `RoundPageClient.tsx` (only HoleCard consumer, the mock/no-course branch):
  wraps HoleCard in a framer `drag="x"` hole-swipe surface with `draggedRef`
  suppression and `touchAction: "pan-y"`. So THREE gesture conflicts to isolate:
  card expand tap, horizontal hole swipe, vertical page scroll.

### 2.2 Geometry decisions (the crux)

**Scale — DECIDED: yards-per-unit from path ARC LENGTH, not straight-line.**
`hole.yards` on a scorecard is measured along the dogleg centerline, not
point-to-point; deriving the scale from the polyline's arc length is the honest
mapping and makes a straight par-3's tee→green euclidean distance equal `yards`
exactly.

```
arc      = Σ hypot(path[i+1] − path[i])          // normalized units
ypu      = hole.yards / arc                       // yards per normalized unit
toTarget = round( |P − tee|   × ypu )             // euclidean, origin → target
toGreen  = round( |P − green| × ypu )             // euclidean, target → green
```

**Free drag vs snap-to-centerline — DECIDED: FREE 2D drag** (clamped to the
diagram, §2.6). Rationale: (a) the map allows free placement — same gesture on
both surfaces is the coherence bar; (b) aiming at a fairway edge / short of a
bunker is the point of an aim target; (c) projection onto the smoothed path adds
math and a "magnet" feel that fights the finger. Not snapping means **on a dogleg,
toTarget + toGreen ≠ hole.yards** (euclidean legs cut the corner). That is
accepted and arguably honest — a target line across a dogleg IS shorter. Spell
this out in a code comment; do not force the legs to sum.

**Origin — DECIDED: tee, always.** The mock-round branch (HoleCard's only
consumer) has no live GPS wired into the card, and even if it did, the diagram is
NOT georeferenced — there is no defensible projection of a lat/lng onto the
abstract path. Label the readout "From tee" (map's exact fallback wording) —
never "From you" on this surface.

**Cross-surface coherence — the achievable bar (state this to the reviewer/
designer).** The book uses abstract demo `HOLES` geometry; the map uses real
`holeCoordinates`. The two surfaces CANNOT show byte-identical numbers for the
same physical point, and no one should judge against that. The bar is:
same-magnitude numbers (the arc-length scale guarantees totals match the card
yardage), same readout format (mono/serif paper badge, "From tee" / "To green"
labels, `Y` suffix idiom), same gesture (grab reticle, drag, live numbers,
settle on release), same reset (clear via ×, reset on hole change).

**Confabulation / false precision — DECIDED: round to nearest 5 yards on the
book** (`Math.round(v / 5) * 5`), vs nearest yard on the map. A 1-yard-precise
number off a hand-drawn schematic is a lie of precision; 5s read like a caddie's
"call it 215". **FLAG for the designer/PM pass:** if same-format-to-the-yard is
preferred for coherence, the rounding constant is one line in the helper. Also
flag whether a subtle "approx" cue (e.g. `~215`) is wanted — recommend NO tilde
(the 5s rounding already signals it; calmer).

### 2.3 New pure helper module (unit-testable offline)

`frontend/src/lib/yardage-book-target.ts` — mirror of the map's
`tapTargetDistances` pattern (pure, injected nothing, no DOM):

- `pathArcLength(path: PathPoint[]): number`
- `bookYardsPerUnit(yards: number, path: PathPoint[]): number`
- `bookTargetDistances(point: PathPoint, path: PathPoint[], yards: number):
  { toTarget: number; toGreen: number }` — applies the ×5 rounding; single
  arg-building seam for BOTH the live-drag tick and the settled state (the
  book-side analogue of the map's Item-4 contract).
- `clampToDiagram(p: PathPoint, inset = 0.04): PathPoint` — clamp to
  [inset, 1−inset]² so the reticle can never leave the paper.

Reuses `PathPoint` from `frontend/src/lib/hole-shot-point.ts`.

### 2.4 Component changes + state ownership

**DECIDED: state stays INSIDE HoleIllustration (minimal surface).**
`const [aim, setAim] = useState<PathPoint | null>(null)` — no lift to HoleCard,
no new required props on any caller, `shotPoint` prop contract untouched.
Rationale: no other component needs the aim point (the readout renders inside the
SVG, §2.5); lifting would force RoundPageClient plumbing for zero benefit.

- **Additive to `shotPoint`, which it visually supersedes:** seed the draggable
  reticle at `shotPoint` (when non-null, else the path midpoint) so there is
  ALWAYS something to grab — this sidesteps any tap-to-place vs expand-tap
  conflict (the map is tap-to-place; the book is grab-the-existing-reticle,
  which is literally the owner's ask). While the reticle exists, do NOT also
  render the old passive pulsing dot (two markers = noise). Effective aim =
  `aim ?? seedFromShotPoint` — the user's drag overrides the seed.
- **Reset on hole change:** `useEffect(() => setAim(null), [holeNumber])`.
  (The consumer also remounts the card per hole via a keyed AnimatePresence,
  but don't rely on that.)
- **HoleCard change is minimal:** none required for state. One optional
  designer-call prop if drag is gated to expanded only (see flag in §2.7).

### 2.5 Pointer-event handling spec (the builder's checklist)

- **Pointer Events, not mouse/touch pairs:** `onPointerDown` / `onPointerMove` /
  `onPointerUp` / `onPointerCancel` on an invisible hit `<circle>` in the SVG,
  with `e.currentTarget.setPointerCapture(e.pointerId)` on pointerdown (release
  on up/cancel). Capture keeps events flowing when the finger leaves the circle.
- **Screen→viewBox conversion:** canonical path is
  `svg.getScreenCTM()!.inverse()` applied to the pointer position (via
  `new DOMPoint(clientX, clientY).matrixTransform(inv)`), divided by 100 back to
  normalized units. (Because the viewBox is a uniform square and width===height,
  bounding-rect math `(clientX − rect.left) / rect.width` is exactly equivalent —
  acceptable fallback; pick ONE and comment why.) Keep an `svgRef` on the root.
  Reticle position updates every move ⇒ stays under the finger.
- **Hit target ≥44pt at the SMALLEST render:** drawn reticle is small
  (~r 3.5 viewBox units) but the invisible hit circle is **r = 12 viewBox
  units** (`fill="transparent"`, no stroke) — at the 190px collapsed card that is
  ~45.6px diameter; at 340px it's larger still. Hit circle sits last in the SVG
  (top of z-order).
- **Scroll/gesture isolation:** `style={{ touchAction: "none" }}` on the hit
  circle ONLY (rest of the SVG keeps default so page pan-y still works). On
  pointerdown: `e.stopPropagation()` — this keeps the framer `drag="x"`
  hole-swipe wrapper AND framer's tap detection from ever seeing the gesture
  (same pattern the round map wrapper already uses at RoundPageClient ~line
  1983).
- **Drag-vs-tap threshold + onClick conflict:** track `movedRef` (true once
  cumulative movement > ~0.06 normalized units ≈ 6px @ 100px/unit-scale…
  concretely: >6 CSS px from pointerdown). On the hit circle's `onClick`:
  ALWAYS `e.stopPropagation()` (whether moved or not) — a tap ON the reticle
  should do nothing, never expand/zoom the card (calm; the rest of the card
  remains the expand surface). This fully protects HoleCard's
  `onClick={expanded ? onZoom : onExpand}`.
- **During drag:** `setAim(clampToDiagram(pt))` per move; compute the readout via
  `bookTargetDistances` from the SAME state (one seam — no separate live-tick
  math, learning from the map's Item 4). SVG re-render at pointer-move frequency
  on a 100-unit scene is cheap; no rAF throttling needed unless profiling says
  otherwise. Optional single `haptic('light')` on drag start (import from the
  existing haptics util the map uses) — matches the map's feel.

### 2.6 Visual spec (designer-blocking pass finalizes)

`specs/yardage-target-concept.md` does not exist yet (checked 2026-07-17); a
designer concept is being produced in parallel — **adopt it when it lands; the
following is the working default**, all from `tokens.ts` (no new colors, no
component library):

- **Reticle:** on-paper analogue of the map's white tap-target — a ring
  (r≈3.2, `stroke: accent`, strokeWidth 0.6, `fill: none`) with four short
  crosshair ticks and a center dot, over a paper halo (`stroke: T.paper`,
  slightly wider, underneath) so it reads on fairway green ink. No continuous
  pulse animation (calmer than the old dot; also reduced-motion-safe by
  default).
- **Leg lines (live during drag — SVG is cheap, unlike the native map):**
  tee→target thin dashed ink (`#1a2a1a`, opacity ~0.45, same 1.5/1.8 dash idiom
  as the centerline), target→green dashed `accent`. These are the book's white +
  amber legs translated to pencil.
- **Readout:** shown when `showDetail` (expanded) is true, and while actively
  dragging in the collapsed card. Small paper badge INSIDE the SVG (top-left —
  top-right of the card is occupied by HoleCard's `{distance}Y` pill): two mono
  lines in the map pill's idiom — `FROM TEE` label + serif number, hairline,
  `TO GREEN` label + accent serif number — plus a tiny `×` that clears the aim
  (sets `aim` null ⇒ reticle returns to the seed; mirrors the map pill's ×).
  **FLAG to designer:** always-on vs expanded-only readout, and the ×5 rounding
  (§2.2).

### 2.7 Edge cases

- **Par-3 two-point paths:** seed uses `shotPointForPath`'s existing null-guard;
  all helper math is length-agnostic (arc of one segment). Add a unit test.
- **Doglegs:** legs don't sum to `yards` — accepted, commented (§2.2), unit test
  asserts straight holes DO sum (within rounding).
- **Dragged past green / behind tee:** allowed (map allows it; aiming a layup
  behind your position is meaningless but harmless — toGreen/toTarget just
  grow). Only clamp = `clampToDiagram` to the paper bounds, so the marker can
  never go off-canvas.
- **Rapid drags / multi-touch:** pointer capture binds one pointerId; ignore
  pointerdown while a capture is active. Last move wins; all math synchronous —
  no async races (unlike the map, no mutex needed).
- **Hole change mid-drag:** effect resets `aim`; pointercancel handler clears
  the dragging flag.
- **Reduced motion:** new reticle/readout are static (no SMIL, no loops). The
  pre-existing `shotPoint` pulse is hidden while the reticle exists — a net
  reduction in motion.
- **Drag in collapsed (190px) card:** enabled — threshold + stopPropagation
  isolate it. **FLAG to designer:** if the small card feels fiddly on device,
  the one-line fallback is enabling the hit circle only when `showDetail`
  (expanded); do not pre-build a prop for this.

### 2.8 Shared-types check

**Frontend-only. Confirmed.** No round/course/API shape changes; nothing touches
`frontend/src/lib/types.ts` or `backend/app/models.py`. No new dependencies.

---

## 3. Files to touch

| File | Change |
|---|---|
| `frontend/src/lib/yardage-book-target.ts` | NEW — pure geometry helpers (arc length, yards-per-unit, distances w/ rounding, clamp) |
| `frontend/src/lib/yardage-book-target.test.ts` | NEW — unit tests (vitest) |
| `frontend/src/components/yardage/HoleIllustration.tsx` | Add aim state, hit circle + pointer handlers, reticle + leg lines + readout SVG; hide passive dot while reticle active |
| `frontend/src/components/yardage/HoleCard.tsx` | Likely NO change (state internal, readout in-SVG); touch only if designer gates drag to expanded |
| `frontend/src/components/GoogleSatelliteMap.tsx` | NO planned change — verification checklist §1 only |

Reference (read, don't edit): `frontend/src/lib/map/google-map-helpers.ts`
(`tapTargetDistances`, `TapTarget`), `frontend/src/lib/hole-shot-point.ts`,
`frontend/src/components/yardage/tokens.ts`, `frontend/src/app/round/[id]/RoundPageClient.tsx`.

## 4. Implementation order

1. `yardage-book-target.ts` + tests (pure math first; green offline).
2. HoleIllustration: reticle + pointer plumbing + live legs/readout, seeded from
   `shotPoint`; hole-change reset; conflict isolation (§2.5).
3. On-device pass: collapsed + expanded drag, hole swipe still works, page still
   scrolls, expand tap still works, map surface checklist §1.
4. Designer-blocking review (reticle form, readout placement, rounding call) —
   adopt `specs/yardage-target-concept.md` if it has landed.

## 5. Gates (exact)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npx vitest run src/lib/yardage-book-target.test.ts \
  src/lib/hole-shot-point.test.ts \
  src/lib/map/google-map-helpers.test.ts \
  src/lib/map/satellite-helpers.test.ts \
  src/lib/map/tee-shot-overlays.test.ts
```

New tests to write in `yardage-book-target.test.ts`:
- straight hole: `toTarget + toGreen === yards` (± rounding) anywhere ON the line;
  point at green ⇒ toGreen = 0; point at tee ⇒ toTarget = 0.
- dogleg (use real `HOLES[1]`): each leg < yards; legs sum ≥ straight tee→green
  distance × ypu; sum ≤ yards (triangle inequality vs arc).
- par-3 (2-point path) sanity; clamp keeps points in [inset, 1−inset]; rounding
  lands on multiples of 5.

## 6. NORTHSTAR conformance

Calm and on-paper: one grabbable reticle (no new chrome until you touch it),
pencil-dash leg lines, tokens.ts palette only, no library, no pulse animation,
voice remains primary (drag is the tactile fallback the owner asked for). The
designer agent reviews the reticle/readout before ship and is BLOCKING.
