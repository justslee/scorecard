/**
 * Playwright configuration — Looper E2E gate
 *
 * Tests live in frontend/e2e/.
 * Run locally:  npm run test:e2e
 *
 * Environment variables:
 *   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY — enables the AuthGate in the app (public key).
 *     Tier 1 tests (sign-in screen renders) require this.
 *   CLERK_PUBLISHABLE_KEY             — alternate name; the config forwards it as
 *     NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY to the dev server if the NEXT_PUBLIC_ form
 *     isn't already set.
 *   CLERK_SECRET_KEY                  — enables clerkSetup() and full sign-in tests.
 *     Tier 2 tests (complete auth flow + core journeys) require this.
 *
 * Without any Clerk keys the webServer starts normally; Tier 1 and Tier 2 tests
 * skip themselves with clear messages. This keeps the runner green in plain dev
 * environments while the CI advisory job provides the real signal.
 */

import { defineConfig, devices } from "@playwright/test";

// Forward CLERK_PUBLISHABLE_KEY → NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY so the Next.js
// dev server (webServer child process) activates the AuthGate even when only the
// un-prefixed form is set (common in CI / @clerk/testing convention).
const nextPublicClerkKey =
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
  process.env.CLERK_PUBLISHABLE_KEY ||
  "";

export default defineConfig({
  testDir: "./e2e",

  // global.setup.ts obtains a Clerk testing token so Tier 2 tests can bypass
  // bot detection. It is a no-op when CLERK_SECRET_KEY is absent.
  globalSetup: "./e2e/global.setup.ts",

  // Retry once on CI to absorb transient network flakiness in Clerk widget load.
  retries: process.env.CI ? 1 : 0,

  // Prefer one worker in CI to avoid racing against the single dev server.
  workers: process.env.CI ? 1 : undefined,

  use: {
    baseURL: "http://localhost:3000",
    // Capture a trace on first retry only (keeps run artifacts small).
    trace: "on-first-retry",
    // Screenshots on failure for faster debugging.
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // Use next dev so the AuthGate (ClerkProvider) initialises correctly.
    // The static export (next build → out/) is only for production/Capacitor;
    // Playwright always tests against the live dev server.
    command: "npm run dev",
    port: 3000,
    // Reuse an already-running dev server locally; always spin a fresh one in CI.
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    // Pass the Clerk publishable key to the dev server child process so
    // AuthProvider wraps children in ClerkProvider + AuthGate.
    env: {
      ...(nextPublicClerkKey
        ? { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: nextPublicClerkKey }
        : {}),
    },
  },
});
