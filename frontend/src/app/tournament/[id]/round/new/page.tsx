import { Suspense } from "react";
import NewTournamentRoundClient from "./NewTournamentRoundClient";

// Static export shim: emit ONE real static shell ("view"); the tournament id
// is carried in the query (/tournament/view/round/new?id=…) and read
// client-side, so navigation stays client-side (no hard reload → no AuthGate
// cold-boot hang). Same fix as tournament/[id] — see lib/round-url.ts
// tournamentRoundNewHref (was "placeholder", which emitted an unreachable
// path since nothing ever navigated to it).
export function generateStaticParams() {
  return [{ id: "view" }];
}

export default function Page() {
  // Suspense required: NewTournamentRoundClient reads useSearchParams (?id=).
  return (
    <Suspense>
      <NewTournamentRoundClient />
    </Suspense>
  );
}
