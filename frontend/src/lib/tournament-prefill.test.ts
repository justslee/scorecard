// tournament-prefill.ts — pure parse→prefill mapping for /tournament/new's
// caddie-orb task registration (specs/omnipresent-caddie-orb-plan.md §4, S3).

import { describe, it, expect } from "vitest";
import {
  tournamentTaskParse,
  tournamentConfirmEcho,
  tournamentPrefillFromParse,
} from "./tournament-prefill";
import type { VoiceParseResultValidated } from "@/lib/voice/schemas";
import { parseVoiceTranscript } from "@/lib/voice/pipeline";
import { TASK_CONFIDENCE_FLOOR } from "@/lib/caddie-context";

const SAVED = [
  { id: "p1", name: "Justin" },
  { id: "p2", name: "Jack" },
  { id: "p3", name: "Mike" },
];

/** Builds a validated-shaped tournament result WITHOUT going through
 *  zod .parse() — lets tests exercise inputs the schema itself would reject
 *  (e.g. numRounds: 0) to prove the prefill mapper defensively clamps rather
 *  than trusting the upstream contract blindly. */
function tournamentResult(
  overrides: Partial<NonNullable<VoiceParseResultValidated["tournament"]>> = {},
  confidence = 0.6,
): VoiceParseResultValidated {
  return {
    type: "tournament",
    tournament: {
      name: "Tournament",
      numRounds: 1,
      courses: [],
      playerNames: [],
      ...overrides,
    },
    confidence,
  };
}

function gameResult(confidence = 0.6): VoiceParseResultValidated {
  return {
    type: "game",
    game: {
      format: "skins",
      name: "Skins",
      playerNames: ["Justin", "Jack"],
      settings: {},
    },
    confidence,
  };
}

describe("tournamentTaskParse", () => {
  it("tournament-typed result: hasSignal true, confidence passthrough, payload === result", () => {
    const result = tournamentResult({ numRounds: 3 }, 0.6);
    const p = tournamentTaskParse("three round tournament", result);
    expect(p.hasSignal).toBe(true);
    expect(p.confidence).toBe(0.6);
    expect(p.payload).toBe(result);
  });

  it("game-typed result: hasSignal false — never throws, never misfires a tournament", () => {
    const result = gameResult();
    const p = tournamentTaskParse("skins with Justin and Jack", result);
    expect(p.hasSignal).toBe(false);
  });

  it("tournament type but no tournament payload: hasSignal false", () => {
    const result = { type: "tournament", confidence: 0.5 } as VoiceParseResultValidated;
    const p = tournamentTaskParse("huh", result);
    expect(p.hasSignal).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// End-to-end dispatch-gate guard (cycle 84 orb-wiring audit).
//
// The host (CaddieOrbSheet) only runs a task's apply() when
// `hasSignal && confidence >= TASK_CONFIDENCE_FLOOR`; below the floor it shows
// the "here's what I got — say it again to correct" confirm line and NEVER
// fills the form. The tournament page wires `parseVoiceTranscript` (pipeline,
// offline local path in tests) → `tournamentTaskParse`. That local path emits
// exactly `confidence: 0.6`, which sits ON the 0.6 floor — it passes only
// because the gate is a strict `<`. Nothing pinned that razor-thin
// relationship, so a floor bump (0.6→0.65) or a drop in the local tournament
// confidence would SILENTLY route every spoken tournament setup into the
// confirm-gate — voice tournament creation would look "broken" with zero test
// failures. This locks the invariant end-to-end.
describe("tournament dispatch gate — real utterances clear the confidence floor", () => {
  const UTTERANCES = [
    "set up a tournament 2 rounds with Justin, Jack, Mike",
    "create tournament 3 rounds players: Justin, Jack",
    "tournament 1 day players Justin, Mike",
    "start a tournament 4 days players: justin, jack, mike",
  ];

  for (const utterance of UTTERANCES) {
    it(`"${utterance}" → hasSignal and confidence ≥ the gate floor (apply is never silently blocked)`, async () => {
      // Offline, deterministic: no `llm` option ⇒ pipeline's local basic parse.
      const result = await parseVoiceTranscript({
        transcript: utterance,
        known: { players: SAVED.map((p) => p.name) },
      });
      const parse = tournamentTaskParse(utterance, result);

      expect(parse.hasSignal).toBe(true);
      // The exact host gate (CaddieOrbSheet.tsx): confidence < FLOOR → confirm,
      // no apply. Prove these clear it so the form actually fills.
      expect(parse.confidence).toBeGreaterThanOrEqual(TASK_CONFIDENCE_FLOOR);
    });
  }
});

describe("tournamentConfirmEcho", () => {
  it("names players when present", () => {
    const result = tournamentResult({ numRounds: 3, playerNames: ["Justin", "Sam"] });
    expect(tournamentConfirmEcho(result)).toBe("a 3-round tournament with Justin, Sam");
  });

  it("omits players when absent", () => {
    const result = tournamentResult({ numRounds: 2, playerNames: [] });
    expect(tournamentConfirmEcho(result)).toBe("a 2-round tournament");
  });

  it("game-typed result -> not much, honestly", () => {
    expect(tournamentConfirmEcho(gameResult())).toBe("not much, honestly");
  });
});

describe("tournamentPrefillFromParse — name", () => {
  it("trims and passes through a real name", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ name: "  Club Championship  " }),
      SAVED,
      [],
    );
    expect(plan.name).toBe("Club Championship");
  });

  it("empty/whitespace name -> null (leave the form untouched)", () => {
    const plan = tournamentPrefillFromParse(tournamentResult({ name: "   " }), SAVED, []);
    expect(plan.name).toBeNull();
  });

  it("no tournament payload at all -> null name, honest ack, no crash", () => {
    const plan = tournamentPrefillFromParse({ type: "game", confidence: 0.4 }, SAVED, []);
    expect(plan.name).toBeNull();
    expect(plan.ackLine).toMatch(/didn.t catch/i);
  });

  it('parser sentinel "Tournament" -> null name (never a real name), and the ack does not quote it', () => {
    // The offline no-LLM parser always emits this literal sentinel when it
    // heard no actual name (lib/voice/pipeline.ts parseVoiceLocalBasic) — it
    // is never a real transcription, so treating it as a name would clobber
    // the form's own placeholder/user-typed value with something the golfer
    // never said.
    const plan = tournamentPrefillFromParse(
      tournamentResult({ name: "Tournament", numRounds: 2, playerNames: ["Justin", "Sam"] }),
      SAVED,
      [],
    );
    expect(plan.name).toBeNull();
    expect(plan.ackLine).not.toMatch(/["“]Tournament["”]/);
    expect(plan.ackLine).toMatch(/2 rounds/);
  });

  it('parser sentinel is case/whitespace-insensitive ("  tournament  ") -> null name', () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ name: "  tournament  " }),
      SAVED,
      [],
    );
    expect(plan.name).toBeNull();
  });

  it("a genuinely different name (e.g. a future LLM-extracted name) still flows through and is quoted", () => {
    const plan = tournamentPrefillFromParse(tournamentResult({ name: "Ryder Cup" }), SAVED, []);
    expect(plan.name).toBe("Ryder Cup");
    expect(plan.ackLine).toMatch(/Ryder Cup/);
  });
});

describe("tournamentPrefillFromParse — numRounds clamp", () => {
  it("0 clamps up to 1 (defensive — schema wouldn't allow 0, but never trust blindly) — note says minimum, not max", () => {
    const plan = tournamentPrefillFromParse(tournamentResult({ numRounds: 0 }), SAVED, []);
    expect(plan.numRounds).toBe(1);
    expect(plan.numRoundsRequested).toBe(0);
    expect(plan.numRoundsClamped).toBe(true);
    expect(plan.notes.some((n) => /set to 1 \(minimum\)/.test(n))).toBe(true);
    expect(plan.notes.some((n) => /capped at 4/.test(n))).toBe(false);
  });

  it("5 clamps down to 4 and the ack/notes say so", () => {
    const plan = tournamentPrefillFromParse(tournamentResult({ numRounds: 5 }), SAVED, []);
    expect(plan.numRounds).toBe(4);
    expect(plan.numRoundsClamped).toBe(true);
    expect(plan.notes.some((n) => /5 rounds/.test(n) && /capped at 4/.test(n))).toBe(true);
    expect(plan.ackLine).toMatch(/5 rounds/);
    expect(plan.ackLine).toMatch(/capped at 4/);
  });

  it("3 passes through untouched — no clamp note", () => {
    const plan = tournamentPrefillFromParse(tournamentResult({ numRounds: 3 }), SAVED, []);
    expect(plan.numRounds).toBe(3);
    expect(plan.numRoundsClamped).toBe(false);
    expect(plan.notes.some((n) => /capped/.test(n))).toBe(false);
  });
});

describe("tournamentPrefillFromParse — players", () => {
  it("exact case-insensitive match -> selectedIds", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ playerNames: ["justin", "JACK"] }),
      SAVED,
      [],
    );
    expect(plan.selectedIds.sort()).toEqual(["p1", "p2"]);
    expect(plan.customPlayerNames).toEqual([]);
  });

  it("fuzzy match (transcription drift) -> selectedIds", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ playerNames: ["Justyn"] }), // close to "Justin"
      SAVED,
      [],
    );
    expect(plan.selectedIds).toEqual(["p1"]);
  });

  it("unmatched names -> customPlayerNames, deduped case-insensitively", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ playerNames: ["Sam", "sam", "Pat"] }),
      SAVED,
      [],
    );
    expect(plan.selectedIds).toEqual([]);
    expect(plan.customPlayerNames).toEqual(["Sam", "Pat"]);
  });

  it("a name that matches a saved player is never ALSO staged as custom", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ playerNames: ["Justin", "justin", "Sam"] }),
      SAVED,
      [],
    );
    expect(plan.selectedIds).toEqual(["p1"]);
    expect(plan.customPlayerNames).toEqual(["Sam"]);
  });

  it("selectedIds are deduped even across repeated matches", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ playerNames: ["Justin", "Jack", "Justin"] }),
      SAVED,
      [],
    );
    expect(plan.selectedIds.sort()).toEqual(["p1", "p2"]);
  });
});

describe("tournamentPrefillFromParse — honest notes for fields with no form surface", () => {
  it("courses -> a note, never silently dropped", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ courses: ["Pebble Beach", "Spanish Bay"] }),
      SAVED,
      [],
    );
    expect(plan.notes.length).toBeGreaterThan(0);
    expect(plan.notes.some((n) => n.includes("Pebble Beach") && n.includes("Spanish Bay"))).toBe(
      true,
    );
    expect(plan.ackLine).toMatch(/Pebble Beach/);
  });

  it("groupings -> a note, never silently dropped", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ groupings: [["Justin", "Jack"], ["Mike"]] }),
      SAVED,
      [],
    );
    expect(plan.notes.length).toBeGreaterThan(0);
    expect(plan.notes.some((n) => /grouping/i.test(n))).toBe(true);
  });

  it("handicapAdjustment -> a note, never silently dropped", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ handicapAdjustment: { type: "half-divergence", description: "" } }),
      SAVED,
      [],
    );
    expect(plan.notes.length).toBeGreaterThan(0);
    expect(plan.notes.some((n) => /handicap/i.test(n))).toBe(true);
  });

  it("handicaps (per-player stroke allocations) -> a note, never silently dropped", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({ handicaps: { Justin: 2 } }),
      SAVED,
      [],
    );
    expect(plan.notes.length).toBeGreaterThan(0);
    expect(plan.notes.some((n) => /stroke/i.test(n))).toBe(true);
  });

  it("none of the no-surface fields present -> no notes", () => {
    const plan = tournamentPrefillFromParse(tournamentResult({}), SAVED, []);
    expect(plan.notes).toEqual([]);
  });
});

describe("tournamentPrefillFromParse — ack note capping (keep it calm, no wall of caveats)", () => {
  it("more than 2 notes -> ack surfaces only the first 2 plus a brief catch-all, but plan.notes keeps ALL of them (nothing silently dropped)", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({
        courses: ["Pebble Beach"],
        groupings: [["Justin", "Jack"]],
        handicapAdjustment: { type: "half-divergence", description: "" },
        handicaps: { Justin: 2 },
        numRounds: 5,
      }),
      SAVED,
      [],
    );
    // All five no-surface signals are represented in the full notes list.
    expect(plan.notes.length).toBe(5);
    // The ack surfaces at most 2 note sentences plus a short catch-all —
    // never a run-on paragraph of every caveat.
    expect(plan.ackLine).toMatch(/Pebble Beach/);
    expect(plan.ackLine).toMatch(/grouping/i);
    expect(plan.ackLine).not.toMatch(/handicap adjustment/i);
    expect(plan.ackLine).not.toMatch(/stroke/i);
    expect(plan.ackLine).toMatch(/other details/i);
  });

  it("exactly 2 notes -> both shown, no catch-all needed", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({
        courses: ["Pebble Beach"],
        groupings: [["Justin", "Jack"]],
      }),
      SAVED,
      [],
    );
    expect(plan.notes.length).toBe(2);
    expect(plan.ackLine).toMatch(/Pebble Beach/);
    expect(plan.ackLine).toMatch(/grouping/i);
    expect(plan.ackLine).not.toMatch(/other details/i);
  });
});

describe("tournamentPrefillFromParse — ackLine", () => {
  it("mentions name, rounds, and player count when they land", () => {
    const plan = tournamentPrefillFromParse(
      tournamentResult({
        name: "Club Championship",
        numRounds: 4,
        playerNames: ["Justin", "Jack", "Mike"],
      }),
      SAVED,
      [],
    );
    expect(plan.ackLine).toContain("Club Championship");
    expect(plan.ackLine).toContain("4 rounds");
    expect(plan.ackLine).toContain("3 players");
    expect(plan.ackLine).toMatch(/Tap Create/);
  });

  it("never claims creation happened", () => {
    const plan = tournamentPrefillFromParse(tournamentResult({ numRounds: 2 }), SAVED, []);
    expect(plan.ackLine).not.toMatch(/created|on it\./i);
  });
});
