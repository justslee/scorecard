# Plan: Lift `/round/new` picker sheets above the CaddieOrb (z-index fix)

**Spec file:** `specs/caddie-orb-sheet-zindex-plan.md`
**Scope:** 4 numeric CSS changes across 2 files. No behavior, layout, or component changes.
(Authored by the Plan agent on `fable`, cycle 102.)

## 1. Bug confirmation (verified in code)

The reported analysis is correct, with two refinements.

**Mechanism — confirmed.** The omnipresent `CaddieOrb` renders `position: fixed; right: 16; zIndex: 50` (`frontend/src/components/CaddieOrb.tsx:118-129`) and is mounted in the **root layout after `{children}`** (`frontend/src/app/layout.tsx:66`). Both picker bottom sheets render inside page content at backdrop `zIndex: 40` / sheet `zIndex: 41`:

- `frontend/src/app/round/new/page.tsx:1168` (backdrop) and `:1181` (sheet)
- `frontend/src/app/tournament/[id]/round/new/NewTournamentRoundClient.tsx:1247` (backdrop) and `:1260` (sheet)

Since 50 > 41, the orb **paints on top of the sheet**, and — being a real `<motion.button>` with active pointer handlers (`CaddieOrb.tsx:162-199`) — it **intercepts taps** in its 54px circle. It is not the sheet clipping the orb; the sheet loses the stacking contest.

**Refinement A — where exactly the orb lands differs per page:**
- On `/round/new`, `isSetupCtaRoute` gives the orb `STICKY_CTA_CLEARANCE_PX = 92`, so it floats ~104px + safe-area above the bottom edge — i.e. over the **middle of the open sheet's content**: PlayerAutocomplete suggestion rows with right-aligned handicap badges, and the "this is me" button (`page.tsx:1506-1530`). This matches the designer report.
- On `/tournament/[id]/round/new`, neither `shouldShowTabBar` nor `isSetupCtaRoute` matches, so clearance is **0** — the orb sits at ~12px + safe-area, over the **bottom-right of the GamePicker sheet** (stake rows / Done area).

**Refinement B — the tournament sheet is game-picker-only.** `NewTournamentRoundClient.tsx` has one sheet gated on `showGamePicker` hosting only `GamePicker` (lines 1234-1316). The full picker set (player / game / tee / sides / holes) exists only on `/round/new`. Same stacking pattern, same fix; just a narrower sheet inventory.

**Also note:** because the orb is a *later DOM sibling* than all page content, it wins ties at `zIndex: 50` too. So the fix must land strictly **above 50**, not at 50.

## 2. Chosen fix: raise both backdrop+sheet pairs to 52/53

Change the two sheet pairs from 40/41 to **backdrop 52 / sheet 53**.

Why this over the alternatives:
- **(chosen) z-lift** — 4 numeric edits, matches the existing pattern (`LooperSheet` at 60/61 already sits above the orb by design; `CaddieOrb.tsx:82-86` even documents "the sheet covers the orb while open (z 61 vs 50)"). The full-screen backdrop (`inset: 0`) now covers the orb: it reads as dimmed page furniture behind the scrim and is non-interactive (taps in that region hit the backdrop, which closes the sheet — standard scrim behavior). No new state, no cross-component coupling, no motion.
- **(a) "modal open" signal to hide/dim the orb** — rejected. The orb is a global layout component; `picker` is local page state. This needs a new bus event or context channel plus wiring in two pages, adds branches to the orb's visibility logic (which carries the one-mic invariant), and introduces orb hide/show motion the quiet-yardage-book feel doesn't want. Disproportionate to the bug.
- **(b) sheet-bottom clearance / padding** — rejected. On `/round/new` the orb overlaps content ~104px up (mid-list rows), not just the sheet's bottom strip; padding per picker is brittle and does nothing about tap interception over the padded area on the tournament page.

**Z-landscape check (all verified by grep):** orb 50 < backdrop 52 < sheet 53 < LooperSheet/CaddieOrbSheet 60/61 (caddie sheet still wins) < ScanSheet 70 < RoundRecap 80. `VoiceRoundSetup` 50/51, `Voice.tsx` 50/51, `CourseSearch` 50, `VoiceRoundSetupRealtime` backdrop 50/sheet 60 — none co-open with these pickers (see §3), and 52/53 collides with nothing. `FloatingTabBar` (40) is hidden on both routes, so nothing depended on the old 40/41.

## 3. Edge cases

- **Narrow vs wide viewports.** The sheet is `maxWidth: 420; margin: 0 auto` but the **backdrop is `inset: 0` full-screen**. On phones <420px the sheet is full-width (orb region is inside the sheet footprint); on wider screens the orb (right: 16) sits outside the sheet but still under the full-screen backdrop at 52. Covered in both cases.
- **Orb halo.** The ambient glow is a `boxShadow` on the orb button (`CaddieOrb.tsx:215-220`), so it paints at the orb's stacking level (50) and is dimmed under the 52 backdrop along with the orb. No stray halo over the scrim.
- **VoiceRoundSetupRealtime coexistence (`/round/new`).** VRS (backdrop 50 / sheet 60, `VoiceRoundSetupRealtime.tsx:228,255`) opens only via the orb summon or post-voice flow; the picker opens via page field taps. They are mutually exclusive in practice. Even if both were somehow open, VRS sheet (60) > picker (53) > VRS backdrop (50) — the voice sheet still wins. No regression.
- **Sheet-open animation.** `AnimatePresence` exit/enter untouched; during the slide-in the backdrop is already at 52, so the orb is covered for the whole transition (no flash of orb-over-sheet).
- **Invariants untouched:** orb placement, `STICKY_CTA_CLEARANCE_PX`, tap/hold summon, one-mic rule, and the `/round/[id]` "Ask caddie" pill are not in the diff.

## 4. Scope: these two sheets only — three same-class ties found (do NOT fix here)

Confirmed **not** affected: `ScoreSheet` (40/50) and `Voice.tsx` (40/50/51) are used only in `RoundPageClient.tsx` (`/round/[id]`), where `shouldShowCaddieOrb` returns false.

Found and worth logging as follow-ups (all are **z=50 ties** the orb wins via DOM order — different failure class, none designer-flagged):
1. `/players` add/edit-player modal — `frontend/src/app/players/page.tsx:643` (`zIndex: 50`).
2. `CourseSearch` full-screen overlay — `frontend/src/components/CourseSearch.tsx:661` (`zIndex: 50`), used on `/courses`, `/tee-time`, and `/round/new`.
3. `VoiceRoundSetupRealtime` backdrop (`zIndex: 50`) — on viewports wider than 420px the orb sits outside the z60 sheet and above the tied backdrop.

Recommend: fix only the two picker sheets now (the reported bug); file the three ties as one backlog item ("audit z=50 ties vs CaddieOrb DOM-order win").

## 5. Exact changes

**File 1: `frontend/src/app/round/new/page.tsx`**
- Line 1168: `zIndex: 40,` → `zIndex: 52, // above CaddieOrb (50) so the scrim dims/blocks it; below LooperSheet (60)`
- Line 1181: `zIndex: 41,` → `zIndex: 53,`

**File 2: `frontend/src/app/tournament/[id]/round/new/NewTournamentRoundClient.tsx`**
- Line 1247: `zIndex: 40,` → `zIndex: 52, // above CaddieOrb (50) so the scrim dims/blocks it; below LooperSheet (60)`
- Line 1260: `zIndex: 41,` → `zIndex: 53,`

Comment style matches the existing documented-z convention (`tee-time/page.tsx:1735`). There is no shared z-token scale in `yardage/tokens.ts` (verified); do not introduce one for this fix.

## 6. Testing & gates

**Unit test: none — confirmed no real seam.** jsdom computes no stacking contexts; a vitest assertion would just re-read the inline literal. Precedent: the sibling fix `aeb388b` (PlayerAutocomplete in-flow) shipped with no unit test and visual verification. Existing `CaddieOrb.test.tsx` (visibility/summon) needs no changes.

**Gates (per CLAUDE.md, all must pass):**
1. `cd frontend && npm run lint`
2. `cd frontend && npx tsc --noEmit`
3. `cd frontend && npm run build`
4. `cd frontend && npx tsx voice-tests/runner.ts --smoke`

**Visual verification (required evidence):**
- `/round/new` → open the player picker → orb must be **behind the dimmed scrim**, "this is me" and suggestion-row handicap badges fully visible; tap where the orb sits → the sheet **closes** (backdrop tap), the caddie does **not** open.
- `/tournament/[id]/round/new` → open the game picker → same checks over the Done/stake area.
- `/round/new` at a wide viewport (e.g. 1024px): orb outside the sheet is still dimmed under the scrim.
- Regression: close the sheet → orb tap opens VRS, orb hold opens it listening.

**Risks:** minimal — numeric-only diff; the only behavior delta is intentional (orb dimmed/inert while a picker is open; taps there close the sheet). Nothing on these two routes lived at z 42-51 (verified).
