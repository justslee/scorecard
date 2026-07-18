/**
 * Single source of truth for the auth-headless-spike dev flag.
 *
 * NEXT_PUBLIC_AUTH_SPIKE=1 is a build-time env var — the same proven
 * mechanism as NEXT_PUBLIC_AUTH_DIAG / NEXT_PUBLIC_AUTH_BYPASS (see
 * AuthGate.tsx). Because NEXT_PUBLIC_* vars are inlined at build time,
 * AUTH_SPIKE_ENABLED is a statically-false constant in every default build,
 * so any code gated on it is dead-code-eliminated by the bundler — zero
 * user-visible change, zero runtime toggle, zero hidden gesture.
 *
 * See specs/auth-headless-spike-plan.md §1.
 */

export const AUTH_SPIKE_ENABLED = process.env.NEXT_PUBLIC_AUTH_SPIKE === "1";

/**
 * URL prefixes that must stay reachable while signed out, ONLY when the
 * spike flag is on. AuthGate.tsx merges these into its auth-route allowlist.
 * Both routes render only auth UI/diagnostics — never protected app
 * children — so this is NOT an auth-bypass surface
 * (see scripts/assert-no-auth-bypass.mjs, unchanged by this file).
 */
export const SPIKE_AUTH_PREFIXES: string[] = AUTH_SPIKE_ENABLED
  ? ["/dev/auth-spike", "/sso-callback"]
  : [];
