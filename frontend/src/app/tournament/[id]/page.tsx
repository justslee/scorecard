import { Suspense } from "react";
import TournamentPageClient from "./TournamentPageClient";

// Static export shim: emit ONE real static shell ("view"); the tournament id is
// carried in the query (/tournament/view?id=…) and read client-side, so
// navigation stays client-side (no hard reload → no AuthGate cold-boot hang).
// Same fix as round/[id]. See lib/round-url.ts tournamentHref.
export function generateStaticParams() {
  return [{ id: "view" }];
}

export default function Page() {
  // Suspense required: TournamentPageClient reads useSearchParams (?id=).
  return (
    <Suspense>
      <TournamentPageClient />
    </Suspense>
  );
}
