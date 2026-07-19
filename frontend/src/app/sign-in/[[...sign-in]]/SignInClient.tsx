"use client";

import dynamic from "next/dynamic";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";

// Load the headless sign-in screen client-only. Under static export the
// page is prerendered with no ClerkProvider (the publishable key is
// injected at runtime via the build env), so any Clerk-hook component
// would throw at prerender time. `PaperShell` below is the `loading`
// placeholder — instant first paint, no white screen — while the real
// screen (and Clerk) load in.
const SignInScreen = dynamic(() => import("@/components/auth/SignInScreen"), {
  ssr: false,
  loading: () => <PaperShell kicker="Your yardage book" />,
});

// Load the auth diagnostic strip client-only for the same reason: useAuth()
// requires a live <ClerkProvider> which is not available at prerender time.
// On-device (TestFlight) this shows auth state, token restoration, Native API
// status, and the WebView origin so the owner can validate without rebuilding.
const NativeAuthDiag = dynamic(
  () => import("@/components/NativeAuthDiag"),
  { ssr: false },
);

/** Static paper background + masthead — the pre-hydration first paint. */
function PaperShell({ kicker }: { kicker: string }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "max(14px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom))",
        fontFamily: T.sans,
      }}
    >
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 44,
          letterSpacing: -1,
          color: T.ink,
          lineHeight: 1,
        }}
      >
        Looper.
      </div>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 8.5,
          letterSpacing: 1.8,
          color: T.pencil,
          textTransform: "uppercase",
          marginTop: 10,
        }}
      >
        {kicker}
      </div>
    </div>
  );
}

export default function SignInClient() {
  return (
    <>
      <SignInScreen intent="signIn" />

      {/* On-screen auth diagnostic — visible on native (TestFlight) or when
          NEXT_PUBLIC_AUTH_DIAG=1.  Shows the exact Clerk state so the owner
          can read isLoaded / isSignedIn / token restored / Native API status
          / origin off the screen without rebuilding blind. */}
      <NativeAuthDiag />
    </>
  );
}
