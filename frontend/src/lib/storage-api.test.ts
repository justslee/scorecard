// @vitest-environment jsdom
/**
 * Unit tests for storage-api.ts's offline-fallback identity-leak fix
 * (multiuser-p0-client-identity, specs/multi-user-epic-plan.md §3.5 / §3.6.6).
 *
 * `isAuthenticated()` mode-picks via `!!window.Clerk?.session` — when false
 * (signed-out or offline), reads fall through to `localCache.*` (storage.ts),
 * which is namespaced via `getCurrentUserId()`. These tests prove the local
 * fallback can only ever serve the last-known signed-in user's cache, or
 * empty — never a different, foreign user's cache.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getRoundsAsync, getPlayersAsync } from "./storage-api";
import { saveRound, saveSavedPlayer } from "./storage";
import type { Round, SavedPlayer } from "./types";

function setClerkSignedIn(id: string | undefined) {
  const w = window as unknown as {
    Clerk?: { user?: { id?: string }; session?: unknown };
  };
  w.Clerk = id ? { user: { id }, session: {} } : undefined;
}

function makeRound(id: string): Round {
  return {
    id,
    courseId: "course-1",
    courseName: "Test Links",
    date: "2026-07-16",
    players: [{ id: "p1", name: "Me" }],
    scores: [],
    holes: [],
    games: [],
    status: "active",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
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
  setClerkSignedIn(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline fallback refuses a foreign cache", () => {
  it("serves ONLY the last-known signed-in user's namespace, never a different user's", async () => {
    // Seed user A's local cache while "signed in" as A.
    setClerkSignedIn("user_a");
    saveRound(makeRound("round-a"));

    // Seed user B's local cache while "signed in" as B (B signs in more
    // recently — B is now the device's "last known" user).
    setClerkSignedIn("user_b");
    saveRound(makeRound("round-b"));

    // Now go offline / signed-out: window.Clerk never hydrates (native) or
    // there's no active session (signed out).
    setClerkSignedIn(undefined);

    const rounds = await getRoundsAsync();

    expect(rounds.map((r) => r.id)).toEqual(["round-b"]); // last-known user, B
    expect(rounds.some((r) => r.id === "round-a")).toBe(false); // NEVER A's cache
  });

  it("serves empty (never a foreign namespace) on a device with no known signed-in user", async () => {
    // Simulate stray data existing under SOME other user's namespace (e.g. a
    // shared device, or leftover from an uninstalled account) — but this
    // device itself has never resolved a live or last-known user id.
    window.localStorage.setItem(
      "scorecard_some_other_user_rounds",
      JSON.stringify([makeRound("foreign-round")]),
    );

    setClerkSignedIn(undefined); // never signed in on this device

    const rounds = await getRoundsAsync();

    expect(rounds).toEqual([]); // empty, not the foreign namespace's data
  });

  it("holds for the players cache too", async () => {
    const playerA: SavedPlayer = {
      id: "sp-a",
      name: "A's Partner",
      roundsPlayed: 0,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    const playerB: SavedPlayer = {
      id: "sp-b",
      name: "B's Partner",
      roundsPlayed: 0,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    };

    setClerkSignedIn("user_a");
    saveSavedPlayer(playerA);

    setClerkSignedIn("user_b");
    saveSavedPlayer(playerB);

    setClerkSignedIn(undefined);

    const players = await getPlayersAsync();

    expect(players.map((p) => p.id)).toEqual(["sp-b"]);
    expect(players.some((p) => p.id === "sp-a")).toBe(false);
  });
});
