/**
 * JWT-parity comparator for the auth-headless-spike (Gate 1 —
 * specs/auth-headless-spike-plan.md §6).
 *
 * The spike's central security question is: does a session JWT minted by a
 * CUSTOM headless flow (email/code, Google web, Google native ID-token,
 * Apple native ID-token) look IDENTICAL — same `iss`, same `azp`, same
 * claim-key shape — to a JWT minted by the unchanged prebuilt <SignIn>
 * widget? If so, the unchanged backend (backend/app/services/clerk_auth.py)
 * accepting the widget's token is strong evidence it accepts the custom
 * flows' tokens too.
 *
 * This module never verifies a signature — it only decodes the payload
 * (base64url, no crypto) and compares claim shape. Signature verification
 * happens on the backend (JWKS) and is exercised separately by
 * backend/tests/test_clerk_jwt_parity.py.
 */

export interface JwtClaimShape {
  iss: string | undefined;
  azp: string | undefined;
  /** Sorted claim keys — drift in the set of claims present is visible even
   *  when iss/azp match (Clerk v2 session-claim additions like fva/sts). */
  claimKeys: string[];
}

export interface JwtParityDiff {
  field: "iss" | "azp" | "claimKeys";
  baseline: string;
  candidate: string;
}

export interface JwtParityResult {
  ok: boolean;
  diffs: JwtParityDiff[];
}

/**
 * Decode a JWT's payload (the middle base64url segment) without verifying
 * the signature. Never logs or returns the raw token string.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("decodeJwtPayload: not a JWT (expected 3 dot-separated segments)");
  }
  const payloadSegment = parts[1];
  // base64url -> base64
  const base64 = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const json =
    typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("utf-8");
  return JSON.parse(json) as Record<string, unknown>;
}

/** Extract the comparable claim shape from a decoded JWT payload. */
export function claimShape(payload: Record<string, unknown>): JwtClaimShape {
  return {
    iss: typeof payload.iss === "string" ? payload.iss : undefined,
    azp: typeof payload.azp === "string" ? payload.azp : undefined,
    claimKeys: Object.keys(payload).sort(),
  };
}

/**
 * Compare a candidate claim shape against a baseline (captured from the
 * prebuilt widget's session JWT). Named diffs so the panel and the verdict
 * can report exactly what differed.
 */
export function assertJwtParity(
  baseline: JwtClaimShape,
  candidate: JwtClaimShape,
): JwtParityResult {
  const diffs: JwtParityDiff[] = [];

  if (baseline.iss !== candidate.iss) {
    diffs.push({
      field: "iss",
      baseline: String(baseline.iss),
      candidate: String(candidate.iss),
    });
  }

  if (baseline.azp !== candidate.azp) {
    diffs.push({
      field: "azp",
      baseline: String(baseline.azp),
      candidate: String(candidate.azp),
    });
  }

  const baselineKeys = baseline.claimKeys.join(",");
  const candidateKeys = candidate.claimKeys.join(",");
  if (baselineKeys !== candidateKeys) {
    diffs.push({
      field: "claimKeys",
      baseline: baselineKeys,
      candidate: candidateKeys,
    });
  }

  return { ok: diffs.length === 0, diffs };
}
