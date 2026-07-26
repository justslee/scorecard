# P0 — Login blocked on TestFlight v1.1.22 — fix plan (revised after simulator falsification)

Branch `p0-login-fix` (base `bc2ceeb`). Owner report, sign-in screen screenshot: "This logging thing is blocking me from logging in." AUTH DIAG readout: `loaded=true, signed=false, native-sent=true, auth-hdr=false (red), tok=true, napi=true, origin=capacitor://localhost, path=/v1/client`.

**There is ONE real defect.** The suspected second defect (a persisted stale Clerk client JWT wedging all FAPI requests) was FALSIFIED by an iOS-simulator reproduction from current source with the real pk_live key (eng-lead sim run, 2026-07-26, iPhone 17 sim).
This plan: (1) fixes the real blocker — the diag panel ships in production builds and occludes the sign-in controls; (2) makes the dev diagnostic honest so it cannot manufacture phantom defects again; (3) corrects two false docs; (4) files one follow-up experiment. No backend changes. Shared types untouched (`frontend/src/lib/types.ts` <-> `backend/app/models.py`).

---

## The defect — the AUTH_DIAG panel ships in Release/TestFlight builds and occludes sign-in

### Root cause (confirmed in code)
`frontend/src/components/NativeAuthDiag.tsx:89-90,140`:

```ts
const isNative = Capacitor.isNativePlatform();
const authDiagEnabled = process.env.NEXT_PUBLIC_AUTH_DIAG === "1";
...
if (!isNative && !authDiagEnabled) return null;
```

The gate is "native OR opt-in" — a deliberate auth-spike-era leftover, not an env-flag leak — so the panel renders on EVERY native build, including TestFlight. It is imported unconditionally in `frontend/src/app/sign-in/[[...sign-in]]/SignInClient.tsx:21-24` via `dynamic(..., { ssr: false })`.

### Why it blocks login (simulator screenshot evidence)
The panel is position:fixed at the bottom (left 8 / right 8, zIndex 9999, pointerEvents "auto" — NativeAuthDiag.tsx:144-163) and occupies the entire bottom third of the screen. The sign-in sheet holding the auth controls is the bottom ~38% (`frontend/src/components/auth/SignInScreen.tsx:310-319`).
In the sim screenshot only the "Continue with Apple" pill is visible above the panel; the Google button, the divider, the email/password form and the caption are ALL underneath it, and pointerEvents:auto means the panel intercepts their taps. The owner sentence — "This logging thing is blocking me from logging in" — is literally true. The panel is also a Northstar violation: loud SaaS-debug chrome on the calm yardage-book sign-in screen.

### Falsified: the "stale-token wedge" hypothesis (recorded so nobody re-investigates it)
Evidence chain (sim run from current source, real pk_live, + code reading):

1. **`auth-hdr=false` is an ordering artifact, not a rejection signal.** `authHeaderReceived` is a single module-global overwritten by every FAPI response (`nativeOnAfterResponse`, AuthProvider.tsx:97-130). `/v1/environment` responses carry NO authorization header while `/v1/client` responses do (probe: header count 0 vs 1), so the transient false appears in every healthy run.
   Worse, `lastFapiPath` is written by the BEFORE hook while `authHeaderReceived` is written by the AFTER hook, so the two fields routinely describe DIFFERENT requests — the owner readout pairing (`auth-hdr=false ... path=/v1/client`) is meaningless.
2. **The wedge does not reproduce.** Poisoning the Keychain via the `migrateFromPreferences()` legacy path with (a) a well-formed JWT with exp in 2023 and (b) literal garbage produced `tok=true` and then a fully HEALTHY readout (`auth-hdr=true`). Direct FAPI probes: `GET /v1/client?_is_native=1` with empty, stale-JWT, or garbage authorization ALL return HTTP 200 **plus a fresh authorization header minting a brand-new client**.
   Clerk ignores an unusable client token and issues a new one; `nativeOnAfterResponse` then persists the fresh header via `setNativeToken()` on the first `/v1/client` response of every launch — **self-healing by overwrite**, confirmed across relaunches. Although nothing clears a token on rejection, nothing needs to: a bad value cannot survive the first request.
3. **Not a v1.1.22 regression.** `git diff --stat 7a50218..bc2ceeb -- frontend/src` = one line in `frontend/src/lib/caddie/types.ts`. Zero auth-adjacent frontend changes in the shipped bundle.
4. **`origin=capacitor://localhost` is expected and NOT causal.** Capacitor iOS rejects `iosScheme: "https"`: `CAPInstanceDescriptor.swift:167-175` accepts a scheme only when `WKWebView.handlesURLScheme(scheme) == false`, which is TRUE for https, so the scheme silently resets to the default `capacitor` (`InstanceDescriptorDefaults.scheme`). Confirmed three ways: the sim launch log ("Loading app at capacitor://localhost"), the on-screen panel, and the framework binary.
   This has been the origin through ALL history — including v1.0.369, when native auth was verified green end-to-end on this exact origin — and Clerk allowed_origins includes both `https://localhost` and `capacitor://localhost` (backlog-archive.json:982). The comment at `frontend/capacitor.config.ts:9-16` describes a state that has never existed on iOS. FAPI also returns `access-control-expose-headers: Authorization, X-Country`, so the CORS rationale for CapacitorHttp in that file is weaker than claimed. Fix the COMMENTS only.
5. **One residual untested case** — filed as a follow-up experiment (section 5), NOT this cycle: a REAL previously-valid, now-REVOKED client JWT carries a genuine client_id + rotating_token, and Clerk rotating-token reuse detection could behave differently from how it treats an unparseable token. Unproven either way; the sim only exercised expired/garbage tokens.

---

## 1. Fix — hard build-time exclusion of the panel (the release blocker)

### Mechanism
**`frontend/src/app/sign-in/[[...sign-in]]/SignInClient.tsx`** — make the dynamic import itself build-time conditional, with the env test INLINE in the conditional:

```tsx
const NativeAuthDiag =
  process.env.NEXT_PUBLIC_AUTH_DIAG === "1"
    ? dynamic(() => import("@/components/NativeAuthDiag"), { ssr: false })
    : null;
...
{NativeAuthDiag ? <NativeAuthDiag /> : null}
```
**Why this survives Next.js static export and is a true build-time exclusion:** `NEXT_PUBLIC_*` values are inlined at build time; with the flag unset the condition is a compile-time constant false, and the bundler (webpack ConstPlugin / Turbopack equivalent) eliminates the dead branch at PARSE time — before the chunk graph is built — so the `import()` never emits an async chunk into `out/`, the static export that `npx cap sync ios` copies into the shipped app. The component and its strings are absent from the bundle, not merely hidden.
Do NOT hoist the condition into a named const (parse-time dead-branch elimination fires only on inline constant conditions). If the postbuild scan (below) still finds an emitted chunk under the ternary form, fall back to a statement-form `if (process.env.NEXT_PUBLIC_AUTH_DIAG === "1") { ... }` module-scope assignment — **the scan is the arbiter, not the mechanism**.

Companion changes:
- **`NativeAuthDiag.tsx`** — drop the `isNative` arm of the runtime gate (that arm IS the bug); keep `if (!authDiagEnabled) return null` as a second belt-and-suspenders layer. Update the header comment.
- **`frontend/src/lib/auth-diag.ts:74-85`** — the `setAuthDiag` console mirror prints the full auth-state JSON as `[authdiag] {...}` to the device log on every FAPI request in shipped builds. Wrap it in `if (process.env.NEXT_PUBLIC_AUTH_DIAG === "1")` so it compiles out of production (no secrets are logged today, but auth-state telemetry does not belong in a prod device log). The state store itself stays — AuthProvider writes it; it is inert without a reader.
- **`AuthProvider.tsx:151`** — the `console.error("[authdiag] native FAPI hook registration failed")` is a genuine error path worth keeping in prod; rename the prefix to `[auth]` so the bundle scan can stay strict on the string `authdiag`.

### Proof — NEW `frontend/scripts/assert-no-auth-diag.mjs`
Follows the `assert-no-auth-bypass.mjs` / `assert-no-credential-log.mjs` precedent (importable predicate + CLI entrypoint, tested like `frontend/src/lib/build-guards.test.ts`):
- Recursively scans `out/` (`.js`, `.html`, `.txt`) for markers: `authdiag` (case-insensitive), `Looper Auth Diagnostic` (the copy-button text), `Auth diag` (the panel header).
- Exit 1 (build blocked) if any marker is found while `NEXT_PUBLIC_AUTH_DIAG` is not `1`.
- If the flag IS set (a legitimate dev/sim diag build): exit 0 with a loud "DIAG BUILD — NOT SHIPPABLE" warning.
- Wired as **`postbuild`** in `frontend/package.json` (the existing `prebuild` slot runs `assert-no-auth-bypass.mjs` BEFORE the build; a bundle grep must run AFTER `next build` emits `out/`). npm runs postbuild automatically after `build`, so both the CI build step and the real prod build (`ops/ios/ship.sh:89` runs `npm run build`) prove the exclusion on every build. ship.sh sets only API_URL / Clerk pk / Maps key — never the diag flag — so every shipped bundle is scan-proven clean.

## 2. Fix — make the dev diagnostic honest and non-occluding (it stays, dev-only)

The diagnostic manufactured a phantom P0. Since we keep it for dev/sim validation, it must stop lying:
- **`auth-diag.ts`** — replace the global `authHeaderReceived` + free-floating `lastFapiPath` with an ATOMIC per-response record written only by the after-hook: `lastResponse: { path, status, authHeaderPresent }`, plus a small per-path map (at minimum `/v1/client`) so the panel can show `auth-hdr(/v1/client)` — the only value that means anything. The before-hook keeps its own `lastRequestPath` field, clearly named as a REQUEST field.
- **`NativeAuthDiag.tsx`** — render the per-path values with response status codes; label rows so a screenshot cannot conflate request/response fields again.
- **Non-occluding in dev:** default to a COLLAPSED chip (small mono "diag" pill above the safe area, right-aligned) that expands to the full readout on tap and collapses again — never a fixed full-width slab over the sign-in controls. (AuthProvider hook logic is otherwise untouched — no token-flow changes ride this P0.)

## 3. Fix — doc truth
- **`frontend/capacitor.config.ts`** (comments only, zero runtime effect): the `server.iosScheme` block claims the WebView origin is `https://localhost` — false on iOS forever (Capacitor silently falls back to `capacitor`, cite CAPInstanceDescriptor.swift:167-175). Also soften the CapacitorHttp CORS claim: FAPI exposes `access-control-expose-headers: Authorization, X-Country`, so header readability is not the sole reason CapacitorHttp exists. Do NOT change `iosScheme` itself or disable CapacitorHttp in this P0.
- **`frontend/ios/SIMTEST.md`** — step 2 builds with `CODE_SIGNING_ALLOWED=NO`, which cannot write the Keychain (errSecMissingEntitlement, OSStatus -34018), so `tok` can never read true under it. Correct to `CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES` for any Keychain-touching sim test, and document that diag builds now require `NEXT_PUBLIC_AUTH_DIAG=1` exported before the build step (the panel and `[authdiag]` log stream no longer exist otherwise).

## 4. Explicitly OUT of scope for this P0
- Any change to token injection/clearing in `AuthProvider.tsx` / `native-token-store.ts` / `sign-out-teardown.ts` / `ClerkTokenBridge.tsx`. The wedge is disproven; changing auth internals on a release-blocking hotfix with no proven bug is the wrong trade.
- Any `iosScheme` change (WebView storage repartition + Clerk origin allowlist = high blast radius). Annotate only.

## 5. Follow-up backlog item to FILE (write-up only, not this cycle)
`clerk-native-revoked-client-token-probe` (LOW): the one untested case — a real, previously-valid, now-REVOKED Clerk client JWT (genuine client_id + rotating_token) might trip rotating-token reuse detection and get a 401 WITHOUT a fresh authorization header, unlike expired/garbage tokens (sim-proven self-healing).
Experiment to close it: credentialed sim session (signed Keychain build), then revoke the client/sessions server-side via the Clerk Backend API, relaunch, and capture the status + headers of the first `GET /v1/client` carrying the stale JWT. Only if it wedges: design a clear-on-definitive-reject at the FAPI after-hook seam (compare-and-clear of the exact sent token), NOT at the React seam — folding it into ClerkTokenBridge would fight the cold-start-restore guard at ClerkTokenBridge.tsx:39-42.

---

## Files to touch
| File | Change |
|---|---|
| `frontend/src/app/sign-in/[[...sign-in]]/SignInClient.tsx` | build-time-conditional dynamic import |
| `frontend/src/components/NativeAuthDiag.tsx` | flag-only gate; honest labeled rows; collapsed-chip default |
| `frontend/src/lib/auth-diag.ts` | atomic per-response record + per-path map; console mirror gated behind the flag |
| `frontend/src/components/AuthProvider.tsx` | diag WRITE-sites updated to the new record shape; `[authdiag]` prefix renamed `[auth]`; token flow untouched |
| `frontend/scripts/assert-no-auth-diag.mjs` (NEW) | bundle-scan proof |
| `frontend/package.json` | add `postbuild` |
| `frontend/src/lib/build-guards.test.ts` | cover the new assert script |
| `frontend/capacitor.config.ts` | comment-only truth fix |
| `frontend/ios/SIMTEST.md` | signing flags + diag-flag docs |
| `backlog.json` | file `clerk-native-revoked-client-token-probe` |

Shared types: none touched.

## Tests (Vitest)
- `assert-no-auth-diag.mjs`: pure predicate on fixture strings + CLI exit codes (clean dir → 0; marker present → 1; marker present with flag set → 0 + warning) — mirrors `build-guards.test.ts`.
- `auth-diag` shape tests: an environment-response (no auth header) followed by a client-response (auth header) leaves `auth-hdr(/v1/client)=true` and a `lastResponse` whose path matches what it describes — the regression test for the exact artifact that manufactured this phantom defect.
- `NativeAuthDiag` component test: renders null when the flag is unset; renders the collapsed chip (not the full slab) when set.
- Existing suites must stay green untouched: `SignInScreen.test.tsx`, `useAuthFlow.test.ts`, `ClerkTokenBridge.test.tsx`, `sign-out-teardown.test.ts`, `native-token-store.test.ts`.
- Manual/sim verification: unflagged build → sign-in screen with NO panel, `out/` scan clean; flagged build → chip renders, expands, log stream present.

## Edge cases and risks
- **White-screen (the v1.0.365 history):** the import change is confined to SignInClient; `ssr:false` + the `PaperShell` loading placeholder are untouched; NativeAuthDiag was never rendered during prerender. The auth-diag record-shape change touches only diag WRITE calls inside the already-guarded async hooks — worst case a diag field is stale, never a render-path throw. Token flow is byte-identical.
- **Cannot lock the owner out worse:** no auth logic changes. The only behavioral change on his device is the panel disappearing.
- **Bundler still emits the diag chunk:** the postbuild scan fails the build; apply the statement-form fallback. The assertion, not the mechanism, is the guarantee.
- **Losing on-device TestFlight diagnosis:** accepted and intended (Northstar); flagged dev/sim builds retain the tool.
- **Turbopack vs webpack (Next 16):** both inline env constants and drop dead branches; verified empirically by the scan either way.

## Gates (all must pass before done)
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm run build` — now also runs the `postbuild` assert-no-auth-diag scan (the proof)
- `cd frontend && npx vitest run`
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`
- `cd backend && ruff check .` (no backend changes; still run)
- `/security-review` + `/code-review` (auth-surface adjacency — mandatory per CLAUDE.md)

## What the owner must do on his device
1. **Nothing destructive — do NOT delete or reinstall the app.** No settings change, no Clerk Dashboard action.
2. When the fixed build lands on TestFlight: update and open the app. The debug panel will be gone — that is the fix, not a missing feature.
3. **CORRECTED during implementation (builder, 2026-07-26):** both OAuth buttons are hard-disabled in this build (`frontend/src/components/auth/OAuthButtons.tsx` has a local `const OAUTH_LIVE = false` — enabling SSO is blocked on credentials that don't exist in this repo, untouched by this P0). The owner's ONLY working path is tapping **"Continue with email"**, which currently sits underneath the diag panel. Use that button and sign in normally. The auth path itself was verified healthy in the simulator (a stale or garbage stored token is overwritten by a fresh one on the first request of every launch), so once the panel stops covering the button, sign-in should just work.
4. If sign-in STILL fails with the panel gone, that is new signal — it would point at the one untested residual case (revoked-client rotating-token, section 5) and we run that experiment immediately.

## Northstar note
Removing the panel from shipped builds restores the calm, on-paper sign-in screen. The panel was loud SaaS-debug chrome overlaying the primary action — a direct Northstar violation in addition to being the functional blocker.
