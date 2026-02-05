import { NextRequest, NextResponse } from "next/server";
import { parseVoiceTranscript } from "@/lib/voice/parseVoiceTranscript";

export async function POST(request: NextRequest) {
  try {
    const { transcript, systemPrompt } = await request.json();

    if (!transcript) {
      return NextResponse.json(
        { error: "No transcript provided" },
        { status: 400 }
      );
    }

    const parsed = await parseVoiceTranscript(transcript, {
      systemPrompt,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    });

    return NextResponse.json(parsed);
  } catch (error) {
    console.error("Parse voice error:", error);
    return NextResponse.json(
      { error: "Failed to parse voice command" },
      { status: 500 }
    );
  }
}
