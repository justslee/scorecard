// weather-freshness (specs/wind-periodic-refresh-plan.md) — pure staleness
// predicate + the deterministic periodic-refresh scheduler. Mirrors
// idle-timer.test.ts: default 'node' env, `vi.useFakeTimers()` makes the
// 25-min cadence testable without a real setInterval.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isWeatherStale,
  shouldRefreshOnDemand,
  WeatherRefreshScheduler,
  WEATHER_STALE_MS,
  WEATHER_REFRESH_INTERVAL_MS,
} from "./weather-freshness";

describe("isWeatherStale", () => {
  it("null fetchedAt is always stale (no reading yet)", () => {
    expect(isWeatherStale(null, Date.now())).toBe(true);
  });

  it("fresh reading (just fetched) is not stale", () => {
    const now = 1_000_000;
    expect(isWeatherStale(now, now)).toBe(false);
  });

  it("just under the threshold is not stale", () => {
    const now = 1_000_000;
    expect(isWeatherStale(now - (WEATHER_STALE_MS - 1), now)).toBe(false);
  });

  it("at/over the threshold is stale", () => {
    const now = 1_000_000;
    expect(isWeatherStale(now - WEATHER_STALE_MS, now)).toBe(true);
    expect(isWeatherStale(now - WEATHER_STALE_MS - 1, now)).toBe(true);
  });

  it("respects a custom threshold", () => {
    const now = 1_000_000;
    expect(isWeatherStale(now - 5_000, now, 10_000)).toBe(false);
    expect(isWeatherStale(now - 10_000, now, 10_000)).toBe(true);
  });
});

describe("shouldRefreshOnDemand", () => {
  const now = 1_000_000;
  const stale = now - WEATHER_STALE_MS; // exactly at threshold → stale
  const fresh = now - 1; // 1ms old → fresh
  const someWeather = { windSpeed: 5 };

  it("completed/loading round (inactive) never refetches, even when stale", () => {
    expect(shouldRefreshOnDemand(false, someWeather, stale, now)).toBe(false);
    expect(shouldRefreshOnDemand(false, someWeather, null, now)).toBe(false);
  });

  it("active round with an existing STALE reading refreshes", () => {
    expect(shouldRefreshOnDemand(true, someWeather, stale, now)).toBe(true);
  });

  it("active round with a FRESH reading does not refresh", () => {
    expect(shouldRefreshOnDemand(true, someWeather, fresh, now)).toBe(false);
  });

  it("never conjures a first reading out of turn (weather == null → no)", () => {
    // null fetchedAt is 'stale', but with no reading yet an on-demand trigger
    // must stay silent — the initial fetch effect owns first acquisition.
    expect(shouldRefreshOnDemand(true, null, null, now)).toBe(false);
    expect(shouldRefreshOnDemand(true, null, stale, now)).toBe(false);
  });

  it("respects a custom staleness threshold", () => {
    expect(shouldRefreshOnDemand(true, someWeather, now - 5_000, now, 10_000)).toBe(false);
    expect(shouldRefreshOnDemand(true, someWeather, now - 10_000, now, 10_000)).toBe(true);
  });
});

describe("WeatherRefreshScheduler — deterministic periodic tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not tick before start()", () => {
    const onTick = vi.fn();
    new WeatherRefreshScheduler(onTick);
    vi.advanceTimersByTime(WEATHER_REFRESH_INTERVAL_MS * 2);
    expect(onTick).not.toHaveBeenCalled();
  });

  it("ticks every intervalMs while armed", () => {
    const onTick = vi.fn();
    const sched = new WeatherRefreshScheduler(onTick);
    sched.start();

    vi.advanceTimersByTime(WEATHER_REFRESH_INTERVAL_MS - 1);
    expect(onTick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(WEATHER_REFRESH_INTERVAL_MS);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("stop() disarms — no further ticks", () => {
    const onTick = vi.fn();
    const sched = new WeatherRefreshScheduler(onTick);
    sched.start();
    vi.advanceTimersByTime(WEATHER_REFRESH_INTERVAL_MS);
    expect(onTick).toHaveBeenCalledTimes(1);

    sched.stop();
    vi.advanceTimersByTime(WEATHER_REFRESH_INTERVAL_MS * 3);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(sched.isArmed()).toBe(false);
  });

  it("repeated start() calls never stack multiple intervals", () => {
    const onTick = vi.fn();
    const sched = new WeatherRefreshScheduler(onTick);
    sched.start();
    sched.start();
    sched.start();
    vi.advanceTimersByTime(WEATHER_REFRESH_INTERVAL_MS);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it("stop() is safe to call when not armed", () => {
    const onTick = vi.fn();
    const sched = new WeatherRefreshScheduler(onTick);
    expect(() => sched.stop()).not.toThrow();
    expect(sched.isArmed()).toBe(false);
  });

  it("respects a custom intervalMs", () => {
    const onTick = vi.fn();
    const sched = new WeatherRefreshScheduler(onTick, 5_000);
    sched.start();
    vi.advanceTimersByTime(5_000);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it("isArmed() reflects start/stop state", () => {
    const sched = new WeatherRefreshScheduler(() => {});
    expect(sched.isArmed()).toBe(false);
    sched.start();
    expect(sched.isArmed()).toBe(true);
    sched.stop();
    expect(sched.isArmed()).toBe(false);
  });
});
