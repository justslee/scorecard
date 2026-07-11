// course-clarify.ts — the A3 clarify-turn matcher + router
// (specs/course-selection-a3-plan.md). Pure decision-table tests: no network,
// no page state.

import { describe, it, expect } from "vitest";
import { matchClarifyReply, routeClarifyReply, type PendingCourseClarify } from "./course-clarify";
import type { ResolvedCandidate } from "./course-resolve";
import { TeeTimePrefsParseResultSchema } from "@/lib/voice/schemas";
import type { TeeTimePrefsParseResultValidated } from "@/lib/voice/schemas";

function parsedFixture(
  overrides: Partial<Parameters<typeof TeeTimePrefsParseResultSchema.parse>[0]> = {},
): TeeTimePrefsParseResultValidated {
  return TeeTimePrefsParseResultSchema.parse({ confidence: 0.2, ...overrides });
}

const BROOKLYN = { lat: 40.6, lng: -73.9 };
const NJ = { lat: 40.42, lng: -74.36 };

// The plan's Step 0 fixture — two REAL "Marine Park" facilities in different
// cities, the exact shape resolveSpokenCourse's "ambiguous" branch produces.
const CANDIDATES: ResolvedCandidate[] = [
  {
    id: "mp-bk",
    name: "Marine Park Golf Course",
    localityLabel: "Brooklyn, NY",
    center: BROOKLYN,
    address: "2880 Flatbush Ave, Brooklyn, NY",
  },
  {
    id: "mp-nj",
    name: "Marine Park Golf Club",
    localityLabel: "Old Bridge, NJ",
    center: NJ,
    address: "1 Golf Club Dr, Old Bridge, NJ",
  },
];

describe("matchClarifyReply — ordinal stage", () => {
  it('"the first one" → index 0', () => {
    expect(matchClarifyReply("the first one", CANDIDATES)).toEqual({ kind: "picked", candidate: CANDIDATES[0] });
  });
  it('"second" → index 1', () => {
    expect(matchClarifyReply("second", CANDIDATES)).toEqual({ kind: "picked", candidate: CANDIDATES[1] });
  });
  it('"number two" → index 1', () => {
    expect(matchClarifyReply("number two", CANDIDATES)).toEqual({ kind: "picked", candidate: CANDIDATES[1] });
  });
  it('"the last one" → last candidate', () => {
    expect(matchClarifyReply("the last one", CANDIDATES)).toEqual({ kind: "picked", candidate: CANDIDATES[1] });
  });
  it('"the fifth one" with only 2 candidates → none (unrecognized/out-of-range)', () => {
    expect(matchClarifyReply("the fifth one", CANDIDATES)).toEqual({ kind: "none" });
  });
});

describe("matchClarifyReply — locality-token stage", () => {
  it('"the Brooklyn one" → picks Brooklyn', () => {
    expect(matchClarifyReply("the brooklyn one", CANDIDATES)).toEqual({ kind: "picked", candidate: CANDIDATES[0] });
  });
  it('"Marine Park in Brooklyn" → picks Brooklyn (locality stage wins before the name stage would go ambiguous)', () => {
    expect(matchClarifyReply("marine park in brooklyn", CANDIDATES)).toEqual({
      kind: "picked",
      candidate: CANDIDATES[0],
    });
  });
  it('"the New Jersey one" → full state name maps to the "nj" token', () => {
    expect(matchClarifyReply("the new jersey one", CANDIDATES)).toEqual({ kind: "picked", candidate: CANDIDATES[1] });
  });
  it('a token hitting BOTH candidates ("the NY one" when both are NY) → ambiguous', () => {
    const bothNY: ResolvedCandidate[] = [
      { id: "q", name: "Queens Muni Golf Course", localityLabel: "Queens, NY", center: BROOKLYN },
      { id: "si", name: "Staten Island Golf Course", localityLabel: "Staten Island, NY", center: BROOKLYN },
    ];
    expect(matchClarifyReply("the ny one", bothNY)).toEqual({ kind: "ambiguous" });
  });
});

describe("matchClarifyReply — name-token stage", () => {
  it('a bare-name repeat matching 2+ candidates identically → ambiguous (re-ask, not re-resolve)', () => {
    // "golf"/"course"/"club" are generic stopwords — both candidates reduce
    // to the SAME identifying tokens ["marine","park"], so a bare repeat of
    // the shared name can't disambiguate them.
    expect(matchClarifyReply("marine park", CANDIDATES)).toEqual({ kind: "ambiguous" });
  });
  it("a reply matching exactly one candidate's DISTINCT name → picked", () => {
    const withDyker: ResolvedCandidate[] = [
      ...CANDIDATES,
      { id: "dyker", name: "Dyker Beach Golf Course", localityLabel: "Bay Ridge, NY", center: BROOKLYN },
    ];
    expect(matchClarifyReply("dyker beach", withDyker)).toEqual({ kind: "picked", candidate: withDyker[2] });
  });
});

describe("matchClarifyReply — defensive", () => {
  it("empty transcript → none", () => {
    expect(matchClarifyReply("", CANDIDATES)).toEqual({ kind: "none" });
  });
  it("empty candidates → none", () => {
    expect(matchClarifyReply("the first one", [])).toEqual({ kind: "none" });
  });
  it("no stage matches → none", () => {
    expect(matchClarifyReply("the purple one", CANDIDATES)).toEqual({ kind: "none" });
  });
});

describe("routeClarifyReply", () => {
  const pending: PendingCourseClarify = { name: "marine park", candidates: CANDIDATES, armed: true, attempts: 0 };

  it("no pending → null (falls through to converse exactly as today)", () => {
    expect(routeClarifyReply("whatever", parsedFixture({}), null)).toBeNull();
  });

  it("a pick → the clarify lane, even when the utterance ALSO carries other signal", () => {
    const parsed = parsedFixture({ windows: [{ day: "saturday", period: "morning" }] });
    const route = routeClarifyReply("the brooklyn one", parsed, pending);
    expect(route).not.toBeNull();
    expect(route!.match).toEqual({ kind: "picked", candidate: CANDIDATES[0] });
    expect(route!.pending).toBe(pending);
  });

  it('a bare "yes"/"go ahead" (dispatch-only, no other signal) stays in the clarify lane — dispatch alone is NOT a topic change', () => {
    const parsed = parsedFixture({ dispatch: true });
    const route = routeClarifyReply("yeah go ahead", parsed, pending);
    expect(route).not.toBeNull();
    expect(route!.match).toEqual({ kind: "none" });
  });

  it("a real non-dispatch signal (new windows) with no pick → null: topic change, pending yields to the normal turn", () => {
    const parsed = parsedFixture({ windows: [{ day: "sunday", period: "afternoon" }] });
    const route = routeClarifyReply("actually sunday afternoon anywhere", parsed, pending);
    expect(route).toBeNull();
  });

  it("a DIFFERENT new unresolved course name with no pick → null: normal A2 turn, not a re-ask", () => {
    const parsed = parsedFixture({ unresolvedCourseNames: ["dyker beach"] });
    const route = routeClarifyReply("dyker beach", parsed, pending);
    expect(route).toBeNull();
  });

  it("an unrecognized reply with NO other signal → the clarify lane with a none match (re-ask territory)", () => {
    const parsed = parsedFixture({});
    const route = routeClarifyReply("the purple one", parsed, pending);
    expect(route).not.toBeNull();
    expect(route!.match).toEqual({ kind: "none" });
  });
});
