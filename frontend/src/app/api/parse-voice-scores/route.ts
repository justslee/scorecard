import { NextRequest, NextResponse } from "next/server";
import { parseVoiceScores } from "@/lib/voice/parseVoiceScores";

export async function POST(request: NextRequest) {
  try {
    const { transcript, playerNames, hole, par, apiKey } = await request.json();

    if (!transcript || !playerNames || !Array.isArray(playerNames)) {
      return NextResponse.json(
        { error: "Missing transcript or playerNames" },
        { status: 400 }
      );
    }

    // Use provided API key or fall back to env variable
    const ANTHROPIC_API_KEY = apiKey || process.env.ANTHROPIC_API_KEY;

    if (!ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "No API key. Add your Claude API key in Settings." },
        { status: 500 }
      );
    }

    const parsed = await parseVoiceScores(transcript, {
      playerNames,
      hole,
      par,
      anthropicApiKey: ANTHROPIC_API_KEY,
      requireApiKey: true,
    });

    return NextResponse.json(parsed);
  } catch (error) {
    console.error("Parse voice scores error:", error);
    return NextResponse.json(
      { error: "Failed to parse voice command" },
      { status: 500 }
    );
  }
}
