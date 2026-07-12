# Plan: Lift the three z=50 orb-tied overlays above the CaddieOrb (z-index fix)

**Branch:** `integration/next` · **Scope:** 3 numeric CSS edits across 3 files. No behavior,
layout, component, or shared-type changes. Follow-up to commit `89450fa` (same bug class, same
fix convention). Produced by the fable Plan agent, cycle 103.

## 0. Mechanism (shared by all three)

`CaddieOrb` renders `position: fixed; right: 16; zIndex: 50` (`frontend/src/components/CaddieOrb.tsx:121-123`)
and is mounted in the root layout **after** `{children}` (`frontend/src/app/layout.tsx:66`). Every
page-rendered overlay is an earlier DOM sibling, so at a z-index **tie of 50 the orb wins by paint
order** and its 54px `<motion.button>` (live pointer handlers) intercepts taps. Orb vertical band =
`12px + safe-area + clearance` to `+54px` above that: clearance 74 on tab-bar routes
(`/courses`, `/players`, `/tee-time`), 92 on `/round/new` (`isSetupCtaRoute`).

Established convention: **40** (page overlays, tab bar) < **50** (orb) < **52/53** (overlays that
must clear the orb — `89450fa`) < **60/61** (LooperSheet/caddie) < 70 (ScanSheet) < 80 (RoundRecap).
No shared z-token file; raw numbers + inline comments.

## 1. Per-surface verdicts (verified in code)

### 1a. CourseSearch — REAL control overlap (highest priority, v1.1.2 live surface)
- `frontend/src/components/CourseSearch.tsx:661` — single full-screen `motion.div`
  (`position:fixed; inset:0; height:100dvh; zIndex:50`). One z value; header, list, map are children.
- Routes: `/courses`, `/tee-time`, `/round/new` — all orb-shown.
- Map mode (owner is testing v1.1.2): `CourseScoutMap` fills the region; orb floats over the live
  map — pan/pin-tap/tap-to-add in its 54px circle swallowed. Tap-card **Add** (`CourseScoutMap.tsx`,
  `right:14, bottom:max(14px,safe)`) top edge near the orb's bottom; map above the card squarely
  intercepted. Card/status-pill are z 10/5 INSIDE the surface context — can't out-stack the orb.
- List mode: scroll region puts course rows / right-aligned star toggles under the orb band.
- CourseSearch has its own mic button — orb-on-top is a second live mic over a voice-search surface.

### 1b. PlayerModal — REAL control overlap (moderate)
- `frontend/src/app/players/page.tsx:643` — outer container `position:fixed; inset:0; zIndex:50`;
  backdrop + bottom-anchored sheet (maxWidth 520, `margin:'0 12px'`, `marginBottom:max(16px,safe)`)
  are children.
- Route: `/players`. On phone widths the Save/Add-Player submit button (right-hand `flex:1` of the
  bottom row) extends to ~36px of the right edge; orb's lower portion sits over its top-right corner
  and the Handicap input's right edge; taps in the orb circle summon the caddie instead. Real.

### 1c. VoiceRoundSetupRealtime — MINOR scrim-tie only (no control collision)
- `VoiceRoundSetupRealtime.tsx:228` backdrop (`fixed inset:0; zIndex:50`, onClick=close) and `:255`
  sheet (`fixed bottom; maxWidth 420; zIndex:60`).
- Route: `/round/new`. Interactive sheet is already at 60 > 50 — no VRS control under the orb. On
  phones the full-width sheet is behind the orb anyway. Only defect: the 50-50 backdrop tie — on
  wider viewports the orb pokes through the scrim beside the centered 420 sheet, undimmed/tappable
  (a second-mic `openLooper()` tap path during a live VRS session). Cosmetic + minor one-mic leak.

## 2. Chosen fix — three one-line z lifts to 52 (the 89450fa convention)

| # | File:line | Change |
|---|-----------|--------|
| 1 | `CourseSearch.tsx:661` | `zIndex: 50` → `zIndex: 52` (+ comment: above CaddieOrb (50), below LooperSheet (60)) |
| 2 | `app/players/page.tsx:643` | `zIndex: 50` → `zIndex: 52` (+ comment); backdrop + sheet are children of this container's context |
| 3 | `VoiceRoundSetupRealtime.tsx:228` | backdrop `zIndex: 50` → `zIndex: 52` (+ comment). **Sheet at :255 stays 60.** |

Rationale: one full-screen motion.div value moves the whole CourseSearch surface (header/list/map/
tap-card) above the orb — scrim-covers-orb precedent (89450fa), more correct here (surface carries its
own mic → one mic). PlayerModal: scrim now dims/covers the orb (tap there closes the modal, standard),
Save never under the orb. VRS backdrop → 52 closes the wide-viewport poke-through + second-mic path and
matches the picker scrims already at 52 on the SAME `/round/new` page (`app/round/new/page.tsx:1168`);
order stays backdrop 52 < sheet 60.

Cross-checks: on `/round/new` picker sheets (52/53), VRS (52/60), CourseSearch (52) are mutually
exclusive (one open-state; `onVoiceSearch` closes CourseSearch before opening VRS). LooperSheet/
CaddieOrbSheet 60/61, ScanSheet 70, RoundRecap 80 still stack above. FloatingTabBar (40) and
tee-time's status-bar scrim (40, comment "under CourseSearch (50)" stays true at 52) unaffected.

## 3. Systemic alternatives — evaluated, not chosen
- (a) Shared z-token scale: repo convention is raw numbers + comments (~30 sites, no z tokens);
  retrofitting mid-v1.1.2-owner-testing churns dozens of files for a 3-line fix. Future refactor,
  wrong vehicle now.
- (b) Hide/dim orb on overlay-open: needs a global overlay-open signal wired from three page-local
  states into the orb visibility path (the one-mic / orb-identity invariant carrier) + hide/show
  motion the design avoids. Omnipresent-orb invariant says the orb stays mounted; the 89450fa answer
  is overlays that must win simply stack above it. Disproportionate. Not chosen.
- (rejected: lowering the orb below 50 — regresses its required stacking over the tab bar (40).)

## 4. Stacking-context traps — checked, none found
All three overlays are `position:fixed` direct children of plain, untransformed page-root divs
(`AnimatePresence` renders no DOM wrapper). `/tee-time` PaperShell + `/players` sticky blurred header
are siblings, not ancestors. The framer transform/opacity is on the elements themselves (does not trap
their own z-index — only ancestor transforms do) and resets at rest. Runtime re-verify (DevTools): walk
each overlay's ancestor chain for transform/filter/perspective/will-change/contain; confirm the orb is
not hit-testable over the open overlay.

## 5. Verification gates
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm run build`
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`
- No unit test: jsdom computes no stacking/paint order (precedent: 89450fa, aeb388b). Behavioral
  verification is Playwright/simulator: open each overlay and check `document.elementFromPoint()` at
  the orb's center returns the overlay/scrim, not the orb button; visual pass that the orb is
  dimmed/covered. CourseSearch map mode uses native `capacitor-google-map` — the surface-vs-orb z
  contest is verifiable in web Playwright (list mode + transparent map frame); full native map render
  needs the iOS simulator.

## 6. Out of scope
Pure numeric CSS — `types.ts` / `models.py` untouched. Other z=50 users (`ScanSheet`, `CameraCapture`,
`CaddieSheet`, `Voice.tsx`, `VoiceRoundSetup`, `SwipeableRow`) live on orb-hidden routes or in local
stacking contexts — not part of this fix.
