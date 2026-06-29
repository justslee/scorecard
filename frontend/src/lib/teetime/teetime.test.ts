/**
 * Unit tests for the tee-time provider abstraction.
 *
 * Covers: MockTeeTimeProvider, registry, and pure helper logic.
 * No real network calls; no DB.
 */

import { describe, it, expect } from "vitest";
import { MockTeeTimeProvider } from "./providers/mock";
import { registerProvider, getProvider, getActiveProvider } from "./registry";
import type { TeeTimeQuery } from "./types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_QUERY: TeeTimeQuery = {
  date: "2026-10-18",
  timeWindowStart: "06:30",
  timeWindowEnd: "09:30",
  partySize: 3,
};

// ─── MockTeeTimeProvider ──────────────────────────────────────────────────────

describe("MockTeeTimeProvider", () => {
  const provider = new MockTeeTimeProvider();

  it('has name "mock"', () => {
    expect(provider.name).toBe("mock");
  });

  it("returns an array of slots for a valid query", async () => {
    const slots = await provider.searchAvailability(BASE_QUERY);
    expect(Array.isArray(slots)).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
  });

  it("every slot has the required fields", async () => {
    const slots = await provider.searchAvailability(BASE_QUERY);
    for (const slot of slots) {
      expect(typeof slot.id).toBe("string");
      expect(typeof slot.courseId).toBe("string");
      expect(typeof slot.courseName).toBe("string");
      expect(typeof slot.city).toBe("string");
      expect(slot.date).toBe(BASE_QUERY.date);
      expect(typeof slot.time).toBe("string");
      expect(slot.time).toMatch(/^\d{2}:\d{2}$/);
      expect(typeof slot.players).toBe("number");
      expect(slot.players).toBeGreaterThanOrEqual(BASE_QUERY.partySize);
      expect(typeof slot.priceUsd).toBe("number");
      expect(slot.priceUsd).toBeGreaterThan(0);
      expect(typeof slot.distanceMiles).toBe("number");
      expect(slot.provider).toBe("mock");
      expect([9, 18]).toContain(slot.holes);
    }
  });

  it("slots are sorted by distance then time", async () => {
    const slots = await provider.searchAvailability(BASE_QUERY);
    for (let i = 1; i < slots.length; i++) {
      const a = slots[i - 1];
      const b = slots[i];
      if (a.distanceMiles === b.distanceMiles) {
        expect(a.time <= b.time).toBe(true);
      } else {
        expect(a.distanceMiles).toBeLessThanOrEqual(b.distanceMiles);
      }
    }
  });

  it("returned times fall within the query window", async () => {
    const slots = await provider.searchAvailability(BASE_QUERY);
    const startMin = 6 * 60 + 30; // 06:30
    const endMin = 9 * 60 + 30;   // 09:30
    for (const slot of slots) {
      const [h, m] = slot.time.split(":").map(Number);
      const slotMin = h * 60 + m;
      expect(slotMin).toBeGreaterThanOrEqual(startMin);
      expect(slotMin).toBeLessThan(endMin);
    }
  });

  it("returns no slots above the price ceiling", async () => {
    const query: TeeTimeQuery = { ...BASE_QUERY, maxPriceUsd: 50 };
    const slots = await provider.searchAvailability(query);
    for (const slot of slots) {
      expect(slot.priceUsd).toBeLessThanOrEqual(50);
    }
  });

  it("respects maxDistanceMiles filter", async () => {
    const query: TeeTimeQuery = { ...BASE_QUERY, maxDistanceMiles: 10 };
    const slots = await provider.searchAvailability(query);
    for (const slot of slots) {
      expect(slot.distanceMiles).toBeLessThanOrEqual(10);
    }
  });

  it("restricts to specified courseIds", async () => {
    const query: TeeTimeQuery = { ...BASE_QUERY, courseIds: ["presidio"] };
    const slots = await provider.searchAvailability(query);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.courseId).toBe("presidio");
    }
  });

  it("returns empty array for an empty courseIds match", async () => {
    const query: TeeTimeQuery = { ...BASE_QUERY, courseIds: ["nonexistent-course-xyz"] };
    const slots = await provider.searchAvailability(query);
    expect(slots).toEqual([]);
  });

  it("is cache-first: repeat call returns the same array reference", async () => {
    const query: TeeTimeQuery = { ...BASE_QUERY, date: "2026-11-01" };
    const first = await provider.searchAvailability(query);
    const second = await provider.searchAvailability(query);
    expect(first).toBe(second); // same reference from cache
  });

  it("book() returns a confirmed result with a confirmation number", async () => {
    const slots = await provider.searchAvailability(BASE_QUERY);
    expect(slots.length).toBeGreaterThan(0);
    const result = await provider.book(slots[0], { name: "Justin L.", partySize: 3 });
    expect(result.status).toBe("confirmed");
    expect(typeof result.confirmationNumber).toBe("string");
    expect(result.confirmationNumber).toMatch(/^MOCK-/);
  });
});

// ─── Registry ─────────────────────────────────────────────────────────────────

describe("provider registry", () => {
  it("getActiveProvider() returns a provider (mock by default)", () => {
    const p = getActiveProvider();
    expect(p).toBeDefined();
    expect(typeof p.searchAvailability).toBe("function");
    expect(typeof p.book).toBe("function");
  });

  it("registerProvider() + getProvider() round-trip", () => {
    const fakeProvider = new MockTeeTimeProvider();
    registerProvider("test-fake", fakeProvider);
    const retrieved = getProvider("test-fake");
    expect(retrieved).toBe(fakeProvider);
  });

  it("getProvider() returns undefined for unknown name", () => {
    expect(getProvider("does-not-exist-xyz")).toBeUndefined();
  });
});

// ─── Type shape validation (pure logic) ───────────────────────────────────────

describe("TeeTimeQuery shape", () => {
  it("accepts a minimal query", () => {
    const q: TeeTimeQuery = {
      date: "2026-10-18",
      timeWindowStart: "07:00",
      timeWindowEnd: "10:00",
      partySize: 1,
    };
    expect(q.partySize).toBe(1);
    expect(q.courseIds).toBeUndefined();
  });

  it("accepts a fully-specified query", () => {
    const q: TeeTimeQuery = {
      date: "2026-10-18",
      timeWindowStart: "06:30",
      timeWindowEnd: "09:30",
      partySize: 4,
      area: "San Francisco",
      maxDistanceMiles: 20,
      maxPriceUsd: 120,
      courseIds: ["presidio", "harding"],
    };
    expect(q.area).toBe("San Francisco");
    expect(q.courseIds?.length).toBe(2);
  });
});
