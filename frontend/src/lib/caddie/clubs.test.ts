// @vitest-environment jsdom
/**
 * Unit tests for buildClubMap (lib/caddie/clubs.ts).
 *
 * P0 field bug (owner, 2026-07-18, specs/caddie-yardage-selector-p0-plan.md
 * §2.3): buildClubMap used to emit `hybrid -> 'hy'`, but the backend's
 * `_CLUB_ALIASES` table had NO 'hy' entry (only '3h'), so
 * `normalize_club_distances` silently dropped the hybrid for every
 * hybrid-carrying golfer. The fix moves the frontend to emit CANONICAL
 * backend keys directly (driver/3wood/5wood/hybrid/4iron.../pw/gw/sw/lw),
 * removing the short-code seam going forward. This test pins that every
 * key buildClubMap emits is a canonical key — guards against a future
 * re-divergence between the two ends of the wire.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildClubMap, DEFAULT_BAG_CAMEL } from './clubs';
import { saveGolferProfile } from '../storage';
import type { GolferProfile } from '../types';

// jsdom in this project's Node/vitest setup doesn't reliably ship a working
// localStorage — provide a lightweight Map-backed mock via vi.stubGlobal
// (same pattern as storage.test.ts / CaddieOrbSheet.test.tsx).
function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
  };
}

// The canonical CLUB_REFERENCE / CLUB_DISPLAY_NAMES keyspace
// (backend/app/caddie/club_selection.py) — the ONLY keys buildClubMap may
// ever emit now.
const CANONICAL_KEYS = new Set([
  'driver', '3wood', '5wood', 'hybrid',
  '4iron', '5iron', '6iron', '7iron', '8iron', '9iron',
  'pw', 'gw', 'sw', 'lw',
]);

function profileWithFullBag(): GolferProfile {
  return {
    id: 'test-user',
    name: 'Test Golfer',
    handicap: 12,
    homeCourse: null,
    clubDistances: {
      driver: 300,
      threeWood: 270,
      fiveWood: 250,
      hybrid: 235,
      fourIron: 220,
      fiveIron: 205,
      sixIron: 190,
      sevenIron: 175,
      eightIron: 160,
      nineIron: 145,
      pitchingWedge: 130,
      gapWedge: 115,
      sandWedge: 100,
      lobWedge: 80,
    },
    onboardingStep: null,
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage());
});

describe('buildClubMap', () => {
  it('emits only canonical keys for a full 14-club bag', () => {
    saveGolferProfile(profileWithFullBag());
    const clubMap = buildClubMap();
    const keys = Object.keys(clubMap);
    expect(keys.length).toBe(14);
    for (const key of keys) {
      expect(CANONICAL_KEYS.has(key)).toBe(true);
    }
  });

  it('emits "hybrid" (never "hy") for a hybrid-carrying golfer', () => {
    saveGolferProfile(profileWithFullBag());
    const clubMap = buildClubMap();
    expect(clubMap['hybrid']).toBe(235);
    expect(clubMap['hy']).toBeUndefined();
  });

  it('emits "3wood"/"7iron" (never "3w"/"7i") for a partial bag', () => {
    const profile = profileWithFullBag();
    profile.clubDistances = { driver: 300, threeWood: 270, sevenIron: 175 };
    saveGolferProfile(profile);
    const clubMap = buildClubMap();
    expect(clubMap).toEqual({ driver: 300, '3wood': 270, '7iron': 175 });
  });

  it('returns an empty map when no profile / no clubDistances is stored', () => {
    expect(buildClubMap()).toEqual({});
  });

  // Guards the onboarding Bag step's short<->camel defaults table
  // (specs/onboarding-shell-and-gate-plan.md §2.12/§6) against drift from the
  // backend's DEFAULT_CLUB_DISTANCES (club_selection.py).
  it('DEFAULT_BAG_CAMEL round-trips through buildClubMap to the exact backend defaults', () => {
    const profile = profileWithFullBag();
    profile.clubDistances = DEFAULT_BAG_CAMEL;
    saveGolferProfile(profile);
    const clubMap = buildClubMap();
    expect(clubMap).toEqual({
      driver: 250, '3wood': 230, '5wood': 215, hybrid: 200,
      '4iron': 190, '5iron': 180, '6iron': 170, '7iron': 160,
      '8iron': 150, '9iron': 140, pw: 130, gw: 115, sw: 100, lw: 85,
    });
  });
});
