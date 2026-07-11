// Visibility rule for the omnipresent CaddieOrb (specs/omnipresent-caddie-orb-plan.md
// §1). Sibling of shouldShowTabBar.ts — reuses the same trailing-slash
// normalization so the two rules read consistently.
//
// S3 status: the orb now has LIVE page contexts on `/tournament/new`
// (kind:"task", tournament-prefill) and `/round/new` (kind:"surface", opens
// the existing VoiceRoundSetupRealtime) — both setup pages SHOW. The
// one-mic collision that used to gate `/round/new` off is resolved: its
// bespoke sticky-footer mic was removed (app/round/new/page.tsx), the orb IS
// the invocation there now. The sticky-CTA overlap on both setup pages is
// solved by orb clearance (CaddieOrb.tsx's `STICKY_CTA_CLEARANCE_PX`, driven
// by `isSetupCtaRoute` below), not by hiding the orb.
//
// Pill/orb interplay: on `/round/[id]` (an in-progress round) the floating
// "Ask caddie" pill in RoundPageClient.tsx (~line 2110) IS the caddie
// invocation for that page — the orb still hides there so there is never a
// second mic on screen. `/round/new` (setup, before the pill exists) is
// carved out of the `/round/` HIDE rule below so it can show.
import { normalizePath } from './shouldShowTabBar';

// Exact-match SHOW routes.
const SHOW_EXACT = [
  '/',
  '/courses',
  '/players',
  '/profile',
  '/tee-time',
  '/settings',
] as const;

// Prefix SHOW routes — dynamic detail pages under these hubs also show the orb.
// NOTE: `/courses/` (detail pages) is deliberately NOT here — see the
// `/courses` handling below.
const SHOW_PREFIXES = ['/players/', '/tournament/'] as const;

/** Setup pages with a full-width sticky bottom CTA the orb must float above
 *  (see CaddieOrb.tsx's `STICKY_CTA_CLEARANCE_PX`). Exported so the orb's
 *  clearance logic and this visibility rule share one normalized route list. */
export function isSetupCtaRoute(pathname: string): boolean {
  const p = normalizePath(pathname);
  return p === '/round/new' || p === '/tournament/new';
}

export function shouldShowCaddieOrb(pathname: string): boolean {
  if (!pathname) return false;
  const p = normalizePath(pathname);

  // `/round/new` (setup, its own registered "round-setup" surface) SHOWS;
  // every other `/round/*` route (an in-progress round) still HIDES — the
  // "Ask caddie" pill there is the invocation, so this must be checked
  // BEFORE the broader `/round/` prefix rule below.
  if (p === '/round/new') return true;
  if (p.startsWith('/round/')) return false;

  if ((SHOW_EXACT as readonly string[]).includes(p)) return true;

  // `/courses` (the list page, exact match above) has a live `context:
  // "courses"` listener in app/courses/page.tsx. Course DETAIL pages
  // (`/courses/[id]`) do not — the layout's general LooperSheet drops any
  // non-general context, so firing there today would be a dead mic. S2's
  // page-context general fallback restores `/courses/*`; until then, hide.
  return SHOW_PREFIXES.some((prefix) => p.startsWith(prefix));
}
