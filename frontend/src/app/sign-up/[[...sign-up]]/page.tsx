import SignUpClient from "./SignUpClient";

// Optional catch-all under static export: emit just the base /sign-up shell.
// Clerk handles sub-steps client-side via hash routing (routing="hash").
export function generateStaticParams() {
  return [{ "sign-up": [] }];
}

export default function Page() {
  return <SignUpClient />;
}
