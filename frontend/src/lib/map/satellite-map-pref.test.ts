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
  it('returns "holediagram" when nothing is stored (fresh user / safe default)', () => {
    expect(getMapViewPref()).toBe('holediagram');
  });

  it('returns "satellite" when "satellite" was previously stored', () => {
    mockStorage.setItem(MAP_VIEW_PREF_KEY, 'satellite');
    expect(getMapViewPref()).toBe('satellite');
  });

  it('returns "holediagram" for an unrecognised stored value (defensive)', () => {
    mockStorage.setItem(MAP_VIEW_PREF_KEY, 'google');
    expect(getMapViewPref()).toBe('holediagram');
  });

  it('returns "holediagram" for an empty string', () => {
    mockStorage.setItem(MAP_VIEW_PREF_KEY, '');
    expect(getMapViewPref()).toBe('holediagram');
  });

  it('returns "holediagram" for a random string', () => {
    mockStorage.setItem(MAP_VIEW_PREF_KEY, 'mapbox');
    expect(getMapViewPref()).toBe('holediagram');
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
  it('key absent + no stored pref → renderer "holediagram", pref "holediagram"', () => {
    expect(mapRendererFor(undefined)).toBe('holediagram');
    expect(getMapViewPref()).toBe('holediagram');
  });

  it('key absent + pref "satellite" → renderer still "holediagram" (key wins)', () => {
    setMapViewPref('satellite');
    // No key → mapRendererFor returns 'holediagram' regardless of stored pref.
    expect(mapRendererFor(undefined)).toBe('holediagram');
    expect(mapRendererFor('')).toBe('holediagram');
    expect(mapRendererFor('   ')).toBe('holediagram');
  });

  it('key present + no stored pref → renderer "google", pref "holediagram" (safe default)', () => {
    // Key is present but no preference stored yet — renderer says 'google'
    // but the UI gate should check getMapViewPref() before auto-loading.
    // This test documents the expected values for each part of the gate.
    expect(mapRendererFor('AIzaSyABC123')).toBe('google');
    expect(getMapViewPref()).toBe('holediagram'); // no pref stored → safe default
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
