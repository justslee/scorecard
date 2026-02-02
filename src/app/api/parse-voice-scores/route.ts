import { NextRequest, NextResponse } from "next/server";

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

    const prompt = `You are parsing golf scores from a voice transcript.

Players in this round: ${playerNames.join(", ")}
Current hole: ${hole}
Par for this hole: ${par}

Voice transcript: "${transcript}"

Parse this and return a JSON object with the scores for each player mentioned.

Rules:
- Match player names flexibly (first name, nickname, partial match)
- "par" = ${par}, "birdie" = ${par - 1}, "eagle" = ${par - 2}, "bogey" = ${par + 1}, "double bogey" = ${par + 2}
- "everyone par" means all players get ${par}
- Numbers can be spoken as words (four, five) or digits
- If a player name sounds similar to one in the list, use that player

Return ONLY valid JSON in this exact format, no other text:
{"hole": ${hole}, "scores": {"PlayerName": score, "PlayerName2": score}}

Use the exact player names from the list above in your response.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: prompt,
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
    
    console.log("Claude response:", content);

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
    console.error("Parse voice scores error:", error);
    return NextResponse.json(
      { error: "Failed to parse voice command" },
      { status: 500 }
    );
  }
}
