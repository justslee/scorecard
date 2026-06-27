"use client";

import dynamic from "next/dynamic";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";

// Load the Clerk widget client-only. Under static export the page is prerendered
// with no ClerkProvider (the publishable key is injected at runtime via the build
// env), so rendering <SignIn> at prerender would throw.
const SignIn = dynamic(() => import("@clerk/clerk-react").then((m) => m.SignIn), {
  ssr: false,
});

export default function SignInClient() {
  return (
    <div
      style={{
        minHeight: "100vh",
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
      <div style={{ width: "100%", maxWidth: 400 }}>
        {/* Yardage-book masthead */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
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
            Your yardage book
          </div>
        </div>

        {/* Clerk sign-in widget. Appearance is driven by the ClerkProvider
            appearance prop (paper/ink palette). Per-element override kept minimal. */}
        <SignIn
          routing="hash"
          appearance={{
            elements: {
              rootBox: "mx-auto",
            },
          }}
        />
      </div>
    </div>
  );
}
