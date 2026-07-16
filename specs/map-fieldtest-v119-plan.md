# Map field-test v1.1.9 fixes — implementation plan (Fable)

## Summary + key root-cause verdicts

**All 5 classified NOTICEABLE.** Verdicts first, then the full contract.

- **#1 upside-down letters — CONFIRMED.** `isFlat: true` on the lettered bunker badges (`GoogleSatelliteMap.tsx:528`) rotates the baked north-up PNG with the down-the-line camera bearing; on south-ish holes the letter inverts. Fix: `isFlat: false` (billboard) on the lettered badges. The tee dot (`:480`, also `isFlat:true`) is a rotationally-symmetric colored disc — cosmetically unaffected; I recommend flipping it too for one honest convention, but it's optional. Plate circles are native `addCircles` — unaffected. No other lettered/oriented markers exist.

- **#2 missing big bunkers on Red-9 — HONEST, TWO-PART VERDICT.** The committed fixture `backend/tests/fixtures/bethpage_overpass.json` contains 270 `golf=bunker` features, **all `way` type, all single `Polygon`, zero `natural=sand`, zero relations/MultiPolygons.** So: (a) the "frontend `geom.type !== 'Polygon'` skip at `tee-shot-overlays.ts:572`" is a **real latent bug but NOT the demonstrable cause for Bethpage** — there is no MultiPolygon bunker in our data to skip. (b) What the fixture **does** demonstrate: applying the exact frontend filter math to Red-9's way-bunkers, ~6 pass and several **large-area bunkers (355–509 m²) are excluded by `CORRIDOR_MAX_LATERAL_YARDS=45`** (they compute 55–180y off the reconstructed centerline), and with `BUNKER_CAP=4` only 4 of the 6 survivors render. (c) The **structural gap** most likely to hide a "giant waste complex": the ingest Overpass query (`osm.py:796–807`) requests **only** `way["golf"="bunker"]` — never `relation[...]`, never `natural=sand`. A waste complex mapped as a multipolygon relation or `natural=sand` is invisible to us and, because the fixture *is* that query's output, **cannot be seen locally** — the builder must run a live Overpass probe to confirm. Minimal honest fix spans query + parser + both geometry consumers (details below).

- **#3 stray other-hole tee markers / hole-line fragments — ROOT CAUSE CONFIRMED: a two-writer race on `holeMarkerIdsRef`.** `handlePositionUpdate` (the GPS tick, `GoogleSatelliteMap.tsx:924–927`) calls `clearHoleOverlays` + `addHoleOverlays` **outside** the serialized camera queue, while the queue's `run` (`:608–611`) calls the same two functions. Both mutate `holeMarkerIdsRef.current`. Interleaved awaits let chain B's `addMarker` resolve after chain A has already written the ref, so chain A's marker id becomes untracked → an **orphan marker that no future `clearHoleOverlays` removes** → it persists as a stray tee marker on 8/11. Fix: single writer — route the GPS-tick overlay refresh through the same camera queue. Testable via the pure `createCameraQueue` most-recent-wins logic.

- **#4 draggable reticle — feasible on the native path.** Plugin typings confirm `draggable?: boolean` and `setOnMarkerDrag{Start,,End}Listener` with `MarkerClickCallbackData.{latitude,longitude,markerId}`. Plan: extract one shared `placeTarget(pos)` seam used by both the click handler and drag-end; live-update the FROM TEE/TO GREEN numbers on drag ticks (cheap React state), redraw polylines only on drag-end. No DOM-overlay projection (plugin has no projection API).

- **#5 Red-11 "PAR 3 · 462Y" — DATA/PARSE BUG, fixture confirms par 4.** The fixture's Red-11 way (`id 810888441`) is tagged **`par 4`**. The header reads par from `round.holes[currentHole-1].par` (`RoundPageClient.tsx:858` → rendered `:2095`), which is stale stored DB data (par 3), same class as the Red-3 bug the re-ingest fixed. Primary fix: sanctioned re-ingest (owner's standing Red approval covers it). Defense: a display-side sanity guard mirroring the caddie's `PAR_SANITY_MIN_YARDS_FOR_PAR3=280`. The caddie guard **does fire** for Red-11 (par 3, 462 > 280) — verified by reading `format_par_sanity_note`.

---

# specs/map-fieldtest-v119-plan.md — Map field-test v1.1.9 fixes

**Contract for the builder.** Five owner field-test fixes to the native Google Maps round hole view. Consistent with NORTHSTAR (quiet, yardage-book, voice-first, calm). All five are NOTICEABLE. Rebase onto `origin/integration/next` before starting; a concurrent multi-user slice-2 lane (`multiuser-p0-client-identity`, in progress per the `integration/next` tip) may land first — none of these five touch multi-user client-identity code, so expect a clean rebase; only `GoogleSatelliteMap.tsx` is a shared hot file, so land these promptly and re-check that file's head before opening the PR.

Evidence base: plugin marker options + drag listeners confirmed in `frontend/node_modules/@capacitor/google-maps/dist/typings/{definitions,map}.d.ts` (`isFlat`, `draggable`, `iconAnchor`, `zIndex`, `setOnMarkerDrag{Start,,End}Listener`, `MarkerClickCallbackData.{latitude,longitude,markerId}`). Bundled assets `bunker-marker-{a..f}.png` all present (cap can rise to 6 with no new art).

---

## Item 1 — Upside-down bunker letters

**Root cause (file:line).** `GoogleSatelliteMap.tsx:523–530` builds the lettered bunker badge markers with `isFlat: true`. A flat-to-ground marker rotates with the map; the map bearing is tee→green (`cameraForHole` → `bearingDegrees`, `google-map-helpers.ts:181`). The letter PNG is baked north-up, so on holes whose down-the-line bearing points south the badge rotates ~180° and the letter inverts. Since the camera is *already* oriented down-the-line, a **billboard** marker (`isFlat:false`, always upright to the screen) reads correctly down-the-line by construction.

**Exact change.**
- In `addTeeShotOverlays` (`:523–530`) set `isFlat: false` on the bunker badge markers. `iconAnchor` stays `{x:13, y:13}` (centered) — billboard keeps the same visual anchor/size; no size regression.
- Optional (recommended, state the call to the designer): also flip the tee dot at `:480` to `isFlat:false` so the map has one honest convention ("badges/markers billboard; only native circles lie flat"). The dot is a symmetric disc so it's visually identical either way — this is a consistency call, not a bug fix. Default: **flip it** unless the designer objects.
- Do NOT touch the plate circles (native `addCircles`, `:511–521`) — orientation-free.

**Testable seam.** Extract the bunker-marker option object into a tiny pure builder so the option can be asserted headlessly, e.g. `buildBunkerMarkers(bunkers: BunkerCarry[]): Marker[]` in `tee-shot-overlays.ts` (or a new `map/marker-options.ts`), returning `{ coordinate, iconUrl, iconSize, iconAnchor, isFlat:false, zIndex }`. `addTeeShotOverlays` calls it. Keep it minimal — no plugin import in the pure module.

**Gate.** Unit test (extend `tee-shot-overlays.test.ts` or new `marker-options.test.ts`): assert every marker from `buildBunkerMarkers([...])` has `isFlat === false` and `iconAnchor === {x:13,y:13}`. Lint + `tsc` + voice-tests smoke.

**Sync / risk.** No backend or `types.ts` counterpart. Risk: none — billboard is the plugin default; anchor unchanged.

---

## Item 2 — Missing big bunkers on Red-9

**Root cause — honest, from the committed fixture.** See the verdict above. Three findings from `backend/tests/fixtures/bethpage_overpass.json`:
1. **All 270 Bethpage bunkers are single-`Polygon` ways; no `natural=sand`, no relations.** So the frontend MultiPolygon skip (`tee-shot-overlays.ts:572`) and the caddie's `_feature_point` MultiPolygon skip (`hazards.py:180`) are **latent** — not the provable Red-9 cause for our data.
2. **The provable-from-fixture cause:** the lateral/cap windows. Reconstructing Red-9 (tee `-73.45911,40.75196` → green `-73.45925,40.74832`, 444y par 4) and applying the frontend predicate, ~6 way-bunkers pass; several large-area ones (355–509 m²) are cut by `minAbsLateralYards > CORRIDOR_MAX_LATERAL_YARDS (45)`, and `BUNKER_CAP=4` drops 2 more survivors.
3. **The unverifiable-locally gap:** the ingest query (`osm.py:796–807`) only asks for `way["golf"="bunker"]`. If Bethpage's waste complex is a multipolygon **relation** or `natural=sand` in live OSM, it never enters our data and the fixture (being that query's output) cannot show it.

**What the builder MUST verify against real data (do not fabricate).** Run a live Overpass probe for Red-9's bbox and diff against the way-only set:
```
[out:json][timeout:60];
(
  way["golf"="bunker"](around:400,40.7502,-73.4595);
  relation["golf"="bunker"](around:400,40.7502,-73.4595);
  nwr["natural"="sand"](around:400,40.7502,-73.4595);
);
out geom;
```
If the probe returns a relation or a `natural=sand` polygon covering the left waste area → the binding cause is the **query/parse gap** (fix A). If it does not → the binding cause is the **windows/cap** (fix B). Report which before finalizing.

**Minimal honest fix — do all of A (cheap, closes the structural gap) and the reasoned part of B.**

**Fix A — ingest inclusion (backend, keep caddie + map in sync).**
- `osm.py` geometry query (`fetch_course_geometry`, `:796–807`; and mirror in `fetch_hole_features`/the boundary query at `:678–685` if that path feeds mapped courses): add `relation["golf"="bunker"]` and `way/relation["natural"="sand"]`. Emit `out geom;` still works for relations via existing `_parse_relation` logic used for boundaries (`osm.py:565–582`).
- `_parse_course_geometry_response` (`osm.py:184–325`): handle `el_type == "relation"` for bunkers → build a `MultiPolygon` (reuse the boundary relation parser pattern at `:582`), and accept `tags.natural == "sand"` → `featureType:"bunker"` (a waste bunker is a bunker for carry purposes; keep it in the `bunkers` bucket). Guard: only sand polygons inside the course boundary (existing spatial-join step handles hole assignment).
- `courses_mapped.py` serves whatever `hole_features.geom` holds, so a stored MultiPolygon flows to the frontend unchanged (`:273–298`).

**Fix A (cont) — both geometry consumers must accept MultiPolygon (KEEP IN SYNC).**
- Frontend `fairwayBunkerCarries` (`tee-shot-overlays.ts:568–572`): mirror the existing fairway MultiPolygon handling (`fairwayRingsFromFeatures`, `:161–168`) — iterate each member's outer ring, run the per-vertex carry/lateral over the union of rings (min front / max back across all members so one waste complex = one A/B chip with an honest front/back span). Do **not** emit one chip per member.
- Backend caddie `_feature_point` (`hazards.py:169–182`): add a `MultiPolygon` branch → centroid of the largest member ring (or area-weighted centroid). This keeps the caddie corridor profile and the map agreeing on inclusion.

**Fix B — windows/cap, with reasoned bounds (frontend `tee-shot-overlays.ts`).**
- Raise `BUNKER_CAP` `4 → 6` (`:91`). Assets A–F already exist and `letter` assignment already covers `i < 6` (`:654`) — zero new art, no fabrication, just stops silently dropping in-play bunkers on a heavily-bunkered hole. Inline card keeps its own tighter `maxBunkers: 2` (`GoogleSatelliteMap.tsx:381`) so the in-round card stays calm.
- Lateral window: prefer **not** a blanket raise (45→N invites cross-hole spam). Instead make lateral relative to fairway half-width where fairway geometry exists: keep the 45y absolute cap as a ceiling, but also admit a bunker whose near edge touches the mapped fairway ring (reuse `latLngInRing`/`fairwayRingsFromFeatures`, `:191`, `:149`) — an edge-of-fairway waste bunker is in play regardless of centerline lateral. If the live probe (above) shows the Red-9 complex is genuinely 45–60y off a straight centerline on a dogleg, this fairway-adjacency admit is the honest inclusion; a naive lateral bump is not.
- Leave `BUNKER_FLOOR_YARDS=100` / `BUNKER_CEILING_YARDS=330` / `GREENSIDE_MIN_YARDS=45` unchanged (they're honest carry windows).

**Sync map (every counterpart).**
- `osm.py` (query + parser) — upstream for both.
- `tee-shot-overlays.ts:fairwayBunkerCarries` (MultiPolygon + cap + fairway-adjacency) ↔ `hazards.py:_feature_point` (MultiPolygon). **Note:** `extract_corridor_profile` (`hazards.py:558–597`) intentionally does NOT apply the map's floor/ceiling/lateral windows — it's a broader caddie profile capped at `_DEFAULT_CAP=5`. Do **not** import the map windows into the caddie; only the **geometry inclusion** (MultiPolygon, sand) is shared.
- No `types.ts`/`models.py` shape change (`featureType:"bunker"` already exists; geometry column is generic JSONB/geometry).

**Gates (fixture-based, no live dependency in CI).**
- New frontend test in `tee-shot-overlays.test.ts`: a synthetic "Red-9-like" FeatureCollection containing (i) a MultiPolygon bunker on the fairway edge and (ii) 6 corridor bunkers — assert the MultiPolygon now yields exactly one `BunkerCarry` with the expected front/back span, and that a **tight-course fixture** with 8 candidates still returns ≤6 sorted ascending by front (cap + ordering prevents spam).
- Backend test in `test_hazards.py`: a MultiPolygon bunker feature yields a hazard (not silently dropped).
- Backend test in `test_ingest_osm_course.py`/`test_parse`: a `relation["golf"="bunker"]` and a `natural=sand` way both land in the `bunkers` bucket.
- Builder attaches the live Overpass probe result to the PR stating which cause was binding.

---

## Item 3 — Stray other-hole tee markers / hole-line fragments (holes 8/11)

**Root cause (file:line) — two-writer race on `holeMarkerIdsRef`.** Confirmed by tracing every add/clear path:
- Adders of the tee marker: the camera queue `run` (`GoogleSatelliteMap.tsx:611`, via `addHoleOverlays`), the GPS tick (`:926`, via `addHoleOverlays`), and init (`:769`).
- Clearers: the queue `run` (`:608`), the GPS tick (`:925`), both via `clearHoleOverlays` (`:399–411`).
- The queue is a single serialized writer, **but the GPS-tick path (`handlePositionUpdate`, `:924–927`) runs its own un-serialized `clearHoleOverlays`→`addHoleOverlays` chain.** Both chains read-modify-write the same `holeMarkerIdsRef.current` across `await` points. Interleaving: queue chain A does `removeMarkers(old)` … `addMarker → idA` … `ref=[idA]`; GPS chain B, started concurrently, `addMarker → idB` resolves *after* A wrote the ref, so `ref=[idB]` and **idA is now on-map but untracked**. The next hole change clears `[idB]` only; idA survives as a stray tee marker on the newly framed hole (8/11). "Hole-line fragments" are the same orphaned markers (there are no hole polylines — `holePolylineIdsRef` is always `[]`; tap lines are cleared on hole change at `:873`), so this single race explains both symptoms.

**Fix — single writer.** Route the GPS-tick overlay refresh through the same camera queue so there is exactly one owner of `holeMarkerIdsRef`.
- Add a lightweight request type to the queue (or a second queue method) so the GPS tick enqueues an "overlay refresh for `hd` with `pos`" instead of calling `clearHoleOverlays`/`addHoleOverlays` directly. Simplest: give `createCameraQueue` requests a discriminated payload `{ hd, reason: 'hole' | 'gps', pos }`; the `run` closure already does clear→frame→add and can skip the camera move when `reason==='gps'` and the follow threshold isn't met (reuse `movedBeyondYards`). The GPS "you" dot and auto-detect logic stay in `handlePositionUpdate` (they don't touch `holeMarkerIdsRef`); only the `clearHoleOverlays`/`addHoleOverlays` pair moves into the queued `run`.
- Because the queue is most-recent-wins and serialized, no two chains ever write the ids concurrently → no orphan.

**Gate (pure, no native plugin).** Extend `google-map-helpers.test.ts` for `createCameraQueue`: simulate a hole-change request immediately followed by a GPS-refresh request while the first `run` is in flight; assert `run` executes serially and the **last** target wins (a single trailing execution), and that a synchronous id-tracking mock never ends with an untracked id (model the ref as a set the fake `run` mutates; assert the set matches the last-added id after the queue drains). Also add a regression note test that `handlePositionUpdate` no longer calls `clearHoleOverlays`/`addHoleOverlays` directly (grep-level or a shallow render assertion).

**Sync / risk.** No backend counterpart. Risk: ensure the appStateChange re-frame (`:993–1010`) and init overlays still work — both already go through the queue or run before GPS starts, so single-writer is preserved. Verify the GPS "you" dot still updates every tick (it must stay outside the queue, on `gpsMarkerIdRef`, which is a separate ref — unaffected).

---

## Item 4 — Draggable aim reticle

**Root cause / today's behavior (file:line).** Tap-to-place only: `setOnMapClickListener` (`GoogleSatelliteMap.tsx:782–834`) computes `tapTargetDistances`, sets the card via `setTapTarget`, clears+redraws the white tee→target and amber target→green polylines, drops the reticle `iconUrl:"assets/tap-target.png"` (`:827–833`). No drag. Plugin supports `draggable` + drag listeners (typings confirmed).

**Exact change.**
1. **One shared seam.** Extract the place-target body into `placeTarget(pos: {lat,lng})` (a `useCallback` in the component, since it touches refs/state/plugin): compute `tapTargetDistances` → `setTapTarget`; `clearTapMarker`; redraw the two polylines; place/replace the reticle. The click handler becomes `placeTarget({lat:ev.latitude,lng:ev.longitude})`. No math fork.
2. **Make the reticle draggable.** Add `draggable: true` to the reticle marker (`:827`). Register once (in the init effect, alongside the click listener):
   - `setOnMarkerDragListener` (live tick): if `data.markerId === tapMarkerIdRef.current`, call the **cheap** path only — recompute distances from `{data.latitude,data.longitude}` and `setTapTarget(...)`. Do **not** redraw polylines here (plugin remove+add per tick is too heavy). Keep the existing lines in place (calm interim); optionally dim them to `strokeOpacity ~0.5` on drag-start and restore on drag-end.
   - `setOnMarkerDragEndListener` (final): call `placeTarget({lat:data.latitude,lng:data.longitude})` — the SAME seam as tap, so drag-end math == tap math for the same point, and the polylines/reticle settle to the final position.
   - Guard every callback with `markerId === tapMarkerIdRef.current` so drags of any other marker are ignored.
3. **Affordance (designer-checked, yardage-book, no SaaS clutter).** Keep the existing reticle art; add a subtle grab cue consistent with the printed-book feel — e.g. a faint 1px hairline ring / very soft shadow that only appears while a target exists, not a Material "drag handle." No new color language. Haptic: fire `@capacitor/haptics` `impact({style: ImpactStyle.Light})` on drag-**start** only (cheap, already a dep) — not per tick.
4. **Honest fallback.** If native drag listeners prove unreliable on device, keep `draggable:true` off and tap-to-move stays the interaction; state this in the PR rather than shipping a janky drag. No DOM-overlay lat/lng projection (plugin has no projection API — prior lane proved it).

**Gate.**
- Unit: the extracted math is already pure (`tapTargetDistances`, `google-map-helpers.test.ts`) — add a test asserting `placeTarget`'s distance computation for point P equals the tap-path result for P (same seam). Since `placeTarget` is component-bound, assert at the pure level: both paths call `tapTargetDistances(P, green, tee, false, dist)` with identical args (extract the arg-building into a pure helper if needed).
- On-device verify (`/verify` or the run skill): drag reticle → numbers update live → release → lines redraw at final point → value persists like a tap; tap-to-place still works (no regression); dragging near the panel doesn't scroll the map.

**Sync / risk.** No backend/`types.ts` change. Risk: drag listener registration must be idempotent (register once in init, like the click listener); ensure `clearTapMarker` on hole change also resets any drag-dim state.

---

## Item 5 — Red-11 shows "PAR 3 · 462Y"

**Root cause (file:line) + evidence.** Header renders `Par {holePar}` / `{headerYards}y` at `RoundPageClient.tsx:2095–2096`; `holePar = round?.holes[currentHole-1]?.par ?? hole.par` (`:858`). That par is stored round/course data. The **fixture proves the correct par is 4**: Red-11 way (`golf:course:name="Red"`, `ref=11`, `id 810888441`) is tagged `par 4`. So the stored DB `holes.par` for Red-11 is stale/wrong (par 3) — same class as the Red-3 bug the re-ingest fixed. `courses_mapped.py` reads `holes.par` (`:295`, default 4 at `:309/:393`) and the parse at `osm.py:235` (`int(par_str) if par_str.isdigit() else None`) is correct for the current tag — so this is **data, not parse**.

**Fix — primary + defense.**
1. **Primary (data): sanctioned Red re-ingest.** Re-ingest Bethpage Red from current OSM (owner's standing Red re-ingest approval covers corrections — note it explicitly in the PR). This writes `par=4` for Red-11. The builder must **verify against real stored data** first: query `holes.par` for the Red course hole 11 (staging DB) to confirm it currently reads 3; if it already reads 4, the wrong par is coming from the **round snapshot** (`round.holes`), and the round must be re-seeded from the corrected course. No local Postgres on this machine — do this on staging.
2. **Defense (display-side sanity guard).** Add a frontend guard mirroring `PAR_SANITY_MIN_YARDS_FOR_PAR3=280` so the header never confidently prints an absurd par: when `holePar === 3 && headerYards != null && headerYards > 280`, suppress the "3" (render `Par —` or omit the par token) rather than assert a false par. Keep it a tiny pure helper (e.g. `displayPar(par, yards)` next to the header or in a small `lib/hole/par-sanity.ts`) so it's unit-testable and reusable by any header. This protects against upstream-OSM-wrong cases too (flag those upstream separately).
3. **Caddie guard already fires** for Red-11 (par 3, 462 > 280) — confirmed by reading `format_par_sanity_note` (`voice_prompts.py:261–267`); no change needed there, but keep the frontend threshold literally equal to the backend constant (280) and comment the cross-reference so they can't drift.

**Gate.**
- Frontend unit (new `par-sanity.test.ts`): `displayPar(3, 462) → null/suppressed`; `displayPar(3, 180) → 3`; `displayPar(4, 462) → 4`; `displayPar(5, 620) → 5`.
- Backend: `test_par_sanity_guard.py` already covers the caddie note; add/confirm a case at 462y.
- Post-re-ingest verify on staging: Red-11 header reads `PAR 4 · 462Y`.

**Sync / risk.** Keep the frontend 280 threshold in lockstep with `voice_prompts.py:PAR_SANITY_MIN_YARDS_FOR_PAR3`. `types.ts`/`models.py`: no shape change (par already `int|null`). Risk: the guard must not suppress legitimate long par 3s ≤280; 280 is the agreed floor.

---

## Landing order & process
- Rebase the branch (`fix/map-fieldtest-v119`) onto `origin/integration/next`; the multi-user slice-2 lane may land first — only `GoogleSatelliteMap.tsx` overlaps their surface area lightly, so re-check its head before opening the PR.
- Commit per item (workflow rule: one feature at a time). Items #2 and #5 touch backend + a re-ingest — run `ruff check .` and the backend tests; items #1/#3/#4 run `npm run lint`, `npx tsc --noEmit`, and `npx tsx voice-tests/runner.ts --smoke`.
- #4 is user-facing interaction → `/security-review` not required (no new endpoint/auth), but `/code-review` + designer review the reticle affordance. #2's ingest query change touches a data path → run `/code-review`.
- All five are NOTICEABLE → they bundle into the next approval request.

---

### Critical Files for Implementation
- /Users/justinlee/projects/scorecard/frontend/src/components/GoogleSatelliteMap.tsx  (items 1, 3, 4)
- /Users/justinlee/projects/scorecard/frontend/src/lib/map/tee-shot-overlays.ts  (items 1, 2)
- /Users/justinlee/projects/scorecard/backend/app/services/osm.py  (item 2 query+parse; item 5 parse ref)
- /Users/justinlee/projects/scorecard/backend/app/caddie/hazards.py  (item 2 MultiPolygon sync)
- /Users/justinlee/projects/scorecard/frontend/src/app/round/[id]/RoundPageClient.tsx  (item 5 header par + sanity guard)

Supporting: `frontend/src/lib/map/google-map-helpers.ts` (queue seam, item 3/4 tests), `backend/tests/fixtures/bethpage_overpass.json` (item 2/5 fixture evidence), `backend/app/caddie/voice_prompts.py` (item 5 threshold source of truth).