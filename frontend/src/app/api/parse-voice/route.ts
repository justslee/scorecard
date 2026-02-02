import { NextRequest, NextResponse } from "next/server";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export async function POST(request: NextRequest) {
  try {
    const { transcript, systemPrompt } = await request.json();

    if (!transcript) {
      return NextResponse.json(
        { error: "No transcript provided" },
        { status: 400 }
      );
    }

    if (!ANTHROPIC_API_KEY) {
      // Fallback: try to parse locally with basic rules
      return NextResponse.json(
        await parseLocally(transcript),
        { status: 200 }
      );
    }

    // Call Claude API
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: transcript,
          },
        ],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Claude API error:", error);
      return NextResponse.json(
        { error: "Failed to parse with Claude" },
        { status: 500 }
      );
    }

    const data = await response.json();
    const content = data.content[0]?.text || "";

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        { error: "Could not parse response", raw: content },
        { status: 500 }
      );
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return NextResponse.json(parsed);
  } catch (error) {
    console.error("Parse voice error:", error);
    return NextResponse.json(
      { error: "Failed to parse voice command" },
      { status: 500 }
    );
  }
}

// Basic local parsing fallback when no API key
async function parseLocally(transcript: string) {
  const lower = transcript.toLowerCase();
  
  // Detect game format
  let format = "skins"; // default
  let name = "Game";
  
  if (lower.includes("best ball") || lower.includes("bestball")) {
    format = "bestBall";
    name = "Best Ball";
  } else if (lower.includes("match play") || lower.includes("matchplay")) {
    format = "matchPlay";
    name = "Match Play";
  } else if (lower.includes("nassau")) {
    format = "nassau";
    name = "Nassau";
  } else if (lower.includes("skins")) {
    format = "skins";
    name = "Skins";
  } else if (lower.includes("stableford")) {
    format = "stableford";
    name = "Stableford";
  } else if (lower.includes("wolf")) {
    format = "wolf";
    name = "Wolf";
  } else if (lower.includes("three point") || lower.includes("3 point") || lower.includes("3-point")) {
    format = "threePoint";
    name = "3-Point Game";
  } else if (lower.includes("scramble")) {
    format = "scramble";
    name = "Scramble";
  }

  // Extract player names (basic pattern matching)
  const playerNames: string[] = [];
  const namePatterns = [
    /(?:with|players?:?|between)\s+([A-Z][a-z]+(?:\s*,?\s*(?:and\s+)?[A-Z][a-z]+)*)/gi,
    /([A-Z][a-z]+)\s+(?:receives?|gets?|giving)/gi,
  ];
  
  for (const pattern of namePatterns) {
    const matches = transcript.matchAll(pattern);
    for (const match of matches) {
      const names = match[1].split(/,|\s+and\s+/).map(n => n.trim()).filter(Boolean);
      playerNames.push(...names);
    }
  }

  // Extract handicaps
  const handicaps: Record<string, number> = {};
  const handicapPattern = /([A-Z][a-z]+)\s+(?:receives?|gets?|receiving|getting)\s+(\d+)\s+strokes?/gi;
  const handicapMatches = transcript.matchAll(handicapPattern);
  
  for (const match of handicapMatches) {
    const playerName = match[1];
    const strokes = parseInt(match[2], 10);
    handicaps[playerName] = strokes;
    if (!playerNames.includes(playerName)) {
      playerNames.push(playerName);
    }
  }

  // Detect teams for 2v2
  const teams: { name: string; playerNames: string[] }[] = [];
  if (lower.includes("2v2") || lower.includes("2 v 2") || lower.includes("two on two")) {
    // Try to split players into teams
    if (playerNames.length >= 4) {
      teams.push({ name: "Team 1", playerNames: playerNames.slice(0, 2) });
      teams.push({ name: "Team 2", playerNames: playerNames.slice(2, 4) });
    }
  }

  // Detect tournament
  const isTournament = lower.includes("tournament") || 
                       lower.includes("days") || 
                       lower.includes("rounds");

  if (isTournament) {
    // Extract number of rounds/days
    const daysMatch = lower.match(/(\d+)\s*(?:days?|rounds?)/);
    const numRounds = daysMatch ? parseInt(daysMatch[1], 10) : 1;

    // Extract course names (anything that looks like a course name)
    const courses: string[] = [];
    const coursePattern = /(?:at|play(?:ing)?)\s+([A-Z][A-Za-z\s]+?)(?:\s*,|\s+and\s+|\s+then\s+|\.)/g;
    const courseMatches = transcript.matchAll(coursePattern);
    for (const match of courseMatches) {
      courses.push(match[1].trim());
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
