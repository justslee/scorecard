import type { VoiceScenario } from "../scenario";
import { mulberry32, pick, randInt, maybe, shuffle } from "../prng";
import { injectSttNoise } from "./stt-noise";

const PLAYER_POOL = [
  "Justin",
  "Jack",
  "Bob",
  "Mike",
  "Sam",
  "Chris",
  "Pat",
  "Alex",
  "Jordan",
  "Lee",
  "Kim",
  "Rory",
  "Tiger",
] as const;

const SCORE_WORDS = ["par", "birdie", "bogey", "double bogey", "triple bogey", "eagle"] as const;

function uniq(xs: string[]) {
  return [...new Set(xs)];
}

/**
 * Generator for parseVoiceScores() scenarios that are solvable by heuristics
 * (so we can run offline without an LLM key).
 */
export function generateParseVoiceScoresScenario(seed: number, index: number): VoiceScenario {
  const rng = mulberry32((seed ^ (index * 0x85ebca6b)) >>> 0);

  const playerCount = randInt(rng, 2, 6);
  const players = uniq(shuffle(rng, [...PLAYER_POOL]).slice(0, playerCount));

  const hole = randInt(rng, 1, 18);
  const par = pick(rng, [3, 4, 5] as const);

  const kind = pick(rng, ["everyonePar", "pairs", "mix"] as const);

  let baseUtterance = "";
  const expectedScores: Record<string, number> = {};

  const wordToScore = (w: (typeof SCORE_WORDS)[number]) => {
    if (w === "par") return par;
    if (w === "birdie") return par - 1;
    if (w === "eagle") return par - 2;
    if (w === "bogey") return par + 1;
    if (w === "double bogey") return par + 2;
    if (w === "triple bogey") return par + 3;
    return par;
  };

  if (kind === "everyonePar") {
    baseUtterance = pick(rng, [
      "everyone par",
      "everybody par",
      "all par",
      `everyone par on ${hole}`,
    ]);
    for (const p of players) expectedScores[p] = par;
  } else if (kind === "pairs") {
    // Name Number / Name Word
    const pairs = randInt(rng, 1, Math.min(players.length, 4));
    const chosen = players.slice(0, pairs);
    const parts: string[] = [];

    for (const p of chosen) {
      if (maybe(rng, 0.6)) {
        const w = pick(rng, SCORE_WORDS);
        const val = wordToScore(w);
        expectedScores[p] = val;
        parts.push(`${p} ${w}`);
      } else {
        const val = randInt(rng, Math.max(1, par - 2), par + 4);
        expectedScores[p] = val;
        parts.push(`${p} ${val}`);
      }
    }

    baseUtterance = parts.join(", ");
  } else {
    // Mix in filler words and slight structure changes.
    const parts: string[] = [];
    const chosen = players.slice(0, randInt(rng, 2, Math.min(players.length, 5)));
    for (const p of chosen) {
      const useWord = maybe(rng, 0.65);
      if (useWord) {
        const w = pick(rng, SCORE_WORDS);
        const val = wordToScore(w);
        expectedScores[p] = val;
        parts.push(`${p} ${w}`);
      } else {
        const val = randInt(rng, Math.max(1, par - 2), par + 4);
        expectedScores[p] = val;
        parts.push(`${p} ${val}`);
      }
    }

    baseUtterance = `${pick(rng, ["on this hole", `hole ${hole}`, `for ${hole}`])} ${parts.join(" ")}`
      .replace(/\s+/g, " ")
      .trim();
  }

  const mutated = maybe(rng, 0.55);
  const utterance = mutated ? injectSttNoise(rng, baseUtterance) : baseUtterance;

  return {
    id: `gen:parse-voice-scores:${seed}:${index}`,
    endpoint: "parse-voice-scores",
    context: {
      mode: "command-lane",
      screen: "scoring",
      knownPlayers: players,
      hole,
      par,
    },
    utterance,
    expectedEffect: {
      hole,
      scores: expectedScores,
    },
    expectedConfidenceMin: 0.75,
    tags: ["scoring", kind],
    notes: "Generated to be solvable by parseScoresHeuristics (offline).",
    __meta: { seed, index, baseUtterance, mutated },
  };
}
