import { Suspense } from "react";
import PartnerProfileClient from "./PartnerProfileClient";

// players/view is a literal folder route (not a [dynamic] segment), so the
// static export emits out/players/view automatically — no generateStaticParams
// needed (verified by analogy: out/round/new exists; round/new/page.tsx has no
// generateStaticParams). The <Suspense> boundary IS required because
// PartnerProfileClient reads useSearchParams() — static prerender bails to CSR
// at this boundary (same reason as CourseDetailClient / RoundPageClient).

export default function Page() {
  return (
    <Suspense>
      <PartnerProfileClient />
    </Suspense>
  );
}
