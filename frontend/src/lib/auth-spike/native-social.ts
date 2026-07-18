/**
 * Thin wrapper over @capgo/capacitor-social-login (pinned ^8.3.35 — see
 * specs/auth-headless-spike-plan.md §5) for the two native ID-token flows
 * (§3.3 Google, §3.4 Apple).
 *
 * Contract this wrapper enforces, by construction:
 *   - Every call is guarded by Capacitor.isNativePlatform() — this plugin
 *     has no meaningful web fallback for our purposes (the spike's web path
 *     uses signIn.sso(), a pure FAPI redirect, not this plugin).
 *   - The caller-supplied nonce is forwarded into the plugin's `login()`
 *     options for BOTH providers (nonce binding — Gate 4).
 *   - Before returning, the plugin's own `idToken` claim is verified against
 *     the nonce we sent (verifyIdTokenNonce) — an ID token whose nonce claim
 *     doesn't match is rejected here and NEVER reaches Clerk.
 *   - Only `{ idToken }` is ever returned — never the raw accessToken/profile
 *     — and the token itself is never logged (see
 *     scripts/assert-no-credential-log.mjs, gate 4).
 */

import { Capacitor } from "@capacitor/core";
import { SocialLogin } from "@capgo/capacitor-social-login";
import { verifyIdTokenNonce } from "./nonce";

let initialized = false;
let initializing: Promise<void> | null = null;

/**
 * Initialize the plugin once per process. `iOSClientId`/`iOSServerClientId`
 * (Google) and `clientId` (Apple) are FLIP-TIME values — real Google Cloud /
 * Apple Developer credentials from the ops item
 * auth-clerk-enable-social-connections. Reading from NEXT_PUBLIC_* build env
 * so no secret is hardcoded; unset in the spike (dev has no real values yet).
 */
export function initSocialLogin(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (initializing) return initializing;
  initializing = SocialLogin.initialize({
    google: {
      iOSClientId: process.env.NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID,
      // Per §3.3: MUST equal the Clerk-configured Google Web client ID, not
      // just any server client ID — that audience wiring is a flip-time
      // verification, not something the spike can prove offline.
      iOSServerClientId: process.env.NEXT_PUBLIC_GOOGLE_IOS_SERVER_CLIENT_ID,
    },
    apple: {
      clientId: process.env.NEXT_PUBLIC_APPLE_CLIENT_ID,
      useProperTokenExchange: true,
    },
  }).then(() => {
    initialized = true;
  });
  return initializing;
}

export class NonceMismatchError extends Error {
  constructor(provider: "google" | "apple") {
    super(`native-social: ${provider} ID token nonce did not match the request nonce`);
    this.name = "NonceMismatchError";
  }
}

/**
 * Native Google sign-in — returns a Google-issued ID token bound to
 * `nonce`. Rejects with NonceMismatchError if the returned token's `nonce`
 * claim doesn't match (anti-replay; never handed to Clerk on mismatch).
 */
export async function nativeGoogleIdToken(nonce: string): Promise<{ idToken: string }> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("nativeGoogleIdToken: only available on a native platform");
  }
  await initSocialLogin();
  const { result } = await SocialLogin.login({
    provider: "google",
    options: { nonce },
  });
  if (result.responseType !== "online" || !result.idToken) {
    throw new Error("nativeGoogleIdToken: plugin did not return an idToken");
  }
  const idToken = result.idToken;
  if (!(await verifyIdTokenNonce(idToken, nonce))) {
    throw new NonceMismatchError("google");
  }
  return { idToken };
}

/**
 * Native Sign in with Apple — returns an Apple-issued ID token bound to
 * `nonce` (Apple hashes the nonce into the claim; verifyIdTokenNonce
 * accepts either the raw or SHA-256(raw) form — see nonce.ts). Rejects with
 * NonceMismatchError on mismatch.
 */
export async function nativeAppleIdToken(nonce: string): Promise<{ idToken: string }> {
  if (!Capacitor.isNativePlatform()) {
    throw new Error("nativeAppleIdToken: only available on a native platform");
  }
  await initSocialLogin();
  const { result } = await SocialLogin.login({
    provider: "apple",
    options: { nonce },
  });
  if (!result.idToken) {
    throw new Error("nativeAppleIdToken: plugin did not return an idToken");
  }
  const idToken = result.idToken;
  if (!(await verifyIdTokenNonce(idToken, nonce))) {
    throw new NonceMismatchError("apple");
  }
  return { idToken };
}
