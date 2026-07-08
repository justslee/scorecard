# Plan: caddie-opening-reco-from-tee

Backlog: p1, NOTICEABLE. Owner ask: when the auto opening caddie recommendation
cannot get the golfer's live GPS position (absent / denied / timeout) OR the GPS
fix is implausible (>800y from the green), the opening reco must FALL BACK to a
FROM-THE-TEE recommendation, phrased honestly (e.g. "I'm on the tee, about 365 to
the pin. What should I hit off the tee?") rather than staying idle. This covers
home testing and the first tee before GPS lock.

Honesty is non-negotiable (no-fake-data-fallbacks lesson): the caddie must NEVER
claim the player is somewhere they aren't. The from-the-tee phrasing IS the
honesty — it names the tee explicitly, and the number is the real tee->green
distance. ALL existing honest-null cases are preserved: when even the hole's tee
coordinates are missing (or the green is missing), `resolveOpeningShot` still
returns `null` and the sheet opens idle exactly as today.

This is a small, surgical change. Consistent with NORTHSTAR.md: calm,
yardage-book, voice-first, honest.

---

## Confirmed current behavior (read the files first)

- `frontend/src/app/round/[id]/RoundPageClient.tsx`
  - `greenForHole = holeCoordsForTiles?.green ?? null` (~line 1051).
  - `resolveOpeningShot` useCallback (~line 1052) returns
    `{ distanceYards: number } | null`. It: early-returns null if no green;
    awaits `withTimeout(GPSWatcher.getCurrentPosition(), 6000)`; returns null on
    no fix; computes `haversineYards(pos, greenForHole)`; returns null if
    `!Number.isFinite(d) || d < 1 || d > 800`; returns `{ distanceYards: d }`;
    catch returns null (denied / timeout / throw).
  - `holeCoordsForTiles?.tee` is available, same shape `{ lat, lng }`.
  - Imports already present: `haversineYards` (from `@/lib/map/google-map-helpers`,
    line 60), `withTimeout` (local, line 76), `computeFCBDistances` (line 53).
  - `fcbFromTee` (~line 1066) already computes tee->green F/C/B via
    `computeFCBDistances(holeCoordsForTiles.tee, holeCoordsForTiles)`.

- `frontend/src/components/CaddieSheet.tsx`
  - Prop type (~line 95): `resolveOpeningShot?: () => Promise<{ distanceYards: number } | null>;`
  - Opening-turn useEffect (~lines 682-713). The question is built at line 708:
    `` const q = `I'm about ${shot.distanceYards} yards from the pin. What should I hit or do on this next shot?`; ``
    then `setTranscript(q)` + `await askCaddie(q, { suppressError: true })`.
  - The guard block (lines 683-706: `openingFiredRef`, `openingGenRef`,
    pristine-idle re-checks via `streamAbortRef` / `recorderRef` /
    `convHistoryRef`) is DELICATE and reviewer-hardened. It MUST stay byte-for-byte
    untouched. The ONLY line that changes in this effect is the `const q = ...`
    assignment at 708.

- `frontend/src/lib/map/google-map-helpers.ts` line 129: `haversineYards`
  returns `Math.round((km * 1000) / METRES_PER_YARD)` — i.e. it ALREADY returns
  an integer. See "Rounding" note below.

### Rounding note (resolves the reviewer's suspicion)
The reviewer flagged that `distanceYards` might interpolate as a long decimal.
It does NOT: `haversineYards` rounds internally (line 129), so both the existing
GPS path and the new tee path already produce a clean integer. **No `Math.round`
is added and scope is NOT expanded.** If a future refactor makes `haversineYards`
return a float, add `Math.round` at the phrasing site then — not now.

---

## Design decisions (concrete)

### 1. Return shape
Extend to `{ distanceYards: number; fromTee?: boolean } | null`.
`fromTee` is OPTIONAL and defaults falsy = the GPS path (identical serialization
to today, so existing GPS behavior and existing tests are unaffected).

### 2. Shared-type sync — NONE needed (confirmed)
This shape is a purely local UI contract between `RoundPageClient` (producer) and
the `CaddieSheet` `resolveOpeningShot` prop (consumer). It is NOT persisted, NOT
sent over the wire, and NOT part of any DTO. **`frontend/src/types.ts` and
`backend/.../models.py` are NOT involved and MUST NOT be touched.** Confirm by
grepping: `resolveOpeningShot` appears only in `RoundPageClient.tsx` (definition +
prop pass) and `CaddieSheet.tsx` (prop type + consumer) and the test file.

### 3. Extract a pure helper (RECOMMENDED — option i)
Create `frontend/src/lib/caddie/opening-shot.ts` with a pure, DOM-free, GPS-free
function so BOTH the GPS branch and the tee-fallback branch are unit-testable
without a browser or a mocked geolocation. The async GPS acquisition + `withTimeout`
STAYS in `RoundPageClient` (it is environment-dependent); the helper receives the
already-resolved position (or `null`).

Signature:
```ts
// frontend/src/lib/caddie/opening-shot.ts
import { haversineYards } from "@/lib/map/google-map-helpers";

type LatLng = { lat: number; lng: number };
export type OpeningShot = { distanceYards: number; fromTee?: boolean };

/**
 * Decide the opening recommendation distance-to-pin, honestly.
 *  - GPS path: player's live position -> green, when plausible (1..800y).
 *  - Tee fallback: tee -> green, when GPS is missing/denied/timed-out OR the
 *    GPS distance is implausible. Flagged fromTee:true so the caddie phrases it
 *    honestly ("I'm on the tee ...").
 *  - Honest null: when the green is missing, OR neither a plausible GPS fix nor
 *    tee coords exist. Sheet opens idle.
 *
 * @param gps  Resolved live position, or null (no fix / denied / timeout).
 * @param tee  Hole tee coords, or null.
 * @param green Hole green coords, or null.
 */
export function resolveOpeningShotDistance(
  gps: LatLng | null,
  tee: LatLng | null,
  green: LatLng | null,
): OpeningShot | null {
  if (!green) return null;                         // no green -> honest null (unchanged early guard)

  // GPS path first — the player's real position wins when plausible.
  if (gps) {
    const d = haversineYards(gps, green);
    if (Number.isFinite(d) && d >= 1 && d <= 800) {
      return { distanceYards: d };                 // fromTee falsy -> GPS phrasing
    }
    // implausible GPS -> fall through to tee fallback (do NOT return null yet)
  }

  // Tee fallback — GPS absent/denied/timeout OR implausible.
  if (tee) {
    const d = haversineYards(tee, green);
    if (Number.isFinite(d) && d >= 1 && d <= 800) {
      return { distanceYards: d, fromTee: true };  // honest tee phrasing
    }
  }

  return null;                                     // no plausible GPS, no usable tee -> honest idle
}
```

**Branch order rationale (must be exactly this):**
1. `!green` -> `null` (preserves today's early guard; a from-tee distance is
   meaningless without a green target).
2. plausible GPS -> GPS result (real position always preferred when trustworthy).
3. implausible GPS -> FALL THROUGH (do not early-return null — that was the old
   bug this feature fixes).
4. usable tee -> tee result `fromTee:true`.
5. otherwise -> `null` (honest idle).

**Bounds:** identical `Number.isFinite(d) && d >= 1 && d <= 800` on BOTH paths.
A tee->green over 800y is treated as bad data (implausible) and yields null, same
guard as GPS. `haversineYards` already rounds, so `distanceYards` is an integer.

**Why plain `haversineYards(tee, green)` and NOT `computeFCBDistances`:** the
opening phrasing needs ONE clear number ("about 365 to the pin"), which is the
straight-line tee->center distance. `computeFCBDistances` returns a front/center/back
triple whose `.center` is the same haversine value but forces us to pick a field
and pulls in more surface. Plain haversine is the single, unambiguous number and
reuses the exact bounds logic of the GPS path. (F/C/B tiles still use
`computeFCBDistances` elsewhere — unchanged.)

### 4. Rewire `resolveOpeningShot` in RoundPageClient
Add a `teeForHole` derived const next to `greenForHole` for clean callback deps,
then delegate the math to the helper:
```ts
const greenForHole = holeCoordsForTiles?.green ?? null;
const teeForHole = holeCoordsForTiles?.tee ?? null;
const resolveOpeningShot = useCallback(async () => {
  let pos: { lat: number; lng: number } | null = null;
  try {
    pos = await withTimeout(GPSWatcher.getCurrentPosition(), 6000);
  } catch {
    pos = null; // denied / timeout / throw -> null, helper attempts tee fallback
  }
  return resolveOpeningShotDistance(pos, teeForHole, greenForHole);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [greenForHole?.lat, greenForHole?.lng, teeForHole?.lat, teeForHole?.lng]);
```
Notes:
- The `if (!greenForHole) return null` early guard now lives inside the helper
  (`if (!green) return null`); behavior is identical (helper short-circuits before
  touching GPS math). The GPS is still awaited but that is harmless and keeps the
  code linear; if you prefer to skip the GPS call entirely when there is no green,
  add `if (!greenForHole) return null;` back at the top of the callback — either
  is acceptable, pick the linear version for simplicity unless it trips a test.
- Import: `import { resolveOpeningShotDistance } from "@/lib/caddie/opening-shot";`
- Deps array gains `teeForHole?.lat/lng`. The `openingFiredRef` + `openingGenRef`
  guards in CaddieSheet make callback-identity changes mid-open safe (the callback
  is captured once via `resolveOpeningShotRef`).

### 5. CaddieSheet phrasing (only line 708 changes)
```ts
const q = shot.fromTee
  ? `I'm on the tee, about ${shot.distanceYards} to the pin. What should I hit off the tee?`
  : `I'm about ${shot.distanceYards} yards from the pin. What should I hit or do on this next shot?`;
```
And update the prop type (~line 95):
```ts
resolveOpeningShot?: () => Promise<{ distanceYards: number; fromTee?: boolean } | null>;
```
Nothing else in the effect changes. The `setTranscript(q)` + `askCaddie(q, ...)`
lines and all guards are untouched.

---

## Implementation steps (sequenced)

1. Create `frontend/src/lib/caddie/opening-shot.ts` (pure helper + `OpeningShot`
   type) exactly as above.
2. `RoundPageClient.tsx`: import the helper; add `teeForHole`; rewrite
   `resolveOpeningShot` to acquire GPS then delegate to the helper (section 4).
3. `CaddieSheet.tsx`: widen the prop type (line ~95) and branch the question
   string on `shot.fromTee` (line 708). Nothing else.
4. Add unit tests: `frontend/src/lib/caddie/opening-shot.test.ts` (section below).
5. Add phrasing tests to `frontend/src/components/CaddieSheet.session.test.tsx`
   (section below).
6. Run all gates (section below).

---

## Tests (REQUIRED — deterministic, both paths + null)

### A. Pure-helper unit tests — new file `frontend/src/lib/caddie/opening-shot.test.ts`
Fully deterministic, no DOM, no GPS. Use real coords or trivially-computable ones;
assert on `fromTee` flag and rough distance, not exact yardage (haversine is exact
but keep asserts on presence + `fromTee`). Cases:
- `null` green + any gps/tee -> returns `null`.
- Plausible GPS present -> returns `{ distanceYards, fromTee falsy }` (assert
  `result.fromTee` is undefined/falsy); tee coords present too -> GPS still wins.
- GPS `null` (denied/timeout upstream) + tee present -> `{ fromTee: true }`.
- GPS present but IMPLAUSIBLE (place gps ~5000y from green, or same point ->
  d<1) + tee present & plausible -> falls through to `{ fromTee: true }`
  (this is the core new-behavior case — assert it does NOT return null).
- GPS `null` + tee `null` + green present -> `null` (honest idle).
- Tee present but tee->green implausible (>800y) + no GPS -> `null` (bounds hold
  on the tee path too).

### B. CaddieSheet phrasing tests — extend the auto-opening describe block (~line 645)
Reuse the existing `renderSheet` / `buildProps` harness and the
`sessionVoiceStreamMock` transcript-payload assertion pattern already used by test
(a) at lines 654-664 (assert on the mock payload's `transcript`, which is the
deterministic signal; optionally also `screen.findByText` the user bubble).
- **(a) GPS path unchanged (fromTee falsy):** `resolveOpeningShot` resolves
  `{ distanceYards: 147 }` (no `fromTee`) -> payload transcript contains "147"
  AND "yards from the pin" AND "What should I hit or do on this next shot", and
  does NOT contain "on the tee". (The existing test (a) already covers most of
  this; add the explicit negative assertion `not.stringContaining("on the tee")`
  to lock the regression.)
- **(b) tee path (fromTee:true) -> tee phrasing:** `resolveOpeningShot` resolves
  `{ distanceYards: 365, fromTee: true }` -> payload transcript contains "365",
  "on the tee", and "off the tee", and does NOT contain "yards from the pin".
  Also assert the user bubble renders the tee wording via `screen.findByText`
  (transparency) if the harness surfaces it.
- **(c) null path -> idle:** `resolveOpeningShot` resolves `null` -> no stream
  call, sheet shows idle "Ask anything". (Existing test (b2) at line 700 already
  covers this; keep it green — it doubles as the null-path guarantee. Optionally
  add an assertion that no "on the tee" text ever renders.)

All B tests must run under the SAME lifecycle as existing auto-opening tests
(single fire, guards intact). Do not modify the framer-motion mock or harness.

---

## Gates (builder MUST run all, from `frontend/`)
```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npx vitest run src/lib/caddie/opening-shot.test.ts src/components/CaddieSheet.session.test.tsx
```
(Or `npx vitest run` for the full suite if time allows.) All must pass.

---

## Reviewer must-check list (from owner)
- [ ] No fake GPS claims in prompt wording. The tee phrasing names the tee
      explicitly and uses the real tee->green number. The GPS phrasing is only
      used when `fromTee` is falsy (a real live fix). Never claims a position the
      player isn't at.
- [ ] `openingGenRef` / `openingFiredRef` / pristine-idle re-check guards
      (CaddieSheet lines 683-706) untouched. Only line 708 changed in the effect.
- [ ] Deterministic tests for BOTH paths (GPS falsy phrasing + `fromTee` tee
      phrasing) AND the null/idle path.
- [ ] All existing honest-null cases preserved (no green -> null; no GPS & no tee
      -> null).
- [ ] No shared-type / DTO changes (`types.ts`, `models.py` untouched).

---

## Edge cases & risks
- **GPS present but implausible (>800y or <1y):** MUST fall through to the tee
  fallback, NOT return null. This is the primary bug the feature fixes (home
  testing / pre-lock jitter). Covered by helper branch order + unit test.
- **Tee coords missing AND GPS failed:** returns null -> sheet idle (honest,
  preserved). This is the "even the tee is missing" case the owner calls out.
- **Green coords missing:** always null (early guard preserved) — a from-tee
  number needs a green target.
- **GPS plausible + tee also present:** GPS wins (real position preferred). Unit
  test asserts this priority.
- **Tee->green itself implausible (>800y bad data):** null via the same bounds —
  we don't emit an obviously-wrong tee number.
- **Rounding:** `haversineYards` already rounds; `distanceYards` is an integer on
  both paths. No `Math.round` added; scope not expanded. Documented above so a
  reviewer doesn't "fix" a non-bug.
- **`fromTee` optional/falsy default:** keeps GPS-path object shape and existing
  tests byte-identical; only the tee path sets the flag.
- **Callback deps growth (adds `teeForHole`):** safe — CaddieSheet captures the
  callback via `resolveOpeningShotRef` and fires once per open guarded by
  `openingFiredRef`/`openingGenRef`; a changed callback identity does not
  re-trigger the opening turn.
- **`withTimeout` returning null on timeout:** already handled — helper receives
  `null` and attempts the tee fallback (previously this produced idle; now it
  correctly produces a from-tee reco when tee coords exist).

## Critical files for implementation
- /Users/justinlee/projects/scorecard/frontend/src/lib/caddie/opening-shot.ts (NEW — pure helper)
- /Users/justinlee/projects/scorecard/frontend/src/app/round/[id]/RoundPageClient.tsx (rewire resolveOpeningShot)
- /Users/justinlee/projects/scorecard/frontend/src/components/CaddieSheet.tsx (prop type + line 708 phrasing)
- /Users/justinlee/projects/scorecard/frontend/src/components/CaddieSheet.session.test.tsx (phrasing tests)
- /Users/justinlee/projects/scorecard/frontend/src/lib/caddie/opening-shot.test.ts (NEW — helper unit tests)
