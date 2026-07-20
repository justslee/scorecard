// @vitest-environment jsdom
/**
 * Unit tests for `runSignOutTeardown()`
 * (specs/multiuser-p0-signout-namespace-clear-plan.md §8.1).
 *
 * Covers the TOCTOU regression the backlog item exists to close (the pointer
 * clear must actually resolve every subsequent read to the anon namespace),
 * plus the composition/ordering, fault-isolation, idempotency, and
 * in-memory-reset guarantees.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — module-level so runSignOutTeardown's imports resolve to these.
// ---------------------------------------------------------------------------

const stopActiveRealtimeClient = vi.fn();
vi.mock("@/lib/voice/realtime", () => ({
  stopActiveRealtimeClient: (...args: unknown[]) => stopActiveRealtimeClient(...args),
}));

const warmSessionTeardown = vi.fn();
vi.mock("@/lib/voice/warm-session", () => ({
  warmSession: { teardown: (...args: unknown[]) => warmSessionTeardown(...args) },
}));

const clearNativeToken = vi.fn();
vi.mock("@/lib/native-token-store", () => ({
  clearNativeToken: (...args: unknown[]) => clearNativeToken(...args),
}));

let isNativePlatform = false;
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativePlatform },
}));

import { runSignOutTeardown } from "./sign-out-teardown";
import { getCurrentUserId } from "./identity-core";
import { storageKey } from "./storage-keys";
import { getHydratedGolferProfile } from "./identity";

/** Simulate window.Clerk hydrating (or not) with a signed-in user. */
function setClerkUser(id: string | undefined) {
  (window as unknown as { Clerk?: { user?: { id?: string } } }).Clerk = id
    ? { user: { id } }
    : undefined;
}

// jsdom in this project's Node/vitest setup doesn't reliably ship a working
// localStorage — provide a lightweight Map-backed mock via vi.stubGlobal
// (same pattern as storage-keys.test.ts).
function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeLocalStorage());
  setClerkUser(undefined);
  isNativePlatform = false;
  stopActiveRealtimeClient.mockReset();
  warmSessionTeardown.mockReset();
  clearNativeToken.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runSignOutTeardown", () => {
  it("THE TOCTOU regression: clears the namespace pointer so every subsequent read resolves to anon, never the departed user's data", async () => {
    window.localStorage.setItem("scorecard_last_user_id", "user_a");
    window.localStorage.setItem("scorecard_user_a_caddie_persona", "saltbox");
    setClerkUser(undefined); // post-sign-out: window.Clerk already cleared

    await runSignOutTeardown();

    expect(getCurrentUserId()).toBeNull();
    expect(storageKey("caddie_persona")).toBe("scorecard_anon_caddie_persona");
    // The default (unset) — NEVER the departed user's 'saltbox'.
    expect(window.localStorage.getItem(storageKey("caddie_persona"))).toBeNull();
  });

  it("leaves the departing user's own namespaced data untouched", async () => {
    window.localStorage.setItem("scorecard_last_user_id", "user_a");
    window.localStorage.setItem("scorecard_user_a_caddie_persona", "saltbox");
    window.localStorage.setItem("scorecard_migrated_v1", "1");

    await runSignOutTeardown();

    expect(window.localStorage.getItem("scorecard_user_a_caddie_persona")).toBe("saltbox");
    expect(window.localStorage.getItem("scorecard_migrated_v1")).toBe("1");
  });

  it("stops the realtime client and tears down the warm session on every platform", async () => {
    isNativePlatform = false;
    await runSignOutTeardown();

    expect(stopActiveRealtimeClient).toHaveBeenCalledTimes(1);
    expect(warmSessionTeardown).toHaveBeenCalledTimes(1);
    expect(clearNativeToken).not.toHaveBeenCalled();
  });

  it("clears the native Keychain token only when Capacitor.isNativePlatform() is true", async () => {
    isNativePlatform = true;
    await runSignOutTeardown();

    expect(clearNativeToken).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second call does not throw and leaves state unchanged", async () => {
    window.localStorage.setItem("scorecard_last_user_id", "user_a");

    await runSignOutTeardown();
    await expect(runSignOutTeardown()).resolves.toBeUndefined();

    expect(getCurrentUserId()).toBeNull();
  });

  it("fault-isolates: a rejecting Keychain clear still clears the namespace pointer and does not throw", async () => {
    isNativePlatform = true;
    clearNativeToken.mockRejectedValue(new Error("keychain unavailable"));
    window.localStorage.setItem("scorecard_last_user_id", "user_a");

    await expect(runSignOutTeardown()).resolves.toBeUndefined();

    expect(getCurrentUserId()).toBeNull();
  });

  it("resets in-memory identity state (hydrated GolferProfile) on teardown", async () => {
    await runSignOutTeardown();

    expect(getHydratedGolferProfile()).toBeNull();
  });
});
