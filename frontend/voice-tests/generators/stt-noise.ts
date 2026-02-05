import { maybe, pick, randInt } from "../prng";

/**
 * STT noise injector: introduces common recognition errors, punctuation loss, and fillers.
 * Deterministic given rng.
 */
const WORD_SWAPS: Array<[RegExp, string[]]> = [
  [/\bfour\b/gi, ["4", "fore", "ford"]],
  [/\bfor\b/gi, ["four", "fore"]],
  [/\bto\b/gi, ["two", "too", "2"]],
  [/\btwo\b/gi, ["to", "too", "2"]],
  [/\btoo\b/gi, ["to", "two", "2"]],
  [/\bate\b/gi, ["eight", "8"]],
  [/\beight\b/gi, ["ate", "8"]],
  [/\bone\b/gi, ["won", "1"]],
  [/\bwon\b/gi, ["one", "1"]],
  [/\bthree\b/gi, ["3", "tree"]],
  [/\bstableford\b/gi, ["stable ford", "stable-ford"]],
  [/\bnassau\b/gi, ["nassow", "nasau", "naso"]],
  [/\bmatch play\b/gi, ["matchplay", "match-play"]],
  [/\bbest ball\b/gi, ["bestball", "best-ball"]],
];

const FILLERS = ["uh", "um", "like", "okay", "alright"];

export function injectSttNoise(rng: () => number, utterance: string): string {
  let u = utterance;

  // random case normalization (STT often lowercases)
  if (maybe(rng, 0.65)) u = u.toLowerCase();

  // optional punctuation stripping
  if (maybe(rng, 0.35)) u = u.replace(/[.,!?;:]/g, "");

  // apply 0-3 word swaps
  const swaps = randInt(rng, 0, 3);
  for (let i = 0; i < swaps; i++) {
    const [re, options] = pick(rng, WORD_SWAPS);
    if (re.test(u) && maybe(rng, 0.85)) {
      u = u.replace(re, pick(rng, options));
    }
  }

  // random filler prefix
  if (maybe(rng, 0.18)) u = `${pick(rng, FILLERS)} ${u}`;

  // collapse spaces
  u = u.replace(/\s+/g, " ").trim();

  return u;
}
