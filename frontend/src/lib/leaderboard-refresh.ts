// Tournament live leaderboard (specs/tournament-live-leaderboard-plan.md) —
// pure helpers for the silent foreground/visibility refresh. No React
// imports; keep this a tiny, independently-testable twin of
// `lib/map/weather-freshness.ts`'s staleness predicate — NOT a re-export of
// it, since that module is documented as weather-semantics and scores change
// on a much faster cadence than a 20-min wind reading.

/**
 * Minimum interval between foreground-triggered leaderboard refreshes. Scores
 * change fast (unlike weather), so this exists only to stop rapid app-switch
 * toggling from hammering `GET /api/rounds` — not a "freshness" window.
 */
export const LEADERBOARD_REFRESH_MIN_INTERVAL_MS = 15_000; // 15s

/**
 * Should a silent foreground refresh fire? `lastLoadedAt` is the client
 * receipt time of the last successful fetch (initial or silent), `null` if
 * none has completed yet — treated as due so the first foreground catch-up
 * is never blocked.
 */
export function shouldRefreshLeaderboard(
  lastLoadedAt: number | null,
  now: number,
  minIntervalMs: number = LEADERBOARD_REFRESH_MIN_INTERVAL_MS
): boolean {
  if (lastLoadedAt == null) return true;
  return now - lastLoadedAt >= minIntervalMs;
}

/**
 * Guards against committing a degraded refetch. `storage-api`'s
 * `getRoundsAsync` never throws on API failure — it logs and falls back to
 * `localCache`, which can quietly return `[]` when the API is down and the
 * cache is empty/stale. Returns `false` (implausible — skip the commit) only
 * when the tournament claims rounds exist, we previously had members, and the
 * refetch found none: almost certainly that fallback, not a real mass
 * deletion. Any other shape (including a genuine empty tournament, or a
 * tournament that never had members) is plausible.
 */
export function isPlausibleRefresh(
  expectedRoundCount: number,
  fetchedMemberCount: number,
  previousMemberCount: number
): boolean {
  if (expectedRoundCount > 0 && fetchedMemberCount === 0 && previousMemberCount > 0) {
    return false;
  }
  return true;
}
