// Visibility rule for the omnipresent CaddieOrb (specs/omnipresent-caddie-orb-plan.md
// §1). Sibling of shouldShowTabBar.ts — reuses the same trailing-slash
// normalization so the two rules read consistently.
//
// Pill/orb interplay: on `/round/[id]` the floating "Ask caddie" pill in
// RoundPageClient.tsx (~line 2110) IS the caddie invocation for that page —
// the orb hides there so there is never a second mic on screen. Every other
// hub/task page (including `/round/new`, before a round exists) shows the
// orb as usual.
import { normalizePath } from './shouldShowTabBar';

// Exact-match SHOW routes.
const SHOW_EXACT = [
  '/',
  '/courses',
  '/players',
  '/profile',
  '/tee-time',
  '/settings',
  '/round/new',
  '/tournament/new',
] as const;

// Prefix SHOW routes — dynamic detail pages under these hubs also show the orb.
const SHOW_PREFIXES = ['/courses/', '/players/', '/tournament/'] as const;

export function shouldShowCaddieOrb(pathname: string): boolean {
  if (!pathname) return false;
  const p = normalizePath(pathname);

  // `/round/[id]` is the one deliberate exception: the round page's own
  // "Ask caddie" pill is the invocation there, so hide the orb to avoid
  // doubling mics. `/round/new` (no round yet — voice setup) still shows.
  if (p.startsWith('/round/')) return p === '/round/new';

  if ((SHOW_EXACT as readonly string[]).includes(p)) return true;

  return SHOW_PREFIXES.some((prefix) => p.startsWith(prefix));
}
