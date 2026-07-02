import { describe, it, expect } from "vitest";
import { anchorFromSelectedCourse, roundCourseAnchor } from "./round-anchor";

describe("anchorFromSelectedCourse", () => {
  it("returns empty fields for null selection", () => {
    expect(anchorFromSelectedCourse(null)).toEqual({});
  });

  it("carries the centre for any source that has one", () => {
    expect(
      anchorFromSelectedCourse({
        id: 123,
        source: "osm",
        center: { lat: 40.745, lng: -73.456 },
      })
    ).toEqual({ courseLat: 40.745, courseLng: -73.456 });
  });

  it("carries mappedCourseId only for mapped selections", () => {
    const mapped = anchorFromSelectedCourse({
      id: "9f2b7c1e-1111-5222-8333-444455556666",
      source: "mapped",
      center: { lat: 40.745, lng: -73.456 },
    });
    expect(mapped).toEqual({
      courseLat: 40.745,
      courseLng: -73.456,
      mappedCourseId: "9f2b7c1e-1111-5222-8333-444455556666",
    });

    const golfapi = anchorFromSelectedCourse({
      id: 987,
      source: "golfapi",
      center: { lat: 1, lng: 2 },
    });
    expect(golfapi.mappedCourseId).toBeUndefined();
  });

  it("handles a mapped selection without a centre", () => {
    expect(
      anchorFromSelectedCourse({ id: "abc", source: "mapped" })
    ).toEqual({ mappedCourseId: "abc" });
  });

  it("returns no fields when the selection has neither centre nor mapped id", () => {
    expect(anchorFromSelectedCourse({ id: 5, source: "golfapi" })).toEqual({});
  });
});

describe("roundCourseAnchor", () => {
  it("returns null for legacy rounds without an anchor", () => {
    expect(roundCourseAnchor(null)).toBeNull();
    expect(roundCourseAnchor(undefined)).toBeNull();
    expect(roundCourseAnchor({})).toBeNull();
    expect(roundCourseAnchor({ courseLat: 40.7 })).toBeNull();
    expect(roundCourseAnchor({ courseLng: -73.4 })).toBeNull();
  });

  it("returns the centre when both coordinates exist", () => {
    expect(roundCourseAnchor({ courseLat: 40.7, courseLng: -73.4 })).toEqual({
      lat: 40.7,
      lng: -73.4,
    });
  });

  it("treats 0 as a valid coordinate", () => {
    expect(roundCourseAnchor({ courseLat: 0, courseLng: 0 })).toEqual({
      lat: 0,
      lng: 0,
    });
  });
});
