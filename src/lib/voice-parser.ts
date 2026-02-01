// Voice command parser using Claude
// Converts natural language game/tournament descriptions into structured config

import { GameFormat, GameSettings, Player } from "./types";

export interface ParsedGameConfig {
  format: GameFormat;
  name: string;
  teams?: {
    name: string;
    playerNames: string[];
  }[];
  playerNames: string[];
  handicaps?: Record<string, number>; // playerName -> handicap strokes
  settings: GameSettings;
}

export interface ParsedTournamentConfig {
  name: string;
  numRounds: number;
  courses: string[]; // course names in order
  playerNames: string[];
  groupings?: string[][]; // array of groups, each group is array of player names
  handicaps?: Record<string, number>;
  handicapAdjustment?: {
    type: "half-divergence" | "fixed" | "none";
    description: string;
  };
}

export interface VoiceParseResult {
  type: "game" | "tournament";
  game?: ParsedGameConfig;
  tournament?: ParsedTournamentConfig;
  rawTranscript: string;
  confidence: number;
}

// System prompt for Claude to parse voice commands
const GAME_PARSER_PROMPT = `You are a golf game configuration parser. Convert natural language descriptions of golf games and tournaments into structured JSON.

GAME FORMATS YOU KNOW:
- skins: Individual competition, win the hole outright to win the skin
- nassau: Three separate bets (front 9, back 9, overall)
- bestBall: Team format, best score on each hole counts
- matchPlay: Head-to-head hole-by-hole competition
- stableford: Points-based scoring (birdie=3, par=2, bogey=1, etc.)
- wolf: Rotating "wolf" picks partner or goes alone each hole
- threePoint: 2v2 format with 3 points per hole (2 individual matches + best ball)
- scramble: Team format, everyone plays from best shot

HANDICAP UNDERSTANDING:
- "X receives Y strokes on Z" means X gets Y handicap strokes advantage against Z
- "X gives Y strokes to Z" means Z gets Y handicap strokes advantage
- Handicaps are relative - calculate from the lowest handicap player (scratch)

OUTPUT FORMAT for games:
{
  "type": "game",
  "game": {
    "format": "<format>",
    "name": "<descriptive name>",
    "teams": [{"name": "Team A", "playerNames": ["player1", "player2"]}], // if team format
    "playerNames": ["all", "player", "names"],
    "handicaps": {"playerName": strokesTheyReceive}, // relative to scratch
    "settings": {
      "handicapped": true/false,
      "pointValue": number, // dollars per point/skin if mentioned
      "carryover": true/false, // for skins
      "matchPlayMode": "individual", // for match play
      "matchPlayPlayers": {"player1Id": "name1", "player2Id": "name2"} // for 1v1 match play
    }
  },
  "confidence": 0.0-1.0
}

OUTPUT FORMAT for tournaments:
{
  "type": "tournament",
  "tournament": {
    "name": "<tournament name>",
    "numRounds": number,
    "courses": ["course1", "course2", ...], // in play order
    "playerNames": ["all", "players"],
    "groupings": [["group1player1", "group1player2"], ["group2player1", "group2player2"]],
    "handicaps": {"playerName": handicapIndex},
    "handicapAdjustment": {
      "type": "half-divergence" | "fixed" | "none",
      "description": "Handicaps adjust by half the divergence from previous day"
    }
  },
  "confidence": 0.0-1.0
}

Parse the following voice command and return ONLY valid JSON:`;

export async function parseVoiceCommand(
  transcript: string,
  existingPlayers?: Player[]
): Promise<VoiceParseResult> {
  // Build context about existing players if available
  let playerContext = "";
  if (existingPlayers && existingPlayers.length > 0) {
    playerContext = `\n\nKNOWN PLAYERS IN THIS ROUND: ${existingPlayers.map(p => p.name).join(", ")}`;
  }

  const response = await fetch("/api/parse-voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript,
      systemPrompt: GAME_PARSER_PROMPT + playerContext,
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to parse voice command");
  }

  const result = await response.json();
  return {
    ...result,
    rawTranscript: transcript,
  };
}

// Calculate relative handicaps from "X receives Y strokes on Z" format
export function calculateRelativeHandicaps(
  descriptions: Array<{ player: string; strokes: number; relativeTo: string }>
): Record<string, number> {
  const handicaps: Record<string, number> = {};
  
  // Find the scratch player (the one others are relative to)
  const scratchPlayers = new Set(descriptions.map(d => d.relativeTo));
  
  for (const scratch of scratchPlayers) {
    handicaps[scratch] = 0;
  }
  
  for (const desc of descriptions) {
    handicaps[desc.player] = desc.strokes;
  }
  
  return handicaps;
}

// Match player names from voice to actual players (fuzzy matching)
export function matchPlayerNames(
  voiceNames: string[],
  actualPlayers: Player[]
): Map<string, Player> {
  const matches = new Map<string, Player>();
  
  for (const voiceName of voiceNames) {
    const normalized = voiceName.toLowerCase().trim();
    
    // Try exact match first
    let match = actualPlayers.find(
      p => p.name.toLowerCase() === normalized
    );
    
    // Try partial match (first name)
    if (!match) {
      match = actualPlayers.find(
        p => p.name.toLowerCase().startsWith(normalized) ||
             normalized.startsWith(p.name.toLowerCase().split(" ")[0])
      );
    }
    
    // Try contains match
    if (!match) {
      match = actualPlayers.find(
        p => p.name.toLowerCase().includes(normalized) ||
             normalized.includes(p.name.toLowerCase())
      );
    }
    
    if (match) {
      matches.set(voiceName, match);
    }
  }
  
  return matches;
}
