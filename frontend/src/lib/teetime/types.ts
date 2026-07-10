/**
 * Tee-time provider abstraction — Phase 1 (mock/foundation).
 *
 * These types form the stable contract that every provider (Mock, Routing,
 * GolfNow, Lightspeed/Chronogolf) normalises into.  The UI only ever talks
 * to this shape; swapping a real provider in later requires zero UI rework.
 */

// ─── Query ────────────────────────────────────────────────────────────────────

/**
 * Everything the golfer has told us about what they want.
 * `date` + `timeWindowStart`/`timeWindowEnd` define a single search window;
 * the UI collects multiple windows and fans them out as separate queries.
 */
export interface TeeTimeQuery {
  /** Optional: restrict to specific course IDs in the provider's namespace. */
  courseIds?: string[];
  /** Free-text area / city name (e.g. "San Francisco") — used when no courseIds given. */
  area?: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  date: string;
  /** Window start in 24-h "HH:MM" format. */
  timeWindowStart: string;
  /** Window end in 24-h "HH:MM" format. */
  timeWindowEnd: string;
  /** Number of players (1–4). */
  partySize: number;
  /** Maximum drive distance in miles from the golfer's location. */
  maxDistanceMiles?: number;
  /** Price ceiling in USD. Slots above this are excluded. */
  maxPriceUsd?: number;
}

// ─── Slot ─────────────────────────────────────────────────────────────────────

/**
 * A single available tee time returned by any provider.
 *
 * Every provider normalises into this shape so the UI is provider-agnostic.
 * `bookingUrl` is present on Routing/scrape sources where we deep-link out;
 * it may be absent when the provider can complete the booking natively
 * (Chronogolf/GolfNow — Phase 2+).
 */
export interface TeeTimeSlot {
  /** `${courseId}-${date}-${time}-${slotIndex}` — stable across refreshes. */
  id: string;
  courseId: string;
  courseName: string;
  /** City / muni label, e.g. "San Francisco, CA". */
  city: string;
  /** ISO 8601 date (YYYY-MM-DD). */
  date: string;
  /** 24-h "HH:MM" format, or "" when no real time is known (routing provider —
   *  never render this as a time; show the requested window instead). */
  time: string;
  /** Available player slots (1–4). */
  players: number;
  /** Price in USD — null when unknown (routing slots; prices are never fabricated). */
  priceUsd: number | null;
  cartIncluded: boolean;
  distanceMiles: number;
  /** 0–5 star rating. */
  rating: number;
  designer?: string;
  /** Deep-link to the booking page on an external site (Routing / foreup / Phase 1). */
  bookingUrl?: string;
  /**
   * Identifies which provider generated this slot
   * (mock | routing | foreup | golfnow | chronogolf). "foreup" slots carry a
   * REAL `time` (never "") + a `bookingUrl` deep-link to the course's foreUP
   * booking page, with `route` undefined (the provider knows real
   * availability — see `route`'s doc below).
   */
  provider: string;
  holes: 9 | 18;
  /**
   * DEPRECATED (S0): no provider sets this true anymore — the "estimated
   * window" design was replaced by honest `time=""` + `route`. Kept typed but
   * inert this slice; scheduled for deletion in the S1 cleanup.
   */
  estimated?: boolean;
  /** How this entry gets booked: deep-link handoff, phone call, or (undefined)
   *  real bookable availability. */
  route?: "book_on_site" | "call";
  /** The pro shop's phone number, when known — powers a real `tel:` link on
   *  `route === "call"` entries. Undefined when unknown; never render a
   *  tappable-looking call button without a real number behind it. */
  phone?: string;
}

// ─── Booking ──────────────────────────────────────────────────────────────────

/** Golfer details required to complete a booking. */
export interface BookingDetails {
  name: string;
  email?: string;
  phone?: string;
  partySize: number;
  /** The golfer's requested search window (24-h "HH:MM"). Sent on booking so the
   *  AI phone-call route can ask the pro shop for a time when the routed slot
   *  itself carries none (`slot.time === ""`). Never a fabricated time. */
  timeWindowStart?: string;
  timeWindowEnd?: string;
}

/**
 * The result of a `book()` call.
 *
 * - `confirmed`   – provider completed the booking; `confirmationNumber` is set.
 * - `pending`     – booking is being processed (async — check back).
 * - `failed`      – provider rejected the booking; see `message`.
 * - `needs_human` – provider requires a human action (payment, 2FA, etc.);
 *                   `bookingUrl` gives them the page to complete it.
 * - `not_supported` – this provider cannot book in-app; `bookingUrl` for deep-link.
 */
export interface BookingResult {
  status: "confirmed" | "pending" | "failed" | "needs_human" | "not_supported";
  confirmationNumber?: string;
  message?: string;
  /** URL the user should visit if status is needs_human / not_supported. */
  bookingUrl?: string;
}

// ─── Owner rehearsal call ──────────────────────────────────────────────────────
// Mirrors backend RehearsalCallResponse (backend/app/routes/tee_times.py). The
// owner triggers a self-call rehearsal of the AI pro-shop booking agent — keep
// these shapes in sync with the Pydantic models.

/** One line of the rehearsed call transcript. */
export interface RehearsalCallTurn {
  speaker: string; // "agent" | "shop"
  text: string;
}

/** Structured outcome of the rehearsed call (null until it runs to completion). */
export interface RehearsalCallOutcome {
  result: string; // booked | no_availability | voicemail | no_answer | card_required | unclear
  date: string | null;
  time: string | null;
  partySize: number | null;
  confirmationNumber: string | null;
  costUsd: number | null;
  detail: string | null;
}

export interface RehearsalCallResponse {
  /** "completed" — ran end to end; "refused" — a compliance gate blocked it;
   *  "not_enabled" — live calling is disabled / the bridge isn't shipped yet. */
  status: "completed" | "refused" | "not_enabled";
  /** Gate / compliance / gating explanation when status is not "completed". */
  reason?: string | null;
  /** Masked callee (last 4), display only — never used to dial. */
  calleeNumber?: string | null;
  /** The agent's mandatory AI-disclosure opener, previewed. */
  disclosure?: string | null;
  transcript: RehearsalCallTurn[];
  outcome?: RehearsalCallOutcome | null;
  result?: BookingResult | null;
}
