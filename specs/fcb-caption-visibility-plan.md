# fcb-caption-visibility — implementation plan

- Backlog id: fcb-caption-visibility
- Priority: P1 (owner-confusing UX)
- Scope: frontend-only. Do NOT touch backend/app/caddie/*, guide validator, or any
  backend file (hazard-side-flip backend review is live this cycle — avoid collisions).
- Northstar gate: yardage-book quiet — on-paper, restrained, serif display, calm, NO
  SaaS clutter. Reuse existing T.* tokens and the existing mono micro-label style.
  Introduce NO new design language, NO new dependency.

## 0. Problem statement

On the round map screen, the F/C/B "source" caption (`● from where you stand` vs
`from the tee`) sits directly above the Front/Center/Back tile row, at the very bottom
of the distances card. A prior cycle (specs/caddie-stale-hole-live-plan.md §3.10) already
moved it *above* the tiles, but the ENTIRE card is at the bottom of the viewport, under
the floating Ask-caddie / Enter-score pill bar — so the owner still cannot see it.

Two secondary confusions, both from the 2026-07-09 screenshots:
- The PLAYS tile `sub` reads a bare `"adjusted"` which does not say *what* was adjusted.
- Header 548Y (card) vs Center 508 (straight-line) vs PLAYS 493 (adjusted) read like a
  bug when they diverge on a dogleg.

## 1. Target files

- `frontend/src/app/round/[id]/RoundPageClient.tsx` (derivation ~1104-1167; render
  ~1849-1925; `MapStat` ~2374). Imports at top: line 6 `DEFAULT_ACCENT`, `T`; line 51
  `playsLikeYards`; line 53 `computeFCBDistances`.
- NEW `frontend/src/lib/caddie/fcb-labels.ts` (pure module, no React).
- NEW `frontend/src/lib/caddie/fcb-labels.test.ts` (Vitest, node env).

Do NOT modify `frontend/src/lib/types.ts` (confirmed: no shared-type change; the new
helper takes primitives/booleans, not the API model). Backend `backend/app/models.py`
stays untouched.

## 2. Approach (behavior-preserving refactor + one placement move)

Extract the three label-derivation concerns into a small pure module so they are unit
testable without rendering the 2400-line component (same pattern as
`frontend/src/lib/caddie/plays-like.ts` + `plays-like.test.ts`). Then:
1. Relocate the source caption to a new thin header row at the TOP of the distances card
   (above Wind/Elev/Plays), where the pill bar never reaches. Remove the old caption.
2. Rename the PLAYS `sub` `"adjusted"` → `"wind+elev"` (via the helper), keeping every
   other sub honest.
3. (Designer-gated, optional) add a tiny line-vs-card hint when straight-line Center
   diverges from the card yardage by >5%.

Numbers do NOT change. Only label STRINGS relocate/rename, and the value `v` computation
stays inline in the component (it depends on `playsLikeYards`/`Math.round`).

## 3. New pure module — `frontend/src/lib/caddie/fcb-labels.ts`

Mirror the header-comment + JSDoc style of `plays-like.ts`. No imports needed (pure
primitives). Exact signatures:

```ts
export type FcbSource = "you" | "tee";

export interface FcbCaption {
  /** Display string incl. the leading accent dot when live. Rendered under
      textTransform:uppercase, so lowercase source strings are intentional. */
  text: string;
  /** true when derived from live GPS ("you") → render in DEFAULT_ACCENT. */
  isLive: boolean;
}

/** Source caption for the F/C/B tiles. */
export function fcbSourceCaption(source: FcbSource): FcbCaption {
  const isLive = source === "you";
  return {
    text: isLive ? "● from where you stand" : "from the tee",
    isLive,
  };
}

export interface PlaysSubInput {
  /** holeWind != null — per-hole relative wind is available. */
  hasWind: boolean;
  /** holeIntel != null — USGS elevation intel is available. */
  hasElev: boolean;
  /** fcbLive != null — plays-base came from the live rangefinder distance. */
  isLive: boolean;
}

/**
 * PLAYS-tile sub label. Each branch truthfully names what was adjusted.
 * Mirrors the pre-refactor ternary in RoundPageClient exactly, EXCEPT the
 * wind+elev branch, which was the bare "adjusted".
 */
export function playsSubLabel({ hasWind, hasElev, isLive }: PlaysSubInput): string {
  if (hasWind) {
    if (isLive) return "wind from you"; // wind on live distance; no elev term applied
    if (hasElev) return "wind+elev";    // was "adjusted" — wind AND elevation both applied
    return "wind-adj";                  // wind only
  }
  if (hasElev && !isLive) return "elev-adj"; // elevation only
  if (isLive) return "from you";             // raw live distance, no adjustments
  return "from tee";                         // raw card/tee distance
}

export interface LineVsCardHint {
  /** true when |center − cardYards| / cardYards is strictly > 0.05. */
  show: boolean;
  /** Tiny label distinguishing straight-line from card; "" when !show. */
  text: string;
}

/**
 * Designer-gated dogleg hint. When the straight-line Center distance diverges
 * from the scorecard card yardage by more than 5%, the two numbers can read as
 * a bug; this flags a quiet "line" clarifier. Boundary is strictly >5%.
 */
export function lineVsCardHint(
  center: number | null | undefined,
  cardYards: number,
): LineVsCardHint {
  if (center == null || !Number.isFinite(center) || cardYards <= 0) {
    return { show: false, text: "" };
  }
  const divergence = Math.abs(center - cardYards) / cardYards;
  return divergence > 0.05 ? { show: true, text: "line" } : { show: false, text: "" };
}
```

Rationale for `playsSubLabel` truthfulness (verified against current code
RoundPageClient.tsx:1158-1167 and playsBase at 1150-1152):
- `playsBase` = `fcbLive.center` when live (raw rangefinder, NO elevation term), else
  `holeIntel?.effectiveYards` (elevation-adjusted) or the tee/card center.
- `hasWind && isLive` → wind layered on the raw live distance → "wind from you"
- `hasWind && hasElev && !isLive` → playsBase carried elevation, then wind on top →
  "wind+elev" (this replaces "adjusted")
- `hasWind && !hasElev && !isLive` → wind on the plain card/tee center → "wind-adj"
- `hasElev && !isLive` (no wind) → elevation only → "elev-adj"
- `isLive` (no wind) → raw live distance → "from you"
- else → raw card/tee → "from tee"

## 4. Edits to `frontend/src/app/round/[id]/RoundPageClient.tsx`

### 4.1 Import the helper (anchor: import block, near line 51-53)
Add:
```ts
import { fcbSourceCaption, playsSubLabel, lineVsCardHint } from "@/lib/caddie/fcb-labels";
```
(Import `lineVsCardHint` only if the designer-gated item in §4.5 ships; otherwise omit it
to keep lint clean — no unused import.)

### 4.2 Derive the caption (anchor: after `fcbSource` at line 1118)
After `const fcbSource: "you" | "tee" = fcbLive ? "you" : "tee";` add:
```ts
const fcbCaption = fcbSourceCaption(fcbSource);
```

### 4.3 Replace the `playsTile` ternary (anchor: lines 1158-1167)
Before: the 10-line `holeWind ? {...} : holeIntel && !fcbLive ? {...} : ...` block whose
only per-branch difference (besides `v`) is the `sub` string.
After (behavior-identical `v`, `sub` via helper):
```ts
const playsTile = {
  v: holeWind
    ? `${playsLikeYards(playsBase, holeWind.headMph)}Y`
    : `${Math.round(playsBase)}Y`,
  sub: playsSubLabel({
    hasWind: holeWind != null,
    hasElev: holeIntel != null,
    isLive: fcbLive != null,
  }),
};
```
Verify: all three non-wind branches previously produced `${Math.round(playsBase)}Y`, so
the collapsed `v` is exact. The wind branch is unchanged. Keep the explanatory comment at
1153-1157 (still accurate).

### 4.4 Move the caption into a new card header row (anchors: 1849-1882)
- At the TOP of the `data-overlay` card, immediately inside
  `<div data-overlay style={{ background: T.paper, padding: '10px 14px 12px' }}>`
  (line 1849) and BEFORE the Wind/Elev/Plays grid `<div>` at 1850, insert a thin
  right-aligned header row:
```tsx
<div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
  <span
    style={{
      fontFamily: T.mono,
      fontSize: 8.5,
      letterSpacing: 1.2,
      textTransform: "uppercase",
      color: fcbCaption.isLive ? DEFAULT_ACCENT : T.pencilSoft,
    }}
  >
    {fcbCaption.text}
  </span>
</div>
```
- REMOVE the old caption block entirely (lines 1863-1882 — the comment referencing
  §3.10 and the `<div style={{ marginBottom: 8, textAlign: "right", ... }}>` reading
  `{fcbSource === "you" ? "● from where you stand" : "from the tee"}`). Do NOT leave two
  captions. The tile row (1883-1924) now follows directly after the Wind/Elev/Plays grid
  divider.

Token/casing parity: mono, fontSize 8.5, letterSpacing 1.2, textTransform uppercase,
DEFAULT_ACCENT when live else T.pencilSoft — identical to the removed micro-label, so no
new design language. Placement above the stat grid keeps it clear of the floating pill
bar that occludes the card bottom.

### 4.5 (DESIGNER-APPROVAL-GATED, OPTIONAL) line-vs-card hint
Ship ONLY if the designer confirms it stays yardage-book quiet. Minimal calm form: a
single tiny mono word under the Center tile's number, same micro-label tokens, muted
(`T.pencilSoft`), no icon, no color. Derivation near the `fcbTiles` block (line 1119):
```ts
const centerHint = lineVsCardHint(fcb?.center, distance); // card yardage = `distance`
```
Render inside the Center tile only (in the `fcbTiles.map`, keyed `d.k === "Center"`),
appended after the serif number at ~1921:
```tsx
{d.k === "Center" && centerHint.show && (
  <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase" }}>
    {centerHint.text}
  </div>
)}
```
Caveat to raise with the designer/owner (do NOT fix here — out of scope): `distance`
(RoundPageClient.tsx:1058) is a DERIVED value
(`Math.max(80, hole.yards - Math.round(hole.yards * 0.6))`), not literally the scorecard
yardage. If the intended "card" comparison is `hole.yards`, the designer should confirm
which number the hint compares against before this ships. Because of this ambiguity, the
default recommendation is to hold §4.5 pending designer sign-off and ship §4.2-4.4 now.

## 5. Test matrix — `frontend/src/lib/caddie/fcb-labels.test.ts`

Vitest, node env, `import { describe, it, expect } from 'vitest'`. Follow the
plays-like.test.ts layout (header comment + grouped describes).

fcbSourceCaption:
- source "you" → `{ text: "● from where you stand", isLive: true }`
- source "tee" → `{ text: "from the tee", isLive: false }`

playsSubLabel (every branch):
- `{hasWind:true, hasElev:true,  isLive:true }` → "wind from you"
- `{hasWind:true, hasElev:false, isLive:true }` → "wind from you" (live wins over elev)
- `{hasWind:true, hasElev:true,  isLive:false}` → "wind+elev"   (the renamed branch)
- `{hasWind:true, hasElev:false, isLive:false}` → "wind-adj"
- `{hasWind:false,hasElev:true,  isLive:false}` → "elev-adj"
- `{hasWind:false,hasElev:true,  isLive:true }` → "from you"    (live, no wind)
- `{hasWind:false,hasElev:false, isLive:true }` → "from you"
- `{hasWind:false,hasElev:false, isLive:false}` → "from tee"

lineVsCardHint (>5% boundary — just under / at / over):
- just under: center 522, card 500 → 4.4% → `{ show:false, text:"" }`
- at exactly 5%: center 525, card 500 → 0.05 → `{ show:false, text:"" }` (strictly >)
- just over: center 526, card 500 → 5.2% → `{ show:true, text:"line" }`
- shorter side over: center 470, card 500 → 6% → `{ show:true, text:"line" }`
- null center → `{ show:false, text:"" }`
- NaN center → `{ show:false, text:"" }`
- cardYards 0 → `{ show:false, text:"" }` (no divide-by-zero)

## 6. Edge cases / risks

- No live GPS (playerPos null / posOnHole false): fcbLive null → caption "from the tee",
  T.pencilSoft, no accent dot. Correct.
- Wind data but no hole coords (holeBearing null → holeWind null): PLAYS falls through to
  non-wind branches; sub honesty preserved.
- Collapsing the playsTile ternary: verify the wind branch `v` still uses
  `holeWind.headMph` — do not access `holeWind` outside the `holeWind != null` guard in
  the collapsed `v` (the `?:` on `holeWind` truthiness guards it).
- Unused import: if §4.5 does not ship, do NOT import `lineVsCardHint` (lint would flag).
- Do not alter `fcbTiles`, `MapStat`, or any numeric value; the designer reviews the
  header-row placement against NORTHSTAR.md before ship.
- Confirm no other reader of the old caption text exists (grep `from where you stand`,
  `from the tee`, `"adjusted"` after edit — only the relocated usage should remain).

## 7. Gates (run all; each must pass before ship)

```
cd frontend && npm run lint            # exit 0
cd frontend && npx tsc --noEmit        # clean, no type errors
cd frontend && npx vitest run src/lib/caddie/fcb-labels.test.ts   # new tests green
cd frontend && npx vitest run          # full suite, no regressions
cd frontend && npm run build           # production build succeeds
cd frontend && npx tsx voice-tests/runner.ts --smoke              # voice smoke green
```

## 8. Out of scope / do-not
- No backend edits (backend/app/caddie/*, models.py, guide validator).
- No new dependency, no new design tokens or component library.
- No change to frontend/src/lib/types.ts (confirmed unnecessary).
- Numbers unchanged — only label strings relocated/renamed.

### Critical files for implementation
- /Users/justinlee/projects/scorecard/frontend/src/app/round/[id]/RoundPageClient.tsx
- /Users/justinlee/projects/scorecard/frontend/src/lib/caddie/fcb-labels.ts (new)
- /Users/justinlee/projects/scorecard/frontend/src/lib/caddie/fcb-labels.test.ts (new)
- /Users/justinlee/projects/scorecard/frontend/src/lib/caddie/plays-like.ts (pattern reference)
- /Users/justinlee/projects/scorecard/frontend/src/components/yardage/tokens.ts (T.* + DEFAULT_ACCENT)
