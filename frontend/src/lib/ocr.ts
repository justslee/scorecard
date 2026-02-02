'use client';

import { Score, Player } from './types';

interface OCRResult {
  players: { name: string; scores: (number | null)[] }[];
  confidence: number;
  rawText?: string;
}

// Parse scorecard image using Claude Vision API
export async function parseScorecard(
  imageBase64: string,
  existingPlayers?: Player[]
): Promise<OCRResult> {
  const apiKey = localStorage.getItem('anthropic_api_key');
  
  if (!apiKey) {
    throw new Error('Claude API key not configured. Go to Settings to add it.');
  }

  const prompt = `Analyze this golf scorecard image and extract the scores.

Return a JSON object with this exact structure:
{
  "players": [
    {
      "name": "Player Name",
      "scores": [4, 5, 3, null, 5, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5]
    }
  ],
  "confidence": 0.85
}

Rules:
- Extract all player names and their scores for each hole (1-18)
- Use null for any hole that's blank or unreadable
- The scores array must have exactly 18 elements (holes 1-18 in order)
- Confidence should be 0-1 based on image clarity
- If you can't read the scorecard clearly, return empty players array with low confidence

${existingPlayers?.length ? `Hint: Expected player names might include: ${existingPlayers.map(p => p.name).join(', ')}` : ''}

Return ONLY the JSON, no other text.`;

  // Extract base64 data and media type
  let base64Data = imageBase64;
  let mediaType = 'image/jpeg';
  
  if (imageBase64.startsWith('data:')) {
    const matches = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      mediaType = matches[1];
      base64Data = matches[2];
    }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64Data,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to analyze image');
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';
    
    // Parse the JSON from the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse OCR response');
    }
    
    const result = JSON.parse(jsonMatch[0]) as OCRResult;
    result.rawText = content;
    
    return result;
  } catch (error) {
    console.error('OCR Error:', error);
    throw error;
  }
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
