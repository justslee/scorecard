# Passive Shot Tracking — Feasibility Spike Plan

**File:** `specs/passive-shot-tracking-spike-plan.md`
**Branch:** `spike/passive-shot-tracking` (cut from `main`)
**PR type:** SPIKE — not the shippable bundle. The writeup is the deliverable; the prototype is throwaway.
**Author:** Plan agent (fable), 2026-07-12. Grounded in code actually read.

## 0. Locked product direction (do not redesign)

Passive tracking = detect that a FULL SWING happened → produce a DRAFT shot → golfer confirms/edits BY VOICE → confirmed shots feed shot-dispersion stats. **Never silently auto-score. Never attempt putt detection (sensor-invisible). Drafts + voice-confirm is the whole point.**

## 1. What already exists in this repo (the spike must build on, not around, these)

- **Shots infrastructure is already live.** `backend/app/routes/shots.py` — durable `shots` table with `start_lat/lng`, `end_lat/lng`, `club`, PostGIS lie detection, and `GET /api/shots/stats` per-club distance + stdev aggregates consumed by `frontend/src/lib/shot-stats.ts` (profile page dispersion stats). Dispersion models: `backend/app/caddie/dispersion.py`.
- **Voice shot logging already exists.** The realtime caddie has a `record_shot` tool (`frontend/src/lib/voice/realtime.ts` ~line 109) that dual-writes session history + the durable shots table. **The draft→confirm loop must terminate in this existing voice path, not a new write path.**
- **Manual GPS shot tracking already exists.** `frontend/src/hooks/useShotTracking.ts` — markStart/markEnd at the golfer's standing position. This is exactly the semantic the passive GPS-delta signal approximates.
- **A continuous in-round GPS watcher already runs.** `frontend/src/app/round/[id]/RoundPageClient.tsx` line ~1152 instantiates `GPSWatcher` from `frontend/src/lib/gps.ts` (Capacitor `@capacitor/geolocation` on native, `navigator.geolocation` on web; `calculateDistance` via turf already exported). **Marginal battery cost of a GPS-delta watcher in-round is ~zero** — position is already being watched.
- **Voice invocation affordance:** the Looper orb (`frontend/src/components/CaddieOrb.tsx`, tap→sheet / hold≥350ms→listening, via `openLooper` in `frontend/src/lib/looper-bus.ts`). Note: the orb is **suppressed on `/round/[id]`** — the round page's own "Ask caddie" pill is the invocation there. The draft prompt UX must hand into whichever affordance owns the current page.
- **Dev-flag convention:** `NEXT_PUBLIC_*` env flags (`NEXT_PUBLIC_AUTH_BYPASS`, `NEXT_PUBLIC_AUTH_DIAG` in `frontend/src/components/AuthProvider.tsx`). Use `NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS`, absent/off by default.
- **Native surface:** Capacitor 8 WKWebView, iOS deploy target 15.0, `frontend/ios/App/App/Info.plist` has `NSLocationWhenInUseUsageDescription` only — **no motion key, no motion plugin, no watchOS target**.

## 2. Honest feasibility framing (the builder validates, cites, and writes this up — a "don't build phone-only swing detection" conclusion is expected and valid)

### Q1. Can a full swing be detected phone-only? (Expected answer: NO, not reliably — prove it)

**Q1a. WebView `DeviceMotionEvent` ceiling.** Builder must document with citations:
- iOS 13+ requires `DeviceMotionEvent.requestPermission()` from a user gesture (WebKit blog / Safari 13 release notes; MDN `DeviceMotionEvent.requestPermission`).
- In **WKWebView** the permission flow depends on the host app implementing `WKUIDelegate.webView(_:requestDeviceOrientationAndMotionPermissionFor:initiatedByFrame:decisionHandler:)` (Apple docs, iOS 15+ — matches our deploy target). Builder must grep `node_modules/@capacitor/ios` to determine whether Capacitor 8's bridge implements it, and empirically test what happens on device if not (silent deny is a real possibility → the API may be dead-on-arrival in our shell).
- **Sample rate cap:** WebKit fires `devicemotion` at ≤~60Hz (interval reports ~16.67ms), and sensor values are reduced-precision for fingerprinting resistance. Nyquist gives a ~30Hz signal ceiling. Club–ball impact is a sub-millisecond transient (contact ~0.5ms, clubhead 80–110mph); the impact shock is fully aliased/invisible at 60Hz even if the phone were on the club — **which it isn't**.
- Cite: WebKit blog on motion/orientation permission, W3C DeviceOrientation Events spec, Apple WKUIDelegate docs.

**Q1b. The phone-in-pocket/bag problem (the real killer, independent of sample rate).** During a swing the phone rides the torso, not the club: ~1–2Hz rotation, low-g accelerations. Builder must enumerate why this signal is ambiguous — see false-positive taxonomy (§6). The unfixable one: **practice swings are kinematically identical to real swings at the torso.** Distinguishing them requires knowing the ball was struck, which the pocket sensor cannot see. Phone-in-bag/cart = zero signal (miss rate, not just false positives).

**Q1c. Native CoreMotion via a custom Capacitor plugin.** ~100Hz `CMDeviceMotion` (cite Apple `CMMotionManager` docs). Verdict to write honestly: higher rate does not fix Q1b — same torso, same practice-swing ambiguity, same in-bag blindness — at the cost of a custom native plugin, `NSMotionUsageDescription`, and background-motion complications. **Not worth building phone-only. Say so.**

### Q2. Does reliable swing detection require an Apple Watch? (Expected: YES for true detection — and it's LARGE)

Wrist-mounted 100Hz CoreMotion during a HealthKit workout session is the prior art (every Apple Watch golf app). Builder documents the true cost given this repo: **Capacitor does not build watchOS** — this means a brand-new native watchOS target in `frontend/ios/`, Swift detection code, WatchConnectivity bridge into the web layer, separate App Store review surface, and Watch-ownership becoming a product requirement. Frame as a real but large Phase-N option (rough order: weeks, native expertise), not a spike deliverable. Even on-wrist, practice swings still require heuristics (prior art uses them imperfectly) — drafts + voice-confirm remains the right product answer there too.

### Q3. GPS-delta as the feasible phone-only signal (Expected: YES, coarse — quantify it)

Between shots the golfer displaces ~100–280y (91–256m); phone GPS accuracy is ~5–10m open-sky (cite Apple `kCLLocationAccuracyBest` docs / GPS.gov ~4.9m smartphone figure). Signal-to-noise ~20:1 — easily sufficient to **prompt a draft** ("you've moved ~240y — log a shot?"). For **carry estimation**: straight-line distance between successive stationary "hitting dwells" approximates shot length the same way `useShotTracking`'s manual markStart/markEnd does; builder quantifies error sources: ±5–10m per endpoint fix, non-straight walking path (straight-line shot distance IS what we want, so path curvature is favorable), cart detours (breaks the approximation), where-you-stand vs where-the-ball-was ≈ equal at both ends. Honest expected precision: **±10–20y — fine for club-level dispersion buckets, not launch-monitor carry.** This is the signal the prototype exercises.

### Q4. Carry from inertial sensors (Expected: INFEASIBLE — confirm and close it)

Double-integrating noisy consumer accelerometer data drifts meters within seconds; the phone isn't on the club or ball anyway. The writeup states this is infeasible, with the standard IMU-drift reasoning cited. Do not fake it; do not build it.

## 3. Prototype decision: build Option A; add Option B only as a time-boxed measurement rider

**Option A (BUILD — the prototype): GPS-delta draft watcher.** Proves the entire feasible product loop end-to-end (passive signal → draft prompt → existing voice affordance → existing `record_shot` path) with **zero native code, zero new plugins, zero new permissions** (location already granted in-round), and near-zero battery delta (watcher already runs on the round page). It de-risks the path we'd actually ship.

**Option B (RIDER — half-day time-box, measurement only): motion probe page.** A dev-flag-gated page that calls `DeviceMotionEvent.requestPermission()` on tap and displays: permission outcome, achieved sample interval, live peak |accel|. Its only purpose is an **honest empirical number for the writeup** (likely: permission dead-ends or 60Hz confirms the ceiling). No thresholding beyond a printed peak; no swing classifier. If the Capacitor-WKWebView permission path dead-ends within the time-box, that dead-end IS the finding — stop and write it down.

Why not B as the main prototype: even a positive B result (60Hz data flows) proves nothing product-usable (Q1b stands); a negative A result would actually change the roadmap. A is the falsifiable experiment on the feasible path.

## 4. Exact files the builder creates/touches

**Create:**
1. `specs/passive-shot-tracking-spike.md` — **the PRIMARY deliverable.** Structure: (a) verdicts per Q1–Q4 with citations and (where run) on-device/simulator measurements; (b) feasible-now vs needs-Watch vs infeasible matrix; (c) draft→voice-confirm→dispersion UX sketch consistent with the orb/pill + `record_shot` (see §5); (d) phased build plan if greenlit (Phase 1: GPS-delta drafts productionized; Phase 2: hole-geometry suppression via existing PostGIS course data; Phase 3: Watch investigation); (e) honest risks: battery (continuous GPS off-round-page, background limits), false positives (§6), accuracy limits, never-auto-write invariant.
2. `frontend/src/lib/spike/shot-drift.ts` — **the pure classifier seam** (see §5.1). No I/O, no Capacitor imports (types from `@/lib/gps` `Position` only; reuse `calculateDistance`).
3. `frontend/src/lib/spike/shot-drift.test.ts` — vitest unit tests for the seam only (runs under existing `npm run test`).
4. `frontend/src/components/spike/PassiveShotDraftBanner.tsx` — dev-flag-gated banner rendered on the round page; feeds positions into the classifier; on a draft, fires `haptic()` and shows "You've moved ~240y — hold **Ask caddie** and say the club to log it." Its confirm action opens the **existing** voice affordance (round-page pill path / `openLooper` elsewhere) — it never writes a shot itself.
5. `frontend/src/app/dev/motion-probe/page.tsx` — Option B rider, gated on the same flag; renders nothing (or 404-style empty) when the flag is off.

**Touch (minimally):**
6. `frontend/src/app/round/[id]/RoundPageClient.tsx` — one gated mount of `PassiveShotDraftBanner`, fed from the existing `GPSWatcher` callback (~line 1152); a few lines, clearly commented `// SPIKE (specs/passive-shot-tracking-spike.md) — dev flag, off by default`.

**Do NOT touch:** `frontend/src/lib/types.ts`, `backend/app/models.py`, `backend/**` at all, `.env*`, `deploy/**`, migrations, existing tests, the voice pipeline internals, caller/booking. Drafts live in component state only — nothing persisted, nothing sent to the backend.

**Flag:** `NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS === "1"` (mirrors `NEXT_PUBLIC_AUTH_DIAG` usage in `AuthProvider.tsx`). Absent in all env files → off by default everywhere.

## 5. Design details

### 5.1 The pure classifier seam (the ONE thing worth unit tests)

```ts
// frontend/src/lib/spike/shot-drift.ts — pure, deterministic, no I/O
export interface DriftSample { lat: number; lng: number; accuracy?: number; speed?: number; timestamp: number }
export interface DraftSuggestion { estimatedYards: number; fromDwellMs: number; kind: 'walked' | 'rode' }
export interface DriftState { /* anchor position, dwell accumulator, EMA-smoothed position, last suggestion */ }

export function createDriftState(anchor: DriftSample): DriftState;
export function advance(state: DriftState, sample: DriftSample, cfg?: DriftConfig): { state: DriftState; suggestion: DraftSuggestion | null };
export function resetAnchor(state: DriftState, sample: DriftSample): DriftState; // on confirm/dismiss
```

Internals: drop samples with `accuracy > 25m`; EMA smoothing over position; **dwell → move → dwell** pattern (dwell = smoothed speed < ~0.7 m/s sustained ≥ ~10s); displacement = haversine/turf distance from anchor dwell to new dwell; suggest only when ≥ threshold (~55y default); classify `rode` when peak inter-sample speed > ~4.5 m/s (suppress or soften prompt — cart rides between holes are the top false positive). All constants in an exported `DriftConfig` so tests pin them.

### 5.2 UX sketch (for the writeup — consistent with the locked direction)

Draft appears as a quiet banner (calm, on-paper feel per `NORTHSTAR.md` — no modal, no auto-anything). Golfer holds the existing voice affordance (orb elsewhere; "Ask caddie" pill on `/round/[id]`) and says "seven iron, fairway" → the **existing** `record_shot` realtime tool writes it → dispersion stats already aggregate it via `/api/shots/stats`. Dismissal = swipe/ignore; anchor resets either way. The spike never adds a second mic affordance and never programmatically records.

## 6. False-positive taxonomy the writeup must document

**GPS-delta:** walk/ride to the next tee after holing out (no shot — the #1 case; mitigation: hole-transition awareness via course geometry, Phase 2); cart rides mid-hole; searching for a lost ball (zigzag inflates path but dwell-to-dwell straight-line is still ~ball position — note it); provisional/drop walks (backward movement); returning to bag/cart before walking forward; restroom/beverage-cart detours; GPS drift under tree cover (accuracy gate); tee-box loitering with jitter (dwell + threshold gate); shared-cart passenger movement while partner hits.
**Motion (for the Q1 writeup):** practice swings (identical torso signature — unfixable phone-only); walking cadence; cart vibration spikes; bending to tee/mark/read putts; handling the phone; phone in bag = silent misses.
**Both:** driving range adjacency, shuttle to first tee, weather delays.

## 7. Test plan (don't over-test a spike)

Unit tests on `shot-drift.ts` only: (1) straight 240y walk between dwells → one `walked` suggestion ~240y; (2) tee-box jitter (±8m noise, no displacement) → none; (3) cart-speed trace → `rode`; (4) zigzag search path → suggestion uses straight-line, fires once; (5) accuracy>25m samples ignored; (6) `resetAnchor` prevents re-fire. No component/E2E tests; the banner is exercised by hand (dev flag on, simulated location in Xcode/simulator — document the manual check in the writeup).

## 8. Gates (branch stays green — all from repo `CLAUDE.md`)

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npm run test          # includes shot-drift.test.ts
cd backend && ruff check .           # backend untouched → trivially green
```

## 9. Sequencing

1. Desk research + citations for Q1a/Q1c/Q2/Q4 (incl. grep of `node_modules/@capacitor/ios` for the motion-permission delegate) — start the writeup first.
2. Build `shot-drift.ts` + tests (pure, fast).
3. Wire the gated banner into `RoundPageClient` + manual simulator walk-through.
4. Option B motion-probe page, hard time-box (half day), record numbers.
5. Finish `specs/passive-shot-tracking-spike.md` with measured results and the recommendation. Open the spike PR (base `main`) labeled SPIKE — writeup is the headline, prototype is appendix.

**Expected recommendation shape (write it only if the evidence bears it out):** phone-only *swing detection* — don't build (Q1 evidence); GPS-delta *draft prompting* — feasible now, coarse, ship-shaped; Watch — the only path to true detection, large native investment, defer; sensor carry estimation — infeasible, closed.
