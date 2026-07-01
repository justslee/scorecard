/**
 * Unit tests for map view preference persistence (localStorage).
 *
 * Runs in Node env (fast, no browser) — uses vi.stubGlobal to provide a
 * lightweight localStorage mock and expose `window` so the guards in
 * getMapViewPref / setMapViewPref don't short-circuit.
 *
 * Run: cd frontend && npx vitest run src/lib/map/satellite-map-pref.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAP_VIEW_PREF_KEY,
  getMapViewPref,
  setMapViewPref,
  mapRendererFor,
} from './satellite-helpers';

// ── In-memory localStorage mock ───────────────────────────────────────────────

function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    get length() { return Object.keys(store).length; },
    key: (n: number) => Object.keys(store)[n] ?? null,
  };
}

// Stub `window` (so typeof window !== 'undefined') and `localStorage` before
// each test; restore after so other test files are unaffected.
let mockStorage: ReturnType<typeof makeLocalStorage>;

beforeEach(() => {
  mockStorage = makeLocalStorage();
  vi.stubGlobal('window', { localStorage: mockStorage });
  vi.stubGlobal('localStorage', mockStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── getMapViewPref — default and stored preference ────────────────────────────

describe('getMapViewPref — default and stored preference', () => {
  // Default flipped to 'satellite' (owner: Google satellite is THE map route);
  // only an explicit stored 'holediagram' opts into the on-paper diagram.
  it('returns "satellite" when nothing is stored (fresh user / default map route)', () => {
    expect(getMapViewPref()).toBe('satellite');
  });

  it('returns "holediagram" when "holediagram" was explicitly stored', () => {
    mockStorage.setItem(MAP_VIEW_PREF_KEY, 'holediagram');
    expect(getMapViewPref()).toBe('holediagram');
  });

  it('returns "satellite" when "satellite" was previously stored', () => {
    mockStorage.setItem(MAP_VIEW_PREF_KEY, 'satellite');
    expect(getMapViewPref()).toBe('satellite');
  });

  it('returns "satellite" for an unrecognised stored value (defensive)', () => {
    mockStorage.setItem(MAP_VIEW_PREF_KEY, 'google');
    expect(getMapViewPref()).toBe('satellite');
  });

  it('returns "satellite" for an empty string', () => {
    mockStorage.setItem(MAP_VIEW_PREF_KEY, '');
    expect(getMapViewPref()).toBe('satellite');
  });

  it('returns "satellite" for a random string', () => {
    mockStorage.setItem(MAP_VIEW_PREF_KEY, 'mapbox');
    expect(getMapViewPref()).toBe('satellite');
  });
});

// ── setMapViewPref — writing and reading back ─────────────────────────────────

describe('setMapViewPref — persisting the preference', () => {
  it('stores "satellite" and getMapViewPref reads it back', () => {
    setMapViewPref('satellite');
    expect(getMapViewPref()).toBe('satellite');
  });

  it('stores "holediagram" and getMapViewPref reads it back', () => {
    // First set to satellite, then switch back.
    setMapViewPref('satellite');
    setMapViewPref('holediagram');
    expect(getMapViewPref()).toBe('holediagram');
  });

  it('writes to the correct localStorage key', () => {
    setMapViewPref('satellite');
    expect(mockStorage.getItem(MAP_VIEW_PREF_KEY)).toBe('satellite');
  });

  it('overwrites a previous value', () => {
    setMapViewPref('satellite');
    setMapViewPref('holediagram');
    expect(mockStorage.getItem(MAP_VIEW_PREF_KEY)).toBe('holediagram');
  });
});

// ── renderer-selection + preference interaction ───────────────────────────────
//
// These tests capture the intended gate logic:
//   • No key → no Google option regardless of preference
//   • Key present + no pref → renderer is "google" but pref is "holediagram"
//   • Key present + pref "satellite" → both ready for satellite mode

describe('renderer selection + preference — combined logic', () => {
  it('key absent + no stored pref → renderer "holediagram", pref "satellite"', () => {
    expect(mapRendererFor(undefined)).toBe('holediagram');
    expect(getMapViewPref()).toBe('satellite'); // default map route
  });

  it('key absent + pref "satellite" → renderer still "holediagram" (key wins)', () => {
    setMapViewPref('satellite');
    // No key → mapRendererFor returns 'holediagram' regardless of stored pref.
    expect(mapRendererFor(undefined)).toBe('holediagram');
    expect(mapRendererFor('')).toBe('holediagram');
    expect(mapRendererFor('   ')).toBe('holediagram');
  });

  it('key present + no stored pref → renderer "google", pref "satellite" (default map route)', () => {
    // Key is present and no preference stored yet — renderer says 'google' and
    // the pref defaults to 'satellite', so the map loads satellite by default.
    expect(mapRendererFor('AIzaSyABC123')).toBe('google');
    expect(getMapViewPref()).toBe('satellite'); // default map route
  });

  it('key present + pref "satellite" → both ready for satellite mode (user opted in)', () => {
    setMapViewPref('satellite');
    expect(mapRendererFor('AIzaSyABC123')).toBe('google');
    expect(getMapViewPref()).toBe('satellite');
  });

  it('toggling satellite on then off: final state is "holediagram"', () => {
    setMapViewPref('satellite');
    expect(getMapViewPref()).toBe('satellite');
    setMapViewPref('holediagram');
    expect(getMapViewPref()).toBe('holediagram');
  });

  it('toggling multiple times is idempotent on the last write', () => {
    setMapViewPref('satellite');
    setMapViewPref('holediagram');
    setMapViewPref('satellite');
    expect(getMapViewPref()).toBe('satellite');
  });
});
