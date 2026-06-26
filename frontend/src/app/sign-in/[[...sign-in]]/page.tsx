import SignInClient from "./SignInClient";

// Optional catch-all under static export: emit just the base /sign-in shell.
// Clerk handles sub-steps client-side via hash routing (routing="hash").
export function generateStaticParams() {
  return [{ "sign-in": [] }];
}

export default function Page() {
  return <SignInClient />;
}
