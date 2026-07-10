/**
 * Options phase — pure logic for the results/prefs UX fixes
 * (specs/teetime-show-real-time-options-plan.md).
 *
 * The Searching phase fans a dispatch out into one or more provider queries
 * and comes back with a flat `TeeTimeSlot[]` that mixes REAL bookable times
 * (foreup today, mock in dev — `route == null && time !== ""`) with call/
 * book-on-site ROUTE ENTRIES for every other public course (`time === ""`).
 * This module turns that flat list into what the Options screen renders —
 * grouped per course, defended against an unselected course slipping through
 * (bug #3), and never presenting a search window as a found time (bug #1).
 *
 * `DispatchedAsk` is the other half of the fix (bug #2): it's a 1:1
 * projection of the queries ACTUALLY sent, threaded through to both Options
 * and Confirmed so the window shown anywhere post-dispatch is, by
 * construction, the window that was submitted — never re-derived from live
 * prefs state (which can hold deselected defaults that win a `find()` race).
 */

import type { TeeTimeSlot } from "./types";

// ─── The real-slot vs call-route discriminator ────────────────────────────────

/**
 * `true` for a REAL bookable time (foreup today, mock in dev); `false` for a
 * route entry (`route === "book_on_site" | "call"`, `time === ""`) — a
 * course we found, not a found time. Key on `route`/`time`, never on the
 * `provider` string (future providers keep working).
 */
export function isRealSlot(s: TeeTimeSlot): boolean {
  return s.route == null && s.time !== "";
}

// ─── Time formatting (moved from page.tsx so Options/Confirmed share it) ──────

/** "07:10" → "7:10 AM" */
export function formatTime12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}

/** "07:00" + "10:00" → "7:00–10:00 AM"; different periods → "11:00 AM–1:00 PM". */
export function formatWindowRange(start: string, end: string): string {
  const [sh] = start.split(":").map(Number);
  const [eh] = end.split(":").map(Number);
  const sPeriod = sh < 12 ? "AM" : "PM";
  const ePeriod = eh < 12 ? "AM" : "PM";
  const startLabel = formatTime12h(start);
  const endLabel = formatTime12h(end);
  return sPeriod === ePeriod
    ? `${startLabel.replace(` ${sPeriod}`, "")}–${endLabel}`
    : `${startLabel}–${endLabel}`;
}

// ─── Dispatched asks — the SUBMITTED prefs, not re-derived state ──────────────

/** One dispatched query's window, projected 1:1 from a `TeeTimeQuery`. */
export interface DispatchedAsk {
  date: string;
  start: string;
  end: string;
}

/** Every dispatched ask that searched a given date. */
export function asksForDate(asks: DispatchedAsk[], date: string): DispatchedAsk[] {
  return asks.filter((a) => a.date === date);
}

/**
 * "6:30–9:30 AM", or "6:30–9:30 AM or 11:00 AM–2:00 PM" when two selected
 * windows share the date. Empty input → "" (caller decides the fallback).
 */
export function formatAskWindows(asks: DispatchedAsk[]): string {
  if (asks.length === 0) return "";
  const ranges = Array.from(new Set(asks.map((a) => formatWindowRange(a.start, a.end))));
  return ranges.join(" or ");
}

// ─── Normalization (mirrors the tolerant spirit of the backend's
//     `matches_selection` — lowercase, trim, collapse whitespace/punctuation) ──

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Grouping — per-course cards for the Options screen ───────────────────────

export interface CourseGroup {
  courseId: string;
  courseName: string;
  city: string;
  distanceMiles: number;
  /** Real bookable times, sorted ascending. */
  realSlots: TeeTimeSlot[];
  /** The route entry for this course (call / book_on_site), when present. A
   *  course is either foreup-capable (real slots) or routed — not both — so
   *  this is set at most once per group in practice. */
  routeEntry?: TeeTimeSlot;
}

/**
 * Group slots by course (courseId, falling back to a normalized course name
 * when `courseId` is empty). Real-slot groups sort first, then route-entry
 * groups; within each bucket groups sort by distance. Real slots within a
 * group sort ascending by time.
 */
export function groupSlotsByCourse(slots: TeeTimeSlot[]): CourseGroup[] {
  const groups = new Map<string, CourseGroup>();

  for (const s of slots) {
    const key = s.courseId || normalizeName(s.courseName);
    let g = groups.get(key);
    if (!g) {
      g = {
        courseId: s.courseId || key,
        courseName: s.courseName,
        city: s.city,
        distanceMiles: s.distanceMiles,
        realSlots: [],
      };
      groups.set(key, g);
    }
    if (isRealSlot(s)) {
      g.realSlots.push(s);
    } else if (!g.routeEntry || s.date < g.routeEntry.date) {
      // A course could in principle carry route entries for more than one
      // dispatched date; keep the earliest deterministically rather than
      // whichever happened to arrive last.
      g.routeEntry = s;
    }
  }

  for (const g of groups.values()) {
    g.realSlots.sort((a, b) => a.time.localeCompare(b.time));
  }

  return Array.from(groups.values()).sort((a, b) => {
    const aReal = a.realSlots.length > 0;
    const bReal = b.realSlots.length > 0;
    if (aReal !== bReal) return aReal ? -1 : 1;
    return a.distanceMiles - b.distanceMiles;
  });
}

// ─── Selection guard (bug #3 defense-in-depth) ─────────────────────────────────

/** The bit of a selected course this guard needs. */
export interface SelectionRef {
  id: string;
  name: string;
}

/**
 * Keep a slot iff it belongs to a selected course — matched by id OR by
 * normalized-name equality. The name fallback matters because a discovered
 * course's `course_id` can legitimately differ from the selected row's id
 * (the backend's own `matches_selection` does the same two-step match); an
 * id-only guard would false-reject good results. Called only when the golfer
 * actually has a selection — an empty `selection` returns `slots` unchanged.
 */
export function filterToSelection(slots: TeeTimeSlot[], selection: SelectionRef[]): TeeTimeSlot[] {
  if (selection.length === 0) return slots;
  const ids = new Set(selection.map((s) => s.id));
  const names = new Set(selection.map((s) => normalizeName(s.name)));
  return slots.filter((s) => ids.has(s.courseId) || names.has(normalizeName(s.courseName)));
}

// ─── Copy ───────────────────────────────────────────────────────────────────

/**
 * "6:10 AM · 2 spots · $24". `players` is real capacity ONLY on real slots
 * (route entries echo the request — routing.py — so this is only ever called
 * on real slots); `priceUsd == null` omits the price segment entirely —
 * never "$—", never fabricated.
 */
export function slotOptionLabel(s: TeeTimeSlot): string {
  const time = formatTime12h(s.time);
  const spots = `${s.players} spot${s.players !== 1 ? "s" : ""}`;
  const price = s.priceUsd != null ? ` · $${Math.round(s.priceUsd)}` : "";
  return `${time} · ${spots}${price}`;
}

/**
 * Honest miss copy naming the picks that came up empty — e.g. "None of your
 * picks — Clearview, Silver Lake, Forest Hills, Knickerbocker — had times in
 * your windows. Widen a window, or add a course."
 */
export function emptySelectionNote(names: string[]): string {
  if (names.length === 0) return "Nothing open nearby. Try a wider window or radius.";
  return `None of your picks — ${names.join(", ")} — had times in your windows. Widen a window, or add a course.`;
}
