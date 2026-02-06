import { NextRequest, NextResponse } from "next/server";
import { parseVoiceTranscript } from "@/lib/voice/node";

export async function POST(request: NextRequest) {
  try {
    const { transcript, systemPrompt, knownPlayers, knownCourses, apiKey } =
      await request.json();

    if (!transcript) {
      return NextResponse.json({ error: "No transcript provided" }, { status: 400 });
    }

    // Use provided API key (stored locally in browser) or fall back to server env.
    const ANTHROPIC_API_KEY = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "No API key. Add your Claude API key in Settings." },
        { status: 500 }
      );
    }

    const parsed = await parseVoiceTranscript({
      transcript,
      known: {
        players: Array.isArray(knownPlayers) ? knownPlayers : undefined,
        courses: Array.isArray(knownCourses) ? knownCourses : undefined,
      },
      llm: {
        anthropicApiKey: ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL || "claude-opus-4-20250514",
        maxTokens: 600,
        temperature: 0,
        systemPrompt:
          systemPrompt ||
          "You are a parser that returns ONLY valid JSON matching the provided schema.",
      },
      maxRepairs: 2,
    });

    return NextResponse.json(parsed);
  } catch (error) {
    console.error("Parse voice error:", error);
    return NextResponse.json({ error: "Failed to parse voice command" }, { status: 500 });
  }
}
