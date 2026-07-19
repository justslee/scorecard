# Slice 7 plan — `login-onboarding-epic-polish-review` (epic-closing polish / edge sweep / cleanup)

Base: `integration/next` @ `3109c39`. Repo root `/Users/justinlee/projects/scorecard`. Backend is
**untouched** except running its lint gate — `clerk_auth.py` / `webhooks.py` / migrations out of bounds.
Security-review, designer pass, and QA are run by other agents; §7 lists the gates only.

Produced by Plan(fable) 2026-07-19. This is the builder's contract.

---

## 1. Ribbon-joints geometry fix (hero corridor) — `frontend/src/components/yardage/HoleIllustration.tsx`

### 1.1 Problem, precisely
`fairwayRibbon(pts, widthStart, widthEnd)` (line 66) offsets each centerline point along the
chord-normal (perpendicular of `prev→next`) and joins the offset boundary points with straight `L`
segments. The centerline (`smoothPath`, line 52) joins the same interior points with `Q` quadratics
through segment midpoints (`Q p_i mid(p_i, p_{i+1})` … `T last`). Result: at HOLES[3]'s two dogleg
vertices the corridor edges show angular mitered corners while the ink line between them curves.

### 1.2 Contract constraints (verified)
- `fairwayRibbon` is **module-private** (not exported). Exactly two call sites, both in this file:
  - hero (line 255–256): `fairwayRibbon(scaledPath, scale(0.18), scale(0.11))` — only when `isHero`.
  - interactive (line 257): `fairwayRibbon(scaledPath)` — the byte-identical contract pinned by the
    comment at lines 248–254 and by `HoleIllustration.test.tsx` ("interactive DOM stays byte-identical").
- **Verdict on gating:** an unconditional algorithm change WOULD alter the interactive `d` string
  (`L` → `Q` joins), violating the contract even though it's visually a sub-pixel hairline. Therefore
  the change **must be gated by a new trailing parameter whose default preserves the legacy string
  byte-for-byte.** Only the hero call opts in.

### 1.3 Exact change
Add a 4th parameter and a helper. The offset loop and the miter branch are **character-for-character
untouched**:

```ts
function fairwayRibbon(
  pts: Array<[number, number]>,
  widthStart = 0.18,
  widthEnd = 0.11,
  join: "miter" | "smooth" = "miter",
) {
  if (pts.length < 2) return "";
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    // ...UNCHANGED offset loop (lines 70–82): chord-normal (px,py),
    // per-point taper w = widthStart*(1-t) + widthEnd*t, left = +w, right = -w
  }
  if (join === "miter") {
    return (
      // ...UNCHANGED current string construction (lines 83–89) — byte-identical
    );
  }
  // "smooth": join the SAME offset points with the SAME quadratic-through-
  // midpoints grammar the centerline (smoothPath) uses, so both corridor
  // edges curve exactly like the ink line between them.
  const revRight = [...right].reverse();
  return (
    `M ${left[0][0]} ${left[0][1]}` +
    smoothJoinSegments(left) +
    ` L ${revRight[0][0]} ${revRight[0][1]}` +   // far (green-end) cap — straight, as today
    smoothJoinSegments(revRight) +
    " Z"                                          // tee-end cap closes straight, as today
  );
}

/** Segment commands (no leading M) through pts, using smoothPath's exact
 *  grammar: Q(control = interior point, end = midpoint of next pair), then
 *  T to the final point. 2 points → a single straight L (degenerate holes). */
function smoothJoinSegments(pts: Array<[number, number]>): string {
  if (pts.length === 2) return ` L ${pts[1][0]} ${pts[1][1]}`;
  let d = "";
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` T ${last[0]} ${last[1]}`;
  return d;
}
```

Hero call site becomes:
```ts
const ribbonD = isHero
  ? fairwayRibbon(scaledPath, scale(0.18), scale(0.11), "smooth")
  : fairwayRibbon(scaledPath);
```

### 1.4 Correctness argument (the rigor items)
- **Taper preserved:** the offset arrays (`left`/`right`) are computed by the unchanged loop —
  per-point interpolated width is identical; only the join commands between the same points change.
- **Normal consistency around corners:** unchanged. The chord-normal `(-dy, dx)/len` from `prev→next`
  rotates continuously along the ordered point list, so left/right never swap sides at a dogleg.
- **No new self-intersection at sharp doglegs:** each `Q` curve lies inside the convex hull of its
  control triangle `{mid_before, corner-offset-point, mid_after}` (Bézier hull property). The smoothed
  boundary is contained within the region already swept by the current mitered polyline — smoothing can
  only cut corners inward, never overshoot outward, so it cannot introduce a self-intersection the
  mitered version didn't have. The mitered hero corridor is visually verified clean for HOLES[3]
  (Slices 2/3), and the hull argument extends to all `HOLES[]` if the hero hole ever rotates.
- **Corner apex width:** both edges cut their corners with the identical grammar the centerline uses,
  so the corridor narrows/widens at the apex exactly in sympathy with the ink line.
- **`T` semantics:** a `T` only ever follows a `Q` emitted by the same `smoothJoinSegments` call (for
  `len ≥ 3` the string starts with `Q`; for `len == 2` it's a lone `L`), so the reflected-control rule
  always has a real prior control point. The cap `L` is never directly followed by `T`.
- **Degenerates:** 2-point paths (straight par 3s) → all-`L` fallback, shape unchanged.
  `pts.length < 2` → `""` unchanged.
- **Caps:** both remain straight chords (far cap `L`, near cap `Z`), exactly today's hero look — cap
  styling is explicitly out of scope.

### 1.5 Tests — `frontend/src/components/yardage/HoleIllustration.test.tsx` (non-brittle strategy)
Ribbon selector: `path[fill="#c8d6a8"]` (unique in both variants).

1. **Interactive byte-identical (brittleness is the point here):** assert the interactive ribbon `d`
   for `holeNumber={4}` equals the pinned legacy string — captured from the current code (deterministic
   pure float arithmetic; Plan computed it against HEAD):
   `M 50.166323029835944 93.93117667730927 L 38.15577510078077 65.01669018936937 L 56.12978895577782 38.03053857783007 L 50.106715675015984 13.973321081246006 L 49.893284324984016 14.026678918753998 L 55.870211044222195 37.96946142216993 L 37.84422489921923 64.98330981063063 L 49.833676970164056 94.06882332269073 Z`
   Builder discipline: add this test **before** touching `fairwayRibbon` (it must pass on HEAD), then
   refactor — the test proves byte-identity across the change. Also assert `!d.includes("Q")`.
   (If the exact float string differs on this machine, capture the real HEAD output first and pin THAT
   — the point is byte-identity across the refactor, not the specific digits.)
2. **Hero structural (deliberately loose — no coordinate snapshot):** for `variant="hero"` (both with
   and without `playIntro`), assert the ribbon `d`: starts with `"M "`, `d.includes(" Q ")`, exactly
   one cap `L` (`d.split(" L ").length === 2`), ends with `"Z"`, and `!d.includes("NaN")`. Pins "edges
   are curved, one straight cap, closed" without freezing floats.
3. **Degenerate hero:** `holeNumber={3}` (HOLES[2], 2-point straight path), `variant="hero"`: `d`
   contains no `Q`, no `NaN`, ends `Z` — pins the `L` fallback.
4. Existing counts (interactive `<g>`=4/`<path>`=3, hero path counts) are unaffected.

---

## 2. Wash-ease nit — **TRIVIAL → include**

Inspection: the six fill fades in `VARIANTS` (`rough`, `centerline`, `ribbon`, `hazard`, `green`,
`label` — lines 130–186) all use `T.ease = [0.22, 1, 0.36, 1]` (strongly front-loaded — the "pop-y on
large fills" note). `teeDot`/`flag` are springs (untouched). One-constant swap; reduced-motion is
unaffected because the static path renders via `initial={false}` (no transitions run) and the
interactive branch never activates variants.

Changes:
1. `frontend/src/components/yardage/tokens.ts` — add under `// Motion`:
   ```ts
   // Symmetric wash for the hero intro's large fill fades — T.ease is
   // front-loaded and reads pop-y on big fills (Slice-3 designer note).
   // easeInOutSine.
   wash: [0.37, 0, 0.63, 1] as [number, number, number, number],
   ```
2. `HoleIllustration.tsx` `VARIANTS`: swap `ease: T.ease` → `ease: T.wash` in `rough`, `centerline`,
   `ribbon`, `hazard`, `green`, `label`, **and in `penStroke`'s `opacity` sub-transition only** (the
   pen-lift fade crossfades against `centerline`'s fade-in on the same 0.3s window — the pair must
   share one curve or the line visibly dips mid-crossfade). `penStroke.pathLength` keeps `T.ease`.
3. Do **not** touch `SignInScreen.tsx`'s `INTRO_HEADER/SHEET/WORDMARK` eases.

---

## 3. Dead prebuilt-widget / appearance-config cleanup

Proof greps (run at HEAD, verified during planning):
```
grep -rn "AuthButtons" frontend/src frontend/e2e
  → only frontend/src/components/AuthButtons.tsx itself. Zero importers.
grep -rn "<SignIn\b\|<SignUp\b\|<UserButton\|<UserProfile\|<Show\b" frontend/src
  → only AuthButtons.tsx (dead) + historical comments.
grep -rn "clerkAppearance" frontend/src
  → only AuthProvider.tsx (definition line 17 + prop line 209).
```

Decisions:
1. **DELETE `frontend/src/components/AuthButtons.tsx`.** Dead file — zero importers.
2. **DELETE the `clerkAppearance` object (AuthProvider.tsx lines 13–33) and the
   `appearance={clerkAppearance}` prop (line 209).** `appearance` themes prebuilt Clerk UI only. After
   (1), the only Clerk-rendered element anywhere is `AuthenticateWithRedirectCallback` in
   `sso-callback/page.tsx` — a headless control component (renders no themed DOM). One-line comment
   touch-up at AuthProvider lines 205–207; KEEP the v1.0.365 history block (lines 42–76).
3. **KEEP (with reason):** `NativeAuthDiag.tsx` + `SignInClient`/`SignUpClient` wiring (owner on-device
   validation); `sso-callback/page.tsx`, `lib/auth-spike/*`, `dev/auth-spike/*` (spike-gated, flip-time
   reference); `settings/page.tsx` `useClerk()` headless signOut.
4. **NEVER touch** `backend/`.

Verification: full `tsc`/lint/build; `e2e/auth.spec.ts` has no reference to AuthButtons.

---

## 4. Edge-sweep audit — classification (fix only real defects)

Verify-only edges (with citations): interrupted mid-onboarding (awaited PUT + `initialSubStep` resume,
e2e-proven); interrupted mid-sign-in (in-memory by design, resend fresh code); back-nav sign-in
(`flow.back()` guarded); back-nav onboarding (forward-only by design, back-swipe already disabled on
`/onboarding`); keyboard avoidance email (`useFocusScrollIntoView`); keyboard avoidance name/handicap
(top-half inputs, no occlusion portrait — QA device check); iPad landscape/portrait (fluid, ≥768pt);
deep-link mid-onboarding (AuthGate redirect both directions, e2e-covered); OAuth-cancel (OAuth
live-disabled this slice — flip-time item); offline first launch / offline sign-in (static hero +
`isOffline()` pre-check, e2e-covered).

**Code-touching fixes:**
- **F1 — auth stall (real dead-spinner).** `guarded()` in `useAuthFlow.ts`: a **hung** FAPI request
  leaves `busy=true` forever with "One moment…" AND `back()` no-ops while busy — user trapped. Fix:
  race `fn()` against a 15s timer in `guarded` (sentinel `class StallError {}`; on timeout patch
  `error = STALL_COPY = "Still no answer — check your connection and try again."`; `finally` clears
  timer + busy). Late resolution benign (late `step:"done"` truthful; late error patch replaces stall
  copy). No credentials in copy/logs. Tests in `useAuthFlow.test.ts` with `vi.useFakeTimers`.
- **F2 — onboarding write stall.** `fetchAPI` (`lib/api.ts`) has no timeout; a hung PUT pins `busy`
  forever. Fix: add pure `withStallTimeout<T>(p, ms = 15_000)` to
  `frontend/src/components/onboarding/steps.ts` + wrap every awaited write in `OnboardingFlow.tsx`
  (`updateGolferProfile` in all four handlers, `saveGolferBagAsync` in handleBag). Existing catch shows
  `SAVE_ERROR_COPY` — zero new copy. Late PUT idempotent. Unit test in `steps.test.ts` (fake timers).
- **F3 — sign-out clean-slate one-liner.** Most of the clean slate is already correct (centralized
  `ClerkTokenBridge` Keychain clear; per-user namespaced onboarding cache `storageKey()`; `useMe`
  returns `'unknown'` on user mismatch, identity.ts:271 — do NOT add per-site clears). **One real
  leak:** `hydrateGolferProfile`'s account-switch re-anchor (identity.ts ~166–168) resets
  `userId`+`step` but **retains the previous user's `profile` object** → `NameStep` prefills the
  PREVIOUS user's name until the GET resolves. Fix: re-anchor with `profile: null` (e.g.
  `setOnboardingSnapshot(userId, readCachedOnboardingStep(), { persist: false, profile: null })` —
  verify the actual `identity.ts` function name/signature before editing; the point is: clear the
  retained profile on account switch). Note in PR for the security reviewer.
- **F4 — back-swipe on auth routes.** Layout's `BackSwipe` mounts on `/sign-in`/`/sign-up` (AuthGate
  passes auth routes through); swipe → `router.back()` into a gated route → AuthGate bounce = pointless
  flash (same class the `/onboarding` exclusion documents). Add to
  `frontend/src/components/nav/shouldEnableBackSwipe.ts`: return false for `/sign-in`, `/sign-in/*`,
  `/sign-up`, `/sign-up/*`, `/sso-callback`. New cases in `shouldEnableBackSwipe.test.ts`.
- **F5 — iPhone portrait lock (owner-visible, app-wide → FLAG in PR).** `frontend/ios/App/App/Info.plist`
  `UISupportedInterfaceOrientations` includes LandscapeLeft/Right; in landscape (~375pt height)
  `OnboardingFlow`'s `height:100dvh; overflow:hidden` clips the Continue pill — genuinely broken.
  Fix: remove the two landscape entries from the **iPhone** array (portrait-only), matching Northstar
  "mobile-first, one-handed". Do **not** touch `UISupportedInterfaceOrientations~ipad`. This is
  app-wide + NOTICEABLE — the PR description MUST flag it to the owner explicitly and QA must confirm
  no existing screen depended on iPhone landscape.

---

## 5. Google/Apple flip-readiness checklist — content to append to `specs/login-onboarding-redesign-plan.md`

The builder appends this verbatim as a new section `## 10. Google/Apple flip-readiness checklist
(owner runbook)`; no other edits to the epic plan file.

### A. Clerk Dashboard / provider consoles (owner — `auth-clerk-enable-social-connections`)
1. Clerk Dashboard → Configure → SSO connections → enable **Google**, with **custom production OAuth
   credentials** (Google Cloud web client for Clerk; plus an **iOS client ID** for the native plugin).
2. Enable **Apple**: Apple Developer portal — Sign in with Apple capability on the App ID, Services ID +
   key, pasted into the Clerk Apple connection.
3. Confirm **Native Applications** is still enabled (`authdiag` shows `native_api_disabled` if not).

### B. App-side flip PR (small; the only code work)
**Already handled — no change at flip:** native FAPI hooks + Keychain (`AuthProvider.tsx`,
`native-token-store.ts`); centralized sign-out Keychain clear (`ClerkTokenBridge.tsx` observer); nonce
generation + claim check (`lib/auth-spike/`, unit-proven); plugin pinned
`@capgo/capacitor-social-login@8.3.35`; enumeration-safe error copy (`useAuthFlow.authErrorCopy`);
JWT-parity harness (`lib/auth-spike/jwt-parity.ts`); `NativeAuthDiag`.
**Still stubbed — the flip PR does:**
1. Wire `OAuthButtons.tsx` handlers — web: `signIn.sso(...)`; native: `SocialLogin.login()` →
   `clerk.authenticateWithGoogleOneTap({token})` / `signIn.create({strategy:'oauth_token_apple',token})`.
   Set `OAUTH_LIVE = true`; drop the "coming online shortly" caption. Apple stays first (App Store 4.8).
2. Ungate `/sso-callback` — live-by-default; add it to `AUTH_PREFIXES` in `AuthGate.tsx`.
3. Env: `NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_IOS_SERVER_CLIENT_ID` (**must equal the
   audience the Clerk Google connection expects** — epic risk #1), `NEXT_PUBLIC_APPLE_CLIENT_ID`.
4. Xcode: add the Sign in with Apple capability + entitlement.
5. Update `SignInScreen.test.tsx` + `e2e/auth.spec.ts` for enabled buttons.

### C. LIVE verification after flip (in order)
1. **JWT parity (§7 gate 1):** email-code (baseline), Google web, Google native, Apple native; decode
   each session JWT; `iss` + `azp` + claim shape identical; unchanged backend verifies each.
2. **Native bridge (§7 gate 2):** `authdiag` `native-sent:true`, token persisted, cold-start restore.
3. **Sign-out (§7 gate 3):** headless `signOut()` → `ClerkTokenBridge` observer clears the Keychain —
   verify the entry is gone (never add per-site clears).
4. **Credential no-log (§7 gate 4):** `node scripts/assert-no-credential-log.mjs` — covers the plugin's
   raw ID token surface.
5. **Fallback safety (§7 gate 5):** system-browser redirect fallback stays **not shippable** until a
   Universal-Link callback exists — ID-token path only.
6. **OAuth-cancel edge:** cancel the native sheet → calm return to method step, no error dialog, no
   orphan `golfer_profiles` row.
7. Re-run Playwright auth e2e; `/security-review` on the flip PR (new raw-ID-token surface).

---

## 6. Gates (exact commands; last three run by other agents)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx vitest run src/components/yardage/HoleIllustration.test.tsx \
  src/components/auth/useAuthFlow.test.ts src/components/auth/SignInScreen.test.tsx \
  src/components/onboarding/steps.test.ts \
  src/components/nav/shouldEnableBackSwipe.test.ts
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && node scripts/assert-no-credential-log.mjs && node scripts/assert-no-auth-bypass.mjs
cd backend && ruff check .
cd frontend && npm run test:e2e        # auth.spec + onboarding.spec; Tier-2 self-skips w/o CLERK_SECRET_KEY
```
Run by others: epic-wide `/security-review` (reviewer; incl. Slice-5 caddie-payload ride-along),
designer pass (hero ribbon + wash + portrait lock), QA device matrix + E2E CI wiring verification.

## 7. Explicit non-goals
No backend changes; no cap restyling; no onboarding back button; no keyboard-scroll rework
(`overflow:hidden` stands unless QA fails it); no OAuth enabling (that's the §5 flip PR); no removal of
spike files / `NativeAuthDiag` / `sso-callback`; no `SignInScreen` ease changes.

## 8. Epic retro note (filled at close)
_To be appended when the epic completes: what shipped vs the original plan._
