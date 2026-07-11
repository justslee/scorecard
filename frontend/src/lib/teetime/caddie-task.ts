/**
 * Tee-time ↔ caddie-context glue (specs/orb-s2-context-contract-teetime-plan.md §7.2).
 *
 * Pure functions turning the page's own deterministic parse into the generic
 * contract's `TaskParse`/`TaskAck` shapes, and computing exactly what the old
 * private `applyParsed` (page.tsx) computed — minus the setters and the
 * dispatch timer, which stay in the page (the page owns state + the timer;
 * this module only computes what to do with them). Imports ONLY the
 * untouched libs (`voice-prefs.ts`, `parseTeeTimePrefs.ts`) plus the shared
 * add-flow (`courses.ts`) that A2's voice-resolved course reuses.
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
import {
  courseOptionFromSelection,
  addCourseOption,
  type CourseOption,
} from "@/lib/teetime/courses";
import type { SpokenCourseResolution } from "@/lib/teetime/course-resolve";

/**
 * The opaque payload the tee-time task hands the host through TaskParse and
 * back into apply(): the deterministic parse plus, when the utterance named a
 * course we couldn't match on-screen, the async resolution of that name (A2).
 * The host never inspects it (§8) — only planTeeTimeApply does.
 */
export interface TeeTimeTaskPayload {
  parsed: TeeTimePrefsParseResultValidated;
  /** null = no spoken-course resolution attempted (no unresolved name, or more
   *  than one — A2 resolves a single spoken name). */
  resolution: SpokenCourseResolution | null;
}

/** parsed (+ optional spoken-course resolution) → the contract's TaskParse. Pure. */
export function teeTimeTaskParse(
  transcript: string,
  parsed: TeeTimePrefsParseResultValidated,
  resolution: SpokenCourseResolution | null = null,
): TaskParse {
  const payload: TeeTimeTaskPayload = { parsed, resolution };
  return {
    transcript,
    hasSignal: hasTeeTimeSignal(parsed),
    confidence: parsed.confidence,
    ack: teeTimeConfirmEcho(parsed),
    payload,
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
  line: string;                        // unresolvedNote ?? resolvedLine ?? courseMissNote ?? teeTimeAckLine(parsed) ?? "Got it."
  dispatched: boolean;                 // false whenever a named course is unresolved / missed (A2: true once resolved to one)
}

/** Title-case a spoken (lowercase) course name for an honest ack — "marine
 *  park" → "Marine Park". Pure; leaves already-capitalized input alone. */
function displayCourseName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Join names as "A", "A and B", or "A, B and C". */
function joinNames(names: string[]): string {
  const parts = names.map(displayCourseName);
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function planTeeTimeApply(
  parsed: TeeTimePrefsParseResultValidated,
  current: {
    windows: VoicePrefWindow[];
    courses: CourseOption[];
    maxMiles: number;
    group: VoicePrefMember[];
    /** GPS origin for honest distance on a voice-resolved course; null = unknown. */
    origin?: { lat: number; lng: number } | null;
    /** Has the golfer already toggled/added a course? Gates whether a resolved
     *  add deselects the GPS auto-preselects (untouched) or preserves the
     *  golfer's own picks (touched). Defaults false (untouched). */
    touched?: boolean;
  },
  /** A2: the async resolution of a single spoken course name, when the utterance
   *  named a course we couldn't match on-screen. null = none attempted. */
  resolution: SpokenCourseResolution | null = null,
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

  // A2 — the resolved course wins. When the utterance named exactly one course
  // we couldn't place on-screen and the unified search resolved it to a single
  // real facility, ADD it and select it. When the golfer hasn't yet touched the
  // list, the GPS auto-preselects were never a deliberate choice — deselect them
  // so the search targets the course they actually named; their OWN prior
  // toggles (touched) survive untouched. Distance stays honest (its real number,
  // never a ≤50-mile pretense) — the Brooklyn course reads "350 mi away".
  const unresolvedNames = parsed.unresolvedCourseNames;
  const resolvedOne =
    unresolvedNames.length === 1 && resolution?.kind === "one" ? resolution.course : null;

  let resolvedNote: string | null = null;
  if (resolvedOne) {
    const option = courseOptionFromSelection(
      {
        id: resolvedOne.id,
        name: resolvedOne.name,
        location: resolvedOne.location,
        center: resolvedOne.center,
        favorite: false,
      },
      current.origin ?? null,
    );
    const base0 = courses ?? current.courses;
    const base = current.touched
      ? base0
      : base0.map((c) => (c.selected ? { ...c, selected: false } : c));
    courses = addCourseOption(base, option);

    const where = option.muni ? ` in ${option.muni}` : "";
    const far =
      option.distance != null
        ? ` — ${option.distance < 10 ? option.distance.toFixed(1) : Math.round(option.distance)} mi away`
        : "";
    resolvedNote = `Found ${displayCourseName(resolvedOne.name)}${where}${far}.`;
  }

  // A0 — stop the lie: a sentence that NAMES a course we can't place must never
  // dispatch a search that ignores it (the Marine-Park-from-Pittsburgh bug). A
  // named-but-unresolved course — or a total miss on a listed name — gates the
  // dispatch and acks honestly. A2 differentiates the honest line by WHY the
  // name is still unplaced (searched-and-missing vs search-unreachable vs
  // several-matches vs never-searched), and lifts the gate only for a clean
  // single resolution.
  const unresolvedNote =
    unresolvedNames.length > 0 && !resolvedOne
      ? unresolvedCourseLine(unresolvedNames, resolution)
      : null;

  const dispatched =
    unresolvedNote == null &&
    courseMissNote == null &&
    (parsed.windows.length > 0 || parsed.dispatch);

  // A resolved course that will be searched now says so; one added without a
  // day/time is simply added (honest — nothing was dispatched).
  const resolvedLine = resolvedNote
    ? `${resolvedNote}${dispatched ? " Looking there now." : ""}`
    : null;

  const line =
    unresolvedNote ?? resolvedLine ?? courseMissNote ?? teeTimeAckLine(parsed) ?? "Got it.";

  return { windows, courses, maxMiles, group, maxPriceUsd, line, dispatched };
}

/**
 * The honest one-line ack when a spoken course name stays unplaced. A2 tailors
 * it to WHY: searched and genuinely not found, search couldn't be reached, or
 * several facilities matched (the clarify turn is A3, so for now we just ask
 * and don't dispatch a guess). With no resolution attempted (more than one name
 * spoken), it keeps A0's honest "not on your list" line unchanged.
 */
function unresolvedCourseLine(
  names: string[],
  resolution: SpokenCourseResolution | null,
): string {
  const label = joinNames(names);
  switch (resolution?.kind) {
    case "unreachable":
      return `I couldn’t reach course search just now — want to try again, or add ${label} by name?`;
    case "ambiguous":
      return `I found a few courses called ${label} — which area did you mean?`;
    case "none":
      return `I couldn’t find a course called ${label} — want to spell it out, or add it from search?`;
    default:
      // No resolution attempted (e.g. more than one spoken name) — A0's line.
      return `I don’t know a course called ${label} — nothing on your list matches. Want to add it, or search the list?`;
  }
}
