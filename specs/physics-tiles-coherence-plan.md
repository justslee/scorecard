# Physics/Tiles Coherence — one plays-like number, everywhere

**Goal (noticeable):** the round page's PLAYS tile shows the SAME plays-like number the
caddie cites for the same hole + conditions. Today they can disagree: the tile runs a
deprecated frontend heuristic while the caddie runs the RK4 ball-flight engine. Fix:
the tile consumes the backend physics number; the deprecated heuristic stops being used.

## 1. Verified current state (receipts)

- **Tile (divergent path):** `frontend/src/app/round/[id]/RoundPageClient.tsx` ~1215
  renders `playsLikeYards(playsBase, holeWind.headMph)` from
  `frontend/src/lib/map/wind.ts` (`@deprecated`, +0.8%/mph head / −0.5%/mph tail,
  clamp ±15%). `playsBase` (~1205) is `fcbLive.center` (live rangefinder) →
  `cardYards` (card-only fallback) → `holeIntel.effectiveYards` (backend
  `elevation_only_plays_like`) → `fcbFromTee.center`. So the tile today =
  backend elevation term + frontend wind heuristic — the wind term diverges from
  the caddie.
- **Caddie (source of truth):** `POST /caddie/session/shot-distance`
  (`backend/app/routes/caddie.py:503`, `ShotDistanceRequest` at :491) →
  `shot_distance_payload` (`backend/app/caddie/tools.py:568`). With `target_yards`
  it returns `plays_like_yards` via `physics_plays_like`
  (`backend/app/caddie/club_selection.py:85`) on the RK4 engine
  (`backend/app/caddie/physics.py`), using session weather + the hole's
  `elevation_change_ft`. Honest degradation already in place (`available:false`
  when no club distances; still-air / flat-ground assumptions surfaced).
- **The north-wind gap:** `shot_distance_payload` calls
  `physics.conditions_from_weather(weather, shot_bearing_deg=0.0, ...)`
  (tools.py:619–620) and surfaces "shot direction unknown — wind applied relative
  to due north" (tools.py:613–615).
- **KEY EXISTING FACT (resolves the bearing question):**
  `HoleIntelligence.approach_bearing_deg` ALREADY EXISTS
  (`backend/app/caddie/types.py:139`) — the tee→green compass bearing, computed
  server-side by `app/caddie/green_geometry.approach_bearing_deg` inside
  `build_hole_intelligence` (`backend/app/caddie/course_intel.py:91, :228`)
  whenever tee+green coords are known, and cached into `session.hole_intel`.
  `get_green_read` already consumes it (tools.py:427–451). The session DOES know
  the hole's bearing — `shot_distance_payload` just never uses it.
- **Convention parity checked:** backend `rel = wind_dir − shot_bearing_deg;
  head = wind·cos(rel)` (physics.py:652–653) and frontend `relativeWind`
  (wind.ts:36–59) agree: wind FROM the direction of play ⇒ positive headwind.
  Frontend `bearingDeg` (great-circle) vs backend `approach_bearing_deg` (local
  east/north projection) differ by <0.1° at hole scale — immaterial, and after
  this change the frontend bearing is only used for the wind tile LABEL, never
  the number.
- **Frontend client already exists:** `getSessionShotDistance` +
  `SessionShotDistance` in `frontend/src/lib/caddie/api.ts:333–364`; the realtime
  voice tool dispatches through it (`frontend/src/lib/voice/realtime.ts:142`).
- **Session lifecycle on the round page:** `startCaddieSession` fires on load
  (RoundPageClient ~704, silent-fail → `caddieSessionActive`), then
  `fetchCourseIntel(..., roundId)` caches intel+weather into the session (~751);
  weather refreshes re-cache via `fetchWeather(lat, lng, roundId)` (~620) on a
  25-min scheduler + on-demand (`lib/map/weather-freshness.ts`). All session
  routes 404 without an owned session (`backend/app/caddie/session.py:402`).
- **Caption:** `playsSubLabel` (`frontend/src/lib/caddie/fcb-labels.ts:61`) already
  names what was adjusted ("wind+elev", "wind from you", "from card", …).

## 2. The bearing-parity decision (chosen design)

**Resolve the bearing SERVER-SIDE from the session's own hole intel.**
`shot_distance_payload` passes `intel.approach_bearing_deg` as `shot_bearing_deg`
when it is not None, falling back to the current unknown-bearing path only when
intel or bearing is genuinely missing.

Why this and not client-supplied bearing (option a's request field):

1. **Both mouths fix at once.** The caddie's number comes from three call paths —
   the backend text tool loop (`resolve_tool`, tools.py:734), the realtime voice
   dispatch (realtime.ts:142), and now the tile. Only a server-side bearing fixes
   all three identically; a request field would require the realtime model and the
   text loop to also learn to pass it, and any path that forgets reintroduces the
   divergence this spec kills.
2. **No trust/validation surface.** A client-supplied bearing is client-trusted
   physics input; the session already has the authoritative geometry (the same
   bearing `get_green_read` uses).
3. **No shared-type churn.** `ShotDistanceRequest` is unchanged, so
   `frontend/src/lib/types.ts` ↔ `backend/app/models.py` need no new request
   fields. (Response additions below are typed in `api.ts`'s
   `SessionShotDistance`, the existing mirror of this payload.)
4. **Coherent degradation.** When intel never landed (unmapped course, fetch
   failed), BOTH the tile and the caddie get the same bearing-less payload — they
   still agree, which is the actual invariant.

Do NOT add a `shot_bearing_deg` request field in this slice. If a future slice
wants mid-hole player-position bearings, it can add one then — additive.

### 2b. Wind honesty when the bearing is unknown (sub-decision)

Today, unknown bearing ⇒ wind resolved against DUE NORTH — a fabricated direction
that materially moves the number (a 15 mph "north headwind" on an eastbound hole
is fiction). That violates [[no-fake-data-fallbacks]] and there is no honest tile
caption for it. **Change:** when wind ≥ 1 mph and no bearing is known, run the
engine in still air and surface the assumption
(`"hole direction unknown — N mph wind NOT applied to the number"`). This changes
the caddie tool's numbers in the no-intel case — deliberately, and for the better:
the caddie stops citing a directionally-invented wind adjustment. Elevation and
air-density terms still apply as before. (This applies to both club mode and
target mode — same `cond` object.)

### 2c. Response additions (for the caption + tests)

Add to `conditions_used` in the payload (tools.py:638):
- `shot_bearing_deg: float | null` — the bearing actually used (null = unknown).
- `wind_applied: bool` — false when still-air fallback ran (no weather, calm, or
  unknown bearing).

Mirror both in `SessionShotDistance.conditions_used` in
`frontend/src/lib/caddie/api.ts` (currently `Record<string, unknown>` — give it a
proper interface: `weather_available`, `wind_speed_mph`, `wind_direction`,
`elevation_change_ft`, `shot_bearing_deg`, `wind_applied`, `firmness`,
`temperature_f`, `air_density_kg_m3`). The payload is a plain dict (no pydantic
response model), so `api.ts` is the shared-type sync point; no `models.py` change.

## 3. Backend changes (step by step)

File: `backend/app/caddie/tools.py`, `shot_distance_payload` only.

1. After `intel = session.hole_intel.get(hn)` (:602), read
   `bearing = intel.approach_bearing_deg if intel is not None else None`.
2. Replace the hardcoded `shot_bearing_deg=0.0` (:620):
   - `bearing is not None` → pass it; drop the "due north" assumption; add
     assumption `"wind resolved along the hole (tee→green line)"` only when wind
     ≥ 1 mph (keep assumptions quiet in calm air).
   - `bearing is None` and wind ≥ 1 mph → pass `shot_bearing_deg=0.0` **with the
     weather's wind zeroed for the conditions build** (simplest: construct the
     cond via `conditions_from_weather` then zero `head/cross` — check
     `ShotConditions` mutability; if frozen, pass a wind-stripped copy of weather)
     + assumption `"hole direction unknown — {N} mph wind not applied"`.
     Keep `conditions_used.wind_speed_mph/wind_direction` reporting the REAL
     weather (honest reporting of what exists vs what was applied — that's what
     `wind_applied:false` is for).
3. Populate `conditions_used.shot_bearing_deg` / `wind_applied` per §2c.
4. Update docstring's honest-degradation list (the "due north" bullet becomes the
   wind-not-applied bullet).

Tests (non-DB — `test_caddie_tools.py` builds in-memory `RoundSession`s, runs
locally without Postgres):
- `backend/tests/test_caddie_tools.py`: extend the `get_shot_distance` block
  (:168–241):
  - intel with `approach_bearing_deg=90`, wind FROM 90 at 10 mph ⇒ plays-like >
    target (headwind on an eastbound hole); wind FROM 270 ⇒ < target. Assert the
    along-hole assumption string and `conditions_used.shot_bearing_deg == 90`.
  - no intel + wind ⇒ `wind_applied is False`, number equals the still-air
    payload for identical weather-minus-wind, assumption names the unapplied wind.
  - regression: calm air + flat + bearing known ⇒ plays-like == target (identity
    already guaranteed by `physics_plays_like`'s neutral-baseline cancellation).
- **Golden parity fixture** (the cross-language pin): a new backend test asserts
  `shot_distance_payload` for one fully-specified fixture (hole 7: bearing 90°,
  elevation −12 ft, wind 12 mph FROM 90, temp 70, target 150, bag
  {"7iron": 165, "driver": 250}) equals a checked-in JSON,
  `backend/tests/fixtures/plays_like_parity.json`. The frontend vitest (below)
  consumes a copy of the same JSON. If the engine changes, the backend test forces
  the golden update, which forces the frontend re-pin — tile and caddie cannot
  drift silently.

## 4. Frontend changes

### 4.1 Fetch: when and how (no endpoint spam)

New hook `usePhysicsPlaysLike` (colocate in
`frontend/src/lib/caddie/use-physics-plays-like.ts`, following the existing
session-client pattern in `lib/caddie/api.ts` — plain `getSessionShotDistance`,
no new transport):

- **Inputs:** `roundId`, `caddieSessionActive && !isLocalRound`, `currentHole`,
  `basisYards` (rounded int — see §4.2), `weatherFetchedAt`.
- **Cache:** per-mount `Map<string, SessionShotDistance>` keyed
  `${hole}:${basis}:${weatherFetchedAt}` — hole revisits and re-renders are free;
  a weather refresh (which re-caches into the session server-side, so the server
  number actually changes) naturally invalidates via the key.
- **Debounce:** 400 ms trailing debounce on key change. Live-rangefinder movement
  is already gated to ≥3 yd steps by the GPS watcher (RoundPageClient ~1121); add
  a 2 s min-interval floor in the hook so a fast walk emits ≤1 request per 2 s.
- **Stale guard:** capture the key per request; discard resolutions whose key no
  longer matches (standard pattern; no spinner, see §4.4).
- **Failure:** any error / 404 (no session yet) → store `null` for the key,
  retry only on next key change (no retry loops on the course).
- Trigger set is exactly: hole change, tee change (changes `holeCoordsForTiles`
  → `fcbFromTee.center` → basis), live-distance change, weather refresh, session
  becoming active. Nothing else refetches.

### 4.2 Basis: selected-tee distance, and the double-count trap

The engine applies elevation itself (`elevation_change_ft` inside `cond`). The
tile must therefore pass the RAW basis — **never `holeIntel.effectiveYards`**
(which already embeds `elevation_only_plays_like`; passing it would double-count
elevation). New basis for the physics call:

- live mode: `Math.round(fcbLive.center)`
- card-only: `cardYards`
- default: `Math.round(fcbFromTee.center)` — the selected-tee anchored distance,
  composing with the multi-tee anchor (#119/#120): tee change → new
  `fcbFromTee.center` → new request. The tile ADJUSTS the selected-tee number; it
  never re-derives yardage.

`playsBase`'s `effectiveYards` branch remains only inside the display FALLBACK
(§5) where the old composed number is still the best honest local approximation.

### 4.3 Display: new pure module, tile consumes the backend number verbatim

New `frontend/src/lib/caddie/plays-tile.ts` (pattern: `fcb-labels.ts` — pure,
no React) exporting `playsTileDisplay(input): { v: string; sub: string }` with
inputs: `physics: SessionShotDistance | null`, `basisYards`, `isLive`,
`fromCard`, `hasLocalIntel`, `hasLocalWind` (for fallback captioning only).

Rules:
- `physics?.available && physics.plays_like_yards != null` →
  `v = "${physics.plays_like_yards}Y"` — **no local math on the number, ever**;
  caption via `playsSubLabel` driven by the RESPONSE:
  `hasWind = conditions_used.wind_applied`,
  `hasElev = conditions_used.elevation_change_ft !== 0`, plus client-known
  `isLive`/`fromCard`.
- otherwise → fallback per §5.
- Delete the `playsLikeYards` import/use from RoundPageClient (:52, :1217). Leave
  the deprecated function in `wind.ts` untouched this slice (it has tests and a
  deprecation pointer; removal is a follow-up once nothing imports it) —
  `relativeWind`/`bearingDeg`/`compassFrom` stay, they drive the WIND tile label.

`playsSubLabel` (fcb-labels.ts) gains one branch for the newly-possible
live+elev state: `isLive && hasWind && hasElev` → `"wind+elev · you"` (and
`isLive && !hasWind && hasElev` → `"elev from you"`). Keep every string ≤ the
current longest ("from where you stand" sets the width envelope); designer
reviews exact copy.

### 4.4 Calm loading/degraded state (NORTHSTAR)

No spinner, no shimmer, no chrome. While the physics response for the current key
is pending or absent, the tile shows the FALLBACK display (§5) — a real, honest
number with an honest caption — and simply re-renders when the physics number
lands. First paint is identical to today's no-wind tile; the number quietly
updates once (same feel as the Elev tile's "—" → value).

## 5. Fallback matrix (the builder must implement exactly this)

Invariant: every cell is NON-CONTRADICTORY with what the caddie would say in the
same state — either the identical physics number, or a plain yardage with a
caption that claims no adjustment the engine didn't make. The deprecated wind
heuristic is used in NO cell.

| State | Tile value | Caption (`playsSubLabel` inputs) | Why coherent |
|---|---|---|---|
| Physics OK, wind applied + elev | `plays_like_yards` | "wind+elev" (or "wind+elev · you" live) | identical number to caddie |
| Physics OK, no weather in session | `plays_like_yards` (≈ elevation-only) | "elev-adj" (`wind_applied:false`) | caddie says the same still-air number + assumption |
| Physics OK, no intel (flat, bearing unknown, wind NOT applied per §2b) | `plays_like_yards` | "from tee" / "from you" (no wind/elev claimed) | caddie cites same number + "wind not applied" assumption |
| `available:false` — no club distances on file | plain basis yards (`Math.round(basis)`) | "from tee"/"from you"/"from card" — never a wind/elev claim | caddie also declines a plays-like here ("needs at least one club") |
| Endpoint error / offline / session never started / `isLocalRound` | `Math.round(playsBase)` where playsBase keeps today's `effectiveYards` branch | "elev-adj" when effectiveYards was used, else "from tee"/"from you"/"from card" — **never "wind…"** | offline caddie is also unavailable; elevation term is the backend's own cached number, not invented |
| Card-only (no usable tee geometry) | physics number if the call succeeds (basis = cardYards), else cardYards | "wind on card" only when `wind_applied`; else "from card" | matches existing card-only honesty rule (no elev claim from unusable geometry — engine's elev comes from intel, which card-only rounds lack anyway) |
| Live rangefinder | physics number with basis = live center; hole-level elevation/bearing applied by the engine (same approximation the caddie itself makes mid-hole — surfaced in `assumptions`) | "wind+elev · you" | tile == what the caddie answers for that target right now |

Note the one deliberate asymmetry: the offline/error fallback may still show the
elevation-composed number (today's behavior minus wind). That number came from
the backend (`elevation_only_plays_like`) — cached truth, not fabrication — and
its caption says "elev-adj", claiming nothing more.

## 6. Files to touch

Backend
- `backend/app/caddie/tools.py` — `shot_distance_payload`: bearing from intel,
  wind-honesty fallback, `conditions_used` additions (§2b/2c/3).
- `backend/tests/test_caddie_tools.py` — bearing/wind-honesty/identity tests.
- `backend/tests/fixtures/plays_like_parity.json` — NEW golden parity fixture.

Frontend
- `frontend/src/app/round/[id]/RoundPageClient.tsx` — wire hook, replace
  `playsTile` derivation, drop `playsLikeYards` import.
- `frontend/src/lib/caddie/use-physics-plays-like.ts` — NEW fetch hook (§4.1).
- `frontend/src/lib/caddie/plays-tile.ts` + `plays-tile.test.ts` — NEW pure
  display module + vitest (consumes the parity golden + fallback matrix cases).
- `frontend/src/lib/caddie/fcb-labels.ts` + `fcb-labels.test.ts` — new
  `playsSubLabel` branches.
- `frontend/src/lib/caddie/api.ts` — type `conditions_used` (§2c).

Shared-type sync: no `ShotDistanceRequest`/`models.py` change; the payload mirror
lives in `api.ts` (`SessionShotDistance`) per existing convention.

## 7. Gates (this machine has NO local Postgres)

Deterministic tests
1. **Parity (the heart):** backend pytest pins `shot_distance_payload(fixture) ==
   plays_like_parity.json`; frontend vitest pins `playsTileDisplay(golden).v ==
   "${golden.plays_like_yards}Y"` and asserts the module performs no arithmetic on
   it (e.g. golden number is a prime-ish value like 163 that no local formula
   reproduces from the 150 basis).
2. **Fallback matrix:** vitest cases for every §5 row (non-contradictory value +
   caption); backend tests for `available:false` and wind-not-applied rows.

Commands
- Frontend: `cd frontend && npm run lint && npx tsc --noEmit && npm run test &&
  npx tsx voice-tests/runner.ts --smoke && npm run build`
- Backend (local, non-DB): `cd backend && ruff check . && python -m pytest
  tests/test_caddie_tools.py tests/test_physics.py tests/test_club_selection.py -q`
  (all in-memory; no Postgres needed)
- DB-backed integration (`backend/tests/integration/`) runs in CI only.
- Existing realtime-dispatch tests (`frontend/src/lib/voice/realtime-dispatch.test.ts`)
  must still pass unchanged — the request shape is untouched.

## 8. Sequencing

1. Backend payload change + tests + golden fixture (independently shippable; also
   fixes the caddie's own north-wind honesty bug).
2. Frontend `api.ts` typing + `plays-tile.ts` + `playsSubLabel` branches + vitest
   against the golden.
3. Hook + RoundPageClient wiring; delete the heuristic call.
4. Run gates; `/security-review` not required (no new endpoint/auth/data surface —
   existing owned-session route, read-only), `/code-review` per workflow.

## 9. Risks / edge cases

- **Session weather vs tile weather skew:** the tile's local `weather` state and
  the session's cached weather are written by the same fetches (`fetchWeather(...,
  roundId)` and course-intel), but the FIRST weather fetch (~:594) omits
  `roundId`. The physics number always reflects the SESSION's weather — which is
  what the caddie cites, so coherence holds by construction; at worst the wind
  TILE label leads the plays number by one refresh cycle. Optional tightening
  (recommended, one-line): pass `roundId` at :594 so both fetches re-cache.
- **`physics_plays_like` needs ≥1 club distance** — golfers with an empty bag get
  the `available:false` row permanently; the fallback caption keeps that honest.
- **Mid-hole elevation/bearing approximation (live mode):** the engine applies
  tee→green values to a mid-hole target; identical to what the caddie answers, so
  coherent — refinement (player-position bearing via a request field +
  `shot_line_profile_ft`) is explicitly out of scope, noted for a future slice.
- **Request volume:** worst case ≈ 1/hole + 1/weather-refresh (25 min) + walking
  bursts capped at 1 per 2 s only while the live distance actually changes ≥3 yd.
