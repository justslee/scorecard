# Implementation Plan — `wind-periodic-refresh`

**Backlog item:** Wind refreshes during the round (stale after ~20 min). Type: minor, risk: low, priority 2.
**Owner direction (2026-07-07):** One wind reading currently persists for a 4+ hour round. Quietly re-fetch weather every ~20-30 min, OR on hole change when the current reading is >~20 min old, and update the wind/weather tiles in place. Silent change — no new UI.

**Non-negotiables:**
- HONESTY: source granularity is one Open-Meteo grid cell for the whole course. Per-hole SPEED differences exist in no data source and must NEVER be faked. Only STALENESS is fixed — same reading source, refreshed over time. Direction-per-hole-bearing already works and must be preserved.
- Keep the existing honest `—` fallback and the existing retry ladder. A failed refresh must NOT clobber a good prior reading with `—`.
- Silent / calm per NORTHSTAR.md. No new chrome.

---

## 1. Exploration findings (the real code)

**Weather is fetched and held entirely on the client, inline in `RoundPageClient.tsx`.** There is no `useWeather` hook and no separate staleness helper today — the eng-lead's "weather effect + staleness helper" framing is directionally right but the helper does not yet exist and the fetch is an inline effect, not a hook.

`frontend/src/app/round/[id]/RoundPageClient.tsx`:
- **State:** line 517 `const [weather, setWeather] = useState<WeatherConditions | null>(null);` — `null` is the honest "no data" sentinel. There is currently **no `fetchedAt` timestamp anywhere on the client.**
- **Weather anchor:** lines 526-528 derive `weatherLat` / `weatherLng` from `roundAnchor ?? fallbackTee`.
- **Retry ladder (existing, must be preserved):** lines 529-549. A `useEffect` keyed on `[weatherLat, weatherLng]` with `const DELAYS = [0, 3_000, 10_000, 30_000];` and a self-arming `attempt(i)` recursion. On success `setWeather(w)`; on failure it climbs the ladder and, when exhausted, **leaves tiles at honest `—` (never calls `setWeather(null)`)**. Cleanup sets `cancelled = true` and `clearTimeout(timer)`.
- **Second weather write path:** the course-intel effect (lines 593-678) also sets weather: line 634 `if (intel.weather) setWeather(intel.weather);` and line 672 `setWeather(w)`. Any timestamp work must cover **all three** `setWeather` sites, not just the ladder.
- **Per-hole derivation (must stay intact):** lines 986-1016. `holeWind = relativeWind(weather.wind_direction, holeBearing, weather.wind_speed_mph)` (lines 990-991); `windTile` (lines 993-999); `playsTile` (lines 1013-1016). The direction-per-hole logic reads `holeBearing` (derived from `currentHole`), NOT from any per-hole speed — so replacing the single `weather` object refreshes every tile in place with zero change to bearing logic.
- **Tile render sites:** `<MapStat k="Wind" .../>` at ~line 1712; the sheet at ~lines 1795-1796 consumes `windMph={weather ? Math.round(weather.wind_speed_mph) : 0}` and `windDir={holeWind ? holeWind.label : weather ? ... : "—"}`. Both are pure functions of `weather` + `holeBearing`, so they re-render automatically on `setWeather`.
- **Hole state:** line 272 `const [currentHole, setCurrentHole] = useState(1);`. Navigation goes through `goHole(n)` (~lines 750-762) and swipe handlers (~1783-1784).

`frontend/src/lib/caddie/api.ts`:
- **`fetchWeather(lat, lng, roundId?)`** lines 55-64 → `POST /api/caddie/weather`. Returns `WeatherConditions`.
- Precedent for controlled timeouts/retries lives here (`api.timeout.test.ts`, `api.stream.test.ts`).

`frontend/src/lib/caddie/types.ts`:
- **`WeatherConditions`** interface lines 39-49: `temperature_f, humidity, wind_speed_mph, wind_direction, wind_gusts_mph, pressure_hpa, altitude_ft, air_density_factor, conditions`. **No `fetchedAt`.**

`frontend/src/lib/map/wind.ts` + `wind.test.ts`: pure bearing/relative-wind helpers with existing vitest coverage. This is the correct home for a co-located, pure staleness helper.

**Backend (provider + endpoint):**
- `backend/app/services/weather.py`: provider is **Open-Meteo** (`OPEN_METEO_URL`, free, **no API key**). GolfAPI is NOT the weather provider — the GolfAPI call-budget concern does not apply here.
- `backend/app/routes/caddie.py` lines 928-947 (`POST /weather`): **always calls `build_weather_conditions(lat, lng)` fresh** (no cached short-circuit), then optionally caches into the session. So every client refresh yields a genuinely fresh reading — a client-captured receipt timestamp is honest.
- `backend/app/db/models.py` line 33: the session table already has `weather_fetched_at`. This is **server-side cache bookkeeping, orthogonal** to this task; we deliberately do NOT surface it to the client (see §4).

**Test/scheduler precedent:** `frontend/src/lib/voice/idle-timer.ts` (a `window.*`-scoped `IdleTimer` class) + `idle-timer.test.ts` (`vi.useFakeTimers()` / `vi.advanceTimersByTime`) is the canonical deterministic-timer pattern to mirror. Test runner is `vitest` (`npm run test` → `vitest run`).

---

## 2. Approach

Two small, pure, independently testable units plus wiring in `RoundPageClient.tsx`. No backend changes, no type changes.

### 2a. New module — `frontend/src/lib/map/weather-freshness.ts`
Co-located with `wind.ts` (the weather/tile helper home).

- Constants:
  - `export const WEATHER_STALE_MS = 20 * 60_000;` — hole-change staleness threshold (~20 min).
  - `export const WEATHER_REFRESH_INTERVAL_MS = 25 * 60_000;` — periodic cadence (inside the 20-30 min window).
- Pure predicate:
  - `export function isWeatherStale(fetchedAt: number | null, now: number, thresholdMs: number = WEATHER_STALE_MS): boolean` — returns `fetchedAt == null ? true : now - fetchedAt >= thresholdMs`. (Callers that only want to refresh an existing reading gate on `weather != null` separately; documented in the JSDoc.)
- Deterministic scheduler class (mirrors `IdleTimer`, `window.*`-scoped per lessons.md):
  - `export class WeatherRefreshScheduler { constructor(onTick: () => void, intervalMs = WEATHER_REFRESH_INTERVAL_MS); start(); stop(); isArmed(): boolean }` using `window.setInterval` / `window.clearInterval`. Keeping the loop in a class (rather than inline `setInterval`) is what makes the cadence hand-controllable in tests without real timers.

### 2b. Timestamp source — client receipt time, single writer
- Add `const [weatherFetchedAt, setWeatherFetchedAt] = useState<number | null>(null);` in `RoundPageClient.tsx`.
- Introduce one `applyWeather` callback (`useCallback`) that is the ONLY place weather is set:
  `const applyWeather = useCallback((w: WeatherConditions) => { setWeather(w); setWeatherFetchedAt(Date.now()); }, []);`
- Route all three existing `setWeather` sites (lines 538, 634, 672) through `applyWeather`. This guarantees `weatherFetchedAt` always reflects the actual reading time and can never drift out of sync with `weather`. `fetchedAt` is the client's honest "when I received this reading" — appropriate because the `/weather` POST always fetches fresh (§1).

### 2c. Single refresh function (idempotent, no-clobber)
- `const refreshWeather = useCallback(async () => { if (weatherLat == null || weatherLng == null) return; if (refreshInFlightRef.current) return; refreshInFlightRef.current = true; try { const w = await fetchWeather(weatherLat, weatherLng, roundId); applyWeather(w); } catch { /* keep prior good reading + '—' honesty */ } finally { refreshInFlightRef.current = false; } }, [weatherLat, weatherLng, roundId, applyWeather]);`
- `refreshInFlightRef` (a `useRef(false)`) coalesces overlapping periodic + hole-change triggers into one network call — protects the (free, keyless) Open-Meteo endpoint from being hammered.
- On failure it does nothing: the prior good `weather` and its timestamp survive; if there is genuinely no reading yet, tiles remain honest `—`.

### 2d. Periodic refresh effect (only while round active)
- New `useEffect` keyed on `[weatherLat, weatherLng, roundId, round?.status]`:
  - Bail unless `weatherLat != null && round && round.status !== 'completed'`.
  - `const sched = new WeatherRefreshScheduler(() => { void refreshWeather(); }); sched.start(); return () => sched.stop();`
  - The class holds exactly one interval; cleanup on unmount / dep-change guarantees no duplicate or leaked timers.

### 2e. Hole-change refresh (stale-gated)
- New `useEffect` keyed on `[currentHole]` using a `prevHoleRef` to fire only on an actual hole change (skip the mount run):
  - `if (prevHoleRef.current !== currentHole) { prevHoleRef.current = currentHole; if (weather != null && isWeatherStale(weatherFetchedAt, Date.now())) void refreshWeather(); }`
  - Read `weather` / `weatherFetchedAt` via refs (or include in deps and guard) to avoid stale-closure reads; simplest is a tiny `latestRef` that mirrors `{ weather, weatherFetchedAt }`. Builder picks whichever is cleaner and lint-clean.

### 2f. Background/foreground catch-up
- New `useEffect` (deps `[refreshWeather]`) adds a `visibilitychange` listener: when `document.visibilityState === 'visible'` and `weather != null && isWeatherStale(weatherFetchedAt, Date.now())`, call `refreshWeather()`. Remove the listener in cleanup. Rationale to document inline: on native (Capacitor/iOS) JS interval timers are suspended while backgrounded, so an app resumed mid-round after an hour would otherwise show a stale reading until the next interval; the resume-refresh is the reliable catch-up.

**Honesty guardrail (call out in code comments):** every path replaces the single grid-cell reading only — no per-hole speed synthesis is ever introduced. Direction remains `relativeWind(weather.wind_direction, holeBearing, …)`, unchanged.

---

## 3. Edge cases & risks

- **Failed refresh must not clobber good data:** `refreshWeather` never calls `setWeather(null)`; its `catch` is a no-op. Prior reading + timestamp preserved; honesty `—` only ever appears when weather was genuinely never acquired.
- **Cold start / first acquisition:** the existing retry ladder (lines 529-549) still owns first acquisition and is left intact — only its success `setWeather(w)` is rerouted through `applyWeather`. If the ladder exhausts but a later periodic/foreground refresh succeeds, tiles recover (also routed through `applyWeather`).
- **Round not active:** periodic effect bails when `round` is missing or `round.status === 'completed'` — no polling for finished/absent rounds.
- **Timer cleanup / duplicate timers:** the scheduler is a single-interval class stopped in effect cleanup; the visibility listener is removed in cleanup; `prevHoleRef` prevents redundant hole-change fires. Effects are keyed so a lat/lng/round change tears down and rebuilds exactly one timer.
- **API hammering / budget:** provider is Open-Meteo (free, keyless) — no hard budget, but we stay polite: 25-min cadence, `refreshInFlightRef` coalescing, only-when-active, and hole-change only when actually stale (>20 min). ~1 extra provider call per active round per 25 min. GolfAPI budget does not apply to weather.
- **Stale closures in effects:** guard via refs (`latestRef` / `prevHoleRef`) so `currentHole` change reads current `weather`/`weatherFetchedAt`, not mount-time values.
- **Deterministic tests (lessons.md, non-negotiable):** any timer/async path gets tests that CONTROL the scheduler — `vi.useFakeTimers()` + `vi.advanceTimersByTime`, `window.*`-scoped so a fake-timer polyfill can't leak across jsdom files; never real `setTimeout`. `isWeatherStale` gets pure unit tests (hand-fed `now`/`fetchedAt`, no timers). A flaky timer test is treated as a real race, bisected — not retried-until-green.

---

## 4. Shared types

- **No change to `frontend/src/lib/caddie/types.ts` (`WeatherConditions`) and no change to `backend/app/models.py` / `backend/app/db/models.py`.** The `fetchedAt` receipt is tracked purely client-side (`Date.now()` at the moment `applyWeather` runs). Adding a timestamp to the payload would (a) require backend + Pydantic + type changes, and (b) risk surfacing the server session's cache time (`db/models.py:weather_fetched_at`, line 33) as if it were fresh — an honesty hazard. Because `POST /weather` always fetches fresh (`caddie.py:928-947`), the client receipt time is the honest reading time.
- Keep-in-sync obligation = a documented no-op. If the builder later decides a server-provided timestamp is preferable, that becomes a separate change touching `WeatherConditions` (types.ts) ↔ the `/weather` response (caddie.py) ↔ Pydantic model, and would require the backend `ruff` gate — out of scope here.

---

## 5. Files touched

- **New:** `frontend/src/lib/map/weather-freshness.ts` (pure `isWeatherStale` + constants + `WeatherRefreshScheduler` class).
- **New:** `frontend/src/lib/map/weather-freshness.test.ts` (pure predicate tests + deterministic fake-timer scheduler tests).
- **Edit:** `frontend/src/app/round/[id]/RoundPageClient.tsx` (add `weatherFetchedAt` state + refs; `applyWeather`; reroute the 3 `setWeather` sites; `refreshWeather`; periodic effect; hole-change effect; visibility effect). No backend files, no shared-type files.

---

## 6. Exact gates the builder must run

Run from repo root unless noted. No local Postgres — DB-backed backend tests are CI-only.

```
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke
cd frontend && npx vitest run src/lib/map/weather-freshness.test.ts src/lib/map/wind.test.ts
```

- The new `weather-freshness.test.ts` (pure staleness + deterministic scheduler) is required; `wind.test.ts` is the direction/bearing regression guard (proves per-hole logic untouched).
- Run any RoundPageClient-adjacent vitest that exists if the builder adds one; keep timer tests `window.*`-scoped.
- **`cd backend && ruff check .` is NOT required** for this plan because no backend file is touched. Only run it if the builder deviates and edits a backend file (e.g. surfacing a server timestamp).

Ship remains gated on `NORTHSTAR.md`: this is a silent freshness fix — verify no new UI/chrome appeared and the yardage-book calm is preserved.
