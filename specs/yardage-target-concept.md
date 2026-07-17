# Draggable aim target on the yardage-book hole illustration — design concept

Status: CONCEPT ONLY — no code. Feeds an implementation plan + builder.
Owner ask (2026-07-17): the aim target must be draggable on BOTH the satellite
map and the on-paper yardage book. The map already has this (`GoogleSatelliteMap.tsx`
`placeTarget` seam, `tap-target.png` reticle). This concept adds the equivalent to
the book's SVG hole diagram (`HoleIllustration.tsx`, consumed by `HoleCard.tsx`).

Reviewed against: `frontend/src/components/yardage/tokens.ts`,
`frontend/src/components/yardage/HoleIllustration.tsx`,
`frontend/src/components/yardage/HoleCard.tsx`,
`frontend/src/components/GoogleSatelliteMap.tsx` (`placeTarget`, `tapTargetForPos`,
the tap-to-target pill at ~L1356-1391), `frontend/src/lib/map/google-map-helpers.ts`
(`tapTargetDistances`), `frontend/src/lib/hole-shot-point.ts`, NORTHSTAR.md.

## Ground truth that shapes every decision below

`HoleIllustration` is a **fully abstract, procedural schematic** — `HOLES[]` is a
canned array of normalized `[0,1]` path points, not georeferenced to the real
course. `hole.yards` is a single fixed total; there is no real lat/lng under this
SVG. The existing `shotPoint` dot (`shotPointForPath`) is already just "midpoint of
the last segment, nudged" — decorative, not measured. **Any live yardage the new
target shows is a geometric estimate (interpolated along the abstract path,
scaled to `hole.yards`), not a GPS distance.** This is the single biggest risk in
this concept and drives the rounding call in §3 and the red line in §5.

---

## 1. The reticle visual

A hand-drawn compass mark, not a map pin — same *idiom* as `tap-target.png`
(crosshair + ring) but redrawn in the book's ink, not the map's flat gray line art,
so the two read as siblings, not the same file file re-skinned.

- **Form:** a circle (ring) with four short crosshair ticks (N/E/S/W), plus a
  small solid center dot — geometrically identical structure to `tap-target.png`
  (ring + crosshair) so the *idiom* is instantly recognizable coming from the map.
- **Size (viewBox units, VB=100):** outer ring `r = 3.2`, ticks extend from
  `r = 3.6` to `r = 4.6` (short, not full crosshair arms — keeps it a mark, not a
  scope), center dot `r = 0.9`.
- **Stroke:** ring + ticks in `T.ink` (`#1a2a1a`) at `strokeWidth 0.5`, rounded
  caps — matches the pencil-line weight already used for the tee marker
  (`strokeWidth 0.4`) and fairway dashes. Fill: `none` on the ring, `T.ink` solid
  on the center dot with a `T.paper` 0.3-wide halo stroke around the dot (same
  trick `shotPoint`'s center dot already uses: `stroke="#f4f1ea" strokeWidth="0.3"`)
  so it reads on both fairway green and paper-rough backgrounds.
- **Accent, not ink, while active:** the moment it's grabbed (see §2) the ring
  and ticks switch from `T.ink` to `accent` (the hole's accent color, same prop
  `HoleIllustration` already takes) — this is the ONE color signal that says
  "this is live/selected," mirroring how the map's leg-2 line uses amber against
  the white leg-1 to distinguish "carry" from "what's left." At rest (not
  dragging) it's ink, quiet, just another pencil mark on the page.
- **No drop shadow, no gradient, no glow.** A flat two-tone ink mark, consistent
  with every other glyph on the illustration (tee dot, flag, hazards). A shadow
  or glow would read as a UI affordance lifted off the page — exactly the
  "SaaS map pin" drift NORTHSTAR warns against.
- **Echo vs. difference from the map reticle:** echo = ring + crosshair
  structure, white-on-dark halo trick, "not a pin." Difference = the book version
  is pure vector ink linework (no raster PNG, no flat gray `#stroke` line art) and
  it carries the hole's accent color when active — the map reticle is intentionally
  neutral/white because the map background varies (imagery); the book background
  is always paper, so ink/accent contrast is legible without needing a white base.

## 2. The drag gesture feel

- **Grab (drag-start):** scale the whole reticle group up ~1.15x (spring,
  `T.spring` — stiffness 380/damping 32, already the token used for snappy
  micro-interactions elsewhere) and switch ink → accent (§1). Fire
  `haptic('light')` once, same call the map already makes on drag-start
  (`GoogleSatelliteMap.tsx` ~L1027) — one shared haptic vocabulary across map and
  book.
- **During drag:** the reticle group's `transform` tracks the pointer 1:1 inside
  the SVG's local coordinate space (pointer position converted through the
  `viewBox`→client-rect ratio, same `scale()` helper already used for every other
  point in the file). No inertia, no lag — it must feel glued to the finger,
  per the brief.
  - **Aim line, yes but restrained:** draw ONE thin dashed line from the moving
    reticle to the green (mirrors the map's amber leg-2 "what's left" line) in
    `T.pencil` at low opacity (`0.35`), `strokeWidth 0.3`, `strokeDasharray
    "1 1.5"` — the same dash language the fairway centerline already uses
    (`strokeDasharray="1.5 1.8" opacity="0.3"`), just a different segment. **Do
    NOT** also draw the tee→target leg — that's the second line the map shows,
    and on a small book illustration two live dashed lines plus the fairway
    dashes plus the ribbon edge is visual noise the calm aesthetic can't afford
    (see the PM call in §4). One "what's left" thread, echoing the map's own
    hierarchy (leg-2 is the number golfers actually re-check while dragging).
- **Release (drag-end):** spring-settle to the drop point (`T.springSoft`, no
  hard snap-to-grid, no snap-to-fairway — this is an abstract schematic, there is
  nothing physically correct to snap to). Scale back to 1x, accent → ink, over
  ~200ms. The aim-line dash fades out (`opacity 0.35 → 0`) rather than vanishing,
  echoing the paper-noise/hairline fades already used for panel transitions.
- **Reduced motion:** honor `prefers-reduced-motion` — no scale spring, no
  fade tween; state changes (ink↔accent, line show/hide) become instant
  opacity/color swaps with no easing, position tracks the pointer as normal
  (position tracking during drag is functional, not decorative, so it stays).

## 3. The live yardage readout

- **Placement:** reuse the existing distance badge slot — top-right ink pill,
  mono, already at `HoleCard.tsx` ~L112-135 (`"### Y"`, `T.ink` background,
  `T.paper` text, `T.mono` font, 10px, tracking 1.2). Do not invent a second
  badge position; while dragging, this SAME pill becomes the live readout instead
  of the static "distance to hole" value it shows at rest.
- **What it shows:** while dragging, two lines like the map's paper pill
  (`GoogleSatelliteMap.tsx` ~L1372-1387) — but condensed into the ONE small
  top-right pill instead of the map's larger left-edge two-tier card, because the
  book pill is a corner accent, not a standalone panel:
  - Line 1, small mono label + number: `TEE ###Y` (from-tee distance to the
    dragged point).
  - Line 2, small mono label + number: `PIN ###Y` (dragged point to green),
    in `accent` color, echoing the map's ink/accent split between the two
    numbers (carry = ink, to-green = accent).
  - At rest (not dragging), collapse back to the single existing "###Y"
    (distance to hole) — don't permanently grow the pill into a two-line fixture;
    the two-line state is a drag-only affordance, matching "quiet, minimal
    chrome" — it only earns the extra pixels while it's actively useful.
- **Rounding — nearest 5, not nearest 1.** This is the direct consequence of the
  ground truth above: the number is interpolated from an abstract path, not
  measured. Presenting `247Y` implies GPS-grade precision the geometry can't
  back up; `245Y` (rounded to 5) reads as an estimate, matches how a golfer
  paces off a book yardage by eye, and is coherent with the hand-drawn,
  non-digital feel of the rest of the page. The satellite map is allowed nearest-1
  (`Math.round`) because it's measuring real lat/lng; the book is not the same
  kind of number and should not borrow the map's precision. **Recommend the
  builder round via `Math.round(y / 5) * 5` for both TEE and PIN lines here.**
- **Legibility in sunlight:** keep the existing pill contrast (dark ink fill,
  paper text, no translucency change) — already tuned for outdoor use elsewhere
  in this file; don't soften it for this feature.

## 4. PM/designer call: mirror the map, or stay simpler?

**Recommendation: stay simpler. One aim-line (target→green) only, no
tee→target leg, no snap-to-fairway, no bunker-carry chips.**

Why:
- The map's two-leg + chip system exists because the map is a real,
  georeferenced navigation surface at a much larger canvas (full-bleed satellite
  view) where a golfer is actively planning a shot with real hazards in frame.
  The book illustration is a **340px-at-most inset panel inside a card** — there
  is roughly a third of the pixel budget and none of the real-world grounding.
  Duplicating the map's full HUD at that scale would look cramped and busy, the
  opposite of NORTHSTAR's "calm > busy."
  - The book's whole reason to exist alongside a fully-featured map is to be the
    quieter, printed-page alternative — if it converges on the map's feature
    set it stops earning its own component and should just BE the map.
  - One dashed thread to the green is enough to answer the one question the
    yardage book always answers ("what's left from here") without turning the
    illustration into a second HUD.
- No snap-to-fairway: the fairway ribbon here is a hand-tapered decorative
  shape (`fairwayRibbon()`), not a real polygon with edges worth snapping to;
  snapping would be arbitrary and would fight natural drag with no functional
  payoff.

## 5. Red lines — what would break the aesthetic

- A red/colored Google-style map pin (teardrop) anywhere on the illustration —
  this is the exact "SaaS map, not a yardage book" drift NORTHSTAR calls out by
  name. The mark is a ring+crosshair ink glyph, always.
- Any bounce, wobble-loop, or continuous idle animation on the reticle at rest
  (the existing passive `shotPoint` pulse is fine because it's decorative and
  static-context; a live, user-controlled aim target bouncing while idle would
  read as a toy, not a tool).
- A drop shadow, glow, gradient fill, or glassmorphism treatment on the reticle
  or its pill — everything else on this SVG is flat ink/wash; one 3D-lit object
  would look pasted on.
- Rendering the live yardage at nearest-1 precision (`247Y`) — false precision
  the abstract geometry can't support (see §3).
- A second, permanently-visible dashed leg (tee→target) alongside the
  target→green leg at rest — clutters the small canvas; the map's two-leg
  treatment does not port down 1:1 (see §4).
- Growing the top-right badge into a large standalone card/panel that persists
  after drag ends — it must collapse back to the quiet single-line "###Y" pill
  the moment the finger lifts.
- Anything that requires importing a new icon/marker asset or component
  library — the reticle is pure inline SVG using `tokens.ts` colors, built the
  same way every other mark on this illustration already is.

## Buildable summary for the implementation plan

1. New optional prop on `HoleIllustration`: `target?: [number,0-1 y] | null`,
   `onTargetChange?: (pt: [number, number]) => void`, `dragging?: boolean` (or
   internal state) — mirrors the existing `shotPoint` prop shape so the two can
   coexist (target overrides/independent of the decorative `shotPoint`).
2. Ring+crosshair glyph per §1, ink at rest / accent while dragging, drawn as a
   `<g>` with pointer/touch handlers (`onPointerDown/Move/Up`), scale spring
   per §2, `touch-action: none` on the group during drag so the card's own
   swipe/expand gestures don't fight it (note `HoleCard`'s wrapping motion.div
   currently sets `touchAction: "pan-y"` on the outer card for hole-swipe — the
   reticle's own hit area needs `touch-action: none` locally, scoped to itself).
3. One dashed target→green line per §2, `T.pencil` at 0.35 opacity, fades in/out
   with drag state.
4. Top-right badge in `HoleCard.tsx` grows to two mono lines during drag
   (TEE/PIN, nearest-5 rounding) and collapses back at rest, per §3.
5. Hit target: draw an invisible enlarged hit circle (`r` in viewBox units sized
   so it maps to ≥44pt physical touch target at BOTH `size=190` collapsed and
   `size=340` expanded — the collapsed card is worth checking; if 44pt doesn't
   fit cleanly at 190px, gate dragging to the expanded state only, since that's
   already the size at which `showDetail`/interactive affordances turn on).
