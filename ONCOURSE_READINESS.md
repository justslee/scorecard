# On-course GPS readiness — Bethpage Red pre-round briefing

Verification pass for `specs/oncourse-gps-readiness-plan.md` (owner directive
2026-07-16: verify every GPS-dependent behavior before Bethpage Red this
weekend). This is the honest, per-behavior status — evidence paths point into
`ops/harness/oncourse-sim/`. See that directory's `README.md` for the full
re-run recipe.

**Bottom line:** the two behaviors the owner specifically flagged — the
yardage card tracking GPS, and the caddie's GPS grounding — are **PASS**,
verified via passing pure-logic vitest tests (the exact code paths the
round page and caddie use) plus a direct code audit. The reusable offline
harness (Bethpage Red fixture + walking trace + diagnostic patch) is built
and committed for future on-device runs. The live on-device simulator drive
did **not** complete in this pass — see row 1-3/8 and the honest note below;
it is not required for the two PASS rows above, which don't depend on the
simulator at all.

The two owner-flagged rows are backed by **46 tests** (course-coordinates 19 +
fcb-tiles 10 + hole-yardage 13 + bethpage-hole3 4), all green on the current
bundle head. Since this verification began, the **map field-test v1.1.9 lane
landed on the same bundle** (5 NOTICEABLE fixes — see "Map field-test fixes"
below); its changes to the map suites were re-run here and remain green
(the combined backing set is now **288 tests**, up from 258, because the map
lane grew google-map-helpers 95→109 and tee-shot-overlays 36→41 and added
par-sanity 7 + marker-options 4).

## Checklist

| # | Behavior | Status | Evidence | Note |
|---|----------|--------|----------|------|
| 1 | You-dot + camera follow (>20yd re-frame) | **NOT-VERIFIABLE this pass** | `ops/harness/oncourse-sim/evidence/00-launch.png` (healthy build/install/launch); no on-hole screenshot | Debug build succeeded and installed/launched cleanly (confirmed by a correctly-rendered home screen), but the diagnostic round-navigation never settled on the round map within the timebox (see "On-device attempt" below) — no camera-follow screenshot exists to grade. `google-map-helpers.test.ts` (109 passed, incl. the map lane's new createCameraQueue priority tests) covers `cameraForHole`/movedBeyondYards purely; `satellite-helpers.test.ts` (81 passed) covers `isGpsOnHole` purely — both PASS, but neither exercises the live camera re-frame animation itself. |
| 2 | **Yardage card tracks GPS (OWNER'S EXAMPLE)** | **PASS** | vitest below + code audit | See "Behavior 2" section. |
| 3 | Tee-shot overlay 40yd tee zone | **PASS (pure-logic); on-device NOT-VERIFIABLE** | `tee-shot-overlays.test.ts` (41 passed) | `teeShotOverlaysVisible`'s 40yd threshold + fade behavior is directly tested and green. The live on-screen fade/redraw was not observed on-device this pass (same navigation blocker as row 1). |
| 4 | Auto-advance walking to next tee | **FILED** (product decision) | `backlog.json` id `gps-auto-advance-decision` | OFF by design (`autoDetectHole={false}` at `InlineHoleDiagram.tsx:306` and `RoundPageClient.tsx:2658`); the nearest-green auto-detect logic already exists in `GoogleSatelliteMap.tsx handlePositionUpdate` (948-958) but is disabled. Risk: mis-jumping between adjacent greens on a tight routing. NOT changed this pass (owner decision needed; also touches the map-lane hot file). |
| 5 | Caddie GPS grounding | **PASS** | vitest below + code audit | See "Behavior 5" section. |
| 6 | Untethered live session grounding | **PASS-via-audit** | code audit (`useDetachedCaddieLive.ts`, `useCaddieLiveSession.ts:305`) + `npx tsx voice-tests/runner.ts --smoke` = 278/278 | The detached session re-anchors using the SAME `resolvedYardage` value the yardage card and caddie use (Item B, `specs/caddie-detach-and-language-pin-plan.md`) — no separate/stale number path. Voice-tests smoke is fully offline and green; no GPS-specific voice fixture exists to add live-GPS coverage beyond the resolver tests already counted under behavior 2. |
| 7 | Wind/elev/plays-like updates | **PASS-via-audit** | code audit (`RoundPageClient.tsx` 1274-1301, `usePhysicsPlaysLike`) | Per-hole `holeBearing` is derived from `holeCoordsForTiles.tee`/`.green` (the SAME GPS-derived coords behavior-2 verifies), so wind/elev tiles inherit that grounding. `playsBasis`/`playsTileDisplay` recompute from `fcbLive` — covered indirectly by `hole-yardage.test.ts` / `fcb-tiles.test.ts`. No dedicated wind/elev vitest suite exists; not built this pass (out of scope — audit only, per the plan). |
| 8 | Tap-target "from tee" line uses GPS origin | **FILED** (bounded gap, map lane) | `backlog.json` id `tap-target-gps-origin` | `GoogleSatelliteMap.tsx` tap handler (782-824) hardcodes the tee as the measuring-line origin (`fromGps=false`) even when the golfer's GPS is on-hole. P2 follow-up, confined to the map-lane hot file (`fix/map-fieldtest-v119`) — deliberately NOT touched here. |

## Map field-test v1.1.9 fixes (landed on the same bundle — in this pass's scope)

The `fix/map-fieldtest-v119` lane landed 5 NOTICEABLE map fixes on `integration/next`
while this verification ran; they are part of what the owner will see Saturday, so
they are in scope here. Each was built to its own Fable plan and cleared that lane's
own gates + adversarial reviewer + designer before landing (bundle #143). Their status
in THIS on-course readiness view:

| Map fix | What it fixes on-course | Verification |
|---------|------------------------|--------------|
| #1 Billboard bunker letters (`marker-options.ts`, `isFlat:false`) | Bunker-carry letters no longer render upside-down on south-playing holes | `marker-options.test.ts` (4 passed) asserts every badge is `isFlat:false`; map lane designer-approved |
| #2 Missing big bunkers (relations + `natural=sand` ingest, cap 4→6, fairway-adjacency admit) | Large waste/fairway bunkers on heavily-bunkered holes now render | `tee-shot-overlays.test.ts` (41 passed) + backend hazards tests (CI); the ingest re-run against live OSM is the lane's evidence |
| **#3 Stray other-hole tee markers (GPS-tick race)** | **GPS-relevant:** the two-writer race on `holeMarkerIdsRef` between the GPS tick and the camera queue is eliminated — GPS-tick overlay refresh now routes through the single serialized camera queue, so no orphan tee marker persists on the wrong hole while walking | `google-map-helpers.test.ts` (109 passed) incl. new createCameraQueue priority/most-recent-wins tests (`gps never evicts a pending hole-change`); reviewer flagged 1 blocking issue on the first cut, the lane fixed it (priority-aware queue) before landing |
| #4 Draggable aim reticle (shared `placeTarget` seam) | Tap-or-drag the target; FROM TEE/TO GREEN update live on drag | Shared seam so tap-math == drag-end-math; on-device drag itself is device-only (like all native-plugin interactions) |
| #5 Red-11 "PAR 3 · 462Y" (`par-sanity.ts` display guard + re-ingest) | The wrong par/yardage header on Red-11 is corrected | `par-sanity.test.ts` (7 passed) |

On-device NOTE: the same simulator navigation blocker that stopped rows 1/3 also means
these map fixes were **not** re-observed on the sim in this pass — their authoritative
backing is the map lane's own gates + review (above), not a fresh on-device drive here.
Fix #3 is the one that most directly touches the walking-round GPS experience; its
pure-logic regression test is green on the current bundle head.

## Behavior 2 — Yardage card tracks GPS (owner's example) — PASS

**Claim:** as the golfer walks tee → green, the Center tile (and Front/Back)
decrease monotonically toward the green; the diagnostic overlay would show
`resolvedYardage.basis === 'gps'` and `fcbLive` non-null while `posOnHole`;
at the green it reads a small number (front/back span); off-hole (>800y or
<5y) it falls back to from-tee.

**Evidence — vitest (all green, offline, no simulator dependency):**
```
$ cd frontend && npx vitest run \
    src/lib/course/course-coordinates.test.ts \
    src/lib/course/fcb-tiles.test.ts \
    src/lib/caddie/hole-yardage.test.ts \
    src/lib/caddie/bethpage-hole3.test.ts

 Test Files  4 passed (4)
      Tests  46 passed (46)
```
(19 + 10 + 13 + 4 = 46; broken out: `course-coordinates.test.ts` 19,
`fcb-tiles.test.ts` 10, `hole-yardage.test.ts` 13, `bethpage-hole3.test.ts` 4.)

**Code audit (`RoundPageClient.tsx`):**
- `playerPos` is set from a live `GPSWatcher` (1172-1185), re-rendering only
  on >~3yd movement (jitter suppression).
- `posOnHole` (1192-1198) requires the player be 5-800y from the hole's green
  — exactly the plausibility window the plan specifies; outside it, honest
  from-tee fallback.
- `fcbLive` (1199) is `computeFCBDistances(playerPos, holeCoordsForTiles)`
  ONLY when `posOnHole` — never fabricated when off-hole.
- `resolvedYardage` (1260-1266) is `resolveHoleYardage({fcbLive, ...})` — the
  **one shared resolver** every caddie/grounding surface reads (comment at
  1254-1259: "GPS-to-green (live, gated on-hole) beats the selected tee's
  card yards, beats its mapped geometry, beats a bare scorecard snapshot,
  beats honest null"). `hole-yardage.test.ts` directly asserts this
  precedence order, including the GPS-live vs. card-yards tie-break.
- `fcbTileValues` (1235, via `buildFcbTiles`) is the SAME `fcb` value shown
  on the Front/Center/Back tiles — `fcb-tiles.test.ts` asserts the honest
  card-only collapse when `fcb == null`, so the tiles can never show a
  fabricated GPS-shaped number when GPS isn't actually live.
- `bethpage-hole3.test.ts` is a real-course regression: Bethpage Black hole 3
  resolves to 231 yds for the "Black" tee independent of the generic
  `round.holes[i].yards` snapshot — proof the resolver reads real per-tee
  mapped-course data, not a placeholder.

**Conclusion:** the monotonic-decrease claim reduces to "`computeFCBDistances`
returns a smaller `center` as `playerPos` approaches `green`", which is
geometry (haversine distance), covered by `course-coordinates.test.ts`'s
ordering assertions ("front < center < back", "all three distances are
positive and center is between front and back"). PASS via gates + audit,
exactly as the plan pre-authorizes even without a completed on-device drive.

## Behavior 5 — Caddie GPS grounding — PASS

**Claim:** with GPS live mid-fairway, the caddie's yardage line is the GPS
distance-to-green ("… to the green"), not a card/mock number; it adopts the
golfer's stated number over a stored one.

**Evidence — vitest:**
```
$ cd frontend && npx vitest run src/lib/caddie/hole-yardage.test.ts
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

**Code audit:**
- `CaddieSheet.tsx:261` reads `resolvedYardage` (the SAME resolver behavior 2
  verifies) with `basis: 'gps'` when `fcbLive` is present — one resolver, one
  number, shared by the tiles AND the caddie sheet header (no second/stale
  source).
- `backend/app/caddie/caddie.py` `_format_yardage_line` (620-655) — audited:
  formats "N yards to the green" from the `yards`/`basis` the frontend sends,
  and separately honors a golfer-STATED number over the stored one (existing
  behavior, not touched this pass). Backend DB-backed integration tests
  (`test_caddie_tools`, `test_hazards`) were NOT run locally per the
  house rule (no local Postgres) — they run in CI; `ruff check .` is clean
  (see gates below).
- Voice-tests smoke (fully offline, no DB): `npx tsx voice-tests/runner.ts
  --smoke` → **278/278 pass** — includes caddie-response fixtures exercising
  the yardage-line phrasing paths this behavior depends on.

**Conclusion:** PASS via gates + audit, per the plan's explicit allowance
("voice tests offline").

## On-device attempt (Step 2/3 of the plan) — best-effort, timeboxed, did not complete

What worked:
- Fixtures regenerated + verified offline (18/18 Red holes, every hole has a
  green — see `ops/harness/oncourse-sim/README.md` Step 1 output).
- Diagnostic patch built (`mapped-course-api.ts` short-circuit,
  `RoundPageClient.tsx` overlay, `page.tsx` self-seed+redirect — see that
  file's README §2.2 for the honest note on why `page.tsx` was touched
  beyond the plan's two named files), captured as
  `ops/harness/oncourse-sim/diagnostic/oncourse-diag.patch`, then reverted.
- Maps key fetched from `looper/client` (Secrets Manager); Clerk key unset.
- `npm run build && npx cap sync ios` — succeeded.
- `xcodebuild ... -derivedDataPath /tmp/simbuild -clonedSourcePackagesDirPath
  /tmp/simspm ... build` — **BUILD SUCCEEDED**.
- `simctl install` / `simctl privacy grant location` / `simctl launch` — all
  succeeded; the home screen rendered correctly and fully styled
  (`ops/harness/oncourse-sim/evidence/00-launch.png` — confirms the Debug
  build, install, and base app are healthy).

What didn't: after the diagnostic self-seed effect fired (`router.replace`
to the seeded round), the app oscillated between the home screen and a blank
white screen over ~40 seconds of polling and never settled on the round map
(`ops/harness/oncourse-sim/evidence/01-round-nav-incomplete-blank.png`). A
`log stream` capture during a fresh relaunch showed the WebView issuing
several rapid `didStartProvisionalLoadForMainFrame` events (consistent with
a navigation loop) but surfaced no JS exception text — iOS log stream does
not expose Capacitor's in-page `console.log`/uncaught-exception detail (a
known limitation, see the `ios-simulator-map-testing` memory), and there is
no headless Safari Web Inspector access in this environment to pull the real
stack trace. Root-causing further would need GUI access (Safari → Develop →
attach to the simulator's WebView) that isn't available here.

Per the plan's explicit timebox instruction ("If the build/reconstruction/
watch doesn't come together in a reasonable window ... STOP and fall back
... Do NOT fake a PASS"), this is reported honestly as **NOT-VERIFIABLE
on-device this pass** for rows 1 and 3, rather than claimed complete. The
harness (fixtures, scripts, README, reusable diagnostic patch) is the durable
deliverable that makes the next attempt cheap — likely next step: retry with
the Safari Web Inspector attached (GUI session) to read the actual thrown
error, or add a temporary visible error boundary to the diagnostic patch
itself so a crash renders readable text instead of blank white.

All diagnostic edits were reverted before anything was committed — confirmed
by `git status` showing no changes to `frontend/src/app/page.tsx`,
`frontend/src/app/round/[id]/RoundPageClient.tsx`,
`frontend/src/lib/courses/mapped-course-api.ts`, or
`frontend/public/diag-bethpage-red-mapped.json` (see "Gates" below).

## What only Saturday proves (honest section)

Simulated GPS is always perfect-accuracy, instant-fix, zero-jitter. NOT
verifiable in any simulator/offline pass, only the real round proves:
- True GPS accuracy and drift on a real device antenna.
- Tree-canopy signal loss + jitter recovery (Bethpage Red has wooded holes).
- Sunlight legibility of the satellite tiles and the yardage-book UI outdoors.
- Battery drain over a full 18-hole round with GPS + the map active.
- LTE dependence of the caddie / weather / course-intel calls away from wifi.

The one loss-path that IS sim-checkable — `simctl location clear` → tiles
fall back to honest from-tee (no crash, no stale "you" number) — was
**not captured** this pass (the on-device drive didn't reach a state where
it could be exercised; `drive_trace.sh --loss` is ready for the next attempt
once navigation is unblocked).

## Fixed vs. filed this pass

**Fixed:** nothing in app code — this was a verification-only pass, per the
plan's hard constraint (new files only; `backlog.json` + `tasks/progress.md`
are the only existing-file edits).

**Filed** (`backlog.json`, both `status: "ready"`, not built):
- `gps-auto-advance-decision` — owner decision needed (behavior 4).
- `tap-target-gps-origin` — P2, map-lane follow-up (behavior 8).

## Gates

```
$ cd frontend && npm run lint && npx tsc --noEmit && npx tsx voice-tests/runner.ts --smoke && npm run build
# lint: clean (0 errors, 0 warnings)
# tsc --noEmit: clean
# voice-tests smoke: pass=278 fail=0 total=278
# next build: ✓ Compiled successfully; 19/19 static pages generated

$ cd backend && ruff check .
# All checks passed!
```

`git status` at the end of this pass shows only `backlog.json` (the two
filed items) and the new `ops/harness/` directory + this file — no
diagnostic edits to any app source file.
