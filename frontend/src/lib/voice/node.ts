// Node-friendly entry points for testing/harnesses.
// These functions are pure TS and work anywhere with global `fetch`.

export { parseVoiceTranscript, parseVoiceScores } from "./pipeline";
export type { ParseVoiceOptions, ParseScoresOptions } from "./pipeline";
