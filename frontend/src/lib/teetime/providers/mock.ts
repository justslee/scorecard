/**
 * MockTeeTimeProvider — Phase 1 placeholder.
 *
 * Generates deterministic, realistic availability for a small set of courses.
 * Clearly labelled `provider: "mock"` so the UI can show "Demo data" when
 * this provider is active.
 *
 * Seam for real providers: replace this file's usage in the registry with a
 * real provider (e.g. `ChronogolfProvider`) that calls the Lightspeed Partner
 * API, and the UI + backend surface work unchanged.
 *
 * Cache-first: once a query key has been resolved the result is stored in a
 * module-level Map and returned immediately on repeat calls (matching the
 * GolfAPI cache-first pattern in golf-api.ts).
 */

import type { TeeTimeProvider } from "../provider";
import type { TeeTimeQuery, TeeTimeSlot, BookingDetails, BookingResult } from "../types";

// ─── Course catalogue (mock) ──────────────────────────────────────────────────

interface MockCourse {
  id: string;
  name: string;
  city: string;
  distanceMiles: number;
  rating: number;
  designer?: string;
  basePrice: number;
  cartIncluded: boolean;
  holes: 9 | 18;
}

const MOCK_COURSES: MockCourse[] = [
  {
    id: "presidio",
    name: "Presidio Golf Course",
    city: "San Francisco, CA",
    distanceMiles: 4.1,
    rating: 4.3,
    designer: "Robert Trent Jones Jr.",
    basePrice: 86,
    cartIncluded: false,
    holes: 18,
  },
  {
    id: "harding",
    name: "Harding Park",
    city: "San Francisco, CA",
    distanceMiles: 6.8,
    rating: 4.5,
    designer: "Willie Watson",
    basePrice: 145,
    cartIncluded: false,
    holes: 18,
  },
  {
    id: "lincoln",
    name: "Lincoln Park Golf Course",
    city: "San Francisco, CA",
    distanceMiles: 5.2,
    rating: 3.9,
    basePrice: 52,
    cartIncluded: false,
    holes: 18,
  },
  {
    id: "sharp",
    name: "Sharp Park Golf Course",
    city: "Pacifica, CA",
    distanceMiles: 12.4,
    rating: 3.6,
    designer: "Alister MacKenzie",
    basePrice: 38,
    cartIncluded: false,
    holes: 18,
  },
  {
    id: "bethpage-black",
    name: "Bethpage State Park — Black",
    city: "Farmingdale, NY",
    distanceMiles: 31.2,
    rating: 4.8,
    designer: "A.W. Tillinghast",
    basePrice: 95,
    cartIncluded: false,
    holes: 18,
  },
  {
    id: "crystal-springs",
    name: "Crystal Springs Golf Course",
    city: "San Bruno, CA",
    distanceMiles: 16.7,
    rating: 3.8,
    basePrice: 65,
    cartIncluded: true,
    holes: 18,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse "HH:MM" into total minutes since midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** Format total minutes since midnight to "HH:MM". */
function fromMinutes(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Generate a stable pseudo-random number in [0, 1) from a string seed.
 * Deterministic so the same query always returns the same "availability."
 */
function seededRandom(seed: string): () => number {
  // Simple hash → 32-bit integer.
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  // LCG PRNG
  let state = h;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) | 0;
    return ((state >>> 0) / 0x100000000);
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const _cache = new Map<string, TeeTimeSlot[]>();

function cacheKey(query: TeeTimeQuery): string {
  return JSON.stringify({
    date: query.date,
    start: query.timeWindowStart,
    end: query.timeWindowEnd,
    partySize: query.partySize,
    courseIds: query.courseIds?.slice().sort(),
    area: query.area,
    maxDistanceMiles: query.maxDistanceMiles ?? null,
    maxPriceUsd: query.maxPriceUsd ?? null,
  });
}

// ─── Mock Provider ────────────────────────────────────────────────────────────

export class MockTeeTimeProvider implements TeeTimeProvider {
  readonly name = "mock";

  async searchAvailability(query: TeeTimeQuery): Promise<TeeTimeSlot[]> {
    const key = cacheKey(query);
    if (_cache.has(key)) return _cache.get(key)!;

    const slots = this._generate(query);
    _cache.set(key, slots);
    return slots;
  }

  async book(slot: TeeTimeSlot, _details: BookingDetails): Promise<BookingResult> {
    // Mock booking: always succeeds.  Real providers replace this with an API call.
    const suffix = slot.id.slice(-6).toUpperCase();
    return {
      status: "confirmed",
      confirmationNumber: `MOCK-${suffix}`,
      message: "Mock booking confirmed. No real reservation was made.",
    };
  }

  // ─── Internal generation ───────────────────────────────────────────────────

  private _generate(query: TeeTimeQuery): TeeTimeSlot[] {
    const rng = seededRandom(cacheKey(query));
    const startMin = toMinutes(query.timeWindowStart);
    const endMin = toMinutes(query.timeWindowEnd);

    // Filter courses by courseIds / maxDistanceMiles.
    const eligible = MOCK_COURSES.filter((c) => {
      if (query.courseIds?.length && !query.courseIds.includes(c.id)) return false;
      if (query.maxDistanceMiles != null && c.distanceMiles > query.maxDistanceMiles) return false;
      return true;
    });

    const slots: TeeTimeSlot[] = [];

    for (const course of eligible) {
      // Generate 2–4 tee times spread across the window.
      const count = 2 + Math.floor(rng() * 3); // 2, 3, or 4
      const windowSpan = endMin - startMin;
      const used = new Set<number>();

      for (let i = 0; i < count; i++) {
        // Pick a time in the window, rounded to 8-minute intervals.
        let offset = Math.floor(rng() * (windowSpan / 8)) * 8;
        // Avoid exact duplicates.
        while (used.has(offset)) offset = (offset + 8) % windowSpan;
        used.add(offset);
        const teeMin = startMin + offset;
        if (teeMin >= endMin) continue;

        // Available slots: must be >= partySize.
        const available = query.partySize + Math.floor(rng() * (4 - query.partySize + 1));
        const playerSlots = Math.min(4, Math.max(query.partySize, available));

        // Price variation ±15%.
        const priceVariation = 0.85 + rng() * 0.30;
        const priceUsd = Math.round(course.basePrice * priceVariation);

        // Skip if above ceiling.
        if (query.maxPriceUsd != null && priceUsd > query.maxPriceUsd) continue;

        const time = fromMinutes(teeMin);
        const slotId = `${course.id}-${query.date}-${time}-${i}`;

        slots.push({
          id: slotId,
          courseId: course.id,
          courseName: course.name,
          city: course.city,
          date: query.date,
          time,
          players: playerSlots,
          priceUsd,
          cartIncluded: course.cartIncluded,
          distanceMiles: course.distanceMiles,
          rating: course.rating,
          designer: course.designer,
          provider: "mock",
          holes: course.holes,
          // Phase 1: deep-link to GolfNow search for this course.
          bookingUrl: `https://www.golfnow.com/tee-times/facility/${encodeURIComponent(course.name)}/search`,
        });
      }
    }

    // Sort by distance, then time.
    slots.sort((a, b) => a.distanceMiles - b.distanceMiles || a.time.localeCompare(b.time));
    return slots;
  }
}

/** Singleton instance — import this where you need the mock. */
export const mockProvider = new MockTeeTimeProvider();
