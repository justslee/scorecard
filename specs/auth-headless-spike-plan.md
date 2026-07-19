# `auth-headless-spike` — Implementation Plan (Slice 1 of login/onboarding redesign)

**Source:** Fable architecture plan, 2026-07-18 (dispatched by eng-lead per the owner's Fable-for-Plan
directive). Contract handed to the builder — the builder implements this and does NOT re-plan.
Parent spec: `specs/login-onboarding-redesign-plan.md` §2/§5/§6/§7/§8. Backlog item: `auth-headless-spike`.

**Objective:** prove Clerk headless custom flows work end-to-end in our exact stack (Next.js 16 static
export + Capacitor iOS WKWebView + FastAPI JWKS verification), behind a dev flag with ZERO user-visible
change, and emit a written GO/NO-GO verdict with the exact per-platform API calls and the 5 reviewer
security gates asserted. UI is deliberately ugly and throwaway. The prebuilt `<SignIn>` login stays
byte-identical on default builds. This is a SILENT change (dev-flag only).

---

## 0. Two load-bearing discoveries (the builder MUST internalize these)

**(a) The installed `@clerk/react@6.11.1` does NOT export the classic `useSignIn`.** The epic plan (§2.2)
was written against the classic `useSignIn → {isLoaded, signIn, setActive}` API from `@clerk/clerk-react`.
Our package is the *newer* `@clerk/react`, whose `useSignIn`/`useSignUp` are the **signal-based "Future"
API**: `const { signIn, errors, fetchStatus } = useSignIn()` returning a `SignInFutureResource` with
method-per-factor calls (`signIn.password(...)`, `signIn.emailCode.sendCode(...)`, `signIn.sso(...)`,
`signIn.finalize(...)`). Verified directly in `frontend/node_modules/@clerk/react/dist/index.d.mts` and
`@clerk/shared/dist/types/signInFuture.d.ts` (vendored inside clerk-js 6.22.0). The classic resource API
is still reachable headlessly via `useClerk() → clerk.client.signIn / clerk.client.signUp / clerk.setActive`.
The spike exercises the Future API as primary (it is what our hooks return) and keeps the classic path as a
documented fallback. **This is a discovered constraint that Slice 2's `useAuthFlow.ts` must be built on —
record it in the verdict.**

**(b) NO Clerk version bump is needed for native Apple.** The installed `@clerk/clerk-js@6.22.0` already
ships `AppleIdTokenStrategy = 'oauth_token_apple'` in `SignInCreateParams`/`SignUpCreateParams` and
`clerk.authenticateWithGoogleOneTap(params)` (verified in `@clerk/shared/dist/types/strategies.d.ts:8`,
`signInCommon.d.ts:36`, `clerk.d.ts:960`). `frontend/patches/` contains only
`@capacitor+google-maps+8.0.1.patch` — **no Clerk patches exist, so there is no patch-package risk and no
bump**. This retires epic risk #2 entirely. Do NOT bump — it would only widen the diff.

---

## 1. Approach

- **Dev flag mechanism: `NEXT_PUBLIC_AUTH_SPIKE=1`, build-time env var** (same proven mechanism as
  `NEXT_PUBLIC_AUTH_DIAG` / `NEXT_PUBLIC_AUTH_BYPASS`). `NEXT_PUBLIC_*` vars are inlined at build time, so
  `process.env.NEXT_PUBLIC_AUTH_SPIKE === "1"` branches are statically false and dead-code-eliminated in
  every default build — zero user-visible change, zero behavior delta, provable by tests. No runtime toggle,
  no hidden gesture.
- **Hidden route `/dev/auth-spike`** hosts the throwaway UI. With the flag off the page renders a static
  "spike disabled" stub; nothing links to it. With the flag on it dynamic-imports the spike panel
  (`ssr:false`, the proven `SignInClient`/`NativeAuthDiag` pattern — no ClerkProvider at prerender).
- **`AuthGate` gets one minimal, flag-gated change:** the spike route and `/sso-callback` must be reachable
  while signed out (otherwise AuthGate renders `<SignInClient/>` inline over them). Add
  `const SPIKE_AUTH_PREFIXES = process.env.NEXT_PUBLIC_AUTH_SPIKE === "1" ? ["/dev/auth-spike", "/sso-callback"] : [];`
  and include it in `isAuthRoute`. Default build: empty array → byte-equivalent semantics, proven by a unit
  test. This is NOT an auth bypass: those routes render only auth UI/diag, never protected app children — and
  `assert-no-auth-bypass.mjs` semantics are untouched (see gate section).
- **Live-SSO honesty:** everything requiring the Clerk Dashboard social connections (real Google/Apple
  round-trips, native client IDs) is **blocked on `auth-clerk-enable-social-connections`**. The spike builds
  and unit-tests the full code path against the exact documented request/response contract shapes (stubbed
  plugin + stubbed FAPI results), and the verdict file contains an explicit **FLIP-TIME VERIFICATION
  CHECKLIST** for the live steps. The spike must NOT claim live SSO was proven.
- **Sign-out clearing stays centralized** in `ClerkTokenBridge` — the spike adds an offline test asserting
  the observer, and adds NO per-site `clearNativeToken()` calls anywhere.

## 2. Exact file list

### New frontend files
| File | Purpose |
|---|---|
| `frontend/src/lib/auth-spike/spike-flag.ts` | `AUTH_SPIKE_ENABLED` const + `SPIKE_AUTH_PREFIXES`; single source of the flag |
| `frontend/src/lib/auth-spike/jwt-parity.ts` | `decodeJwtPayload(jwt)` (base64url decode, no verify), `claimShape(payload)` (sorted claim keys), `assertJwtParity(baseline, candidate)` → `{ok, diffs[]}` comparing `iss`, `azp`, and claim-key shape |
| `frontend/src/lib/auth-spike/jwt-parity.test.ts` | Gate-1 offline tests (synthetic fixtures: identical iss/azp/shape passes; wrong azp / missing claim / extra claim each produce a named diff) |
| `frontend/src/lib/auth-spike/nonce.ts` | `generateNonce()` (crypto.getRandomValues, 32 bytes hex), `sha256Hex(s)` (WebCrypto), `verifyIdTokenNonce(idToken, rawNonce)` — decodes the ID token payload and checks `nonce` claim equals rawNonce or SHA256(rawNonce) (Apple hashes; Google echoes raw) |
| `frontend/src/lib/auth-spike/nonce.test.ts` | Nonce round-trip + mismatch-rejection tests |
| `frontend/src/lib/auth-spike/native-social.ts` | Thin wrapper over `@capgo/capacitor-social-login`: `initSocialLogin()`, `nativeGoogleIdToken(nonce)`, `nativeAppleIdToken(nonce)` → return `{ idToken }` only; guarded by `Capacitor.isNativePlatform()`; verifies nonce claim BEFORE returning; never logs the token |
| `frontend/src/lib/auth-spike/native-social.test.ts` | Mocked-plugin tests: nonce forwarded into `SocialLogin.login`; mismatched nonce claim rejects; result shape `{provider, result:{idToken}}` consumed per the plugin contract |
| `frontend/src/components/auth-spike/AuthSpikePanel.tsx` | The ugly UI (see §3). Sections: email+password sign-in/up, email-code sign-in/up, Google (web redirect / native ID-token branch), Apple (native ID-token), headless sign-out, "capture baseline" / "compare JWT" parity readout, "ping backend" button (existing authenticated profile GET via `src/lib/api.ts`), embedded `<NativeAuthDiag/>` |
| `frontend/src/app/dev/auth-spike/page.tsx` | Route; flag-off → static stub; flag-on → `dynamic(() => import(".../AuthSpikePanel"), {ssr:false})` |
| `frontend/src/app/sso-callback/page.tsx` | Web OAuth landing; flag-off → static stub; flag-on → `dynamic` client component rendering `<AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/dev/auth-spike" signUpFallbackRedirectUrl="/dev/auth-spike" />` (exported by `@clerk/react`; wraps `clerk.handleRedirectCallback`) |
| `frontend/src/components/ClerkTokenBridge.test.tsx` | Gate-3 offline test (jsdom; see §6) |
| `frontend/scripts/assert-no-credential-log.mjs` | Gate-4 grep gate (see §6) |
| `frontend/src/lib/auth-spike/no-credential-log.test.ts` | Runs/imports the grep script predicate the same way `assert-no-auth-bypass.mjs` is proven (both predicate and CLI exit code) |

### Modified frontend files
- `frontend/src/components/AuthGate.tsx` — the flag-gated `SPIKE_AUTH_PREFIXES` addition ONLY. Extract
  `isAuthRoute(pathname, extraPrefixes)` or keep inline; add `frontend/src/components/auth-gate-routes.test.ts`
  unit-testing: flag-off ⇒ prefix set identical to today; flag-on ⇒ spike routes pass through.
- `frontend/package.json` — add `@capgo/capacitor-social-login` (pin `^8.3.35`, see §5). Run
  `npx cap sync ios` (Podfile.lock under `frontend/ios/` changes).
- `frontend/ios/App/App/Info.plist` / entitlements — **NOT modified in the spike** (needs real client IDs /
  Apple capability from the ops item). Exact flip-time edits documented in the verdict file (§8).

### New backend file (backend source is otherwise UNCHANGED)
- `backend/tests/test_clerk_jwt_parity.py` — Gate-1 offline verification (see §6). `backend/app/services/clerk_auth.py`
  is not touched.

### New spec output
- `specs/auth-headless-spike-verdict.md` — the written GO/NO-GO verdict (template created by the builder,
  filled with observed evidence + the flip-time checklist).

---

## 3. Exact clerk-js API calls per platform

All signatures below were **pinned from the installed packages' type declarations** (`@clerk/clerk-js@6.22.0`
vendored `@clerk/shared` types; `@clerk/react@6.11.1` exports) — stronger than docs. Web docs verified the
operational model (audience/nonce/dashboard config; sources at end).

### 3.1 Email + password and email-code (all platforms — pure FAPI, no native branch)

Signal API (what `@clerk/react`'s hooks return):

```ts
const { signIn, errors, fetchStatus } = useSignIn();   // SignInSignalValue
const { signUp } = useSignUp();                        // SignUpSignalValue
const clerk = useClerk();

// Sign-IN, password:
await signIn.password({ identifier: email, password });      // SignInFuturePasswordParams
await signIn.finalize();                                     // sets the created session active

// Sign-IN, email code:
await signIn.emailCode.sendCode({ emailAddress: email });    // SignInFutureEmailCodeSendParams
await signIn.emailCode.verifyCode({ code });                 // { code: string }
await signIn.finalize();

// Sign-UP, password:
await signUp.password({ emailAddress: email, password });    // SignUpFuturePasswordParams
await signUp.verifications.sendEmailCode();
await signUp.verifications.verifyEmailCode({ code });
await signUp.finalize();

// Sign-UP, email code only:
await signUp.create({ emailAddress: email });
await signUp.verifications.sendEmailCode();
await signUp.verifications.verifyEmailCode({ code });
await signUp.finalize();
```

Every method resolves `{ error: ClerkError | null }` — surface `error` in the ugly UI; map
`too_many_requests` etc. to plain text (no retry loops). Documented fallback if the Future API misbehaves:
classic resources via `clerk.client.signIn.create({ identifier })` →
`prepareFirstFactor({ strategy:'email_code', emailAddressId })` →
`attemptFirstFactor({ strategy:'email_code', code })` →
`clerk.setActive({ session: clerk.client.signIn.createdSessionId })` (all present in `signInCommon.d.ts`).
The verdict records which surface was used.

### 3.2 Google OAuth — web

```ts
await signIn.sso({
  strategy: 'oauth_google',                       // OAuthStrategy
  redirectUrl: `${window.location.origin}/sso-callback`,
  redirectCallbackUrl: `${window.location.origin}/dev/auth-spike`,
});   // SignInFutureSSOParams — navigates away to Google
```

(Classic equivalent, also installed: `clerk.client.signIn.authenticateWithRedirect({ strategy:'oauth_google',
redirectUrl:'/sso-callback', redirectUrlComplete:'/dev/auth-spike' })` — `AuthenticateWithRedirectParams` in
`redirects.d.ts`.) The `/sso-callback` page completes it with `<AuthenticateWithRedirectCallback/>` which
calls `clerk.handleRedirectCallback(params)` (`clerk.d.ts:926`) — including the sign-in↔sign-up transfer case.

### 3.3 Google OAuth — Capacitor iOS NATIVE (primary path: ID token, no browser)

```ts
const rawNonce = generateNonce();
const { idToken } = await nativeGoogleIdToken(rawNonce);     // @capgo plugin → Google ID token
// verifyIdTokenNonce(idToken, rawNonce) already asserted inside the wrapper
const resource = await clerk.authenticateWithGoogleOneTap({ token: idToken });
//   (params: AuthenticateWithGoogleOneTapParams { token: string; legalAccepted?: boolean })
//   → Promise<SignInResource | SignUpResource> — handles sign-in vs sign-up transfer itself
await clerk.setActive({ session: resource.createdSessionId });
// or: clerk.handleGoogleOneTapCallback(resource, { signInFallbackRedirectUrl: '/dev/auth-spike' })
```

**Verified from Clerk docs (web):** the ID token's `aud` must be the **Web application client ID** configured
as the Google social connection's custom credential in the Clerk Dashboard — "even if you are building a
native app, you still need to create the web client for Clerk's token verification." With
`@capgo/capacitor-social-login` this means initializing Google with both `iOSClientId` AND `iOSServerClientId`
(= the web client ID) so the returned `idToken` is minted for the web-client audience. **This exact audience
wiring is the epic's #1 risk and is a FLIP-TIME verification** (needs real Google Cloud + Clerk Dashboard
credentials from the ops item). Offline, the spike stubs the plugin and asserts our side of the contract
(nonce in, `result.idToken` out, token → `authenticateWithGoogleOneTap({token})`).

### 3.4 Sign in with Apple — Capacitor iOS NATIVE (ID-token strategy)

```ts
const rawNonce = generateNonce();
const { idToken } = await nativeAppleIdToken(rawNonce);      // native ASAuthorization sheet
// signIn path (classic resource — the Future API has no ID-token method; verified absent
// from signInFuture.d.ts, so the classic create() IS the pinned call):
const res = await clerk.client.signIn.create({ strategy: 'oauth_token_apple', token: idToken });
if (res.status === 'complete') {
  await clerk.setActive({ session: res.createdSessionId });
} else if (res.firstFactorVerification?.status === 'transferable') {
  // no matching user → transfer to sign-up (mirror strategy exists in SignUpCreateParams)
  const up = await clerk.client.signUp.create({ transfer: true });
  await clerk.setActive({ session: up.createdSessionId });
}
```

`{ strategy: AppleIdTokenStrategy; token: string }` is a first-class member of the installed
`SignInCreateParams` and `SignUpCreateParams` unions. Dashboard prerequisites (flip time): Apple social
connection enabled + the app registered under Native Applications (Team ID + Bundle ID `com.looperapp.app`)
so Clerk accepts the bundle-ID audience; Xcode "Sign in with Apple" capability + entitlement added to the App
target. Note the `create` params accept no nonce field — nonce binding is enforced client-side (§6 gate 4)
and whether FAPI additionally validates it is a flip-time observation for the verdict.

### 3.5 Headless sign-out (all platforms)

```ts
const { signOut } = useClerk();
await signOut();          // SignOut type; no redirectUrl needed in the spike panel
```

`isSignedIn` flips false → `ClerkTokenBridge`'s centralized observer clears the Keychain. **No other clearing
code is added.**

---

## 4. Clerk version bump verdict

**No bump.** `oauth_token_apple`, `google_one_tap` create-strategies, `authenticateWithGoogleOneTap`,
`handleRedirectCallback`, `AuthenticateWithRedirectCallback`, and the Future sign-in/up API all exist in the
installed `@clerk/clerk-js@6.22.0` / `@clerk/react@6.11.1`. `frontend/patches/` holds no Clerk patches (only
`@capacitor+google-maps+8.0.1.patch`), so even a future bump carries no patch-package conflict; do not bump
in this spike.

---

## 5. Native social-login plugin

**`@capgo/capacitor-social-login`, pin `^8.3.35`** (latest as of 2026-07; major 8 tracks Capacitor 8,
matching our `@capacitor/core@8.4.1`). Verified from its README/docs:
- `SocialLogin.initialize({ google: { iOSClientId, iOSServerClientId }, apple: { clientId } })`; Apple on iOS
  uses the native AuthenticationServices flow (no redirect URL needed on iOS); `login({ provider, options })`
  returns `result.idToken` for both providers; **`login()` accepts a `nonce` option for both providers**; Apple
  config supports `useProperTokenExchange: true` (strict token handling) — set it.
- iOS setup: Apple needs the Sign in with Apple entitlement; Google needs the reversed-client-ID URL scheme in
  `Info.plist` — both are FLIP-TIME native config (real IDs required), listed in the verdict checklist, not
  stubbed into the plist now.
- Audit obligations (rides `/security-review` of this slice): pin the version (no `^`-drift beyond patch —
  commit the lockfile), read the plugin's iOS Swift sources for the token path (it handles the raw
  Google/Apple ID token before clerk-js), confirm it does not log tokens natively, extend our no-log grep to
  its JS surface (§6 gate 4), and record the plugin version + audit notes in the verdict.

---

## 6. The 5 security gates as concrete tests

**Gate 1 — JWT PARITY (offline + flip-time).**
- Offline (backend): `backend/tests/test_clerk_jwt_parity.py` — pure unit, no DB (CI-safe): generate an RSA
  keypair in-test (`pyjwt[crypto]` is already a backend dep), monkeypatch
  `clerk_auth._jwks_client.get_signing_key_from_jwt` to return the public key, mint RS256 tokens from **four
  claim fixtures named for the flows** (email/code, google-web, google-native-id-token, apple-native-id-token)
  that share identical `iss`/`azp`/claim-shape with a baseline fixture, and assert `_verified_user_id` accepts
  each (and with `CLERK_AUTHORIZED_PARTIES` set to the minting origins, still accepts; wrong `azp` rejects).
  This proves the UNCHANGED backend accepts any token with the widget-baseline shape — reducing the live
  question to "do the custom flows produce that shape."
- Offline (frontend): `jwt-parity.test.ts` proves the comparator (`iss` + `azp` + sorted-claim-key shape;
  diff naming).
- Flip time (the honest live half): in the spike panel, sign in once with the **prebuilt widget** (unchanged
  `/sign-in`), open `/dev/auth-spike`, tap "capture baseline" (stores `claimShape(decodeJwtPayload(await
  getToken()))`); then per custom flow, tap "compare" — the panel shows PASS/DIFF and the decoded `iss`/`azp`
  on screen (Copy button, like NativeAuthDiag). Expected: `azp` = the minting request Origin
  (`https://localhost` on native; the web origin on web) and NOT anything provider-derived — confirming §7's
  claim. Record observed `azp` value(s) verbatim in the verdict (input to the future `CLERK_AUTHORIZED_PARTIES`
  allowlist). "Ping backend" button per flow must return 200 from an existing authenticated endpoint.

**Gate 2 — NATIVE BRIDGE PARITY (flip-time on-device, mechanism argued offline).**
The FAPI hooks are provider-level `window` globals consumed by clerk-js's FAPI client, so headless calls
traverse the identical path by construction (epic §2.1). On-device (sim + TestFlight, flip-time checklist):
after a custom email+password sign-in, `NativeAuthDiag` must read `native-sent:true`, `auth-hdr:true`; kill +
relaunch → `tok:true`, `signed:true` (cold-start restore). The existing `native-token-store.test.ts` already
covers persistence mechanics offline; no new offline test needed beyond keeping it green.

**Gate 3 — SIGN-OUT CLEARS KEYCHAIN VIA THE CENTRAL OBSERVER (offline test + on-device).**
New `frontend/src/components/ClerkTokenBridge.test.tsx` (`// @vitest-environment jsdom`, mirroring the repo's
component-test style): mock `@clerk/react`'s `useAuth`, `@capacitor/core` (`isNativePlatform → true`),
`@/lib/native-token-store`, `@/lib/auth-token`. Rerender the bridge through auth-state sequences and assert:
1. `isLoaded:true, isSignedIn:true` → `isSignedIn:false` ⇒ `clearNativeToken` called exactly once (the
   wasSignedIn-guarded transition);
2. cold start `isSignedIn:false` initial ⇒ never called (restore not clobbered);
3. same transition with `isNativePlatform → false` ⇒ never called.
On-device flip-time: headless `signOut()` from the spike panel → diag `signed:false`, `tok:false`; relaunch →
still signed out (Keychain entry gone). **No per-site clears are added anywhere in the diff — reviewer checks
this explicitly.**

**Gate 4 — CREDENTIAL NO-LOG GREP GATE (offline).**
`frontend/scripts/assert-no-credential-log.mjs` (importable predicate + CLI, exactly the
`assert-no-auth-bypass.mjs` pattern, proven by `no-credential-log.test.ts`): scans `src/lib/auth-spike/`,
`src/components/auth-spike/`, `src/components/AuthProvider.tsx`, `src/components/ClerkTokenBridge.tsx` and
fails if any `console.*(...)`, `setAuthDiag(...)`, or template/string-concat argument references identifiers
matching `/password|idToken|identityToken|rawNonce|\btoken\b/` (allowlist: boolean/diag fields like
`tokenRestored`). Nonce **binding** half: `native-social.test.ts` asserts the nonce is forwarded into
`SocialLogin.login()` options and that `verifyIdTokenNonce` rejects a token whose `nonce` claim mismatches —
the anti-replay binding we can enforce client-side; whether Clerk FAPI additionally accepts/validates a nonce
is recorded at flip time (the installed `oauth_token_apple` create params take no nonce field — documented as
such, not assumed verified).

**Gate 5 — FALLBACK SAFETY (resolved by construction + documented constraint).**
`frontend/ios` has **no `.entitlements` file and no Associated Domains** today ⇒ a Universal-Link callback
does not exist, so the system-browser redirect fallback is **NOT SHIPPABLE** in the current app: the ID-token
path is REQUIRED (custom URL schemes are explicitly forbidden — scheme-hijack risk). The spike implements no
browser fallback. The verdict documents the fallback's precondition (Associated Domains entitlement + AASA on
the web domain + Clerk redirect config) as a named constraint should the ID-token path fail at flip time — in
which case the spike verdict is CONSTRAINED-GO/NO-GO, not "quietly ship the scheme fallback."

**Auth-bypass guard integrity:** `scripts/assert-no-auth-bypass.mjs` and its tests are untouched;
`auth-gate-routes.test.ts` additionally proves flag-off route behavior is identical to today, and that the
spike prefixes gate only `/dev/auth-spike` + `/sso-callback` (pages that render no protected children) — a
spike route cannot become an auth bypass.

---

## 7. Build sequence for the builder

1. `spike-flag.ts` + `AuthGate` prefix change + `auth-gate-routes.test.ts` (prove zero-change first).
2. `jwt-parity.ts` + `nonce.ts` + tests (pure libs, no Clerk).
3. `AuthSpikePanel.tsx` + `/dev/auth-spike` route: email+password / email-code sign-in+up (§3.1), sign-out,
   baseline/compare readout, backend ping, embedded `NativeAuthDiag`.
4. `/sso-callback` route + Google web `signIn.sso` branch (§3.2).
5. Install `@capgo/capacitor-social-login@^8.3.35`, `npx cap sync ios`; `native-social.ts` wrapper +
   Google/Apple native branches (§3.3–3.4) + mocked tests; run `npm run test:native-crash` (plugin present
   must not crash the webview).
6. `ClerkTokenBridge.test.tsx` (gate 3), `assert-no-credential-log.mjs` + test (gate 4).
7. `backend/tests/test_clerk_jwt_parity.py` (gate 1 offline).
8. `specs/auth-headless-spike-verdict.md` with observed evidence (web-dev email flows CAN be exercised live
   now against the existing dev Clerk instance — email+password/code and headless signOut are
   dashboard-independent; do so and record it) + the flip-time checklist (Google/Apple live round-trips,
   on-device matrix, azp capture, Info.plist/entitlement edits, `iOSServerClientId` audience confirmation).
9. `/security-review` on the diff (new flows + new native plugin), then gates.

## 8. Gate commands (all must pass before the item is done)

```
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd frontend && npm run build                          # default build — flag OFF, prebuild bypass-guard runs
cd frontend && NEXT_PUBLIC_AUTH_SPIKE=1 npm run build # flag build compiles + exports
cd frontend && npx vitest run                          # incl. all new tests
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && node scripts/assert-no-credential-log.mjs
cd frontend && npm run test:native-crash               # webview crash check with plugin installed
cd backend  && ruff check .                            # DB-backed pytest runs in CI; test_clerk_jwt_parity is DB-free
```

## 9. Edge cases and risks

- **Future-API vs classic-API split** (§0a) — the named constraint for Slice 2; if the Future API's
  `finalize()` fails to set the active session in the Capacitor webview, fall back to classic `clerk.client.*`
  + `clerk.setActive` and record it.
- **Google native audience config** — `iOSServerClientId` must equal the Clerk-configured web client ID or
  `authenticateWithGoogleOneTap` rejects the token (flip-time; epic risk #1). NO-GO trigger if unresolvable.
- **Apple returns email/name only on first-ever auth** — irrelevant for session creation, but note for
  onboarding (Slice 4) name prefill.
- **`/sso-callback` transfer case** (Google account with no Clerk user) — handled by
  `AuthenticateWithRedirectCallback`; verify sign-up transfer lands signed-in.
- **Enumeration hygiene / rate limits** — ugly UI still maps Clerk error codes to uniform copy; no client
  retry loops (epic §6).
- **Static export** — every Clerk-hook component behind `dynamic(...,{ssr:false})`; the flag-off stubs are
  plain static pages, so `next build` prerender cannot touch Clerk.
- **Session token claim version drift** (Clerk v2 session claims: `fva`, `sts`, etc.) — parity compares
  claim-key shape so drift between flows is caught; drift vs an outdated fixture is corrected by re-capturing
  the widget baseline, which is the defined baseline.
- **`signOut()` on web dev** — observer is native-gated; web assertion is only `isSignedIn:false`.

## 10. GO/NO-GO rubric (verdict file must conclude with exactly one)

- **GO:** email+password/code sign-in AND sign-up + headless signOut work live on web dev against the real
  dev Clerk instance; all offline gates 1/3/4 tests green; gates run clean; plugin installed without webview
  crash; JWT-parity comparator + backend parity tests prove the unchanged backend accepts baseline-shaped
  tokens; ID-token call paths compile against the pinned installed types; flip-time checklist written. (Native
  SSO live proof explicitly deferred to flip time — GO means "headless is architecturally proven and nothing
  observed contradicts it.")
- **CONSTRAINED-GO:** headless email flows proven, but a named constraint exists — e.g. Future API required a
  classic-API fallback, or the Google audience wiring shows a plausible failure mode — with the constraint and
  its epic impact (Slice 2/OAuthButtons design) written down.
- **NO-GO:** any of — headless flows cannot mint a session the unchanged backend verifies; the FAPI native
  hooks demonstrably don't fire for headless calls; the sign-out observer doesn't fire after headless
  `signOut()`; or the ID-token strategies are absent/broken in the installed clerk-js AND a bump breaks the
  build. NO-GO must name the exact failing call + error.

**Sources verified via web:** Clerk Expo Sign in with Google (web-client-ID audience requirement, nonce),
Clerk Expo Sign in with Apple (Native Applications + dashboard config), Clerk native Apple changelog
(2025-11-13), Clerk Google One Tap custom flow, capgo social-login repo/README + docs (`initialize`/`login`
shapes, `result.idToken`, nonce option, iOS setup), npm `@capgo/capacitor-social-login` 8.3.35. All
clerk-js/react signatures were pinned from the installed packages' `.d.ts` files, not docs.
