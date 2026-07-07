import { describe, it, expect } from 'vitest';
import {
  INITIAL_TRANSPORT_STATE,
  transportReducer,
  surfaceForTier,
  mapStatusToVoiceState,
  messagesToTurns,
  type TransportEvent,
  type TransportState,
} from './transport';
import type { RealtimeMessage } from '@/lib/voice/realtime';

function run(events: TransportEvent[], from: TransportState = INITIAL_TRANSPORT_STATE) {
  return events.reduce(transportReducer, from);
}

describe('transportReducer — degradation ladder', () => {
  it('happy path: press → mint → connect stays on tier 1, live', () => {
    const s = run([{ type: 'PRESS' }, { type: 'MINT_OK' }, { type: 'CONNECTED' }]);
    expect(s).toEqual({ tier: 'realtime', phase: 'live', downgradeReason: null });
  });

  it('mint slower than the 3s budget degrades to the text sheet', () => {
    const s = run([{ type: 'PRESS' }, { type: 'MINT_TIMEOUT' }]);
    expect(s.tier).toBe('text');
    expect(s.downgradeReason).toBe('mint_timeout');
  });

  it('ICE/SDP failure before going live degrades to the text sheet', () => {
    const s = run([{ type: 'PRESS' }, { type: 'MINT_OK' }, { type: 'CONNECT_FAILED' }]);
    expect(s.tier).toBe('text');
    expect(s.downgradeReason).toBe('connect_failed');
  });

  it('a fatal mid-burst error degrades to the text sheet', () => {
    const s = run([
      { type: 'PRESS' },
      { type: 'MINT_OK' },
      { type: 'CONNECTED' },
      { type: 'REALTIME_ERROR' },
    ]);
    expect(s.tier).toBe('text');
  });

  it('a clean idle disconnect keeps tier 1 healthy (next press reconnects)', () => {
    const s = run([
      { type: 'PRESS' },
      { type: 'MINT_OK' },
      { type: 'CONNECTED' },
      { type: 'DISCONNECTED' },
    ]);
    expect(s).toEqual({ tier: 'realtime', phase: 'idle', downgradeReason: null });
  });

  it('MINT_TIMEOUT after the mint already succeeded is ignored (stale deadline)', () => {
    const s = run([{ type: 'PRESS' }, { type: 'MINT_OK' }, { type: 'MINT_TIMEOUT' }]);
    expect(s.tier).toBe('realtime');
    expect(s.phase).toBe('connecting');
  });

  it('a second PRESS while phase is already connecting (e.g. adopting a warm client) is a no-op — no re-mint', () => {
    const connecting = run([{ type: 'PRESS' }, { type: 'MINT_OK' }]);
    expect(connecting.phase).toBe('connecting');
    const pressedAgain = transportReducer(connecting, { type: 'PRESS' });
    expect(pressedAgain).toEqual(connecting); // unchanged — same object shape, no fresh minting phase
    expect(pressedAgain.tier).toBe('realtime');
  });

  it('a second PRESS while phase is already minting (warm() dispatched first) is also a no-op', () => {
    const minting = run([{ type: 'PRESS' }]);
    expect(minting.phase).toBe('minting');
    expect(transportReducer(minting, { type: 'PRESS' })).toEqual(minting);
  });

  it('going offline drops straight to tier 3 from any tier', () => {
    expect(run([{ type: 'WENT_OFFLINE' }]).tier).toBe('offline');
    const fromText = run([{ type: 'PRESS' }, { type: 'MINT_TIMEOUT' }, { type: 'WENT_OFFLINE' }]);
    expect(fromText.tier).toBe('offline');
    const fromLive = run([
      { type: 'PRESS' },
      { type: 'MINT_OK' },
      { type: 'CONNECTED' },
      { type: 'WENT_OFFLINE' },
    ]);
    expect(fromLive.tier).toBe('offline');
  });

  it('coming back online climbs back to the top of the ladder', () => {
    const s = run([{ type: 'WENT_OFFLINE' }, { type: 'BACK_ONLINE' }]);
    expect(s).toEqual(INITIAL_TRANSPORT_STATE);
  });

  it('BACK_ONLINE does not disturb a healthy realtime tier', () => {
    const live = run([{ type: 'PRESS' }, { type: 'MINT_OK' }, { type: 'CONNECTED' }]);
    expect(transportReducer(live, { type: 'BACK_ONLINE' })).toEqual(live);
  });

  it('text tier stays put until an explicit silent retry', () => {
    const text = run([{ type: 'PRESS' }, { type: 'MINT_TIMEOUT' }]);
    expect(transportReducer(text, { type: 'PRESS' }).tier).toBe('text');
    expect(transportReducer(text, { type: 'CONNECTED' }).tier).toBe('text');
    expect(transportReducer(text, { type: 'RETRY_REALTIME' })).toEqual(INITIAL_TRANSPORT_STATE);
  });

  it('offline tier ignores everything except BACK_ONLINE', () => {
    const off = run([{ type: 'WENT_OFFLINE' }]);
    expect(transportReducer(off, { type: 'PRESS' }).tier).toBe('offline');
    expect(transportReducer(off, { type: 'RETRY_REALTIME' }).tier).toBe('offline');
  });

  it('surfaceForTier picks the press surface per tier', () => {
    expect(surfaceForTier('realtime')).toBe('voice');
    expect(surfaceForTier('text')).toBe('text');
    expect(surfaceForTier('offline')).toBe('offline');
  });
});

describe('mapStatusToVoiceState — realtime status → orb/sheet state', () => {
  it('connecting reads as thinking (calm spin-up)', () => {
    expect(mapStatusToVoiceState('connecting', false)).toBe('thinking');
    expect(mapStatusToVoiceState('connecting', true)).toBe('thinking');
  });

  it('holding the mic reads as listening even before server VAD confirms', () => {
    expect(mapStatusToVoiceState('connected', true)).toBe('listening');
    expect(mapStatusToVoiceState('connected', false)).toBe('idle');
  });

  it('passes through listening/speaking', () => {
    expect(mapStatusToVoiceState('listening', false)).toBe('listening');
    expect(mapStatusToVoiceState('speaking', false)).toBe('speaking');
  });

  it('idle/closed/error all read as idle (no error states on paper)', () => {
    expect(mapStatusToVoiceState('idle', false)).toBe('idle');
    expect(mapStatusToVoiceState('closed', false)).toBe('idle');
    expect(mapStatusToVoiceState('error', false)).toBe('idle');
  });
});

describe('messagesToTurns — realtime transcript → VoiceSheet turns', () => {
  const msg = (over: Partial<RealtimeMessage>): RealtimeMessage => ({
    id: 'm1',
    role: 'user',
    text: 'hello',
    partial: false,
    order: 0,
    ...over,
  });

  it('maps assistant → caddy and user → user, in order', () => {
    const turns = messagesToTurns([
      msg({ id: 'u1', role: 'user', text: 'What should I hit?', order: 0 }),
      msg({ id: 'a1', role: 'assistant', text: 'Easy 8.', order: 1 }),
    ]);
    expect(turns).toEqual([
      { role: 'user', text: 'What should I hit?' },
      { role: 'caddy', text: 'Easy 8.' },
    ]);
  });

  it('drops empty/whitespace partials so no blank bubbles render', () => {
    const turns = messagesToTurns([
      msg({ id: 'a1', role: 'assistant', text: '  ', partial: true }),
      msg({ id: 'u1', role: 'user', text: 'wind?' }),
    ]);
    expect(turns).toEqual([{ role: 'user', text: 'wind?' }]);
  });
});
