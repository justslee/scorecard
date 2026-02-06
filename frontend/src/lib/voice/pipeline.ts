import { z } from "zod";
import {
  VoiceParseResultSchema,
  VoiceScoreParseResultSchema,
  type VoiceParseResultValidated,
  type VoiceScoreParseResultValidated,
} from "./schemas";
import {
  safeJsonExtract,
  fuzzyBestMatch,
  clamp01,
  parseSpokenNumber,
  stripFillerWords,
  normalizeTranscript,
} from "./utils";

export type VoiceKnownContext = {
  players?: string[];
  courses?: string[];
};

export type VoiceLLMConfig = {
  anthropicApiKey: string;
  model?: string;
  maxTokens?: number;
  systemPrompt: string;
  temperature?: number;
};

export type ParseVoiceOptions = {
  transcript: string;
  known?: VoiceKnownContext;
  llm?: VoiceLLMConfig;
  maxRepairs?: number;
};

export type ParseScoresOptions = {
  transcript: string;
  playerNames: string[];
  hole: number;
  par: number;
  llm?: Omit<VoiceLLMConfig, "systemPrompt"> & { systemPrompt?: string };
  maxRepairs?: number;
};

function zodErrorSummary(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

async function anthropicMessage(
  apiKey: string,
  body: unknown
): Promise<{ ok: boolean; text: string; raw: unknown }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const raw: unknown = await response
    .json()
    .catch(async () => ({ text: await response.text() }));

  const text = extractAnthropicText(raw);
  return { ok: response.ok, text, raw };
}

function extractAnthropicText(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const anyRaw = raw as Record<string, unknown>;
    const text = anyRaw["text"];
    if (typeof text === "string") return text;

    const content = anyRaw["content"];
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as any;
      if (first && typeof first === "object" && typeof first.text === "string") {
        return first.text;
      }
    }
  }
  return "";
}

function normalizePlayersAndCourses(
  result: VoiceParseResultValidated,
  known?: VoiceKnownContext
): VoiceParseResultValidated {
  const explanations: string[] = [...(result.explanations ?? [])];
  const warnings: string[] = [...(result.warnings ?? [])];
  const normalization: NonNullable<VoiceParseResultValidated["normalization"]> =
    result.normalization ? { ...result.normalization } : {};

  const knownPlayers = known?.players ?? [];
  const knownCourses = known?.courses ?? [];

  const normPlayers: { from: string; to: string; score: number }[] = [];
  const normCourses: { from: string; to: string; score: number }[] = [];

  const mapName = (name: string) => {
    if (knownPlayers.length === 0) return { name, score: 1, changed: false };
    const { match, score } = fuzzyBestMatch(name, knownPlayers, 0.76);
    if (!match) return { name, score, changed: false };
    if (match === name) return { name, score: 1, changed: false };
    return { name: match, score, changed: true };
  };

  const mapCourse = (course: string) => {
    if (knownCourses.length === 0) return { course, score: 1, changed: false };
    const { match, score } = fuzzyBestMatch(course, knownCourses, 0.74);
    if (!match) return { course, score, changed: false };
    if (match === course) return { course, score: 1, changed: false };
    return { course: match, score, changed: true };
  };

  if (result.type === "game" && result.game) {
    const mapped = result.game.playerNames.map((n) => {
      const m = mapName(n);
      if (m.changed) normPlayers.push({ from: n, to: m.name, score: m.score });
      return m.name;
    });

    const teamMapped = result.game.teams?.map((t) => ({
      ...t,
      playerNames: t.playerNames.map((n) => {
        const m = mapName(n);
        if (m.changed) normPlayers.push({ from: n, to: m.name, score: m.score });
        return m.name;
      }),
    }));

    // Remap handicaps keys as well.
    const handicaps = result.game.handicaps
      ? Object.fromEntries(
          Object.entries(result.game.handicaps).map(([k, v]) => {
            const m = mapName(k);
            if (m.changed) normPlayers.push({ from: k, to: m.name, score: m.score });
            return [m.name, v];
          })
        )
      : undefined;

    result = {
      ...result,
      game: {
        ...result.game,
        playerNames: Array.from(new Set(mapped)),
        teams: teamMapped,
        handicaps,
      },
    };
  }

  if (result.type === "tournament" && result.tournament) {
    const mappedPlayers = result.tournament.playerNames.map((n) => {
      const m = mapName(n);
      if (m.changed) normPlayers.push({ from: n, to: m.name, score: m.score });
      return m.name;
    });

    const mappedCourses = result.tournament.courses.map((c) => {
      const m = mapCourse(c);
      if (m.changed) normCourses.push({ from: c, to: m.course, score: m.score });
      return m.course;
    });

    const handicaps = result.tournament.handicaps
      ? Object.fromEntries(
          Object.entries(result.tournament.handicaps).map(([k, v]) => {
            const m = mapName(k);
            if (m.changed) normPlayers.push({ from: k, to: m.name, score: m.score });
            return [m.name, v];
          })
        )
      : undefined;

    const groupings = result.tournament.groupings
      ? result.tournament.groupings.map((g) =>
          g.map((n) => {
            const m = mapName(n);
            if (m.changed) normPlayers.push({ from: n, to: m.name, score: m.score });
            return m.name;
          })
        )
      : undefined;

    result = {
      ...result,
      tournament: {
        ...result.tournament,
        playerNames: Array.from(new Set(mappedPlayers)),
        courses: mappedCourses,
        handicaps,
        groupings,
      },
    };
  }

  if (normPlayers.length) {
    normalization.players = dedupeNorm(normPlayers);
    explanations.push("Normalized player names to known players.");
  }
  if (normCourses.length) {
    normalization.courses = dedupeNorm(normCourses);
    explanations.push("Normalized course names to known courses.");
  }

  return {
    ...result,
    explanations: explanations.length ? Array.from(new Set(explanations)) : undefined,
    warnings: warnings.length ? Array.from(new Set(warnings)) : undefined,
    normalization: Object.keys(normalization).length ? normalization : undefined,
  };
}

function dedupeNorm<T extends { from: string; to: string; score: number }>(xs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const key = `${x.from}→${x.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

function ensureTypeFields(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;

  if (r.type === "game" && !r.game && r.tournament) {
    r.game = undefined;
  }
  if (r.type === "tournament" && !r.tournament && r.game) {
    r.tournament = undefined;
  }
  return r;
}

export async function parseVoiceTranscript(options: ParseVoiceOptions): Promise<VoiceParseResultValidated> {
  const transcript = normalizeTranscript(options.transcript || "");
  const known = options.known;
  const maxRepairs = options.maxRepairs ?? 2;

  // 1) Deterministic fallback first for very common patterns.
  const heuristic = parseVoiceHeuristics(transcript, known);
  if (heuristic) return heuristic;

  // 2) If no LLM, fallback local parse (basic).
  if (!options.llm?.anthropicApiKey) {
    return parseVoiceLocalBasic(transcript, known);
  }

  // 3) LLM parse with schema validation + repair.
  const baseSystem = options.llm.systemPrompt;
  const contextHint = buildContextHint(known);

  let lastText = "";
  let lastErr: string | null = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const system =
      attempt === 0
        ? `${baseSystem}${contextHint}`
        : `${baseSystem}${contextHint}\n\nYour previous output was invalid. Fix it and return ONLY valid JSON that matches the schema.\nValidation errors: ${lastErr}`;

    const body = {
      model: options.llm.model ?? "claude-sonnet-4-20250514",
      max_tokens: options.llm.maxTokens ?? 1024,
      system,
      temperature: options.llm.temperature ?? 0,
      messages: [{ role: "user", content: transcript }],
    };

    const res = await anthropicMessage(options.llm.anthropicApiKey, body);
    if (!res.ok) {
      return {
        type: "game",
        game: {
          format: "skins",
          name: "Game",
          playerNames: known?.players ?? [],
          settings: { handicapped: false },
        },
        confidence: 0.1,
        warnings: ["LLM request failed"],
        explanations: ["Fell back to default game due to LLM error."],
      };
    }

    lastText = res.text;
    const jsonText = safeJsonExtract(lastText);
    if (!jsonText) {
      lastErr = "No JSON object found in response";
      continue;
    }

    let obj: unknown;
    try {
      obj = JSON.parse(jsonText) as unknown;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = `Invalid JSON: ${msg}`;
      continue;
    }

    obj = ensureTypeFields(obj);

    const parsed = VoiceParseResultSchema.safeParse(obj);
    if (!parsed.success) {
      lastErr = zodErrorSummary(parsed.error);
      continue;
    }

    const normalized = normalizePlayersAndCourses(parsed.data, known);
    return normalized;
  }

  // 4) Final fallback.
  const local = parseVoiceLocalBasic(transcript, known);
  return {
    ...local,
    warnings: [
      "Could not validate LLM output; fell back to local parser.",
      ...(local.warnings ?? []),
    ],
    confidence: 0.25,
  };
}

function buildContextHint(known?: VoiceKnownContext): string {
  const parts: string[] = [];
  if (known?.players?.length) {
    parts.push(`KNOWN PLAYERS: ${known.players.join(", ")}`);
  }
  if (known?.courses?.length) {
    parts.push(`KNOWN COURSES: ${known.courses.join(", ")}`);
  }
  return parts.length ? `\n\n${parts.join("\n")}` : "";
}

function parseVoiceLocalBasic(
  transcript: string,
  known?: VoiceKnownContext
): VoiceParseResultValidated {
  // Port of the old /api/parse-voice parseLocally() behavior so offline generators remain valid.
  const lower = transcript.toLowerCase();

  // Detect game format
  let format:
    | "skins"
    | "nassau"
    | "bestBall"
    | "matchPlay"
    | "stableford"
    | "wolf"
    | "threePoint"
    | "scramble" = "skins";
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

  // Extract player names (basic pattern matching; requires Capitalized names)
  const playerNames: string[] = [];

  // If caller provided known players, prefer them as the base set (but still try to extract subsets).
  const knownPlayers = known?.players ?? [];

  const namePatterns = [
    /(?:with|players?:?|between)\s+([A-Z][a-z]+(?:\s*,?\s*(?:and\s+)?[A-Z][a-z]+)*)/gi,
    /([A-Z][a-z]+)\s+(?:receives?|gets?|giving)/gi,
  ];

  const splitNameList = (raw: string): string[] => {
    const chunks = raw
      .split(/,|\s+and\s+/i)
      .map((n) => n.trim())
      .filter(Boolean);

    const out: string[] = [];
    for (const c of chunks) {
      // If a chunk looks like multiple capitalized first names with no commas ("Dan Justin Matt"), split on spaces.
      const words = c.split(/\s+/).filter(Boolean);
      if (words.length > 1 && words.every((w) => /^[A-Z][a-z]+$/.test(w))) {
        out.push(...words);
      } else {
        out.push(c);
      }
    }
    return out;
  };

  for (const pattern of namePatterns) {
    const matches = transcript.matchAll(pattern);
    for (const match of matches) {
      playerNames.push(...splitNameList(match[1]));
    }
  }

  // If nothing extracted, fall back to known players (if any).
  const extractedPlayers = [...new Set(playerNames)];
  const finalPlayers = extractedPlayers.length ? extractedPlayers : knownPlayers;

  // Extract handicaps
  const handicaps: Record<string, number> = {};
  const handicapPattern =
    /([A-Z][a-z]+)\s+(?:receives?|gets?|receiving|getting)\s+(\d+)\s+strokes?/gi;
  const handicapMatches = transcript.matchAll(handicapPattern);

  for (const match of handicapMatches) {
    const playerName = match[1];
    const strokes = parseInt(match[2], 10);
    handicaps[playerName] = strokes;
    if (!finalPlayers.includes(playerName)) {
      finalPlayers.push(playerName);
    }
  }

  // Detect teams for 2v2
  const teams: { name: string; playerNames: string[] }[] = [];
  if (
    lower.includes("2v2") ||
    lower.includes("2 v 2") ||
    lower.includes("two on two")
  ) {
    if (finalPlayers.length >= 4) {
      teams.push({ name: "Team 1", playerNames: finalPlayers.slice(0, 2) });
      teams.push({ name: "Team 2", playerNames: finalPlayers.slice(2, 4) });
    }
  }

  // Detect tournament
  const isTournament =
    lower.includes("tournament") || lower.includes("days") || lower.includes("rounds");

  if (isTournament) {
    const daysMatch = lower.match(/(\d+)\s*(?:days?|rounds?)/);
    const numRounds = daysMatch ? parseInt(daysMatch[1], 10) : 1;

    const courses: string[] = [];
    const coursePattern =
      /(?:at|play(?:ing)?)\s+([A-Z][A-Za-z\s]+?)(?:\s*,|\s+and\s+|\s+then\s+|\.)/g;
    const courseMatches = transcript.matchAll(coursePattern);
    for (const match of courseMatches) {
      courses.push(match[1].trim());
    }

    return normalizePlayersAndCourses(
      {
        type: "tournament",
        tournament: {
          name: "Tournament",
          numRounds,
          courses,
          playerNames: [...new Set(finalPlayers)],
          handicaps: Object.keys(handicaps).length ? handicaps : undefined,
        },
        confidence: 0.6,
        explanations: ["Parsed with deterministic local rules."],
      },
      known
    );
  }

  return normalizePlayersAndCourses(
    {
      type: "game",
      game: {
        format,
        name,
        teams: teams.length ? teams : undefined,
        playerNames: [...new Set(finalPlayers)],
        handicaps: Object.keys(handicaps).length ? handicaps : undefined,
        settings: {
          handicapped: Object.keys(handicaps).length > 0,
        },
      },
      confidence: 0.6,
      explanations: ["Parsed with deterministic local rules."],
    },
    known
  );
}

function extractCapitalizedNames(transcript: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Z][a-z]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transcript))) {
    out.push(m[1]);
  }
  return Array.from(new Set(out));
}

function parseVoiceHeuristics(
  transcript: string,
  known?: VoiceKnownContext
): VoiceParseResultValidated | null {
  const lower = transcript.toLowerCase();

  // Simple 1v1 match play: "match play justin vs jack" or "justin against jack"
  const mp = lower.match(/match\s*play.*\b([a-z]+)\b\s*(?:vs\.?|versus|against)\s*\b([a-z]+)\b/i);
  if (mp && known?.players?.length) {
    const aRaw = mp[1];
    const bRaw = mp[2];
    const a = fuzzyBestMatch(aRaw, known.players).match;
    const b = fuzzyBestMatch(bRaw, known.players).match;
    if (a && b && a !== b) {
      return {
        type: "game",
        game: {
          format: "matchPlay",
          name: "Match Play",
          playerNames: [a, b],
          settings: {
            handicapped: /stroke|handicap/.test(lower),
            matchPlayMode: "individual",
            matchPlayPlayers: { player1: a, player2: b },
          },
        },
        confidence: 0.8,
        explanations: ["Detected 1v1 match play pattern."],
      };
    }
  }

  // "2v2 best ball ..." is handled well by LLM; heuristic not added yet.
  if (/\b2\s*v\s*2\b|two\s*on\s*two/i.test(lower) && /best\s*ball|bestball/i.test(lower)) {
    // Let LLM do more nuanced team splits unless all players known and we can safely split.
  }

  return null;
}

export async function parseVoiceScores(options: ParseScoresOptions): Promise<VoiceScoreParseResultValidated> {
  const transcript = normalizeTranscript(options.transcript || "");
  const maxRepairs = options.maxRepairs ?? 2;

  // 1) Deterministic parse first.
  const heuristic = parseScoresHeuristics(transcript, options.playerNames, options.hole, options.par);
  if (heuristic) return heuristic;

  if (!options.llm?.anthropicApiKey) {
    return {
      hole: options.hole,
      scores: {},
      confidence: 0.2,
      warnings: ["No API key and heuristic parse failed."],
    };
  }

  const systemPrompt =
    options.llm.systemPrompt ??
    `You are parsing golf scores from a voice transcript and must return ONLY valid JSON.`;

  const userPrompt = `Players in this round: ${options.playerNames.join(", ")}
Current hole: ${options.hole}
Par for this hole: ${options.par}
Voice transcript: "${transcript}"

Return ONLY valid JSON in this exact format:
{"hole": ${options.hole}, "scores": {"PlayerName": score}}

Rules:
- Use the exact player names from the list.
- "par"=${options.par}, birdie=${options.par - 1}, eagle=${options.par - 2}, bogey=${options.par + 1}, double bogey=${options.par + 2}
- "everyone par" means all players get ${options.par}
- Numbers can be words or digits.`;

  let lastText = "";
  let lastErr: string | null = null;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const body = {
      model: options.llm.model ?? "claude-sonnet-4-20250514",
      max_tokens: options.llm.maxTokens ?? 256,
      system:
        attempt === 0
          ? systemPrompt
          : `${systemPrompt}\n\nYour previous output was invalid. Fix it and return ONLY JSON. Validation errors: ${lastErr}`,
      temperature: options.llm.temperature ?? 0,
      messages: [{ role: "user", content: userPrompt }],
    };

    const res = await anthropicMessage(options.llm.anthropicApiKey, body);
    if (!res.ok) {
      return {
        hole: options.hole,
        scores: {},
        confidence: 0.2,
        warnings: ["LLM request failed"],
      };
    }

    lastText = res.text;
    const jsonText = safeJsonExtract(lastText);
    if (!jsonText) {
      lastErr = "No JSON found";
      continue;
    }

    let obj: unknown;
    try {
      obj = JSON.parse(jsonText) as unknown;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = `Invalid JSON: ${msg}`;
      continue;
    }

    const parsed = VoiceScoreParseResultSchema.safeParse(obj);
    if (!parsed.success) {
      lastErr = zodErrorSummary(parsed.error);
      continue;
    }

    // Filter any names not in list to avoid bad updates.
    const allowed = new Set(options.playerNames);
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed.data.scores)) {
      if (allowed.has(k)) filtered[k] = v;
    }

    return {
      ...parsed.data,
      scores: filtered,
      confidence: clamp01(parsed.data.confidence ?? 0.75),
    };
  }

  return {
    hole: options.hole,
    scores: {},
    confidence: 0.25,
    warnings: ["Could not validate LLM output."],
  };
}

function parseScoresHeuristics(
  transcript: string,
  playerNames: string[],
  hole: number,
  par: number
): VoiceScoreParseResultValidated | null {
  const lower = transcript.toLowerCase();
  const allowed = playerNames;

  const explanations: string[] = [];

  if (/\b(everyone|everybody|all)\s+par\b/.test(lower)) {
    const scores: Record<string, number> = {};
    for (const p of allowed) scores[p] = par;
    explanations.push("Detected 'everyone par'.");
    return { hole, scores, confidence: 0.9, explanations };
  }

  // "Justin birdie" / "Jack bogey" etc.
  const scoreWordToValue = (w: string): number | null => {
    const t = w.toLowerCase();
    if (t.includes("par")) return par;
    if (t.includes("birdie")) return par - 1;
    if (t.includes("eagle")) return par - 2;
    if (t.includes("bogey")) return par + 1;
    if (t.includes("double")) return par + 2;
    if (t.includes("triple")) return par + 3;
    return null;
  };

  const scores: Record<string, number> = {};

  // Pair pattern: Name Number Name Number...
  const tokens = transcript
    .replace(/[,;]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  // Build map for quick name resolution (allow partials)
  const resolveName = (raw: string): string | null => {
    const { match } = fuzzyBestMatch(raw, allowed, 0.72);
    return match;
  };

  for (let i = 0; i < tokens.length - 1; i++) {
    const maybeName = resolveName(tokens[i]);
    if (!maybeName) continue;

    const num = parseSpokenNumber(tokens[i + 1]);
    if (num != null) {
      scores[maybeName] = num;
      explanations.push(`Parsed '${tokens[i]} ${tokens[i + 1]}' as ${maybeName}=${num}.`);
      i += 1;
      continue;
    }

    const val = scoreWordToValue(tokens[i + 1]);
    if (val != null) {
      scores[maybeName] = val;
      explanations.push(`Parsed '${tokens[i]} ${tokens[i + 1]}' as ${maybeName}=${val}.`);
      i += 1;
      continue;
    }
  }

  if (Object.keys(scores).length) {
    return { hole, scores, confidence: 0.8, explanations };
  }

  return null;
}
