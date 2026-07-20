/**
 * Centralized sign-out residue teardown
 * (specs/multiuser-p0-signout-namespace-clear-plan.md §1).
 *
 * The ONE place that tears down all per-user device state on sign-out, so
 * nothing resolves to the prior account for the next user on the same
 * device — whether sign-out was triggered by the Profile button, server-side
 * revocation, session expiry, or a headless `clerk.signOut()` call. Called
 * ONLY from the reactive signed-in→signed-out transition in
 * `ClerkTokenBridge.tsx` (never from the button itself — see
 * `components/auth/useAuthFlow.ts:23`), so it always runs AFTER Clerk has
 * already cleared its own session state. That ordering matters: clearing the
 * namespace pointer before/while Clerk tears down would have it resurrected
 * by the very next synchronous `getCurrentUserId()` read (`identity-core.ts`'s
 * opportunistic re-write).
 *
 * Extracted into its own module (not inlined in ClerkTokenBridge) so it is
 * unit-testable in vitest without React, and the ordering is documented in
 * ONE place. Every step below is individually try/caught so one failure
 * (e.g. a Keychain error) can never skip another step — in particular, the
 * namespace-pointer clear (step 2, the TOCTOU fix) must always run.
 */

import { Capacitor } from "@capacitor/core";
import { stopActiveRealtimeClient } from "@/lib/voice/realtime";
import { warmSession } from "@/lib/voice/warm-session";
import { clearLastUserId, resetOnboardingOnSignOut } from "@/lib/identity";
import { clearNativeToken } from "@/lib/native-token-store";
import { setAuthDiag } from "@/lib/auth-diag";

export async function runSignOutTeardown(): Promise<void> {
  // 1. Stop the live caddie — releases the mic/WebRTC first (a live hot-mic
  //    surviving sign-out is the worst residue). Both are synchronous +
  //    idempotent, safe even though React unmount usually got there first.
  try {
    stopActiveRealtimeClient();
  } catch (e) {
    console.error("[sign-out-teardown] realtime stop failed:", e);
  }
  try {
    warmSession.teardown();
  } catch (e) {
    console.error("[sign-out-teardown] warm-session teardown failed:", e);
  }

  // 2. Clear the namespace pointer — THE TOCTOU fix. After this every
  //    storageKey() read resolves to the anon namespace, never the prior
  //    user's.
  try {
    clearLastUserId();
  } catch (e) {
    console.error("[sign-out-teardown] clearLastUserId failed:", e);
  }

  // 3. Reset in-memory identity module state (onboarding snapshot +
  //    hydratedForUserId guard, together — see resetOnboardingOnSignOut's
  //    doc comment for why).
  try {
    resetOnboardingOnSignOut();
  } catch (e) {
    console.error("[sign-out-teardown] resetOnboardingOnSignOut failed:", e);
  }

  // 4. Native only — Keychain (+ legacy plaintext Preferences) clear.
  //    Preserves the exact diag behavior this replaces
  //    (ClerkTokenBridge.tsx, pre-teardown-extraction).
  if (Capacitor.isNativePlatform()) {
    try {
      await clearNativeToken();
      setAuthDiag({ tokenRestored: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuthDiag({ lastError: `token-clear: ${msg}` });
    }
  }
}
