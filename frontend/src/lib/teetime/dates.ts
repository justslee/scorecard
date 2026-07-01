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
