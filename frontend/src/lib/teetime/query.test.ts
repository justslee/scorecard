/**
 * Unit tests for tee-time query building — the prefs → TeeTimeQuery fan-out
 * (area inclusion, per-window dates, fallback window).
 */

import { describe, it, expect } from "vitest";
import { buildTeeTimeQueries, formatAreaLatLng } from "./query";

// Wed Jul 1 2026 → next Sat = 07-04, next Sun = 07-05.
const WED = new Date(2026, 6, 1, 10, 0);

const BASE = {
  courseIds: ["osm-1", "osm-2"],
  partySize: 4,
  maxDistanceMiles: 15,
};

describe("buildTeeTimeQueries", () => {
  it("fans out one query per window, each on its own day's date", () => {
    const queries = buildTeeTimeQueries({
      ...BASE,
      windows: [
        { label: "Saturday", start: "06:30", end: "09:30" },
        { label: "Sunday", start: "07:00", end: "10:00" },
      ],
      area: "37.79000,-122.46000",
    }, WED);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      date: "2026-07-04",
      timeWindowStart: "06:30",
      timeWindowEnd: "09:30",
      partySize: 4,
      maxDistanceMiles: 15,
      courseIds: ["osm-1", "osm-2"],
    });
    expect(queries[1].date).toBe("2026-07-05"); // Sunday — NOT Saturday's date
    expect(queries[1].timeWindowStart).toBe("07:00");
  });

  it("includes area on every query when known", () => {
    const queries = buildTeeTimeQueries({
      ...BASE,
      windows: [
        { label: "Saturday", start: "06:30", end: "09:30" },
        { label: "Sunday", start: "07:00", end: "10:00" },
      ],
      area: "37.79000,-122.46000",
    }, WED);
    for (const q of queries) expect(q.area).toBe("37.79000,-122.46000");
  });

  it("omits area entirely when location is unknown", () => {
    const [q] = buildTeeTimeQueries({
      ...BASE,
      windows: [{ label: "Saturday", start: "06:30", end: "09:30" }],
    }, WED);
    expect("area" in q).toBe(false);
  });

  it("omits courseIds when no courses are selected", () => {
    const [q] = buildTeeTimeQueries({
      ...BASE,
      courseIds: [],
      windows: [{ label: "Saturday", start: "06:30", end: "09:30" }],
    }, WED);
    expect("courseIds" in q).toBe(false);
  });

  it("no windows selected → single broad Saturday-morning query", () => {
    const queries = buildTeeTimeQueries({ ...BASE, windows: [], area: "sf" }, WED);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      date: "2026-07-04",
      timeWindowStart: "06:00",
      timeWindowEnd: "12:00",
      area: "sf",
    });
  });
});

describe("formatAreaLatLng", () => {
  it('formats as "lat,lng" with 5 decimals', () => {
    expect(formatAreaLatLng(37.7907123, -122.4610987)).toBe("37.79071,-122.46110");
  });
});
