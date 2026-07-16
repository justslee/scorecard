# On-course GPS readiness — verification harness + program (builder contract)

Owner directive (2026-07-16): verify every GPS-dependent behavior works before he plays
**Bethpage Red this weekend**; test and make it production-ready. This spec is the builder
contract. Follow NORTHSTAR (quiet, voice-first, yardage-book). HOLD all pushes — the lane
lead lands this; do not push, ship, or ping.

## What "done" means
1. A committed, reusable simulated-round harness under `ops/harness/oncourse-sim/` (SILENT).
2. A committed Bethpage Red mapped-course fixture + walking traces, reconstructed OFFLINE
   from `backend/tests/fixtures/bethpage_overpass.json` (no prod auth needed).
3. `ONCOURSE_READINESS.md` at repo root — the owner's pre-round briefing: a per-behavior
   PASS / FAIL / NOT-VERIFIABLE checklist with evidence, fixed-vs-filed, and an honest
   "only your real round proves this" section.
4. Two gaps FILED in `backlog.json` (auto-advance decision; tap-target GPS origin). NOT fixed
   here — both live in `GoogleSatelliteMap.tsx`, a map-lane hot file (conflict risk).
5. All gates green.

## Hard constraints
- **NEW FILES ONLY.** Do NOT edit `GoogleSatelliteMap.tsx`, `tee-shot-overlays.ts`, or any
  file the map field-test lane (`fix/map-fieldtest-v119`) touches. The only edits to existing
  files allowed: `backlog.json` (file the 2 gaps), `tasks/progress.md`. Everything else is new.
- The **diagnostic shim + diagnostic overlay** used to land the Debug build on the round map
  are DIAGNOSTIC-ONLY — apply, screenshot, then `git checkout` to revert. NEVER commit them.
  Save the shim as a documented patch under `ops/harness/oncourse-sim/diagnostic/` (a `.patch`
  file + README notes) so it is reproducible without being live in the app.

## GPS-consumer inventory (audited — the verification targets)
| # | Behavior | Where (file:line) | Verifiable now? |
|---|----------|-------------------|-----------------|
| 1 | You-dot + camera follow (>20yd re-frame) | GoogleSatelliteMap.tsx handlePositionUpdate 883-962 | On-device (best-effort) |
| 2 | **Yardage card tracks GPS** (owner's example) | RoundPageClient.tsx 1166-1210 (GPSWatcher, posOnHole 5-800y, fcbLive→tiles) | YES — gates + audit + on-device |
| 3 | Tee-shot overlay 40yd tee zone | tee-shot-overlays.ts teeShotOverlaysVisible 696-706 | Partial (pure-logic yes; on-device visibility flip best-effort) |
| 4 | Auto-advance walking to next tee | GoogleSatelliteMap.tsx 948-958 but DISABLED (autoDetectHole={false}: InlineHoleDiagram:306, RoundPageClient:2658) | FILE — product decision |
| 5 | Caddie GPS grounding | resolveHoleYardage 1260-1266 → CaddieSheet:261 (gps basis) → caddie.py _format_yardage_line 620-655 | YES — gates + audit |
| 6 | Untethered live session grounding | useDetachedCaddieLive.ts / useCaddieLiveSession.ts:305 | Gates + audit |
| 7 | Wind/elev/plays-like updates | RoundPageClient 1274-1301 + usePhysicsPlaysLike | Gates + audit |
| 8 | Tap-target "from tee" line uses GPS origin | GoogleSatelliteMap tap 782-824 hardcodes tee/fromGps=false | FILE — bounded gap (map hot file) |

## Step 1 — Harness scripts + fixtures (do first; fully offline, no auth, no map lane)
Layout under `ops/harness/oncourse-sim/`:
- `extract_red_trace.py` (stdlib Python) — reads `backend/tests/fixtures/bethpage_overpass.json`,
  finds `golf=hole` ways named `Red 1`..`Red 18` (3-node tee→green centerlines). For each hole
  emit a station list: TEE (node[0]), 2-3 FAIRWAY steps (interpolate along the centerline at
  ~25%/50%/75%), APPROACH (~90% toward green), GREEN-FRONT/GREEN (node[-1]), then WALK-TO-NEXT-TEE
  (a couple of interpolated points from this green to the next hole's tee). Output
  `fixtures/red-trace-waypoints.json`: `[{hole, station, lat, lng}]`. Do NOT hardcode 18 holes —
  read them from the fixture. Include holes 1-3 fully; the generator should handle all 18 so a
  future run can cover any hole.
- `build_bethpage_red_course.py` (stdlib Python) — reconstruct a `CourseData`-shaped JSON offline
  from the overpass fixture so the sim can render without the 401'd prod GET. Shape (match
  `frontend/src/lib/courses/types.ts` CourseData): `{ id, name:"Bethpage State Park (Red)",
  location:{lat,lng}, teeSets:[{name:"Red",...}], holes:[{number, par (from the golf=hole `par`
  tag), yardages:{Red: <dist tag or straight-line yards>}, features: FeatureCollection of the
  hole's green polygon + fairway polygon(s) + bunker polygons + a tee point/box, spatially
  assigned to the hole by nearest-centerline}] }`. Reuse the SAME assignment idea the backend
  ingest uses (a feature belongs to the hole whose centerline it's nearest to). Verify the output
  parses and has 18 holes each with a green + ≥1 feature. Save to
  `fixtures/bethpage-red-mapped.json` (COMMITTED — reusable).
- `drive_trace.sh` (bash, `set -euo pipefail`) — args: UDID + waypoints JSON + evidence dir.
  For each station: `xcrun simctl location <udid> set <lat>,<lng>`, sleep ~4s for the watch to
  settle, `xcrun simctl io <udid> screenshot <evidence>/hN-<station>.png`. Optionally use
  `xcrun simctl location <udid> start --speed=1.4 <lat1>,<lng1> <lat2>,<lng2>` between stations
  to simulate a realistic walk (1.4 m/s ≈ walking). Include a final `--loss` mode step that runs
  `xcrun simctl location <udid> clear` and screenshots the from-tee fallback.
- `README.md` — the COMPLETE re-run recipe (see Step 2), the auth-blocker note, the diagnostic
  shim/overlay instructions + revert, and how to read each screenshot against the checklist.
- `fixtures/` (committed): `bethpage-red-mapped.json`, `red-trace-waypoints.json`.
- `evidence/` (committed, a handful of key screenshots referenced by the report; the rest gitignored).

## Step 2 — Land the Debug build on the Bethpage Red round map (best-effort on-device)
Recipe (from the ios-simulator-map-testing memory, UPDATED for the auth blocker):
1. Maps key: `GM=$(aws secretsmanager get-secret-value --secret-id looper/client --region us-east-1 --query SecretString --output text | jq -r '.GOOGLE_MAPS_KEY')`;
   `export NEXT_PUBLIC_GOOGLE_MAPS_KEY=$GM; unset NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
2. **Diagnostic shim (reverted, saved as a `.patch`):** short-circuit `fetchMappedCourse`
   (`frontend/src/lib/courses/mapped-course-api.ts`) and the coords hook (`useHoleCoordinates`)
   to return the committed `bethpage-red-mapped.json` for the seeded round instead of hitting
   the network — because prod GET `/api/courses/mapped/*` now 401s anonymously (verified). Seed a
   local round in `localStorage` (ROUNDS_KEY) pointing at the Bethpage Red course id + `teeName:"Red"`
   and route straight to `/round/<id>` (or temporarily point the home route there). AuthProvider
   passes children through when Clerk is unset → no login gate.
3. **Diagnostic overlay (reverted):** mount a fixed-position `<pre>` in RoundPageClient printing,
   each render: `playerPos {lat,lng}`, `posOnHole`, `fcbLive {front,center,back}`,
   `resolvedYardage {yards,basis}`, `currentHole`. iOS log stream does NOT surface Capacitor
   console.log, so the screenshot is the only readout.
4. Build: `(cd frontend && npm run build && npx cap sync ios)` then
   `xcodebuild -project frontend/ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator -destination "id=D4DB2397-D23A-4D55-A049-8E7D4B738E8D" -derivedDataPath /tmp/simbuild -clonedSourcePackagesDirPath /tmp/simspm CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build`.
   **Use /tmp/simspm — NOT /tmp/looper-spm** (that corrupts the TestFlight ship build).
5. `xcrun simctl install <udid> /tmp/simbuild/Build/Products/Debug-iphonesimulator/App.app`;
   `xcrun simctl privacy <udid> grant location com.looperapp.app`;
   `xcrun simctl launch <udid> com.looperapp.app`.
6. Drive: `ops/harness/oncourse-sim/drive_trace.sh <udid> fixtures/red-trace-waypoints.json evidence/`.
   Read each screenshot with the Read tool; record observed vs expected in the checklist.
7. **REVERT the diagnostic shim + overlay** (`git checkout` the touched files). Confirm the tree
   has no diagnostic edits before committing anything.

**Timebox the on-device attempt.** If the build/reconstruction/watch doesn't come together in a
reasonable window (SPM resolve failures, the capacitor geolocation watch not firing off simctl,
etc.), STOP and fall back: mark the on-device rows "verified via pure-logic gates + code audit;
on-device pending" honestly in the report. The harness + fixtures still ship as the durable
deliverable and make a later run cheap. Do NOT fake a PASS.

## Step 3 — Verification checklist (fill ONCOURSE_READINESS.md)
One row per behavior. Observable + expected = PASS:
1. **You-dot + camera follow** — at each fairway station, the "You" dot sits at the sim
   coordinate and the camera re-frames (down-hole view) after >20yd moves; no jitter re-frame
   inside 20yd. Evidence: h1-fairway25/50/75 screenshots. Backing: google-map-helpers.test.ts
   (cameraForHole/movedBeyondYards), satellite-helpers.test.ts (isGpsOnHole).
2. **Yardage card tracks GPS (OWNER'S EXAMPLE)** — as the sim walks tee→green, the Center tile
   (and Front/Back) DECREASE monotonically toward the green; diagnostic overlay shows
   `resolvedYardage.basis==='gps'` and fcbLive non-null while posOnHole. At the green it reads a
   small number (front/back span). Off-hole (>800y or <5y) it falls back to from-tee.
   Backing: course-coordinates.test.ts (computeFCBDistances), fcb-tiles.test.ts, hole-yardage.test.ts
   (resolveHoleYardage gps precedence), bethpage-hole3.test.ts.
3. **Tee-shot overlay 40yd tee zone** — overlays/bunker chips VISIBLE within 40yd of the tee,
   FADE once past it; redraw only on the visibility flip. On-device best-effort; pure-logic
   backing: tee-shot-overlays.test.ts (teeShotOverlaysVisible thresholds).
4. **Auto-advance** — FILED. Document: it is OFF by design on the round page; holes change by
   swipe/tap. The owner should decide whether to enable nearest-green auto-detect (risk: mis-jumps
   between adjacent greens on a tight routing). NOT changed this pass.
5. **Caddie GPS grounding** — with GPS live mid-fairway, the caddie yardage line is the GPS
   distance-to-green ("… to the green"), not a card/mock number; it adopts the player's stated
   number over a stored one. Backing: hole-yardage.test.ts + backend test_caddie_tools/test_hazards +
   caddie.py _format_yardage_line audit. Report as PASS-via-gates+audit (voice tests offline).
6. **Untethered live session** — the live caddie session re-anchors with the resolved GPS number
   and survives the sheet closing. Backing: audit of useDetachedCaddieLive/useCaddieLiveSession +
   voice-tests smoke.
7. **Wind/elev/plays-like** — per-hole wind bearing + USGS elev delta render; plays-like recomputes
   on whole-yard GPS movement. Backing: audit + existing physics/plays tests.
8. **Tap-target from-tee line** — FILED. Today the measuring line origins at the tee even when GPS
   is on-hole; the helper supports a GPS origin. Bounded follow-up in the map lane's file.

For each: PASS / FAIL / NOT-VERIFIABLE, evidence path, and one honest sentence.

## Step 4 — File the two gaps in backlog.json
Use targeted Edits (NEVER json.load/dump the whole file — it has duplicate keys; see the
backlog-json-duplicate-keys lesson). Add two READY items:
- `gps-auto-advance-decision` (needs owner decision): enable GPS nearest-green auto-advance on the
  round page, or keep swipe-only. Note the mis-jump risk + that logic already exists behind
  `autoDetectHole`.
- `tap-target-gps-origin` (P2, map lane): when GPS is on-hole, origin the tap-target measuring line
  + FROM number at the player, not the tee (helper already supports it).

## Step 5 — What only Saturday proves (report's honest section)
Simulated GPS is always perfect-accuracy. NOT-VERIFIABLE on the sim, only the real round proves:
true GPS accuracy/drift, tree-canopy signal loss + jitter recovery, sunlight legibility of the
tiles, battery drain over 18 holes, LTE dependence of caddie/weather/intel. The ONE loss-path that
IS sim-checkable: `simctl location clear` → tiles fall back to honest from-tee (no crash, no stale
"you" number) — include that screenshot.

## Risks + mitigations
- Sim build time / SPM resolve failure → dedicated `/tmp/simspm`; if corrupted, `mv aside` (rm -rf
  is guard-blocked) and retry. Timebox; fall back to gates+audit.
- GMSMapView SIGTRAP on GPS jitter → native calls are gated on `mapReadyRef` (google-maps-onmapready-crash
  lesson); the loss-path (`clear`) must fall back to paper/from-tee, not crash — verify.
- Capacitor `@capacitor/geolocation` watch may not fire off simctl on this OS → if the "You" dot /
  overlay don't move, that is a HARNESS limitation, NOT an app bug; note it and rely on gates+audit.
- Map-lane conflict → NEW files only; re-verify #3's stray-marker race after the map lane lands.

## Gates (all must pass before done)
`(cd frontend && npm run lint && npx tsc --noEmit && npx tsx voice-tests/runner.ts --smoke && npm run build)`
and `(cd backend && ruff check .)`. The harness scripts add no npm deps (stdlib Python + xcrun +
bash). Confirm the tree has NO diagnostic edits (shim/overlay reverted) before committing.

## Shared types
No `types.ts` ↔ `models.py` change. The reconstructed fixture must MATCH the existing `CourseData`
shape in `frontend/src/lib/courses/types.ts` (read it — do not invent fields).
