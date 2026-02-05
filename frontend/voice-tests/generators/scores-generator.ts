import type { CommandLaneScenario } from "../schema";
import { mulberry32, pick, randInt, maybe, shuffle } from "../prng";
import { injectSttNoise } from "./stt-noise";

const PLAYER_POOL = [
  "Justin",
  "Bob",
  "Mike",
  "Sam",
  "Chris",
  "Pat",
  "Alex",
  "Jordan",
  "JT",
  "Kim",
] as const;

const RESULT_WORDS = ["par", "birdie", "bogey", "double bogey", "eagle"] as const;

function titleCase(s: string) {
  if (s.length <= 3 && /^[a-zA-Z]+$/.test(s)) return s.toUpperCase();
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

function scoreForResult(par: number, word: string) {
  if (word === "par") return par;
  if (word === "birdie") return par - 1;
  if (word === "eagle") return par - 2;
  if (word === "bogey") return par + 1;
  if (word === "double bogey") return par + 2;
  return par;
}

function uniq(xs: string[]) {
  return [...new Set(xs)];
}

function maybeNickname(rng: () => number, name: string) {
  const n = name.toLowerCase();
  const nick: Record<string, string[]> = {
    robert: ["rob", "bob", "bobby"],
    michael: ["mike"],
    justin: ["jt"],
    patrick: ["pat"],
  };
  const opts = nick[n];
  if (!opts) return name;
  return maybe(rng, 0.4) ? pick(rng, opts) : name;
}

export function generateScoresScenario(seed: number, index: number): CommandLaneScenario {
  const rng = mulberry32((seed ^ (index * 0x85ebca6b)) >>> 0);

  const hole = randInt(rng, 1, 18);
  const par = pick(rng, [3, 4, 4, 4, 5]);

  const playerCount = randInt(rng, 2, 4);
  const players = uniq(shuffle(rng, [...PLAYER_POOL]).slice(0, playerCount)).map(titleCase);

  const everyone = maybe(rng, 0.18);

  let utterance = "";
  let expectedEffect: any;

  if (everyone) {
    const res = pick(rng, RESULT_WORDS);
    const score = scoreForResult(par, res);
    utterance = `${pick(rng, ["everyone", "everybody", "all of us"]) } ${res} on ${hole}`;
    expectedEffect = {
      hole,
      scores: Object.fromEntries(players.map((p) => [p, score])),
    };
  } else {
    const mentionedCount = randInt(rng, 1, players.length);
    const mentioned = uniq(shuffle(rng, [...players]).slice(0, mentionedCount));

    const clauses: string[] = [];
    const scores: Record<string, number> = {};

    for (const p of mentioned) {
      const resOrNum = maybe(rng, 0.65) ? pick(rng, RESULT_WORDS) : "num";
      if (resOrNum === "num") {
        const s = randInt(rng, Math.max(1, par - 2), par + 4);
        const words = [
          "zero",
          "one",
          "two",
          "three",
          "four",
          "five",
          "six",
          "seven",
          "eight",
          "nine",
          "ten",
        ];
        const say = maybe(rng, 0.5) ? `${s}` : (words[Math.max(0, Math.min(10, s))] ?? `${s}`);
        clauses.push(`${maybeNickname(rng, p)} ${pick(rng, ["made", "shot", "got", "with"]) } a ${say}`);
        scores[p] = s;
      } else {
        const s = scoreForResult(par, resOrNum);
        clauses.push(`${maybeNickname(rng, p)} ${resOrNum}`);
        scores[p] = s;
      }
    }

    utterance = clauses.join(pick(rng, [" and ", ", ", " then "]));
    if (maybe(rng, 0.35)) utterance = `${utterance} on ${hole}`;

    expectedEffect = { hole, scores };
  }

  const variant = injectSttNoise(rng, utterance);

  return {
    id: `scores:${seed}:${index}`,
    context: { kind: "scores", playerNames: players, hole, par },
    utterance: variant,
    endpoint: "/api/parse-voice-scores",
    expectedEffect,
    expectedConfidenceMin: 0,
    notes: "Generated deterministically; runner uses local score parser by default (offline). Includes STT noise (four/ford etc), nicknames, punctuationless variants.",
  };
}
