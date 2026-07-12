# Universal edge-swipe-back — implementation plan

Owner request (verbatim intent): "On every single page you should be able to swipe to go
back. For the yardage book that is going back to previous hole which already works. But
for example if I go to tee time from the home page, swiping back should take me there."

Feature: iOS-native-style **left-screen-edge swipe → router history back** on ALL pages,
EXCEPT the in-round yardage-book page (`/round/[id]` and `/round/view`) where horizontal
swipe already means prev/next hole, and `/map/course` where the full-screen native map
owns the edge and the page has its own back button (`handleBack`, map/course/page.tsx:691).

Northstar fit: calm, native, no janky animation — threshold-only trigger with a light
haptic, no follow-the-finger chrome. Reuses the existing route-predicate pattern
(`shouldShowTabBar.ts` siblings), the proven swipe thresholds from RoundPageClient, and
`haptic('light')` from `lib/haptics.ts`. No new dependencies. Client-only — no
`types.ts`/`models.py` change.

---

## 1. Mechanism decision: JS edge detector (chosen), native gesture (rejected)

**Chosen: a JS left-edge touch detector mounted once globally.**

**Rejected: WKWebView `allowsBackForwardNavigationGestures = true`** (a one-line native
AppDelegate change). Reasons, in order:

1. **Unreliable with pushState/App Router.** The app is a static export
   (`output:'export'`) served as a single document at `https://localhost`; ALL navigation
   is client-side `next/navigation` pushState. The native gesture drives WKWebView's own
   back-forward list with an interactive *snapshot* transition; for same-document
   pushState entries it renders a stale screenshot, then fires `popstate`, which the Next
   App Router handles asynchronously — the visible result is a screenshot-then-jump
   artifact, not a clean transition, and on some entries the snapshot is blank.
2. **No per-route exclusion.** The native gesture is webview-global. It would hijack the
   in-round hole swipe (rightward hole-prev collides directly with rightward back) and
   left-edge map panning on `/map/course`. Capacitor ships no plugin to toggle it per
   page; we'd have to write a custom native plugin + JS bridge — far more surface than a
   JS detector.
3. **Native build friction.** It requires an Xcode/native change and a new TestFlight
   binary; the JS detector ships in the web bundle, is unit-testable in Vitest, and is
   fully route-aware.

No Capacitor plugin in the app provides gestures. Raw `touchstart/touchend` listeners —
the exact pattern already proven for the hole swipe in `RoundPageClient.tsx` (~L1802-1819)
— are sufficient. **No new dependency.**

## 2. Files to create / touch

| File | Action |
|---|---|
| `frontend/src/components/nav/backSwipeGesture.ts` | NEW — pure gesture core (constants + decision functions) |
| `frontend/src/components/nav/shouldEnableBackSwipe.ts` | NEW — pure route predicate |
| `frontend/src/components/nav/BackSwipe.tsx` | NEW — thin `"use client"` wiring component |
| `frontend/src/components/nav/backSwipeGesture.test.ts` | NEW — Vitest (node env) |
| `frontend/src/components/nav/shouldEnableBackSwipe.test.ts` | NEW — Vitest (node env) |
| `frontend/src/app/layout.tsx` | EDIT — mount `<BackSwipe />` beside `<FloatingTabBar />` |
| `frontend/src/components/SwipeableRow.tsx` | EDIT — edge-zone pointer-capture guard (§7) |
| `frontend/src/components/CaddieOrbSheet.tsx`, `CaddieSheet.tsx`, `VoiceRoundSetupRealtime.tsx` | EDIT — add `data-no-backswipe` to the sheet root element (§7) |

## 3. Mount point

Mount `<BackSwipe />` in `frontend/src/app/layout.tsx` inside `<AuthProvider>` next to the
other once-mounted global client widgets:

```tsx
<AuthProvider>
  {children}
  <FloatingTabBar />
  <CaddieOrb />
  <CaddieOrbSheet />
  <BackSwipe />
</AuthProvider>
```

`BackSwipe.tsx` is `"use client"` (layout.tsx stays a server component — same pattern as
FloatingTabBar/CaddieOrb). It renders **null** — it only attaches listeners.

## 4. Event wiring (inside BackSwipe.tsx — keep it THIN)

- Attach `touchstart`, `touchmove`, `touchend`, `touchcancel` on `document` with
  `{ capture: true, passive: true }`, in a single `useEffect` mounted once (empty dep
  array; read live values through refs).
- **Touch events, not pointer events**, deliberately:
  - framer-motion drags (SwipeableRow, round paper fallback, sheets) run on *pointer*
    events and use pointer capture; touch listeners observe the same finger without ever
    being retargeted or stopped by framer's capture/stopPropagation.
  - It mirrors the proven RoundPageClient hole-swipe implementation (raw touch + capture
    guards).
  - Capture phase guarantees we see the event even where inner code stops propagation
    (e.g. RoundPageClient's `onPointerDownCapture` stopPropagation trick — different
    event type anyway, but capture makes it unconditional).
- **`passive: true` always** — the detector NEVER calls `preventDefault()`. It is
  threshold-only (no follow-the-finger), so native scrolling stays untouched and no
  `touch-action` CSS changes are needed anywhere.
- Safe area: `viewportFit: "cover"` is set (layout.tsx viewport export), so
  `env(safe-area-inset-left)` resolves. Read it once per `touchstart` via a memoized
  helper: create (once, lazily) a detached probe div with
  `style.paddingLeft = 'env(safe-area-inset-left)'` appended invisibly to body, read
  `getComputedStyle(...).paddingLeft`, parse px, cache; portrait iPhone = 0, landscape
  notch side ≈ 59px. Pass the number into the pure functions — the pure core never
  touches the DOM.
- Per-event handlers do only:
  - `touchstart`: bail unless `e.touches.length === 1`; bail if
    `!shouldEnableBackSwipe(pathnameRef.current)`; bail if
    `(e.target as HTMLElement | null)?.closest?.('[data-no-backswipe]')`; bail if within
    the 350 ms refire lockout (§6); else record
    `{ startX, startY, t: Date.now() }` in a ref **iff**
    `isEdgeStart(startX, safeAreaLeft)`.
  - `touchmove`: if tracking and `e.touches.length !== 1` → cancel (pinch). If tracking
    and the move sample is disqualifying per `isDisqualified(...)` (vertical-dominant
    early exit, §5) → cancel.
  - `touchend`: if tracking, run `decideBackSwipe(...)` with the changed touch; on
    `'back'` → re-check `shouldEnableBackSwipe(pathnameRef.current)` (route may have
    changed mid-gesture), then `haptic('light')` + navigate (§6). Always clear tracking.
  - `touchcancel`: clear tracking.
- `pathnameRef` is kept current from `usePathname()` in an effect; `router` from
  `useRouter()`.

## 5. Gesture state machine — pure core (`backSwipeGesture.ts`)

Constants (exported):

```ts
export const EDGE_ZONE_PX = 24;          // left-edge start zone (beyond safe-area inset)
export const MIN_DX_PX = 70;             // matches the proven hole-swipe distance
export const HORIZONTAL_DOMINANCE = 1.8; // |dx| > 1.8 * |dy| — matches hole swipe
export const FLICK_MS = 600;             // matches hole swipe time box
export const LONG_DRAG_FRACTION = 0.35;  // slow deliberate drag: ≥35% of viewport width
export const REFIRE_LOCKOUT_MS = 350;    // min gap between two triggered backs
```

Pure functions (exported, no DOM access):

```ts
export function isEdgeStart(startX: number, safeAreaLeft: number): boolean;
// startX <= safeAreaLeft + EDGE_ZONE_PX

export interface BackSwipeSample {
  startX: number; startY: number;
  endX: number;   endY: number;
  elapsedMs: number;
  viewportWidth: number;
  safeAreaLeft: number;
}

export type BackSwipeDecision = 'back' | 'ignore';

export function decideBackSwipe(s: BackSwipeSample): BackSwipeDecision;
// 'back' iff ALL of:
//   isEdgeStart(s.startX, s.safeAreaLeft)
//   dx = endX - startX > 0                          (rightward ONLY)
//   |dx| > HORIZONTAL_DOMINANCE * |dy|              (decisively horizontal)
//   AND ( (elapsedMs < FLICK_MS && dx >= MIN_DX_PX)               // fast flick
//         || dx >= LONG_DRAG_FRACTION * viewportWidth )           // slow deliberate drag
// else 'ignore'

export function isDisqualified(startX: number, startY: number,
                               curX: number, curY: number): boolean;
// mid-gesture early cancel: |dy| > 30 && |dy| > |dx|  (vertical scroll from the edge)
```

Disqualifiers, summarized: started outside the edge zone; leftward; vertical-dominant
(early via `isDisqualified`, final via the dominance ratio); multi-touch/pinch at any
point; too short and too slow (fails both the flick and the long-drag arm).

**Visual affordance decision: none (threshold-only + haptic).** A faithful iOS
follow-the-finger transition needs a live snapshot of the previous page, which a SPA
cannot render honestly — any approximation (sliding the current page, an arrow chevron)
is exactly the janky chrome NORTHSTAR forbids. The hole swipe users already know is also
threshold-only-with-a-page-turn; here even the page-turn is skipped — the router
transition itself is the feedback, plus `haptic('light')` at the moment of commitment.
Trigger evaluates on `touchend` (release), so a user can cancel by dragging back — same
cancellability contract as the native gesture.

## 6. Back semantics + no-history fallback

- Navigation: `router.back()` from `next/navigation`.
- **No-history detection — session navigation-depth counter** (this is a single-document
  static export; `window.history.length` is a dead end: it counts the initial document,
  never decrements on back, and inflates on push-after-back, so it cannot distinguish
  "something in-app to go back to" from "first page"). Instead, inside BackSwipe:
  - `depthRef = useRef(0)`, `poppedRef = useRef(false)`, `firstPathSeenRef`.
  - `popstate` listener (window, passive) sets `poppedRef.current = true`.
  - Effect on `usePathname()` change (skip the very first run): if `poppedRef.current`
    → `depthRef.current = Math.max(0, depthRef.current - 1); poppedRef.current = false;`
    else `depthRef.current += 1`.
  - This counts client-side pushes since app boot. Capacitor always cold-boots the shell
    at the exported entry document (see `lib/round-url.ts` header comment — dynamic
    deep links hard-navigate to the root shell), so depth 0 reliably means "nothing
    in-app behind this page".
- On a committed swipe:
  - `depthRef.current > 0` → `haptic('light'); router.back();`
  - `depthRef.current === 0 && normalizePath(pathname) !== '/'` →
    `haptic('light'); router.push('/');` — a deep-linked/orphan page goes home instead of
    a dead gesture or popping out of the app.
  - `depthRef.current === 0 && pathname === '/'` → ignore silently (no haptic — nothing
    to promise).
  - A back-swipe therefore **never** exits the app.
- **Refire lockout:** record `lastFiredRef = Date.now()` on any committed navigation;
  `touchstart` ignores new gestures for `REFIRE_LOCKOUT_MS` (350 ms). This prevents a
  rapid double-swipe from popping two entries before the first transition settles, and
  covers the route-transition race (§9).
- Known accepted limitation (document in a code comment): a *forward* traversal also
  fires `popstate` and would decrement the counter. The app has no forward affordance
  (no forward button, and iOS forward gesture is native-only which we don't enable), so
  in practice this doesn't occur; worst case the fallback is `router.push('/')` — safe.

## 7. Route exclusion predicate (`shouldEnableBackSwipe.ts`)

Sibling of `shouldShowTabBar.ts` / `shouldShowCaddieOrb.ts`, same normalization, same
`/round/new` carve-out shape as `shouldShowCaddieOrb` (which already documents why
`/round/new` is not the in-round page):

```ts
// Route gate for the global left-edge back-swipe (specs/universal-swipe-back-plan.md).
// Sibling of shouldShowTabBar.ts — same trailing-slash normalization.
import { normalizePath } from './shouldShowTabBar';

export function shouldEnableBackSwipe(pathname: string): boolean {
  if (!pathname) return false;
  const p = normalizePath(pathname);

  // /round/new is SETUP (no hole swipe) — back-swipe ON. Must be checked before
  // the broader /round/ prefix rule (same carve-out as shouldShowCaddieOrb).
  if (p === '/round/new') return true;

  // The in-round yardage book: horizontal swipe = prev/next hole there. Covers
  // BOTH deep-link forms — /round/<uuid> and /round/view (?id= carried in the
  // query; pathname is what we match — see lib/round-url.ts).
  if (p.startsWith('/round/')) return false;

  // Full-screen native map owns the left edge for panning and already has its
  // own back button (map/course/page.tsx handleBack → router.back()).
  if (p === '/map/course') return false;

  return true;
}
```

Decisions recorded:
- **`/round/new` INCLUDED** — it is a setup form, not the yardage book; edge-swipe back
  to home is exactly the expected iOS behavior there. (Its bottom sheet gets the
  `data-no-backswipe` opt-out like the others, so a swipe while the voice sheet is open
  doesn't navigate underneath it.)
- **`/map/course` EXCLUDED** — left-edge touches pan the native Google map; the page has
  a dedicated back control.
- Tournament pages (`/tournament/view`, `/tournament/new`) INCLUDED — tabs are tap-only;
  the standings table is protected by edge-zone gating (§8).

## 8. Conflict-avoidance audit (why each surface is safe)

Primary defense everywhere: the gesture only ARMS when the touch **starts** within
`safeAreaLeft + 24px` of the left screen edge, must be **rightward**, **decisively
horizontal** (1.8×), and either fast (<600 ms, ≥70 px) or very long (≥35% vw). The
detector is passive/observe-only — it never blocks or retargets anyone else's events.

| Surface | Why safe | Extra action |
|---|---|---|
| In-round hole swipe (`RoundPageClient.tsx` map card ~L1785-1819 + paper framer `drag="x"` ~L2023) | Route excluded outright — detector disarms on `/round/<uuid>` AND `/round/view` | none |
| `/map/course` native map pan (`CourseScoutMap`) | Route excluded | none |
| **SwipeableRow swipe-to-delete** (`components/SwipeableRow.tsx`; home list `app/page.tsx` ~L717, players page) | HIGHEST-RISK: same rightward direction, and its 100 px reveal overlaps our 70 px flick — a fast edge flick over a row could BOTH navigate back AND visually drag the row / open its confirm. Edge gating alone is not enough because rows can extend under the 24 px zone. | **Claim the edge zone for back-swipe**: in `SwipeableRow.tsx`, add on the draggable `motion.div`: `onPointerDownCapture={(e) => { if (isEdgeStart(e.clientX, readSafeAreaLeft())) e.stopPropagation(); }}` — capture fires before framer's own (bubble-registered) pointerdown on the same node, so framer never starts a drag for edge-zone touches. This is the exact trick RoundPageClient already uses (~L1795-1801) to keep framer off map touches. Import `isEdgeStart` (+ export a small `readSafeAreaLeft()` from `backSwipeGesture`'s DOM-adjacent sibling — put `readSafeAreaLeft()` in `backSwipeGesture.ts` as the ONE impure, guarded (`typeof document !== 'undefined'`) helper, memoized). Result: edge-start → back-swipe only (row never moves); start ≥24 px in → row drag only (fails `isEdgeStart`, detector never arms). No double-trigger in either direction. |
| Tee-time window slider (`app/tee-time/WindowCard.tsx` L87-111) | Track sits inside page + card padding (>24 px from the screen edge); handle drags are slow (>600 ms) and would need ≥35% vw net-rightward from *inside the edge zone* to hit the long-drag arm — geometrically it can't arm because the start is outside the zone | none |
| SVG hole diagram pan/zoom (`components/course/HoleDiagram.tsx`) | Pinch = multi-touch → disqualified; one-finger pan starting at the extreme left edge that is fast, rightward, and horizontal triggers back — which IS the iOS-native contract (edge belongs to back everywhere) | none |
| `GoogleSatelliteMap` (in-round) | Route excluded | none |
| CaddieOrb press-vs-drift (`components/CaddieOrb.tsx`) | Docked bottom-RIGHT — never in the left edge zone | none |
| Bottom sheets (`CaddieOrbSheet.tsx`, `CaddieSheet.tsx`, `VoiceRoundSetupRealtime.tsx`) drag-to-dismiss | Vertical → dominance ratio rejects. BUT a genuine horizontal edge-swipe while a sheet is open would navigate the page *underneath* the still-open sheet (sheets are layout-level overlays, not routes) — confusing | Add `data-no-backswipe` to each sheet's root/backdrop element; the detector's `touchstart` bails when `e.target.closest('[data-no-backswipe]')` matches. Also add it to SwipeableRow's fixed confirm-dialog backdrop. This attribute is the standing escape hatch for any future surface. |
| `overflowX:auto` tables (`TournamentPageClient.tsx` ~L897 standings, `ScoreSheet.tsx`, `GameResults.tsx`) | Scroll containers sit inside page padding, outside the 24 px zone; a rightward swipe on a table also means "scroll left" only when already scrolled (rare at rest) | If manual testing shows any table actually reaching the raw screen edge, put `data-no-backswipe` on that scroll container — one attribute, no logic change |

## 9. Risks / edge cases (handled in design)

- **Pathname changes mid-gesture** (e.g. a voice action navigates while a finger is
  down): predicate is checked BOTH at `touchstart` (arm) and again at `touchend` (fire).
  If the route became excluded mid-gesture, the swipe is dropped.
- **Gesture during a route transition / rapid repeated swipes**: 350 ms refire lockout
  after any committed navigation; depth counter updates via the pathname effect, so a
  second swipe after lockout sees the settled depth.
- **Sheets open**: `data-no-backswipe` opt-out (§8) — no navigation under an open sheet.
- **iOS rubber-band/overscroll**: vertical rubber-banding fails the 1.8× horizontal
  dominance test and the `touchmove` early disqualifier; there is no horizontal page
  overscroll (pages don't scroll horizontally).
- **Landscape notch**: edge zone is `safeAreaLeft + 24px`; safe area read per-gesture, so
  rotation mid-session is handled.
- **First page / deep link**: depth counter → `router.push('/')` fallback; never exits
  the app; silent no-op only when already at `/`.
- **SSR/build**: BackSwipe renders null and touches `document` only inside `useEffect`;
  `readSafeAreaLeft()` guards `typeof document`. Static export unaffected.

## 10. Test seams (Vitest — node env, matching `vitest.config.ts` defaults)

1. `frontend/src/components/nav/shouldEnableBackSwipe.test.ts` — style-match
   `shouldShowTabBar.test.ts`:
   - true: `/`, `/tee-time`, `/courses`, `/players/abc`, `/profile`, `/settings`,
     `/tournament/view`, `/tournament/new`, `/round/new`, `/round/new/` (trailing slash)
   - false: `/round/view`, `/round/view/`, `/round/8b1f…uuid`, `/map/course`,
     `/map/course/`, empty string
2. `frontend/src/components/nav/backSwipeGesture.test.ts`:
   - `isEdgeStart`: 0/12/24 → true at safeArea 0; 25 → false; safeArea 59 → 80 true, 84 false
   - `decideBackSwipe` 'back': fast flick (dx 80, dy 10, 300 ms); long slow drag
     (dx 0.4×vw, 1500 ms); exactly-at-threshold boundaries (dx 70 @ 599 ms)
   - `decideBackSwipe` 'ignore': leftward (dx −80); vertical-dominant (dx 80, dy 60);
     start outside zone (startX 40); short+slow (dx 71 @ 900 ms with vw such that
     0.35×vw > 71); zero movement
   - `isDisqualified`: dy 40/dx 10 → true; dy 20/dx 5 → false (under 30); dy 50/dx 80 → false
3. (Wiring stays thin enough that a jsdom component test adds little; if the builder adds
   one, mirror `FloatingTabBar.test.tsx`'s next/navigation mocking and assert only that
   BackSwipe renders null and attaches/detaches document listeners.)

## 11. Implementation order

1. `backSwipeGesture.ts` (pure core + `readSafeAreaLeft`) → its test.
2. `shouldEnableBackSwipe.ts` → its test.
3. `BackSwipe.tsx` wiring (refs, listeners, depth counter, lockout, haptic, router).
4. Mount in `layout.tsx`.
5. `SwipeableRow.tsx` edge-zone `onPointerDownCapture` guard.
6. `data-no-backswipe` on the three sheet roots + SwipeableRow confirm backdrop.
7. Gates + simulator verification.

## 12. Gates

Automated (all from `frontend/`):
- `npm run lint`
- `npx tsc --noEmit`
- `npx vitest run` (new tests + existing suite green)
- `npm run build` (static export must succeed — BackSwipe is SSR-null-safe)
- `npx tsx voice-tests/runner.ts --smoke`

iOS simulator manual verification (Capacitor build):
1. Home → tap into Tee time → left-edge swipe right → back on Home (haptic fires).
   Repeat Home → round history detail → back.
2. Open an in-round page (`/round/view?id=…`): edge swipe still does **hole prev**, never
   app-back; `/map/course`: edge drag pans the map, no back.
3. On Home, slow-drag a round row (SwipeableRow) starting ~40 px in → delete reveal works,
   no navigation; then flick from the raw edge over the same row → navigates back, row
   never visibly drags. Also: open the caddie sheet, edge-swipe → nothing navigates.

**Needs the owner's real-device pass** (state honestly in the PR): gesture *feel* —
whether 24 px zone / 70 px / 600 ms feel right under a thumb on real glass, haptic timing,
and landscape-notch edge behavior. Simulator verifies logic, not feel; thresholds are
constants in one file so tuning is a one-line change.

## 13. Shared-types / deps check

- Client-only UI: **no** `frontend/src/lib/types.ts` ↔ `backend/app/models.py` change.
- **No new dependency**: raw touch events + existing `framer-motion` (untouched) +
  existing `@capacitor/haptics` via `lib/haptics.ts`.
