import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const RoundSetupSchema = z.object({
  courseName: z.string().optional().default(""),
  playerNames: z.array(z.string()).optional().default([]),
  teeName: z.string().nullable().optional().default(null),
  confidence: z.number().optional(),
  warnings: z.array(z.string()).optional(),
  explanations: z.array(z.string()).optional(),
});

type RoundSetup = z.infer<typeof RoundSetupSchema>;

function safeJsonExtract(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith("{") || candidate.startsWith("[")) return candidate;
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

async function anthropicMessage(apiKey: string, body: unknown) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const raw: any = await response
    .json()
    .catch(async () => ({ text: await response.text() }));

  const text =
    raw?.content && Array.isArray(raw.content) && raw.content[0]?.text
      ? String(raw.content[0].text)
      : typeof raw?.text === "string"
        ? raw.text
        : JSON.stringify(raw);

  return { ok: response.ok, text, raw };
}

export async function POST(request: NextRequest) {
  try {
    const { transcript, apiKey } = await request.json();

    if (!transcript) {
      return NextResponse.json({ error: "No transcript provided" }, { status: 400 });
    }

    const ANTHROPIC_API_KEY = apiKey || process.env.ANTHROPIC_API_KEY;

    // If no API key is available, fall back to a lightweight local parse so the feature still works.
    if (!ANTHROPIC_API_KEY) {
      const text = String(transcript);

      const splitNameList = (raw: string): string[] => {
        const chunks = raw
          .split(/,|\s+and\s+/i)
          .map((n) => n.trim())
          .filter(Boolean);

        const out: string[] = [];
        for (const c of chunks) {
          const words = c.split(/\s+/).filter(Boolean);
          if (words.length > 1 && words.every((w) => /^[A-Z][a-z]+$/.test(w))) {
            out.push(...words);
          } else {
            out.push(c);
          }
        }
        return out;
      };

      // Players: try to capture after "with" or "players"
      const playerNames: string[] = [];
      const withPattern = /(?:with|players?:?)\s+([A-Z][a-z]+(?:\s*,?\s*(?:and\s+)?[A-Z][a-z]+)*)/gi;
      for (const match of text.matchAll(withPattern)) {
        playerNames.push(...splitNameList(match[1]));
      }

      // Course: "at Augusta" / "playing at Pebble Beach"
      let courseName = "";
      const atPattern = /(?:at|playing)\s+([A-Z][A-Za-z\s]+?)(?:\s+(?:golf|course|with|today|everyone)|\s*$|,)/i;
      const atMatch = text.match(atPattern);
      if (atMatch) courseName = atMatch[1].trim();

      // Tee: "blue tees"
      let teeName: string | null = null;
      const teePattern = /(?:from\s+(?:the\s+)?)?(\w+)\s+tees?/i;
      const teeMatch = text.match(teePattern);
      if (teeMatch) teeName = teeMatch[1];

      return NextResponse.json({
        courseName,
        playerNames: Array.from(new Set(playerNames)),
        teeName,
        confidence: 0.55,
        warnings: ["No API key available; used local parsing."],
      });
    }

    const system = `You extract a golf round setup from voice transcription and must return ONLY valid JSON.

Schema:
{
  "courseName": string,
  "playerNames": string[],
  "teeName": string | null
}

Rules:
- Split players into individual names ("Dan Justin Matt" -> ["Dan","Justin","Matt"]).
- courseName should be the course mentioned if any.
- teeName should be tee color/name if mentioned; otherwise null.
- Return only JSON, no extra text.`;

    const user = `Transcript: "${transcript}"`;

    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await anthropicMessage(ANTHROPIC_API_KEY, {
        model: process.env.ANTHROPIC_MODEL || "claude-opus-4-20250514",
        max_tokens: 300,
        temperature: 0,
        system:
          attempt === 0
            ? system
            : `${system}\n\nYour previous output was invalid. Fix it and return ONLY JSON. Error: ${lastErr}`,
        messages: [{ role: "user", content: user }],
      });

      if (!res.ok) {
        console.error("Anthropic API error:", res.raw);
        return NextResponse.json({ 
          error: "LLM request failed", 
          details: res.raw?.error?.message || res.text || "Unknown error"
        }, { status: 500 });
      }

      const jsonText = safeJsonExtract(res.text);
      if (!jsonText) {
        lastErr = "No JSON found";
        continue;
      }

      try {
        const obj = JSON.parse(jsonText);
        const parsed = RoundSetupSchema.safeParse(obj);
        if (!parsed.success) {
          lastErr = parsed.error.issues.map((i) => i.message).join(", ");
          continue;
        }
        const out: RoundSetup = parsed.data;
        return NextResponse.json({ ...out, confidence: out.confidence ?? 0.75 });
      } catch (e: any) {
        lastErr = e?.message || String(e);
      }
    }

    return NextResponse.json({ error: "Could not parse transcript" }, { status: 500 });
  } catch (error) {
    console.error("Parse round setup error:", error);
    return NextResponse.json({ error: "Failed to parse round setup" }, { status: 500 });
  }
}
