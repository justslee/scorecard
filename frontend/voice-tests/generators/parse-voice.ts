import type { VoiceScenario } from "../scenario";
import { mulberry32, pick, randInt, maybe, shuffle } from "../prng";
import { injectSttNoise } from "./stt-noise";

const FORMATS = [
  { key: "skins", says: ["skins", "play skins"] },
  { key: "bestBall", says: ["best ball", "bestball"] },
  { key: "matchPlay", says: ["match play", "matchplay"] },
  { key: "nassau", says: ["nassau"] },
  { key: "stableford", says: ["stableford"] },
  { key: "wolf", says: ["wolf"] },
  { key: "threePoint", says: ["three point", "3 point", "3-point"] },
  { key: "scramble", says: ["scramble"] },
] as const;

const PLAYER_POOL = [
  "Justin",
  "Bob",
  "Bobby",
  "Rob",
  "Robert",
  "Mike",
  "Michael",
  "Sam",
  "Samantha",
  "Chris",
  "Christine",
  "Pat",
  "Patrick",
  "Alex",
  "Alexa",
  "Jordan",
  "JT",
  "Lee",
  "Kim",
  "Rory",
  "Tiger",
  "Jack",
] as const;

const COURSES = [
  "Bethpage Black",
  "Pebble Beach",
  "Pinehurst No. 2",
  "Winged Foot",
  "Augusta National",
  "Torrey Pines",
  "Kiawah Island",
  "St Andrews",
] as const;

function uniq(xs: string[]) {
  return [...new Set(xs)];
}

function titleCase(s: string) {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/**
 * Generator for parseVoiceTranscript() scenarios that *do not* require an LLM.
 * This intentionally targets the deterministic heuristic/local-basic behavior.
 */
export function generateParseVoiceScenario(seed: number, index: number): VoiceScenario {
  const rng = mulberry32((seed ^ (index * 0x9e3779b9)) >>> 0);

  const format = pick(rng, FORMATS);
  const formatSaid = pick(rng, format.says);

  const isTournament = maybe(rng, 0.33);
  const playerCount = randInt(rng, 2, 6);
  const players = uniq(shuffle(rng, [...PLAYER_POOL]).slice(0, playerCount));

  // Local-basic extraction prefers Capitalized names.
  const spokenPlayers = players.map((p) => (maybe(rng, 0.78) ? titleCase(p) : p.toLowerCase()));

  const intro = pick(rng, [
    "set up",
    "start",
    "create",
    "new",
    "let's do",
    "we're playing",
    "we are playing",
  ]);

  // handicaps: local-basic regex requires "Name receives X strokes"
  const handicapMap: Record<string, number> = {};
  const handicapPhrases: string[] = [];
  for (const sp of spokenPlayers) {
    if (maybe(rng, 0.22) && /^[A-Z]/.test(sp)) {
      const strokes = randInt(rng, 1, 18);
      handicapMap[sp] = strokes;
      handicapPhrases.push(`${sp} receives ${strokes} strokes`);
    }
  }

  let baseUtterance = "";
  let expectedEffect: any;
  let tags: string[] = ["setup", isTournament ? "tournament" : "game", format.key];

  if (isTournament) {
    const rounds = randInt(rng, 1, 4);
    const courseCount = randInt(rng, 0, Math.min(3, COURSES.length));
    const courses = courseCount === 0 ? [] : uniq(shuffle(rng, [...COURSES]).slice(0, courseCount));

    const coursePart = courses.length ? ` at ${courses.map(titleCase).join(" and ")}.` : "";

    baseUtterance = `${intro} a tournament ${rounds} days with ${spokenPlayers.join(", ")}. ${handicapPhrases.join(", ")}${coursePart}`
      .replace(/\s+/g, " ")
      .trim();

    expectedEffect = {
      type: "tournament",
      tournament: {
        numRounds: rounds,
        handicaps: Object.keys(handicapMap).length ? handicapMap : undefined,
      },
    };
  } else {
    const do2v2 = maybe(rng, 0.2) && spokenPlayers.length >= 4;
    const teamSignal = do2v2 ? pick(rng, ["2v2", "2 v 2", "two on two"]) : "";

    baseUtterance = `${intro} ${formatSaid} ${teamSignal} with ${spokenPlayers.join(", ")}. ${handicapPhrases.join(", ")}`
      .replace(/\s+/g, " ")
      .trim();

    expectedEffect = {
      type: "game",
      game: {
        format: format.key,
        handicaps: Object.keys(handicapMap).length ? handicapMap : undefined,
        settings: {
          handicapped: Object.keys(handicapMap).length > 0,
        },
      },
    };
  }

  const mutated = maybe(rng, 0.62);
  const utterance = mutated ? injectSttNoise(rng, baseUtterance) : baseUtterance;

  return {
    id: `gen:parse-voice:${seed}:${index}`,
    endpoint: "parse-voice",
    context: {
      mode: "command-lane",
      screen: "setup",
      knownPlayers: uniq(players.map(titleCase)),
      knownCourses: uniq(shuffle(rng, [...COURSES]).slice(0, randInt(rng, 0, 5))).map(titleCase),
    },
    utterance,
    expectedEffect,
    expectedConfidenceMin: 0.45,
    tags,
    notes: "Generated to exercise deterministic heuristic/local parser (no LLM).",
    __meta: { seed, index, baseUtterance, mutated },
  };
}
