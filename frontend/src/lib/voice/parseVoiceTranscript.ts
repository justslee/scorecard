import type { VoiceParseSetupResult } from "./types";

export interface ParseVoiceTranscriptOptions {
  /** Set true to skip any network / LLM and use local rules. */
  forceLocal?: boolean;
  /** Optional: pass through systemPrompt for LLM parsing (not used by local). */
  systemPrompt?: string;
  /** Optional Anthropic API key; if omitted and forceLocal=false, we still fall back to local. */
  anthropicApiKey?: string;
  /** Dependency injection for fetch (tests). */
  fetchFn?: typeof fetch;
}

/**
 * Node-friendly wrapper around the setup voice parsing.
 *
 * Behavior:
 * - If `forceLocal` OR no `anthropicApiKey`: uses local heuristic parser.
 * - Else: calls Anthropic and extracts JSON.
 */
export async function parseVoiceTranscript(
  transcript: string,
  opts: ParseVoiceTranscriptOptions = {}
): Promise<VoiceParseSetupResult> {
  if (!transcript) throw new Error("No transcript provided");

  const anthropicApiKey = opts.anthropicApiKey;
  if (opts.forceLocal || !anthropicApiKey) {
    return parseVoiceTranscriptLocally(transcript);
  }

  const fetchFn = opts.fetchFn ?? fetch;

  const response = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: opts.systemPrompt ?? "",
      messages: [{ role: "user", content: transcript }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic parse failed: ${error}`);
  }

  const data: any = await response.json();
  const content = data.content?.[0]?.text ?? "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Could not extract JSON from LLM response: ${content}`);
  }
  return JSON.parse(jsonMatch[0]);
}

/**
 * Local parsing (heuristic). This is used for offline tests and as a fallback in dev.
 *
 * NOTE: Keep this in sync with user-facing expectations.
 */
export function parseVoiceTranscriptLocally(transcript: string): VoiceParseSetupResult {
  const lower = transcript.toLowerCase();

  // Detect game format
  let format = "skins"; // default
  let name = "Game";

  if (lower.includes("best ball") || lower.includes("bestball") || lower.includes("best-ball")) {
    format = "bestBall";
    name = "Best Ball";
  } else if (lower.includes("match play") || lower.includes("matchplay") || lower.includes("match-play")) {
    format = "matchPlay";
    name = "Match Play";
  } else if (lower.includes("nassau")) {
    format = "nassau";
    name = "Nassau";
  } else if (lower.includes("skins")) {
    format = "skins";
    name = "Skins";
  } else if (lower.includes("stableford") || lower.includes("stable ford") || lower.includes("stable-ford")) {
    format = "stableford";
    name = "Stableford";
  } else if (lower.includes("wolf")) {
    format = "wolf";
    name = "Wolf";
  } else if (
    lower.includes("three point") ||
    lower.includes("3 point") ||
    lower.includes("3-point")
  ) {
    format = "threePoint";
    name = "3-Point Game";
  } else if (lower.includes("scramble")) {
    format = "scramble";
    name = "Scramble";
  }

  // Extract player names.
  // We support:
  // - "with Bob, Sam and JT"
  // - "players: bob sam jt" (lowercase)
  // - comma-separated lists
  const playerNames: string[] = [];

  const listTriggers = ["with", "players", "player", "between"];
  for (const trig of listTriggers) {
    const re = new RegExp(`${trig}[:\\s]+([^.]*)`, "i");
    const m = transcript.match(re);
    if (m?.[1]) {
      const chunk = m[1]
        .replace(/\band\b/gi, ",")
        .replace(/\bvs\b/gi, ",")
        .replace(/\bv\b/gi, ",")
        .replace(/[()]/g, "")
        .trim();
      const parts = chunk.split(/[,+]/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        // keep short nicknames like "JT"; titlecase normal names
        if (p.length <= 3 && /^[a-zA-Z]+$/.test(p)) playerNames.push(p.toUpperCase());
        else playerNames.push(p.split(/\s+/).map(w => w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w).join(" "));
      }
    }
  }

  // Handicap extraction
  const handicaps: Record<string, number> = {};
  const handicapPattern = /([A-Za-z]{2,})\s+(?:receives?|gets?|receiving|getting|is)\s+(\d+)\s+strokes?/gi;
  for (const match of transcript.matchAll(handicapPattern)) {
    const playerNameRaw = match[1];
    const playerName = playerNameRaw.length <= 3 ? playerNameRaw.toUpperCase() : playerNameRaw[0]!.toUpperCase() + playerNameRaw.slice(1).toLowerCase();
    const strokes = parseInt(match[2]!, 10);
    handicaps[playerName] = strokes;
    if (!playerNames.includes(playerName)) playerNames.push(playerName);
  }

  // Detect teams for 2v2
  const teams: { name: string; playerNames: string[] }[] = [];
  if (lower.includes("2v2") || lower.includes("2 v 2") || lower.includes("two on two") || lower.includes("two vs two")) {
    if (playerNames.length >= 4) {
      teams.push({ name: "Team 1", playerNames: playerNames.slice(0, 2) });
      teams.push({ name: "Team 2", playerNames: playerNames.slice(2, 4) });
    }
  }

  // Detect tournament
  const isTournament = lower.includes("tournament") || lower.includes("days") || lower.includes("rounds");

  if (isTournament) {
    const daysMatch = lower.match(/(\d+)\s*(?:days?|rounds?)/) ?? lower.match(/(?:days?|rounds?)\s*(\d+)/);
    const numRounds = daysMatch ? parseInt(daysMatch[1]!, 10) : 1;

    // course names (very loose)
    const courses: string[] = [];
    const coursePattern = /(?:at|playing|play)\s+([A-Za-z][A-Za-z\s.]*?)(?:\s*(?:,|and|then|\.|$))/gi;
    for (const match of transcript.matchAll(coursePattern)) {
      const c = match[1]?.trim();
      if (c && c.length > 2) courses.push(c);
    }

    return {
      type: "tournament",
      tournament: {
        name: "Tournament",
        numRounds,
        courses,
        playerNames: [...new Set(playerNames)],
        handicaps: Object.keys(handicaps).length > 0 ? handicaps : undefined,
      },
      confidence: 0.6,
    };
  }

  return {
    type: "game",
    game: {
      format,
      name,
      teams: teams.length > 0 ? teams : undefined,
      playerNames: [...new Set(playerNames)],
      handicaps: Object.keys(handicaps).length > 0 ? handicaps : undefined,
      settings: {
        handicapped: Object.keys(handicaps).length > 0,
      },
    },
    confidence: 0.6,
  };
}
