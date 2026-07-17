/**
 * record_scores routing (specs/caddie-two-tier-routing-plan.md §9) — a PURE
 * routing layer between the live realtime caddie session and:
 *   - the EXISTING voice score parser (`POST /api/voice/parse-scores`,
 *     backend/app/routes/voice.py — the same endpoint ScoreSheet.tsx's own
 *     voice-scoring flow already posts to), and
 *   - the EXISTING score write path (`RoundPageClient.handleSetScore` —
 *     passed in as `onSetScore`, unmodified).
 *
 * NO new parser, schema, validation layer, or write path — this module only
 * wires the two together and applies the parse-failure guard: a low-
 * confidence PARSE writes nothing and asks the player to repeat. That guard
 * is NOT a confirm ceremony — an explicit spoken command ("I made a 5")
 * still writes DIRECTLY, on the first call, with no read-back-and-await
 * step (owner refinement, 2026-07-17).
 */

import { fetchAPI } from "@/lib/api";
import type { ScoreEntryResult } from "@/lib/voice/realtime";

export interface ParseScoresResponse {
  hole: number;
  scores: Record<string, number>;
  confidence?: number;
}

export interface ScoreEntryPlayer {
  id: string;
  name: string;
}

// Honest-empty guard threshold — mirrors the parser's own confidence field;
// below this, nothing is written and the model is told to ask the player to
// repeat (never a fabricated score, [[no-fake-data-fallbacks]]).
const MIN_SCORE_CONFIDENCE = 0.5;
// Same range-validate ScoreSheet.tsx's `applyVoiceScores` uses: manual entry
// is constrained to 1-9; voice allows up to 15 (a very bad hole on a par 5
// is realistic). Out-of-range values are treated as unmatched, never written.
const MIN_STROKES = 1;
const MAX_STROKES = 15;

const PARSE_FAILURE_RESULT = (utterance: string): ScoreEntryResult => ({
  error: "couldn't make out the scores",
  heard: utterance,
});

/**
 * Resolve one `record_scores` tool call: parse the utterance against the
 * round's real player names, range-validate, write each matched score via
 * `onSetScore` (the EXISTING write path — optimistic UI + pending overlay +
 * offline retry, all free), and return a structured result for the model to
 * acknowledge in-flow (never read back name-and-number, never a confirm
 * round-trip — the write already happened by the time this resolves).
 */
export async function resolveScoreEntry(
  utterance: string,
  hole: number,
  par: number,
  players: ScoreEntryPlayer[],
  onSetScore: (playerId: string, holeIdx: number, val: number) => void,
  parseScores: (body: {
    transcript: string;
    playerNames: string[];
    hole: number;
    par: number;
  }) => Promise<ParseScoresResponse>,
): Promise<ScoreEntryResult> {
  let parsed: ParseScoresResponse;
  try {
    parsed = await parseScores({
      transcript: utterance,
      playerNames: players.map((p) => p.name),
      hole,
      par,
    });
  } catch {
    return PARSE_FAILURE_RESULT(utterance);
  }

  const scores = parsed.scores ?? {};
  if (!parsed.confidence || parsed.confidence < MIN_SCORE_CONFIDENCE || Object.keys(scores).length === 0) {
    return PARSE_FAILURE_RESULT(utterance);
  }

  const recorded: Record<string, number> = {};
  for (const player of players) {
    const val = scores[player.name];
    if (val === undefined) continue;
    if (Number.isInteger(val) && val >= MIN_STROKES && val <= MAX_STROKES) {
      onSetScore(player.id, hole - 1, val);
      recorded[player.name] = val;
    }
  }
  const unmatched = Object.keys(scores).filter((name) => !(name in recorded));

  return { hole, recorded, unmatched, confidence: parsed.confidence };
}

/** The real `/api/voice/parse-scores` call — the EXISTING endpoint, same
 *  request shape ScoreSheet.tsx already posts. Split out so tests can
 *  inject a fake without mocking global fetch. */
export function defaultParseScores(body: {
  transcript: string;
  playerNames: string[];
  hole: number;
  par: number;
}): Promise<ParseScoresResponse> {
  return fetchAPI<ParseScoresResponse>("/api/voice/parse-scores", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
