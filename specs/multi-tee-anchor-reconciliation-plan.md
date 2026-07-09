# Implementation Plan — Multi-Tee Anchor Reconciliation ("from the tee" ≠ card yardage)

Spec: `specs/multi-tee-anchor-reconciliation.md` (contract). Third geometry-anchor incident
(after hazards + doglegs) — correctness over cleverness; every derived number must be honest
or absent, per NORTHSTAR.

---

## 0. Verified diagnosis — the two disagreeing code paths (as they exist today)

**Leg A — where the tiles' tee anchor comes from (the 232y back tee):**

- `frontend/src/app/round/[id]/RoundPageClient.tsx` line 1064:
  `const holeCoordsForTiles = mapCoords.find((c) => c.holeNumber === currentHole) ?? null;`
  and lines 1106–1108: `fcbFromTee = holeCoordsForTiles?.tee ? computeFCBDistances(holeCoordsForTiles.tee, holeCoordsForTiles) : null;`
- `mapCoords` comes from `useHoleCoordinates(mappedCourse?.id)` (`frontend/src/lib/map/use-hole-coordinates.ts`), which resolves per-hole coords as: `getCourseCoordinates(courseId)` (backend `GET /api/courses/mapped/{id}/golf-coords` → `golfapi_cache.json`, else the hardcoded `MOCK_BLACK`/`MOCK_RED` in `frontend/src/lib/course/course-coordinates.ts` whose `tee` is the OSM centerline **first point** — the back tee), else `mappedCourseToCoordinates(course)` (`frontend/src/lib/courses/mapped-course-api.ts` lines 114–119), which takes the **first** `featureType === 'tee'` polygon centroid: `else if (ft === 'tee' && !tee) tee = centroid;` — tee box `[0]`, regardless of the player's tee.
- Every hole stores **all** its tee boxes as separate `featureType: "tee"` polygon features in the mapped-course GeoJSON (`backend/app/services/courses_mapped.py` `get_course`, lines ~210–235); each feature may carry `properties.teeSet` (editor-assigned tee set name via `hole_features.tee_set_id`) — OSM-ingested tees currently carry only `{featureType, osm_id}` (`backend/app/services/osm.py` lines 266–274). The `tee`/`green` "top-level None + empty yardages" in the spec corresponds to `HoleData.yardages = {}` and no golfapi-cache entry — so the arbitrary geometry pick wins.
- The same wrong anchor also feeds: `holeBearing` (wind label, line 1131), `playsBase` via `fcbFromTee.center` (line 1158), `resolveOpeningShot`'s `teeForHole` (line 1072), `fetchCourseIntel`'s per-hole `tee` (line 731 — so the server-computed `effective_yards`/elevation are measured from the wrong tee too), and the colored tee-marker on both maps (`GoogleSatelliteMap.tsx` line 374: marker at `hd.tee`).

**Leg B — where the header 178Y comes from:**

- The hole-stats pill (RoundPageClient line 1812) renders `{hole.yards}y` where `hole = HOLES[currentHole - 1]` — the **illustration mock** (`frontend/src/components/yardage/HoleIllustration.tsx` line 20: hole 3 = `{ par: 3, yards: 178 }`). Round data (`round.holes[i].yards`, `HoleInfo.yards?`) is the authoritative card source when present (tournament flow stores `selectedTee?.holes` with yards, `NewTournamentRoundClient.tsx` line 439; the standard `round/new` flow stores `createDefaultCourse` holes with **no** yards). So today the header can show a number from a *third* source. The fix must make header and tiles derive from one reconciled ladder.

**Leg C — the player's selected tee (already known):**

- Set at round start: `frontend/src/app/round/new/page.tsx` line 371/404 `teeName: teeLabel` (from `TEE_OPTIONS`, e.g. "White"), voice path `handleVoiceSetup` → `setTee(...)` (lines 262–269), tournament path `teeName: selectedTee?.name` + `teeId`. Persisted on the round: `Round.teeName` / `Round.teeId` (`frontend/src/lib/types.ts` lines 193–194; backend parity `backend/app/models.py` lines 134–135/162–163 — already in sync, no model change needed).
- In RoundPageClient it is already read at line 663: `const teeMarker = round?.teeName ?? ""` (drives the colored tee marker via `teeColorFor` in `lib/map/google-map-helpers.ts`). **This is the value to thread into the anchor selection.**

---

## 1. Approach

Do the selection in **one pure, unit-tested module**, expose all stored tee boxes on the shared coords shape, and apply the anchor once where `mapCoords` is derived — so tiles, plays-like, wind bearing, opening shot, course-intel, and both maps' tee markers all agree by construction.

### Step 1 — New pure module: `frontend/src/lib/course/tee-anchor.ts`

No React, no network (same pattern as `fcb-labels.ts` / `hole-projection.ts`). Uses `yardsDistance` from `lib/course/hole-projection.ts` (yards everywhere; geometry is lat/lng so there is no meters ambiguity — document that `HoleInfo.yards` and `HoleData.yardages` are yards by convention).

```ts
export interface TeeBox {
  point: { lat: number; lng: number };
  /** properties.teeSet (editor) or properties.ref/name (OSM), lowercased; null when untagged. */
  name: string | null;
  /** Straight-line yards from this box to the hole's green center. */
  yardsToGreen: number;
}

/** All featureType==='tee' polygon centroids for one hole, measured against its green. */
export function extractTeeBoxes(
  features: GeoJSON.Feature[],
  green: { lat: number; lng: number },
): TeeBox[];

export type TeeAnchorSource = "named" | "card" | "single" | "legacy" | "card-only";

export interface TeeAnchor {
  tee: { lat: number; lng: number } | null;  // null only for source 'card-only'
  source: TeeAnchorSource;
  cardYards: number | null;                  // resolved card yardage used (or null)
}

export function resolveTeeAnchor(opts: {
  currentTee: { lat: number; lng: number } | null; // existing coords.tee (golfapi/mock/first-polygon)
  green: { lat: number; lng: number } | null;
  boxes: TeeBox[];
  teeName: string | null;      // round.teeName
  cardYards: number | null;    // round.holes[i].yards ?? course yardages[teeName] (resolved by caller/integration)
  par: number | null;
}): TeeAnchor;
```

**Selection algorithm (the crux — spec §fix.1):**
1. **Named match:** case-insensitive equality of `box.name` vs `teeName`; else mutual-substring match (mirrors `teeColorFor`'s tolerance, so "White · Middle" matches "white"). If exactly one box matches → `named`.
2. **Card-nearest fallback:** if `cardYards != null` and boxes exist → pick `argmin |box.yardsToGreen − cardYards|`. Sanity bound: reject if best `|Δ|/cardYards > 0.25` (a 178 card must not silently adopt a 136 box for a different routing). Result → `card`. **Tie rule (deterministic, tested):** exact tie → the longer (back-most) box, so the golfer is never handed a shorter-than-actual number for club selection.
3. **Single box:** exactly one box, no card/name signal → use it (`single`).
4. **Nothing to choose with:** keep `currentTee` (`legacy`) — with no card number there is nothing to contradict.

**Reconciliation guard (spec §fix.3), par-aware so doglegs don't misfire (edge case 8):**
After steps 1/3/4, if `cardYards != null`, compute `geo = yardsDistance(tee, green)`:
- **Par 3:** `|geo − cardYards| / cardYards > 0.08` → re-run step 2 (card-nearest). Tee→green *is* the card number on a par 3.
- **Par 4/5:** only `geo > cardYards × 1.08` → re-run step 2. Straight-line ≤ card is legitimate on doglegs (card is measured along the routing) and must never trigger; straight-line *longer* than card means wrong tee box.
- If after re-anchoring the best candidate still fails the guard (or there are no boxes at all — e.g. the mock's single 232y centerline tee vs a 178 card): return `{ tee: null, source: "card-only", cardYards }` — the honest fallback (spec §fix.5). Never show a contradictory geometry number.

### Step 2 — Expose tee boxes on the shared coords (frontend-only shape change)

- `frontend/src/lib/golf-api.ts` — extend `CourseCoordinates` with `teeBoxes?: Array<{ lat: number; lng: number; name: string | null }>` (optional; nothing breaks).
- `frontend/src/lib/courses/mapped-course-api.ts` `mappedCourseToCoordinates` — collect **all** tee polygon centroids per hole (not just the first) into `teeBoxes`, reading `feat.properties.teeSet ?? feat.properties.ref ?? feat.properties.name`. Keep the existing single `tee` field's behavior (first box / centerline) as the neutral default for non-round consumers (course editor/map pages stay untouched).
- Add a small helper (same file or `tee-anchor.ts`): `attachTeeBoxes(coords: CourseCoordinates[], course: CourseData): CourseCoordinates[]` — merges `teeBoxes` extracted from the mapped course's features onto coords **even when the golfapi-cache/mock path won** (this is what makes the Bethpage prod case fixable: `MOCK_BLACK` provides green/front/back, the stored course features provide the 5 tee boxes). Both `use-hole-coordinates.ts` and `InlineHoleDiagram.tsx` already fetch `fetchMappedCourse` + `getCourseCoordinates` in the same `Promise.all` — call `attachTeeBoxes` in both, on the `effective` coords.

### Step 3 — Apply the anchor once in RoundPageClient (spec §fix.2)

In `RoundPageClient.tsx`, derive anchored coords with a `useMemo` (pure helpers; recomputes when the round or coords change — ordering is safe because `mappedCourse` is only set after `round` loads, so `teeName`/`holes` are present before `mapCoords` exists):

```ts
const { coords: anchoredCoords, anchorByHole } = useMemo(
  () => applyTeeAnchors(mapCoords, {
    teeName: round?.teeName ?? null,
    holes: round?.holes ?? [],   // cardYards per hole = holes[i].yards ?? null
  }),
  [mapCoords, round?.teeName, round?.holes]
);
```

`applyTeeAnchors` (in `tee-anchor.ts`) maps each hole through `resolveTeeAnchor` and returns coords with `tee` overridden, plus `Map<number, TeeAnchor>`. Then **replace every `mapCoords` consumer** with `anchoredCoords`:
- line 1064 `holeCoordsForTiles` → F/C/B tiles and `fcbFromTee` now anchor to the mapped tee box (fix target).
- line 726 `fetchCourseIntel(mapCoords…)` → server elevation/`effective_yards` measured from the right tee, so the Plays tile's elevation term aligns too.
- line 558 `fallbackTee` (weather anchor) and line 2293 fullscreen `GoogleSatelliteMap holeCoordinates` → the fullscreen map's colored tee marker (drawn at `hd.tee`, GoogleSatelliteMap.tsx:374) sits on the player's tee.
- `holeBearing` (1131) and `resolveOpeningShot`'s `teeForHole` (1072) pick it up automatically via `holeCoordsForTiles`.

**Inline map tee marker:** `InlineHoleDiagram` self-fetches its coords, so add one optional prop `teeOverrideByHole?: ReadonlyMap<number, { lat: number; lng: number }>` (built from `anchorByHole` in RoundPageClient); applied via `useMemo` over its `allCoords`/`coordsIndex` before rendering. When absent, behavior is unchanged (other call sites unaffected).

### Step 4 — Header reconciliation + honest card fallback (spec §fix.3, §fix.5)

Define one ladder in RoundPageClient:

```ts
const cardYards = round?.holes[currentHole - 1]?.yards ?? null;              // authoritative card
const anchor = anchorByHole.get(currentHole) ?? null;
const headerYards =
  cardYards ?? fcbFromTee?.center ?? (mappedCourse || roundAnchor ? null : hole.yards);
```

- Hole-stats pill (line 1812): render `headerYards != null ? `${headerYards}y` : "—"` — **stop showing the mock `hole.yards` on mapped-course rounds** (that mock constant is exactly where a phantom "178" can come from on courses that aren't the mock). Paper-fallback (no course data) keeps the illustration numbers as today.
- Tiles: three states —
  1. `fcbLive` (GPS) — untouched, still wins (Step 5).
  2. `anchor.source !== "card-only"` and `fcbFromTee` — geometry tiles as today, now from the right tee. By construction they agree with `headerYards` (guard enforces ≤8%).
  3. `anchor.source === "card-only"` — honest card tiles: `Center = cardYards`, `Front`/`Back` = `"—"`, caption "from the card", `playsBase = cardYards` (skip `holeIntel.effectiveYards` here — it was computed from unusable geometry). Widen `DistancesCardProps.fcbTiles` `v: number` → `v: number | string` (render already tolerates strings).
- `frontend/src/lib/caddie/fcb-labels.ts`: extend `FcbSource` to `"you" | "tee" | "card"`; `fcbSourceCaption("card")` → `{ text: "from the card", isLive: false }`; add `fromCard?: boolean` to `playsSubLabel` (no-wind branch returns `"from card"`; wind branch `"wind on card"` or keep `"wind-adj"` — designer reviews the exact string). Never claim `wind+elev` in card-only state.

### Step 5 — GPS override preserved (spec §fix.4)

The live-rangefinder branch is RoundPageClient lines 1088–1121: `GPSWatcher` → `playerPos` → `posOnHole` plausibility (`5 ≤ yardsDistance(playerPos, green) ≤ 800`) → `fcbLive = computeFCBDistances(playerPos, …)`; `fcb = fcbLive ?? fcbFromTee` (1119), `playsBase = fcbLive ? fcbLive.center : …` (1156). **Do not touch this branch.** The anchor change only alters `fcbFromTee` and the card-only state; `fcbLive`, `posOnHole`, `fcbSource === "you"` and its caption remain the first priority. Add an explicit test/assertion in the new unit tests that a live position bypasses the anchor entirely.

### Step 6 — Backend (small, non-blocking enhancement)

- `backend/app/services/osm.py` (~line 266): preserve `ref` / `name` OSM tags on `tee` features' `properties` at ingest so future re-ingested courses support named matching (today only editor-assigned `teeSet` names exist). No model or route changes; existing rows unchanged (named matching simply falls through to card-nearest for them, which is the workhorse anyway).
- `backend/app/models.py`: verified already in sync — `Round.teeId/teeName` (lines 134–135), `HoleInfo.yards: Optional[int]` (line 88). **No shape change ships**, so `frontend/src/lib/types.ts` ↔ `models.py` stay aligned; the only type edits are frontend-local (`CourseCoordinates.teeBoxes`, `FcbSource`, `DistancesCardProps`).

---

## 2. Tests (must go RED on the pre-fix world — per `tasks/lessons.md` teeth rule)

New `frontend/src/lib/course/tee-anchor.test.ts` (vitest, pure):

1. **Hole-3 fixture (the proof):** synthesize a green at a fixed lat/lng and 5 tee boxes due south at 232/207/174/159/136 yards (invert `yardsDistance`: Δlat = yards/1.09361/111320 m-per-deg; assert each box's `yardsToGreen` within ±1y first). With `teeName: "White"` (boxes untagged, as in prod), `cardYards: 178`, `par: 3` → selected box = the 174y box; `computeFCBDistances(anchor.tee, coords).center` ≈ 174 (assert 166–186, i.e. ≈ card 178, and explicitly `not ≈ 232`).
2. **Named match wins:** tag the 207 box `teeSet: "White"` → named selection picks it even when card 178 is nearer another box... then **guard test:** par 3, named 232 box with card 178 (>8%) → re-anchored to 174 (card wins, spec §fix.3).
3. **Card-nearest tie:** two boxes equidistant from card → deterministic back-most box.
4. **Sanity bound:** card 178, only boxes 136 and 400 → `|Δ|/card > 25%` → `card-only`.
5. **Dogleg no-misfire:** par 5, card 548, straight-line tee→green 470 (−14%) → guard does NOT fire; par 5 geo 600 vs card 548 (+9.5%) → fires.
6. **Honest fallbacks:** zero boxes + card contradicting legacy tee (mock 232 vs card 178, par 3) → `card-only`; zero boxes + no card → `legacy` (keeps incoming tee); no teeName + no card + 5 boxes → `legacy`.
7. **`attachTeeBoxes`:** golfapi/mock coords enriched with polygon-derived boxes; `mappedCourseToCoordinates` returns all 5 boxes (not just `[0]`).

Extend `frontend/src/lib/caddie/fcb-labels.test.ts` (exists? if not, add): `fcbSourceCaption("card")`, `playsSubLabel({ fromCard: true, ... })`. Do **not** weaken any existing assertion (lessons.md #116 rule); the existing `DistancesCard.test.tsx` captions stay as-is.

**Gates (all must be SUCCESS, not merely not-failed):**
```
cd /Users/justinlee/projects/scorecard/frontend && npm run lint && npx tsc --noEmit && npm run test && npm run build && npx tsx voice-tests/runner.ts --smoke
cd /Users/justinlee/projects/scorecard/backend && ruff check .
```

## 3. Edge cases & risks

- **0 tee boxes / unmapped hole** → `legacy` or `card-only`; never crash, never fabricate.
- **Card yardage missing** (standard `round/new` rounds store no yards) → named/single/legacy path; header falls back to anchored geometry center — header and tiles agree from the other direction.
- **Player changed tees mid-round** → not modeled (`round.teeName` fixed at creation); accepted limitation — the GPS override shows truth from wherever they actually stand.
- **9-hole rounds / hole count mismatch** → index by `holeNumber`, guard `round.holes[i]` undefined.
- **Units** — all geometry distances via `yardsDistance` (yards); never read OSM `dist` tags (unit-ambiguous).
- **Intel one-shot ordering** — `courseIntelSentRef` fires once; confirm it fires with anchored coords (it does: `mappedCourse` requires a loaded round). Note in code comment.
- **Regression surface** — course editor / `/map/course` pages use `mappedCourseToCoordinates` too: keep its single `tee` field semantics identical; only *add* `teeBoxes`.
- Designer review required (user-facing tile/caption/header strings) per NORTHSTAR; adversarial (Fable) review required per the spec's closing note.

## 4. Suggested build order

1. `tee-anchor.ts` + tests (pure, red→green against fixture) 2. `CourseCoordinates.teeBoxes` + `mappedCourseToCoordinates`/`attachTeeBoxes` + hook enrichment 3. RoundPageClient integration (anchored coords, header ladder, card-only tiles) + `fcb-labels`/`DistancesCard` prop widening + `InlineHoleDiagram` override prop 4. osm.py tag preservation 5. gates + designer/adversarial review.

### Critical Files for Implementation
- `frontend/src/app/round/[id]/RoundPageClient.tsx` (anchor application, header ladder, card-only tiles; lines 1060–1173, 1812, 726, 2293)
- `frontend/src/lib/course/tee-anchor.ts` (new — selection + reconciliation, the crux) with `frontend/src/lib/course/tee-anchor.test.ts`
- `frontend/src/lib/courses/mapped-course-api.ts` (collect all tee polygons → `teeBoxes`)
- `frontend/src/lib/map/use-hole-coordinates.ts` and `frontend/src/components/course/InlineHoleDiagram.tsx` (enrich effective coords; tee-override prop)
- `frontend/src/lib/caddie/fcb-labels.ts` + `frontend/src/components/yardage/DistancesCard.tsx` (honest "from the card" state); backend touch limited to `backend/app/services/osm.py` (preserve tee `ref`/`name` tags)
