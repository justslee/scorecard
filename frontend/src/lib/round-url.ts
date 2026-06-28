// Round deep-link URL helper.
//
// In the Capacitor static export (`output: 'export'`) a dynamic path segment
// like /round/<uuid> has no generated RSC data file, so Next falls back to a
// HARD browser navigation → Capacitor serves the root index.html shell → the
// app cold-boots and gets stuck on the AuthGate "Preparing your book" loader.
//
// Fix: navigate to a single STATICALLY-generated path (/round/view) and carry
// the real id in the query string. The pathname maps to a real out/round/view
// file, so the App Router transitions CLIENT-SIDE with no reload, ClerkProvider
// stays mounted, and the round renders instantly. RoundPageClient reads the id
// from the query (?id=) — see useSearchParams there.

/** The single static round route segment (matches generateStaticParams in round/[id]/page.tsx). */
export const ROUND_VIEW_SEGMENT = "view";

/** Client-navigable URL for a round by id. */
export function roundHref(id: string): string {
  return `/round/${ROUND_VIEW_SEGMENT}?id=${encodeURIComponent(id)}`;
}

/** Same static-path + query-id trick for tournaments (see round/[id] note). */
export function tournamentHref(id: string): string {
  return `/tournament/${ROUND_VIEW_SEGMENT}?id=${encodeURIComponent(id)}`;
}
