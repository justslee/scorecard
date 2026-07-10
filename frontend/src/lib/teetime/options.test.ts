/**
 * Unit tests for the Options-phase pure helpers (results/prefs UX fixes
 * #1–#3, specs/teetime-show-real-time-options-plan.md §5).
 */

import { describe, it, expect } from "vitest";
import {
  isRealSlot,
  asksForDate,
  formatAskWindows,
  groupSlotsByCourse,
  filterToSelection,
  slotOptionLabel,
  emptySelectionNote,
  formatTime12h,
  formatWindowRange,
  type DispatchedAsk,
} from "./options";
import type { TeeTimeSlot } from "./types";

function slot(overrides: Partial<TeeTimeSlot> & { id: string; courseId: string; courseName: string }): TeeTimeSlot {
  return {
    city: "San Francisco, CA",
    date: "2026-07-11",
    time: "07:10",
    players: 2,
    priceUsd: 24,
    cartIncluded: false,
    distanceMiles: 4.1,
    rating: 4.2,
    provider: "foreup",
    holes: 18,
    ...overrides,
  };
}

// ─── isRealSlot ────────────────────────────────────────────────────────────────

describe("isRealSlot", () => {
  it("a foreup slot with a real time and no route is real", () => {
    expect(isRealSlot(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "07:10", route: undefined }))).toBe(true);
  });

  it("a mock slot (real time, no route) is real", () => {
    expect(isRealSlot(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "07:10", provider: "mock", route: undefined }))).toBe(true);
  });

  it("a book_on_site route entry (time='') is not real", () => {
    expect(isRealSlot(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "", route: "book_on_site" }))).toBe(false);
  });

  it("a call route entry (time='') is not real", () => {
    expect(isRealSlot(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "", route: "call" }))).toBe(false);
  });

  it("a route set but a (theoretically) non-empty time is still not real — route wins", () => {
    expect(isRealSlot(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "07:10", route: "call" }))).toBe(false);
  });

  it("no route but an empty time is not real (defensive — should never happen upstream)", () => {
    expect(isRealSlot(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "", route: undefined }))).toBe(false);
  });
});

// ─── asksForDate / formatAskWindows ────────────────────────────────────────────

describe("asksForDate / formatAskWindows", () => {
  const ASKS: DispatchedAsk[] = [
    { date: "2026-07-11", start: "06:30", end: "09:30" },
    { date: "2026-07-11", start: "11:00", end: "14:00" },
    { date: "2026-07-12", start: "07:00", end: "10:00" },
  ];

  it("filters asks to a single date", () => {
    expect(asksForDate(ASKS, "2026-07-12")).toEqual([{ date: "2026-07-12", start: "07:00", end: "10:00" }]);
  });

  it("returns [] for a date with no dispatched ask", () => {
    expect(asksForDate(ASKS, "2026-08-01")).toEqual([]);
  });

  it("formats a single window", () => {
    expect(formatAskWindows(asksForDate(ASKS, "2026-07-12"))).toBe("7:00–10:00 AM");
  });

  it("joins two windows sharing the same date with 'or'", () => {
    expect(formatAskWindows(asksForDate(ASKS, "2026-07-11"))).toBe("6:30–9:30 AM or 11:00 AM–2:00 PM");
  });

  it("empty asks format to an empty string", () => {
    expect(formatAskWindows([])).toBe("");
  });
});

// ─── formatTime12h / formatWindowRange (moved from page.tsx) ──────────────────

describe("formatTime12h / formatWindowRange", () => {
  it("formats a 24h time", () => {
    expect(formatTime12h("07:10")).toBe("7:10 AM");
    expect(formatTime12h("14:05")).toBe("2:05 PM");
  });

  it("collapses a same-period range", () => {
    expect(formatWindowRange("07:00", "10:00")).toBe("7:00–10:00 AM");
  });

  it("keeps both periods when the range crosses noon", () => {
    expect(formatWindowRange("11:00", "14:00")).toBe("11:00 AM–2:00 PM");
  });
});

// ─── groupSlotsByCourse ────────────────────────────────────────────────────────

describe("groupSlotsByCourse", () => {
  it("groups real slots by course and sorts times ascending", () => {
    const slots = [
      slot({ id: "p-1", courseId: "presidio", courseName: "Presidio Golf Course", time: "09:00", distanceMiles: 4.1 }),
      slot({ id: "p-2", courseId: "presidio", courseName: "Presidio Golf Course", time: "07:10", distanceMiles: 4.1 }),
    ];
    const groups = groupSlotsByCourse(slots);
    expect(groups).toHaveLength(1);
    expect(groups[0].realSlots.map((s) => s.time)).toEqual(["07:10", "09:00"]);
  });

  it("puts real-slot groups before route-entry-only groups regardless of distance", () => {
    const slots = [
      slot({ id: "route-1", courseId: "close", courseName: "Close Muni", time: "", route: "call", distanceMiles: 1.0 }),
      slot({ id: "real-1", courseId: "far", courseName: "Far Foreup", time: "07:10", distanceMiles: 9.0 }),
    ];
    const groups = groupSlotsByCourse(slots);
    expect(groups.map((g) => g.courseId)).toEqual(["far", "close"]);
  });

  it("orders same-bucket groups by distance", () => {
    const slots = [
      slot({ id: "a", courseId: "far", courseName: "Far", time: "07:00", distanceMiles: 9.0 }),
      slot({ id: "b", courseId: "near", courseName: "Near", time: "07:30", distanceMiles: 2.0 }),
    ];
    const groups = groupSlotsByCourse(slots);
    expect(groups.map((g) => g.courseId)).toEqual(["near", "far"]);
  });

  it("a mixed response groups real slots and route entries into separate course cards", () => {
    const slots = [
      slot({ id: "real-1", courseId: "foreup-1", courseName: "Foreup Course", time: "07:10", distanceMiles: 3.0 }),
      slot({ id: "route-1", courseId: "osm-2", courseName: "Muni Course", time: "", route: "book_on_site", distanceMiles: 5.0 }),
    ];
    const groups = groupSlotsByCourse(slots);
    expect(groups).toHaveLength(2);
    expect(groups[0].realSlots).toHaveLength(1);
    expect(groups[0].routeEntry).toBeUndefined();
    expect(groups[1].realSlots).toHaveLength(0);
    expect(groups[1].routeEntry?.id).toBe("route-1");
  });

  it("falls back to a normalized course name when courseId is empty", () => {
    const slots = [
      slot({ id: "a", courseId: "", courseName: "Sharp Park Golf Course", time: "07:00", distanceMiles: 2.0 }),
      slot({ id: "b", courseId: "", courseName: "sharp   park golf course", time: "08:00", distanceMiles: 2.0 }),
    ];
    const groups = groupSlotsByCourse(slots);
    expect(groups).toHaveLength(1);
    expect(groups[0].realSlots).toHaveLength(2);
  });
});

// ─── filterToSelection ──────────────────────────────────────────────────────

describe("filterToSelection", () => {
  it("returns slots unchanged when there is no selection", () => {
    const slots = [slot({ id: "a", courseId: "c1", courseName: "Presidio" })];
    expect(filterToSelection(slots, [])).toBe(slots);
  });

  it("keeps a slot whose courseId matches a selected id", () => {
    const slots = [slot({ id: "a", courseId: "c1", courseName: "Presidio" })];
    expect(filterToSelection(slots, [{ id: "c1", name: "Presidio" }])).toHaveLength(1);
  });

  it("keeps a slot by normalized-name match even when the discovered id differs from the selected id", () => {
    // The exact scenario the guard exists for: the provider's discovered
    // course_id is not the same string as the mapped-row id the golfer
    // selected, but it's honestly the same course.
    const slots = [slot({ id: "a", courseId: "osm-99887", courseName: "Presidio Golf Course" })];
    const selection = [{ id: "presidio-uuid-1234", name: "Presidio Golf Course" }];
    expect(filterToSelection(slots, selection)).toHaveLength(1);
  });

  it("name match tolerates case/whitespace/punctuation differences", () => {
    const slots = [slot({ id: "a", courseId: "osm-1", courseName: "Presidio Golf Course" })];
    const selection = [{ id: "different-id", name: "  presidio   golf, course!! " }];
    expect(filterToSelection(slots, selection)).toHaveLength(1);
  });

  it("drops an unselected course (Forest Park) — bug #3 regression", () => {
    const slots = [
      slot({ id: "a", courseId: "forest-park", courseName: "Forest Park Golf Course", distanceMiles: 0.8 }),
    ];
    const selection = [
      { id: "clearview", name: "Clearview Park Golf Course" },
      { id: "silverlake", name: "Silver Lake Golf Course" },
    ];
    expect(filterToSelection(slots, selection)).toEqual([]);
  });

  it("a real miss (nothing matches the selection) empties the list — never substitutes", () => {
    const slots = [
      slot({ id: "a", courseId: "unrelated-1", courseName: "Random Public Course" }),
      slot({ id: "b", courseId: "unrelated-2", courseName: "Another Course", time: "", route: "call" }),
    ];
    const selection = [{ id: "clearview", name: "Clearview Park Golf Course" }];
    expect(filterToSelection(slots, selection)).toEqual([]);
  });

  it("partial selection match keeps only the matched course, no padding", () => {
    const slots = [
      slot({ id: "a", courseId: "clearview", courseName: "Clearview Park Golf Course" }),
      slot({ id: "b", courseId: "unrelated", courseName: "Random Public Course" }),
    ];
    const selection = [{ id: "clearview", name: "Clearview Park Golf Course" }, { id: "silverlake", name: "Silver Lake" }];
    const kept = filterToSelection(slots, selection);
    expect(kept).toHaveLength(1);
    expect(kept[0].courseId).toBe("clearview");
  });
});

// ─── slotOptionLabel ────────────────────────────────────────────────────────

describe("slotOptionLabel", () => {
  it("formats time, pluralized spots, and a known price", () => {
    expect(slotOptionLabel(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "06:10", players: 2, priceUsd: 24 })))
      .toBe("6:10 AM · 2 spots · $24");
  });

  it("singular 'spot' for one player", () => {
    expect(slotOptionLabel(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "06:10", players: 1, priceUsd: 24 })))
      .toBe("6:10 AM · 1 spot · $24");
  });

  it("omits the price segment entirely when priceUsd is null — never '$—'", () => {
    const label = slotOptionLabel(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "06:10", players: 2, priceUsd: null }));
    expect(label).toBe("6:10 AM · 2 spots");
    expect(label).not.toContain("$");
  });

  it("rounds a fractional price", () => {
    expect(slotOptionLabel(slot({ id: "a", courseId: "c1", courseName: "Presidio", time: "06:10", players: 2, priceUsd: 23.5 })))
      .toContain("$24");
  });
});

// ─── emptySelectionNote ─────────────────────────────────────────────────────

describe("emptySelectionNote", () => {
  it("names the picks that came up empty", () => {
    expect(emptySelectionNote(["Clearview", "Silver Lake", "Forest Hills", "Knickerbocker"])).toBe(
      "None of your picks — Clearview, Silver Lake, Forest Hills, Knickerbocker — had times in your windows. Widen a window, or add a course.",
    );
  });

  it("falls back to a generic honest miss when there is no selection at all", () => {
    expect(emptySelectionNote([])).toBe("Nothing open nearby. Try a wider window or radius.");
  });
});
