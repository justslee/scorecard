# Passive Shot Tracking — Feasibility Spike: Findings & Recommendation

**Status:** SPIKE complete. Branch `spike/passive-shot-tracking` (base `main`).
**Plan:** `specs/passive-shot-tracking-spike-plan.md`.
**This document is the primary deliverable.** The prototype (`lib/spike/shot-drift.ts` +
tests + a dev-flag-gated banner + a motion-probe rider) is throwaway evidence in support
of the recommendation below, not shippable code as-is.

**Locked product direction this spike does not revisit:** passive tracking = detect that a
full swing happened → produce a DRAFT → golfer confirms/edits BY VOICE → confirmed shots
feed dispersion stats. Never silently auto-score. Never attempt putt detection.

---

## TL;DR recommendation

| Signal | Verdict | Confidence |
|---|---|---|
| Phone-only swing detection (motion, Q1) | **Don't build.** Sample-rate ceiling AND the phone-in-pocket/practice-swing problem are both independently fatal — fixing one doesn't fix the other. | High |
| GPS-delta draft prompting (Q3) | **Build now.** Feasible with zero new native code/permissions, coarse (±10-20y) but plenty precise to *prompt a draft*, which is all the product needs — the golfer supplies the club and confirms by voice. | High |
| Apple Watch swing detection (Q2) | **Real, but large.** The only path to true swing detection. Requires a brand-new native watchOS target this repo does not have. Defer to a scoped Phase-N investigation, not this spike. | High |
| Sensor-based carry estimation (Q4) | **Infeasible. Close it.** Standard IMU double-integration drift; the phone isn't on the club or ball anyway. | High |

The prototype proves the GPS-delta half of this table end-to-end (classifier → draft →
existing voice affordance) and the motion-probe rider proves the WKWebView permission path
is *not* the dead end the plan expected — see the Capacitor grep finding below, which
changes *why* Q1 fails (it's not "permission dead-ends," it's "the signal itself is
useless"), without changing the verdict.

---

## Q1. Can a full swing be detected phone-only? — **No, not reliably.**

### Q1a. The WKWebView `DeviceMotionEvent` permission path — an actual finding, not speculation

The plan flagged this as an open risk ("silent deny is a real possibility... may be
dead-on-arrival"). I grepped `frontend/node_modules/@capacitor/ios` directly rather than
assuming:

```
frontend/node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift:60-65

open func webView(_ webView: WKWebView,
                  requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                  initiatedByFrame frame: WKFrameInfo,
                  decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    decisionHandler(.grant)
}
```

**Finding: Capacitor 8's bridge (`WebViewDelegationHandler`, `WKUIDelegate` conformance)
already implements `webView(_:requestDeviceOrientationAndMotionPermissionFor:initiatedByFrame:decisionHandler:)`
and unconditionally grants.** Since iOS 15 (our deploy target), WKWebView requires the host
app to implement this delegate method or it denies device-motion access outright with no
prompt at all (confirmed via WebKit/community sources below) — so the plan's worst case
("dead on arrival") does **not** apply here. `DeviceMotionEvent.requestPermission()` called
from our app should resolve `"granted"` on a real device, likely without the user ever
seeing a system dialog, because Capacitor auto-approves at the delegate layer before
WebKit's own UI would show one. This is a genuinely useful, unexpected result: it means
**the permission plumbing is not what blocks phone-only swing detection.** The other two
problems below are what block it, and neither is fixable by permission.

Citations:
- Apple, `WKUIDelegate.webView(_:requestDeviceOrientationAndMotionPermissionFor:initiatedByFrame:decisionHandler:)` — https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:requestdeviceorientationandmotionpermissionfor:initiatedbyframe:decisionhandler:)
- Community confirmation that since iOS 15, WKWebView denies devicemotion/deviceorientation outright unless the host implements this exact delegate method (matches what the grep shows Capacitor does) — https://github.com/orgs/home-assistant/discussions/4257, https://developer.apple.com/forums/thread/734869
- `DeviceMotionEvent.requestPermission()` must be invoked from a user gesture (iOS 13+ requirement) — https://dev.to/li/how-to-requestpermission-for-devicemotion-and-deviceorientation-events-in-ios-13-46g2, MDN `DeviceMotionEvent.requestPermission` (referenced from the same search cluster)
- One source claims WKWebView historically didn't gate motion behind `requestPermission()` at all (only MobileSafari did) — https://docs.expo.dev/versions/latest/sdk/devicemotion/. This is consistent with our finding: Capacitor's delegate implementation is *why* our shell behaves like "granted," whether or not WebKit even shows the JS-visible permission gate. Either way the practical outcome for us is the same: **motion events will flow if we ask.**
- `Info.plist` reality check (per the plan): `frontend/ios/App/App/Info.plist` has `NSLocationWhenInUseUsageDescription` only, no `NSMotionUsageDescription`. Apple's docs list `NSMotionUsageDescription` as required for **native CoreMotion** access (`CMMotionManager`) — https://developer.apple.com/documentation/BundleResources/Information-Property-List/NSMotionUsageDescription. Whether the WebKit-level `devicemotion` JS event additionally requires it in a Capacitor shell was not resolved by search (sources conflict on whether it's WKWebView-relevant vs. native-only) — flagged as an **open question requiring an on-device test**, not resolved on paper. It does not change the verdict below either way.

**Sample-rate ceiling.** Multiple sources agree WebKit fires `devicemotion` at browser/OS-
imposed caps around 50-60Hz for fingerprinting-resistance reasons (down from raw sensor
rates of 100-200Hz+) — https://developer.mozilla.org/en-US/docs/Web/API/Window/devicemotion_event,
https://github.com/w3c/sensors/issues/98. Nyquist gives a real signal ceiling around
25-30Hz. Club-ball impact is a sub-millisecond transient (contact duration ~0.5ms,
clubhead speed 80-110mph for a driver) that is **fully aliased away** at 60Hz even in the
best case — and the phone isn't on the club to begin with (see Q1b). This ceiling is a
real, cited constraint, but it turns out not to be the binding one — Q1b is.

### Q1b. The phone-in-pocket/bag problem — the actual killer, independent of sample rate

During a swing the phone rides the torso (pocket) or sits stationary (bag/cart), not the
club. At the torso: ~1-2Hz rotation, low-g accelerations, heavily damped by clothing and
soft tissue. This signal is ambiguous in ways sample rate cannot fix:

- **Practice swings are kinematically identical to real swings at the torso.**
  Distinguishing "swung and struck the ball" from "took a practice cut" requires knowing
  the ball was struck — information the pocket sensor structurally cannot see. This is not
  a tunable-threshold problem; it is a missing-signal problem. **Unfixable phone-only.**
- **Phone in bag/cart = zero signal**, not a false positive but a **miss** — the golfer
  swings, nothing fires, trust in the feature erodes immediately (worse for a "quiet,
  calm" product than an occasional wrong prompt).
- Walking cadence, bending to tee/mark/read putts, handling the phone (checking yardage
  mid-hole), and cart vibration all produce torso accelerations in a similar low-g band —
  seeAppendix §6 (false-positive taxonomy) below.

### Q1c. Would native CoreMotion (a custom plugin) fix it? — No, and it's not worth building

`CMMotionManager` can deliver `CMDeviceMotion` at up to ~100Hz on-device (not WebKit-
capped) — https://developer.apple.com/documentation/coremotion/cmmotionmanager,
https://developer.apple.com/documentation/coremotion/cmmotionmanager/devicemotionupdateinterval.
Higher rate does **not** fix Q1b: same torso, same practice-swing ambiguity, same in-bag
blindness. The cost to get there — a custom native Capacitor plugin, `NSMotionUsageDescription`,
background-motion complications, App Store review surface for a new sensor capability — buys
nothing the WebKit path doesn't already have for the one problem (sample rate) that turned
out not to be the binding constraint. **Verdict: not worth building phone-only, full stop.**

---

## Q2. Does reliable swing detection require an Apple Watch? — **Yes — and it's a large, separate investment.**

Wrist-mounted, ~100Hz+ CoreMotion sampled during an active `HealthKit` workout session is
the prior art for essentially every real golf-swing app on Apple Watch. Apple's own
watchOS 10 "high-frequency motion" API (Series 8/Ultra+) is built for exactly this —
detecting rapid velocity/acceleration changes for the moment of impact — and third-party
apps (e.g. Golfshot's "Swing ID") use it to detect the actual strike:
- WWDC23 "What's new in Core Motion" — https://developer.apple.com/videos/play/wwdc2023/10179/
- Golfshot Swing ID (uses the high-frequency motion API for the moment of impact) — https://golfshot.com/blog/coming-soon-to-your-apple-watch-new-gen-2-swing-id-metrics

**True cost given this repo, not a generic estimate:** Capacitor does not build watchOS
targets. This repo (`frontend/ios/`) has an iOS app target only — no `.xcworkspace` watch
extension, no shared Swift code for sensor logic, no `WatchConnectivity` bridge back into
the web layer. Building this means:
1. A brand-new native watchOS app target (Swift, not Capacitor/web) with its own build,
   signing, and App Store review surface.
2. A `HealthKit` workout session + the high-frequency motion API, native Swift detection
   logic (heuristics — prior art still gets false positives on practice swings even
   *on-wrist*; drafts + voice-confirm remains the right product answer there too, not a
   reason to skip it).
3. A `WatchConnectivity` bridge to get a detection event from the Watch into the existing
   web/voice draft flow.
4. **A product-level requirement that the golfer owns and wears an Apple Watch** — a real
   TAM/adoption question, not just an engineering one.

Rough order of magnitude: **weeks, with native watchOS + CoreMotion expertise this team
does not currently exercise** — not a spike-sized or even single-sprint deliverable.
**Recommendation: defer to a scoped Phase-N investigation if/when Watch ownership becomes
a real product bet, not before.**

---

## Q3. GPS-delta as the feasible phone-only signal — **Yes, coarse, ship-shaped.**

Between shots a golfer displaces roughly 100-280 yards (91-256m). Smartphone GPS accuracy
under open sky is commonly cited at **~4.9m** (GPS.gov) degrading to **~10-20m** near
trees/buildings:
- GPS.gov, GPS Accuracy — https://www.gps.gov/gps-accuracy
- Real-world degradation near obstacles cited in the same source cluster (~10-20m under
  tree cover / near structures).

Signal-to-noise for a 100-280y (91-256m) displacement against ~5-20m of positional noise is
roughly **10:1 to 50:1** — easily sufficient to **prompt a draft**, which is the entire bar
(the golfer supplies the actual club and confirms/edits by voice; the classifier never
needs launch-monitor precision).

**For carry estimation specifically:** straight-line distance between successive
stationary "hitting dwells" approximates shot length the same way the existing
`useShotTracking` hook's manual `markStart`/`markEnd` already does (same repo, same
semantic, already shipped and trusted for the shots table). Error sources the prototype's
own design has to account for, and does:
- ±5-10m per endpoint fix (two independent noisy fixes → errors don't cancel, they
  partially compound — worse than either fix alone, better than naively summing them).
- Non-straight walking path: **favorable**, not adverse — straight-line distance IS the
  quantity we want (it approximates ball flight distance), so a wandering walking path
  does not inflate the estimate. The prototype's zigzag test (`shot-drift.test.ts` #4)
  demonstrates this directly: a 40-step lateral search pattern covering meaningfully more
  ground than the straight-line distance still yields a suggestion tracking the
  straight-line distance, not the path length.
- Cart detours mid-transit break the walking approximation — this is exactly why the
  classifier separately tracks peak transit speed and labels a cart-speed transit `'rode'`
  (softened/suppressed copy) rather than reporting a shot distance for it at all.
- Where-you-stand vs. where-the-ball-actually-was is roughly symmetric at both ends (tee
  box standing position ≈ tee marker; landing-spot standing position ≈ resting ball
  position after the golfer walks to it) — this doesn't introduce a directional bias.

**Honest expected precision: ±10-20 yards.** Fine for club-level dispersion buckets
(driver vs. 7-iron are hundreds of yards apart), **not** fine for launch-monitor-grade
carry numbers. The prototype's classifier test #1 (a synthetic, noise-free 241y straight
walk) lands within this band by construction — see "What the prototype proves" below for
the actual measured number.

---

## Q4. Carry from inertial sensors alone — **Infeasible. Closed.**

Double-integrating consumer-grade MEMS accelerometer data accumulates position error
proportional to `t²` from even tiny bias terms; concretely, a typical MEMS accelerometer
bias of ~0.01 m/s² alone produces on the order of **~18m of position error within about
one minute** of dead-reckoning — well before a single shot's flight time even matters,
because (as Q1b already establishes) the phone is on the golfer's body or in the bag, not
on the club or the ball, so there is no clean acceleration signal to integrate over the
shot in the first place.
- https://guidenav.com/blog/can-an-imu-alone-perform-odometry/
- https://daischsensor.com/the-imu-drift-causes-effects-and-solutions/

No amount of filtering rescues this without an external position reference (which is
exactly what Q3's GPS-delta approach already provides, directly, without integration).
**Do not build. Do not fake it.**

---

## Feasible-now / needs-Watch / infeasible matrix

| Capability | Feasible now (phone-only) | Needs Apple Watch | Infeasible |
|---|---|---|---|
| Draft *prompt* ("you moved ~240y — log a shot?") | ✅ GPS-delta, ±10-20y | | |
| True swing/impact **detection** (no golfer input) | ❌ | ✅ (large native investment) | |
| Practice-swing vs. real-swing disambiguation | ❌ even with detection | ⚠️ still imperfect on-wrist (prior art) | |
| Club identification | Golfer says it (voice) | Golfer says it (voice) | |
| Shot **carry distance**, dispersion-bucket precision | ✅ GPS-delta dwell-to-dwell | | |
| Shot carry distance, launch-monitor precision | ❌ | ❌ | ✅ closed — not achievable from phone or Watch consumer sensors alone |
| Hole-transition suppression (walk-to-next-tee ≠ shot) | ⚠️ needs Phase 2 (course geometry) | | |

---

## Draft → voice-confirm → dispersion UX sketch

Consistent with `NORTHSTAR.md` (calm, on-paper, voice-first) and the existing round-page
"Ask caddie" pill / orb invocation pattern:

1. **Silent by default.** No chrome, no persistent indicator — the classifier runs off
   the round page's already-live `GPSWatcher` stream with zero visible footprint.
2. **A draft fires a single quiet banner**, top of the round page, below the existing
   header chrome — text on paper, no modal, no sound: *"You've moved ~240y — hold **Ask
   caddie** and say the club to log it."* (Prototype: `PassiveShotDraftBanner.tsx`.) A
   light haptic accompanies it — the same restrained language the rest of the app already
   uses for confirming beats (`caddie-context.ts`'s "haptic + orb pulse" doc comment).
3. **`'rode'` transits get softer copy** ("Rode ~Xy — probably not a shot...") rather than
   being hidden outright — honest about the top false-positive (cart ride to the next tee)
   without pretending certainty either way.
4. **Confirmation is 100% the existing voice path.** The banner's only action is opening
   the round page's own "Ask caddie" pill (`setCaddieOpen(true)`) — the *same* sheet, the
   *same* `record_shot` realtime tool (`frontend/src/lib/voice/realtime.ts` ~line 109),
   the *same* dual-write into session history + the durable `shots` table that
   `/api/shots/stats` already aggregates for the profile page's dispersion stats. **No new
   write path is introduced anywhere in this design.**
5. **Dismissal = ignore or tap the × — both re-anchor** (`resetAnchor`), so a dismissed
   draft doesn't keep nagging, and the classifier picks up cleanly from wherever the
   golfer is standing.
6. **One mic, never two** — this spike doesn't add a second voice affordance; it hands
   off into whichever one already owns the page (orb elsewhere, pill on `/round/[id]`),
   matching the existing `omnipresent-caddie-orb` contract.

---

## Phased build plan (IF greenlit — not started by this spike)

**Phase 1 — GPS-delta drafts, productionized.** Take the prototype's classifier from
throwaway to real: move it out of `lib/spike/`, tune constants against real-round GPS
traces (not synthetic data), remove the dev flag, ship the banner. Scope: frontend-only,
reuses the existing `GPSWatcher`/`record_shot` path exactly as sketched above.

**Phase 2 — Hole-transition suppression via existing PostGIS course geometry.** The #1
false positive in the taxonomy below (walking/riding to the next tee after holing out) is
addressable today because this repo already has per-hole PostGIS geometry
(`backend/app/routes/shots.py`'s lie detection, course tee/green coords already consumed
by the round page's F/C/B tiles). Suppress or soften drafts whose transit crosses a known
green→next-tee boundary.

**Phase 3 — Apple Watch investigation.** A scoped, separate spike (not an extension of
this one) to evaluate true swing detection given the Q2 cost above, gated on Watch
ownership actually mattering to the product.

---

## Honest risks

- **Battery.** In-round, the marginal cost is ~zero (the `GPSWatcher` this reuses already
  runs continuously for the live rangefinder). If this classifier were ever run
  **off** the round page (not proposed here), continuous high-accuracy GPS is a real
  battery cost — out of scope, flagged so nobody generalizes this design silently.
- **False positives — see full taxonomy below.** The dominant one (walking/riding to the
  next tee) is only *partially* mitigated in Phase 1 (the `'rode'` softening catches cart
  rides; a walked transition to the next tee reads identically to a walked approach shot
  until Phase 2's course-geometry suppression lands). **Phase 1 alone will over-prompt on
  hole transitions** — worth stating plainly rather than discovering it in the field.
- **Accuracy ceiling is real and permanent.** ±10-20y is a property of phone GPS, not a
  tuning problem — the product framing (draft + voice-confirm, never silent auto-score)
  is what makes this acceptable; it would not be acceptable for automatic scoring.
- **Never-auto-write invariant.** This is a design choice, not an accident of the
  prototype — verified structurally: `PassiveShotDraftBanner` holds only component state
  (a `DriftState` in a `useRef`), imports no API/network client, and its only external
  effect is `haptic()` + handing off to `onOpenCaddie` (which the round page wires to the
  existing sheet). There is no code path in the prototype that reaches the backend.

### False-positive taxonomy (§6 of the plan)

**GPS-delta:**
- Walk/ride to the next tee after holing out — **the #1 case**, only fully closed by
  Phase 2's hole-transition awareness.
- Cart rides mid-hole — mitigated now via the `'rode'` peak-speed classification.
- Searching for a lost ball (zigzag inflates the path but dwell-to-dwell straight-line
  still approximates ball position) — the classifier is *designed* around this (test #4);
  noted as acceptable, not a bug.
- Provisional/drop walks (backward movement) — the classifier has no directional
  awareness; a backward displacement past threshold reads the same as forward. Not solved
  by this spike.
- Returning to bag/cart before walking forward — same displacement-only limitation.
- Restroom/beverage-cart detours — same.
- GPS drift under tree cover — mitigated by the `maxAccuracyM` gate (drops fixes over
  25m accuracy outright).
- Tee-box loitering with jitter — mitigated by the dwell threshold + sustained-rest
  window (`dwellSpeedMps` + `dwellMinMs`); proven directly by classifier test #2.
- Shared-cart passenger movement while a partner hits — reads as a `'rode'` transit for
  the passenger's own phone; softened copy, not suppressed outright.

**Motion (for completeness — this signal is not being built, per Q1):**
- Practice swings — identical torso signature to a real swing; unfixable phone-only.
- Walking cadence, cart vibration, bending to tee/mark/read putts, handling the phone —
  all produce torso accelerations in the same low-g band as a golf swing.
- Phone in bag = silent miss, not a false positive.

**Both:** driving-range adjacency to the course, shuttle to the first tee, weather delays.

---

## What the prototype proves / disproves

**Proves:**
1. The GPS-delta dwell→move→dwell pattern is a clean, pure, unit-testable classifier
   (`lib/spike/shot-drift.ts`, 6 tests, all passing — see gate output below) that can sit
   entirely on top of data the round page already collects, with no new watcher, no new
   permission, and (by construction) no path to the backend.
2. The straight-line-vs-path-length distinction that makes GPS-delta usable for carry
   approximation despite a wandering walking path (test #4: a 40-step lateral zigzag
   covering meaningfully more ground than the straight-line distance still yields a
   suggestion tracking the straight-line distance).
3. The `'rode'` vs `'walked'` peak-speed classification correctly separates a cart
   transit from a walk (test #3).
4. Noise rejection: tee-box GPS jitter of up to ±8m never crosses the suggestion
   threshold (test #2); accuracy-gated fixes (>25m) are dropped outright, not
   incorporated at reduced weight (test #5).
5. The confirm/dismiss re-anchor seam (`resetAnchor`) is the only thing that clears the
   "already suggested" latch — a golfer who ignores a draft and keeps walking does not get
   spammed with repeated suggestions for the same anchor (test #6).
6. The draft→voice-confirm handoff wires cleanly into the **existing** round-page
   "Ask caddie" pill with a ~15-line gated mount in `RoundPageClient.tsx` — no new sheet,
   no new mic affordance, no parallel state machine.
7. **The WKWebView motion-permission path is not a dead end** — the Capacitor 8 grep
   finding above (§Q1a), an unplanned but concrete result.

**Disproves / closes:**
1. The plan's open question about whether the WKUIDelegate motion permission "may be
   dead-on-arrival" in this shell — it is not; Capacitor 8 grants it unconditionally.
   This doesn't rescue phone-only swing detection (Q1b still kills it), but it means the
   reason to not build it is the *signal*, not plumbing risk.
2. Sensor-based carry estimation (Q4) — closed on IMU-drift grounds, no prototype needed
   to disprove it further.

**Not run on-device:** the Option B motion-probe page (`app/dev/motion-probe/page.tsx`)
exists and is gated identically to the banner, but was **not exercised on a physical
device or simulator with real motion input** within this spike's time-box — Xcode/device
access wasn't available in this environment. It is left in place, ready to run
(`NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS=1`, tap "Request permission", then move the phone) for
whoever picks this up next; the number it would report (permission outcome + achieved Hz)
would corroborate but not change the Q1 recommendation, since Q1b (not sample rate) is the
binding constraint. **This is the one place this writeup could not fully honor the plan's
"empirical number" ask — flagged rather than faked.**

---

## Gates (all green on `spike/passive-shot-tracking`)

```
$ cd frontend && npm run lint
✓ no errors

$ cd frontend && npx tsc --noEmit
✓ no errors

$ cd frontend && npm run build
✓ Compiled successfully — /dev/motion-probe present as a static route

$ cd frontend && npx tsx voice-tests/runner.ts --smoke
Done. pass=278 fail=0 total=278

$ cd frontend && npm run test
Test Files  115 passed (115)
Tests       2294 passed (2294)   (includes shot-drift.test.ts's 6 new cases)

$ cd backend && ruff check .
All checks passed!   (backend untouched — 0 files changed)
```

## Files touched

**Created:**
- `specs/passive-shot-tracking-spike.md` (this file)
- `frontend/src/lib/spike/shot-drift.ts` — pure classifier
- `frontend/src/lib/spike/shot-drift.test.ts` — 6 unit tests
- `frontend/src/components/spike/PassiveShotDraftBanner.tsx` — gated banner
- `frontend/src/app/dev/motion-probe/page.tsx` — Option B rider (untested on device, see above)

**Touched (minimal):**
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — one gated mount + a parallel
  `spikeDriftPos` state fed from the existing `GPSWatcher` callback, clearly commented
  `// SPIKE (specs/passive-shot-tracking-spike.md)`.

**Not touched:** `backend/**` (verified via `git status --porcelain backend/` → empty),
`.env*`, `deploy/**`, migrations, `frontend/src/lib/types.ts`, existing tests, the voice
pipeline internals, caller/booking.
