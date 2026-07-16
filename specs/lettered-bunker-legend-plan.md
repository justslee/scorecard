# Implementation Plan — Lettered Bunker Badges + Keyed Carry Legend

**Owner ask:** each marked fairway bunker on the in-round satellite map gets a LETTER badge
(A, B, C…); the carry legend chips reference that letter (`(A) 210 / 220`) instead of the
ambiguous "CARRY 210/220" / "R CARRY 220/265" with no chip↔bunker link. The letter is the
shared key. **NOTICEABLE** change.

**Scope:** in-round satellite map only. Frontend-only; **no backend change (backend ruff N/A).**
**Out of scope (DEFERRED to a separate follow-up):** the yardage-plate zoom-balloon issue.
The builder must NOT touch plate rendering (the `circles` block in `addTeeShotOverlays`,
`PLATE_FILL_BY_YARDS`, `distanceMarkersFromGreen`, or anything plate-related).

## Why per-letter bundled PNGs (constraint — do not "optimize" away)
The Capacitor Google Maps plugin cannot load data-URL/canvas marker icons on iOS (documented
in `GoogleSatelliteMap.tsx` `addTeeShotOverlays` docstring ~L497-501). The letter must be baked
into pre-generated bundled PNGs (`frontend/public/assets/bunker-marker-{a..f}.png`), exactly
like `tee-marker-{slug}.png`. Runtime letter rendering is NOT an option on iOS.

## Step 1 — Letter assignment (source of truth): `frontend/src/lib/map/tee-shot-overlays.ts`
**1a. `BunkerCarry` interface (L51-60)** — add:
```ts
  /** Legend key: 'A' for the smallest front carry, then 'B', 'C'… in the
   *  final ascending-front display order. '' when index exceeds the bundled
   *  asset range A-F (unreachable today: BUNKER_CAP = 4) — renders as the
   *  plain bean marker and a coin-less chip. */
  letter: string;
```
**1b. Assignment in `fairwayBunkerCarries` (L640-644)** — AFTER the final
`capped.sort((a, b) => a.front - b.front)`, keyed by index in the final `.map`:
```ts
  return capped.map(({ front, back, side, nearEdge }, i) => ({
    front,
    back,
    side,
    nearEdge,
    letter: i < 6 ? String.fromCharCode(65 + i) : '', // A-F bundled; '' = graceful fallback
  }));
```
Determinism: `Array.prototype.sort` is stable (ES2019+), letters are pure position → same
geometry in ⇒ same letters out. `maxBunkers = inline ? 2 : 4`, `BUNKER_CAP = 4` → today max A–D;
assets cover A–F for headroom. `i < 6` clamp guards a future cap raise (index ≥ 6 ⇒ `''`).
No other change to this module. Existing test 6 (`chordOnly[0] toEqual withPath[0]`) still passes
(both carry `letter: 'A'`).

## Step 2 — Asset generator: `frontend/scripts/generate-bunker-marker.py`
Keep `coverage`, `over`, `_chunk`, `write_png`, `signed_dist`, all bean constants byte-identical.
**2a. `render()` → `render(letter: str | None)`** (idiom of `generate-tee-markers.py`'s
`render(fill_rgb)`):
- `render(None)` → CURRENT bean exactly as today, **including the three stipple dots** →
  regenerates `bunker-marker.png` unchanged (kept as the `letter: ''` fallback).
- `render('A')..render('F')` → bean WITHOUT stipples (skip the stipple loop when
  `letter is not None`) + the coin + the reversed-out letter.

**2b. Coin (stamped on the C2 lobe top).** New constants:
```python
COIN_C = (74.0, 24.0)   # overlaps the C2 lobe (58,46,r15) top
COIN_R_FILL = 15.0
COIN_RIM = 4.0          # == the bean outline's coverage(sd, 4.0)
PAPER = (0xF4, 0xF1, 0xEA)  # T.paper
```
`sd_coin = hypot(px-74.0, py-24.0) - COIN_R_FILL`. Composite ABOVE the sand fill (replacing the
stipple layer for lettered variants): one solid-ink layer `over(INK, coverage(sd_coin, COIN_RIM), …)`
— a filled ink disc of effective outer radius 15+4=19, same feathered edge as the bean outline.
Extent x∈[55,93], y∈[5,43] — inside the 96px canvas; overlaps the C2 lobe top (stamped-on).
Optional cohesion detail (skip if designer objects): extend the halo to the union for lettered
variants — `halo_cov = coverage(min(sd, sd_coin), 8.0, feather=2.5)`.

**2c. Procedural stroke-font A–F.** Normalized box x∈[0,1] L→R, y∈[0,1] top→baseline (y down).
Map to canvas with `GW = 8.5`, `GH = 11.0`, centered on the coin:
```python
def to_canvas(nx, ny):
    return (COIN_C[0] + (nx - 0.5) * GW, COIN_C[1] + (ny - 0.5) * GH)
```
```python
LETTER_SEGMENTS = {
    "A": [((0.0,1.0),(0.5,0.0)), ((0.5,0.0),(1.0,1.0)), ((0.19,0.62),(0.81,0.62))],
    "B": [((0.0,0.0),(0.0,1.0)),
          ((0.0,0.0),(0.60,0.0)), ((0.60,0.0),(0.92,0.14)), ((0.92,0.14),(0.92,0.34)),
          ((0.92,0.34),(0.60,0.48)), ((0.60,0.48),(0.0,0.48)),
          ((0.0,0.48),(0.65,0.48)), ((0.65,0.48),(1.0,0.62)), ((1.0,0.62),(1.0,0.86)),
          ((1.0,0.86),(0.65,1.0)), ((0.65,1.0),(0.0,1.0))],
    "C": [((0.92,0.06),(0.38,0.0)), ((0.38,0.0),(0.0,0.32)), ((0.0,0.32),(0.0,0.68)),
          ((0.0,0.68),(0.38,1.0)), ((0.38,1.0),(0.92,0.94))],
    "D": [((0.0,0.0),(0.0,1.0)),
          ((0.0,0.0),(0.55,0.0)), ((0.55,0.0),(1.0,0.33)), ((1.0,0.33),(1.0,0.67)),
          ((1.0,0.67),(0.55,1.0)), ((0.55,1.0),(0.0,1.0))],
    "E": [((0.0,0.0),(0.0,1.0)), ((0.0,0.0),(0.95,0.0)), ((0.0,0.5),(0.78,0.5)), ((0.0,1.0),(0.95,1.0))],
    "F": [((0.0,0.0),(0.0,1.0)), ((0.0,0.0),(0.95,0.0)), ((0.0,0.5),(0.78,0.5))],
}
```
Rasterize: `dist_to_segment(px,py,a,b)` (project, clamp t∈[0,1], Euclidean); letter coverage per
pixel = **max** over segments of `coverage(d, STROKE_R)`, `STROKE_R = 1.5` (3px stroke), default
FEATHER. `max` (not sum) so chained joints don't double-darken. Composite `over(PAPER, letter_cov, …)`
as the topmost layer.

**2d. `main()`** — deterministic/idempotent:
```python
render(None) -> bunker-marker.png            # byte-identical to today
for ch in "abcdef": render(ch.upper()) -> bunker-marker-{ch}.png
```
Update the module docstring (now 7 PNGs; letters keyed to `BunkerCarry.letter`).

## Step 3 — Icon URL helper: `frontend/src/lib/map/google-map-helpers.ts` (L468-471)
```ts
export function bunkerMarkerIconUrl(letter: string): string {
  const l = letter.trim().toLowerCase();
  return /^[a-f]$/.test(l) ? `assets/bunker-marker-${l}.png` : 'assets/bunker-marker.png';
}
```
Fallback: `''`, `'G'`, multi-char, whitespace → `assets/bunker-marker.png` (KEPT committed as the
live fallback; regenerated unchanged by Step 2d).

## Step 4 — Map markers: `frontend/src/components/GoogleSatelliteMap.tsx` (L520-527)
```ts
const markers: Marker[] = data.bunkers.map((bunker) => ({
  coordinate: bunker.nearEdge,
  iconUrl: bunkerMarkerIconUrl(bunker.letter),
  iconSize: { width: 26, height: 26 },   // 22 → 26: room for the coin badge
  iconAnchor: { x: 13, y: 13 },
  isFlat: true,
  zIndex: 4,
}));
```
Update the `addTeeShotOverlays` docstring bunker sentence. Do NOT touch the `circles` (plates) block.

## Step 5 — Legend chip rewrite: `frontend/src/components/GoogleSatelliteMap.tsx` (L1177-1204)
ONE row: `[18px ink coin with the letter] [serif numbers]`. **No "·" separator** (the coin IS the key;
a dot is extra chrome — NORTHSTAR quiet). 8px gap.
```tsx
{teeShotChips.bunkers.map((b, i) => (
  <div
    key={b.letter || i}
    style={{
      background: T.paper, border: `1px solid ${T.hairline}`, borderRadius: 10,
      padding: "6px 10px", boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
      display: "flex", alignItems: "center", gap: 8, minWidth: 64,
    }}
  >
    {b.letter !== "" && (
      <span style={{
        width: 18, height: 18, borderRadius: 9, background: T.ink, color: T.paper,
        fontFamily: T.sans, fontSize: 11, fontWeight: 700, lineHeight: "18px",
        textAlign: "center", flexShrink: 0,
      }}>
        {b.letter}
      </span>
    )}
    <span style={{ fontFamily: T.serif, fontSize: 18, lineHeight: 1.15, color: T.ink }}>
      {b.front === b.back ? `${b.front}` : `${b.front} / ${b.back}`}
    </span>
  </div>
))}
```
Use `T.sans` (Geist grotesk) weight 700 for the coin — NOT `T.mono` (Geist Mono). Dropped: the
bean `<svg>` swatch, the `Carry / L Carry / R Carry` mono caption, `textAlign:"center"` on the card.
Kept: card chrome, `AnimatePresence` fade, positioning, `pointer-events-none`, the `length > 0`
guard, TEE-SHOT-ONLY visibility. `b.side` becomes unused by the chip — leave the field (honest-geometry
contract + tests); no other consumer exists.

## Step 6 — Regenerate + commit assets
`cd frontend && python3 scripts/generate-bunker-marker.py`. Commit all 7 PNGs: `bunker-marker.png`
(regenerated, must be byte-identical — if git shows it dirty, the `render(None)` path drifted: fix
the generator, do not commit a changed fallback) + `bunker-marker-{a..f}.png`. Visually inspect at
least `-a` and `-c` at render size.

## Step 7 — Tests (pure, deterministic — no DB/Playwright)
`tee-shot-overlays.test.ts` (reuse existing `makeHoleLine`/`makeBunkerPolygon`/`northOf`/`eastOf`):
1. Stable letter assignment — 3 qualifying bunkers (distinct fronts); two calls same features → identical
   `letter` arrays; `'A'` on the min-front bunker.
2. Legend↔marker agreement — `result[i].letter === String.fromCharCode(65+i)` for every i AND `front`
   non-decreasing.
3. Cap behavior, contiguous — six-bunker fixture (test-11): default cap → `['A','B','C','D']` (no gaps);
   `maxBunkers: 2` → `['A','B']`.
`google-map-helpers.test.ts` (next to the `teeMarkerIconUrl` block ~L754):
4. `bunkerMarkerIconUrl` mapping + fallback — `'A'`→`assets/bunker-marker-a.png`; `'f'`→`…-f.png`
   (case-insensitive); `''`, `'G'`, `'AB'`, `' '` → `assets/bunker-marker.png`.
New `frontend/src/lib/map/bunker-marker-assets.test.ts` (vitest node env, `node:fs`/`node:path` only):
5. For each of the 7 expected PNGs: file exists, starts with the 8-byte PNG signature, IHDR width/height
   (bytes 16-23 BE) == 96×96. Catches "edited generator, forgot to re-run/commit PNGs" drift.

## Step 8 — Gates (all SUCCESS on pushed head)
```
cd frontend
npm run lint
npx tsc --noEmit
npm run build
npx tsx voice-tests/runner.ts --smoke
npx vitest run src/lib/map/tee-shot-overlays.test.ts src/lib/map/google-map-helpers.test.ts src/lib/map/bunker-marker-assets.test.ts
```
Plus `python3 scripts/generate-bunker-marker.py` re-run with the A–F PNGs committed. Backend ruff N/A.

## Edge cases
- 0 bunkers → `[]`; existing `length > 0` guard hides the legend; no markers. Unchanged.
- 1 bunker → single 'A' coin + `(A) 210/220` chip.
- Cap hit (>4) → letters only to survivors, post-cap post-sort, contiguous A.. no gaps.
- Inline (cap 2) → A, B only; both surfaces read the same `BunkerCarry` → agree by construction.
- index ≥ 6 (unreachable today) → `letter: ''` → plain bean marker + coin-less chip; no crash/wrong letter.
- `front === back` → single number next to the coin (preserved).
- iOS → per-letter bundled PNGs mandatory (data-URL/canvas icons don't load).
- Par 3 / no tee → suppressed upstream in `computeTeeShotOverlays`; unchanged.

## NORTHSTAR conformance
Ink coin + reversed paper letter on the hand-drawn bean = printed yardage-book annotation, not SaaS
chrome; the chip gets quieter (one row, caption removed); all colors are existing `T` tokens; no new
deps, no new design language.

## Ordered execution
1. `tee-shot-overlays.ts` letter field + assignment.
2. `generate-bunker-marker.py` parameterization + stroke font; run it; inspect PNGs.
3. `google-map-helpers.ts` `bunkerMarkerIconUrl(letter)`.
4. `GoogleSatelliteMap.tsx` marker size/icon + chip rewrite.
5. Tests.
6. Gates; commit code + PNGs together.

## Post-implementation note — legibility rework (designer BLOCKING → PASS)
The first render (d604c30) used a small corner coin (COIN_R_FILL 15 @ (74,24)) that was ILLEGIBLE at the
true 26px CSS render size (coin ≈8px, sub-pixel stroke that smeared — B/D collapsed). Fixed in 9c4cade:
coin enlarged (COIN_R_FILL 15→24), recentered to (58,40) so the ring stays fully inside the 96px canvas
(the old center clipped), glyph box scaled ~1.53×, STROKE_R 1.5→3.0 (≥1.5px final stroke). `render(None)`
fallback stayed byte-identical. Verified legible at true size via 26px/52px downsample proofs (designer
independently re-downscaled and PASSED). LESSON: the assets test only checks 96×96 IHDR — it does NOT
catch true-render-size legibility. Always eyeball a downsample to the actual `iconSize` before shipping a
generated marker glyph.

## NON-BLOCKING watch item (designer, future tweak — do NOT fix now)
The enlarged coin now dominates the icon silhouette over the sand-bean shape. If the owner ever wants the
bunker identity stronger at a glance, a future tweak: `COIN_R_FILL` 24→~20–21 and/or a wider bean arc.
Ships as-is; this is a taste tweak, not a defect.

## DEFERRED sibling item (separate backlog entry: bunker-plate-zoom-fixed-screen-dot)
The 200/150/100 yardage plates render as native `Circle`s with `radius: 4` METERS (ground-anchored), so
they visually balloon in screen px at close zoom — this is what the owner's screenshot showed as "large
plain circles." Designer + Fable both judge a fixed small SCREEN-space dot (icon-marker idiom, like the
bunker/tee glyphs) the correct yardage-book treatment. It's a Circle→icon MECHANISM swap (not trivial) and
PRE-EXISTING (not introduced by this lane), so it is intentionally OUT OF SCOPE here and filed separately.
Verdict on the owner's item-4 question: NOT a zoom artifact of this change and NOT a new regression — it is
the shipped plate implementation's inherent behavior (ground radius), a real sizing issue worth a dedicated,
reviewed follow-up.
