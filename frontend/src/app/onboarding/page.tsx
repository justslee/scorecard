"use client";

/**
 * /onboarding — the resumable first-run onboarding route (Slice 4,
 * specs/onboarding-shell-and-gate-plan.md §2.8). Mirrors SignInClient.tsx's
 * pattern exactly: client-only via dynamic(ssr:false), so no Clerk/identity
 * hooks ever run at static-export prerender — AuthGate's OnboardingRedirect
 * is what actually navigates here.
 */

import dynamic from "next/dynamic";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";

const OnboardingFlow = dynamic(() => import("@/components/onboarding/OnboardingFlow"), {
  ssr: false,
  loading: () => <PaperShell />,
});

/** Static paper background + masthead — the pre-hydration first paint. */
function PaperShell() {
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
        Getting set up
      </div>
    </div>
  );
}

export default function Page() {
  return <OnboardingFlow />;
}
