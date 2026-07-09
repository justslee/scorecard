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

/**
 * Derive the Confirmed screen's copy from the slot + booking result.
 *
 * `needs_human` (routing provider) is a HANDOFF, not a booking — the copy is
 * route-driven ("book_on_site" → deep-link to the course site, "call" → no
 * online booking, phone the pro shop). Real `confirmed` results only ever
 * come from the explicit mock provider on the real path today.
 */
export function confirmCopy(slot: TeeTimeSlot, bookingResult: BookingResult | null): ConfirmCopy {
  const needsHuman = bookingResult?.status === "needs_human";
  const isMock = slot.provider === "mock";
  const bookingUrl = bookingResult?.bookingUrl ?? slot.bookingUrl;

  const stampWord =
    bookingResult?.status === "confirmed" ? "Booked"
    : bookingResult?.status === "pending" ? "Pending"
    : "Found"; // needs_human and every other case read "Found" — never "Held".

  let looperLine: string;
  if (needsHuman) {
    if (slot.route === "call") {
      looperLine = `Found ${slot.courseName}. No online booking — call the pro shop to set it up.`;
    } else {
      // "book_on_site" (or an unset route on a needs_human result — treat as
      // the honest default: we found the course, they take the reservation).
      looperLine = `Found ${slot.courseName}, ${slot.distanceMiles} mi away. They take the reservation — book on the course site.`;
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
