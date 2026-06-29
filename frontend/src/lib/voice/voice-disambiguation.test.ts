/**
 * Unit tests for voice name disambiguation.
 *
 * Two mechanisms resolve spoken names against real data:
 *
 *   1. Realtime path — `matchPlayerName` / `matchPlayerNames` from player-match.ts
 *      (used in page.tsx handleVoiceSetup after the OpenAI tool call fires).
 *      Combines Levenshtein similarity WITH Soundex phonetic keys, so it handles
 *      phonetically-similar mis-transcriptions like "Deepak" → "Dipak".
 *
 *   2. Transcript path — `fuzzyBestMatch` from voice/utils.ts
 *      (used in parseVoiceTranscriptLocally with the new `known` option).
 *      Levenshtein-only: handles single-character drift and containment cases
 *      above the threshold; does NOT resolve phonetic pairs like Dipak/Deepak
 *      because their edit distance (2) vs length (5-6) scores ~0.67 < 0.76.
 *
 *   3. Course disambiguation — `fuzzyBestMatch` at threshold 0.74
 *      (used in both page.tsx and parseVoiceTranscriptLocally).
 *      "Valley Links" vs "Bally Links": 2 edits / 12 max → sim ≈ 0.83 ✓
 *
 * All tests are deterministic — no LLM, no network, no I/O.
 */

import { describe, it, expect } from "vitest";
import { parseVoiceTranscriptLocally } from "./parseVoiceTranscript";
import { fuzzyBestMatch } from "./utils";
import { matchPlayerName, matchPlayerNames } from "../player-match";
import type { SavedPlayer } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal SavedPlayer for test roster construction (required fields only). */
function makePlayer(name: string, nickname?: string): SavedPlayer {
  return {
    id: name.toLowerCase(),
    name,
    nickname,
    roundsPlayed: 0,
    createdAt: "",
    updatedAt: "",
  };
}

// ---------------------------------------------------------------------------
// 1. Realtime path: matchPlayerName (Soundex + fuzzy) — the Dipak/Deepak fix
// ---------------------------------------------------------------------------

describe("matchPlayerName — phonetic disambiguation (realtime path)", () => {
  const roster: SavedPlayer[] = [
    makePlayer("Dipak"),
    makePlayer("Bob"),
    makePlayer("Sam"),
  ];

  it("'Deepak' (spoken/transcribed) resolves to saved 'Dipak' via Soundex", () => {
    // Both have Soundex key D120; sim("deepak","dipak") = 0.67 ≥ PHONETIC_SIM_FLOOR(0.5)
    const { player, via } = matchPlayerName("Deepak", roster);
    expect(player?.name).toBe("Dipak");
    expect(via).toBe("phonetic");
  });

  it("'Dipak' (exact) resolves to saved 'Dipak'", () => {
    const { player, via } = matchPlayerName("Dipak", roster);
    expect(player?.name).toBe("Dipak");
    expect(via).toBe("exact");
  });

  it("genuinely new name ('Xyzzy') with no roster match → player null", () => {
    const { player } = matchPlayerName("Xyzzy", roster);
    expect(player).toBeNull();
  });

  it("empty roster → no match", () => {
    const { player } = matchPlayerName("Deepak", []);
    expect(player).toBeNull();
  });
});

describe("matchPlayerNames — multi-slot deduplication (realtime path)", () => {
  it("resolves ['Deepak', 'Bob'] against roster with 'Dipak'/'Bob'", () => {
    const roster: SavedPlayer[] = [makePlayer("Dipak"), makePlayer("Bob")];
    const results = matchPlayerNames(["Deepak", "Bob"], roster);

    // Deepak → Dipak (phonetic)
    expect(results[0]?.player?.name).toBe("Dipak");
    // Bob → Bob (exact)
    expect(results[1]?.player?.name).toBe("Bob");
  });
});

// ---------------------------------------------------------------------------
// 2. Course disambiguation: fuzzyBestMatch at 0.74
//    (used in page.tsx and parseVoiceTranscriptLocally)
// ---------------------------------------------------------------------------

describe("fuzzyBestMatch — course disambiguation (threshold 0.74)", () => {
  it("Bally→Valley bug: AI says 'Valley Links', saved course is 'Bally Links' → corrected", () => {
    // levenshtein("valley links","bally links") = 2, maxLen = 12, sim ≈ 0.833 > 0.74
    const { match, score } = fuzzyBestMatch("Valley Links", ["Bally Links"], 0.74);
    expect(match).toBe("Bally Links");
    expect(score).toBeGreaterThanOrEqual(0.74);
  });

  it("exact course match → returns the saved name", () => {
    const { match, score } = fuzzyBestMatch(
      "Valley Links",
      ["Valley Links", "Bally Links"],
      0.74,
    );
    expect(match).toBe("Valley Links");
    expect(score).toBe(1);
  });

  it("empty known courses → no match forced (null)", () => {
    const { match } = fuzzyBestMatch("Valley Links", [], 0.74);
    expect(match).toBeNull();
  });

  it("genuinely different course (far Levenshtein) → no match forced", () => {
    // "Pebble Beach" vs "Augusta National" — very different
    const { match } = fuzzyBestMatch(
      "Pebble Beach",
      ["Augusta National", "Winged Foot"],
      0.74,
    );
    expect(match).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. fuzzyBestMatch player threshold 0.76 — what it CAN/CANNOT do
//    (for context: pipeline.ts uses this for the tournament/game path)
// ---------------------------------------------------------------------------

describe("fuzzyBestMatch — player disambiguation (threshold 0.76)", () => {
  const known = ["Justin", "Bobby", "Samuel"];

  it("exact match → score 1", () => {
    expect(fuzzyBestMatch("Justin", known, 0.76).match).toBe("Justin");
    expect(fuzzyBestMatch("Justin", known, 0.76).score).toBe(1);
  });

  it("prefix containment match: 'Justine' → 'Justin' (normalizeName 'justine'.startsWith('justin') → sim 0.92)", () => {
    // normalizeName("Justine") = "justine"; "justine".startsWith("justin") = true → sim = 0.92
    expect(fuzzyBestMatch("Justine", known, 0.76).match).toBe("Justin");
  });

  it("1-edit close match above threshold: 'Justiin' → 'Justin'", () => {
    expect(fuzzyBestMatch("Justiin", known, 0.76).match).toBe("Justin");
  });

  it("Deepak→Dipak: edit-distance (~0.67) is BELOW 0.76 — NOT matched by fuzzyBestMatch alone", () => {
    // This is expected: the realtime path handles it via matchPlayerName (phonetic).
    // fuzzyBestMatch is edit-distance only; for phonetic pairs use player-match.ts.
    const { match } = fuzzyBestMatch("Deepak", ["Dipak", "Bobby"], 0.76);
    expect(match).toBeNull(); // correct: below threshold, no forced match
  });

  it("empty roster → null", () => {
    expect(fuzzyBestMatch("Justin", [], 0.76).match).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. parseVoiceTranscriptLocally — known context integration
// ---------------------------------------------------------------------------

describe("parseVoiceTranscriptLocally — player disambiguation via known context", () => {
  // Note: names ≤ 3 chars are uppercased (e.g. "Jon" → "JON") by the extractor.
  // Use names > 3 chars for these integration tests so casing doesn't mask results.

  it("'Justine' resolves to roster 'Justin' (prefix containment, sim 0.92 > 0.76)", () => {
    const result = parseVoiceTranscriptLocally(
      "skins with Justine and Bobby",
      { known: { players: ["Justin", "Bobby"] } },
    );
    expect(result.type).toBe("game");
    if (result.type === "game") {
      expect(result.game.playerNames).toContain("Justin");
      expect(result.game.playerNames).not.toContain("Justine");
    }
  });

  it("empty known.players → behaviour unchanged ('Justine' stays 'Justine')", () => {
    const result = parseVoiceTranscriptLocally(
      "skins with Justine and Bobby",
      { known: { players: [] } },
    );
    if (result.type === "game") {
      expect(result.game.playerNames).toContain("Justine");
    }
  });

  it("no known context → behaviour unchanged (regression guard)", () => {
    const result = parseVoiceTranscriptLocally("skins with Justine and Bobby");
    if (result.type === "game") {
      expect(result.game.playerNames).toContain("Justine");
    }
  });

  it("genuinely new name not in roster → not forced to nearest entry", () => {
    // "Xyzzy" has no close match in ["Justin","Bobby"] — must stay "Xyzzy"
    const result = parseVoiceTranscriptLocally(
      "skins with Xyzzy and Bobby",
      { known: { players: ["Justin", "Bobby"] } },
    );
    if (result.type === "game") {
      expect(result.game.playerNames).toContain("Xyzzy");
    }
  });
});

describe("parseVoiceTranscriptLocally — course disambiguation via known context", () => {
  it("tournament 'at Valley Links' resolves to saved 'Bally Links'", () => {
    // Use 'at' (not 'playing at') so the regex captures 'Valley Links' cleanly.
    // levenshtein("valley links","bally links") = 2, sim ≈ 0.83 > 0.74 → match
    const result = parseVoiceTranscriptLocally(
      "3-round tournament at Valley Links",
      { known: { courses: ["Bally Links"] } },
    );
    expect(result.type).toBe("tournament");
    if (result.type === "tournament") {
      expect(result.tournament.courses).toContain("Bally Links");
      expect(result.tournament.courses).not.toContain("Valley Links");
    }
  });

  it("tournament: empty known.courses → course name extracted as-is", () => {
    const result = parseVoiceTranscriptLocally(
      "3-round tournament at Valley Links",
      { known: { courses: [] } },
    );
    if (result.type === "tournament") {
      expect(result.tournament.courses).toContain("Valley Links");
    }
  });

  it("tournament: no known context → unchanged (regression guard)", () => {
    const result = parseVoiceTranscriptLocally("3-round tournament at Pebble Beach");
    if (result.type === "tournament") {
      expect(result.tournament.courses).toContain("Pebble Beach");
    }
  });
});
