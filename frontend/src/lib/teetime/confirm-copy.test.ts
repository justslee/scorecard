/**
 * Unit tests for confirmCopy (specs/teetime-s0-plan.md §3/§5).
 *
 * The load-bearing assertion: for every (route, status, bookingUrl) combo,
 * NONE of the four copy fields ever contain "Held" — that word died with the
 * synthesized-slot ("estimated") design.
 */

import { describe, it, expect } from "vitest";
import { confirmCopy } from "./confirm-copy";
import type { TeeTimeSlot, BookingResult } from "./types";

const BASE_SLOT: TeeTimeSlot = {
  id: "gplaces-abc-2026-07-04-route",
  courseId: "gplaces-abc",
  courseName: "Presidio Golf Course",
  city: "San Francisco, CA",
  date: "2026-07-04",
  time: "",
  players: 4,
  priceUsd: null,
  cartIncluded: false,
  distanceMiles: 4.1,
  rating: 4.3,
  provider: "routing",
  holes: 18,
  bookingUrl: "https://www.presidiogolf.com/",
  estimated: false,
  route: "book_on_site",
};

const ROUTES: Array<TeeTimeSlot["route"]> = ["book_on_site", "call", undefined];
const STATUSES: Array<BookingResult["status"]> = [
  "confirmed", "pending", "needs_human", "failed", "not_supported",
];
const BOOKING_URLS: Array<string | undefined> = ["https://example.com/book", undefined];

function allCopyText(copy: ReturnType<typeof confirmCopy>): string {
  return `${copy.stampWord} ${copy.looperLine} ${copy.ctaLabel} ${copy.subCopy}`;
}

describe("confirmCopy — no 'Held' anywhere", () => {
  for (const route of ROUTES) {
    for (const status of STATUSES) {
      for (const bookingUrl of BOOKING_URLS) {
        it(`route=${route ?? "none"} status=${status} bookingUrl=${bookingUrl ?? "none"}`, () => {
          const slot: TeeTimeSlot = { ...BASE_SLOT, route, bookingUrl };
          const result: BookingResult = { status, bookingUrl };
          const copy = confirmCopy(slot, result);
          expect(allCopyText(copy)).not.toMatch(/held/i);
        });
      }
    }
  }

  it("also never says Held with a null bookingResult", () => {
    const copy = confirmCopy(BASE_SLOT, null);
    expect(allCopyText(copy)).not.toMatch(/held/i);
  });
});

describe("confirmCopy — route-driven language", () => {
  it("book_on_site: looper line + CTA point to the course site", () => {
    const slot: TeeTimeSlot = { ...BASE_SLOT, route: "book_on_site" };
    const result: BookingResult = { status: "needs_human", bookingUrl: slot.bookingUrl };
    const copy = confirmCopy(slot, result);
    expect(copy.looperLine.toLowerCase()).toContain("book on the course site");
    expect(copy.ctaLabel).toBe("Book on the course site →");
  });

  it("call: looper line + CTA tell the golfer to call", () => {
    const slot: TeeTimeSlot = { ...BASE_SLOT, route: "call", bookingUrl: undefined };
    const result: BookingResult = { status: "needs_human", bookingUrl: undefined };
    const copy = confirmCopy(slot, result);
    expect(copy.looperLine.toLowerCase()).toContain("call");
    expect(copy.ctaLabel).toBe("Call the course to book");
  });

  it("needs_human stamp word is 'Found', never 'Held'", () => {
    const result: BookingResult = { status: "needs_human", bookingUrl: BASE_SLOT.bookingUrl };
    const copy = confirmCopy(BASE_SLOT, result);
    expect(copy.stampWord).toBe("Found");
  });

  it("subCopy for a needs_human handoff is the honest 'you book direct' line", () => {
    const result: BookingResult = { status: "needs_human", bookingUrl: BASE_SLOT.bookingUrl };
    const copy = confirmCopy(BASE_SLOT, result);
    expect(copy.subCopy).toBe("You book direct — the course takes the reservation.");
  });
});

describe("confirmCopy — mock (dev) confirmed slot", () => {
  it("stamps 'Booked' and labels demo data honestly", () => {
    const slot: TeeTimeSlot = { ...BASE_SLOT, provider: "mock", time: "07:36", route: undefined };
    const result: BookingResult = { status: "confirmed", confirmationNumber: "MOCK-123" };
    const copy = confirmCopy(slot, result);
    expect(copy.stampWord).toBe("Booked");
    expect(copy.looperLine).toContain("(Demo data.)");
    expect(copy.looperLine).toContain("7:36 AM");
  });

  it("real (non-mock) confirmed slot has no '(Demo data.)' suffix", () => {
    const slot: TeeTimeSlot = { ...BASE_SLOT, provider: "golfnow", time: "07:36", route: undefined };
    const result: BookingResult = { status: "confirmed", confirmationNumber: "ABC123" };
    const copy = confirmCopy(slot, result);
    expect(copy.looperLine).not.toContain("Demo data");
  });
});
