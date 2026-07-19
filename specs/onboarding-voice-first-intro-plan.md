# Plan — `onboarding-voice-first-intro` (Slice 6): the real "meet your caddie" voice moment

**Base:** `integration/next` @ `5ce4648` · **Spec lineage:** `specs/login-onboarding-redesign-plan.md` §3.2/§3.3/§4.2d, `specs/onboarding-shell-and-gate-plan.md` §2.13/§2.14, Slice-6 seam comments in `MeetCaddieStep.tsx` and `shouldShowCaddieOrb.ts`.

Produced by Plan(fable) 2026-07-19. This is a **staging of existing production behavior inside the onboarding shell** — one step component rewritten, zero new voice code paths, zero backend changes, zero shared-type changes.

> ENG-LEAD NOTE (divergence flag): the caller's task framing asked for the production orb "center-stage." The plan recommends approach **(A)** which keeps the orb in its real bottom-right production position (it is already on screen on `/onboarding`) rather than growing it to center. Rationale below (blast radius on the owner-crux orb + spatial-memory fidelity). This is a legitimate architecture call, but the **designer review is BLOCKING and must explicitly judge whether the moment lands without a center-stage orb** — if the designer insists on center-stage, that is a separately-scoped follow-up slice against `CaddieOrb`, flagged in the PR, not smuggled into this one.

---

## 1. The crux: orb position — decision = **(A) keep the real orb bottom-right; do not touch CaddieOrb**

**Recommendation: (A).** The intro screen is a serif invitation + example-ask hints composed toward the real production orb, which is already on screen bottom-right (verified: `shouldShowCaddieOrb.ts` `SHOW_EXACT` includes `'/onboarding'`; `CaddieOrb`/`CaddieOrbSheet` are mounted once in `app/layout.tsx:67-68`, outside any route). The `MeetCaddieStep` renders **no orb, no mic, no openLooper call of its own** — the user's own tap/hold on the real orb is the invocation, exactly as it will be on Home.

**Justification (fidelity vs. blast radius):**

- **The epic's center-stage vision (§3.2 54→96px grow, §3.3 "whole-screen at the voice moment") was written before Slice 4 shipped the orb in production position from the Name step onward.** §3.3's own core argument — *"in its exact production position, so spatial memory forms early"* — is better served by (A): the moment the user first talks to the caddie, the orb is exactly where it will live forever. Growing it to center for one screen and flying it back teaches a position that never exists again. The intro IS the tutorial; (A) makes the tutorial literally true.
- **Blast radius on an OWNER-CRUX shared component.** (B) would require: a position mode threaded into `CaddieOrb` (bus event or context flag), centered coordinates that only make sense inside the onboarding layout, rework of the chip/caption stack (the `OrbChip` column is `alignItems: 'flex-end'` anchored above a corner orb — a centered orb needs a different chip geometry), a cross-route center→corner animation on `router.replace('/')` (position state keyed on pathname inside a component whose fixed-position contract five other specs depend on: island clearance, sticky-CTA clearance, overlay suppression, hidden-while-docked cancel, z-50 ties), a reduced-motion appear-at-rest branch, and cleanup on skip/force-quit/nav-away. Every one of those is a regression vector on the omnipresent-orb crux, testable only with new harness work. (A) touches none of it.
- **Gesture identity is free under (A).** The hard constraint — user uses the EXACT production gestures (verified in `CaddieOrb.tsx`, post-inversion: idle **tap** → `openLooper({context, listening: true, presentation: 'docked'})` at line ~336; idle **hold ≥350ms** (`ORB_HOLD_MS`) → `openLooper({context, listening: false, presentation: 'full'})` at line ~309) — is trivially satisfied because it is the same button.
- **The land-on-home beat still lands.** The `INTRO_SEEN_KEY` "Your caddie moved here" chip is deferred while on `/onboarding` (`CaddieOrb.tsx` line ~178, `normalizePath(pathname) === '/onboarding'` early-return, same for the invert-reteach chip at ~208) and fires on the first Home render — that chip IS the handoff moment, unchanged because we don't touch the file.

The designer (BLOCKING) judges the composition either way; if they insist on center-stage, that is a new, separately-scoped slice against `CaddieOrb` — not something to smuggle into this one. Flag it in the PR notes.

---

## 2. Files to touch

| File | Change |
|---|---|
| `frontend/src/components/onboarding/MeetCaddieStep.tsx` | **The whole slice.** Rewrite the placeholder into the voice-moment composition (§3 below). Adds: serif invitation, 2–3 example-ask hints, quiet "Maybe later" affordance, a `hasSpoken` bool fed by a read-only `onCaddieOrbState` subscription (flip once on `'listening'`), and the completion CTA that appears after the first real interaction. Still receives `{busy, error, onContinue}`; **both** affordances call the same `onContinue`. |
| `frontend/e2e/onboarding.spec.ts` | Update the happy-path step (lines 145–150: `"Meet your caddie."` heading + `"Open your book"` click → new copy/skip affordance). Add two new tests: **skip path** and **mic-deny path** (§9). |
| `frontend/src/components/onboarding/OnboardingFlow.tsx` | **No logic change.** At most the `KICKER_FOR_STEP.intro` string if the designer wants it (currently `"ONE LAST THING"` — fine as a placeholder). `handleDone` (lines 266–278: `PUT {onboardingStep:'done'}` → `publishOnboardingStep(userId,'done')` → `router.replace('/')`) is passed as `onContinue` at line 351 and stays the **single** completion path. |

**NOT touched (verify in review):** `CaddieOrb.tsx`, `CaddieOrbSheet.tsx`, `looper-bus.ts`, `LooperSheet.tsx`, `useLooperDictation.ts`, `caddie-context.ts`, `shouldShowCaddieOrb.ts`, anything in `backend/` — and **no shared-type changes**: `frontend/src/lib/types.ts` / `backend/app/models.py` are untouched (the step writes nothing new; `onboardingStep:'done'` already exists from Slice 4).

The step's only new import surface: `onCaddieOrbState` (+ optionally `getCaddieOrbState`) from `@/lib/caddie-context` — existing, exported, read-only pub-sub (lines 141–166), the same channel `CaddieOrb` itself consumes. Zero new voice code.

---

## 3. The invitation composition (designer owns final copy; placeholders below; `T.*` tokens only)

Layout inside the step's existing `flex:1` column (kicker + tick strip come from `OnboardingFlow` as on every step):

- **Serif invitation** — existing exported `questionStyle` (serif italic 34px): placeholder **"Ask your caddie anything."** Sub-line in `subLabelStyle`: placeholder *"Tap the mark in the corner and just talk. It already knows your bag."*
- **2–3 example-ask hints** — quiet, static (NOT buttons — one standardized invocation means no second tappable ask-path), VoiceSheet-register: mono kicker `TRY` (`T.mono`, 8.5px, letterSpacing 1.8, `T.pencil`) over serif-italic lines in `T.inkSoft`, e.g.:
  - *"How far does my 7-iron go?"* ← the magic-moment ask; grounded in THEIR just-entered number (§4)
  - *"What should I work on as a 15?"*
  - *"Find me a tee time Saturday morning."*
- **"Maybe later"** — quiet from the first render: a plain text affordance (`T.sans` 13px `T.pencil`, or the existing `hairlinePillStyle` if the designer prefers a pill), never guilt-y, disabled while `busy`.
- **After the first real interaction** (`hasSpoken`: orb state hit `'listening'` at least once — the mic was actually hot), the completion beat appears: the `primaryPillStyle` pill, placeholder **"Open your book"** (continuity with the shipped placeholder + e2e). "Maybe later" can then quietly drop out (designer's call — both routes are the same `onContinue`). Gate this reveal's animation on `useReducedMotion` (fade/appear only).
- `errorLineStyle` error line above the CTAs, exactly as today (write-failure copy `SAVE_ERROR_COPY` is `OnboardingFlow`'s).
- **Composition constraint:** the lower-right corner must stay visually clear of the orb (fixed `right:16, bottom: calc(12px + safe-area)`, z-50; no tab-bar clearance on `/onboarding` since `shouldShowTabBar` excludes it). Keep the CTA block's right edge / bottom margin clear of that 54px footprint on 375px-wide screens — e.g. left-align "Maybe later" and give the CTA stack bottom clearance ≈70px so nothing sits under the orb.

---

## 4. Reaching the LIVE session + bag grounding (no new work — confirmed flowing)

- User **taps** the orb → `CaddieOrb` fires `openLooper({context: looperContextForPath('/onboarding'), listening: true, presentation: 'docked'})` — `looperContextForPath` resolves `/onboarding` to `'general'` (verified: only `/tee-time*` and exact `/courses` map elsewhere). No context is registered on `/onboarding`, so `CaddieOrbSheet`'s summon routing takes lane 3 (general), starts the one shared `useLooperDictation` instance, and publishes `listening` state/caption back to the orb. **Hold** → `{context:'general', listening: false, presentation:'full'}` → full sheet. Both are the production behaviors, untouched.
- On end-of-speech the docked session auto-sends (`onUtteranceEnd` → `handleMicTap`), promotes to the full sheet (`promoteToFull` before converse — promotion trigger a), and runs `runConverse` → `talkToCaddieStream` → fallback `talkToCaddie` — the production reply, `ConversationTurn`/persona/TTS pixel-identical.
- **Bag grounding (Slice 5, verified in commit `212bc27`):** `runConverse` sends no `club_distances`; the stateless `_build_voice_prompt` (shared by `/caddie/voice` and `/caddie/voice/stream`) now hydrates the stored `golfer_profiles.bag_clubs` server-side when the client sends none (own fail-open block), and injects `"Player's clubs: 7-iron: 160y, …"` into the CURRENT SITUATION block. The bag the user entered two steps ago was written via `saveGolferBagAsync` → `PUT /api/profile/golfer` → `bag_clubs` (`OnboardingFlow.handleBag`, `profile.py`). So "how far does my 7-iron go?" answers with **their** number with zero Slice-6 work. Skipped-bag users get the honest defaults path (also Slice 5). **Just confirm during build** (one manual ask on the dev stack); do not add code.

---

## 5. Mic-deny flow (production path confirmed; no new permission code)

Verified chain: `useLooperDictation.start()` catches `getUserMedia` failure and sets `micError = "Microphone access denied."` for `NotAllowedError` (lines 127–138, else `"Couldn't start the microphone."`); `CaddieOrbSheet` promotion trigger (b) (lines 244–246) promotes docked→full on `micError`, so the full sheet surfaces the error line + retry mic instead of a silently dead orb. The user closes the sheet (scrim tap / close button — `LooperSheetShell` `onClose`) and lands back on the step where **"Maybe later" is always present and enabled** → `onContinue` → done. Never a dead end. The only Slice-6 obligation is compositional: "Maybe later" exists from first render (it must not be gated on `hasSpoken`). No new permission code required — none is justified.

---

## 6. reduced-motion + small screens

- **`useReducedMotion`** in the step (the hook is already the shell's pattern): any hint stagger / CTA-reveal animation collapses to plain appearance. The orb's own reduced-motion behavior (static printed double ring while listening, no pulse) is production and untouched.
- **375×667 and 375×812:** step content is short (one question + 3 hint lines + CTA block) and lives inside `OnboardingFlow`'s bounded `height:100dvh / overflow:hidden` container — nothing scrolls, nothing can push CTAs off-screen (the Bag-step BLOCKING lesson). Do **not** use the placeholder's `marginTop: '18vh'` if it crowds 667px — prefer a smaller fixed top margin + `flex:1` spacer. Verify both sizes in the designer pass; keep the orb-corner clearance from §3.

---

## 7. Session lifecycle / no leakage into Home (named reviewer concern — verified against code)

- **Docked session live when the user completes/skips:** `handleDone` → `router.replace('/')` → pathname change → `CaddieOrbSheet`'s route-change hygiene effect (lines 315–324) sets `dockedExpectedStopRef` and `close()`s any docked session — mic released, orb reset to idle, caption cleared. Verified.
- **Full sheet open:** structurally cannot leak — the full sheet is a `position:fixed; inset:0` scrim (z-60) + sheet (z-61) over the entire step (verified `LooperSheet.tsx` lines 148/157–161), so the completion CTAs are unreachable until the user closes it. After close, `turns` only reset on the next closed→open summon (`resetSession`), which is the pre-existing, tested contract — no onboarding conversation ever re-greets onto Home.
- **`close()` hygiene** (lines 145–173) covers every path: cancels dictation, aborts streams, resets presentation, `setCaddieOrbState('idle')`, clears caption. The step adds nothing and must add nothing — in particular it must **not** invent a "close the sheet on unmount" call (no such bus event exists; the pathname hygiene is the designed mechanism).

---

## 8. Edge cases + risks

- **Blast radius on CaddieOrb: zero by construction** — the diff must show no change to `CaddieOrb.tsx`/`CaddieOrbSheet.tsx`/`looper-bus.ts`. That single fact discharges the owner-crux regression risk; reviewer should confirm it.
- **Permission race (tap during OS prompt):** the OS prompt suspends the page; on deny §5 runs; on grant the docked session proceeds. `start()`'s gen-guard already handles a cancel racing the grant. No work.
- **Double-completion:** both affordances disable on `busy` (`pillDisabledStyle` / `disabled`), and `handleDone` is idempotent server-side (PUT). A failed write shows `SAVE_ERROR_COPY` and stays put — same as every other step.
- **Force-quit mid-moment:** server holds `onboardingStep:'bag'` → relaunch resumes at `intro` (`initialSubStep`); no voice state persists anywhere. Nothing to do.
- **User navigates the sheet's tee-time/etc. content mid-onboarding:** the full sheet has no nav links; scrim-close returns to the step. Not reachable.
- **`hasSpoken` false-positive on deny:** flip only on orb state `'listening'` (mic actually hot), not `'connecting'` — a denied mic never reaches `'listening'`, so the completion pill never appears from a failed attempt (the "Maybe later" path serves it).
- **Chip deferral intact:** untouched `CaddieOrb` effects still skip both one-time chips on `/onboarding` and fire "Your caddie moved here" on first Home render — the handoff beat. E2E may assert it on the happy path if cheap; don't force it.

---

## 9. Gates (exact)

From `frontend/`:
1. `npm run lint`
2. `npx tsc --noEmit`
3. `npm run build`
4. `npx tsx voice-tests/runner.ts --smoke`
5. `npm run test:caddie-experience` (caddie-experience vitest config)
6. `npm run test:e2e` — `e2e/onboarding.spec.ts` updated/extended:
   - **Happy path** (existing test, lines 97–152): update the intro-step assertions to the new heading + completion affordance; keep the `PUT {onboardingStep:'done'}` + `/$` landing assertions verbatim.
   - **SKIP path (new):** reach the intro step → click "Maybe later" → `expect.poll(puts.at(-1)).toMatchObject({onboardingStep:'done'})` → lands on `/`.
   - **DENY path (new):** reach the intro step → tap the real orb (`getByRole('button', { name: /Talk to your caddie/ })` — its production `aria-label`) with mic permission ungranted (Playwright default → `getUserMedia` rejects `NotAllowedError`, no network needed) → expect the full sheet showing "Microphone access denied." → close the sheet → "Maybe later" still enabled → complete to `/`. (The live-audio interaction itself is not offline-e2e-able; it's covered by the voice-tests smoke + designer/manual pass.)
7. Backend untouched → `ruff check .` not required (run it only if review finds any accidental backend diff — there must be none).
8. Designer review (BLOCKING on this slice) + reviewer confirmation of the empty-diff claim in §8 bullet 1.

---

### Critical Files for Implementation
- `frontend/src/components/onboarding/MeetCaddieStep.tsx`
- `frontend/src/components/onboarding/OnboardingFlow.tsx`
- `frontend/src/components/CaddieOrb.tsx` (read-only contract — gestures, chip deferral, position; must not change)
- `frontend/src/components/CaddieOrbSheet.tsx` (read-only contract — summon routing, deny promotion, route-change close; must not change)
- `frontend/e2e/onboarding.spec.ts`
