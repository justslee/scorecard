// @vitest-environment jsdom
// Live mode defaults ON (owner directive 2026-07-09) — the URL-param flag was
// unreachable in the native app. "0" is the only off state; absent/garbage/
// storage-error all mean ON (the classic path remains the automatic fallback).
// This jsdom build lacks a real localStorage — stub a Map-backed one.
import { describe, it, expect, beforeEach } from "vitest";
import { getCaddieLiveMode, setCaddieLiveMode } from "./live-mode-pref";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
});

describe("live-mode-pref (default ON)", () => {
  it("defaults ON when the key is absent", () => {
    expect(getCaddieLiveMode()).toBe(true);
  });

  it("only an explicit '0' turns it off", () => {
    setCaddieLiveMode(false);
    expect(getCaddieLiveMode()).toBe(false);
    setCaddieLiveMode(true);
    expect(getCaddieLiveMode()).toBe(true);
  });

  it("garbage values read as ON (never lock the owner out of live mode)", () => {
    store.set("looper.caddieLiveMode", "banana");
    expect(getCaddieLiveMode()).toBe(true);
  });
});
