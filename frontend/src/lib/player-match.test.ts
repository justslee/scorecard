// Vitest unit tests for player-match.ts
// Run with: cd frontend && npx vitest run src/lib/player-match.test.ts

import { describe, it, expect } from "vitest";
import type { SavedPlayer } from "@/lib/types";
import { soundex, matchPlayerName, matchPlayerNames } from "@/lib/player-match";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal SavedPlayer. */
function sp(id: string, name: string, nickname?: string, handicap?: number): SavedPlayer {
  return {
    id,
    name,
    nickname,
    handicap,
    roundsPlayed: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// soundex
// ---------------------------------------------------------------------------

describe("soundex", () => {
  it("Dipak → D120", () => expect(soundex("Dipak")).toBe("D120"));
  it("Deepak → D120 (same key as Dipak — owner bug case)", () => expect(soundex("Deepak")).toBe("D120"));
  it("Robert → R163", () => expect(soundex("Robert")).toBe("R163"));
  it("Rupert → R163 (same key as Robert)", () => expect(soundex("Rupert")).toBe("R163"));
  it("empty string → 0000", () => expect(soundex("")).toBe("0000"));
  it("single letter → letter padded with zeros", () => expect(soundex("A")).toBe("A000"));
  it("is case-insensitive", () => expect(soundex("dipak")).toBe(soundex("DIPAK")));
  it("non-alpha characters are stripped before encoding", () => {
    expect(soundex("O'Brien")).toBe(soundex("OBrien"));
  });
});

// ---------------------------------------------------------------------------
// matchPlayerName — core owner-bug scenario
// ---------------------------------------------------------------------------

describe("matchPlayerName — owner bug (Dipak/Deepak)", () => {
  const roster = [sp("p1", "Deepak")];

  it("spoken 'Dipak' resolves to saved 'Deepak' (phonetic path)", () => {
    const r = matchPlayerName("Dipak", roster);
    expect(r.player?.id).toBe("p1");
    expect(r.via).toBe("phonetic");
    expect(r.score).toBeGreaterThanOrEqual(0.72);
  });

  it("exact match 'Deepak' → score 1.0, via exact", () => {
    const r = matchPlayerName("Deepak", roster);
    expect(r.player?.id).toBe("p1");
    expect(r.via).toBe("exact");
    expect(r.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// matchPlayerName — general cases
// ---------------------------------------------------------------------------

describe("matchPlayerName — general", () => {
  const roster = [
    sp("p1", "Deepak"),
    sp("p2", "Matthew"),
    sp("p3", "Justin", "JB"),
    sp("p4", "Dan"),
  ];

  it("clearly different name does not match (Xander → null)", () => {
    const r = matchPlayerName("Xander", roster);
    expect(r.player).toBeNull();
    expect(r.via).toBe("none");
  });

  it("'Matthew' vs 'Dan' slot — no cross-match confusion", () => {
    // 'Matthew' and 'Dan' are very different; spoken 'Matthew' should match p2
    const r = matchPlayerName("Matthew", roster);
    expect(r.player?.id).toBe("p2");
  });

  it("nickname match: spoken 'JB' resolves to Justin via nickname", () => {
    const r = matchPlayerName("JB", roster);
    expect(r.player?.id).toBe("p3");
    // The nickname matched exactly, so via should be exact or fuzzy ≥ threshold
    expect(r.score).toBeGreaterThanOrEqual(0.72);
  });

  it("empty roster → null", () => {
    const r = matchPlayerName("Deepak", []);
    expect(r.player).toBeNull();
    expect(r.via).toBe("none");
  });

  it("empty spoken name → null", () => {
    const r = matchPlayerName("", roster);
    expect(r.player).toBeNull();
    expect(r.via).toBe("none");
  });

  it("borderline below threshold → null (free-text fallback)", () => {
    // 'Xan' is only 3 chars; nothing in roster is close enough.
    const r = matchPlayerName("Xan", roster);
    expect(r.player).toBeNull();
    expect(r.via).toBe("none");
  });

  it("lowering minScore to 0 allows weak matches through", () => {
    // With threshold 0, even a low-similarity name should match *something*.
    const r = matchPlayerName("Matt", roster, { minScore: 0 });
    expect(r.player).not.toBeNull();
  });

  it("close fuzzy variant: 'Mathew' (one t) matches Matthew", () => {
    const r = matchPlayerName("Mathew", roster);
    expect(r.player?.id).toBe("p2");
    expect(r.score).toBeGreaterThanOrEqual(0.72);
  });

  it("handicap is preserved from saved player", () => {
    const withHcp = [sp("h1", "Deepak", undefined, 14)];
    const r = matchPlayerName("Dipak", withHcp);
    expect(r.player?.handicap).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// matchPlayerNames — multi-slot deduplication
// ---------------------------------------------------------------------------

describe("matchPlayerNames — deduplication", () => {
  const roster = [
    sp("p1", "Deepak"),
    sp("p2", "Justin"),
  ];

  it("each slot links to a distinct saved player", () => {
    const results = matchPlayerNames(["Dipak", "Justin"], roster);
    expect(results[0].player?.id).toBe("p1"); // Dipak → Deepak (phonetic)
    expect(results[1].player?.id).toBe("p2"); // Justin → Justin (exact)
  });

  it("same spoken name twice: second slot demoted to null (no double-link)", () => {
    const results = matchPlayerNames(["Deepak", "Deepak"], roster);
    expect(results[0].player?.id).toBe("p1");
    expect(results[1].player).toBeNull();
    expect(results[1].via).toBe("none");
  });

  it("phonetic duplicate (Dipak + Deepak): second slot demoted to null", () => {
    const results = matchPlayerNames(["Dipak", "Deepak"], roster);
    expect(results[0].player?.id).toBe("p1");
    expect(results[1].player).toBeNull(); // same id already claimed by slot 0
  });

  it("unmatched name preserves original spoken name in result", () => {
    const results = matchPlayerNames(["Xander"], roster);
    expect(results[0].name).toBe("Xander");
    expect(results[0].player).toBeNull();
  });

  it("empty spoken list returns empty array", () => {
    expect(matchPlayerNames([], roster)).toHaveLength(0);
  });
});
