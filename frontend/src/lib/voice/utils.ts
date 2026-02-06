export function safeJsonExtract(text: string): string | null {
  // Prefer fenced ```json blocks
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith("{") || candidate.startsWith("[")) return candidate;
  }

  // Fallback: find the first balanced { ... }
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

export function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

export function normalizeName(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  const aa = a;
  const bb = b;
  const dp = Array.from({ length: aa.length + 1 }, () =>
    new Array(bb.length + 1).fill(0)
  );
  for (let i = 0; i <= aa.length; i++) dp[i][0] = i;
  for (let j = 0; j <= bb.length; j++) dp[0][j] = j;
  for (let i = 1; i <= aa.length; i++) {
    for (let j = 1; j <= bb.length; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[aa.length][bb.length];
}

export function similarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  // Token containment boost
  if (nb.startsWith(na) || na.startsWith(nb)) return 0.92;
  if (nb.includes(na) || na.includes(nb)) return 0.86;

  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return clamp01(1 - dist / Math.max(1, maxLen));
}

export function fuzzyBestMatch(
  input: string,
  candidates: string[],
  minScore = 0.72
): { match: string | null; score: number } {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = similarity(input, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  if (bestScore < minScore) return { match: null, score: bestScore };
  return { match: best, score: bestScore };
}

const WORD_NUMBERS: Record<string, number> = {
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
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  ate: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

export function parseSpokenNumber(token: string): number | null {
  const t = normalizeName(token);
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (t in WORD_NUMBERS) return WORD_NUMBERS[t];
  return null;
}

export function stripFillerWords(s: string) {
  return s
    .replace(/\b(uh|um|like|please|hey|okay|ok)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Normalize transcript for downstream parsing (heuristics + LLM prompts).
// This is where we fix common speech-to-text mistakes.
export function normalizeTranscript(raw: string) {
  let s = stripFillerWords(raw || "");

  // Common iOS/ASR mishearings in golf game commands
  // "best ball" often becomes "basketball".
  s = s.replace(/\bbasketball\b/gi, "best ball");
  s = s.replace(/\bbestball\b/gi, "best ball");

  // Misc spacing cleanup
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
