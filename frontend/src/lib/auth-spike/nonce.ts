/**
 * Nonce generation + verification for the native Google/Apple ID-token flows
 * (specs/auth-headless-spike-plan.md §3.3/§3.4, Gate 4 nonce-binding half).
 *
 * We generate a random nonce client-side, forward it to the native
 * SocialLogin plugin, and — BEFORE ever handing the resulting ID token to
 * Clerk — verify the token's own `nonce` claim matches what we asked for.
 * This is the anti-replay binding we can enforce entirely client-side:
 *   - Google echoes the raw nonce string in the ID token's `nonce` claim.
 *   - Apple hashes the nonce (SHA-256, hex) into the ID token's `nonce`
 *     claim (Sign in with Apple's documented behavior).
 * verifyIdTokenNonce() accepts either form so one call works for both
 * providers; callers should still know which provider they used (documented
 * in native-social.ts) for anything provider-specific.
 *
 * Uses WebCrypto (crypto.getRandomValues / crypto.subtle.digest) — available
 * in both the browser/WKWebView runtime and Node's global `crypto` (Node 19+,
 * and Vitest's node test environment), so no polyfill/mocking is needed.
 */

import { decodeJwtPayload } from "./jwt-parity";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 32 random bytes, hex-encoded (64 hex chars) — the raw nonce sent to the native plugin. */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** SHA-256 of a UTF-8 string, hex-encoded — how Apple binds the nonce into its ID token. */
export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Decode `idToken` (no signature verification — that happens on the
 * backend/at the provider) and confirm its `nonce` claim matches `rawNonce`
 * either directly (Google) or as SHA-256(rawNonce) (Apple). Returns false
 * (never throws) on a missing/malformed claim or a genuine mismatch, so
 * callers can uniformly reject and never log the token itself.
 */
export async function verifyIdTokenNonce(idToken: string, rawNonce: string): Promise<boolean> {
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwtPayload(idToken);
  } catch {
    return false;
  }
  const claim = payload.nonce;
  if (typeof claim !== "string" || claim.length === 0) return false;
  if (claim === rawNonce) return true;
  const hashed = await sha256Hex(rawNonce);
  return claim === hashed;
}
