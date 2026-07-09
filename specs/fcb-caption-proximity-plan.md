# fcb-caption-proximity — Implementation Plan

Backlog: `fcb-caption-proximity` (P2 minor, low risk). Designer follow-up to `fcb-caption-visibility`. Non-blocking. Silent rider on bundle PR #117 (branch `integration/next`).

## 1. Problem

The F/C/B source caption (`from the tee` / `● from where you stand`; live state uses `DEFAULT_ACCENT`) was moved to the TOP of the distances `data-overlay` card by the prior visibility fix (`specs/fcb-caption-visibility-plan.md` §4.4). That killed pill-bar occlusion but visually orphaned the label: it now sits above the Wind/Elev/Plays stat row, separated from the Front/Center/Back tiles it describes by that whole stat row plus a hairline.

Verified current layout in `frontend/src/app/round/[id]/RoundPageClient.tsx`:
- Card wrapper `<div data-overlay style={{ background: T.paper, padding: "10px 14px 12px" }}>` — line 1854.
- Caption row (currently TOP): lines 1862–1874 — `flex`, `justifyContent: flex-end`, `marginBottom: 8`; span is `T.mono` 8.5px, `letterSpacing 1.2`, uppercase, color `fcbCaption.isLive ? DEFAULT_ACCENT : T.pencilSoft`, text `fcbCaption.text`.
- Wind/Elev/Plays grid: 1875–1887 — `borderBottom 1px T.hairline`, `marginBottom 12`.
- F/C/B tile row: `<div style={{ display: "flex", gap: 8 }}>` at 1888; tiles 1889–1928.
- Derivations (unchanged): `fcbSource`/`fcbCaption` 1119–1120, `fcbTiles` 1124–1128, `windTile` 1136–1143, `elevTile` 1147–1152, `playsTile` 1163–1172.
- `MapStat` helper: defined 2379–2387, used only at 1884–1886.
- Scroll body: 1468–1485 — `position: absolute`, `top: calc(58px + max(14px, env(safe-area-inset-top)))`, `bottom: 0`, `overflowY: auto`, `padding: "0 14px 110px"`.
- Floating pill bar: 2073 — `position: absolute`, `bottom: 0`, `zIndex: 20`, `padding: "0 20px max(28px, calc(env(safe-area-inset-bottom) + 12px))"`; overlays the scroll body.

## 2. Chosen approach (and why)

**2a. Re-anchor the caption locally.** Remove the top caption block (1862–1874) and re-insert the identical span immediately ABOVE the F/C/B tile row (between the stat grid at 1887 and the tile row at 1888). Same tokens, same quiet right-aligned micro-label styling; only `marginBottom` is retuned (`8 → 6`) so it hugs the tiles. Left/inline-near-tiles placement is left as a designer call at review per the brief; this plan ships the simplest re-anchor (right-aligned, unchanged style) so review has a stable baseline.

**2b. Root clearance = bottom padding on the card wrapper (NOT a sticky mini-header).** Increase the card wrapper's bottom padding so the F/C/B block + its now-lower caption are lifted off the floating pill bar. Change line 1854 padding from `"10px 14px 12px"` to a safe-area-aware value:

```
padding: "10px 14px max(20px, calc(env(safe-area-inset-bottom) + 14px))"
```

Justification for padding over the designer's fallback sticky mini-header:
- It is pure layout — no new stacking context, no `z-index` interplay with the `zIndex: 20` pill bar, no scroll-jank, no new behavior. A `position: sticky` header introduces a moving element and a new visual affordance, which conflicts with the yardage-book / calm / restrained NORTHSTAR and the "no new design language" constraint.
- It reuses the exact idiom already in the codebase (the pill bar and scroll body both use `max(..., calc(env(safe-area-inset-bottom) + ...))`), so it is consistent and inherits correct behavior on notched devices.
- The global scroll-body `110px` bottom padding already guarantees scrollability; this card-level padding is the additional, deterministic guarantee that the block's bottom edge clears the pill overlay in the resting frame. The `max(20px, …)` floor keeps non-notched devices from collapsing the gap.

Net: the caption reads as belonging to the tiles (2a) and no longer hides behind the pill bar (2b), with zero behavior/number changes.

## 3. Validation approach — extract `DistancesCard`, render-test it

`RoundPageClient` cannot render in jsdom cheaply: it pulls `mapbox-gl`, `@capacitor/*`, `@clerk/*`, `framer-motion`, and has a documented crash history on the map view. So a full-component render test is not viable.

**Decision: extract the card into a pure presentational component and render-test THAT** (recommended over an in-place structural assertion, because DOM adjacency is exactly the property under review and extraction lets us assert real render order rather than reading source text). The repo already supports this: `@testing-library/react`, `@testing-library/dom`, `jsdom` are in `devDependencies`, `vitest.config.ts` defaults to `node` with per-file `// @vitest-environment jsdom` opt-in, and there are existing `.test.tsx` render tests (e.g. `src/components/nav/FloatingTabBar.test.tsx`, `src/components/CourseSearch.test.tsx`).

New file `frontend/src/components/yardage/DistancesCard.tsx`, a props-in / JSX-out component (no hooks, no I/O):

```ts
interface DistancesCardProps {
  fcbCaption: { text: string; isLive: boolean };   // from fcbSourceCaption
  fcbTiles: { k: string; v: number; color: string }[];
  windTile: { v: string; sub: string };
  elevTile: { v: string; sub: string };
  playsTile: { v: string; sub: string };
}
```

- Move the JSX currently at lines 1854–1930 (wrapper + caption + stat grid + tile row) into `DistancesCard`, applying the 2a re-anchor and 2b clearance there.
- Move the `MapStat` helper (2379–2387) into `DistancesCard.tsx` (it is used nowhere else) or keep it exported and import it; moving it is cleaner.
- `DistancesCard` imports `T` and `DEFAULT_ACCENT` from `@/components/yardage/tokens` (same source RoundPageClient uses at line 6).
- In `RoundPageClient`, replace the inline block with `<DistancesCard fcbCaption={fcbCaption} fcbTiles={fcbTiles} windTile={windTile} elevTile={elevTile} playsTile={playsTile} />`. This is behavior-preserving; all derivations (§2 refs) stay in `RoundPageClient`.
- Add a `data-testid` to the caption span (e.g. `data-testid="fcb-caption"`) and to the tile-row container (e.g. `data-testid="fcb-tile-row"`) to make adjacency assertable without brittle text matching.

New test `frontend/src/components/yardage/DistancesCard.test.tsx` (`// @vitest-environment jsdom`, RTL `render`), asserting deterministically:
1. **Adjacency / DOM order** — the caption node is the immediately-preceding element sibling of the F/C/B tile row (`captionEl.nextElementSibling === tileRowEl`, or `compareDocumentPosition` proving caption precedes tiles with no stat-grid node between them). This is the core proof of the re-anchor.
2. **Not above the stat grid** — the Wind/Elev/Plays grid comes BEFORE the caption in document order (guards against regressing to the top placement).
3. **Clearance present** — the card wrapper's inline `paddingBottom` (or `padding`) contains the safe-area clearance token (assert the style string includes `env(safe-area-inset-bottom)` and the `max(` floor). jsdom preserves inline `style` strings, so this is a reliable structural assertion.
4. **Caption text/color states** — with `fcbCaption.isLive: true`, text is `● from where you stand` and color is `DEFAULT_ACCENT`; with `false`, text is `from the tee` and color is `T.pencilSoft`. (Covers the live-vs-from-tee edge case at the render layer; the pure derivation is already covered by `fcb-labels.test.ts`.)

The existing `frontend/src/lib/caddie/fcb-labels.test.ts` needs NO change (the helper is untouched); it stays green and is re-run as a gate.

**On-device validation (honest note for the owner):** the deterministic render test proves adjacency + clearance-style presence but NOT the pixel-level glanceable framing on a real device (which depends on map height 430 + viewport + actual safe-area insets). Owner should confirm on the next TestFlight build via an on-device screenshot of the round map view that the caption sits directly above the F/C/B tiles and clears the Ask-caddie / Enter-score pill bar. The iOS simulator screenshot flow is optional-stronger-if-cheap, not required for this P2 CSS follow-up, and the map view's crash history makes it a poor gate.

## 4. Ordered implementation steps

1. Create `frontend/src/components/yardage/DistancesCard.tsx`: move card JSX (1854–1930) + `MapStat` (2379–2387) in; import `T`, `DEFAULT_ACCENT` from `@/components/yardage/tokens`; define `DistancesCardProps`.
2. In `DistancesCard`, apply re-anchor (2a): delete the top caption block; insert the caption span immediately above the tile-row `<div style={{ display: "flex", gap: 8 }}>`, `marginBottom: 6`, same tokens.
3. In `DistancesCard`, apply clearance (2b): set wrapper padding to `"10px 14px max(20px, calc(env(safe-area-inset-bottom) + 14px))"`.
4. Add `data-testid="fcb-caption"` (span) and `data-testid="fcb-tile-row"` (tile-row container).
5. In `RoundPageClient.tsx`: replace inline card (1854–1930) with `<DistancesCard … />`; delete the now-orphaned `MapStat` definition; keep all derivations. Confirm the `data-overlay` attribute stays on the wrapper (the map-interaction handler at line 1653 uses `closest("[data-overlay]")`, and the zoom/overlay logic relies on it) — `DistancesCard` MUST keep `data-overlay` on its root div.
6. Create `frontend/src/components/yardage/DistancesCard.test.tsx` with the four assertion groups in §3.
7. Run the full gate set (§7).

## 5. Edge cases

- **Live vs from-tee caption**: both text strings and both colors covered by render test (§3.4) and the untouched `fcb-labels.test.ts`. `fcbSourceCaption` logic unchanged.
- **320px narrow width**: caption stays right-aligned mono 8.5px (single short line, no wrap risk); tile row keeps `flex gap: 8`. No layout regression; extraction preserves exact styles.
- **Safe-area insets**: clearance uses `max(20px, calc(env(safe-area-inset-bottom) + 14px))` — non-notched devices get the 20px floor, notched devices get inset-aware clearance, matching the pill bar and scroll-body idioms.
- **Mock / no-course fallback branch**: SEPARATE code path (the `) : (` branch at 1932 onward, `AnimatePresence`/`HoleCard`). It does NOT render `DistancesCard` and is untouched by this change.
- **`data-overlay` dependency**: must be preserved on the extracted wrapper (see step 5) or map tap/zoom overlay detection breaks.

## 6. Risks

- **Low — extraction regression**: moving ~75 lines of JSX could drop a style/attr. Mitigated by keeping styles byte-identical except the two intended edits, and by preserving `data-overlay`. Behavior is pure layout; numbers untouched.
- **Low — `data-overlay` omission** would silently break map interaction. Explicit step 5 check + note.
- **Low — glanceable framing not proven by tests**: real-device fold position depends on viewport/map height; addressed by the TestFlight screenshot note (§3), not by tests.
- **Negligible — token drift**: `DistancesCard` imports the same `tokens` module; no duplicated constants.

## 7. Gates (run from `frontend/`)

```
cd frontend && npm run lint && npx tsc --noEmit && npm run build && npx tsx voice-tests/runner.ts --smoke
```
Plus vitest for the labels helper and the new render test:
```
cd frontend && npx vitest run src/lib/caddie/fcb-labels.test.ts src/components/yardage/DistancesCard.test.tsx
```
(or `npm test` to run the whole suite.)

`ruff` is N/A — there is no backend change.

## 8. Shared types

None. This is pure frontend layout. Confirmed no change is needed to `frontend/src/lib/types.ts` or `backend/app/models.py` — no data shape, API, or model changes; the `FcbSource`/`FcbCaption` types in `frontend/src/lib/caddie/fcb-labels.ts` are unchanged.
