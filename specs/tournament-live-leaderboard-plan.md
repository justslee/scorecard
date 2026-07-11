# Implementation Plan — Tournament Live Leaderboard (foreground/visibility refresh)

_Plan agent (fable), cycle 99. Contract for the builder — implement without re-planning._

**Slice:** When the tournament page regains foreground/visibility, silently refetch member rounds, recompute standings, and let the existing FLIP motion + haptics express any real change. No polling, no new UI chrome, no backend change.

## 1. Current state (verified in code)

- `frontend/src/app/tournament/[id]/TournamentPageClient.tsx` lines 97–181: a single `useEffect([id])` runs `load()`, which does `setLoading(true)` → `getTournamentAsync(id)` → `getRoundsAsync()` filtered by `roundIds`/`tournamentId` → name/handicap resolution → `setStandings(computeStandings(...))` → `setLoading(false)`. Runs exactly once per `id`; no cleanup, no race guard, no unmount protection.
- Line 186–193: `sortedStandings`, `orderSignature`, `leaderId` are derived per render; `tournamentSettlement = computeTournamentSettlement(memberRounds)` is also derived per render — so fresh `memberRounds`/`standings` state automatically re-derives everything downstream.
- Lines 203–253: the re-sort haptics effect is keyed on `[orderSignature, leaderId, lbMode]` and early-returns when `prev.signature === orderSignature`. It is already gated on *actual* order change and rebases silently on mode toggle — a no-change refresh will NOT buzz. Verified.
- Line 894–896: rows are `motion.div key={s.playerId} layout={reduce ? false : "position"}` — FLIP re-sort animates automatically when `sortedStandings` order changes, and is already disabled under `prefers-reduced-motion`. A silent state commit flows through this for free.
- Reference pattern: `frontend/src/app/round/[id]/RoundPageClient.tsx` lines 643–710 — `refreshInFlightRef` (single-flight), a `latestRef` mirror so the DOM listener reads current values not a stale closure, `visibilitychange` → visible → `shouldRefreshOnDemand(...)` throttle → silent refresh where a failure "keeps the prior good reading — never clobber."
- `frontend/src/lib/storage-api.ts`: `getTournamentAsync`/`getRoundsAsync` **never throw on API failure** — they log and fall back to `localCache`. Two consequences: (a) the `catch` in `load()` is rarely the failure path; (b) a degraded refresh can return `null` tournament or `[]` rounds from an empty local cache. This is the main correctness hazard (see §5).

## 2. Trigger decision

Use **`document.visibilitychange` → visible, only** — exactly matching RoundPageClient's weather foreground catch-up (lines 700–710), which is the established pattern for *data* refresh on both web and native. In Capacitor's WKWebView, backgrounding/foregrounding the app fires `visibilitychange`; RoundPageClient already relies on this alone for the same "iOS suspends timers" problem. `@capacitor/app` `appStateChange` is used only in `GoogleSatelliteMap.tsx:790` because the *native map view* needs re-framing independent of webview visibility — that concern doesn't exist here. **Do not add `@capacitor/app` to this page** (avoids a plugin import in a pure-web page and an async `addListener` handle lifecycle for no benefit). If QA on device ever shows a missed foreground event, adding `appStateChange` is a follow-up, not this slice.

Throttle: min interval between foreground refreshes, `LEADERBOARD_REFRESH_MIN_INTERVAL_MS = 15_000` (scores change fast, unlike the 20-min weather threshold; 15 s only exists to stop rapid app-switch toggling from hammering `GET /api/rounds`). No interval/polling of any kind.

## 3. Refactor of `load()` — `loadInitial` vs silent `refresh`

Restructure inside `TournamentPageClient` (all in the one file):

1. **Extract the fetch+compute body** into a single async function `fetchAndApply(opts: { initial: boolean })` (hoisted via `useCallback` keyed on `[id]`, or defined inside the effect + a stable callback — builder's choice, but name/handicap resolution logic must be moved *verbatim*: the `namesFromRounds` → `playerNamesById` precedence, the `p.handicap != null` filter with its null-vs-0 comment, and the `effectivePlayerIds` union fallback. Zero math changes.)
2. **`initial: true` path** (current behavior, unchanged): `setLoading(true)` before, `setLoading(false)` after, `t == null` or thrown error → `setNotFound(true)`.
3. **`initial: false` (silent) path**:
   - Never touches `loading` or `notFound`. The skeleton (line 323) can therefore never reappear; the list never blanks; scroll is untouched (state commit only re-renders rows in place).
   - Single-flight: `refreshInFlightRef` boolean ref, same as RoundPageClient line 643–647 — skip if a refresh is already in flight.
   - Staleness/race guard: a `reqIdRef` counter (increment per invocation, capture locally, compare before every `set*` call) **plus** capture `id` at call time and bail if it no longer matches — `storage-api` functions take no `AbortSignal` and changing their signatures is out of scope, so latest-request-wins is the mechanism. Bump `reqIdRef` in the `[id]` effect's cleanup so setState-after-unmount (and after id change) is inert.
   - Failure/degraded result → **keep last good state** (see §5), `console.warn` only.
4. **Commit order** on a successful silent refresh: `setTournament(t)`, `setMemberRounds(members)`, `setStandings(computeStandings(...))`. Also handle `t.roundIds.length === 0`: the current code skips the whole rounds block, which on *refresh* would leave stale standings if all rounds were removed from the tournament — on the silent path, explicitly `setMemberRounds([])` / `setStandings([])` in that branch (initial path already lands on the `[]` defaults).
5. **The listener effect** (new, modeled on RoundPageClient 700–710):
   - `document.addEventListener("visibilitychange", onVisible)`; cleanup removes it.
   - `onVisible`: bail unless `document.visibilityState === "visible"`; bail if initial load hasn't completed (`loading` true or `tournament == null` — read via a latest-values ref, mirroring `weatherLatestRef`, so the listener never closes over stale state); bail unless `shouldRefreshLeaderboard(lastRefreshAtRef.current, Date.now())`; then `void refresh()`.
   - `lastRefreshAtRef` is set on every *successful* fetch completion (initial and silent) so a fresh page load isn't immediately re-fetched by an incidental visibility flap.

## 4. New pure helper (the only new file pair)

`frontend/src/lib/leaderboard-refresh.ts` — two tiny exported pure functions, no React imports:

- `shouldRefreshLeaderboard(lastLoadedAt: number | null, now: number, minIntervalMs = LEADERBOARD_REFRESH_MIN_INTERVAL_MS): boolean` — `null` → true; else `now - lastLoadedAt >= minIntervalMs`. (Mirrors `isWeatherStale` in `frontend/src/lib/map/weather-freshness.ts` but must NOT be imported from there — that module is documented as weather-semantics; a 6-line local twin keeps coupling honest.)
- `isPlausibleRefresh(expectedRoundCount: number, fetchedMemberCount: number, previousMemberCount: number): boolean` — the degraded-fallback guard from §5: returns `false` only when `expectedRoundCount > 0 && fetchedMemberCount === 0 && previousMemberCount > 0` (i.e., the tournament claims rounds exist, we previously had them, and the refetch found none — almost certainly `storage-api`'s local-cache fallback after an API failure, not a real mass deletion). Otherwise `true`.

Plus `frontend/src/lib/leaderboard-refresh.test.ts` — deterministic table tests (null timestamp, just-under/at threshold, and the four plausibility quadrants). Follow the style of `frontend/src/lib/map/weather-freshness.test.ts`.

## 5. Edge cases / correctness rules (the reviewer's checklist)

| Case | Required behavior |
|---|---|
| Silent refresh: `getTournamentAsync` returns `null` (API down + not in local cache) | Keep last good tournament/standings. **Never** `setNotFound(true)` from the silent path — `notFound` is initial-load-only. |
| Silent refresh throws | `console.warn`, keep last good state, reset `refreshInFlightRef` in `finally`. |
| Degraded rounds fetch (`roundIds` nonempty, fetched members `[]`, previously had members) | `isPlausibleRefresh` → false → skip commit, keep last good standings. |
| Tournament genuinely emptied (`roundIds` now `[]`) | Clear `memberRounds`/`standings` to `[]` (silent path must handle this branch explicitly — current code doesn't). |
| Member round deleted / player added between loads | Fresh filter + `computeStandings` handles both; fewer/more rows flow through FLIP (`AnimatePresence` isn't wrapping rows — rows appear/disappear without exit animation; acceptable, matches current tab behavior). |
| Foreground with no data change | `orderSignature` unchanged → haptics effect early-returns (line 220), `layout` animation has nothing to move → visually a perfect no-op. Verify by eye during `/verify`. |
| Rapid focus toggling | 15 s throttle + `refreshInFlightRef` single-flight. |
| `id` changes / unmount mid-fetch | `reqIdRef` bump in effect cleanup makes stale commits no-ops; no setState after unmount. |
| Reduced motion | Already handled: `layout={reduce ? false : "position"}` — rows snap, no new work. |
| Loading skeleton | Only reachable when `loading === true`, which the silent path never sets — assert in review that the silent path contains no `setLoading` call at all. |
| Haptics on refresh | Order-change haptic firing when a scorer's entry genuinely reorders standings is the *feature*. Settle-up haptic (line 259) fires once if settlement newly becomes visible — intended existing behavior, leave as is. |

## 6. Explicitly OUT of this slice

- Polling/intervals, websockets/SSE, any push channel.
- Any "live" indicator, refresh button, pull-to-refresh, toast, or timestamp UI.
- `@capacitor/app` `appStateChange` listener on this page (rationale in §2).
- `AbortSignal` plumbing through `storage-api.ts` / `api` layer.
- Any change to `tournament-standings.ts`, `settlement.ts`, `types.ts`, `models.py`, or the backend. **Confirmed:** this is pure client wiring over existing `Tournament`/`Round` shapes — no shared-type or backend change needed.
- Refresh-on-tab-focus within the page (leaderboard/rounds/games tabs) — visibility only.

## 7. Test surface & gates

- Standings/money math: untouched, already locked by `frontend/src/lib/tournament-standings.test.ts` — no new money tests.
- New: `frontend/src/lib/leaderboard-refresh.test.ts` (pure, deterministic, no fake timers needed).
- No component test for the listener wiring (would need jsdom visibility mocking for low value); the `/verify` pass instead: open tournament page, background/foreground, watch network tab for one throttled refetch, confirm silent no-op with unchanged data and FLIP re-sort after editing a member round's score in another tab.
- Gates, in order: `npm run lint` · `npx tsc --noEmit` · `npx tsx voice-tests/runner.ts --smoke` · `npx vitest run` · `npm run build` · backend `ruff check .` (should be a no-op diff on backend). Playwright E2E deferred to CI (no local live backend).

## 8. Build sequence

1. Add `frontend/src/lib/leaderboard-refresh.ts` + test; run vitest.
2. Refactor `load()` → `fetchAndApply({initial})` in `TournamentPageClient.tsx`, preserving initial-path behavior byte-for-byte in outcome; add `reqIdRef`/cleanup.
3. Add `refreshInFlightRef`, `lastRefreshAtRef`, latest-values ref, and the `visibilitychange` effect.
4. Handle the empty-`roundIds` and implausible-refresh branches on the silent path.
5. Run all gates; manual `/verify` of the no-op and the reorder cases.
