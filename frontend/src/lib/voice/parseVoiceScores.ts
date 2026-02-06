import type { VoiceParseScoresResult } from "./types";

export interface ParseVoiceScoresOptions {
  playerNames: string[];
  hole: number;
  par: number;
  /** Optional: if provided, uses Anthropic; if omitted, local parse is used unless `requireApiKey` is true. */
  anthropicApiKey?: string;
  /** If true and no api key, throws (route behavior). */
  requireApiKey?: boolean;
  /** Dependency injection for fetch (tests). */
  fetchFn?: typeof fetch;
}

export async function parseVoiceScores(
  transcript: string,
  opts: ParseVoiceScoresOptions
): Promise<VoiceParseScoresResult> {
  if (!transcript) throw new Error("Missing transcript");
  if (!opts.playerNames || !Array.isArray(opts.playerNames)) throw new Error("Missing playerNames");

  const apiKey = opts.anthropicApiKey;
  if (!apiKey) {
    if (opts.requireApiKey) throw new Error("No API key");
    return parseVoiceScoresLocally(transcript, opts);
  }

  const fetchFn = opts.fetchFn ?? fetch;

  const prompt = `You are parsing golf scores from a voice transcript.

Common speech-to-text mistakes to handle:
- "for" / "fore" = 4
- "to" / "too" = 2
- "won" = 1
- "ate" = 8

Players in this round: ${opts.playerNames.join(", ")}
Current hole: ${opts.hole}
Par for this hole: ${opts.par}

Voice transcript: "${transcript}"

Parse this and return a JSON object with the scores for each player mentioned.

Rules:
- Match player names flexibly (first name, nickname, partial match)
- "par" = ${opts.par}, "birdie" = ${opts.par - 1}, "eagle" = ${opts.par - 2}, "bogey" = ${opts.par + 1}, "double bogey" = ${opts.par + 2}
- "everyone par" means all players get ${opts.par}
- Numbers can be spoken as words (four, five) or digits
- If a player name sounds similar to one in the list, use that player

Return ONLY valid JSON in this exact format, no other text:
{"hole": ${opts.hole}, "scores": {"PlayerName": score, "PlayerName2": score}}

Use the exact player names from the list above in your response.`;

  const response = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-4-20250514",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic parse failed: ${error}`);
  }

  const data: any = await response.json();
  const content = data.content?.[0]?.text ?? "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Could not parse response: ${content}`);
  const raw = JSON.parse(jsonMatch[0]);

  // Normalize returned player keys to the exact allowed player names.
  const allowed = opts.playerNames;
  const normalizeKey = (s: string) =>
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const resolvePlayer = (rawName: string): string | null => {
    const r = normalizeKey(rawName);
    if (!r) return null;

    // exact / case-insensitive
    for (const a of allowed) {
      if (normalizeKey(a) === r) return a;
    }

    // initial match: if allowed is single-letter like "J" and raw is "Justin"
    for (const a of allowed) {
      const an = normalizeKey(a);
      if (an.length === 1 && r.startsWith(an)) return a;
    }

    // substring match
    for (const a of allowed) {
      const an = normalizeKey(a);
      if (an && (r.includes(an) || an.includes(r))) return a;
    }

    return null;
  };

  if (raw && typeof raw === "object" && raw.scores && typeof raw.scores === "object") {
    const mapped: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.scores as Record<string, any>)) {
      const resolved = resolvePlayer(String(k));
      const num = typeof v === "number" ? v : parseInt(String(v), 10);
      if (resolved && Number.isFinite(num)) mapped[resolved] = num;
    }
    return { ...raw, scores: mapped };
  }

  return raw as any;
}

// --------------------
// Local score parser
// --------------------

const WORD_TO_NUM: Record<string, number> = {
  zero: 0,
  one: 1,
  won: 1,
  two: 2,
  to: 2,
  too: 2,
  three: 3,
  tree: 3,
  four: 4,
  for: 4,
  fore: 4,
  ford: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  ate: 8,
  nine: 9,
  ten: 10,
};

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function wordOrDigitToNum(tok: string): number | null {
  if (!tok) return null;
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  return WORD_TO_NUM[tok.toLowerCase()] ?? null;
}

function findPlayerMatch(playerNames: string[], chunk: string): string | null {
  const c = normalize(chunk);
  const words = new Set(c.split(" ").filter(Boolean));

  // nickname map (expand as needed)
  const nickToCanonical: Record<string, string[]> = {
    jt: ["justin"],
    mike: ["michael"],
    bob: ["robert"],
    bobby: ["robert"],
    rob: ["robert"],
    pat: ["patrick"],
  };

  // exact word match first
  for (const p of playerNames) {
    const pn = normalize(p);
    if (pn && words.has(pn)) return p;
  }

  // nicknames: if utterance has a nickname and player is the canonical
  for (const [nick, canonicals] of Object.entries(nickToCanonical)) {
    if (!words.has(nick)) continue;
    for (const p of playerNames) {
      const pn = normalize(p);
      if (canonicals.includes(pn)) return p;
    }
  }

  // prefix/partial ("mik" -> "Mike")
  for (const p of playerNames) {
    const pn = normalize(p);
    if (!pn) continue;
    if (c.includes(pn)) return p;
    if (c.length >= 2 && pn.startsWith(c)) return p;
    if (pn.length >= 3 && c.includes(pn.slice(0, 3))) return p;
  }

  return null;
}

export function parseVoiceScoresLocally(
  transcript: string,
  opts: Pick<ParseVoiceScoresOptions, "playerNames" | "hole" | "par">
): VoiceParseScoresResult {
  const t = normalize(transcript);

  const scores: Record<string, number> = {};

  // everyone par/birdie/bogey etc
  if (/(everyone|everybody|all|all of us)\s+(par|birdie|eagle|bogey|double bogey|dbl bogey|double)/.test(t)) {
    let val = opts.par;
    if (t.includes("birdie")) val = opts.par - 1;
    else if (t.includes("eagle")) val = opts.par - 2;
    else if (t.includes("double")) val = opts.par + 2;
    else if (t.includes("bogey")) val = opts.par + 1;

    for (const p of opts.playerNames) scores[p] = val;
    return { hole: opts.hole, scores };
  }

  // First pass: explicit "<player> <result/number>" patterns across the whole string.
  // This handles punctuation-less strings like "justin 4 bob 3".
  for (const p of opts.playerNames) {
    const pn = normalize(p);
    if (!pn) continue;
    const re = new RegExp(
      `\\b${pn}\\b\\s+(?:made\\s+a\\s+|got\\s+a\\s+|shot\\s+a\\s+|shot\\s+|with\\s+a\\s+|)\\s*(par|birdie|eagle|bogey|double\\s+bogey|dbl\\s+bogey|double|\\d+|zero|one|won|two|to|too|three|tree|four|fore|ford|five|six|seven|eight|ate|nine|ten)`,
      "gi"
    );
    for (const m of t.matchAll(re)) {
      const tok = (m[1] ?? "").toLowerCase();
      let val: number | null = null;
      if (tok === "par") val = opts.par;
      else if (tok === "birdie") val = opts.par - 1;
      else if (tok === "eagle") val = opts.par - 2;
      else if (tok === "bogey") val = opts.par + 1;
      else if (tok.includes("double") || tok.includes("dbl")) val = opts.par + 2;
      else val = wordOrDigitToNum(tok);
      if (val !== null) scores[p] = val;
    }
  }

  // Second pass: split on conjunctions and try to parse single-player clauses.
  const parts = t.split(/\b(?:and|,|then)\b/).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const player = findPlayerMatch(opts.playerNames, part);
    if (!player) continue;
    if (scores[player] !== undefined) continue;

    let val: number | null = null;
    if (part.includes("par")) val = opts.par;
    else if (part.includes("birdie")) val = opts.par - 1;
    else if (part.includes("eagle")) val = opts.par - 2;
    else if (part.includes("double") || part.includes("dbl")) val = opts.par + 2;
    else if (part.includes("bogey")) val = opts.par + 1;

    if (val === null) {
      const m = part.match(/\b(\d+|zero|one|won|two|to|too|three|tree|four|fore|ford|five|six|seven|eight|ate|nine|ten)\b/);
      if (m?.[1]) val = wordOrDigitToNum(m[1]);
    }

    if (val !== null) scores[player] = val;
  }

  return { hole: opts.hole, scores };
}
