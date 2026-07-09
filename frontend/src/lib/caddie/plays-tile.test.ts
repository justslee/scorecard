/**
 * Unit tests for playsTileDisplay (lib/caddie/plays-tile.ts) —
 * specs/physics-tiles-coherence-plan.md §7.
 *
 * Coverage:
 *   1. Parity (the heart): pins against the SAME golden fixture the backend
 *      test_caddie_tools.py pins (backend/tests/fixtures/plays_like_parity.json,
 *      copied here) — verbatim, no local arithmetic. 173 is a value no
 *      "150 + something round" local formula reproduces by accident.
 *   2. The §5 fallback-matrix rows, one test per row.
 *
 * DO NOT modify lib/caddie/plays-tile.ts to make tests pass; fix the logic.
 */

import { describe, it, expect } from 'vitest';
import { playsTileDisplay } from './plays-tile';
import type { SessionShotDistance } from './api';
import golden from './__fixtures__/plays_like_parity.json';

const goldenFixture = golden as unknown as SessionShotDistance;

// ---------------------------------------------------------------------------
// Parity: the golden fixture, verbatim
// ---------------------------------------------------------------------------

describe('playsTileDisplay — golden parity fixture', () => {
  it('shows the physics plays_like_yards verbatim — no local math', () => {
    const result = playsTileDisplay({
      physics: goldenFixture,
      basisYards: 150,
      fallbackYards: 150,
      isLive: false,
      fromCard: false,
      hasLocalIntel: true,
    });
    expect(goldenFixture.plays_like_yards).toBe(173); // prime — no formula from 150 lands here by accident
    expect(result.v).toBe(`${goldenFixture.plays_like_yards}Y`);
    expect(result.v).toBe('173Y');
  });

  it('wind_applied + nonzero elevation_change_ft → "wind+elev" caption', () => {
    const result = playsTileDisplay({
      physics: goldenFixture,
      basisYards: 150,
      fallbackYards: 150,
      isLive: false,
      fromCard: false,
      hasLocalIntel: true,
    });
    expect(result.sub).toBe('wind+elev');
  });

  it('live basis + same golden response → "wind+elev · you"', () => {
    const result = playsTileDisplay({
      physics: goldenFixture,
      basisYards: 150,
      fallbackYards: 150,
      isLive: true,
      fromCard: false,
      hasLocalIntel: true,
    });
    expect(result.v).toBe('173Y');
    expect(result.sub).toBe('wind+elev · you');
  });
});

// ---------------------------------------------------------------------------
// §5 fallback matrix — one test per row
// ---------------------------------------------------------------------------

describe('playsTileDisplay — §5 fallback matrix', () => {
  it('Physics OK, no weather in session → plays_like_yards, "elev-adj"', () => {
    const physics: SessionShotDistance = {
      round_id: 'r1', hole_number: 4, available: true, mode: 'target',
      plays_like_yards: 156, target_yards: 150,
      conditions_used: {
        weather_available: false, wind_speed_mph: null, wind_direction: null,
        elevation_change_ft: -8, shot_bearing_deg: null, wind_applied: false,
        firmness: 'medium', temperature_f: null, air_density_kg_m3: 1.2,
      },
    };
    const result = playsTileDisplay({
      physics, basisYards: 150, fallbackYards: 150,
      isLive: false, fromCard: false, hasLocalIntel: true,
    });
    expect(result.v).toBe('156Y');
    expect(result.sub).toBe('elev-adj');
  });

  it('Physics OK, no intel (bearing unknown, wind NOT applied) → plays_like_yards, "from tee"', () => {
    const physics: SessionShotDistance = {
      round_id: 'r1', hole_number: 4, available: true, mode: 'target',
      plays_like_yards: 150, target_yards: 150,
      conditions_used: {
        weather_available: true, wind_speed_mph: 10, wind_direction: 90,
        elevation_change_ft: 0, shot_bearing_deg: null, wind_applied: false,
        firmness: 'medium', temperature_f: 70, air_density_kg_m3: 1.2,
      },
    };
    const result = playsTileDisplay({
      physics, basisYards: 150, fallbackYards: 150,
      isLive: false, fromCard: false, hasLocalIntel: false,
    });
    expect(result.v).toBe('150Y');
    expect(result.sub).toBe('from tee');
  });

  it('Physics OK, no intel, live → "from you" (still no wind/elev claim)', () => {
    const physics: SessionShotDistance = {
      round_id: 'r1', hole_number: 4, available: true, mode: 'target',
      plays_like_yards: 142, target_yards: 142,
      conditions_used: {
        weather_available: true, wind_speed_mph: 6, wind_direction: 200,
        elevation_change_ft: 0, shot_bearing_deg: null, wind_applied: false,
        firmness: 'medium', temperature_f: 70, air_density_kg_m3: 1.2,
      },
    };
    const result = playsTileDisplay({
      physics, basisYards: 142, fallbackYards: 142,
      isLive: true, fromCard: false, hasLocalIntel: false,
    });
    expect(result.v).toBe('142Y');
    expect(result.sub).toBe('from you');
  });

  it('available:false (no club distances) → plain basis, never a wind/elev claim', () => {
    const physics: SessionShotDistance = {
      round_id: 'r1', hole_number: 4, available: false,
      reason: 'No club distances on file — plays-like needs at least one.',
    };
    const result = playsTileDisplay({
      // basisYards is the raw request basis; fallbackYards is intentionally
      // a DIFFERENT (elevation-composed) number to prove this row ignores it.
      physics, basisYards: 150, fallbackYards: 999,
      isLive: false, fromCard: false, hasLocalIntel: true,
    });
    expect(result.v).toBe('150Y');
    expect(result.sub).toBe('from tee');
  });

  it('Endpoint error / offline / local round (physics null) → fallbackYards, "elev-adj" when it was effectiveYards', () => {
    const result = playsTileDisplay({
      physics: null, basisYards: 150, fallbackYards: 163,
      isLive: false, fromCard: false, hasLocalIntel: true,
    });
    expect(result.v).toBe('163Y');
    expect(result.sub).toBe('elev-adj');
  });

  it('Endpoint error / offline, no local intel → "from tee" (never "wind…")', () => {
    const result = playsTileDisplay({
      physics: null, basisYards: 150, fallbackYards: 150,
      isLive: false, fromCard: false, hasLocalIntel: false,
    });
    expect(result.v).toBe('150Y');
    expect(result.sub).toBe('from tee');
  });

  it('Card-only, physics succeeds → physics number, "wind on card" only when wind_applied', () => {
    const physics: SessionShotDistance = {
      round_id: 'r1', hole_number: 4, available: true, mode: 'target',
      plays_like_yards: 168, target_yards: 160,
      conditions_used: {
        weather_available: true, wind_speed_mph: 8, wind_direction: 90,
        elevation_change_ft: 0, shot_bearing_deg: 90, wind_applied: true,
        firmness: 'medium', temperature_f: 70, air_density_kg_m3: 1.2,
      },
    };
    const result = playsTileDisplay({
      physics, basisYards: 160, fallbackYards: 160,
      isLive: false, fromCard: true, hasLocalIntel: false,
    });
    expect(result.v).toBe('168Y');
    expect(result.sub).toBe('wind on card');
  });

  it('Card-only, physics call fails → cardYards, "from card" (no elev claim from unusable geometry)', () => {
    const result = playsTileDisplay({
      physics: null, basisYards: 160, fallbackYards: 160,
      isLive: false, fromCard: true, hasLocalIntel: false,
    });
    expect(result.v).toBe('160Y');
    expect(result.sub).toBe('from card');
  });

  it('physics===null, live, local intel present → "from you" (NEVER claims elev it never computed)', () => {
    // Round-2 review BLOCKING 2: in live rangefinder mode fallbackYards is
    // the RAW fcbLive.center (never elevation-composed), so this row must
    // not caption "elev from you" — that would claim an adjustment the
    // fallback number never applied.
    const result = playsTileDisplay({
      physics: null, basisYards: 140, fallbackYards: 140,
      isLive: true, fromCard: false, hasLocalIntel: true,
    });
    expect(result.v).toBe('140Y');
    expect(result.sub).toBe('from you');
  });

  it('Physics OK, sub-deadband elevation (2ft) → no elev claim, matches ELEV tile\'s "level"', () => {
    // Round-2 review BLOCKING 3: the ELEV tile calls anything under 3ft
    // "level"; the PLAYS caption must use the same threshold so the two
    // tiles never contradict each other on a small grade.
    const physics: SessionShotDistance = {
      round_id: 'r1', hole_number: 4, available: true, mode: 'target',
      plays_like_yards: 151, target_yards: 150,
      conditions_used: {
        weather_available: false, wind_speed_mph: null, wind_direction: null,
        elevation_change_ft: 2, shot_bearing_deg: null, wind_applied: false,
        firmness: 'medium', temperature_f: null, air_density_kg_m3: 1.2,
      },
    };
    const result = playsTileDisplay({
      physics, basisYards: 150, fallbackYards: 150,
      isLive: false, fromCard: false, hasLocalIntel: true,
    });
    expect(result.v).toBe('151Y'); // the number may still reflect real sub-deadband physics
    expect(result.sub).toBe('from tee'); // but the caption never claims "elev-adj"
  });

  it('Live rangefinder, physics succeeds → physics number with live basis, "wind+elev · you"', () => {
    const physics: SessionShotDistance = {
      round_id: 'r1', hole_number: 4, available: true, mode: 'target',
      plays_like_yards: 137, target_yards: 132,
      conditions_used: {
        weather_available: true, wind_speed_mph: 10, wind_direction: 90,
        elevation_change_ft: -5, shot_bearing_deg: 90, wind_applied: true,
        firmness: 'medium', temperature_f: 70, air_density_kg_m3: 1.2,
      },
    };
    const result = playsTileDisplay({
      physics, basisYards: 132, fallbackYards: 132,
      isLive: true, fromCard: false, hasLocalIntel: true,
    });
    expect(result.v).toBe('137Y');
    expect(result.sub).toBe('wind+elev · you');
  });
});
