#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseVoiceTranscript } from "@/lib/voice/parseVoiceTranscript";
import { parseVoiceScores, parseVoiceScoresLocally } from "@/lib/voice/parseVoiceScores";
import type { CommandLaneScenario } from "./schema";
import { deepSubset } from "./assert";
import { generateScenario } from "./generators";
import { shrinkFailingScenario } from "./shrink";

type Args = Record<string, string | boolean | number>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) {
      out[k] = true;
    } else {
      i++;
      const n = Number(v);
      out[k] = Number.isFinite(n) && v.trim() !== "" ? n : v;
    }
  }
  return out;
}

function readJsonl(filePath: string): CommandLaneScenario[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((l, idx) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      throw new Error(`Failed parsing JSONL ${filePath}:${idx + 1}: ${String(e)}`);
    }
  });
}

function pretty(x: any) {
  return JSON.stringify(x, null, 2);
}

async function runOne(s: CommandLaneScenario, opts: { verbose: boolean; useRealAnthropicForScores: boolean }) {
  const utter = s.utterance;

  let actual: any;

  if (s.endpoint === "/api/parse-voice") {
    // force local by clearing key
    actual = await parseVoiceTranscript(utter, { forceLocal: true });
  } else {
    if (s.context.kind !== "scores") throw new Error(`Scenario ${s.id} has endpoint scores but wrong context`);

    if (opts.useRealAnthropicForScores) {
      actual = await parseVoiceScores(utter, {
        playerNames: s.context.playerNames,
        hole: s.context.hole,
        par: s.context.par,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        requireApiKey: true,
      });
    } else {
      actual = parseVoiceScoresLocally(utter, {
        playerNames: s.context.playerNames,
        hole: s.context.hole,
        par: s.context.par,
      });
    }
  }

  // confidence check (setup only)
  if (s.expectedConfidenceMin > 0 && typeof actual?.confidence === "number") {
    if (actual.confidence < s.expectedConfidenceMin) {
      return {
        ok: false,
        reason: `confidence ${actual.confidence} < min ${s.expectedConfidenceMin}`,
        actual,
      };
    }
  }

  const errs = deepSubset(actual, s.expectedEffect);
  if (errs.length) {
    if (opts.verbose) {
      console.log(`\n[FAIL] ${s.id}`);
      console.log(`Utterance: ${s.utterance}`);
      console.log(`Notes: ${s.notes}`);
      console.log(`Subset errors:\n- ${errs.join("\n- ")}`);
      console.log(`Expected subset:\n${pretty(s.expectedEffect)}`);
      console.log(`Actual:\n${pretty(actual)}`);
    }
    return { ok: false, reason: errs[0]!, actual };
  }

  return { ok: true as const, actual };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const smoke = Boolean(args.smoke) || (!args.seed && !args.count);
  const seed = Number(args.seed ?? 123);
  const count = Number(args.count ?? (smoke ? 200 : 1000));
  const verbose = Boolean(args.verbose);
  const shrink = args.shrink === undefined ? true : Boolean(args.shrink);
  const useRealAnthropicForScores = Boolean(args.realAnthropic);

  const corpusPath = path.join(process.cwd(), "voice-tests", "corpus", "seed-utterances.jsonl");
  const corpus = fs.existsSync(corpusPath) ? readJsonl(corpusPath) : [];

  const scenarios: CommandLaneScenario[] = [];
  if (smoke) scenarios.push(...corpus);

  for (let i = 0; i < count; i++) {
    scenarios.push(generateScenario(seed, i));
  }

  let pass = 0;
  let fail = 0;

  for (const s of scenarios) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runOne(s, { verbose, useRealAnthropicForScores });
    if (res.ok) {
      pass++;
      continue;
    }

    fail++;

    // Shrink: search for a smaller utterance variant that still fails.
    if (shrink) {
      const minimized = await shrinkFailingScenario(s, async (cand) => {
        const r = await runOne(cand, { verbose: false, useRealAnthropicForScores });
        return !r.ok;
      });

      console.log(`\n[FAIL] ${s.id}`);
      console.log(`Endpoint: ${s.endpoint}`);
      console.log(`Reason: ${res.reason}`);
      console.log(`Notes: ${s.notes}`);
      console.log(`Minimized utterance (${minimized.utterance.length} chars): ${minimized.utterance}`);
      console.log(`Expected subset:\n${pretty(s.expectedEffect)}`);
      console.log(`Actual:\n${pretty(res.actual)}`);
    } else {
      console.log(`\n[FAIL] ${s.id}: ${res.reason}`);
    }

    process.exitCode = 1;
    break; // stop on first failure (fast feedback)
  }

  console.log(`\nDone. pass=${pass} fail=${fail} total=${scenarios.length}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
