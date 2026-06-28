import { describe, expect, it } from "vitest";
import type { Round } from "@/lib/types";
import { getOwnerPlayerId } from "./round-owner";

// Minimal Round factory — only the fields getOwnerPlayerId reads matter.
function makeRound(partial: Partial<Round>): Round {
  return {
    id: "r1",
    courseId: "c1",
    courseName: "Test",
    date: "2026-06-28",
    players: [],
    scores: [],
    holes: [],
    status: "completed",
    createdAt: "",
    updatedAt: "",
    ...partial,
  } as Round;
}

describe("getOwnerPlayerId", () => {
  it("returns the explicit ownerPlayerId when present", () => {
    const round = makeRound({
      players: [
        { id: "p-other", name: "Other" },
        { id: "p-owner", name: "Owner" },
      ],
      ownerPlayerId: "p-owner", // owner is NOT first-listed
    });
    expect(getOwnerPlayerId(round)).toBe("p-owner");
  });

  it("falls back to the first player for legacy rounds without ownerPlayerId", () => {
    const round = makeRound({
      players: [
        { id: "p-first", name: "First" },
        { id: "p-second", name: "Second" },
      ],
    });
    expect(getOwnerPlayerId(round)).toBe("p-first");
  });

  it("returns undefined when the round has no players", () => {
    expect(getOwnerPlayerId(makeRound({ players: [] }))).toBeUndefined();
  });

  it("prefers ownerPlayerId even when it equals the first player", () => {
    const round = makeRound({
      players: [{ id: "p1", name: "Solo" }],
      ownerPlayerId: "p1",
    });
    expect(getOwnerPlayerId(round)).toBe("p1");
  });
});
