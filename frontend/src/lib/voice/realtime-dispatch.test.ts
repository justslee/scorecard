/**
 * Tool-dispatch parity tests for the Realtime data-channel tools.
 *
 * The critical contract: every tool routes to the SAME session endpoint the
 * text sheet uses — record_shot must hit POST /caddie/session/shot (the P1
 * dual-write: session history + durable shots table), never a parallel path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/caddie/api', () => ({
  startRealtimeSession: vi.fn(),
  startSetupSession: vi.fn(),
  recordShot: vi.fn(async () => ({ status: 'recorded', total_shots: 1 })),
  sessionRecommend: vi.fn(async () => ({ club: '8iron', target_yards: 150 })),
  getSessionStatus: vi.fn(async () => ({ status: 'active', round_id: 'r1' })),
  getSessionConditions: vi.fn(async () => ({ weather: null, plays_like: null })),
  getSessionCarries: vi.fn(async () => ({
    round_id: 'r1',
    hole_number: 4,
    available: true,
    carries: [
      {
        type: 'bunker',
        side: 'left',
        carry_yards: 245,
        clubs_that_clear: ['Driver'],
        clubs_short_of_it: ['3 Wood'],
      },
    ],
    club_distances: { Driver: 260 },
    note: null,
  })),
  getSessionPlayerProfile: vi.fn(async () => ({ handicap: 12 })),
}));

import { dispatchTool } from './realtime';
import {
  recordShot,
  sessionRecommend,
  getSessionStatus,
  getSessionConditions,
  getSessionCarries,
  getSessionPlayerProfile,
} from '@/lib/caddie/api';

const ctx = { roundId: 'round-42' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatchTool — Realtime tool surface v1', () => {
  it('record_shot flows through the session shot endpoint (dual-write path)', async () => {
    const out = await dispatchTool(
      'record_shot',
      { hole_number: 7, club: '7iron', distance_yards: 155, result: 'green' },
      ctx,
    );
    expect(recordShot).toHaveBeenCalledWith({
      round_id: 'round-42',
      hole_number: 7,
      club: '7iron',
      distance_yards: 155,
      result: 'green',
    });
    expect(out).toEqual({ status: 'recorded', total_shots: 1 });
  });

  it('get_recommendation calls the session-aware recommender', async () => {
    await dispatchTool('get_recommendation', { hole_number: 3, distance_yards: 142 }, ctx);
    expect(sessionRecommend).toHaveBeenCalledWith({
      round_id: 'round-42',
      hole_number: 3,
      distance_yards: 142,
    });
  });

  it('get_conditions reads the session conditions (optional hole)', async () => {
    await dispatchTool('get_conditions', { hole_number: 5 }, ctx);
    expect(getSessionConditions).toHaveBeenCalledWith('round-42', 5);
    await dispatchTool('get_conditions', {}, ctx);
    expect(getSessionConditions).toHaveBeenLastCalledWith('round-42', undefined);
  });

  it('get_player_profile reads the session player profile', async () => {
    await dispatchTool('get_player_profile', {}, ctx);
    expect(getSessionPlayerProfile).toHaveBeenCalledWith('round-42');
  });

  it('get_session_status reads the session status', async () => {
    await dispatchTool('get_session_status', {}, ctx);
    expect(getSessionStatus).toHaveBeenCalledWith('round-42');
  });

  it('get_carries dispatches to the session carries endpoint with the hole number', async () => {
    const out = (await dispatchTool('get_carries', { hole_number: 4 }, ctx)) as {
      available: boolean;
      carries: Array<{ carry_yards: number }>;
    };
    expect(getSessionCarries).toHaveBeenCalledWith('round-42', 4);
    // The REAL along-path carry flows through untouched — never a stub.
    expect(out.available).toBe(true);
    expect(out.carries[0].carry_yards).toBe(245);
  });

  it('unknown tools return an error payload instead of throwing', async () => {
    const out = await dispatchTool('summon_helicopter', {}, ctx);
    expect(out).toEqual({ error: 'Unknown tool: summon_helicopter' });
  });
});
