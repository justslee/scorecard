/**
 * Tee-time prefs voice intent — the /tee-time "Hold to talk" parser.
 *
 * Turns utterances like "find me a tee time Saturday morning at Presidio,
 * party of 4, under $80" into a structured prefs update (windows / courses /
 * party size / price / distance). Same architecture as pipeline.ts:
 * deterministic heuristics first, then an optional LLM pass validated by the
 * Zod schema with a repair loop, then the local parse as the final fallback.
 * The heuristics are pure + offline so voice-tests can exercise them.
 */

import { z } from "zod";
import {
  TeeTimePrefsParseResultSchema,
  type TeeTimePrefsParseResultValidated,
} from "./schemas";
import {
  safeJsonExtract,
  fuzzyBestMatch,
  similarity,
  normalizeName,
  normalizeTranscript,
  parseSpokenNumber,
} from "./utils";

export type TeeTimeDay = z.infer<
  typeof TeeTimePrefsParseResultSchema
>["windows"][number]["day"];
export type TeeTimePeriod = NonNullable<
  z.infer<typeof TeeTimePrefsParseResultSchema>["windows"][number]["period"]
>;

export type TeeTimeKnownContext = {
  /** Names of the courses currently listed on the prefs screen. */
  courses?: string[];
};

export type ParseTeeTimePrefsOptions = {
  transcript: string;
  known?: TeeTimeKnownContext;
  llm?: {
    anthropicApiKey: string;
    model?: string;
    maxTokens?: number;
    systemPrompt?: string;
    temperature?: number;
  };
  maxRepairs?: number;
};

/** True when the parse recognized anything actionable at all. */
export function hasTeeTimeSignal(r: TeeTimePrefsParseResultValidated): boolean {
  return (
    r.windows.length > 0 ||
    r.courseNames.length > 0 ||
    r.favoritesOnly ||
    r.partySize != null ||
    r.maxPriceUsd != null ||
    r.maxDistanceMiles != null ||
    r.dispatch
  );
}

// ─── Deterministic heuristics ─────────────────────────────────────────────────

const DAYS: TeeTimeDay[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const PERIOD_PATTERNS: Array<[RegExp, TeeTimePeriod]> = [
  [/\b(?:early|first thing|sunrise|dawn|daybreak)\b/g, "early"],
  [/\bmornings?\b/g, "morning"],
  [/\b(?:midday|mid-day|noon|lunch(?:time)?)\b/g, "midday"],
  [/\bafternoons?\b/g, "afternoon"],
  [/\b(?:twilight|evenings?|dusk|sunset)\b/g, "twilight"],
];

/** How far apart (chars) a day word and a period word can sit and still pair. */
const PAIR_DISTANCE = 30;

const TENS_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/**
 * Parse a spoken amount phrase — "80", "eighty", "eighty five",
 * "a hundred", "one hundred twenty". Null when nothing numeric is found.
 */
export function parseSpokenAmount(phrase: string): number | null {
  const tokens = normalizeName(phrase).split(" ").filter(Boolean);
  if (tokens.length === 0) return null;

  let total = 0;
  let current = 0;
  let sawNumber = false;

  for (const tok of tokens) {
    if (/^\d+(?:\.\d+)?$/.test(tok)) {
      current += parseFloat(tok);
      sawNumber = true;
      continue;
    }
    if (tok in TENS_WORDS) {
      current += TENS_WORDS[tok];
      sawNumber = true;
      continue;
    }
    if (tok === "hundred") {
      current = (current || 1) * 100;
      sawNumber = true;
      continue;
    }
    const n = parseSpokenNumber(tok);
    // Skip STT homophones ("for"/"to"/"too") when parsing amounts — they are
    // far more often prepositions here ("for four dollars" is not 4+4).
    if (n != null && !["for", "fore", "to", "too", "won", "ate"].includes(tok)) {
      current += n;
      sawNumber = true;
      continue;
    }
    // A non-numeric word ends the amount phrase once we've started one.
    if (sawNumber) break;
  }

  total += current;
  return sawNumber ? total : null;
}

/**
 * Which of the known courses does the transcript mention?
 *
 * Matches on a course's DISTINCTIVE tokens (generic words like "golf" /
 * "park" / "club" never match on their own, so "Sharp Park" doesn't light up
 * "Lincoln Park"). Fuzzy word-level matching absorbs light STT damage on
 * longer names; short tokens must match exactly. Returned in known-list order.
 */
export function matchKnownCourses(
  transcript: string,
  knownCourses: string[]
): string[] {
  const GENERIC = new Set([
    "golf", "course", "club", "links", "country", "the", "at", "gc", "cc",
    "municipal", "muni", "national", "resort", "park", "and", "of",
  ]);
  const normT = normalizeName(transcript);
  if (!normT) return [];
  const tWords = normT.split(" ").filter(Boolean);

  const matched: string[] = [];
  for (const course of knownCourses) {
    const normC = normalizeName(course);
    if (!normC) continue;
    // Fast path: the whole normalized name appears verbatim.
    if (normT.includes(normC)) {
      matched.push(course);
      continue;
    }
    const distinct = normC
      .split(" ")
      .filter((w) => w.length >= 3 && !GENERIC.has(w));
    if (distinct.length === 0) continue;
    // Fuzzy only when BOTH sides are substantial — similarity()'s containment
    // boost would otherwise let a stray "a"/"at" light up any longer token.
    const hit = distinct.some((tok) =>
      tWords.some((w) =>
        tok.length >= 5 && w.length >= 4 ? similarity(w, tok) >= 0.84 : w === tok
      )
    );
    if (hit) matched.push(course);
  }
  return matched;
}

function extractWindows(lower: string): Array<{ day: TeeTimeDay; period: TeeTimePeriod | null }> {
  // Day occurrences (a "weekend" mention expands to Saturday + Sunday).
  const dayHits: Array<{ day: TeeTimeDay; index: number }> = [];
  for (const day of DAYS) {
    const re = new RegExp(`\\b${day}s?\\b`, "g");
    for (const m of lower.matchAll(re)) {
      dayHits.push({ day, index: m.index ?? 0 });
    }
  }
  for (const m of lower.matchAll(/\bweekend\b/g)) {
    dayHits.push({ day: "saturday", index: m.index ?? 0 });
    dayHits.push({ day: "sunday", index: m.index ?? 0 });
  }

  // Period occurrences.
  const periodHits: Array<{ period: TeeTimePeriod; index: number }> = [];
  for (const [re, period] of PERIOD_PATTERNS) {
    for (const m of lower.matchAll(re)) {
      periodHits.push({ period, index: m.index ?? 0 });
    }
  }

  // Pair each day with its NEAREST period (non-consuming, so "this weekend
  // morning" gives both Saturday and Sunday a morning window).
  const windows: Array<{ day: TeeTimeDay; period: TeeTimePeriod | null }> = [];
  const seen = new Set<string>();
  dayHits.sort((a, b) => a.index - b.index);
  for (const d of dayHits) {
    let best: { period: TeeTimePeriod; dist: number } | null = null;
    for (const p of periodHits) {
      const dist = Math.abs(p.index - d.index);
      if (dist <= PAIR_DISTANCE && (!best || dist < best.dist)) {
        best = { period: p.period, dist };
      }
    }
    const key = `${d.day}:${best?.period ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    windows.push({ day: d.day, period: best?.period ?? null });
  }
  return windows;
}

// A contiguous run of amount-ish tokens ("eighty five", "a hundred", "120").
// Keeping the capture strict prevents a lazy free-text capture from swallowing
// earlier words ("party of four … under eighty dollars" must not read as $4).
const AMOUNT_TOKEN =
  "(?:\\d+(?:\\.\\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a)";
const AMOUNT_RUN = `(${AMOUNT_TOKEN}(?:\\s+${AMOUNT_TOKEN})*)`;

function extractPartySize(lower: string): number | undefined {
  if (/\bfoursome\b/.test(lower)) return 4;
  if (/\bthreesome\b/.test(lower)) return 3;
  if (/\btwosome\b/.test(lower)) return 2;
  if (/\bjust me\b|\bby myself\b|\bsolo\b/.test(lower)) return 1;

  const patterns = [
    new RegExp(`\\b(?:party|group) of ${AMOUNT_RUN}\\b`),
    new RegExp(`\\b${AMOUNT_RUN} of us\\b`),
    new RegExp(`\\b${AMOUNT_RUN}\\s+(?:players|golfers|people)\\b`),
  ];
  for (const re of patterns) {
    const m = lower.match(re);
    if (!m) continue;
    const n = parseSpokenAmount(m[1]);
    if (n != null && n >= 1 && n <= 8) return n;
  }
  return undefined;
}

function extractDistance(lower: string): { miles?: number; stripped: string } {
  const m = lower.match(new RegExp(`\\b${AMOUNT_RUN}\\s*miles?\\b`));
  if (m) {
    const n = parseSpokenAmount(m[1]);
    if (n != null && n > 0 && n <= 200) {
      // Strip the whole capped phrase (incl. "within"/"under") so the price
      // pass never re-reads "ten" as $10.
      const start = Math.max(0, (m.index ?? 0) - 16);
      const prefix = lower
        .slice(start, m.index ?? 0)
        .match(/\b(?:within|under|inside|less than|no more than|at most)\s*$/);
      const from = prefix ? (m.index ?? 0) - prefix[0].length : m.index ?? 0;
      return {
        miles: n,
        stripped: `${lower.slice(0, from)} ${lower.slice((m.index ?? 0) + m[0].length)}`,
      };
    }
  }
  return { stripped: lower };
}

function extractPrice(lower: string): number | undefined {
  // "$80" / "under $80" — the sign is unambiguous.
  const dollar = lower.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (dollar) {
    const n = parseFloat(dollar[1]);
    if (n > 0) return n;
  }
  // "under eighty dollars" / "no more than 80 bucks".
  const worded = lower.match(new RegExp(`\\b${AMOUNT_RUN}\\s*(?:dollars|bucks)\\b`));
  if (worded) {
    const n = parseSpokenAmount(worded[1]);
    if (n != null && n > 0) return n;
  }
  // A bare "under 80" — price is the only capped quantity without a unit
  // (distance always says "miles" and was stripped above), so read it as a
  // price ceiling.
  const bare = lower.match(
    new RegExp(`\\b(?:under|below|less than|no more than|cheaper than)\\s+${AMOUNT_RUN}\\b`)
  );
  if (bare) {
    const n = parseSpokenAmount(bare[1]);
    if (n != null && n > 0) return n;
  }
  return undefined;
}

const DISPATCH_RE =
  /\b(?:go ahead|find it|book it|send it|do it|lock it in|make it happen|go find (?:me |us )?(?:one|it|a tee time)|fire away|let'?s go)\b/;
const BARE_YES_RE = /^(?:yes|yeah|yep|yup|sure|sounds good|perfect|that works)[.! ]*$/;

/**
 * Deterministic tee-time prefs parse — pure, offline, unit-tested.
 * `known.courses` resolves spoken course names to the listed ones.
 */
export function parseTeeTimePrefsLocally(
  transcript: string,
  known?: TeeTimeKnownContext
): TeeTimePrefsParseResultValidated {
  const clean = normalizeTranscript(transcript || "");
  const lower = clean.toLowerCase();
  const explanations: string[] = [];
  const warnings: string[] = [];

  const windows = extractWindows(lower);
  if (windows.length) explanations.push("Detected day/time window(s).");

  const courseNames = matchKnownCourses(lower, known?.courses ?? []);
  if (courseNames.length) explanations.push("Matched course name(s) against the listed courses.");

  const favoritesOnly = /\b(?:just|only)\s+(?:my\s+|the\s+)?favou?rites?\b|\bfavou?rites?\s+only\b/.test(lower);
  const partySize = extractPartySize(lower);

  // Strip the distance phrase before price so "ten miles" never reads as $10.
  const { miles: maxDistanceMiles, stripped } = extractDistance(lower);
  const maxPriceUsd = extractPrice(stripped);

  const dispatch =
    DISPATCH_RE.test(lower) ||
    (lower.split(/\s+/).filter(Boolean).length <= 3 && BARE_YES_RE.test(lower.trim()));
  if (dispatch) explanations.push("Detected a go-ahead confirmation.");

  const signals =
    windows.length +
    (courseNames.length ? 1 : 0) +
    (favoritesOnly ? 1 : 0) +
    (partySize != null ? 1 : 0) +
    (maxPriceUsd != null ? 1 : 0) +
    (maxDistanceMiles != null ? 1 : 0) +
    (dispatch ? 1 : 0);

  if (signals === 0) warnings.push("Nothing recognized in the utterance.");

  return TeeTimePrefsParseResultSchema.parse({
    windows,
    courseNames,
    favoritesOnly,
    partySize,
    maxPriceUsd,
    maxDistanceMiles,
    dispatch,
    confidence: signals === 0 ? 0.2 : Math.min(0.95, 0.55 + 0.1 * signals),
    explanations: explanations.length ? explanations : undefined,
    warnings: warnings.length ? warnings : undefined,
  });
}

// ─── LLM pass (schema-validated with repair loop, mirrors pipeline.ts) ───────

function zodErrorSummary(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

const DEFAULT_SYSTEM_PROMPT = `You parse a golfer's tee-time request into JSON. Return ONLY a JSON object:
{"windows":[{"day":"saturday","period":"morning"}],"courseNames":[],"favoritesOnly":false,"partySize":4,"maxPriceUsd":80,"maxDistanceMiles":10,"dispatch":false,"confidence":0.9}
- day: full lowercase weekday. period: one of early|morning|midday|afternoon|twilight or null.
- Omit partySize/maxPriceUsd/maxDistanceMiles when not mentioned. Arrays default empty.
- dispatch=true only for explicit go-ahead confirmations ("go ahead", "book it").`;

/**
 * Parse a tee-time prefs utterance. Heuristics first (deterministic, offline);
 * an optional LLM pass with schema validation + repair; local fallback last.
 */
export async function parseTeeTimePrefs(
  options: ParseTeeTimePrefsOptions
): Promise<TeeTimePrefsParseResultValidated> {
  const transcript = normalizeTranscript(options.transcript || "");
  const maxRepairs = options.maxRepairs ?? 2;

  // 1) Deterministic heuristics first.
  const local = parseTeeTimePrefsLocally(transcript, options.known);
  if (hasTeeTimeSignal(local)) return local;

  // 2) No LLM configured → the local result stands (empty parse, low confidence).
  if (!options.llm?.anthropicApiKey) return local;

  // 3) LLM parse with schema validation + repair.
  const baseSystem = options.llm.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const knownHint = options.known?.courses?.length
    ? `\n\nKNOWN COURSES: ${options.known.courses.join(", ")}`
    : "";

  let lastErr: string | null = null;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const system =
      attempt === 0
        ? `${baseSystem}${knownHint}`
        : `${baseSystem}${knownHint}\n\nYour previous output was invalid. Fix it and return ONLY valid JSON that matches the schema.\nValidation errors: ${lastErr}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": options.llm.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: options.llm.model ?? "claude-sonnet-4-20250514",
        max_tokens: options.llm.maxTokens ?? 512,
        system,
        temperature: options.llm.temperature ?? 0,
        messages: [{ role: "user", content: transcript }],
      }),
    });
    if (!response.ok) {
      return {
        ...local,
        warnings: ["LLM request failed", ...(local.warnings ?? [])],
      };
    }

    const raw = (await response.json().catch(() => null)) as {
      content?: Array<{ text?: string }>;
    } | null;
    const text = raw?.content?.[0]?.text ?? "";
    const jsonText = safeJsonExtract(text);
    if (!jsonText) {
      lastErr = "No JSON object found in response";
      continue;
    }

    let obj: unknown;
    try {
      obj = JSON.parse(jsonText) as unknown;
    } catch (e: unknown) {
      lastErr = `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }

    const parsed = TeeTimePrefsParseResultSchema.safeParse(obj);
    if (!parsed.success) {
      lastErr = zodErrorSummary(parsed.error);
      continue;
    }

    // Resolve any raw course names against the known list (same threshold as
    // pipeline.ts course normalization); unknown names are dropped honestly.
    const knownCourses = options.known?.courses ?? [];
    let courseNames = parsed.data.courseNames;
    const warnings = [...(parsed.data.warnings ?? [])];
    if (knownCourses.length && courseNames.length) {
      const resolved: string[] = [];
      for (const name of courseNames) {
        const { match } = fuzzyBestMatch(name, knownCourses, 0.74);
        if (match && !resolved.includes(match)) resolved.push(match);
        else if (!match) warnings.push(`Course "${name}" is not in the listed courses.`);
      }
      courseNames = resolved;
    }
    return {
      ...parsed.data,
      courseNames,
      warnings: warnings.length ? Array.from(new Set(warnings)) : undefined,
    };
  }

  // 4) Final fallback.
  return {
    ...local,
    warnings: [
      "Could not validate LLM output; fell back to local parser.",
      ...(local.warnings ?? []),
    ],
  };
}
