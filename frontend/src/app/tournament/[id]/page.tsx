import TournamentPageClient from "./TournamentPageClient";

// Static export shim: the real id is read client-side at runtime, so we only
// emit a placeholder shell for this route.
export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function Page() {
  return <TournamentPageClient />;
}
