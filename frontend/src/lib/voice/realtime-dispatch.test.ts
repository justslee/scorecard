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
  getSessionShotDistance: vi.fn(async () => ({
    round_id: 'r1',
    hole_number: 14,
    available: true,
    mode: 'club',
    club: 'driver',
    carry_yards: 301,
    roll_yards: 26,
    total_yards: 327,
    plays_like_yards: null,
    suggested_club: null,
    assumptions: ['treated your 300y driver as TOTAL distance'],
  })),
  getSessionGreenRead: vi.fn(async () => ({
    round_id: 'r1',
    hole_number: 7,
    available: true,
    fall_side: 'left',
    high_side: 'right',
    uphill_leave_side: 'left',
    downhill_leave_side: 'right',
    uphill_leave_depth: null,
    read_line: 'Green falls to your left — right side is the high side; a miss left leaves the uphill putt.',
  })),
  getSessionBend: vi.fn(async () => ({
    round_id: 'r1',
    hole_number: 4,
    available: true,
    straight: false,
    direction: 'left',
    distance_yards: 270,
    deviation_yards: 88,
    double_dogleg: false,
    assumptions: ['distance measured from the tee along the hole centerline'],
  })),
}));

import { dispatchTool } from './realtime';
import {
  recordShot,
  sessionRecommend,
  getSessionStatus,
  getSessionConditions,
  getSessionCarries,
  getSessionPlayerProfile,
  getSessionShotDistance,
  getSessionGreenRead,
  getSessionBend,
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

  it('get_recommendation forwards the ctx-resolved yardage + basis (specs/caddie-numbers-coherence-plan.md §2.1 — root cause of the "125" incident: the model omits distance_yards on a normal tee-shot call, so this is the ONLY number that anchors the engine solve to the real hole yardage instead of the backend default)', async () => {
    const anchoredCtx = { roundId: 'round-42', holeYards: 466, yardageBasis: 'tee-card' as const };
    await dispatchTool('get_recommendation', { hole_number: 1 }, anchoredCtx);
    expect(sessionRecommend).toHaveBeenLastCalledWith({
      round_id: 'round-42',
      hole_number: 1,
      distance_yards: undefined,
      yards: 466,
      yardage_basis: 'tee-card',
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

  it('get_shot_distance dispatches to the session shot-distance endpoint (physics parity)', async () => {
    const out = (await dispatchTool(
      'get_shot_distance',
      { hole_number: 14, club: 'driver' },
      ctx,
    )) as { available: boolean; total_yards: number };
    expect(getSessionShotDistance).toHaveBeenCalledWith({
      round_id: 'round-42',
      hole_number: 14,
      club: 'driver',
      target_yards: undefined,
    });
    // The REAL engine total flows through untouched — the incident's 390
    // can only be killed if the persona receives the physics number.
    expect(out.available).toBe(true);
    expect(out.total_yards).toBe(327);
  });

  it('get_shot_distance forwards target_yards for plays-like solves', async () => {
    await dispatchTool('get_shot_distance', { target_yards: 150 }, ctx);
    expect(getSessionShotDistance).toHaveBeenLastCalledWith({
      round_id: 'round-42',
      hole_number: undefined,
      club: undefined,
      target_yards: 150,
    });
  });

  it('get_green_read dispatches to the session green-read endpoint with the hole number', async () => {
    const out = (await dispatchTool('get_green_read', { hole_number: 7 }, ctx)) as {
      available: boolean;
      uphill_leave_side: string;
    };
    expect(getSessionGreenRead).toHaveBeenCalledWith({ round_id: 'round-42', hole_number: 7 });
    // The REAL rotation-engine side flows through untouched — never a stub.
    expect(out.available).toBe(true);
    expect(out.uphill_leave_side).toBe('left');
  });

  it('get_green_read omits hole_number when not provided (defaults server-side)', async () => {
    await dispatchTool('get_green_read', {}, ctx);
    expect(getSessionGreenRead).toHaveBeenLastCalledWith({
      round_id: 'round-42',
      hole_number: undefined,
    });
  });

  it('get_bend dispatches to the session bend endpoint with the hole number', async () => {
    const out = (await dispatchTool('get_bend', { hole_number: 4 }, ctx)) as {
      available: boolean;
      direction: string;
    };
    expect(getSessionBend).toHaveBeenCalledWith('round-42', 4);
    // The REAL geometry direction flows through untouched — never a stub,
    // and never the deviation-sign mirror (the caddie-bend-distance crux).
    expect(out.available).toBe(true);
    expect(out.direction).toBe('left');
  });

  it('get_bend omits hole_number when not provided (defaults server-side)', async () => {
    await dispatchTool('get_bend', {}, ctx);
    expect(getSessionBend).toHaveBeenLastCalledWith('round-42', undefined);
  });

  it('unknown tools return an error payload instead of throwing', async () => {
    const out = await dispatchTool('summon_helicopter', {}, ctx);
    expect(out).toEqual({ error: 'Unknown tool: summon_helicopter' });
  });
});
