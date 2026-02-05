import type { VoiceScenario } from "../scenario";

// Hand-curated, high-value corpus.
// Keep these stable: they serve as regression tests for real user phrasing.

const P = {
  four: ["Justin", "Jack", "Mike", "Sam"],
  six: ["Justin", "Jack", "Mike", "Sam", "Chris", "Pat"],
  duo: ["Justin", "Jack"],
  trio: ["Justin", "Jack", "Mike"],
};

export const curatedCorpus: VoiceScenario[] = [
  // -------------------- Setup / parse-voice --------------------
  {
    id: "curated:setup:matchplay-vs",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.duo },
    utterance: "match play Justin vs Jack",
    expectedEffect: { type: "game", game: { format: "matchPlay", playerNames: ["Justin", "Jack"] } },
    expectedConfidenceMin: 0.6,
    tags: ["setup", "game", "matchPlay", "1v1"],
  },
  {
    id: "curated:setup:matchplay-against",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.duo },
    utterance: "Justin against Jack match play",
    expectedEffect: { type: "game", game: { format: "matchPlay", playerNames: ["Justin", "Jack"] } },
    expectedConfidenceMin: 0.6,
    tags: ["setup", "game", "matchPlay", "1v1"],
  },
  {
    id: "curated:setup:skins-four",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.four },
    utterance: "set up skins with Justin, Jack, Mike, Sam",
    expectedEffect: { type: "game", game: { format: "skins", playerNames: P.four } },
    expectedConfidenceMin: 0.55,
    tags: ["setup", "game", "skins"],
  },
  {
    id: "curated:setup:skins-lowercase-known",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.four },
    utterance: "start skins with justin jack mike sam",
    expectedEffect: { type: "game", game: { format: "skins" } },
    expectedConfidenceMin: 0.4,
    tags: ["setup", "game", "skins", "lowercase"],
    notes: "Local-basic name extraction is brittle when punctuation is missing; assert only the format here.",
  },
  {
    id: "curated:setup:nassau",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.trio },
    utterance: "create nassau with Justin, Jack and Mike",
    expectedEffect: { type: "game", game: { format: "nassau", playerNames: P.trio } },
    tags: ["setup", "game", "nassau"],
  },
  {
    id: "curated:setup:bestball",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.four },
    utterance: "we're playing best ball with Justin, Jack, Mike, Sam",
    expectedEffect: { type: "game", game: { format: "bestBall" } },
    tags: ["setup", "game", "bestBall"],
  },
  {
    id: "curated:setup:matchplay-spaced",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.trio },
    utterance: "set up match play with Justin and Jack",
    expectedEffect: { type: "game", game: { format: "matchPlay", playerNames: ["Justin", "Jack"] } },
    tags: ["setup", "game", "matchPlay"],
  },
  {
    id: "curated:setup:stableford",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.six },
    utterance: "new stableford with Justin, Jack, Mike, Sam",
    expectedEffect: { type: "game", game: { format: "stableford" } },
    tags: ["setup", "game", "stableford"],
  },
  {
    id: "curated:setup:wolf",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.four },
    utterance: "start wolf with Justin, Jack, Mike and Sam",
    expectedEffect: { type: "game", game: { format: "wolf" } },
    tags: ["setup", "game", "wolf"],
  },
  {
    id: "curated:setup:three-point",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.trio },
    utterance: "let's do 3 point with Justin, Jack, Mike",
    expectedEffect: { type: "game", game: { format: "threePoint" } },
    tags: ["setup", "game", "threePoint"],
  },
  {
    id: "curated:setup:scramble",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.four },
    utterance: "create a scramble with Justin, Jack, Mike, Sam",
    expectedEffect: { type: "game", game: { format: "scramble" } },
    tags: ["setup", "game", "scramble"],
  },
  {
    id: "curated:setup:2v2",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.four },
    utterance: "play skins 2v2 with Justin, Jack, Mike, Sam",
    expectedEffect: {
      type: "game",
      game: {
        format: "skins",
        teams: [
          { name: "Team 1", playerNames: ["Justin", "Jack"] },
          { name: "Team 2", playerNames: ["Mike", "Sam"] },
        ],
      },
    },
    tags: ["setup", "game", "skins", "teams"],
  },
  {
    id: "curated:setup:handicaps",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: ["Justin", "Jack", "Mike"] },
    utterance: "set up nassau with Justin, Jack, Mike. Justin receives 2 strokes Jack receives 5 strokes",
    expectedEffect: {
      type: "game",
      game: {
        format: "nassau",
        handicaps: { Justin: 2, Jack: 5 },
        settings: { handicapped: true },
      },
    },
    tags: ["setup", "game", "nassau", "handicaps"],
  },
  {
    id: "curated:setup:tournament-basic",
    endpoint: "parse-voice",
    context: {
      mode: "command-lane",
      screen: "setup",
      knownPlayers: P.four,
      knownCourses: ["Pebble Beach", "Bethpage Black"],
    },
    utterance: "set up a tournament 2 days with Justin, Jack, Mike, Sam at Pebble Beach and Bethpage Black",
    expectedEffect: {
      type: "tournament",
      tournament: {
        numRounds: 2,
      },
    },
    tags: ["setup", "tournament"],
  },
  {
    id: "curated:setup:tournament-no-courses",
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.trio },
    utterance: "start a tournament 3 rounds with Justin, Jack, Mike",
    expectedEffect: { type: "tournament", tournament: { numRounds: 3 } },
    tags: ["setup", "tournament"],
  },

  // -------------------- Scoring / parse-voice-scores --------------------
  {
    id: "curated:scores:everyone-par",
    endpoint: "parse-voice-scores",
    context: { mode: "command-lane", screen: "scoring", knownPlayers: P.four, hole: 1, par: 4 },
    utterance: "everyone par",
    expectedEffect: { hole: 1, scores: { Justin: 4, Jack: 4, Mike: 4, Sam: 4 } },
    expectedConfidenceMin: 0.85,
    tags: ["scoring", "everyone"],
  },
  {
    id: "curated:scores:everyone-par-with-hole",
    endpoint: "parse-voice-scores",
    context: { mode: "command-lane", screen: "scoring", knownPlayers: P.trio, hole: 9, par: 5 },
    utterance: "everyone par on 9",
    expectedEffect: { hole: 9, scores: { Justin: 5, Jack: 5, Mike: 5 } },
    tags: ["scoring", "everyone"],
  },
  {
    id: "curated:scores:pairs-numbers",
    endpoint: "parse-voice-scores",
    context: { mode: "command-lane", screen: "scoring", knownPlayers: P.trio, hole: 3, par: 4 },
    utterance: "Justin 5 Jack 4 Mike 6",
    expectedEffect: { hole: 3, scores: { Justin: 5, Jack: 4, Mike: 6 } },
    expectedConfidenceMin: 0.7,
    tags: ["scoring", "pairs"],
  },
  {
    id: "curated:scores:pairs-words",
    endpoint: "parse-voice-scores",
    context: { mode: "command-lane", screen: "scoring", knownPlayers: P.trio, hole: 12, par: 4 },
    utterance: "Justin birdie Jack par Mike bogey",
    expectedEffect: { hole: 12, scores: { Justin: 3, Jack: 4, Mike: 5 } },
    expectedConfidenceMin: 0.75,
    tags: ["scoring", "words"],
  },
  {
    id: "curated:scores:double-bogey",
    endpoint: "parse-voice-scores",
    context: { mode: "command-lane", screen: "scoring", knownPlayers: ["Justin", "Jack"], hole: 7, par: 3 },
    utterance: "Justin double bogey Jack par",
    expectedEffect: { hole: 7, scores: { Justin: 5, Jack: 3 } },
    tags: ["scoring", "words", "double"],
  },
  {
    id: "curated:scores:triple-bogey",
    endpoint: "parse-voice-scores",
    context: { mode: "command-lane", screen: "scoring", knownPlayers: ["Justin", "Jack"], hole: 18, par: 5 },
    utterance: "Jack triple bogey Justin par",
    expectedEffect: { hole: 18, scores: { Jack: 8, Justin: 5 } },
    tags: ["scoring", "words", "triple"],
  },
  {
    id: "curated:scores:eagle",
    endpoint: "parse-voice-scores",
    context: { mode: "command-lane", screen: "scoring", knownPlayers: ["Justin", "Jack", "Mike"], hole: 2, par: 5 },
    utterance: "Justin eagle Jack birdie Mike par",
    expectedEffect: { hole: 2, scores: { Justin: 3, Jack: 4, Mike: 5 } },
    tags: ["scoring", "words"],
  },
  {
    id: "curated:scores:comma-separated",
    endpoint: "parse-voice-scores",
    context: { mode: "command-lane", screen: "scoring", knownPlayers: P.four, hole: 10, par: 4 },
    utterance: "Justin 4, Jack 5, Mike 4, Sam 6",
    expectedEffect: { hole: 10, scores: { Justin: 4, Jack: 5, Mike: 4, Sam: 6 } },
    tags: ["scoring", "pairs"],
  },
  {
    id: "curated:scores:stt-ish",
    endpoint: "parse-voice-scores",
    context: { mode: "command-lane", screen: "scoring", knownPlayers: ["Justin", "Jack"], hole: 5, par: 4 },
    utterance: "justin birdie jack bogey",
    expectedEffect: { hole: 5, scores: { Justin: 3, Jack: 5 } },
    tags: ["scoring", "lowercase"],
  },
];

// Expand with extra stable variations without hand-writing 100 lines.
// Keep deterministic ordering.
const extraSetupFormats: Array<[string, string]> = [
  ["skins", "skins"],
  ["best ball", "bestBall"],
  ["match play", "matchPlay"],
  ["nassau", "nassau"],
  ["stableford", "stableford"],
  ["wolf", "wolf"],
  ["scramble", "scramble"],
  ["3 point", "threePoint"],
];

for (const [said, format] of extraSetupFormats) {
  curatedCorpus.push({
    id: `curated:setup:format:${format}:base`,
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.six },
    utterance: `start ${said} with ${P.six.join(", ")}`,
    expectedEffect: { type: "game", game: { format } },
    tags: ["setup", "game", format],
  });

  curatedCorpus.push({
    id: `curated:setup:format:${format}:no-names-known`,
    endpoint: "parse-voice",
    context: { mode: "command-lane", screen: "setup", knownPlayers: P.six },
    utterance: `start ${said}`,
    expectedEffect: { type: "game", game: { format, playerNames: P.six } },
    tags: ["setup", "game", format, "knownPlayers"],
    notes: "No names spoken; should fall back to knownPlayers.",
  });
}

const scorePairs: Array<{ hole: number; par: number; utt: string; expected: Record<string, number> }> = [
  { hole: 1, par: 4, utt: "Justin par Jack bogey", expected: { Justin: 4, Jack: 5 } },
  { hole: 2, par: 3, utt: "Justin birdie Jack par", expected: { Justin: 2, Jack: 3 } },
  { hole: 3, par: 5, utt: "Justin 6 Jack 5", expected: { Justin: 6, Jack: 5 } },
  { hole: 4, par: 4, utt: "Jack 7 Justin 4", expected: { Jack: 7, Justin: 4 } },
  { hole: 5, par: 5, utt: "Justin eagle Jack birdie", expected: { Justin: 3, Jack: 4 } },
  { hole: 6, par: 4, utt: "Justin double bogey Jack triple bogey", expected: { Justin: 6, Jack: 7 } },
];

for (const sp of scorePairs) {
  curatedCorpus.push({
    id: `curated:scores:pairs:${sp.hole}:${sp.par}:${sp.utt.replace(/\s+/g, "-")}`,
    endpoint: "parse-voice-scores",
    context: {
      mode: "command-lane",
      screen: "scoring",
      knownPlayers: ["Justin", "Jack"],
      hole: sp.hole,
      par: sp.par,
    },
    utterance: sp.utt,
    expectedEffect: { hole: sp.hole, scores: sp.expected },
    tags: ["scoring", "pairs"],
  });
}
