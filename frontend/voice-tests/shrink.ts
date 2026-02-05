import type { CommandLaneScenario } from "./schema";

function normalizeSpaces(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

const FILLERS = ["uh", "um", "like", "okay", "alright", "please"];

/**
 * Produce simpler variants of an utterance (best-effort).
 * We keep the same scenario metadata, only changing `utterance`.
 */
export function shrinkUtterance(s: CommandLaneScenario): CommandLaneScenario[] {
  const u = s.utterance;
  const variants: string[] = [];

  variants.push(u);
  variants.push(normalizeSpaces(u.toLowerCase()));
  variants.push(normalizeSpaces(u.replace(/[.,!?;:]/g, "")));

  // strip fillers
  {
    let t = ` ${u} `;
    for (const f of FILLERS) {
      const re = new RegExp(`\\b${f}\\b`, "gi");
      t = t.replace(re, " ");
    }
    variants.push(normalizeSpaces(t));
  }

  // Avoid token-drop shrinking for now; it often removes the key intent words and produces
  // an unhelpful minimized utterance. Keep shrinking semantic-preserving transforms only.
  return uniqScenarios(s, variants);
}

function uniqScenarios(base: CommandLaneScenario, utterances: string[]): CommandLaneScenario[] {
  const seen = new Set<string>();
  const out: CommandLaneScenario[] = [];
  for (const u of utterances) {
    const uu = normalizeSpaces(u);
    if (!uu) continue;
    if (seen.has(uu)) continue;
    seen.add(uu);
    out.push({ ...base, utterance: uu });
  }
  return out;
}

/**
 * Minimal shrinking loop:
 * - given a failing scenario, try a fixed set of simpler utterance variants
 * - keep the smallest utterance (length) that still fails.
 */
export async function shrinkFailingScenario(
  scenario: CommandLaneScenario,
  fails: (s: CommandLaneScenario) => Promise<boolean>
): Promise<CommandLaneScenario> {
  let best = scenario;

  const candidates = shrinkUtterance(scenario).sort(
    (a, b) => a.utterance.length - b.utterance.length
  );

  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const isFail = await fails(c);
    if (isFail && c.utterance.length < best.utterance.length) {
      best = c;
    }
  }

  return best;
}
