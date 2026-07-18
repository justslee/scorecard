// Club-distance mapping — golfer profile (storage.ts camelCase keys) → the
// backend caddie API's canonical club keys (physics.CLUB_REFERENCE /
// club_selection.CLUB_DISPLAY_NAMES). Shared by CaddieSheet (per-call
// stateless context) and RoundPageClient (session/start hydration).
//
// This is the wire's OTHER end from `backend/app/caddie/club_selection.py`'s
// `_CLUB_ALIASES`: this map now emits canonical keys directly (driver,
// 3wood, 5wood, hybrid, 4iron…9iron, pw, gw, sw, lw) instead of short codes,
// so no alias lookup is needed on the read side — canonical keys resolve to
// themselves. specs/caddie-yardage-selector-p0-plan.md §2.2 (P0 2026-07-18):
// this used to emit `hybrid -> 'hy'`, but the backend alias table had no
// 'hy' entry (only '3h'), so `normalize_club_distances` silently DROPPED the
// hybrid for every hybrid-carrying golfer. The backend alias table still
// keeps 'hy'/'3w'/'4i'/... forever (additive-only, for legacy stored rows
// and LLM/voice shorthand that never goes through this function), but this
// map no longer produces them.

import { getGolferProfile } from '../storage';

export function buildClubMap(): Record<string, number> {
  const profile = getGolferProfile();
  const clubMap: Record<string, number> = {};
  if (!profile?.clubDistances) return clubMap;
  const cd = profile.clubDistances;
  const mapping: Array<[keyof typeof cd, string]> = [
    ['driver', 'driver'],
    ['threeWood', '3wood'],
    ['fiveWood', '5wood'],
    ['hybrid', 'hybrid'],
    ['fourIron', '4iron'],
    ['fiveIron', '5iron'],
    ['sixIron', '6iron'],
    ['sevenIron', '7iron'],
    ['eightIron', '8iron'],
    ['nineIron', '9iron'],
    ['pitchingWedge', 'pw'],
    ['gapWedge', 'gw'],
    ['sandWedge', 'sw'],
    ['lobWedge', 'lw'],
  ];
  for (const [ts, api] of mapping) {
    const v = cd[ts];
    if (v !== undefined) clubMap[api] = v;
  }
  return clubMap;
}
