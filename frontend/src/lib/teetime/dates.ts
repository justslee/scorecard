/**
 * Tee-time date helpers — pure functions, no browser APIs.
 *
 * The prefs UI collects time windows labelled by day ("Saturday early",
 * "Sunday early", …). Each window must search its OWN day's date — a Sunday
 * window must not inherit Saturday's date (the old `nextSaturday()` bug).
 */

const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
] as const;

/** Format a Date as YYYY-MM-DD in LOCAL time (toISOString would drift a day near midnight). */
export function toISODateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse a weekday from a window label ("Saturday", "sun", "Sunday early").
 * Returns 0 (Sunday) … 6 (Saturday), or null when the label names no weekday.
 */
export function weekdayFromLabel(label: string): number | null {
  const lower = label.trim().toLowerCase();
  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (lower.startsWith(WEEKDAYS[i]) || lower.startsWith(WEEKDAYS[i].slice(0, 3))) {
      return i;
    }
  }
  return null;
}

/**
 * Next occurrence of a weekday as YYYY-MM-DD, strictly in the future —
 * if `from` already IS that weekday we jump a full week (same semantics the
 * page's original `nextSaturday()` had, so "Saturday" on a Saturday evening
 * never searches a window that has already passed).
 */
export function nextDateForWeekday(weekday: number, from: Date = new Date()): string {
  const d = new Date(from);
  const diff = (weekday - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return toISODateLocal(d);
}

/**
 * Target date for a prefs window: the next occurrence of the day its label
 * names. Labels with no weekday ("Custom") fall back to next Saturday — the
 * default dispatch day.
 */
export function dateForWindowLabel(label: string, from: Date = new Date()): string {
  const weekday = weekdayFromLabel(label);
  return nextDateForWeekday(weekday ?? 6, from);
}

/** Capitalized weekday name: 0 → "Sunday" … 6 → "Saturday". */
export function weekdayName(weekday: number): string {
  const w = WEEKDAYS[((weekday % 7) + 7) % 7];
  return w[0].toUpperCase() + w.slice(1);
}

/** Shape the prefs screen's TimeWindow needs — kept structural (no import
 *  from the page) so this stays a leaf, browser-free module. */
export interface DefaultTimeWindow {
  id: string;
  label: string;
  sub: string;
  start: string;
  end: string;
  date: string;
  selected: boolean;
}

/**
 * The starter windows the prefs screen opens with — Saturday early/midday +
 * Sunday early — each stamped with its OWN real ISO date. A factory (not a
 * module constant) because "next Saturday" depends on when it's called.
 */
export function defaultWindows(from: Date = new Date()): DefaultTimeWindow[] {
  return [
    { id: "sat-am", label: "Saturday", sub: "early",  start: "06:30", end: "09:30", selected: true,  date: nextDateForWeekday(6, from) },
    { id: "sat-pm", label: "Saturday", sub: "midday", start: "11:00", end: "14:00", selected: false, date: nextDateForWeekday(6, from) },
    { id: "sun-am", label: "Sunday",   sub: "early",  start: "07:00", end: "10:00", selected: true,  date: nextDateForWeekday(0, from) },
  ];
}

function overlapsRange(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start < b.end && b.start < a.end;
}

interface SlotTemplate { weekday: number; start: string; end: string; sub: string }

/** Rotation tried in order for "+ Add another window" — Sat/Sun across the
 *  day's natural blocks, so repeat taps never stamp the same slot twice. */
const DEFAULT_SLOT_TEMPLATES: SlotTemplate[] = [
  { weekday: 6, start: "06:30", end: "09:30", sub: "early" },
  { weekday: 0, start: "07:00", end: "10:00", sub: "early" },
  { weekday: 6, start: "11:00", end: "14:00", sub: "midday" },
  { weekday: 0, start: "11:00", end: "14:00", sub: "midday" },
  { weekday: 6, start: "14:00", end: "17:00", sub: "afternoon" },
  { weekday: 0, start: "14:00", end: "17:00", sub: "afternoon" },
  { weekday: 5, start: "16:00", end: "19:00", sub: "twilight" },
  { weekday: 6, start: "16:00", end: "19:00", sub: "twilight" },
];

export interface DefaultWindowSlot {
  label: string;
  sub: string;
  start: string;
  end: string;
  date: string;
}

/**
 * "+ Add another window" — the first slot template whose weekday + time
 * range doesn't overlap anything already on the list, so a second (third, …)
 * add is always a DIFFERENT editable window, never a duplicate stamp.
 * Exhausting every template (unlikely) falls back to a plain custom slot.
 */
export function nextDefaultWindow(
  existing: Array<{ label: string; start: string; end: string }>,
  from: Date = new Date(),
): DefaultWindowSlot {
  const free = DEFAULT_SLOT_TEMPLATES.find(
    (t) => !existing.some((w) => weekdayFromLabel(w.label) === t.weekday && overlapsRange(w, t)),
  );
  const slot = free ?? { weekday: 6, start: "08:00", end: "11:00", sub: "custom" };
  return {
    label: weekdayName(slot.weekday),
    sub: slot.sub,
    start: slot.start,
    end: slot.end,
    date: nextDateForWeekday(slot.weekday, from),
  };
}
