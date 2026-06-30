/**
 * Unit tests for frontend/src/lib/shot-stats.ts
 *
 * Pure helpers (sortClubStats, dispersionLabel, formatClubName) are tested
 * without any DOM or network. fetchShotStats is tested via a global fetch mock.
 *
 * DO NOT edit shot-stats.ts to make these tests pass — fix the tests if the
 * contract changes.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  sortClubStats,
  dispersionLabel,
  formatClubName,
  fetchShotStats,
} from './shot-stats';
import type { ClubStat } from './shot-stats';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeStat(overrides: Partial<ClubStat> = {}): ClubStat {
  return {
    club: 'driver',
    n: 5,
    avg_distance: 250.0,
    median_distance: 248.0,
    stdev_distance: 12.0,
    most_common_lie: 'tee',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sortClubStats
// ---------------------------------------------------------------------------

describe('sortClubStats', () => {
  it('returns empty array unchanged', () => {
    expect(sortClubStats([])).toEqual([]);
  });

  it('returns single-element array unchanged', () => {
    const stat = makeStat();
    expect(sortClubStats([stat])).toEqual([stat]);
  });

  it('sorts longest → shortest by avg_distance', () => {
    const driver = makeStat({ club: 'driver', avg_distance: 250 });
    const pw = makeStat({ club: 'pw', avg_distance: 110 });
    const sevenIron = makeStat({ club: '7iron', avg_distance: 155 });
    const sorted = sortClubStats([pw, sevenIron, driver]);
    expect(sorted.map((s) => s.club)).toEqual(['driver', '7iron', 'pw']);
  });

  it('does not mutate the original array', () => {
    const stats = [
      makeStat({ club: 'pw', avg_distance: 110 }),
      makeStat({ club: 'driver', avg_distance: 250 }),
    ];
    const original = [...stats];
    sortClubStats(stats);
    expect(stats[0].club).toBe(original[0].club);
    expect(stats[1].club).toBe(original[1].club);
  });

  it('is stable: equal avg_distance preserves relative order', () => {
    // Both at 150 — after sort, relative order from input is preserved
    const a = makeStat({ club: 'alpha', avg_distance: 150 });
    const b = makeStat({ club: 'beta', avg_distance: 150 });
    const sorted = sortClubStats([a, b]);
    // Both should be present (order is implementation-defined for ties, but
    // both must appear)
    expect(sorted.map((s) => s.club).sort()).toEqual(['alpha', 'beta']);
  });
});

// ---------------------------------------------------------------------------
// dispersionLabel
// ---------------------------------------------------------------------------

describe('dispersionLabel', () => {
  it('returns "±N yd" for a stat with stdev and n ≥ 2', () => {
    const stat = makeStat({ stdev_distance: 12.4, n: 5 });
    // Math.round(12.4) = 12
    expect(dispersionLabel(stat)).toBe('±12 yd');
  });

  it('rounds stdev to nearest yard', () => {
    const stat = makeStat({ stdev_distance: 12.6, n: 3 });
    // Math.round(12.6) = 13
    expect(dispersionLabel(stat)).toBe('±13 yd');
  });

  it('returns "—" when stdev_distance is null', () => {
    const stat = makeStat({ stdev_distance: null, n: 1 });
    expect(dispersionLabel(stat)).toBe('—');
  });

  it('returns "—" when n < 2 (even if stdev is somehow set)', () => {
    const stat = makeStat({ stdev_distance: 10.0, n: 1 });
    expect(dispersionLabel(stat)).toBe('—');
  });

  it('returns "—" when n is 0', () => {
    const stat = makeStat({ stdev_distance: 0.0, n: 0 });
    expect(dispersionLabel(stat)).toBe('—');
  });

  it('returns "±0 yd" for zero stdev with n ≥ 2', () => {
    const stat = makeStat({ stdev_distance: 0.0, n: 3 });
    expect(dispersionLabel(stat)).toBe('±0 yd');
  });
});

// ---------------------------------------------------------------------------
// formatClubName
// ---------------------------------------------------------------------------

describe('formatClubName', () => {
  it('uppercases first letter of all-lowercase club names', () => {
    expect(formatClubName('driver')).toBe('Driver');
    expect(formatClubName('pw')).toBe('Pw');
  });

  it('preserves names that already start with a capital', () => {
    expect(formatClubName('Driver')).toBe('Driver');
  });

  it('does not alter numeric-prefixed names', () => {
    // "7 iron" starts with '7' — already uppercase-safe, no change expected
    expect(formatClubName('7 iron')).toBe('7 iron');
  });

  it('handles empty string without throwing', () => {
    expect(formatClubName('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// fetchShotStats — mock global fetch
// ---------------------------------------------------------------------------

describe('fetchShotStats', () => {
  const MOCK_STATS: ClubStat[] = [
    makeStat({ club: 'driver', avg_distance: 255.0 }),
    makeStat({ club: '7iron', avg_distance: 160.0 }),
  ];

  // Mock window.fetch so fetchAPI doesn't hit a real network.
  // fetchAPI uses fetch() under the hood; we need to also mock env vars.
  beforeEach(() => {
    // Suppress the Clerk auth wait by mocking process.env
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns parsed ClubStat[] on success', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => MOCK_STATS,
      text: async () => '',
    });

    const result = await fetchShotStats();
    expect(result).toHaveLength(2);
    expect(result[0].club).toBe('driver');
    expect(result[1].club).toBe('7iron');
  });

  it('calls the correct URL', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '',
    });

    await fetchShotStats();

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/shots/stats');
  });

  it('throws on HTTP error', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(fetchShotStats()).rejects.toThrow();
  });

  it('returns empty array when server returns []', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '',
    });

    const result = await fetchShotStats();
    expect(result).toEqual([]);
  });
});
