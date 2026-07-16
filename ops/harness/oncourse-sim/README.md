# oncourse-sim — on-course GPS readiness harness

A committed, reusable simulated-round harness for verifying every GPS-dependent
behavior in the round page (yardage tiles, caddie grounding, camera follow,
tee-shot overlays, auto-advance, tap-target) **offline**, without prod auth,
using a Bethpage State Park (Red) course reconstructed from a committed
Overpass fixture. Built for `specs/oncourse-gps-readiness-plan.md` (owner's
Bethpage Red readiness pass, 2026-07-16). Re-run any time — the fixtures are
regenerated from `backend/tests/fixtures/bethpage_overpass.json`, no network
or auth required for Step 1.

## Layout
```
ops/harness/oncourse-sim/
  extract_red_trace.py         stdlib Python — hole centerlines -> walking waypoints
  build_bethpage_red_course.py stdlib Python — reconstructs a CourseData-shaped course
  drive_trace.sh               bash — drives the iOS Simulator location + screenshots
  fixtures/
    red-trace-waypoints.json     COMMITTED — 142 waypoints, all 18 Red holes
    bethpage-red-mapped.json     COMMITTED — 18-hole CourseData JSON (see below)
  diagnostic/
    oncourse-diag.patch          COMMITTED — the (reverted) diagnostic shim + overlay
  evidence/
    (a handful of key screenshots, committed; the rest is gitignored)
```

## Step 1 — regenerate the fixtures (fully offline, no auth, no map lane)

```bash
cd ops/harness/oncourse-sim
python3 extract_red_trace.py           # -> fixtures/red-trace-waypoints.json
python3 build_bethpage_red_course.py   # -> fixtures/bethpage-red-mapped.json (prints VERIFY OK)
```

Both scripts are stdlib-only (no pip deps), read only the committed Overpass
fixture, and make no network calls. `build_bethpage_red_course.py` prints a
verification summary (18 holes, every hole has a green, feature-type counts,
per-hole yardages) before writing the file — re-run any time the Overpass
fixture changes and diff the output.

**Known gaps in the reconstructed course (documented, not hidden):**
- The Red holes in `bethpage_overpass.json` carry no `dist`/yardage OSM tag
  (unlike some other tagged courses), so `yardages.Red` is the straight-line
  length of the hole's own `golf=hole` centerline in yards — a reasonable
  proxy, not the real scorecard number for each tee marker.
- The Red holes also carry no `handicap` (stroke index) tag. The `handicap`
  field (required by `CourseData`/`HoleData`) falls back to the hole number
  as a **synthetic placeholder** — NOT a real stroke index. This fixture is
  offline-sim-only; never treat `handicap` here as ground truth.
- Feature assignment (green/fairway/tee/bunker -> hole) is a simplified
  "nearest centerline, searched globally across every course in the fixture"
  join — the same idea as `backend/app/services/course_spatial.py`
  (`assign_features_to_holes`), not a byte-for-byte port. Good enough to
  produce a green per hole and a plausible feature layout; not guaranteed
  pixel-perfect against the real Bethpage Red routing.

## Step 2 — land the Debug build on the round map (best-effort, timeboxed)

The Bethpage Red mapped-course fixture only exists locally, and prod GET
`/api/courses/mapped/*` now 401s anonymously (verified 2026-07-16) — so
driving a real Debug build against a live round needs a **diagnostic shim**
that serves the local fixture instead of hitting the network, plus a small
on-screen readout (iOS log stream does not surface Capacitor `console.log`,
so a screenshot is the only readout of internal state like `posOnHole` /
`fcbLive` / `resolvedYardage`).

### 2.1 — Auth blocker (why the shim exists)
`GET /api/courses/mapped/<id>` returns 401 for an anonymous caller in prod.
The round page's normal course-loading path (`fetchMappedCourse`) would
therefore fail for ANY course id when driven from a fresh, unauthenticated
simulator — there's no way to land on a real mapped-course round without
either (a) a full Clerk sign-in flow in the simulator, or (b) a diagnostic
shim that bypasses the network for a known diagnostic course id. This harness
uses (b), scoped tightly (see the patch) and reverted before commit.

### 2.2 — Apply the diagnostic patch
```bash
git apply ops/harness/oncourse-sim/diagnostic/oncourse-diag.patch
```
The patch touches exactly:
- `frontend/src/lib/courses/mapped-course-api.ts` — `fetchMappedCourse` short-
  circuits to `fetch('/diag-bethpage-red-mapped.json')` (a static asset, so it
  works in the static-exported Capacitor bundle with zero network) when the
  requested id is the diagnostic fixture id
  (`bethpage-red-offline-fixture`); every other id is unaffected — the real
  network path is untouched.
- `frontend/public/diag-bethpage-red-mapped.json` — a **copy** of
  `fixtures/bethpage-red-mapped.json` placed where Next's static export
  bundles it as a fetchable asset. (`getCourseCoordinates`, the OTHER coords
  source `useHoleCoordinates` reads, already fails soft to `[]` on a 404/
  network error with no patch needed — see `lib/course/course-coordinates.ts`
  — so `mappedCourseToCoordinates(course)` derives the coords from this
  fixture's polygons/centerline the same way it would for a real course.)
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — mounts a fixed, top-
  left `<pre>` diagnostic overlay printing `currentHole`, `playerPos`,
  `posOnHole`, `fcbLive`, and `resolvedYardage` on every render. Pure
  addition; no existing logic touched.
- `frontend/src/app/page.tsx` — a `useEffect`, gated on
  `NEXT_PUBLIC_ONCOURSE_DIAG === "1"` (a build-time env var only ever set by
  this harness's own diagnostic build — inert in every normal build), that
  self-seeds a local round (`storage.ts saveRound`, id
  `oncourse-diag-round`) pointed at the fixture course + `teeName:"Red"`
  and `router.replace`s straight to `/round/oncourse-diag-round` instead of
  rendering the home screen. This lets the harness land on the round map with
  zero manual localStorage injection (no Safari Web Inspector step needed) —
  install + launch the Debug build and it's already on the round.
  **Note:** the plan's Step 2 names `mapped-course-api.ts` +
  `RoundPageClient.tsx` as the two files needing a diagnostic edit;
  `page.tsx` was added as the minimal, sound way to reach `/round/<id>`
  without a manual injection step or GUI automation (simctl has no tap/type
  primitive) — flagged here explicitly since it's outside the plan's named
  file list. It is transient and reverted exactly like the other two.

Auth: `AuthProvider` already passes `children` straight through with no gate
when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is unset (`frontend/src/components/
AuthProvider.tsx`) — no patch needed there.

### 2.3 — Build
```bash
cd frontend
export NEXT_PUBLIC_GOOGLE_MAPS_KEY=$(aws secretsmanager get-secret-value \
  --secret-id looper/client --region us-east-1 --query SecretString --output text \
  | jq -r '.GOOGLE_MAPS_KEY')
unset NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
export NEXT_PUBLIC_ONCOURSE_DIAG=1
npm run build && npx cap sync ios

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator \
  -destination "id=D4DB2397-D23A-4D55-A049-8E7D4B738E8D" \
  -derivedDataPath /tmp/simbuild -clonedSourcePackagesDirPath /tmp/simspm \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```
**Use `/tmp/simspm` — NOT `/tmp/looper-spm`** (that path is the TestFlight
ship build's SPM cache; reusing it for a Debug diagnostic build risks
corrupting it).

### 2.4 — Install, grant location, launch
```bash
UDID=D4DB2397-D23A-4D55-A049-8E7D4B738E8D
xcrun simctl install $UDID /tmp/simbuild/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl privacy $UDID grant location com.looperapp.app
xcrun simctl launch $UDID com.looperapp.app
```
`NEXT_PUBLIC_ONCOURSE_DIAG=1` self-seeds the round and routes there on first
paint (see 2.2) — no manual navigation needed.

### 2.5 — Drive the trace + screenshot
```bash
ops/harness/oncourse-sim/drive_trace.sh $UDID \
  ops/harness/oncourse-sim/fixtures/red-trace-waypoints.json \
  ops/harness/oncourse-sim/evidence/ \
  --loss --holes 1,2,3
```
Drop `--holes` to drive all 18. Add `--loss` to also run `simctl location
clear` and screenshot the from-tee fallback (the one loss-path that IS
sim-checkable — see the plan's Step 5). Read each screenshot with the `Read`
tool; the diagnostic overlay in the top-left corner of every screenshot is
the ground truth to compare against the checklist in `ONCOURSE_READINESS.md`
(iOS log stream does not surface Capacitor `console.log`).

### 2.6 — REVERT
```bash
git checkout -- frontend/src/lib/courses/mapped-course-api.ts \
  frontend/src/app/round/\[id\]/RoundPageClient.tsx \
  frontend/src/app/page.tsx
rm -f frontend/public/diag-bethpage-red-mapped.json
git status   # confirm zero diagnostic edits before committing anything
```
The diagnostic shim and overlay must **never** be committed live — only the
`.patch` + this README ship. Re-apply the patch fresh next time from this
file's recipe (2.2) rather than trusting a stale local branch state.

## Known harness limitations (NOT app bugs)
- Simulated GPS is always perfect-accuracy, instant-fix, zero-jitter — real
  tree-canopy signal loss/drift, sunlight tile legibility, battery drain, and
  LTE dependence can only be proven on Saturday's real round (see the
  report's honest section).
- `@capacitor/geolocation`'s watch may not reliably fire off a `simctl
  location set` on every OS/Xcode combination. If the "You" dot / overlay
  don't move between screenshots despite distinct simulated coordinates,
  treat that as a **harness limitation**, not necessarily an app bug — cross-
  check against the pure-logic vitest gates (which don't depend on the
  simulator's location plumbing at all) before concluding anything is broken.
- `drive_trace.sh` has no way to distinguish "GPS watch never fired" from
  "GPS watch fired but the value legitimately didn't change the on-screen
  render" — read the overlay text in each screenshot, don't just diff pixels.
