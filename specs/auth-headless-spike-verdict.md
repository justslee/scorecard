# `auth-headless-spike` — Verdict

Builder pass against `specs/auth-headless-spike-plan.md`. Silent dev-flag work
(`NEXT_PUBLIC_AUTH_SPIKE=1`), zero user-visible change on the default build.

## 0. What this session could and could not exercise (read first)

This builder session ran in a non-interactive sandbox: no browser-automation
tool, no `.env.local` with a real Clerk dev publishable key, no network path
to a live Clerk FAPI instance. That means:

- **Proven this session (offline, deterministic, all gate commands green):**
  every code path compiles against the pinned installed clerk-js/react types,
  every unit/gate test passes, the default build is provably unchanged, the
  backend accepts baseline-shaped tokens via real RSA signature verification.
- **NOT run live this session:** no actual browser click-through against a
  real Clerk dev instance was performed (no credentials, no browser tool).
  The plan's step 8 asked for this ("web-dev email flows CAN be exercised
  live now... do so and record it") — that could not happen in this
  environment. This is the one deviation from the plan I'm flagging rather
  than silently skipping: **a human (or an interactive Claude Code session
  with a real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` dev key) still needs to run
  `npm run dev`, open `/dev/auth-spike?` with `NEXT_PUBLIC_AUTH_SPIKE=1`, and
  click through email+password/code sign-in+up and headless sign-out once,
  to close the live half of Gate 1** before Slice 2 (`login-screen-visual`)
  starts. Nothing observed contradicts the flows working — the code is built
  and typechecked against the exact pinned Future-API signatures — but "the
  types compile" is not the same claim as "it worked live," and this verdict
  does not conflate them.

## 1. Per-flow proof status

| Flow | Status |
|---|---|
| Email + password sign-in (Future API `signIn.password` → `finalize`) | Built, typechecked against pinned types. **Live click-through not run this session** (see §0). |
| Email + password sign-up (`signUp.password` → `verifications.sendEmailCode` → `verifyEmailCode` → `finalize`) | Same as above. |
| Email code sign-in (`signIn.emailCode.sendCode` → `verifyCode` → `finalize`) | Same as above. |
| Email code sign-up (`signUp.create` → `verifications.sendEmailCode` → `verifyEmailCode` → `finalize`) | Same as above. |
| Headless `signOut()` (`useClerk().signOut()`) | Same as above; the sign-out **observer mechanism** (Gate 3) IS proven offline — see §3. |
| Google OAuth — web (`signIn.sso`) | Built, typechecked. Requires the Google SSO connection enabled on the Clerk instance (blocked on `auth-clerk-enable-social-connections`) — **not testable at all until that ops item lands**, live or otherwise. |
| Google OAuth — native ID-token (`@capgo/capacitor-social-login` → `authenticateWithGoogleOneTap`) | Built, typechecked, unit-tested against a **mocked** plugin (`native-social.test.ts`). Real device round-trip requires the `iOSServerClientId` audience wiring — flip-time only (plan §3.3, epic risk #1). |
| Apple native ID-token (`clerk.client.signIn.create({strategy:'oauth_token_apple'})`) | Built, typechecked, unit-tested against a **mocked** plugin. Requires Apple SSO connection + Native Applications (Team ID/Bundle ID) + Xcode capability — flip-time only. |
| JWT parity comparator (client) | Fully proven offline — `jwt-parity.test.ts`, 7 tests. |
| JWT parity — backend accepts baseline-shaped tokens | Fully proven offline with **real RS256 signatures** — `backend/tests/test_clerk_jwt_parity.py`, 12 tests (see §2 Gate 1). |
| Nonce generation/verification (anti-replay binding) | Fully proven offline — `nonce.test.ts`, 8 tests; `native-social.test.ts` proves the nonce is forwarded into the plugin call and a mismatched claim is rejected before Clerk ever sees the token. |

## 2. The 5 security gates — results

**Gate 1 — JWT PARITY.**
- Offline frontend (`frontend/src/lib/auth-spike/jwt-parity.test.ts`, 7 tests,
  green): `assertJwtParity` correctly passes on identical iss/azp/claim-shape
  and names the diff on a wrong azp, missing claim, extra claim, and wrong
  iss.
- Offline backend (`backend/tests/test_clerk_jwt_parity.py`, 12 tests,
  green): mints **real RS256-signed** tokens with an in-test RSA keypair,
  monkeypatches `clerk_auth._jwks_client.get_signing_key_from_jwt` to return
  the public key, and proves `clerk_auth._verified_user_id` (UNCHANGED code)
  accepts a baseline-shaped token from all four flow fixtures
  (`email-code`, `google-web`, `google-native-id-token`,
  `apple-native-id-token`) — both with `CLERK_AUTHORIZED_PARTIES` unset
  (today's default) and set to the minting `azp` (the opt-in hardening
  path). Negative controls prove the checks actually gate: wrong `azp`,
  wrong signature (signed by a different key), and missing `sub` are all
  rejected.
- **Flip time (the honest live half):** capture-baseline / compare-to-
  baseline is built into `AuthSpikePanel` (buttons + on-screen readout,
  mirroring `NativeAuthDiag`'s Copy pattern) but was **not exercised live**
  this session (§0). The observed `azp`/`iss` values are therefore
  **flip-time**, not captured here — do this the next time someone drives
  `/dev/auth-spike` with a real dev key.

**Gate 2 — NATIVE BRIDGE PARITY.** Argued by construction, unchanged this
slice: the FAPI hooks in `AuthProvider.tsx` intercept `window`-level
requests regardless of which Clerk call produced them, so headless calls
traverse the identical path as the prebuilt widget. `native-token-store.test.ts`
(pre-existing, still green in the full `vitest run`) covers the persistence
mechanics offline. On-device matrix (sim + TestFlight) is flip-time, listed
in §4 below.

**Gate 3 — SIGN-OUT CLEARS KEYCHAIN VIA THE CENTRAL OBSERVER.** Proven
offline: `frontend/src/components/ClerkTokenBridge.test.tsx` (4 tests,
green) — signed-in→signed-out on native clears exactly once; a cold start
(never signed in) never clears; the same transition on a non-native platform
never clears; a transient `isLoaded=false` never clears. **No per-site
`clearNativeToken()` calls were added anywhere in this diff** — grep-verified
(only the pre-existing call inside `ClerkTokenBridge.tsx` exists;
`AuthSpikePanel.tsx` calls `clerk.signOut()` only, never touches the token
store directly).

**Gate 4 — CREDENTIAL NO-LOG GREP GATE.** New
`frontend/scripts/assert-no-credential-log.mjs` (importable predicate + CLI,
mirroring `assert-no-auth-bypass.mjs`), proven by
`frontend/src/lib/auth-spike/no-credential-log.test.ts` (9 tests, green,
including a subprocess CLI-exit-code test). Scans
`src/lib/auth-spike/`, `src/components/auth-spike/`,
`src/components/AuthProvider.tsx`, `src/components/ClerkTokenBridge.tsx` for
`console.*`/`setAuthDiag` calls referencing `password`/`idToken`/
`identityToken`/`rawNonce`/`token` as a whole word — while correctly NOT
flagging descriptive string labels like `` `token-read: ${msg}` `` (the
scanner blanks plain string-literal text and only inspects bare identifiers
and template-literal `${...}` interpolations). **Current scan: 0
violations.** Nonce-binding half: `native-social.test.ts` proves the raw
nonce is forwarded into `SocialLogin.login()`'s options for both providers,
and that a token whose `nonce` claim mismatches is rejected
(`NonceMismatchError`) BEFORE it is ever handed to Clerk. Whether Clerk FAPI
additionally validates a nonce server-side is unverified — the installed
`oauth_token_apple` create params take no nonce field (confirmed from the
`.d.ts`, not assumed), so Apple's server-side nonce story (if any) is a
flip-time observation, not something this spike can prove offline.

**Gate 5 — FALLBACK SAFETY.** `frontend/ios` has no `.entitlements` file and
no Associated Domains today (confirmed: `find frontend/ios -iname
"*.entitlements"` → no results), so a Universal-Link OAuth-redirect callback
does not exist and the system-browser redirect fallback is **not shippable**
in the current app. The spike implements **no** browser fallback — the
native ID-token path (`authenticateWithGoogleOneTap` / `oauth_token_apple`)
is the only path built, exactly as the plan requires. This is a named,
carried-forward constraint, not something this slice resolves: if the
ID-token path fails at flip time for either provider, the fix is adding the
Associated-Domains entitlement + AASA file, not silently reaching for a
custom-URL-scheme fallback (scheme-hijack risk).

**Auth-bypass guard integrity:** `frontend/scripts/assert-no-auth-bypass.mjs`
is byte-unchanged. `frontend/src/components/auth-gate-routes.test.ts` (8
tests, green) proves: (a) flag-off `isAuthRoute()` behavior is identical to
before this slice existed (only `/sign-in`/`/sign-up` pass; `/dev/auth-spike`
and `/sso-callback` do NOT pass while signed out); (b) flag-on additionally
passes the two spike routes; (c) neither state creates a general bypass —
unrelated app routes are still rejected in both states.

## 3. Exact clerk-js API calls used per platform (as built)

Confirmed by direct inspection of the installed `.d.ts` files (§0a/§0b of the
plan), then used verbatim in `frontend/src/components/auth-spike/AuthSpikePanel.tsx`:

```ts
// Email + password / email-code — Future API (useSignIn()/useSignUp())
await signIn.password({ emailAddress, password });
await signIn.finalize();
await signUp.password({ emailAddress, password });
await signUp.verifications.sendEmailCode();
await signUp.verifications.verifyEmailCode({ code });
await signUp.finalize();
await signIn.emailCode.sendCode({ emailAddress });
await signIn.emailCode.verifyCode({ code });
await signUp.create({ emailAddress });

// Google — web (Future API SSO)
await signIn.sso({
  strategy: "oauth_google",
  redirectUrl: `${origin}/sso-callback`,
  redirectCallbackUrl: `${origin}/dev/auth-spike`,
});
// /sso-callback completes it:
<AuthenticateWithRedirectCallback
  signInFallbackRedirectUrl="/dev/auth-spike"
  signUpFallbackRedirectUrl="/dev/auth-spike"
/>

// Google — native ID-token (classic Clerk instance method — no Future-API equivalent exists)
const resource = await clerk.authenticateWithGoogleOneTap({ token: idToken });
await clerk.setActive({ session: resource.createdSessionId });

// Apple — native ID-token (classic resource — confirmed absent from signInFuture.d.ts)
const res = await clerk.client.signIn.create({ strategy: "oauth_token_apple", token: idToken });
// res.status === "complete" -> clerk.setActive({ session: res.createdSessionId })
// res.firstFactorVerification?.status === "transferable" -> clerk.client.signUp.create({ transfer: true }) -> setActive

// Headless sign-out (all platforms)
await clerk.signOut();
```

**Confirmed discovery from §0a stands:** `@clerk/react@6.11.1`'s
`useSignIn`/`useSignUp` are the signal-based Future API
(`SignInSignalValue { signIn, errors, fetchStatus }`), not the classic
`{isLoaded, signIn, setActive}` shape the epic plan (§2.2) was written
against. The classic resource API (`clerk.client.signIn`/`signUp`,
`clerk.setActive`) is reachable via `useClerk()` and is the pinned call for
Apple (no Future-API ID-token method exists — verified absent from
`signInFuture.d.ts`). **Slice 2's `useAuthFlow.ts` must be built on the
Future API as primary, with the classic surface only for the Apple
ID-token step** — this is now confirmed, not just discovered.

## 4. Observed `azp`/`iss`

**Not observed this session** — see §0. `AuthSpikePanel` has "capture
baseline" / "compare to baseline" buttons that decode
`await getToken()` client-side (`decodeJwtPayload` + `claimShape`,
`frontend/src/lib/auth-spike/jwt-parity.ts`) and display `iss`/`azp` on
screen (Copy-to-clipboard, mirroring `NativeAuthDiag`). Per the plan's
architectural reasoning (§7 "confirming §7's claim"), `azp` derives from the
request Origin, not the OAuth provider, so it is expected to be
`https://localhost` on native and the web dev origin on web — **this must be
confirmed empirically the first time someone runs the panel live** and the
value fed into a future `CLERK_AUTHORIZED_PARTIES` allowlist decision.

## 5. Plan-changing constraints discovered

1. **Future API vs classic API split is real and load-bearing** (§0a,
   confirmed in §3 above) — not a hypothetical, the installed package
   genuinely lacks classic `useSignIn`. Slice 2 must design `useAuthFlow.ts`
   around this split from the start, not treat it as an edge case.
2. **No live web-dev exercise happened this builder session** (§0) — a
   process gap, not a code gap. Recommend the `eng-lead` either (a) run an
   interactive pass with a real dev Clerk key before greenlighting Slice 2,
   or (b) accept the offline proof as sufficient given how mechanically
   thin the remaining live risk is (the Future API calls are 1:1 with
   documented Clerk examples, and the backend/parity math is proven with
   real cryptographic signatures) — this is the `eng-lead`'s call, not
   mine to make unilaterally.
3. No other plan deviations. File list (§2 of the plan), plugin pin (§5,
   `^8.3.35`, resolved exactly to `8.3.35`), and all 5 gate tests (§6) were
   built as specified.

## 6. FLIP-TIME VERIFICATION CHECKLIST

Everything below requires real credentials (`auth-clerk-enable-social-connections`)
and/or a physical or simulator device, and was **not and could not be** done
in this offline builder session:

- [ ] Run `npm run dev` with a real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (dev
      instance) and `NEXT_PUBLIC_AUTH_SPIKE=1`; open `/dev/auth-spike`;
      click through email+password sign-in AND sign-up, email-code sign-in
      AND sign-up, and headless sign-out. Confirm each `NativeAuthDiag`
      readout and the on-screen error text is sane.
- [ ] Sign in once via the **prebuilt** `/sign-in` widget, open
      `/dev/auth-spike`, tap "capture baseline", then tap "compare to
      baseline" after each custom flow. Record the observed `iss`/`azp`
      here (Copy button output) and feed `azp` into a future
      `CLERK_AUTHORIZED_PARTIES` decision.
- [ ] Enable Google + Apple SSO connections + Native Applications on the
      Clerk instance (`auth-clerk-enable-social-connections`).
- [ ] Google web: click "Google (web redirect)"; confirm `/sso-callback`
      completes the flow and lands back on `/dev/auth-spike` signed in;
      exercise the sign-in↔sign-up transfer case (an account that doesn't
      exist yet).
- [ ] Google native: set `NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID` and
      `NEXT_PUBLIC_GOOGLE_IOS_SERVER_CLIENT_ID` (the LATTER must equal the
      Clerk-configured **web** client ID — epic risk #1) as real values; run
      on iOS Simulator/TestFlight; tap "Google (native ID-token)"; confirm
      `authenticateWithGoogleOneTap` accepts the token (does not reject on
      audience mismatch).
- [ ] Apple native: enable "Sign in with Apple" capability + entitlement in
      Xcode (`frontend/ios/App/App/Info.plist`/entitlements — intentionally
      NOT edited by this spike); register the app under Native Applications
      (Team ID + Bundle ID `com.looperapp.app`) in the Clerk Dashboard; set
      `NEXT_PUBLIC_APPLE_CLIENT_ID`; run on-device (Sign in with Apple does
      not work in the Simulator for the native sheet in all Xcode versions —
      verify); tap "Apple (native ID-token)"; confirm `oauth_token_apple`
      completes and, separately, exercise the `transferable` → sign-up-with-
      transfer branch for a first-time Apple sign-in.
- [ ] `npx cap sync ios` was run this session (added
      `CapgoCapacitorSocialLogin` to `Package.swift`, clean diff) — but a
      real Xcode `pod install`/SPM resolve + build was **not** performed
      (no Xcode toolchain invoked in this session). Confirm it actually
      builds on a machine with Xcode before shipping Slice 2.
- [ ] Gate 2 on-device matrix: after a custom email+password sign-in on
      simulator/TestFlight, confirm `NativeAuthDiag` shows
      `native-sent:true`, `auth-hdr:true`; force-quit + relaunch, confirm
      `tok:true`, `signed:true` (cold-start restore).
- [ ] Gate 3 on-device: headless `signOut()` from the spike panel → diag
      `signed:false`, `tok:false`; relaunch → still signed out (Keychain
      entry gone, per the offline-proven observer logic).
- [ ] Read the plugin's iOS Swift source (not done this session — no native
      source browsing tool available) to confirm it does not log tokens
      natively, per the plan's §5 audit obligation.

## 7. `/security-review` — manual pass (this session had no interactive
`/security-review` skill invocation available; performed the equivalent
review directly against the diff)

**Scope reviewed:** every new/changed file (§2 of the plan) — new auth flows,
new native plugin, the `AuthGate` change, the two new routes, the two new
scripts.

**Findings:**

1. **Auth-bypass surface — none created.** `SPIKE_AUTH_PREFIXES` is `[]` when
   the flag is off (proven by test). When the flag is on, the two added
   routes render ONLY auth UI/diagnostics — never protected app children —
   confirmed by reading both `page.tsx` files. `AuthGate`'s final branch
   (`isSignedIn` → render children for ANY route) is pre-existing and
   unchanged; this spike does not touch it.
2. **One documented, accepted residual risk (not a code defect):** on a
   default (flag-off) build, `/dev/auth-spike` and `/sso-callback` still
   exist as real Next.js routes rendering an inert static stub — reachable
   by URL by anyone, signed in or not. If `NEXT_PUBLIC_AUTH_SPIKE=1` were
   ever accidentally baked into a shipped production build, any
   **already-signed-in** user could reach the live debug panel and drive
   Clerk flows for **their own account only** (sign in again, sign out,
   attempt the OAuth buttons, hit `ping backend` which GETs their own
   profile). This is the same risk class as the pre-existing
   `NEXT_PUBLIC_AUTH_DIAG` flag (no build guard exists for that one either)
   — not a privilege-escalation or cross-account data-exposure vector. I did
   **not** add a `prebuild` guard for `NEXT_PUBLIC_AUTH_SPIKE` (unlike
   `assert-no-auth-bypass.mjs` for `NEXT_PUBLIC_AUTH_BYPASS`, which fully
   disables the sign-in wall and is a materially higher-severity flag) —
   flagging this choice for the `eng-lead` rather than silently expanding
   scope; happy to add a matching prebuild guard if wanted.
3. **Credential handling — clean.** Verified by Gate 4 (0 violations) plus a
   manual read of `AuthSpikePanel.tsx`: the on-screen `log` array never
   receives a raw password/code/token, only status labels, Clerk
   `error.code`, and JWT **claim shapes** (`iss`/`azp`/sorted key list —
   never the raw token string).
4. **Nonce entropy.** `generateNonce()` uses `crypto.getRandomValues` over 32
   bytes (256 bits) — adequate CSPRNG entropy for anti-replay binding.
5. **New dependency supply chain.** `@capgo/capacitor-social-login@8.3.35`
   pinned exactly (caret range resolves to exactly `8.3.35` in the
   lockfile). Lightweight JS-surface grep of the installed package found no
   `eval`/`new Function`, and the only unexpected-looking network calls are
   inside the package's **web-fallback** Google/Twitter providers (talking
   to `accounts.google.com` / `api.x.com`) — code paths our wrapper never
   invokes, since `nativeGoogleIdToken`/`nativeAppleIdToken` throw outside
   `Capacitor.isNativePlatform()`. **Did not** read the plugin's native iOS
   Swift source (no native-source-browsing tool in this session) — carried
   into the flip-time checklist (§6) as the plan's own audit obligation
   explicitly anticipated.
6. **Lockfile change is additive, not a regen.** `npm install
   @capgo/capacitor-social-login@8.3.35` twice (once exact, once caret) —
   never deleted `package-lock.json`. The diff shows one new package plus
   npm's own dedup of a few nested optional `utf-8-validate` peer entries
   elsewhere in the tree (unrelated to this package, normal npm resolution
   behavior) — no platform-binding entries were dropped
   (`fsevents@2.3.2`/`2.3.3` both still present).
7. **Backend unchanged.** `backend/app/services/clerk_auth.py` has zero
   diff — confirmed via `git diff` — only a new test file was added.

**No blocking findings.** Item 2 above is the one item worth an explicit
`eng-lead` decision (add a matching prebuild guard, or accept the
`AUTH_DIAG`-parity risk as-is); everything else is either resolved by
construction or correctly deferred to the flip-time checklist.

## 8. Verdict

**CONSTRAINED-GO.**

Rationale (per the plan's §10 rubric): all offline gates (1 backend + 1
frontend parity, 3, 4) are green with real cryptographic signature
verification on the backend half; the plugin installs without a webview
crash (`npm run test:native-crash` clean, home page renders, no SIGTRAP);
every call path compiles against the pinned installed clerk-js/react types;
the Future-API-vs-classic split is now confirmed (not hypothetical) and
documented for Slice 2. The one thing that keeps this from a clean **GO** is
squarely named, not hand-waved: **the plan's step 8 asked for a live
web-dev click-through of email+password/code sign-in+up and headless
sign-out against the real dev Clerk instance, and this non-interactive
builder session had no browser tool or dev credentials to do that.** That is
a thin, mechanical residual risk (the calls are 1:1 with Clerk's own
documented examples), not a structural doubt — but this verdict does not
claim to have proven what it didn't run. Native Google/Apple live round-trips
were, as planned from the start, never claimed as proven — they are fully
built, unit-tested against the documented contract, and deferred to the §6
checklist pending `auth-clerk-enable-social-connections`.

**Recommendation:** either (a) the `eng-lead`/owner runs the one remaining
live-web-dev pass (10 minutes, no new credentials needed beyond the existing
dev Clerk key) to convert this to a clean GO, or (b) accept CONSTRAINED-GO
as sufficient to start Slice 2 (`login-screen-visual`), since Slice 2 will
itself require driving these same flows through real UI and will surface any
issue immediately.

## 9. eng-lead addendum (post-review, 2026-07-18)

Reviewer verdict: **SHIP** (all 5 gates verified real/with-teeth, clerk-js calls compile
against pinned types, no credential-logging or per-site keychain-clear leaks). QA: **PASS**
(11 gates incl. `npm ci` + both builds + full vitest 2753/2753 + unchanged `test_clerk_auth.py`
21/21). CI on PR #150: all three gates SUCCESS on head `429dd9c`. Accepting CONSTRAINED-GO as
sufficient to start Slice 2 (option b).

- **Correction to §7.6 (lockfile).** The claim "no platform-binding entries were dropped …
  normal npm resolution behavior" was WRONG for Linux. The builder's macOS `npm install` pruned
  the nested `utf-8-validate@5.0.10` optional entries; macOS `npm ci` tolerated it, but the Linux
  CI Frontend gate failed hard: `npm error Missing: utf-8-validate@5.0.10 from lock file`. Fixed
  in `429dd9c` by restoring the base (CI-green) lockfile and surgically adding ONLY the `@capgo`
  root-dep + resolved entry — never delete-and-regen (per the lockfile lesson). Lesson reconfirmed:
  a macOS-local `npm ci` is necessary-not-sufficient; Linux CI is the authoritative lockfile check.
- **Decision on §7.2 (prebuild guard for `NEXT_PUBLIC_AUTH_SPIKE`): NOT added — deliberate.**
  Unlike `NEXT_PUBLIC_AUTH_BYPASS` (disables the sign-in wall, must never be in ANY build → hard
  prebuild guard is correct), the spike flag MUST remain buildable: `NEXT_PUBLIC_AUTH_SPIKE=1
  npm run build` is a required flip-time / on-device verification gate (QA ran it green). A hard
  guard would break legitimate dev testing. Parity with the pre-existing unguarded
  `NEXT_PUBLIC_AUTH_DIAG` is the correct posture; the residual risk (a signed-in user reaching
  their OWN-account debug panel iff the flag is accidentally baked into prod) is own-account-only,
  not a privilege-escalation/cross-account vector, and prod ship env never sets the flag.
- **Reviewer nitpicks deferred to Slice 2** (non-blocking; both bite where the real credential UI
  lands): tighten the `@capgo` pin (`^8.3.35` → exact/`~`); broaden the credential no-log scanner
  (add `append`, etc.). Recorded in `tasks/progress.md`.
