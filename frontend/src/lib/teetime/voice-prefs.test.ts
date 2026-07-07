/**
 * Unit tests for voice → prefs application on the /tee-time screen
 * (windows / courses / party size + the looper's acknowledgement line).
 */

import { describe, it, expect } from "vitest";
import {
  applyParsedWindows,
  applyParsedCourses,
  applyPartySize,
  teeTimeAckLine,
  type VoicePrefWindow,
  type VoicePrefMember,
} from "./voice-prefs";
import type { CourseOption } from "./courses";
import { TeeTimePrefsParseResultSchema } from "@/lib/voice/schemas";

const WINDOWS: VoicePrefWindow[] = [
  { id: "sat-am", label: "Saturday", sub: "early",  start: "06:30", end: "09:30", date: "2026-07-04", selected: true  },
  { id: "sat-pm", label: "Saturday", sub: "midday", start: "11:00", end: "14:00", date: "2026-07-04", selected: false },
  { id: "sun-am", label: "Sunday",   sub: "early",  start: "07:00", end: "10:00", date: "2026-07-05", selected: true  },
];

// Wed Jul 1 2026 → next Sat = 07-04, next Sun = 07-05, next Fri = 07-03.
const WED = new Date(2026, 6, 1, 10, 0);

const COURSES: CourseOption[] = [
  { id: "presidio", name: "Presidio Golf Course", muni: "SF", distance: 4.1,  favorite: true,  selected: true  },
  { id: "harding",  name: "TPC Harding Park",     muni: "SF", distance: 6.8,  favorite: true,  selected: true  },
  { id: "sharp",    name: "Sharp Park",           muni: "Pacifica", distance: 12.4, favorite: false, selected: false },
];

const SELF: VoicePrefMember = { id: "me", name: "You", hdcp: 8.2, init: "JL", confirmed: true, self: true };

/** Build a full parse result from a partial (schema fills the defaults). */
function parsed(p: Record<string, unknown>) {
  return TeeTimePrefsParseResultSchema.parse({ confidence: 0.8, ...p });
}

describe("applyParsedWindows", () => {
  it("selects the matching window and deselects the rest", () => {
    const next = applyParsedWindows(WINDOWS, [{ day: "sunday", period: "early" }]);
    expect(next.map((w) => w.selected)).toEqual([false, false, true]);
  });

  it("matches by overlap ('morning' covers the 06:30 early block)", () => {
    const next = applyParsedWindows(WINDOWS, [{ day: "saturday", period: "morning" }]);
    expect(next.find((w) => w.id === "sat-am")?.selected).toBe(true);
    expect(next.find((w) => w.id === "sun-am")?.selected).toBe(false);
  });

  it("a period-less day selects that day's first window", () => {
    const next = applyParsedWindows(WINDOWS, [{ day: "saturday", period: null }]);
    expect(next.find((w) => w.id === "sat-am")?.selected).toBe(true);
  });

  it("creates a window when nothing on the list fits", () => {
    const next = applyParsedWindows(WINDOWS, [{ day: "friday", period: "twilight" }]);
    const added = next.find((w) => w.id.startsWith("voice-friday-twilight"));
    expect(added).toMatchObject({ label: "Friday", start: "16:00", end: "19:00", selected: true });
    expect(next.filter((w) => w.selected)).toHaveLength(1);
  });

  it("leaves the list untouched when nothing was spoken", () => {
    expect(applyParsedWindows(WINDOWS, [])).toBe(WINDOWS);
  });

  it("stamps a new window with the real ISO date for its spoken day (fixed `from`)", () => {
    const next = applyParsedWindows(WINDOWS, [{ day: "friday", period: "twilight" }], WED);
    expect(next.find((w) => w.id.startsWith("voice-friday-twilight"))?.date).toBe("2026-07-03");
  });

  it("a matched window keeps its EXISTING date — the spoken day selected it, didn't move it", () => {
    const next = applyParsedWindows(WINDOWS, [{ day: "sunday", period: "early" }], WED);
    expect(next.find((w) => w.id === "sun-am")?.date).toBe("2026-07-05");
  });
});

describe("applyParsedCourses", () => {
  it("named courses replace the selection", () => {
    const next = applyParsedCourses(COURSES, ["Sharp Park"], false);
    expect(next.map((c) => c.selected)).toEqual([false, false, true]);
  });

  it("'favorites only' selects exactly the favorites", () => {
    const next = applyParsedCourses(COURSES, [], true);
    expect(next.map((c) => c.selected)).toEqual([true, true, false]);
  });

  it("untouched when nothing was spoken", () => {
    expect(applyParsedCourses(COURSES, [], false)).toBe(COURSES);
  });
});

describe("applyPartySize", () => {
  it("pads with guest placeholders up to the spoken size", () => {
    const next = applyPartySize([SELF], 4);
    expect(next).toHaveLength(4);
    expect(next[0]).toBe(SELF);
    expect(next.slice(1).every((m) => m.id.startsWith("guest-"))).toBe(true);
  });

  it("never removes real people, only guests", () => {
    const jack: VoicePrefMember = { id: "jack", name: "Jack H.", hdcp: 11.4, init: "JH", confirmed: false, self: false };
    const withGuests = applyPartySize([SELF, jack], 4);
    expect(withGuests).toHaveLength(4);
    const shrunk = applyPartySize(withGuests, 1);
    expect(shrunk).toEqual([SELF, jack]);
  });
});

describe("teeTimeAckLine", () => {
  it("reads back a full request calmly", () => {
    const line = teeTimeAckLine(parsed({
      windows: [{ day: "saturday", period: "morning" }],
      courseNames: ["Presidio Golf Course"],
      partySize: 4,
      maxPriceUsd: 80,
    }));
    expect(line).toBe("Saturday morning, at Presidio, party of 4, under $80 — on it.");
  });

  it("acknowledges a partial update without dispatching language", () => {
    const line = teeTimeAckLine(parsed({ favoritesOnly: true, maxDistanceMiles: 10 }));
    expect(line).toBe("Got it — your favorites only, within 10 miles.");
  });

  it("a bare go-ahead gets a bare 'on it'", () => {
    expect(teeTimeAckLine(parsed({ dispatch: true }))).toBe("On it — going to look now.");
  });

  it("returns null when nothing was recognized", () => {
    expect(teeTimeAckLine(parsed({}))).toBeNull();
  });
});
