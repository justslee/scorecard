// Player deep-link URL helper.
//
// In the Capacitor static export (`output: 'export'`) a dynamic path segment
// like /players/<id> has no generated RSC data file, so Next falls back to a
// HARD browser navigation → Capacitor serves the root index.html shell → the
// app cold-boots and gets stuck on the AuthGate "Preparing your book" loader.
//
// Fix: navigate to a single STATICALLY-generated path (/players/view) and
// carry the real id in the query string. The pathname maps to a real
// out/players/view file (literal folder route — emitted automatically with no
// generateStaticParams needed), so the App Router transitions CLIENT-SIDE with
// no reload. PartnerProfileClient reads the id from the query (?id=) via
// useSearchParams.
// This is the established fix (round + course + tournament use the same pattern).

/** The single static player route segment (matches the literal players/view/ folder). */
export const PLAYER_VIEW_SEGMENT = "view";

/** Client-navigable URL for a saved player by id. */
export function playerHref(id: string): string {
  return `/players/${PLAYER_VIEW_SEGMENT}?id=${encodeURIComponent(id)}`;
}
