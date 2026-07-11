/**
 * Tee-time ↔ caddie-context glue (specs/orb-s2-context-contract-teetime-plan.md §7.2).
 *
 * Pure functions turning the page's own deterministic parse into the generic
 * contract's `TaskParse`/`TaskAck` shapes, and computing exactly what the old
 * private `applyParsed` (page.tsx) computed — minus the setters and the
 * dispatch timer, which stay in the page (the page owns state + the timer;
 * this module only computes what to do with them). Imports ONLY the
 * untouched libs (`voice-prefs.ts`, `parseTeeTimePrefs.ts`).
 */

import type { TaskParse } from "@/lib/caddie-context";
import { hasTeeTimeSignal } from "@/lib/voice/parseTeeTimePrefs";
import type { TeeTimePrefsParseResultValidated } from "@/lib/voice/schemas";
import {
  applyParsedWindows,
  applyParsedCourses,
  applyPartySize,
  teeTimeAckLine,
  type VoicePrefWindow,
  type VoicePrefMember,
} from "@/lib/teetime/voice-prefs";
import type { CourseOption } from "@/lib/teetime/courses";

/** parsed → the contract's TaskParse. Pure. */
export function teeTimeTaskParse(
  transcript: string,
  parsed: TeeTimePrefsParseResultValidated,
): TaskParse {
  return {
    transcript,
    hasSignal: hasTeeTimeSignal(parsed),
    confidence: parsed.confidence,
    ack: teeTimeConfirmEcho(parsed),
    payload: parsed,
  };
}

/**
 * Neutral echo for the low-confidence confirm line — teeTimeAckLine's summary
 * with its action framing removed ("— on it." / "Got it — ") so a line that
 * did NOT act never claims it did. Derived, not duplicated: teeTimeAckLine
 * stays the single formatter; format-locking tests below break loudly if its
 * two shapes ever change. (Unreachable for today's tee-time parses — any
 * local signal ⇒ confidence ≥0.65 and the page passes no LLM key — but the
 * contract field must be honest under S3+ LLM parsers.)
 */
export function teeTimeConfirmEcho(parsed: TeeTimePrefsParseResultValidated): string {
  const line = teeTimeAckLine(parsed);
  if (!line) return "not much, honestly";
  return line.replace(/\s*—\s*on it\.$/, "").replace(/^Got it — /, "").replace(/\.$/, "");
}

/** Everything applyParsed COMPUTED, minus the setters and the timer. Pure.
 *  null = leave that pref untouched. Body is today's page.tsx:413-446 verbatim,
 *  ordering preserved: windows → courses (+miss note, + radius widening) →
 *  explicit maxDistanceMiles (wins over widening, as the last setState did) →
 *  party → price → line → dispatched. */
export interface TeeTimeApplyPlan {
  windows: VoicePrefWindow[] | null;
  courses: CourseOption[] | null;      // null on total course-name miss (=== sentinel respected)
  maxMiles: number | null;
  group: VoicePrefMember[] | null;
  maxPriceUsd: number | null;
  line: string;                        // courseMissNote ?? teeTimeAckLine(parsed) ?? "Got it."
  dispatched: boolean;                 // parsed.windows.length > 0 || parsed.dispatch
}

export function planTeeTimeApply(
  parsed: TeeTimePrefsParseResultValidated,
  current: { windows: VoicePrefWindow[]; courses: CourseOption[]; maxMiles: number; group: VoicePrefMember[] },
): TeeTimeApplyPlan {
  const windows =
    parsed.windows.length > 0 ? applyParsedWindows(current.windows, parsed.windows) : null;

  let courses: CourseOption[] | null = null;
  let courseMissNote: string | null = null;
  let widenedMaxMiles: number | null = null;
  if (parsed.courseNames.length > 0 || parsed.favoritesOnly) {
    const next = applyParsedCourses(current.courses, parsed.courseNames, parsed.favoritesOnly);
    if (parsed.courseNames.length > 0 && next === current.courses) {
      courseMissNote = `Couldn’t find ${parsed.courseNames.join(", ")} on your list — kept your picks.`;
      courses = null; // total miss — nothing to apply (=== sentinel respected)
    } else {
      courses = next;
    }
    const farthest = Math.max(
      0,
      ...next.filter((c) => c.selected && c.distance != null).map((c) => c.distance ?? 0),
    );
    if (parsed.courseNames.length > 0 && farthest > current.maxMiles) {
      widenedMaxMiles = Math.min(50, Math.ceil(farthest));
    }
  }

  const explicitMaxMiles =
    parsed.maxDistanceMiles != null
      ? Math.max(1, Math.min(50, Math.round(parsed.maxDistanceMiles)))
      : null;
  const maxMiles = explicitMaxMiles ?? widenedMaxMiles;

  const group = parsed.partySize != null ? applyPartySize(current.group, parsed.partySize) : null;
  const maxPriceUsd = parsed.maxPriceUsd ?? null;

  const line = courseMissNote ?? teeTimeAckLine(parsed) ?? "Got it.";
  const dispatched = parsed.windows.length > 0 || parsed.dispatch;

  return { windows, courses, maxMiles, group, maxPriceUsd, line, dispatched };
}
