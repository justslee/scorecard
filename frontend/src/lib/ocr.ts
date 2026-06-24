'use client';

import { Score, Player } from './types';
import { fetchAPI } from './api';

interface OCRResult {
  players: { name: string; scores: (number | null)[] }[];
  confidence: number;
  rawText?: string;
}

// Parse a scorecard photo. Claude Vision runs server-side via the backend, so no
// API key ever touches the browser. (Previously this called api.anthropic.com
// directly with a key read from localStorage.)
export async function parseScorecard(
  imageBase64: string,
  existingPlayers?: Player[]
): Promise<OCRResult> {
  return fetchAPI<OCRResult>('/api/voice/parse-scorecard', {
    method: 'POST',
    body: JSON.stringify({
      imageBase64,
      existingPlayerNames: existingPlayers?.map((p) => p.name),
    }),
  });
}

// Convert OCR result to Score objects
export function ocrResultToScores(
  result: OCRResult,
  players: Player[]
): Score[] {
  const scores: Score[] = [];

  for (const ocrPlayer of result.players) {
    // Try to match with existing player
    const matchedPlayer = players.find(
      p => p.name.toLowerCase() === ocrPlayer.name.toLowerCase()
    );

    if (matchedPlayer) {
      ocrPlayer.scores.forEach((strokes, index) => {
        scores.push({
          playerId: matchedPlayer.id,
          holeNumber: index + 1,
          strokes,
        });
      });
    }
  }

  return scores;
}

// Validate scores are reasonable
export function validateScores(scores: (number | null)[]): boolean {
  return scores.every(s => s === null || (s >= 1 && s <= 15));
}
