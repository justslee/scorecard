# `login-screen-visual` — Slice 2 Implementation Plan (CONTRACT)

**Epic:** `specs/login-onboarding-redesign-plan.md` (§3.2, §3.4, §5, §6, §4.2 step 2)
**Spike ground truth:** `specs/auth-headless-spike-verdict.md` (§3 exact calls, §5 Future-API split, §9 eng-lead addendum)
**Status:** PLAN — hand to builder. Static visual only. The self-drawing hero animation is
Slice 3 (`login-animation-moment`) — DO NOT build any pathLength/self-drawing animation here.

## 0. Scope in one sentence

Replace the prebuilt Clerk `<SignIn>`/`<SignUp>` widgets with the designed custom headless
login screen — yardage-book hero (signature hole rendered COMPLETE and STATIC) + hairline
paper sheet with Apple/Google (rendered, live-disabled) and a fully live email
(code-primary, password-secondary) flow — on by default, no flag. Backend zero-delta.
Auth logic = the spike's proven Future-API call sequences, verbatim, behind a clean state
machine. No data-model change (`onboarding_step` is Slice 4).

## 1. File list

### New
| File | Purpose |
|---|---|
| `frontend/src/components/auth/useAuthFlow.ts` | Headless state machine over `useSignIn`/`useSignUp` (Future API); exports `useAuthFlow(intent)` + `authErrorCopy(code)` mapping. UI-free, fully unit-testable. |
| `frontend/src/components/auth/SignInScreen.tsx` | The visual screen (§3 below): hero + wordmark + sheet + steps. Dumb renderer over `useAuthFlow`. Props: `{ intent: "signIn" | "signUp" }`. |
| `frontend/src/components/auth/OAuthButtons.tsx` | Apple (primary ink pill) + Google (hairline pill), rendered but live-DISABLED with honest mono caption. Local `const OAUTH_LIVE = false` so the future flip is one line. No handlers wired this slice. |
| `frontend/src/components/auth/useAuthFlow.test.ts` | Vitest: mock `@clerk/react` (pattern: `ClerkTokenBridge.test.tsx`); prove every transition, both pivots, the error mapping, busy re-entrancy guard, resend cooldown. |
| `frontend/src/components/auth/SignInScreen.test.tsx` | Render smoke: kicker text `Your yardage book` present (e2e contract), Apple/Google `aria-disabled`, email pill enabled, zero prebuilt-Clerk DOM. |

### Modified
| File | Change |
|---|---|
| `frontend/src/app/sign-in/[[...sign-in]]/SignInClient.tsx` | REPLACE internals: delete `dynamic(<SignIn>)`; keep the file, keep `dynamic(..., {ssr:false})` pattern, keep `<NativeAuthDiag/>`. Now: static paper shell + masthead as the dynamic `loading` placeholder → `SignInScreen intent="signIn"`. |
| `frontend/src/app/sign-up/[[...sign-up]]/SignUpClient.tsx` | Same replacement; `SignInScreen intent="signUp"`. Deletes the `<SignUp>` widget. |
| `frontend/src/components/yardage/HoleIllustration.tsx` | Additive prop `variant?: "interactive" | "hero"` (default `"interactive"` — zero delta for all existing call sites). See §4. |
| `frontend/scripts/assert-no-credential-log.mjs` | Add `"src/components/auth"` to `SCAN_ROOTS` (today it scans ONLY auth-spike paths + AuthProvider/ClerkTokenBridge — confirmed by reading it; without this the gate would NOT cover the new UI). Also the recorded Slice-2 nitpick: broaden `LOGGING_CALL` to `\b(console\.\w+|setAuthDiag|append)\s*\(` (verified: current `append(` call-sites in scanned files produce 0 violations). |
| `frontend/src/lib/auth-spike/no-credential-log.test.ts` | Cover the new scan root + the broadened `append` detection (positive + negative fixture). |
| `frontend/e2e/auth.spec.ts` | Drive the NEW screen (§6). |
| `frontend/package.json` + `package-lock.json` (recorded nitpick, optional but assigned to this slice) | Tighten `@capgo/capacitor-social-login` `^8.3.35` → `8.3.35`. SURGICAL edit of the range strings only — never delete/regen the lockfile; Linux CI is the authoritative check (epic §9 lockfile lesson). |

### Deleted
None. (The prebuilt-widget usage is deleted *inside* the two Client files. Verify with
`grep -rn "m.SignIn\b\|m.SignUp\b" frontend/src/app` → no matches.)

### Explicitly UNTOUCHED (assert zero diff at review)
`frontend/src/components/AuthGate.tsx` (all four existing render states preserved; the
onboarding 4th state is Slice 4), `AuthProvider.tsx`, `ClerkTokenBridge.tsx`,
`frontend/src/lib/auth-spike/**` (except the no-credential-log test), `spike-flag.ts`,
`frontend/src/app/sso-callback/page.tsx`, `frontend/src/app/dev/auth-spike/page.tsx`,
`frontend/scripts/assert-no-auth-bypass.mjs`, `frontend/src/lib/types.ts`,
`backend/**` (zero-delta — check `git diff backend/` is empty), `AuthButtons.tsx`
(uses `UserButton`, not `<SignIn>`/`<SignUp>` — out of scope).

## 2. `useAuthFlow.ts` — state machine (the exact contract)

Built on the **Future API as primary** (spike verdict §5 — confirmed, load-bearing:
`@clerk/react@6.11.1`'s `useSignIn`/`useSignUp` ARE the signal-based Future API). The
classic surface (`useClerk().client.signIn` / `authenticateWithGoogleOneTap`) is needed
ONLY for native Apple/Google ID-token — which is DISABLED this slice, so `useAuthFlow`
contains **no classic calls** (OAuthButtons carries a comment pointing at
`AuthSpikePanel.tsx` §3.3/§3.4 for the future wiring).

```ts
type Intent      = "signIn" | "signUp";   // seeded from route; toggleable in-screen
type EmailMethod = "code" | "password";   // default "code"
type FlowOwner   = "signIn" | "signUp";   // which Clerk resource owns the pending code
type Step        = "method" | "email" | "code" | "done";

state = {
  step: Step;               // "method" initial
  intent: Intent;
  emailMethod: EmailMethod;
  emailAddress: string;
  flowOwner: FlowOwner | null;
  busy: boolean;            // re-entrancy guard: every action no-ops while true
  error: string | null;     // ALREADY-MAPPED uniform copy — never a raw Clerk message
  resendAvailableAt: number | null;  // Date.now()+30_000 after each send
}
```

Every Clerk call below is verbatim from the PROVEN `AuthSpikePanel.tsx`. The Future API
**returns** errors (`const { error } = await ...`) — handle the returned error; ALSO wrap
each action in try/catch for thrown transport errors (offline) → offline copy.

**Transitions (exact calls):**

- `chooseEmail()` — `method → email`.
- `submitPassword(email, pw)` (`emailMethod === "password"`, sets `busy`):
  - intent `signIn`:
    1. `const {error} = await signIn.password({ emailAddress, password })` → error: map, stay `email`.
    2. `const {error} = await signIn.finalize()` → error: map. OK → `done`.
  - intent `signUp`:
    1. `const {error} = await signUp.password({ emailAddress, password })`
       — if `error.code === "form_identifier_exists"`: **silent pivot** → run the
       `signIn.password` sequence above with the same credentials (succeeds = user just
       signs in; fails = uniform "don't match" copy → zero enumeration leak).
       Other errors: map, stay `email`.
    2. OK → `const {error} = await signUp.verifications.sendEmailCode()` → error: map.
       OK → `flowOwner = "signUp"`, `step = "code"` (password sign-up still verifies email — spike-proven sequence).
- `sendCode(email)` (`emailMethod === "code"`, sets `busy`) — the **combined,
  non-enumerating flow**; user sees the identical "code sent" step either way:
  - intent `signIn`:
    1. `const {error} = await signIn.emailCode.sendCode({ emailAddress })`
    2. `error.code === "form_identifier_not_found"` → **silent pivot**:
       `await signUp.create({ emailAddress })` → error: map; OK →
       `await signUp.verifications.sendEmailCode()` → `flowOwner = "signUp"`.
    3. else error → map; OK → `flowOwner = "signIn"`.
    4. → `step = "code"`, start 30s resend cooldown.
  - intent `signUp`:
    1. `const {error} = await signUp.create({ emailAddress })`
    2. `error.code === "form_identifier_exists"` → **silent pivot**:
       `await signIn.emailCode.sendCode({ emailAddress })` → `flowOwner = "signIn"`.
    3. else OK → `await signUp.verifications.sendEmailCode()` → `flowOwner = "signUp"`.
    4. → `step = "code"`, cooldown.
- `verifyCode(code)` (sets `busy`):
  - `flowOwner === "signIn"`: `signIn.emailCode.verifyCode({ code })` → error: map, stay
    `code`; OK → `signIn.finalize()` → error: map; OK → `done`.
  - `flowOwner === "signUp"`: `signUp.verifications.verifyEmailCode({ code })` → map;
    OK → `signUp.finalize()` → map; OK → `done`.
- `resendCode()` — only when cooldown elapsed; re-runs the send for the current
  `flowOwner`; resets cooldown. (Politeness guard against `too_many_requests`; never an
  automatic client retry loop.)
- `back()` — `code → email` (clear error, keep email), `email → method` (clear error).
- `toggleIntent()` / `toggleEmailMethod()` — flips, clears error.
- On `done`: nothing else to do when mounted inline from `AuthGate` (`isSignedIn` flips →
  gate re-renders children). For direct `/sign-in`·`/sign-up` visits, `SignInScreen` has
  one effect: `if (isSignedIn) router.replace("/")`.

**Hard rules:** no `console.*` anywhere in `components/auth/` (the scanner now covers it);
state stores only mapped copy + optionally the Clerk `code` string (for tests) — NEVER
`error.message`/`longMessage`, never the password/code/token; no token reads
(`getToken()` does not appear in this directory — tokens live in clerk-js/Keychain
bridge); no `signOut()` calls (sign-out invariant untouched, stays centralized in
`ClerkTokenBridge`).

## 3. `SignInScreen.tsx` — composition spec (builder + designer contract, epic §3.2)

Full-bleed column, `minHeight: 100dvh` (dvh precedent: `CourseSearch.tsx`),
`background: PAPER_NOISE, T.paper` + `backgroundBlendMode: "multiply"`, `overflowY: auto`.
No card chrome anywhere. All values from `yardage/tokens.ts` — no new design language.

**HERO — top ~62% (`height: 62dvh`, `position: relative`, `pointerEvents: none`):**
- Top-right, safe-area-top padded, mono annotation: `NO 4 · PAR 5 · 548 YDS · HCP 1`
  (T.mono, 8.5px, letterSpacing 1.8, uppercase, T.pencil).
- Centered: `<HoleIllustration holeNumber={4} variant="hero" showDetail accent={T.accent}
  size={min(viewportWidth - 48, heroHeight - 96)} />` — HOLES[3] = the 548yd hcp-1 par-5
  dogleg, rendered COMPLETE and STATIC. No animation of any kind (Slice 3's surface).
- Bottom-left (24px pad): wordmark `Looper.` — T.serif italic, 52px, letterSpacing −1,
  T.ink, lineHeight 1; beneath it the mono kicker with LITERAL source text
  `Your yardage book` (CSS `textTransform: uppercase`, 8.5px, ls 1.8, T.pencil).
  **This exact text is the Playwright Tier-1 contract — do not reword.**

**SHEET — bottom ~38% (flex-grow):** `background: T.paper`, `borderTop: 1px solid
T.hairline`, `borderRadius: "20px 20px 0 0"` (echoes `LooperSheet.tsx:165`), padding
`20px 24px max(24px, env(safe-area-inset-bottom))`. Steps swap inside it:

- **step `method`** (all pills: height 56, `borderRadius: 999` — never the 4px SaaS radius; full width, T.sans 15px, 44pt+ touch targets):
  1. **Apple (primary even while disabled, per §3.2/HIG):** ink-filled — bg T.ink, color
     T.paper, inline Apple-logo SVG glyph + "Continue with Apple". DISABLED: `disabled` +
     `aria-disabled="true"`, no onClick, opacity 0.5, cursor default, no press state.
  2. **Google:** hairline pill — transparent bg, `1px solid T.hairline`, T.ink text,
     Google "G" glyph. Disabled identically.
  3. Honest mono caption centered under the pair: `APPLE & GOOGLE COMING ONLINE SHORTLY`
     (T.mono 9px, ls 1.5, T.pencil). Lights up when `auth-clerk-enable-social-connections` lands.
  4. Divider: hairline — mono `or` (T.pencil) — hairline.
  5. **Email (LIVE):** hairline pill, T.ink text, "Continue with email".
  6. Foot toggle (T.sans 13, T.pencil, underlined): signIn → "New here? Create an
     account"; signUp → "Have an account? Sign in". `/sign-up` mounts intent="signUp"
     with kicker "Create your account" on the placeholder shell.
- **step `email`:** quiet "‹ Back" link; **underline-only input** (no box: borderBottom
  `1px solid T.hairline`, focus → T.ink; transparent bg) with small mono over-label
  `EMAIL`; `fontSize: 17` (**≥16px is mandatory on every input — blocks iOS auto-zoom**),
  `autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off"`,
  `aria-label="Email address"`. If `emailMethod==="password"`: password input beneath
  (`aria-label="Password"`, `autoComplete` = `current-password` / `new-password` by
  intent). Error line (T.errorInk, 13px, `aria-live="polite"`) above the primary pill.
  Primary ink-filled pill: "Email me a code" (code) / "Sign in" · "Create account"
  (password); while `busy`: label "One moment…", disabled. Method toggle link:
  "Use a password instead" ↔ "Email me a code instead".
- **step `code`:** mono caption `WE EMAILED A CODE TO {email}`; **one** code input (not
  six boxes — calmer, and iOS one-time-code autofill works): T.mono, fontSize 24,
  letterSpacing 6, `maxLength 6`, `inputMode="numeric"`, `autoComplete="one-time-code"`,
  underline-only, `aria-label="Six-digit code"`. Error line; primary ink pill "Verify";
  quiet "Resend code" link (during cooldown: disabled, shows countdown); "‹ Back".

**Motion:** step swaps crossfade ≤150ms (framer-motion), gated on `useReducedMotion()` →
instant swap. Nothing else moves. Reduced-motion is trivially satisfied (static hero).

**Keyboard avoidance (Capacitor iOS — no keyboard plugin installed, keep it that way):**
every input `onFocus` → `setTimeout(300)` → `e.target.scrollIntoView({ block: "center",
behavior: "smooth" })` (precedent: `PlayerAutocomplete.tsx:117`); scrollable root +
`100dvh` sizing; ≥16px input font kills the zoom-jump; WKWebView's native scroll-on-focus
is the first line, this is belt-and-braces.

**Sunlight legibility:** body/interactive text T.ink on T.paper (≈13:1); T.pencil only
for ≤9px mono captions; error copy T.errorInk at 13px (≈4.9:1). Verify at 375×812 and
430×932 — no horizontal overflow, all three steps fit without scrolling when the
keyboard is closed.

**Wrapper (`SignInClient.tsx` / `SignUpClient.tsx`):** keep the proven static-export
pattern — `const SignInScreen = dynamic(() => import("@/components/auth/SignInScreen"),
{ ssr: false, loading: () => <PaperShell/> })` where `PaperShell` is the current static
paper background + masthead (instant first paint, no white screen; headless removes the
`mountSignIn` hazard class entirely). Keep `<NativeAuthDiag/>` mounted (it is already
`dynamic(ssr:false)`). `generateStaticParams` in both `page.tsx` files untouched.

## 4. `HoleIllustration` `variant="hero"` (additive, Slice-3-ready)

Default `"interactive"` = byte-identical current behavior (HoleCard etc. unaffected).
`"hero"`:
- OMIT: the `#ece7db` background rect (paper + noise shows through — "no card chrome"),
  the aim reticle group, the tee→green thread line, the invisible hit circle, and the
  native pointer-listener effect (skip attach entirely — no dead listeners).
- KEEP: rough-pattern texture rect (opacity ~0.25), fairway ribbon, dashed centerline,
  hazards, green + flag (accent), tee dot, TEE/GRN labels via `showDetail`.
- This exact element set is what Slice 3 animates (`pathLength` on the centerline etc.) —
  the variant is the shared contract; do not fork a second hero component.

## 5. Enumeration hygiene — error-code → uniform copy (the mapping table)

Lives in `useAuthFlow.ts` as `export function authErrorCopy(code: string): string`.
Raw Clerk `message`/`longMessage` are NEVER rendered or stored (they leak existence).

| Clerk `error.code` | Uniform copy |
|---|---|
| `form_identifier_not_found` | Password path: "That email and password don't match." (SAME copy as wrong-password — no existence leak). Code path: never surfaced — triggers the sign-up pivot. |
| `form_password_incorrect` | "That email and password don't match." |
| `form_identifier_exists` | Never surfaced — triggers the sign-in pivot; fallback copy = "That email and password don't match." |
| `form_code_incorrect` | "That code isn't right — check the email and try again." |
| `verification_expired` | "That code expired. Tap resend and we'll send a fresh one." |
| `verification_failed` (too many wrong codes) | Same as `verification_expired`. |
| `too_many_requests` | "A lot of attempts just now. Give it a minute, then try again." (surface calmly; NO client retry loop.) |
| `form_password_pwned` | "That password showed up in a known breach — pick a different one." (sign-up only; safe, non-enumerating.) |
| `form_password_length_too_short` / `form_password_validation_failed` / `form_password_size_in_bytes_exceeded` | "Passwords need at least 8 characters." |
| `form_param_format_invalid` | "That doesn't look like an email address." |
| `session_exists` | Treated as SUCCESS → `done`. |
| thrown transport error / `navigator.onLine === false` | "You're offline — sign-in needs a connection." |
| anything else | "Something went wrong on our end. Try again." |

Invariant to unit-test: for the sign-in password path, not-found and wrong-password
produce byte-identical copy; for the code path, an existing account and a brand-new
account produce byte-identical screens.

## 6. `/sso-callback` decision + AuthGate

**DEFER — leave `frontend/src/app/sso-callback/page.tsx` byte-unchanged.** Rationale:
(1) it already exists as a spike-flag-gated page (inert static stub on default builds,
live only under `NEXT_PUBLIC_AUTH_SPIKE=1` via `SPIKE_AUTH_PREFIXES`); (2) Google web
redirect is live-disabled this slice, so an always-on callback has zero callers — adding
it to `AUTH_PREFIXES` would only widen the signed-out-reachable surface for no function;
(3) zero `AuthGate.tsx` diff means `assert-no-auth-bypass.mjs` and
`auth-gate-routes.test.ts` stay green by construction. Promote it to a first-class
`AUTH_PREFIXES` entry in the slice that flips OAuth live (after
`auth-clerk-enable-social-connections`), with its own /security-review then.
**`AuthGate.tsx`: ZERO diff this slice.** Its existing states (PaperLoading / auth-route
passthrough / signed-out→SignInClient / signed-in→children) are all preserved untouched;
the onboarding fourth state is Slice 4.

## 7. Playwright `e2e/auth.spec.ts` — concrete updates

Keep the file, the tier structure, `TEST_USER_EMAIL` (`+clerk_test` / OTP `424242`), and
`setupClerkTestingToken` (spike verdict: testing tokens work headless).

- **Tier 1** ("renders sign-in screen"): keep the `Your yardage book` + `Looper.` +
  no-`Recent rounds` assertions (they hold — kicker text preserved). ADD:
  `getByRole("button", { name: "Continue with email" })` visible + enabled;
  `getByRole("button", { name: "Continue with Apple" })` and `"Continue with Google"`
  visible + disabled; `locator('input[name="identifier"]')` count 0 (prebuilt widget gone).
- **Tier 2** (all 3 tests): extract one helper and replace every inline widget-drive:
  ```ts
  async function signInWithEmailCode(page) {
    await setupClerkTestingToken({ page });
    await page.goto("/");
    await expect(page.getByText("Your yardage book")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Continue with email" }).click();
    await page.getByLabel("Email address").fill(TEST_USER_EMAIL);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await page.getByLabel("Six-digit code").fill("424242");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Recent rounds")).toBeVisible({ timeout: 15_000 });
  }
  ```
  Delete the `input[name="identifier"]` / multi-selector OTP (`.cl-otpCodeFieldInput`
  etc.) cruft. The three tests' post-sign-in journey assertions (home shell, profile
  link, `/round/new`) stay as-is. The aria-labels/button names in §3 are the test
  contract — builder must keep them in exact sync.

## 8. Edge cases & risks

- **Offline:** pre-check `navigator.onLine` + catch thrown transport errors → offline
  copy; the static shell itself renders fine offline (epic §4.4).
- **Expired code / too many wrong codes:** mapped copy + resend (30s cooldown).
- **`too_many_requests`:** calm copy, cooldown, never auto-retry (Clerk owns rate limiting).
- **Double-tap / re-entrancy:** `busy` flag no-ops every action while in flight.
- **Reduced motion:** static screen; only the ≤150ms step swap is gated on `useReducedMotion()`.
- **Static-export prerender:** all Clerk-hook code behind `dynamic(ssr:false)`;
  `generateStaticParams` untouched; both builds (default + `NEXT_PUBLIC_AUTH_SPIKE=1`) must pass.
- **Pivot state staleness (watch item):** after a failed `signUp.create`, retrying should
  re-run `create` cleanly; if Clerk rejects a re-create, surface the generic copy. First
  live drive will confirm — see next point.
- **Spike was CONSTRAINED-GO:** the email flows were never clicked live (verdict §0).
  Slice 2 is deliberately the first live exercise — the builder MUST drive
  sign-in+sign-up (code AND password) against the dev Clerk instance
  (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` dev key) during development. This closes the
  spike's outstanding live half; any Future-API surprise surfaces here, not in review.
- **e2e text contract:** the literal `Your yardage book` source text must survive the redesign.
- **Apple HIG:** keep the disabled Apple pill HIG-shaped (logo + "Continue with Apple")
  so enabling later is a no-restyle flip.
- **Lockfile (if the `@capgo` pin is tightened):** surgical string edit only; Linux CI is
  authoritative (epic §9 lesson).

## 9. Gates (all must pass)

1. `cd frontend && npm run lint`
2. `cd frontend && npx tsc --noEmit`
3. `cd frontend && npm run build` (runs `assert-no-auth-bypass.mjs` via prebuild)
4. `cd frontend && NEXT_PUBLIC_AUTH_SPIKE=1 npm run build`
5. `cd frontend && node scripts/assert-no-credential-log.mjs` (now covering `src/components/auth` — 0 violations)
6. `cd frontend && node scripts/assert-no-auth-bypass.mjs`
7. `cd frontend && npx vitest run` (new: useAuthFlow + SignInScreen + updated no-credential-log tests; existing: auth-gate-routes, ClerkTokenBridge — all green)
8. `cd frontend && npx tsx voice-tests/runner.ts --smoke`
9. `cd frontend && npx playwright test e2e/auth.spec.ts` (Tier 1 with pk; Tier 2 when `CLERK_SECRET_KEY` present)
10. Manual: 375×812 + 430×932 viewport pass; on-device/simulator keyboard-avoidance check.
11. **Designer review — BLOCKING** (judge against §3 of this plan + epic §3.2: hero
    proportion, wordmark, pill language/radius, disabled-OAuth treatment, error-copy tone).
12. **`/security-review` — BLOCKING** (epic §6 Slice-2 checkpoint: credential-handling UI —
    no-log discipline, enumeration hygiene, no token handling in UI, sign-out invariant
    untouched, backend zero-delta).

## 10. Shared-type sync note

**This slice touches NEITHER `frontend/src/lib/types.ts` NOR `backend/app/models.py`.**
The `onboarding_step` column/field is Slice 4 (`onboarding-shell-and-gate`) — explicitly
out of scope here. Backend diff must be empty (`git diff backend/` → nothing).
