/**
 * /dev/auth-spike — hidden route hosting the auth-headless-spike's throwaway
 * UI (specs/auth-headless-spike-plan.md §1/§2). Never linked to from the
 * real app.
 *
 * Flag OFF (default build, NEXT_PUBLIC_AUTH_SPIKE unset): renders a static
 * stub only. AuthSpikePanel is dynamically imported — its chunk is only
 * fetched if this branch actually mounts it, which it never does on a
 * default build. Zero user-visible change: the route is unlinked, and even
 * a signed-in owner who guesses the URL sees only this stub.
 *
 * Flag ON: dynamically imports AuthSpikePanel with ssr:false — the same
 * proven pattern SignInClient uses for <SignIn>/<NativeAuthDiag>, so the
 * static-export prerender pass never touches Clerk hooks.
 */

"use client";

import dynamic from "next/dynamic";
import { AUTH_SPIKE_ENABLED } from "@/lib/auth-spike/spike-flag";

const AuthSpikePanel = dynamic(
  () => import("@/components/auth-spike/AuthSpikePanel"),
  { ssr: false },
);

export default function AuthSpikePage() {
  if (!AUTH_SPIKE_ENABLED) {
    return (
      <div style={{ padding: 24, fontFamily: "monospace" }}>
        auth-headless-spike disabled (set NEXT_PUBLIC_AUTH_SPIKE=1 to enable).
      </div>
    );
  }
  return <AuthSpikePanel />;
}
