/**
 * Provider registry.
 *
 * Providers self-register at module load time; the active provider is chosen
 * by the NEXT_PUBLIC_TEETIME_PROVIDER env var (default: "mock").
 *
 * Adding a real provider (Phase 2+):
 *   1. Implement TeeTimeProvider in providers/<name>.ts.
 *   2. Import it here and call registerProvider("chronogolf", new ChronogolfProvider()).
 *   3. Set NEXT_PUBLIC_TEETIME_PROVIDER=chronogolf in the deployment env.
 *   4. Zero UI changes required.
 */

import type { TeeTimeProvider } from "./provider";
import { mockProvider } from "./providers/mock";

const _registry = new Map<string, TeeTimeProvider>();

/** Register a provider under a stable name. */
export function registerProvider(name: string, provider: TeeTimeProvider): void {
  _registry.set(name, provider);
}

/** Retrieve a provider by name. Returns undefined if not registered. */
export function getProvider(name: string): TeeTimeProvider | undefined {
  return _registry.get(name);
}

/**
 * Return the currently active provider.
 * Reads NEXT_PUBLIC_TEETIME_PROVIDER; falls back to "mock".
 */
export function getActiveProvider(): TeeTimeProvider {
  const name =
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_TEETIME_PROVIDER) ||
    "mock";
  const provider = _registry.get(name);
  if (!provider) {
    // Graceful fallback: always return mock so dev/demo never breaks.
    return mockProvider;
  }
  return provider;
}

// ─── Default registrations ────────────────────────────────────────────────────
// Register the mock provider at module load so getActiveProvider() always works.
registerProvider("mock", mockProvider);

// TODO(Phase 2): import ChronogolfProvider and register when creds are present.
// TODO(Phase 3): import GolfNowProvider and register when creds are present.
