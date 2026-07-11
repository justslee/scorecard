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
import type { ResolvedCandidate, ResolvedCourse, SpokenCourseResolution } from "@/lib/teetime/course-resolve";
import type { PendingCourseClarify, ClarifyReplyMatch } from "@/lib/teetime/course-clarify";

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
  /** A3: non-null when this utterance was routed (by `routeClarifyReply`) as
   *  the reply to an outstanding ambiguous-course question. null = no clarify
   *  turn in play. */
  clarify: { pending: PendingCourseClarify; match: ClarifyReplyMatch } | null;
}

/** parsed (+ optional spoken-course resolution / clarify routing) → the
 *  contract's TaskParse. Pure.
 *
 *  A clarify turn ALWAYS carries signal at a confident-enough level to reach
 *  the apply gate — the matcher is deterministic (it already decided
 *  picked/ambiguous/none), so a re-ask or bail must run in the task lane,
 *  never gate (b)'s confirm-only path and never the converse fall-through. */
export function teeTimeTaskParse(
  transcript: string,
  parsed: TeeTimePrefsParseResultValidated,
  resolution: SpokenCourseResolution | null = null,
  clarify: { pending: PendingCourseClarify; match: ClarifyReplyMatch } | null = null,
): TaskParse {
  const payload: TeeTimeTaskPayload = { parsed, resolution, clarify };
  return {
    transcript,
    hasSignal: clarify != null ? true : hasTeeTimeSignal(parsed),
    confidence: clarify != null ? Math.max(parsed.confidence, 0.9) : parsed.confidence,
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
  /** A3: non-null while an ambiguous-course question is outstanding. Every
   *  branch computes this (normal branches → null) — the page assigns it
   *  unconditionally, so any applied turn that isn't itself an ask clears a
   *  stale pending. */
  pendingClarify: PendingCourseClarify | null;
  /** A3: true → the host reopens the mic for one hands-free follow-up turn.
   *  Only ever true alongside `dispatched:false`. */
  expectReply: boolean;
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

/** Join localities as "A", "A, or B", or "A, B, or C" — a spoken question
 *  reads naturally with "or" between the choices. */
function joinOr(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]}, or ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

/** The honest label for a candidate in spoken copy — its real locality, or
 *  (never fabricated) the course name itself when there's no honest
 *  locality to show. */
function candidateLabel(c: ResolvedCandidate): string {
  return c.localityLabel || c.name;
}

/**
 * Shared A2/A3 add-flow: place a resolved course onto the list, honoring the
 * touched/untouched GPS-preselect rule, and return the honest "Found …" note.
 * Used both by A2's single-resolution auto-add and A3's clarify pick — a
 * clarify pick is synthesized into the SAME `ResolvedCourse` shape so the two
 * paths share one implementation (no drift between them).
 */
function applyResolvedCourseAdd(
  resolved: ResolvedCourse,
  baseCourses: CourseOption[],
  current: { origin?: { lat: number; lng: number } | null; touched?: boolean },
): { courses: CourseOption[]; note: string } {
  const option = courseOptionFromSelection(
    {
      id: resolved.id,
      name: resolved.name,
      location: resolved.location,
      center: resolved.center,
      favorite: false,
    },
    current.origin ?? null,
  );
  const base = current.touched
    ? baseCourses
    : baseCourses.map((c) => (c.selected ? { ...c, selected: false } : c));
  const courses = addCourseOption(base, option);

  const where = option.muni ? ` in ${option.muni}` : "";
  const far =
    option.distance != null
      ? ` — ${option.distance < 10 ? option.distance.toFixed(1) : Math.round(option.distance)} mi away`
      : "";
  const note = `Found ${displayCourseName(resolved.name)}${where}${far}.`;
  return { courses, note };
}

/** A3: the initial clarify ask, naming the real localities so the golfer can
 *  answer with a place, not a guess ("Marine Park — Brooklyn, NY, or Old
 *  Bridge, NJ. Which one?"). */
function ambiguousAskLine(name: string, candidates: ResolvedCandidate[]): string {
  const localities = joinOr(candidates.map(candidateLabel));
  return `I found a few courses called ${displayCourseName(name)} — ${localities}. Which one?`;
}

/** A3: the honest re-ask after a reply that matched none or several
 *  candidates — repeats the real choices, never guesses. */
function clarifyReAskLine(candidates: ResolvedCandidate[]): string {
  const localities = joinOr(candidates.map(candidateLabel));
  return `Sorry — which one: ${localities}? You can say "the first one."`;
}

/** A3: the graceful bail once the 2-ask budget is spent — never a fake pick. */
const CLARIFY_BAIL_LINE =
  "No worries — I’ll leave it for now. You can add it from the course list, or name the area again anytime.";

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
  /** A3: non-null when this utterance was routed as the reply to an
   *  outstanding ambiguous-course question (`routeClarifyReply`). null = no
   *  clarify turn in play — the normal A0/A2 path runs unchanged. */
  clarify: { pending: PendingCourseClarify; match: ClarifyReplyMatch } | null = null,
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

  // A3 — a clarify reply that PICKED a candidate: the pick IS the resolution.
  // Skip the unresolvedCourseNames gate entirely (a repeated/locality-tagged
  // name in the reply must not re-trip A0's honest-miss gate) and reuse the
  // A2 add-flow via the synthesized ResolvedCourse. Dispatch iff the ORIGINAL
  // turn was armed (had a window/go-ahead) or this reply adds one.
  if (clarify?.match.kind === "picked") {
    const candidate = clarify.match.candidate;
    const syntheticCourse: ResolvedCourse = {
      id: candidate.id,
      name: candidate.name,
      center: candidate.center,
      location: candidate.address,
    };
    const added = applyResolvedCourseAdd(syntheticCourse, courses ?? current.courses, current);
    courses = added.courses;
    const dispatched = clarify.pending.armed || parsed.windows.length > 0 || parsed.dispatch;
    const line = `${added.note}${dispatched ? " On it." : ""}`;
    return {
      windows, courses, maxMiles, group, maxPriceUsd, line, dispatched,
      pendingClarify: null, expectReply: false,
    };
  }

  // A3 — a clarify reply that matched NOTHING or SEVERAL candidates: one
  // honest re-ask, then a graceful bail. Hard budget: 2 asks total (the
  // initial ask + one re-ask). Never dispatches a guess.
  if (clarify) {
    const pending = clarify.pending;
    if (pending.attempts + 1 < 2) {
      return {
        windows, courses, maxMiles, group, maxPriceUsd,
        line: clarifyReAskLine(pending.candidates),
        dispatched: false,
        pendingClarify: { ...pending, attempts: pending.attempts + 1 },
        expectReply: true,
      };
    }
    return {
      windows, courses, maxMiles, group, maxPriceUsd,
      line: CLARIFY_BAIL_LINE,
      dispatched: false,
      pendingClarify: null,
      expectReply: false,
    };
  }

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
    const added = applyResolvedCourseAdd(resolvedOne, courses ?? current.courses, current);
    courses = added.courses;
    resolvedNote = added.note;
  }

  // A3 — a single spoken name resolved to 2+ real candidates: ASK which one,
  // holding them as pending page state instead of dispatching a guess. Empty
  // candidates (defensive) keeps the old generic line and never sets pending.
  let pendingClarify: PendingCourseClarify | null = null;
  let expectReply = false;
  let ambiguousAsk: string | null = null;
  if (unresolvedNames.length === 1 && !resolvedOne && resolution?.kind === "ambiguous" && resolution.candidates.length > 0) {
    ambiguousAsk = ambiguousAskLine(unresolvedNames[0], resolution.candidates);
    pendingClarify = {
      name: unresolvedNames[0],
      candidates: resolution.candidates,
      armed: parsed.windows.length > 0 || parsed.dispatch,
      attempts: 0,
    };
    expectReply = true;
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
      ? (ambiguousAsk ?? unresolvedCourseLine(unresolvedNames, resolution))
      : null;

  const dispatched =
    unresolvedNote == null &&
    courseMissNote == null &&
    (parsed.windows.length > 0 || parsed.dispatch);

  // A resolved course that will be searched appends the caddie's ONE canonical
  // action tag ("On it." — voice-prefs.ts, honest about the ~1.4s dispatch beat
  // the page arms); one added without a day/time is simply added, nothing
  // dispatched, so no action tag.
  const resolvedLine = resolvedNote
    ? `${resolvedNote}${dispatched ? " On it." : ""}`
    : null;

  const line =
    unresolvedNote ?? resolvedLine ?? courseMissNote ?? teeTimeAckLine(parsed) ?? "Got it.";

  return {
    windows, courses, maxMiles, group, maxPriceUsd, line, dispatched,
    pendingClarify, expectReply,
  };
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
