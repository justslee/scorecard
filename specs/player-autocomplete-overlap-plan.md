# Plan: `player-autocomplete-overlap` — Done button unreachable under autocomplete overlays

## Confirmed root cause

In the "Who's playing?" picker bottom sheet (`frontend/src/app/round/new/page.tsx`, picker branch lines 1477–1596), `<PlayerAutocomplete>` (line 1534) is followed in normal flow by the Done button (lines 1576–1594, `marginTop: 16`, `onClick={() => setPicker(null)}`).

`frontend/src/components/PlayerAutocomplete.tsx` renders two overlays absolutely positioned just below the input, both `position: 'absolute'; zIndex: 60; top: 'calc(100% + 6px)'; left: 0; right: 0`:

- Suggestions dropdown: lines 287–414 (style at 296–307), rows are 48px min-height, list capped at `maxHeight: 240`.
- "No matches" popover: lines 421–458 (style at 427–441), shows `"X" will be added as a new player.` and has **no onClick** — it just eats taps.

Since Done sits only ~16px below the input in flow, either overlay floats over it and intercepts pointer events. While typing (suggestions or no-match visible), tapping Done hits the overlay instead — the user cannot confirm/dismiss. The input's `onBlur` closes the overlay only after a 150ms `setTimeout` (line 176–178), and the tap that would trigger that blur is itself swallowed, so there's no escape path other than tapping the backdrop.

Consumer check (grep confirmed): `PlayerAutocomplete` is imported/used **only** by `frontend/src/app/round/new/page.tsx` (line 20, 1534). Changing the component affects exactly this one sheet.

Corroborating evidence the in-flow behavior was the original intent: the comment at page.tsx lines 1506–1508 says the "this is me" button was placed above the autocomplete "so the inline suggestion row can't push it off the sheet while typing" — i.e. the design already assumed an *inline* (in-flow) suggestion row that pushes content down.

## Chosen fix: Option A — render both overlays in-flow

Make the suggestions dropdown and the no-matches popover normal-flow siblings of the input row instead of absolute overlays. They then push the Done button down; nothing can ever cover it.

**Why A over the others**
- **A** is one file, ~8 style-property changes, zero new state or props. The picker content div is already `flex: 1; overflow: "auto"` (page.tsx line 1478) inside a `maxHeight: 80vh` sheet, so the pushed-down Done stays reachable by scroll in the worst case (240px list). It also matches the existing "inline suggestion row" comment and removes two `zIndex: 60` declarations entirely.
- **B** (in-flow spacer mirroring an absolute overlay's height) needs the sheet to know the overlay's open state and measured height — a new callback prop or ResizeObserver, two files, more moving parts for the same visual result.
- **C** (lift Done above with `position: relative; zIndex > 60`) leaves the overlay visually sitting on top of/behind the pill — Done's text would collide with the suggestion card. Ugly, and taps near the card edge still ambiguous. Rejected.

### Exact edits (single file: `frontend/src/components/PlayerAutocomplete.tsx`)

1. **Suggestions dropdown** (style object, lines 296–307): delete `position: 'absolute'`, `zIndex: 60`, `top: 'calc(100% + 6px)'`, `left: 0`, `right: 0`; add `marginTop: 6`. Keep `borderRadius`, `background`, `border`, `overflow: 'hidden'`; keeping the `boxShadow` is fine — it still reads as a card.
2. **No-matches popover** (style object, lines 427–441): same substitution — remove `position/zIndex/top/left/right`, add `marginTop: 6`.
3. Leave everything else untouched: the root `position: 'relative'` wrapper (line 199) is harmless; the inner `maxHeight: 240; overflowY: 'auto'` list (line 309) still scroll-caps long suggestion lists; `scrollIntoView({ block: 'nearest' })` (line 116) still targets that inner list.

**Calm check:** the `AnimatePresence` enter/exit still animates opacity/y over 0.14s; the height change itself is a single instant reflow inside an already-scrolling sheet — same feel as other yardage-book sheets that grow with content. Exit keeps the element in flow for 140ms, so Done doesn't jump up before the animation finishes. No height animation added — not needed for calm at this size.

## Edge cases (verified against the code)

- **Keyboard nav**: ArrowUp/Down/Enter/Escape/Tab handling (lines 140–169) doesn't depend on positioning; inner list scrolling unchanged.
- **Auto-close on saved-player select**: `handleSelectPlayer` (128–138) sets `isOpen(false)` and page.tsx's `onChange` (1551–1554) closes the picker — unchanged. The 150ms blur delay (176–178) still lets suggestion clicks land before collapse.
- **"this is me" button** (page.tsx 1509–1531): sits *above* the input; in-flow overlays only push content *down*, so it's unaffected — consistent with its own comment.
- **Sunlight legibility**: colors/typography untouched; the card keeps `T.paper` background + hairline border + shadow.
- **z-index**: fix removes both `zIndex: 60` uses in this component. No interaction with LooperSheet's `zIndex: 60` fixed backdrop was ever real (the picker sheet is its own stacking context), but after the fix there's no z-index in this component at all — strictly fewer footguns.
- **Done pushed below the fold**: worst case (10 suggestions, capped 240px) Done needs a small scroll — acceptable; the previous state was *untappable*, and users typically tap a suggestion (auto-closes) rather than Done in that state.

## Test seam — honest assessment

No good unit seam. Vitest runs in `environment: 'node'` with per-file jsdom (`frontend/vitest.config.ts`), and jsdom has no layout/hit-testing — a jsdom "click Done while suggestions open" test would pass even against the buggy code, and asserting `style.position !== 'absolute'` just restates the diff. Don't write one.

The genuine seam is Playwright: `page.click()` performs real hit-testing and fails/timeouts when another element intercepts pointer events. Recommended as a **verification drive, not a committed spec** (the `e2e/` dir has only auth setup + one spec; wiring a durable authed round-setup e2e for this is disproportionate): open `/round/new`, open the player picker, type into the autocomplete so suggestions (and separately, a no-match string) are showing, then `click('text=Done')` and assert the sheet closed. Before the fix this click times out with "element intercepts pointer events"; after, it succeeds.

## Gates

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npm run build
```

Plus the interaction check above (Playwright drive of the sheet, or a manual/simulator pass): with a suggestion row showing → tap Done → sheet closes; with the no-match popover showing → tap Done → sheet closes; tapping a suggestion still selects and auto-closes.

### Critical files
- `frontend/src/components/PlayerAutocomplete.tsx` — the only file edited (overlay style objects at lines 296–307 and 427–441)
- `frontend/src/app/round/new/page.tsx` — sole consumer; picker sheet lines 1477–1596, Done at 1576, scroll container at 1478 (read-only context)
- `frontend/playwright.config.ts` — interaction-verification harness
- `frontend/vitest.config.ts` — documents why no jsdom unit test (node env, no layout)
