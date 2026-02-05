import type { CommandLaneScenario } from "../schema";
import { mulberry32, pick, randInt, maybe, shuffle } from "../prng";
import { injectSttNoise } from "./stt-noise";

const FORMATS = [
  { key: "skins", says: ["skins", "play skins", "run skins"] },
  { key: "bestBall", says: ["best ball", "bestball", "2 best ball"] },
  { key: "matchPlay", says: ["match play", "matchplay"] },
  { key: "nassau", says: ["nassau"] },
  { key: "stableford", says: ["stableford", "stable ford"] },
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
] as const;

const COURSES = [
  "Bethpage Black",
  "Pebble Beach",
  "Pinehurst No 2",
  "Winged Foot",
  "Augusta National",
  "Torrey Pines",
  "Kiawah Island",
  "St Andrews",
] as const;

function titleCase(s: string) {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

function uniq(xs: string[]) {
  return [...new Set(xs)];
}

function maybeDropVowels(rng: () => number, name: string) {
  if (!maybe(rng, 0.15)) return name;
  return name.replace(/[aeiou]/gi, ""); // partial / weird STT
}

export function generateSetupScenario(seed: number, index: number): CommandLaneScenario {
  const rng = mulberry32((seed ^ (index * 0x9e3779b9)) >>> 0);

  const format = pick(rng, FORMATS);
  const formatSaid = pick(rng, format.says);

  const isTournament = maybe(rng, 0.35);
  const playerCount = randInt(rng, 2, 6);
  const players = uniq(shuffle(rng, [...PLAYER_POOL]).slice(0, playerCount));

  // Include partial / nickname-ish variants sometimes
  const spokenPlayers = players.map((p) => {
    const base = p.length > 3 && maybe(rng, 0.25) ? p.slice(0, randInt(rng, 2, Math.min(4, p.length))) : p;
    const noisy = maybeDropVowels(rng, base);
    return maybe(rng, 0.6) ? titleCase(noisy) : noisy.toLowerCase();
  });

  const intro = pick(rng, [
    "set up",
    "start",
    "create",
    "new",
    "let's do",
    "we're playing",
    "we are playing",
    "spin up",
  ]);

  // handicaps: keep phrasing compatible with local parser
  const handicapMap: Record<string, number> = {};
  const handicapPhrases: string[] = [];
  for (const sp of spokenPlayers) {
    if (maybe(rng, 0.25)) {
      const strokes = randInt(rng, 1, 18);
      const normName = sp.length <= 3 ? sp.toUpperCase() : titleCase(sp);
      handicapMap[normName] = strokes;
      handicapPhrases.push(`${normName} receives ${strokes} strokes`);
    }
  }

  let utterance = "";
  let expectedEffect: any;

  if (isTournament) {
    const rounds = randInt(rng, 1, 4);
    const courseCount = randInt(rng, 0, 3);
    const courses = courseCount === 0 ? [] : uniq(shuffle(rng, [...COURSES]).slice(0, courseCount));

    const coursePart = courses.length
      ? ` at ${courses.map(titleCase).join(" and ")}`
      : "";

    utterance = `${intro} a tournament ${rounds} days players: ${spokenPlayers.join(", ")}. ${handicapPhrases.join(", ")}${coursePart}`
      .replace(/\s+/g, " ")
      .trim();

    expectedEffect = {
      type: "tournament",
      tournament: {
        name: "Tournament",
        numRounds: rounds,
        // local parser is loose; allow subset match
      },
    };
  } else {
    const do2v2 = maybe(rng, 0.2) && spokenPlayers.length >= 4;
    const teamSignal = do2v2 ? pick(rng, ["2v2", "2 v 2", "two on two", "two vs two"]) : "";

    utterance = `${intro} ${formatSaid} ${teamSignal} with ${spokenPlayers.join(", ")}. ${handicapPhrases.join(", ")}`
      .replace(/\s+/g, " ")
      .trim();

    expectedEffect = {
      type: "game",
      game: {
        format: format.key,
      },
    };
  }

  const variant = injectSttNoise(rng, utterance);

  return {
    id: `setup:${seed}:${index}`,
    context: { kind: "setup", lane: isTournament ? "tournament" : "game" },
    utterance: variant,
    endpoint: "/api/parse-voice",
    expectedEffect,
    expectedConfidenceMin: 0.5,
    notes: "Generated deterministically; subset-checked against local fallback parser. Includes STT noise, partial names, punctuationless variants.",
  };
}
