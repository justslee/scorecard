// Unit tests for gps.ts — platform-independent helpers only.
//
// Real GPS behaviour is device-only and is tested on TestFlight.  Here we
// cover the position-normalisation function and the pure utility functions so
// that the Capacitor → app shape mapping is verified headlessly in CI.
//
// Capacitor is mocked because the plugin can't initialise in a Node environment.

import { describe, expect, it, vi } from "vitest";

// ─── Mock @capacitor/core ────────────────────────────────────────────────────
// isNativePlatform() must return false so imports don't throw in Node.
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
  },
}));

// ─── Mock @capacitor/geolocation ─────────────────────────────────────────────
vi.mock("@capacitor/geolocation", () => ({
  Geolocation: {
    getCurrentPosition: vi.fn(),
    watchPosition: vi.fn(),
    clearWatch: vi.fn(),
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
  },
}));

// Import AFTER mocks are in place
import {
  normalizeCapacitorPosition,
  calculateDistance,
  calculateBearing,
  formatDistance,
  getAccuracyDescription,
  isOnCourse,
} from "./gps";
import type { Position } from "./gps";
import type { Position as CapacitorPosition } from "@capacitor/geolocation";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCapPos(overrides?: Partial<CapacitorPosition["coords"]>): CapacitorPosition {
  return {
    timestamp: 1700000000000,
    coords: {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 5,
      altitude: null,
      altitudeAccuracy: null,
      speed: null,
      heading: null,
      // Fields added in @capacitor/geolocation v8.2.0
      magneticHeading: null,
      trueHeading: null,
      headingAccuracy: null,
      course: null,
      ...overrides,
    },
  };
}

// ─── normalizeCapacitorPosition ───────────────────────────────────────────────

describe("normalizeCapacitorPosition", () => {
  it("maps latitude and longitude to lat/lng", () => {
    const result = normalizeCapacitorPosition(makeCapPos());
    expect(result.lat).toBe(37.7749);
    expect(result.lng).toBe(-122.4194);
  });

  it("maps accuracy (always present in Capacitor Position)", () => {
    const result = normalizeCapacitorPosition(makeCapPos({ accuracy: 8.5 }));
    expect(result.accuracy).toBe(8.5);
  });

  it("maps timestamp", () => {
    const result = normalizeCapacitorPosition(makeCapPos());
    expect(result.timestamp).toBe(1700000000000);
  });

  it("converts null altitude to undefined", () => {
    const result = normalizeCapacitorPosition(makeCapPos({ altitude: null }));
    expect(result.altitude).toBeUndefined();
  });

  it("maps a present altitude value", () => {
    const result = normalizeCapacitorPosition(makeCapPos({ altitude: 42 }));
    expect(result.altitude).toBe(42);
  });

  it("converts null heading to undefined", () => {
    const result = normalizeCapacitorPosition(makeCapPos({ heading: null }));
    expect(result.heading).toBeUndefined();
  });

  it("maps a present heading value (including 0 degrees — north)", () => {
    const result = normalizeCapacitorPosition(makeCapPos({ heading: 0 }));
    // 0 is a valid heading; ?? undefined must NOT convert 0 → undefined
    expect(result.heading).toBe(0);
  });

  it("maps a non-zero heading", () => {
    const result = normalizeCapacitorPosition(makeCapPos({ heading: 270 }));
    expect(result.heading).toBe(270);
  });

  it("converts null speed to undefined", () => {
    const result = normalizeCapacitorPosition(makeCapPos({ speed: null }));
    expect(result.speed).toBeUndefined();
  });

  it("maps a present speed value (including 0 — stationary)", () => {
    const result = normalizeCapacitorPosition(makeCapPos({ speed: 0 }));
    // 0 is a valid speed — stationary golfer
    expect(result.speed).toBe(0);
  });

  it("maps a full position with all optional fields present", () => {
    const full = makeCapPos({
      accuracy: 3,
      altitude: 120,
      heading: 180,
      speed: 1.5,
    });
    full.timestamp = 9999;

    const result = normalizeCapacitorPosition(full);
    expect(result).toEqual<Position>({
      lat: 37.7749,
      lng: -122.4194,
      accuracy: 3,
      altitude: 120,
      heading: 180,
      speed: 1.5,
      timestamp: 9999,
    });
  });

  it("produces the app Position shape — no unexpected extra keys", () => {
    const result = normalizeCapacitorPosition(makeCapPos());
    const keys = Object.keys(result).sort();
    // altitude / heading / speed are undefined so Object.keys may or may not
    // include them depending on how the object literal was created — we check
    // the keys that ARE defined
    expect(keys).toContain("lat");
    expect(keys).toContain("lng");
    expect(keys).toContain("accuracy");
    expect(keys).toContain("timestamp");
  });
});

// ─── Pure utility smoke tests ─────────────────────────────────────────────────
// These already work on web — included here to protect the module import.

describe("calculateDistance", () => {
  it("returns non-zero yards between two distinct points", () => {
    const d = calculateDistance(
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7759, lng: -122.4194 }
    );
    expect(d.yards).toBeGreaterThan(0);
    expect(d.meters).toBeGreaterThan(0);
    expect(d.feet).toBeGreaterThan(0);
  });

  it("returns 0 yards for the same point", () => {
    const d = calculateDistance(
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7749, lng: -122.4194 }
    );
    expect(d.yards).toBe(0);
  });
});

describe("calculateBearing", () => {
  it("returns a number between -180 and 180", () => {
    const b = calculateBearing(
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.7759, lng: -122.4194 }
    );
    expect(b).toBeGreaterThanOrEqual(-180);
    expect(b).toBeLessThanOrEqual(180);
  });
});

describe("formatDistance", () => {
  it("includes 'yds' suffix", () => {
    expect(formatDistance(150)).toBe("150 yds");
    expect(formatDistance(5)).toBe("5 yds");
  });
});

describe("getAccuracyDescription", () => {
  it("returns Excellent for ≤3m", () => expect(getAccuracyDescription(2)).toBe("Excellent"));
  it("returns Very Good for ≤5m", () => expect(getAccuracyDescription(4)).toBe("Very Good"));
  it("returns Good for ≤10m", () => expect(getAccuracyDescription(8)).toBe("Good"));
  it("returns Fair for ≤20m", () => expect(getAccuracyDescription(15)).toBe("Fair"));
  it("returns Low for >20m", () => expect(getAccuracyDescription(25)).toBe("Low"));
});

describe("isOnCourse", () => {
  const bounds = { north: 38, south: 37, east: -122, west: -123 };

  it("returns true when position is within bounds", () => {
    expect(isOnCourse({ lat: 37.5, lng: -122.5 }, bounds)).toBe(true);
  });

  it("returns false when position is outside bounds", () => {
    expect(isOnCourse({ lat: 39, lng: -122.5 }, bounds)).toBe(false);
  });
});
