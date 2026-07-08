// Wind/weather freshness (owner 2026-07-07: one Open-Meteo reading was
// persisting for a whole 4+ hour round, going stale). This module only fixes
// STALENESS — quietly re-fetch the same single grid-cell reading over time —
// it never synthesizes per-hole wind speed differences that don't exist in
// any data source. Per-hole DIRECTION (relative bearing, `lib/map/wind.ts`)
// is untouched: refreshing the reading just updates the one shared object
// that bearing math already reads from.
//
// Pure predicate + a tiny deterministic scheduler class (mirrors
// `lib/voice/idle-timer.ts`'s `IdleTimer` pattern) so the periodic cadence is
// unit-testable with fake timers rather than a real setInterval.

/** Hole-change staleness threshold — refresh if the reading is older than this. */
export const WEATHER_STALE_MS = 20 * 60_000; // 20 min

/** Periodic refresh cadence while a round is active (inside the 20-30 min window). */
export const WEATHER_REFRESH_INTERVAL_MS = 25 * 60_000; // 25 min

/**
 * Is the current weather reading stale? `fetchedAt` is the client receipt
 * time (`Date.now()` when the reading was applied), `null` if no reading has
 * ever been acquired — treated as stale so a first refresh is always allowed.
 * Callers that only want to refresh an EXISTING reading (never conjure one
 * out of turn) should additionally gate on `weather != null` themselves.
 */
export function isWeatherStale(
  fetchedAt: number | null,
  now: number,
  thresholdMs: number = WEATHER_STALE_MS
): boolean {
  if (fetchedAt == null) return true;
  return now - fetchedAt >= thresholdMs;
}

// Mirrors `lib/voice/idle-timer.ts`'s `IdleTimer` class: bare `setInterval`/
// `clearInterval` (not `window.setInterval`, which this repo's tsconfig
// types as `NodeJS.Timeout` via @types/node's ambient `Window` overload,
// not the DOM `number` — a real TS build error, not just style). Unlike
// `requestAnimationFrame` (patched ad hoc in jsdom, hence explicitly scoped
// to `window.*` in `lib/caddie/stream-buffer.ts` to dodge a cross-file
// polyfill leak), `setInterval`/`clearInterval` are real Node/jsdom globals
// that `vi.useFakeTimers()` swaps consistently — no equivalent leak risk.
export class WeatherRefreshScheduler {
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private onTick: () => void,
    private intervalMs: number = WEATHER_REFRESH_INTERVAL_MS
  ) {}

  /** Arm the periodic tick. No-op if already armed (never stacks intervals). */
  start(): void {
    if (this.handle !== null) return;
    this.handle = setInterval(() => {
      this.onTick();
    }, this.intervalMs);
  }

  /** Disarm the periodic tick. Safe to call repeatedly / when not armed. */
  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  isArmed(): boolean {
    return this.handle !== null;
  }
}
