// @vitest-environment jsdom
/**
 * Unit tests for storage.ts's per-user namespacing (multiuser-p0-client-
 * identity, specs/multi-user-epic-plan.md §3.5 / §3.6.6).
 *
 * Covers the P0 acceptance bar directly against the real storage.ts API
 * (not just the key-derivation helper): the core cross-user leak test, and
 * byte-identical-for-the-owner after the legacy migration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getRounds,
  saveRound,
  getCourses,
  saveCourse,
  getGolferProfile,
  saveGolferProfile,
  getSavedPlayers,
  saveSavedPlayer,
} from "./storage";
import type { Round, Course, GolferProfile, SavedPlayer } from "./types";

function setClerkUser(id: string | undefined) {
  (window as unknown as { Clerk?: { user?: { id?: string } } }).Clerk = id
    ? { user: { id } }
    : undefined;
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

function makeCourse(id: string): Course {
  return {
    id,
    name: "Custom Course",
    holes: [{ number: 1, par: 4, yards: 400 }],
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
  setClerkUser(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The core leak test
// ---------------------------------------------------------------------------

describe("user-switch on one device", () => {
  it("sees empty state, not user A's rounds (the core leak test)", () => {
    setClerkUser("user_a");
    saveRound(makeRound("round-a"));
    expect(getRounds().map((r) => r.id)).toEqual(["round-a"]);

    setClerkUser("user_b");
    expect(getRounds()).toEqual([]); // NOT user A's round.

    saveRound(makeRound("round-b"));
    expect(getRounds().map((r) => r.id)).toEqual(["round-b"]);

    // Switching back to user A: their data is untouched by user B's writes.
    setClerkUser("user_a");
    expect(getRounds().map((r) => r.id)).toEqual(["round-a"]);
  });

  it("also isolates saved courses", () => {
    setClerkUser("user_a");
    // saveCourse appends to whatever getCourses() currently returns — on a
    // fresh namespace that's the default sample courses, so "course-a" joins
    // them under A's namespace.
    saveCourse(makeCourse("course-a"));
    expect(getCourses().some((c) => c.id === "course-a")).toBe(true);

    setClerkUser("user_b");
    // No saved courses for B yet → falls back to the default sample courses,
    // NOT user A's custom course.
    expect(getCourses().some((c) => c.id === "course-a")).toBe(false);
  });

  it("also isolates saved players and the golfer profile", () => {
    const playerA: SavedPlayer = {
      id: "sp-a",
      name: "Alice's Partner",
      roundsPlayed: 0,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    const profileA: GolferProfile = {
      id: "gp-a",
      name: "Alice",
      handicap: 12,
      homeCourse: null,
      clubDistances: {},
      onboardingStep: null,
    };

    setClerkUser("user_a");
    saveSavedPlayer(playerA);
    saveGolferProfile(profileA);
    expect(getSavedPlayers().map((p) => p.id)).toEqual(["sp-a"]);
    expect(getGolferProfile()?.name).toBe("Alice");

    setClerkUser("user_b");
    expect(getSavedPlayers()).toEqual([]);
    expect(getGolferProfile()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Byte-identical for the owner — the migration is the ONLY observable change
// ---------------------------------------------------------------------------

describe("byte-identical for the owner after migration", () => {
  it("getRounds/getCourses return exactly what the legacy bare keys held", () => {
    const legacyRounds: Round[] = [makeRound("owner-round-1")];
    const legacyCourses: Course[] = [makeCourse("owner-course-1")];

    // Simulate the owner's existing pre-namespacing device state.
    window.localStorage.setItem("scorecard_rounds", JSON.stringify(legacyRounds));
    window.localStorage.setItem("scorecard_courses", JSON.stringify(legacyCourses));

    // Clerk resolves to the owner on this device (the only account today).
    setClerkUser("owner_clerk_id");

    // First read triggers the one-time migration (storageKey() -> migrateLegacyKeysIfNeeded()).
    const rounds = getRounds();
    const courses = getCourses();

    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toEqual(legacyRounds[0]);

    expect(courses).toHaveLength(1);
    expect(courses[0]).toEqual(legacyCourses[0]);

    // The legacy keys are gone — everything now lives under the owner's namespace.
    expect(window.localStorage.getItem("scorecard_rounds")).toBeNull();
    expect(window.localStorage.getItem("scorecard_courses")).toBeNull();
  });

  it("a second read after migration returns the identical data (no drift, no duplication)", () => {
    window.localStorage.setItem(
      "scorecard_rounds",
      JSON.stringify([makeRound("owner-round-1")]),
    );
    setClerkUser("owner_clerk_id");

    const first = getRounds();
    const second = getRounds();

    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });
});
