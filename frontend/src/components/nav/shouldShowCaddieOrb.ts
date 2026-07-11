// Visibility rule for the omnipresent CaddieOrb (specs/omnipresent-caddie-orb-plan.md
// §1). Sibling of shouldShowTabBar.ts — reuses the same trailing-slash
// normalization so the two rules read consistently.
//
// S1 is a PURE PLACEMENT MIGRATION: the orb only fires the existing
// `openLooper` bus event with `looperContextForPath` — it has no per-page
// context wiring yet (that lands in S2/S3). So a route may only SHOW here if
// (a) the context it fires has a live listener today, and (b) it doesn't
// collide with a sticky CTA or an existing bespoke voice control on that page.
//
// Pill/orb interplay: on `/round/[id]` the floating "Ask caddie" pill in
// RoundPageClient.tsx (~line 2110) IS the caddie invocation for that page —
// the orb hides there so there is never a second mic on screen. Every other
// hub/task page shows the orb as usual, EXCEPT the setup pages below, which
// have their own pre-existing voice control / sticky CTA until S3 unifies them.
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

export function shouldShowCaddieOrb(pathname: string): boolean {
  if (!pathname) return false;
  const p = normalizePath(pathname);

  // Every `/round/*` route hides the orb. `/round/[id]` already has its own
  // "Ask caddie" pill (see header). `/round/new` has its own bespoke
  // voice-setup mic (app/round/new/page.tsx ~line 1087,
  // aria-label="Set up round by voice") AND a sticky "Tee off" CTA — until S3
  // wires the orb to that same `openVoiceSetup` flow, showing it here would
  // stack a second, forked mic on top of the existing one.
  if (p.startsWith('/round/')) return false;

  // `/tournament/new` has its own sticky "Create tournament" CTA (~line 632)
  // that the low-right orb would overlap. Checked before the `/tournament/`
  // prefix below so other tournament detail pages (no sticky footer) still
  // show normally.
  if (p === '/tournament/new') return false;

  if ((SHOW_EXACT as readonly string[]).includes(p)) return true;

  // `/courses` (the list page, exact match above) has a live `context:
  // "courses"` listener in app/courses/page.tsx. Course DETAIL pages
  // (`/courses/[id]`) do not — the layout's general LooperSheet drops any
  // non-general context, so firing there today would be a dead mic. S2's
  // page-context general fallback restores `/courses/*`; until then, hide.
  return SHOW_PREFIXES.some((prefix) => p.startsWith(prefix));
}
