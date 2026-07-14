/**
 * Pure copy helper for the tee-time Confirmed screen (specs/teetime-s0-plan.md §3).
 *
 * S0 kills "Held" everywhere: a routing entry is a real course we found, not
 * a reservation we made. Centralizing the language here makes "no Held
 * anywhere" testable (see confirm-copy.test.ts) and keeps the Confirmed
 * component slim.
 */

import type { TeeTimeSlot, BookingResult } from "./types";

export interface ConfirmCopy {
  /** The word inside the round stamp — never "Held". */
  stampWord: string;
  /** The looper's one-line summary under the time card. */
  looperLine: string;
  /** Label for the primary CTA button — "" when there's nothing to book. */
  ctaLabel: string;
  /** Small italic line under the CTA — "" when there's nothing to add. */
  subCopy: string;
}

/** "07:10" → "7:10 AM"; "" (no known time) → "". */
function formatTime12hOrEmpty(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}

export interface ConfirmCopyOptions {
  /**
   * The SUBMITTED window text ("6:30–9:30 AM" or "… or …" for two windows
   * sharing a date) — a `formatAskWindows(asksForDate(asks, slot.date))`
   * projection of the dispatched queries, never re-derived from live prefs
   * state (results/prefs UX fixes plan, bug #2). Only used on a route entry
   * (`slot.time === ""`) — a real slot's known time speaks for itself.
   */
  askWindow?: string;
}

/**
 * Derive the Confirmed screen's copy from the slot + booking result.
 *
 * `needs_human` (routing provider) is a HANDOFF, not a booking — the copy is
 * route-driven ("book_on_site" → deep-link to the course site, "call" → no
 * online booking, phone the pro shop). Real `confirmed` results only ever
 * come from the explicit mock provider on the real path today.
 */
export function confirmCopy(slot: TeeTimeSlot, bookingResult: BookingResult | null, opts: ConfirmCopyOptions = {}): ConfirmCopy {
  const needsHuman = bookingResult?.status === "needs_human";
  const isMock = slot.provider === "mock";
  const bookingUrl = bookingResult?.bookingUrl ?? slot.bookingUrl;
  const { askWindow } = opts;

  const stampWord =
    bookingResult?.status === "confirmed" ? "Booked"
    : bookingResult?.status === "pending" ? "Pending"
    : "Found"; // needs_human and every other case read "Found" — never "Held".

  let looperLine: string;
  if (needsHuman) {
    if (slot.time) {
      // A real provider (foreup) slot with a known time — still a needs_human
      // deep-link handoff (S2 owns in-app booking), but honest enough to say
      // the real time out loud instead of falling back to the routing copy.
      // (Who books it is said once, in subCopy below — not repeated here.)
      looperLine = `Found ${formatTime12hOrEmpty(slot.time)} at ${slot.courseName}.`;
    } else if (slot.route === "call") {
      looperLine = askWindow
        ? `Found ${slot.courseName}. No online booking — call the pro shop for a time in your ${askWindow} window.`
        : `Found ${slot.courseName}. No online booking — call the pro shop to set it up.`;
    } else {
      // "book_on_site" (or an unset route on a needs_human result — treat as
      // the honest default: we found the course, they take the reservation).
      // (Who books it is said once, in subCopy below — not repeated here.)
      looperLine = askWindow
        ? `Found ${slot.courseName}, ${slot.distanceMiles} mi away — for a time in your ${askWindow} window.`
        : `Found ${slot.courseName}, ${slot.distanceMiles} mi away.`;
    }
  } else {
    const teeTime = formatTime12hOrEmpty(slot.time);
    looperLine = `Found one. ${teeTime} at ${slot.courseName}${slot.cartIncluded ? ", cart included" : ", walking"}.`;
    if (isMock) looperLine += " (Demo data.)";
  }

  const ctaLabel = bookingUrl
    ? (needsHuman ? "Book on the course site →" : "Book on GolfNow →")
    : (needsHuman ? "Call the course to book" : "");

  const subCopy = needsHuman ? "You book direct — the course takes the reservation." : "";

  return { stampWord, looperLine, ctaLabel, subCopy };
}

/**
 * The `tel:` URI for a "call" route's CTA — or `null` when no phone number
 * is known. Never render a tappable-looking call button without a real
 * number behind it (S0 review finding — a dead-end CTA is worse than the
 * "Held" bug this slice killed).
 */
export function callTelHref(slot: Pick<TeeTimeSlot, "phone">): string | null {
  return slot.phone ? `tel:${slot.phone}` : null;
}
