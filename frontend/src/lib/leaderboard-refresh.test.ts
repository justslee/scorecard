// leaderboard-refresh (specs/tournament-live-leaderboard-plan.md) — pure
// throttle + plausibility predicates for the silent foreground refresh.
// Mirrors weather-freshness.test.ts: deterministic table tests, no fake
// timers needed (no scheduler here — trigger is `visibilitychange`, not an
// interval).

import { describe, it, expect } from "vitest";
import {
  shouldRefreshLeaderboard,
  isPlausibleRefresh,
  LEADERBOARD_REFRESH_MIN_INTERVAL_MS,
} from "./leaderboard-refresh";

describe("shouldRefreshLeaderboard", () => {
  it("null lastLoadedAt is always due (no fetch has completed yet)", () => {
    expect(shouldRefreshLeaderboard(null, Date.now())).toBe(true);
  });

  it("just-fetched (0ms old) is not due", () => {
    const now = 1_000_000;
    expect(shouldRefreshLeaderboard(now, now)).toBe(false);
  });

  it("just under the threshold is not due", () => {
    const now = 1_000_000;
    expect(
      shouldRefreshLeaderboard(now - (LEADERBOARD_REFRESH_MIN_INTERVAL_MS - 1), now)
    ).toBe(false);
  });

  it("at/over the threshold is due", () => {
    const now = 1_000_000;
    expect(shouldRefreshLeaderboard(now - LEADERBOARD_REFRESH_MIN_INTERVAL_MS, now)).toBe(
      true
    );
    expect(
      shouldRefreshLeaderboard(now - LEADERBOARD_REFRESH_MIN_INTERVAL_MS - 1, now)
    ).toBe(true);
  });

  it("respects a custom minIntervalMs", () => {
    const now = 1_000_000;
    expect(shouldRefreshLeaderboard(now - 5_000, now, 10_000)).toBe(false);
    expect(shouldRefreshLeaderboard(now - 10_000, now, 10_000)).toBe(true);
  });
});

describe("isPlausibleRefresh", () => {
  it("expected rounds, fetched none, previously had members → implausible (likely local-cache fallback)", () => {
    expect(isPlausibleRefresh(3, 0, 2)).toBe(false);
  });

  it("expected rounds, fetched none, previously had NO members → plausible (nothing to lose)", () => {
    expect(isPlausibleRefresh(3, 0, 0)).toBe(true);
  });

  it("expected rounds, fetched some, previously had members → plausible (real data)", () => {
    expect(isPlausibleRefresh(3, 2, 2)).toBe(true);
  });

  it("no rounds expected at all → plausible regardless of member counts", () => {
    expect(isPlausibleRefresh(0, 0, 0)).toBe(true);
    expect(isPlausibleRefresh(0, 0, 5)).toBe(true);
  });
});
