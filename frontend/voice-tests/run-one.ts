#!/usr/bin/env node
/**
 * Minimal harness hook for testers.
 *
 * Example:
 *   npx tsx voice-tests/run-one.ts "everyone par" --hole 1 --par 4 --players "Justin,Jack"
 */

import { parseVoiceScores, parseVoiceTranscript } from "../src/lib/voice";
import { GAME_PARSER_PROMPT } from "../src/lib/voice-parser";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const transcript = process.argv[2];
  if (!transcript) {
    console.error("Usage: run-one.ts <transcript> [--scores] ...");
    process.exit(1);
  }

  const isScores = process.argv.includes("--scores");

  if (isScores) {
    const hole = parseInt(arg("--hole") || "1", 10);
    const par = parseInt(arg("--par") || "4", 10);
    const players = (arg("--players") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const res = await parseVoiceScores({
      transcript,
      playerNames: players,
      hole,
      par,
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  const players = (arg("--players") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const res = await parseVoiceTranscript({
    transcript,
    known: { players },
    llm: process.env.ANTHROPIC_API_KEY
      ? {
          anthropicApiKey: process.env.ANTHROPIC_API_KEY,
          systemPrompt: GAME_PARSER_PROMPT,
        }
      : undefined,
  });

  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
