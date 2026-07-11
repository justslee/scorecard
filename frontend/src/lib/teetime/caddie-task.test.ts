// caddie-task.ts — proves apply/asks parity with the old private page.tsx
// applyParsed (specs/orb-s2-context-contract-teetime-plan.md §9).

import { describe, it, expect } from "vitest";
import { teeTimeTaskParse, teeTimeConfirmEcho, planTeeTimeApply } from "./caddie-task";
import { TeeTimePrefsParseResultSchema } from "@/lib/voice/schemas";
import type { TeeTimePrefsParseResultValidated } from "@/lib/voice/schemas";
import { parseTeeTimePrefsLocally } from "@/lib/voice/parseTeeTimePrefs";
import {
  applyParsedWindows,
  applyParsedCourses,
  applyPartySize,
  teeTimeAckLine,
  type VoicePrefWindow,
  type VoicePrefMember,
} from "@/lib/teetime/voice-prefs";
import { buildTeeTimeQueries } from "@/lib/teetime/query";
import type { CourseOption } from "@/lib/teetime/courses";

function parsedFixture(
  overrides: Partial<Parameters<typeof TeeTimePrefsParseResultSchema.parse>[0]>,
): TeeTimePrefsParseResultValidated {
  return TeeTimePrefsParseResultSchema.parse({ confidence: 0.8, ...overrides });
}

const WINDOWS: VoicePrefWindow[] = [
  { id: "w1", label: "Saturday", sub: "morning", start: "07:00", end: "11:00", date: "2026-07-11", selected: false },
];

const COURSES: CourseOption[] = [
  { id: "c1", name: "Presidio", muni: "SF", distance: 3.2, favorite: false, selected: false },
  { id: "c2", name: "Harding Park", muni: "SF", distance: 5.1, favorite: true, selected: true },
  { id: "c3", name: "Lincoln Park", muni: "SF", distance: 25.4, favorite: false, selected: false },
];

const GROUP: VoicePrefMember[] = [
  { id: "me", name: "You", hdcp: 12, init: "ME", confirmed: true, self: true },
];

describe("teeTimeTaskParse", () => {
  it("signal fixture: hasSignal true, confidence passthrough, payload === parsed", () => {
    const parsed = parseTeeTimePrefsLocally("Saturday morning, party of 4", {
      courses: COURSES.map((c) => c.name),
    });
    const p = teeTimeTaskParse("Saturday morning, party of 4", parsed);
    expect(p.hasSignal).toBe(true);
    expect(p.confidence).toBe(parsed.confidence);
    expect(p.payload).toBe(parsed);
  });

  it("no-signal fixture: hasSignal false, confidence 0.2", () => {
    const parsed = parseTeeTimePrefsLocally("hello there", { courses: [] });
    const p = teeTimeTaskParse("hello there", parsed);
    expect(p.hasSignal).toBe(false);
    expect(p.confidence).toBe(0.2);
  });
});

describe("teeTimeConfirmEcho format-lock", () => {
  it('"goes" shape: "Saturday morning — on it." → "Saturday morning"', () => {
    const parsed = parsedFixture({ windows: [{ day: "saturday", period: "morning" }] });
    expect(teeTimeAckLine(parsed)).toBe("Saturday morning — on it.");
    expect(teeTimeConfirmEcho(parsed)).toBe("Saturday morning");
  });

  it('"got it" shape: "Got it — party of 4." → "party of 4"', () => {
    const parsed = parsedFixture({ partySize: 4 });
    expect(teeTimeAckLine(parsed)).toBe("Got it — party of 4.");
    expect(teeTimeConfirmEcho(parsed)).toBe("party of 4");
  });

  it("null → fallback", () => {
    const parsed = parsedFixture({});
    expect(teeTimeAckLine(parsed)).toBeNull();
    expect(teeTimeConfirmEcho(parsed)).toBe("not much, honestly");
  });
});

describe("planTeeTimeApply ≡ old applyParsed", () => {
  it("windows merge = applyParsedWindows(current, parsed.windows)", () => {
    const parsed = parsedFixture({ windows: [{ day: "saturday", period: "morning" }] });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.windows).toEqual(applyParsedWindows(WINDOWS, parsed.windows));
    expect(plan.courses).toBeNull();
    expect(plan.dispatched).toBe(true); // windows.length > 0
  });

  it("course miss → courses:null + kept-your-picks line (miss note REPLACES the ack)", () => {
    const parsed = parsedFixture({ courseNames: ["Nonexistent Municipal"] });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.courses).toBeNull();
    expect(plan.line).toBe("Couldn’t find Nonexistent Municipal on your list — kept your picks.");
    expect(plan.dispatched).toBe(false);
  });

  it("course hit → selection replaced", () => {
    const parsed = parsedFixture({ courseNames: ["Presidio"] });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.courses).toEqual(applyParsedCourses(COURSES, ["Presidio"], false));
    expect(plan.line).toBe(teeTimeAckLine(parsed));
  });

  it("radius widening: a named course beyond maxMiles widens to min(50, ceil(farthest))", () => {
    const parsed = parsedFixture({ courseNames: ["Lincoln Park"] }); // distance 25.4, maxMiles 15
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.maxMiles).toBe(26); // Math.ceil(25.4)
  });

  it("explicit spoken miles overrides the widened radius", () => {
    const parsed = parsedFixture({ courseNames: ["Lincoln Park"], maxDistanceMiles: 5 });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.maxMiles).toBe(5); // explicit wins, not the widened 26
  });

  it("party resize via applyPartySize", () => {
    const parsed = parsedFixture({ partySize: 3 });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.group).toEqual(applyPartySize(GROUP, 3));
  });

  it("price set", () => {
    const parsed = parsedFixture({ maxPriceUsd: 80 });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.maxPriceUsd).toBe(80);
  });

  it('line = miss-note ?? ack ?? "Got it."', () => {
    const parsed = parsedFixture({ dispatch: true }); // no windows/courses/party/price — ack falls to "On it — going to look now."
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.line).toBe("On it — going to look now.");
  });

  it("dispatched true iff windows>0 or dispatch", () => {
    const dispatchOnly = parsedFixture({ dispatch: true, partySize: 2 });
    expect(planTeeTimeApply(dispatchOnly, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP }).dispatched).toBe(true);

    const neither = parsedFixture({ partySize: 2 });
    expect(planTeeTimeApply(neither, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP }).dispatched).toBe(false);
  });
});

describe("planTeeTimeApply — A0: unresolved named course stops the lie", () => {
  it("named-but-unresolved course → dispatched:false + honest ack naming it, EVEN with a window", () => {
    // The Marine-Park-from-Pittsburgh bug: a day/time was heard, which used to
    // arm the 1400ms dispatch and search the wrong city. It must not now.
    const parsed = parsedFixture({
      windows: [{ day: "saturday", period: "morning" }],
      unresolvedCourseNames: ["marine park"],
    });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.dispatched).toBe(false);
    expect(plan.line).toContain("Marine Park");
    // Not the window ack ("Saturday morning — on it.") — an honest "don't know".
    expect(plan.line.toLowerCase()).toContain("don");
    expect(plan.line).not.toContain("on it.");
  });

  it("dispatch confirmation cannot override an unresolved named course", () => {
    const parsed = parsedFixture({ dispatch: true, unresolvedCourseNames: ["marine park"] });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.dispatched).toBe(false);
    expect(plan.line).toContain("Marine Park");
  });

  it("multiple unresolved names read naturally", () => {
    const parsed = parsedFixture({ unresolvedCourseNames: ["marine park", "dyker beach"] });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.line).toContain("Marine Park and Dyker Beach");
    expect(plan.dispatched).toBe(false);
  });

  it("no unresolved name → dispatch behaves exactly as before", () => {
    const parsed = parsedFixture({ windows: [{ day: "saturday", period: "morning" }] });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });
    expect(plan.dispatched).toBe(true);
  });
});

describe("identical asks", () => {
  it("plan output fed through buildTeeTimeQueries matches the old direct-application path", () => {
    const transcript = "Saturday morning at Presidio, party of 4";
    const parsed = parseTeeTimePrefsLocally(transcript, { courses: COURSES.map((c) => c.name) });
    const plan = planTeeTimeApply(parsed, { windows: WINDOWS, courses: COURSES, maxMiles: 15, group: GROUP });

    // Old way: apply the same real libs directly (mirrors page.tsx's applyParsed).
    const oldWindows = parsed.windows.length > 0 ? applyParsedWindows(WINDOWS, parsed.windows) : WINDOWS;
    const oldCourses =
      parsed.courseNames.length > 0 || parsed.favoritesOnly
        ? applyParsedCourses(COURSES, parsed.courseNames, parsed.favoritesOnly)
        : COURSES;
    const oldGroup = parsed.partySize != null ? applyPartySize(GROUP, parsed.partySize) : GROUP;

    const queriesFromPlan = buildTeeTimeQueries({
      windows: (plan.windows ?? WINDOWS)
        .filter((w) => w.selected)
        .map((w) => ({ label: w.label, start: w.start, end: w.end, date: w.date })),
      courseIds: (plan.courses ?? COURSES).filter((c) => c.selected).map((c) => c.id),
      partySize: Math.max(1, (plan.group ?? GROUP).length),
      maxDistanceMiles: plan.maxMiles ?? 15,
      ...(plan.maxPriceUsd != null ? { maxPriceUsd: plan.maxPriceUsd } : {}),
    });

    const queriesFromOld = buildTeeTimeQueries({
      windows: oldWindows
        .filter((w) => w.selected)
        .map((w) => ({ label: w.label, start: w.start, end: w.end, date: w.date })),
      courseIds: oldCourses.filter((c) => c.selected).map((c) => c.id),
      partySize: Math.max(1, oldGroup.length),
      maxDistanceMiles: 15,
    });

    expect(queriesFromPlan).toEqual(queriesFromOld);
  });
});
