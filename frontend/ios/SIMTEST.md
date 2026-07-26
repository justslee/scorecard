# Sim-testing Looper (no device, no owner)

How to build, run, and read auth state from the Looper Capacitor iOS app in the
**iOS Simulator** — so a new build can be validated **without the owner** and
without a TestFlight round-trip. No credentials are needed to confirm the app
loads, reaches the sign-in screen, and that the auth diagnostic renders/logs.

**The auth diagnostic panel and its `[authdiag]` log stream are now dev/sim-only**
(P0 login-blocked fix, specs/p0-login-blocked-plan.md §1 — the panel used to
render on every native build, including TestFlight, and occluded the sign-in
controls). For a diag build, export `NEXT_PUBLIC_AUTH_DIAG=1` **before** step 1's
`npm run build`; without it, the panel and the log stream do not exist in the
bundle at all (proven by `scripts/assert-no-auth-diag.mjs`, wired as `postbuild`).

App id: `com.looperapp.app` · webview origin: `capacitor://localhost`
The Clerk publishable key is public (it ships in `ops/ios/ship.sh`); export the
same one so the build matches TestFlight.

## 0. One-time

```sh
xcrun simctl list devices available | grep iPhone   # pick a booted-capable device
xcrun simctl boot "iPhone 17"                        # or any name from the list
open -a Simulator
```

## 1. Build the web bundle + sync into the iOS project

```sh
cd frontend
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_live_Y2xlcmsubG9vcGVyYXBwLm9yZyQ"
export NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
export NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/ NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/
export NEXT_PUBLIC_AUTH_DIAG=1   # opt in to the on-screen diag panel + log stream for THIS sim build only — never set for a real/TestFlight build
npm run build            # static export -> frontend/out
npx cap sync ios         # copies out/ -> ios/App/App/public, updates plugins
```

## 2. Build the app for the simulator

CORRECTION (P0 login-blocked fix, specs/p0-login-blocked-plan.md §3):
`CODE_SIGNING_ALLOWED=NO` cannot write the Keychain (errSecMissingEntitlement,
OSStatus -34018) — `tok` can never read `true` under it, which makes any
Keychain-touching auth test unreliable. For a Keychain-touching sim test, sign
with an ad-hoc identity instead:

```sh
cd frontend
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath /tmp/looper-sim -skipPackagePluginValidation \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES build
```

(`CODE_SIGNING_ALLOWED=NO` is still fine for a quick load/render check that
doesn't touch the Keychain — just don't trust `tok` under it.)

## 3. Install + launch, capturing the JS console

The Capacitor `Console` plugin patches `console.*` on iOS and prints to the app's
**stdout** (Swift `print`, prefixed `⚡️  [log] -`). `xcrun simctl spawn … log
stream` does NOT capture stdout — you must use `launch --console-pty`:

```sh
APP=$(find /tmp/looper-sim/Build/Products -name App.app -type d | head -1)
xcrun simctl uninstall booted com.looperapp.app 2>/dev/null
xcrun simctl install booted "$APP"

# Launch with the console attached; it streams until the app is killed.
xcrun simctl launch --console-pty booted com.looperapp.app > /tmp/looper-stdout.txt 2>&1 &
LP=$!; sleep 13; kill $LP 2>/dev/null

xcrun simctl io booted screenshot /tmp/looper-screen.png   # visual confirm
grep -a authdiag /tmp/looper-stdout.txt                    # read auth state
```

### Reading auth state from the log

Every diagnostic update is mirrored to the console as a single line:

```
⚡️  [log] - [authdiag] loaded=true signed=false native-sent=false auth-hdr=— tok=false napi=true
⚡️  [log] - [authdiag] {"tokenRestored":false,"nativeApiDisabled":false,...}
```

- `loaded=true`            Clerk JS initialised (UI components loaded) — app is up.
- `signed=false`           no session yet (expected before sign-in).
- `native-sent`            true once the native FAPI before-request hook fired.
- `auth-hdr` / `tok` / `napi`  see `src/components/NativeAuthDiag.tsx` for meanings.

A healthy DIAG build (`NEXT_PUBLIC_AUTH_DIAG=1` at step 1) shows `loaded=true`
and the sign-in screen + a small collapsed "diag" chip in the screenshot — tap
it to expand the full readout (it no longer renders as a full-width slab; a
real/non-diag build shows neither the chip nor the log lines at all). If you
instead see **"Application error: a client-side exception has occurred while
loading localhost"**, the web bundle threw on load — capture the real error
with the headless harness below.

## 4. Headless fallback — capture the real JS exception

The simulator only shows the minified production error. To get the actual thrown
error + stack, run the **same production bundle** through Chromium with the
Capacitor native code path forced on:

```sh
cd frontend
npm run build            # ensure frontend/out is current
node ios/simtest-headless.mjs
```

It serves `out/`, fakes `window.webkit.messageHandlers.bridge` (so
`Capacitor.isNativePlatform()` is true and the native code path executes), loads
the page, and prints `[PAGEERROR] …` with the unminified message + stack plus all
console output. This is how the v1.0.365 crash was identified as
`Error: Clerk was not loaded with Ui components`. (FAPI/CORS warnings in this
harness are artifacts of the `http://localhost` origin and not the crash.)

## Notes

- Debug vs Release only changes the Swift wrapper; the JS bundle is identical to
  TestFlight's, so a crash reproduced here reproduces on TestFlight.
- Sign-in cannot be completed in-sim without real Clerk credentials. Everything
  up to and including the rendered sign-in form + diagnostic is testable without
  them. For a credentialed run, sign in by hand in the simulator and watch the
  `[authdiag]` lines flip `signed`/`native-sent`/`auth-hdr`.
