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
import type { GolferProfile } from '../types';

/** Mirror of backend DEFAULT_CLUB_DISTANCES (club_selection.py), re-keyed to the
 *  GolferProfile camelCase keys via buildClubMap's mapping run in reverse.
 *  KEEP IN SYNC. Backend short key → camel key → yards:
 *    driver→driver 250 · 3wood→threeWood 230 · 5wood→fiveWood 215 · hybrid→hybrid 200
 *    4iron→fourIron 190 · 5iron→fiveIron 180 · 6iron→sixIron 170 · 7iron→sevenIron 160
 *    8iron→eightIron 150 · 9iron→nineIron 140 · pw→pitchingWedge 130 · gw→gapWedge 115
 *    sw→sandWedge 100 · lw→lobWedge 85 · (no putter in backend defaults — putter stays unset)
 *
 *  Used by the onboarding Bag step (frontend/src/components/onboarding/BagStep.tsx)
 *  to prefill sensible defaults so a first-run golfer can accept-and-move-on.
 */
export const DEFAULT_BAG_CAMEL: GolferProfile['clubDistances'] = {
  driver: 250, threeWood: 230, fiveWood: 215, hybrid: 200,
  fourIron: 190, fiveIron: 180, sixIron: 170, sevenIron: 160,
  eightIron: 150, nineIron: 140, pitchingWedge: 130, gapWedge: 115,
  sandWedge: 100, lobWedge: 85,
};

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
