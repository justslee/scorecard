/**
 * Unit tests for confirmCopy (specs/teetime-s0-plan.md §3/§5).
 *
 * The load-bearing assertion: for every (route, status, bookingUrl) combo,
 * NONE of the four copy fields ever contain "Held" — that word died with the
 * synthesized-slot ("estimated") design.
 */

import { describe, it, expect } from "vitest";
import { confirmCopy, callTelHref } from "./confirm-copy";
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

describe("confirmCopy — needs_human with a real known time (foreup)", () => {
  const FOREUP_SLOT: TeeTimeSlot = {
    ...BASE_SLOT,
    time: "07:10",
    route: undefined,
    provider: "foreup",
    bookingUrl: "https://foreupsoftware.com/index.php/booking/20410/4467",
  };

  it("a real time renders the actual clock time and course name, never 'Held'", () => {
    const result: BookingResult = { status: "needs_human", bookingUrl: FOREUP_SLOT.bookingUrl };
    const copy = confirmCopy(FOREUP_SLOT, result);
    expect(copy.looperLine).toContain("7:10 AM");
    expect(copy.looperLine).toContain(FOREUP_SLOT.courseName);
    expect(copy.looperLine.toLowerCase()).not.toContain("held");
  });

  it("pins the S2 handoff contract: ctaLabel, stampWord, subCopy exact strings", () => {
    // The deep-link precedence rule the page uses (bookingResult.bookingUrl ??
    // slot.bookingUrl, page.tsx:1093) — both carry the foreupsoftware.com URL
    // here so a drift to a generic website would fail this fixture too.
    const result: BookingResult = { status: "needs_human", bookingUrl: FOREUP_SLOT.bookingUrl };
    const copy = confirmCopy(FOREUP_SLOT, result);
    expect(copy.ctaLabel).toBe("Book on the course site →");
    expect(copy.stampWord).toBe("Found");
    expect(copy.stampWord).not.toBe("Held");
    expect(copy.stampWord).not.toBe("Booked");
    expect(copy.subCopy).toBe("You book direct — the course takes the reservation.");
  });

  it("missing booking_url + no phone: honest 'call the course' CTA, no dead button", () => {
    const slot: TeeTimeSlot = { ...FOREUP_SLOT, bookingUrl: undefined, phone: undefined };
    const result: BookingResult = { status: "needs_human", bookingUrl: undefined };
    const copy = confirmCopy(slot, result);
    expect(copy.ctaLabel).toBe("Call the course to book");
    expect(callTelHref(slot)).toBeNull();
  });

  it("no known time (time='') keeps the existing route-driven lines (regression)", () => {
    const slot: TeeTimeSlot = { ...BASE_SLOT, time: "", route: "book_on_site" };
    const result: BookingResult = { status: "needs_human", bookingUrl: slot.bookingUrl };
    const copy = confirmCopy(slot, result);
    expect(copy.looperLine.toLowerCase()).toContain("book on the course site");
    expect(copy.looperLine).not.toContain("AM");
    expect(copy.looperLine).not.toContain("PM");
  });
});

describe("confirmCopy — S2 honesty fix: network-failure fallback (page.tsx catch)", () => {
  it("the honest needs_human fallback (no fabricated 'pending'/'sent') stamps Found and keeps a working CTA via slot.bookingUrl", () => {
    // Mirrors the shape page.tsx now produces when bookTeeTime() throws: no
    // request reached the booking service, so the result carries no
    // bookingUrl/confirmationNumber of its own — confirmCopy must fall back
    // to slot.bookingUrl, never claim "sent" or "pending".
    const slot: TeeTimeSlot = {
      ...BASE_SLOT,
      time: "07:10",
      route: undefined,
      provider: "foreup",
      bookingUrl: "https://foreupsoftware.com/index.php/booking/20410/4467",
    };
    const result: BookingResult = {
      status: "needs_human",
      message: "Couldn't reach the booking service — book directly on the course site.",
    };
    const copy = confirmCopy(slot, result);
    expect(copy.stampWord).toBe("Found");
    expect(copy.stampWord).not.toBe("Pending");
    expect(copy.ctaLabel).toBe("Book on the course site →");
    expect(allCopyText(copy)).not.toMatch(/held/i);
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

describe("callTelHref — never a dead-end button", () => {
  it("a call-route slot WITH a phone number flows into a real tel: link", () => {
    const slot: TeeTimeSlot = { ...BASE_SLOT, route: "call", bookingUrl: undefined, phone: "+14155551234" };
    expect(callTelHref(slot)).toBe("tel:+14155551234");
  });

  it("a call-route slot WITHOUT a phone number renders no button (null href)", () => {
    const slot: TeeTimeSlot = { ...BASE_SLOT, route: "call", bookingUrl: undefined, phone: undefined };
    expect(callTelHref(slot)).toBeNull();
  });

  it("an empty-string phone is treated as unknown — no button", () => {
    const slot: TeeTimeSlot = { ...BASE_SLOT, route: "call", bookingUrl: undefined, phone: "" };
    expect(callTelHref(slot)).toBeNull();
  });
});
