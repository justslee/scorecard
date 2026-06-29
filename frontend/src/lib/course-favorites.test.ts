/**
 * Unit tests for course-favorites.ts
 *
 * Uses injectable MemoryStore so tests run in pure Node without any localStorage
 * or jsdom dependency — fast and deterministic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  addFavorite,
  removeFavorite,
  toggleFavorite,
  listFavorites,
  isFavorite,
  clearFavorites,
  readFavorites,
  MemoryStore,
  type FavoriteCourse,
} from "./course-favorites";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COURSE_A: Omit<FavoriteCourse, "favoritedAt"> = {
  id: "uuid-bethpage-black",
  name: "Bethpage Black",
  clubName: "Bethpage State Park",
  center: { lat: 40.7442, lng: -73.4593 },
  source: "mapped",
};

const COURSE_B: Omit<FavoriteCourse, "favoritedAt"> = {
  id: "uuid-pebble-beach",
  name: "Pebble Beach",
  source: "golfapi",
  golfApiClubId: "12345",
};

const COURSE_C: Omit<FavoriteCourse, "favoritedAt"> = {
  id: "uuid-augusta",
  name: "Augusta National",
  source: "osm",
};

// Fresh in-memory store per test
let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

// ---------------------------------------------------------------------------
// listFavorites
// ---------------------------------------------------------------------------

describe("listFavorites", () => {
  it("returns empty array when no favorites", () => {
    expect(listFavorites(store)).toEqual([]);
  });

  it("returns favorites most-recently-favorited first", () => {
    addFavorite(COURSE_A, store);
    addFavorite(COURSE_B, store);
    addFavorite(COURSE_C, store);
    const favs = listFavorites(store);
    // COURSE_C added last → first in list
    expect(favs[0].id).toBe(COURSE_C.id);
    expect(favs[1].id).toBe(COURSE_B.id);
    expect(favs[2].id).toBe(COURSE_A.id);
  });
});

// ---------------------------------------------------------------------------
// isFavorite
// ---------------------------------------------------------------------------

describe("isFavorite", () => {
  it("returns false for unknown id", () => {
    expect(isFavorite("does-not-exist", store)).toBe(false);
  });

  it("returns true after adding", () => {
    addFavorite(COURSE_A, store);
    expect(isFavorite(COURSE_A.id, store)).toBe(true);
  });

  it("returns false after removing", () => {
    addFavorite(COURSE_A, store);
    removeFavorite(COURSE_A.id, store);
    expect(isFavorite(COURSE_A.id, store)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addFavorite
// ---------------------------------------------------------------------------

describe("addFavorite", () => {
  it("adds a course and returns it in the list", () => {
    const result = addFavorite(COURSE_A, store);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(COURSE_A.id);
    expect(result[0].name).toBe(COURSE_A.name);
  });

  it("persists favoritedAt as an ISO string", () => {
    addFavorite(COURSE_A, store);
    const favs = readFavorites(store);
    expect(favs[0].favoritedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("deduplicates by id — adding the same course twice keeps only one entry", () => {
    addFavorite(COURSE_A, store);
    addFavorite(COURSE_A, store);
    expect(listFavorites(store)).toHaveLength(1);
  });

  it("re-adding updates favoritedAt (most-recent stays first)", () => {
    addFavorite(COURSE_A, store);
    addFavorite(COURSE_B, store);
    // Re-add COURSE_A — it should float back to the top
    addFavorite(COURSE_A, store);
    const favs = listFavorites(store);
    expect(favs[0].id).toBe(COURSE_A.id);
    expect(favs).toHaveLength(2);
  });

  it("preserves all fields including optional ones", () => {
    addFavorite(COURSE_A, store);
    const fav = listFavorites(store)[0];
    expect(fav.clubName).toBe(COURSE_A.clubName);
    expect(fav.center).toEqual(COURSE_A.center);
    expect(fav.source).toBe(COURSE_A.source);
  });

  it("stores golfApiClubId for golfapi results", () => {
    addFavorite(COURSE_B, store);
    const fav = listFavorites(store)[0];
    expect(fav.golfApiClubId).toBe(COURSE_B.golfApiClubId);
  });
});

// ---------------------------------------------------------------------------
// removeFavorite
// ---------------------------------------------------------------------------

describe("removeFavorite", () => {
  it("is a no-op for an id not in favorites", () => {
    addFavorite(COURSE_A, store);
    removeFavorite("does-not-exist", store);
    expect(listFavorites(store)).toHaveLength(1);
  });

  it("removes the correct course", () => {
    addFavorite(COURSE_A, store);
    addFavorite(COURSE_B, store);
    removeFavorite(COURSE_A.id, store);
    const favs = listFavorites(store);
    expect(favs).toHaveLength(1);
    expect(favs[0].id).toBe(COURSE_B.id);
  });
});

// ---------------------------------------------------------------------------
// toggleFavorite
// ---------------------------------------------------------------------------

describe("toggleFavorite", () => {
  it("adds when not favorited", () => {
    const { isFavorite: fav, favorites } = toggleFavorite(COURSE_A, store);
    expect(fav).toBe(true);
    expect(favorites).toHaveLength(1);
  });

  it("removes when already favorited", () => {
    addFavorite(COURSE_A, store);
    const { isFavorite: fav, favorites } = toggleFavorite(COURSE_A, store);
    expect(fav).toBe(false);
    expect(favorites).toHaveLength(0);
  });

  it("round-trips: toggle on then off leaves empty list", () => {
    toggleFavorite(COURSE_A, store);
    toggleFavorite(COURSE_A, store);
    expect(listFavorites(store)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// persistence round-trip
// ---------------------------------------------------------------------------

describe("persistence round-trip", () => {
  it("survives a readFavorites → writeFavorites cycle without data loss", () => {
    addFavorite(COURSE_A, store);
    addFavorite(COURSE_B, store);
    addFavorite(COURSE_C, store);
    // Simulate a page reload by reading back directly from the same store
    const raw = readFavorites(store);
    expect(raw).toHaveLength(3);
    const ids = raw.map((f) => f.id);
    expect(ids).toContain(COURSE_A.id);
    expect(ids).toContain(COURSE_B.id);
    expect(ids).toContain(COURSE_C.id);
  });
});

// ---------------------------------------------------------------------------
// clearFavorites
// ---------------------------------------------------------------------------

describe("clearFavorites", () => {
  it("removes all favorites", () => {
    addFavorite(COURSE_A, store);
    addFavorite(COURSE_B, store);
    clearFavorites(store);
    expect(listFavorites(store)).toHaveLength(0);
  });
});
