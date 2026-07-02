// Club-distance mapping — golfer profile (storage.ts camelCase keys) → the
// backend caddie API's short club codes. Shared by CaddieSheet (per-call
// stateless context) and RoundPageClient (session/start hydration).

import { getGolferProfile } from '../storage';

export function buildClubMap(): Record<string, number> {
  const profile = getGolferProfile();
  const clubMap: Record<string, number> = {};
  if (!profile?.clubDistances) return clubMap;
  const cd = profile.clubDistances;
  const mapping: Array<[keyof typeof cd, string]> = [
    ['driver', 'driver'],
    ['threeWood', '3w'],
    ['fiveWood', '5w'],
    ['hybrid', 'hy'],
    ['fourIron', '4i'],
    ['fiveIron', '5i'],
    ['sixIron', '6i'],
    ['sevenIron', '7i'],
    ['eightIron', '8i'],
    ['nineIron', '9i'],
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
