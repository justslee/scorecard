/**
 * Voice → prefs application for the /tee-time screen.
 *
 * Pure functions that turn a parsed "Hold to talk" utterance
 * (`parseTeeTimePrefs`) into updates on the page's prefs state: which windows
 * are selected, which courses, how many are playing. Kept out of the page so
 * the voice path is unit-testable end-to-end (parse → apply).
 */

import type {
  TeeTimePrefsParseResultValidated,
} from "@/lib/voice/schemas";
import type { TeeTimeDay, TeeTimePeriod } from "@/lib/voice/parseTeeTimePrefs";
import { weekdayFromLabel } from "./dates";
import type { CourseOption } from "./courses";

/** Structurally identical to the page's TimeWindow / GroupMember shapes. */
export interface VoicePrefWindow {
  id: string;
  label: string;
  sub: string;
  start: string;
  end: string;
  selected: boolean;
}

export interface VoicePrefMember {
  id: string;
  name: string;
  hdcp: number;
  init: string;
  confirmed: boolean;
  self: boolean;
}

const DAY_INDEX: Record<TeeTimeDay, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/** Concrete times for each spoken period ("morning" → 07:00–11:00). */
export const PERIOD_TIMES: Record<TeeTimePeriod, { start: string; end: string }> = {
  early:     { start: "06:30", end: "09:30" },
  morning:   { start: "07:00", end: "11:00" },
  midday:    { start: "11:00", end: "14:00" },
  afternoon: { start: "12:00", end: "16:00" },
  twilight:  { start: "16:00", end: "19:00" },
};

function overlaps(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start < b.end && b.start < a.end;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Apply spoken windows to the prefs list. The utterance is the source of
 * truth for WHEN: matching existing windows are selected, everything else is
 * deselected, and a window is created when nothing on the list fits
 * ("Friday twilight"). No spoken windows → the list is returned untouched.
 */
export function applyParsedWindows(
  existing: VoicePrefWindow[],
  parsed: Array<{ day: TeeTimeDay; period: TeeTimePeriod | null }>,
): VoicePrefWindow[] {
  if (parsed.length === 0) return existing;

  const next = existing.map((w) => ({ ...w, selected: false }));
  const additions: VoicePrefWindow[] = [];

  for (const p of parsed) {
    const times = p.period ? PERIOD_TIMES[p.period] : null;
    const match = next.find(
      (w) =>
        weekdayFromLabel(w.label) === DAY_INDEX[p.day] &&
        (times === null || overlaps(w, times)),
    );
    if (match) {
      match.selected = true;
    } else {
      additions.push({
        id: `voice-${p.day}-${p.period ?? "day"}`,
        label: capitalize(p.day),
        sub: p.period ?? "any time",
        start: times?.start ?? "07:00",
        end: times?.end ?? "17:00",
        selected: true,
      });
    }
  }
  return [...next, ...additions];
}

/**
 * Apply spoken course choices. Named courses replace the selection;
 * "just my favorites" selects exactly the favorites. Neither → untouched.
 */
export function applyParsedCourses(
  courses: CourseOption[],
  courseNames: string[],
  favoritesOnly: boolean,
): CourseOption[] {
  if (courseNames.length > 0) {
    const wanted = new Set(courseNames.map((n) => n.toLowerCase()));
    return courses.map((c) => ({ ...c, selected: wanted.has(c.name.toLowerCase()) }));
  }
  if (favoritesOnly) {
    return courses.map((c) => ({ ...c, selected: c.favorite }));
  }
  return courses;
}

/**
 * Resize the group to a spoken party size by adding/removing "+1" guest
 * placeholders. Real people (self + invited) are NEVER removed — a spoken
 * size below the real headcount just drops the guests.
 */
export function applyPartySize(
  group: VoicePrefMember[],
  partySize: number,
): VoicePrefMember[] {
  const size = Math.max(1, Math.min(8, Math.round(partySize)));
  const real = group.filter((m) => !m.id.startsWith("guest-"));
  const guestsNeeded = Math.max(0, size - real.length);
  const guests: VoicePrefMember[] = Array.from({ length: guestsNeeded }, (_, i) => ({
    id: `guest-${i + 1}`,
    name: `Guest ${i + 1}`,
    hdcp: 0,
    init: "+1",
    confirmed: false,
    self: false,
  }));
  return [...real, ...guests];
}

/** "A, B, and C" — reads like a person wrote it. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** Strip "Golf Course"-style suffixes so the ack reads like speech. */
function shortCourseName(name: string): string {
  return name.replace(/\s+(golf\s+(course|club|links)|country club)\s*$/i, "").trim() || name;
}

/**
 * The looper's calm one-line acknowledgement of what it understood.
 * Returns null when the parse recognized nothing (caller shows the gentle
 * fallback line instead — never an error state).
 */
export function teeTimeAckLine(parsed: TeeTimePrefsParseResultValidated): string | null {
  const bits: string[] = [];
  if (parsed.windows.length > 0) {
    bits.push(
      joinList(
        parsed.windows.map((w) =>
          w.period ? `${capitalize(w.day)} ${w.period}` : capitalize(w.day),
        ),
      ),
    );
  }
  if (parsed.courseNames.length > 0) {
    bits.push(`at ${joinList(parsed.courseNames.map(shortCourseName))}`);
  } else if (parsed.favoritesOnly) {
    bits.push("your favorites only");
  }
  if (parsed.partySize != null) bits.push(`party of ${parsed.partySize}`);
  if (parsed.maxPriceUsd != null) bits.push(`under $${Math.round(parsed.maxPriceUsd)}`);
  if (parsed.maxDistanceMiles != null) bits.push(`within ${Math.round(parsed.maxDistanceMiles)} miles`);

  if (bits.length === 0) {
    return parsed.dispatch ? "On it — going to look now." : null;
  }
  const summary = `${bits[0]}${bits.length > 1 ? `, ${bits.slice(1).join(", ")}` : ""}`;
  // A spoken day/time (or a go-ahead) sends the looper straight out.
  const goes = parsed.windows.length > 0 || parsed.dispatch;
  return goes ? `${capitalize(summary)} — on it.` : `Got it — ${summary}.`;
}
