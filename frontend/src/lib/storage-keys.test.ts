// @vitest-environment jsdom
/**
 * Unit tests for storage-keys.ts + identity-core.ts (multiuser-p0-client-
 * identity, specs/multi-user-epic-plan.md §3.5 / §3.6.6).
 *
 * Covers: key derivation for signed-in / last-user / anon; the one-time
 * legacy migration (idempotency, ordering, never-clobber); and
 * clearCurrentUserStorage (Settings "clear cache" scoping fix).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { storageKey, migrateLegacyKeysIfNeeded, clearCurrentUserStorage } from "./storage-keys";
import { getCurrentUserId } from "./identity-core";

/** Simulate window.Clerk hydrating (or not) with a signed-in user. */
function setClerkUser(id: string | undefined) {
  (window as unknown as { Clerk?: { user?: { id?: string } } }).Clerk = id
    ? { user: { id } }
    : undefined;
}

// jsdom in this project's Node/vitest setup doesn't reliably ship a working
// localStorage (same reason CaddieOrbSheet.test.tsx stubs it) — provide a
// lightweight Map-backed mock via vi.stubGlobal instead of relying on jsdom's.
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// getCurrentUserId — resolution order
// ---------------------------------------------------------------------------

describe("getCurrentUserId", () => {
  it("returns null on a fresh device that has never signed in", () => {
    expect(getCurrentUserId()).toBeNull();
  });

  it("prefers the live window.Clerk user id when present", () => {
    setClerkUser("user_abc");
    expect(getCurrentUserId()).toBe("user_abc");
  });

  it("persists the live id to scorecard_last_user_id as a side effect", () => {
    setClerkUser("user_abc");
    getCurrentUserId();
    expect(window.localStorage.getItem("scorecard_last_user_id")).toBe("user_abc");
  });

  it("falls back to scorecard_last_user_id when window.Clerk hasn't hydrated (native/offline)", () => {
    window.localStorage.setItem("scorecard_last_user_id", "user_prev");
    expect(getCurrentUserId()).toBe("user_prev");
  });

  it("prefers the live Clerk id over a stale last-user-id", () => {
    window.localStorage.setItem("scorecard_last_user_id", "user_prev");
    setClerkUser("user_new");
    expect(getCurrentUserId()).toBe("user_new");
  });
});

// ---------------------------------------------------------------------------
// storageKey — namespace derivation
// ---------------------------------------------------------------------------

describe("storageKey", () => {
  it("derives scorecard_anon_<name> with no known user", () => {
    expect(storageKey("rounds")).toBe("scorecard_anon_rounds");
  });

  it("derives scorecard_<uid>_<name> for a live signed-in user", () => {
    setClerkUser("user_abc");
    expect(storageKey("rounds")).toBe("scorecard_user_abc_rounds");
  });

  it("derives scorecard_<uid>_<name> from the last-known user when signed out/offline", () => {
    window.localStorage.setItem("scorecard_last_user_id", "user_prev");
    expect(storageKey("rounds")).toBe("scorecard_user_prev_rounds");
  });

  it("resolves the SAME namespace for two different base names under one user", () => {
    setClerkUser("user_abc");
    expect(storageKey("rounds")).toBe("scorecard_user_abc_rounds");
    expect(storageKey("courses")).toBe("scorecard_user_abc_courses");
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyKeysIfNeeded — the highest-risk part (ordering + idempotency)
// ---------------------------------------------------------------------------

describe("migrateLegacyKeysIfNeeded", () => {
  it("no-ops when no user id is known yet — never migrates into a wrong/blank namespace", () => {
    window.localStorage.setItem("scorecard_rounds", JSON.stringify([{ id: "r1" }]));

    migrateLegacyKeysIfNeeded();

    expect(window.localStorage.getItem("scorecard_migrated_v1")).toBeNull();
    // Legacy data is untouched — not migrated, not lost.
    expect(window.localStorage.getItem("scorecard_rounds")).toBe(JSON.stringify([{ id: "r1" }]));
    expect(window.localStorage.getItem("scorecard_anon_rounds")).toBeNull();
  });

  it("migrates legacy keys into the signed-in user's namespace once a user id becomes known", () => {
    window.localStorage.setItem("scorecard_rounds", JSON.stringify([{ id: "r1" }]));
    window.localStorage.setItem("looper.caddiePersonaId", "hype");
    setClerkUser("user_abc");

    migrateLegacyKeysIfNeeded();

    expect(window.localStorage.getItem("scorecard_migrated_v1")).toBe("1");
    // Legacy keys removed...
    expect(window.localStorage.getItem("scorecard_rounds")).toBeNull();
    expect(window.localStorage.getItem("looper.caddiePersonaId")).toBeNull();
    // ...and moved into the user's namespace.
    expect(window.localStorage.getItem("scorecard_user_abc_rounds")).toBe(
      JSON.stringify([{ id: "r1" }]),
    );
    expect(window.localStorage.getItem("scorecard_user_abc_caddie_persona")).toBe("hype");
  });

  it("ordering: fires-before-Clerk-resolves then user-id-becomes-known — migrates correctly on the SECOND call, not before", () => {
    window.localStorage.setItem("scorecard_rounds", JSON.stringify([{ id: "r1" }]));

    // First call — before Clerk resolves (app boot race).
    migrateLegacyKeysIfNeeded();
    expect(window.localStorage.getItem("scorecard_migrated_v1")).toBeNull();
    expect(window.localStorage.getItem("scorecard_rounds")).not.toBeNull();

    // Clerk resolves.
    setClerkUser("user_abc");
    migrateLegacyKeysIfNeeded();

    expect(window.localStorage.getItem("scorecard_migrated_v1")).toBe("1");
    expect(window.localStorage.getItem("scorecard_user_abc_rounds")).toBe(
      JSON.stringify([{ id: "r1" }]),
    );
  });

  it("is idempotent — a second call after completion is a no-op and never clobbers newer data", () => {
    window.localStorage.setItem("scorecard_rounds", JSON.stringify([{ id: "r1" }]));
    setClerkUser("user_abc");
    migrateLegacyKeysIfNeeded();

    // App writes new data into the namespaced key post-migration.
    window.localStorage.setItem("scorecard_user_abc_rounds", JSON.stringify([{ id: "r2" }]));
    // A stray re-write of the legacy key (shouldn't happen post-migration, but
    // prove the completed flag gates any further migration attempt).
    window.localStorage.setItem("scorecard_rounds", JSON.stringify([{ id: "stale" }]));

    migrateLegacyKeysIfNeeded();

    expect(window.localStorage.getItem("scorecard_user_abc_rounds")).toBe(
      JSON.stringify([{ id: "r2" }]),
    );
  });

  it("never overwrites an existing namespaced value even on the completing run", () => {
    setClerkUser("user_abc");
    window.localStorage.setItem("scorecard_user_abc_rounds", JSON.stringify([{ id: "real" }]));
    window.localStorage.setItem("scorecard_rounds", JSON.stringify([{ id: "legacy" }]));

    migrateLegacyKeysIfNeeded();

    expect(window.localStorage.getItem("scorecard_user_abc_rounds")).toBe(
      JSON.stringify([{ id: "real" }]),
    );
    // The stale legacy key is still cleared (fully handled either way).
    expect(window.localStorage.getItem("scorecard_rounds")).toBeNull();
  });

  it("is a no-op when there are no legacy keys to migrate (still sets the flag once a user id is known)", () => {
    setClerkUser("user_abc");
    migrateLegacyKeysIfNeeded();
    expect(window.localStorage.getItem("scorecard_migrated_v1")).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// clearCurrentUserStorage — Settings "clear cache" scoping fix
// ---------------------------------------------------------------------------

describe("clearCurrentUserStorage", () => {
  it("clears only the current user's namespaced keys, never another user's", () => {
    setClerkUser("user_a");
    window.localStorage.setItem(storageKey("rounds"), "a-data");
    setClerkUser("user_b");
    window.localStorage.setItem(storageKey("rounds"), "b-data");

    clearCurrentUserStorage();

    expect(window.localStorage.getItem("scorecard_user_b_rounds")).toBeNull();
    expect(window.localStorage.getItem("scorecard_user_a_rounds")).toBe("a-data");
  });

  it("does not touch the device-global GolfAPI course cache", () => {
    setClerkUser("user_a");
    window.localStorage.setItem("golfapi_recent_courses", JSON.stringify(["x"]));

    clearCurrentUserStorage();

    expect(window.localStorage.getItem("golfapi_recent_courses")).not.toBeNull();
  });
});
