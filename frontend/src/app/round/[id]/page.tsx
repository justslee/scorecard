import RoundPageClient from "./RoundPageClient";

// Static export shim: the real id is read client-side (useParams) at runtime,
// so we only emit a placeholder shell for this route.
export function generateStaticParams() {
  return [{ id: "placeholder" }];
}

export default function Page() {
  return <RoundPageClient />;
}
