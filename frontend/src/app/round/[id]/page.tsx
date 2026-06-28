import { Suspense } from "react";
import RoundPageClient from "./RoundPageClient";

// Static export shim: we emit ONE real static shell ("view"); the round id is
// carried in the query string (/round/view?id=…) and read client-side, so
// navigation stays client-side (no hard reload → no Capacitor index.html
// fallback → no cold-boot AuthGate hang). See lib/round-url.ts.
export function generateStaticParams() {
  return [{ id: "view" }];
}

export default function Page() {
  // Suspense boundary required because RoundPageClient reads useSearchParams()
  // (the round id comes from ?id=) — static export prerender bails to CSR here.
  return (
    <Suspense>
      <RoundPageClient />
    </Suspense>
  );
}
