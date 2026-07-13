/**
 * Unit tests for the per-round COURSE plan helpers
 * (specs/tournament-per-round-format-course-plan.md §3/§9).
 *
 * Covers:
 *  - byte-identical gate: untouched itinerary → buildRoundCoursesPayload is undefined
 *  - applyDayCourseSelection: first pick fills all days; second pick overrides only its day
 *  - selectionFromPlanEntry(planEntryFromSelection(x)) round-trips mapped / centre-only / bare cases
 *  - buildRoundCoursesPayload slices to numRounds
 *  - nextDayIndex = roundIds.length
 */

import { describe, it, expect } from "vitest";
import {
  planEntryFromSelection,
  selectionFromPlanEntry,
  applyDayCourseSelection,
  buildRoundCoursesPayload,
  nextDayIndex,
  planCourseNameForDay,
} from "./tournament-course-plan";
import type { CourseSelectPayload } from "@/components/CourseSearch";
import type { Tournament } from "./types";

function makeSelection(
  overrides: Partial<CourseSelectPayload> = {}
): CourseSelectPayload {
  return {
    id: "course-1",
    name: "Bethpage Black",
    clubName: "Bethpage",
    clubId: "club-1",
    ...overrides,
  };
}

describe("buildRoundCoursesPayload — byte-identical gate", () => {
  it("returns undefined when no day was set (untouched itinerary)", () => {
    expect(buildRoundCoursesPayload([null, null, null, null], 2)).toBeUndefined();
    expect(buildRoundCoursesPayload([], 2)).toBeUndefined();
  });

  it("slices to numRounds before mapping", () => {
    const black = makeSelection({ id: "black", name: "Bethpage Black" });
    const red = makeSelection({ id: "red", name: "Bethpage Red" });
    const result = buildRoundCoursesPayload([black, red, null, null], 2);
    expect(result).toEqual([
      { courseId: "black", courseName: "Bethpage Black" },
      { courseId: "red", courseName: "Bethpage Red" },
    ]);
  });

  it("returns entries with null for undrawn days when at least one day is set", () => {
    const black = makeSelection({ id: "black", name: "Bethpage Black" });
    const result = buildRoundCoursesPayload([black, null], 2);
    expect(result).toEqual([
      { courseId: "black", courseName: "Bethpage Black" },
      null,
    ]);
  });
});

describe("applyDayCourseSelection — one course for all rounds default", () => {
  it("fills every slot on the first pick", () => {
    const black = makeSelection({ id: "black", name: "Bethpage Black" });
    const result = applyDayCourseSelection([null, null, null, null], 1, black);
    expect(result).toEqual([black, black, black, black]);
  });

  it("overrides only its day once a prior pick exists", () => {
    const black = makeSelection({ id: "black", name: "Bethpage Black" });
    const red = makeSelection({ id: "red", name: "Bethpage Red" });
    const afterFirstPick = applyDayCourseSelection(
      [null, null, null, null],
      0,
      black
    );
    const afterSecondPick = applyDayCourseSelection(afterFirstPick, 1, red);
    expect(afterSecondPick).toEqual([black, red, black, black]);
  });
});

describe("selectionFromPlanEntry(planEntryFromSelection(x)) — round-trip identity", () => {
  it("preserves mapped id + source:mapped + centre for a mapped selection", () => {
    const selection = makeSelection({
      id: "9f2b7c1e-1111-5222-8333-444455556666",
      name: "Bethpage Black",
      source: "mapped",
      center: { lat: 40.7452, lng: -73.4565 },
    });
    const entry = planEntryFromSelection(selection);
    expect(entry).toEqual({
      courseId: "9f2b7c1e-1111-5222-8333-444455556666",
      courseName: "Bethpage Black",
      courseLat: 40.7452,
      courseLng: -73.4565,
      mappedCourseId: "9f2b7c1e-1111-5222-8333-444455556666",
    });
    const roundTripped = selectionFromPlanEntry(entry);
    expect(roundTripped).toEqual({
      id: "9f2b7c1e-1111-5222-8333-444455556666",
      name: "Bethpage Black",
      source: "mapped",
      center: { lat: 40.7452, lng: -73.4565 },
    });
  });

  it("preserves a centre-only selection (OSM/GolfAPI case) without fabricating a mapped id", () => {
    const selection = makeSelection({
      id: "osm-123",
      name: "Some OSM Course",
      source: "osm",
      center: { lat: 41.0, lng: -74.0 },
    });
    const entry = planEntryFromSelection(selection);
    expect(entry.mappedCourseId).toBeUndefined();
    expect(entry.courseLat).toBe(41.0);
    expect(entry.courseLng).toBe(-74.0);

    const roundTripped = selectionFromPlanEntry(entry);
    expect(roundTripped).toEqual({
      id: "osm-123",
      name: "Some OSM Course",
      source: undefined,
      center: { lat: 41.0, lng: -74.0 },
    });
  });

  it("preserves a bare name/id selection with no anchor at all", () => {
    const selection = makeSelection({ id: "bare-1", name: "Local Muni" });
    const entry = planEntryFromSelection(selection);
    expect(entry).toEqual({ courseId: "bare-1", courseName: "Local Muni" });

    const roundTripped = selectionFromPlanEntry(entry);
    expect(roundTripped).toEqual({
      id: "bare-1",
      name: "Local Muni",
      source: undefined,
      center: undefined,
    });
  });
});

describe("nextDayIndex / planCourseNameForDay", () => {
  function makeTournament(overrides: Partial<Tournament> = {}): Tournament {
    return {
      id: "t1",
      name: "Bethpage Trip",
      playerIds: [],
      roundIds: [],
      createdAt: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  it("nextDayIndex is roundIds.length", () => {
    expect(nextDayIndex({ roundIds: [] })).toBe(0);
    expect(nextDayIndex({ roundIds: ["r1"] })).toBe(1);
    expect(nextDayIndex({ roundIds: ["r1", "r2"] })).toBe(2);
  });

  it("planCourseNameForDay reads the day's plan entry defensively", () => {
    const t = makeTournament({
      roundCourses: [
        { courseId: "black", courseName: "Bethpage Black" },
        null,
      ],
    });
    expect(planCourseNameForDay(t, 0)).toBe("Bethpage Black");
    expect(planCourseNameForDay(t, 1)).toBeNull();
    expect(planCourseNameForDay(t, 5)).toBeNull(); // out of range, no throw

    const noPlan = makeTournament();
    expect(planCourseNameForDay(noPlan, 0)).toBeNull();
  });
});
