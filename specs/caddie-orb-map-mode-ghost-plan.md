# Plan: Suppress the CaddieOrb while a full-screen overlay owns the screen (`caddie-orb-map-mode-ghost`)

**Branch:** `integration/next` · **Backlog:** `caddie-orb-map-mode-ghost` · **Scope:** 1 new pure
module + 1 new unit-test file + 2 component edits + 2 component-test additions. No backend change,
no shared-type change, no z-index change. Follow-up to commit `6ff2b0a`
(specs/caddie-orb-z50-ties-plan.md), which fixed TAP routing for opaque z50-tied overlays but
cannot fix this: out-stacking a TRANSPARENT overlay does not occlude what is under it.

---

## 0. Bug mechanics (verified in code)

- `CaddieOrb` renders `position: fixed; right: 16; zIndex: 50`
  (`frontend/src/components/CaddieOrb.tsx:121-123`), mounted globally in
  `frontend/src/app/layout.tsx:66`, visible wherever `shouldShowCaddieOrb(pathname)` allows —
  including `/tee-time`, `/courses`, `/round/new`
  (`frontend/src/components/nav/shouldShowCaddieOrb.ts:22-32,50`).
- `CourseSearch` is a full-screen `position: fixed; inset: 0; height: 100dvh; zIndex: 52` surface
  (`frontend/src/components/CourseSearch.tsx:651-670`), conditionally mounted on exactly those
  three routes. It has a `mode: "list" | "map"` state (`CourseSearch.tsx:398`).
- In MAP mode the outer frame sets `background: "transparent"` (`CourseSearch.tsx:667`) so the
  native `@capacitor/google-maps` view (rendered BEHIND the WebView; see
  `CourseScoutMap.tsx` header) shows through. Every opaque DOM pixel occludes the native map —
  so the opaque z50 orb, although UNDER the z52 frame for hit-testing (dead to taps), still
  PAINTS over the live map: a ghost button that is not the caddie in that context and reads as a
  second orb/mic on a surface that is not caddie-driven.
- Conclusion (eng-lead scoped, confirmed): z-index cannot fix this. The orb must be truly
  ABSENT (`return null`) while a full-screen overlay owns the screen, and return the instant it
  closes.

## 1. Design decisions

### 1.1 Trigger: register whenever CourseSearch is MOUNTED — not gated on map vs list mode. CONFIRMED CORRECT.

- In LIST mode the opaque paper frame (z52, `inset: 0`, `100dvh`) already fully covers and
  blocks the orb (post-`6ff2b0a`): the orb is invisible and unreachable there. "Covered" vs
  "absent" is pixel-identical to the user — suppressing in both modes changes nothing visually
  in list mode and removes a hidden live pointer target (defense in depth).
- Mode-gating would add churn for zero benefit: an effect keyed on `mode`, register/unregister
  notify traffic on every toggle, and a semantically muddier registry contract. Mount-gating
  keeps the contract simple and general: "a full-screen overlay owns the screen" — true in both
  modes.
- Bonus: mount-gating makes the mechanism fully web/sandbox-verifiable — DOM absence of the orb
  is assertable in list mode with no Google Maps key (the map-mode toggle doesn't even render
  without the key, `CourseSearch.tsx:67,792`). Map mode shares the identical code path.
- CourseSearch is the same component instance across mode toggles, so a mount/unmount effect
  fires exactly once per open/close. This mirrors the existing dictation mount effect idiom
  already in the file (`CourseSearch.tsx:463-473`).

### 1.2 Registry data structure: a module-level `Set<symbol>` of per-registration tokens

Why not reuse `caddie-context.ts`'s single slot: the slot is exclusive/last-writer-wins (right
for page contexts, wrong for overlays) — if two overlays ever stack, closing the top one must
KEEP suppression. A `Set` of unique tokens gives ref-counting with identity:

- Each `registerFullscreenOverlay()` call mints a fresh `Symbol()` token → StrictMode's dev
  double-invoke (register → unregister → register) just cycles tokens; final state is correct.
- The returned unregister closure deletes only ITS token; `Set.delete` of an absent token is a
  no-op → double-unregister is safe, and a stale unmount can never clobber a live overlay
  (same guarantee `registerCaddieContext` gives via object identity, `caddie-context.ts:109-118`).
- Listeners are notified ONLY when the boolean `size > 0` flips (mirrors `setCaddieOrbState`'s
  same-state dedup, `caddie-context.ts:143-147`) — subscribers never see stack-depth churn.

### 1.3 The orb read

`CaddieOrb` lazily initializes state from the getter (no SSR/first-paint flash; the module is
empty on the server so SSR HTML and first client render agree), subscribes in an effect, and
computes `visible = show && !overlayActive`. Both the early return (`CaddieOrb.tsx:111`) and the
one-time intro effect (`CaddieOrb.tsx:92-109`) switch from `show` to `visible` — the intro
effect MUST be re-keyed, otherwise it would run while the orb renders null (overlay open on a
SHOW route) and burn the one-time `looper.caddieOrbIntroSeen` flag for a caption that never
painted. Keyed on `visible`, the intro fires the first time the orb is ACTUALLY on screen; the
existing localStorage guard makes overlay open/close toggles afterwards a no-op.

### 1.4 CourseSearch wiring

One mount-scoped effect: `useEffect(() => registerFullscreenOverlay(), [])` — register returns
the unregister fn, which IS the effect cleanup. Verified all three hosts render CourseSearch
ONLY while open (never mounted-hidden):

- `frontend/src/app/tee-time/page.tsx:814-819` — `<AnimatePresence>{showCourseSearch && <CourseSearch/>}`
- `frontend/src/app/courses/page.tsx:524-530` — `{showSearch && <CourseSearch/>}` (no AnimatePresence wrapper)
- `frontend/src/app/round/new/page.tsx:1620-1637` — `<AnimatePresence>{showCourseSearch && <CourseSearch/>}`

AnimatePresence hosts keep CourseSearch mounted through its ~0.2s exit fade → unregister fires
when the fade completes → the orb reappears exactly as the overlay finishes leaving. On
`/courses` (no AnimatePresence) the orb returns instantly on close. Both are correct.

## 2. Exact changes

### 2.1 NEW `frontend/src/lib/fullscreen-overlay.ts` (pure, SSR-inert — sibling of caddie-context.ts)

```ts
// Full-screen overlay registry (specs/caddie-orb-map-mode-ghost-plan.md).
//
// A full-screen overlay that OWNS the screen (CourseSearch today) registers
// on mount / unregisters on unmount; the omnipresent CaddieOrb subscribes and
// renders NOTHING while ≥1 overlay is registered — truly absent, not merely
// out-stacked (a transparent map-mode overlay cannot occlude an opaque orb).
// Module-level Set + tiny subscription in the spirit of caddie-context.ts:
// pure (no window, no React), SSR-inert, unit-testable, no provider threading.
//
// Opt-in ONLY: normal scrimmed/opaque sheets that already stack above the orb
// (PlayerModal, VoiceRoundSetupRealtime's backdrop, the round/new and
// tournament picker scrims — all z52 per 6ff2b0a) must NOT register; the
// scrim-dims-the-orb behavior there is intentional.

const overlays = new Set<symbol>();
const listeners = new Set<(active: boolean) => void>();

function notifyIfFlipped(before: boolean): void {
  const after = overlays.size > 0;
  if (after === before) return;
  for (const cb of listeners) cb(after);
}

/**
 * Register a full-screen overlay. Returns the unregister fn. Each call mints
 * a unique token, so a StrictMode double-register just stacks two tokens, and
 * a stale or duplicate unregister (Set.delete of an absent token) is a no-op
 * that can never clobber a live overlay.
 */
export function registerFullscreenOverlay(): () => void {
  const token = Symbol("fullscreen-overlay");
  const before = overlays.size > 0;
  overlays.add(token);
  notifyIfFlipped(before);
  return () => {
    const before = overlays.size > 0;
    overlays.delete(token);
    notifyIfFlipped(before);
  };
}

/** True while ≥1 full-screen overlay is registered. */
export function isFullscreenOverlayActive(): boolean {
  return overlays.size > 0;
}

/** Subscribe to active-flag FLIPS (never per-registration churn). Returns the unsubscribe. */
export function onFullscreenOverlayChange(cb: (active: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
```

### 2.2 `frontend/src/components/CaddieOrb.tsx`

1. Add import: `import { isFullscreenOverlayActive, onFullscreenOverlayChange } from '@/lib/fullscreen-overlay';`
2. After the `clearance` block (below line 73), add:
   ```ts
   // Full-screen overlay suppression (specs/caddie-orb-map-mode-ghost-plan.md):
   // while a registered overlay owns the screen the orb is truly ABSENT — a
   // transparent overlay (CourseSearch map mode) cannot occlude it, so
   // out-stacking is not enough. Lazy-initialized from the getter so there is
   // no first-paint flash if an overlay is already live when the orb mounts.
   const [overlayActive, setOverlayActive] = useState(isFullscreenOverlayActive);
   useEffect(() => onFullscreenOverlayChange(setOverlayActive), []);
   const visible = show && !overlayActive;
   ```
3. Intro effect (lines 92-109): change guard `if (!show) return;` → `if (!visible) return;`
   and deps `[show]` → `[visible]` (see §1.3 — protects the one-time intro flag).
4. Early return (line 111): `if (!show) return null;` → `if (!visible) return null;`
5. Header comment (lines 3-14): add one line noting the orb suppresses itself while a
   full-screen overlay is registered (fullscreen-overlay.ts), pointing at this spec.

Untouched on purpose: the `confirming` subscription (line 88) keeps running while suppressed —
setState on a null-rendering component is harmless, and no task-apply path exists while
CourseSearch is open. Pointer handlers, clearance, z-index, and summon (`openLooper`) are
byte-identical.

### 2.3 `frontend/src/components/CourseSearch.tsx`

1. Add import: `import { registerFullscreenOverlay } from "@/lib/fullscreen-overlay";`
2. Add one mount-scoped effect next to the existing unmount-abort effect (after line 569):
   ```ts
   // Full-screen overlay registration (specs/caddie-orb-map-mode-ghost-plan.md):
   // this surface owns the screen in BOTH modes (opaque paper in list,
   // transparent-over-native-map in map), so the omnipresent CaddieOrb
   // suppresses itself while we're mounted. Mount-scoped, NOT mode-scoped —
   // registered once per open, unregistered on close (register returns the
   // unregister fn, which is this effect's cleanup).
   useEffect(() => registerFullscreenOverlay(), []);
   ```
3. Amend the stale z comment at line 662 (`// above CaddieOrb (50) so the full-screen surface
   covers it; below LooperSheet (60)`) to note the orb now suppresses itself entirely while this
   surface is mounted (z52 stays: still needed above the tab bar (40), page scrims (40), and
   below LooperSheet (60)).

### 2.4 No other production changes

`PlayerModal` (`app/players/page.tsx:644`), `VoiceRoundSetupRealtime` backdrop
(`VoiceRoundSetupRealtime.tsx:229`), and the picker scrims (`app/round/new/page.tsx:1168`,
`NewTournamentRoundClient.tsx:1247`) do NOT register — do not touch them.

## 3. Invariant analysis — [[omnipresent-caddie-orb]] (the owner's #1 crux)

**(a) Omnipresence holds.** The registry is opt-in and this change wires exactly ONE registrant:
CourseSearch (grep-verifiable: `registerFullscreenOverlay` appears only in
fullscreen-overlay.ts, CourseSearch.tsx, and tests). Unregister is the useEffect cleanup —
React guarantees it runs on unmount, including unmounts through error boundaries; all three
hosts unmount CourseSearch on every close path (`onClose`, course selection, route push away
from the page). A hard crash reloads the WebView, which resets module state. Therefore: the
instant CourseSearch closes, `size` drops to 0, the flip notifies, and the orb re-renders on
every `shouldShowCaddieOrb` page — no path leaves suppression stuck on. No visibility rule
changed: `shouldShowCaddieOrb.ts` is untouched; on every page without a registered overlay the
orb renders exactly as today.

**(b) One-mic / orb identity holds.** While suppressed there is ZERO orb — no ghost over the
map, no hidden live pointer target under the list. Nothing is lost: CourseSearch is not
caddie-driven; its own header mic (built-in dictation on `/tee-time`+`/courses`, VRS handoff on
`/round/new`, `CourseSearch.tsx:767-787`) is the one voice affordance on that surface, and the
orb was already unreachable (list: covered; map: dead under the z52 frame). The ONE orb = ONE
caddie invocation identity is strengthened: the orb never again appears as a non-functional
second control.

**(c) No regression to shipped fixes or summon.** All z values are unchanged — the `6ff2b0a`
lifts (CourseSearch 52, PlayerModal 52, VRS backdrop 52) and the picker-scrim convention stand;
those non-registering overlays still dim/cover the orb exactly as before. The registry never
touches `looper-bus`: orb tap/long-press → `openLooper` behavior on normal pages is
byte-identical (existing CaddieOrb.test.tsx pointer tests must still pass unmodified). The orb's
`/courses` summon path (surface context opens CourseSearch with `autoVoice`) now correctly
retires the orb while the summoned surface is up.

## 4. Tests

### 4.1 NEW `frontend/src/lib/fullscreen-overlay.test.ts` (pure vitest, node env — mirror caddie-context.test.ts)

1. Fresh module state → `isFullscreenOverlayActive()` is `false`.
2. register → `true`; unregister → `false`.
3. Two registrations (A, B): unregister A → still `true` (superseded/stale unregister cannot
   clobber a live overlay); unregister B → `false`.
4. Double-unregister robustness: calling A's unregister twice is a no-op; sequence
   A-reg, A-unreg, B-reg, A-unreg-again → still `true`.
5. Subscription: callback fires ONLY on flips with the boolean (0→1 `true`, second concurrent
   register fires nothing, last unregister fires `false`); unsubscribe stops delivery.
Every test must leave the registry empty (call every unregister it minted) — module state
persists across tests, same discipline as caddie-context.test.ts.

### 4.2 `frontend/src/components/CaddieOrb.test.tsx` additions (reuse existing mocks/fake-timer harness)

- Suppression: render → orb present; `act(() => { unreg = registerFullscreenOverlay(); })` →
  `queryByLabelText("Talk to your caddie")` is null; `act(unreg)` → present again.
- Intro-flag protection: register overlay BEFORE render, empty localStorage → orb absent AND
  `looper.caddieOrbIntroSeen` NOT set; `act(unreg)` + advance timers → orb present, caption
  "Your caddie moved here" appears, flag now set.
- `afterEach` must unregister any leftover token (module state leaks across tests otherwise).

### 4.3 `frontend/src/components/CourseSearch.test.tsx` addition (existing hermetic mocks)

- Mount → `isFullscreenOverlayActive()` `true`; toggle to map mode (reuse the file's existing
  maps-key/map-mode harness) → STILL `true` (mount-scoped, not mode-scoped); `unmount()` →
  `false`.

## 5. Gates / verification

Commands (all must pass):
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm test` (vitest — includes §4)
- `cd frontend && npm run build`
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`
- `cd backend && ruff check .` — CONFIRMED no backend change (frontend-only, module + 2
  components); this gate is a trivial pass.

Behavioral verification:
- **Sandbox/web-verifiable (fully covers the mechanism):** because the trigger is mount-gated
  (§1.1), DOM absence in list mode exercises the identical code path map mode uses. Dev server
  or Playwright (`frontend/e2e`, currently auth-only — a spec here is optional): on `/courses`
  open search → assert `[aria-label="Talk to your caddie"]` absent from the DOM; close →
  present. Repeat on `/tee-time` (Add course) and `/round/new` (course field). Assert orb
  present + summon works on `/`, `/players`, `/tee-time` with no overlay; open PlayerModal on
  `/players` → orb still MOUNTED (covered by the z52 scrim, unchanged behavior — it must NOT
  vanish).
- **iOS sim / device only (like B2, partially sandbox-verifiable):** with a real
  `NEXT_PUBLIC_GOOGLE_MAPS_KEY`, open CourseSearch → toggle MAP → live native map with NO ghost
  orb anywhere; toggle back to list; close → orb returns (entry spring) bottom-right.

Shared types: CONFIRMED no `frontend/src/**/types.ts` or `backend/**/models.py` change — the
new module's API is self-contained.

## 6. Edge cases & risks

- **Exit fade:** AnimatePresence hosts (`/tee-time`, `/round/new`) unregister ~200ms after
  close (when the fade completes) — desired sequencing; `/courses` unregisters instantly. Never
  a frame where the orb overlaps a fully-visible overlay.
- **StrictMode (dev):** double-invoked effect cycles register→unregister→register; token Set +
  flip-deduped notify makes the end state correct; not present in prod builds.
- **Orb re-entry animation:** the `initial={{ scale: 0.85, opacity: 0 }}` spring replays on
  every reappearance — quiet and consistent with first mount; no new motion added.
- **Over-suppression:** the only risk vector is a future component registering when it
  shouldn't — the module header comment explicitly forbids scrimmed/partial sheets from
  registering.
- **Intro caption:** re-keying on `visible` means an overlay open at the orb's would-be first
  showing DEFERS (not burns) the intro — it fires on first actual paint (§1.3, tested §4.2).
- Stale prose elsewhere (`app/tee-time/page.tsx:1735` "under CourseSearch (50)") predates this
  change — out of scope, do not touch.

## 7. NORTHSTAR consistency

Quiet, voice-first, yardage-book: the orb is the ONE standardized voice invocation — this
change removes the only place it degraded into a dead second-orb artifact. No new chrome, no
new motion, no new design language; the element is simply absent while a surface it cannot
serve owns the screen, and back the instant that surface closes.

## 8. Files to touch

| File | Change |
|---|---|
| `frontend/src/lib/fullscreen-overlay.ts` | NEW — registry module (§2.1) |
| `frontend/src/lib/fullscreen-overlay.test.ts` | NEW — pure unit tests (§4.1) |
| `frontend/src/components/CaddieOrb.tsx` | subscribe + `visible` gate + intro re-key (§2.2) |
| `frontend/src/components/CourseSearch.tsx` | mount-scoped register effect + comment (§2.3) |
| `frontend/src/components/CaddieOrb.test.tsx` | suppression + intro-flag tests (§4.2) |
| `frontend/src/components/CourseSearch.test.tsx` | registration-lifecycle test (§4.3) |
