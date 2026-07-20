/**
 * Auth smoke tests — Looper E2E gate
 *
 * These tests cover the critical sign-in path that our existing gates
 * (voice-tests, vitest, next build) never exercise. A broken sign-in
 * was the #1 QA gap the owner called out.
 *
 * Rewritten for the custom headless login screen (login-screen-visual plan
 * §7) — drives `SignInScreen` directly (email/code and email/password),
 * not the prebuilt Clerk `<SignIn>` widget (deleted this slice).
 *
 * ─── Tier breakdown ────────────────────────────────────────────────────────
 *
 *  Tier 1 — "AuthGate renders sign-in screen" (1 test)
 *    Needs: NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (public key — not a secret).
 *    Skips: when the key is absent (AuthProvider is inactive, no gate).
 *    Can become REQUIRED once CLERK_PUBLISHABLE_KEY is added as a CI secret.
 *
 *  Tier 2 — "Full sign-in flow + core journeys" (3 tests)
 *    Needs: CLERK_SECRET_KEY + a Clerk test user in the dev Clerk instance.
 *    Skips: automatically when CLERK_SECRET_KEY is absent.
 *    Test user setup: in the Clerk dashboard for the dev instance, create (or
 *    confirm auto-creation of) looper+clerk_test@looperapp.org. Any +clerk_test
 *    email works with OTP 424242 in Clerk's dev / test mode.
 *    Promoted to REQUIRED once the Clerk credentials are wired into CI secrets:
 *      CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY
 *
 * ─── What this does NOT cover ───────────────────────────────────────────────
 *  Capacitor webview origin (capacitor://) issues cannot be caught here.
 *  This web E2E runs against the Next.js dev server at localhost:3000 and
 *  tests the web flow only. Webview-specific regressions still need a
 *  simulator smoke (or a real device build via TestFlight) per ship.
 *
 * ─── Local run ──────────────────────────────────────────────────────────────
 *  npm run test:e2e
 *
 *  For Tier 1 only (no sign-in, just auth-gate render):
 *    export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_… && npm run test:e2e
 *
 *  For Tier 2 (full flow):
 *    export CLERK_PUBLISHABLE_KEY=pk_test_…
 *    export CLERK_SECRET_KEY=sk_test_…
 *    npm run test:e2e
 */

import { test, expect } from "@playwright/test";
import { signInWithEmailCode } from "./helpers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const hasPublicKey = !!(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
  process.env.CLERK_PUBLISHABLE_KEY
);
const hasSecretKey = !!process.env.CLERK_SECRET_KEY;

// ─── Tier 1: AuthGate sign-in screen render ───────────────────────────────────

test.describe("Tier 1 — AuthGate", () => {
  test("renders sign-in screen for an unauthenticated user", async ({
    page,
  }) => {
    // Without NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, AuthProvider renders children
    // directly (no gate). This test is only meaningful with the key active.
    test.skip(
      !hasPublicKey,
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY not set — AuthGate is inactive; " +
        "add CLERK_PUBLISHABLE_KEY to CI secrets to enable this check.",
    );

    await page.goto("/");

    // PaperLoading renders first while Clerk initialises. Wait for it to resolve.
    // "Your yardage book" is the mono kicker on SignInScreen's hero — unique to
    // the sign-in screen; it does NOT appear on the home page after auth.
    await expect(page.getByText("Your yardage book")).toBeVisible({
      timeout: 15_000,
    });

    // Confirm the Looper masthead is shown (not a blank/crash or home content).
    await expect(page.getByText("Looper.").first()).toBeVisible({
      timeout: 5_000,
    });

    // Confirm no home-page content leaked through the gate.
    await expect(page.getByText("Recent rounds")).not.toBeVisible();

    // The custom headless method-step controls are present: live email pill,
    // Apple/Google rendered but disabled (login-screen-visual plan §3).
    const emailButton = page.getByRole("button", { name: "Continue with email" });
    await expect(emailButton).toBeVisible();
    await expect(emailButton).toBeEnabled();

    const appleButton = page.getByRole("button", { name: "Continue with Apple" });
    await expect(appleButton).toBeVisible();
    await expect(appleButton).toBeDisabled();

    const googleButton = page.getByRole("button", { name: "Continue with Google" });
    await expect(googleButton).toBeVisible();
    await expect(googleButton).toBeDisabled();

    // The prebuilt Clerk `<SignIn>` widget is gone — no identifier field.
    await expect(page.locator('input[name="identifier"]')).toHaveCount(0);
  });
});

// ─── Tier 2: Full auth flow + core journeys ────────────────────────────────

test.describe("Tier 2 — Full auth flow (needs CLERK_SECRET_KEY)", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (!hasSecretKey) {
      testInfo.annotations.push({
        type: "skip-reason",
        description:
          "CLERK_SECRET_KEY not set — Tier 2 tests are advisory-only until " +
          "CI secrets are configured (see tasks/progress.md).",
      });
    }
  });

  test("completes sign-in with Clerk test user (email code) and reaches home", async ({
    page,
  }) => {
    test.skip(
      !hasSecretKey,
      "CLERK_SECRET_KEY not set — skipping full sign-in flow.",
    );

    await signInWithEmailCode(page);
    await expect(page.getByText("Recent rounds")).toBeVisible({ timeout: 15_000 });

    // After sign-in, the AuthGate clears and the home page renders.
    await expect(page.getByText("Your yardage book")).not.toBeVisible();
  });

  test("home screen shows expected shell after sign-in", async ({ page }) => {
    test.skip(
      !hasSecretKey,
      "CLERK_SECRET_KEY not set — skipping core journey.",
    );

    await signInWithEmailCode(page);
    await expect(page.getByText("Recent rounds")).toBeVisible({ timeout: 15_000 });

    // Home shell: "Start a round" CTA must be present.
    // The exact greeting ("Good morning." etc.) varies by time of day, so we
    // assert a stable part of the primary CTA instead.
    await expect(page.getByText("Start a round, call a shot")).toBeVisible({
      timeout: 5_000,
    });

    // Profile link is reachable (aria-label set in page.tsx).
    await expect(page.getByRole("link", { name: "Open your profile" })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("navigating to new round screen renders without crashing", async ({
    page,
  }) => {
    test.skip(
      !hasSecretKey,
      "CLERK_SECRET_KEY not set — skipping core journey.",
    );

    await signInWithEmailCode(page);
    await expect(page.getByText("Recent rounds")).toBeVisible({ timeout: 15_000 });

    // Navigate to the new round screen.
    await page.goto("/round/new");

    // The new-round screen must render (not crash to blank). It shows a voice
    // setup flow. Wait for a stable element that appears without network data.
    // VoiceRoundSetup renders a mic button or a "Set up a round" prompt.
    await expect(
      page
        .getByText(/set up a round|start a round|new round/i)
        .or(page.locator("[aria-label*='microphone'], [aria-label*='Mic']"))
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // Critically: no error boundary / blank page.
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("sign out from Profile clears the namespace pointer and returns to sign-in", async ({
    page,
  }) => {
    test.skip(
      !hasSecretKey,
      "CLERK_SECRET_KEY not set — skipping sign-out journey.",
    );

    await signInWithEmailCode(page);
    await expect(page.getByText("Recent rounds")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("link", { name: "Open your profile" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Yes, sign out" }).click();

    await expect(page.getByText("Your yardage book")).toBeVisible({ timeout: 15_000 });

    // Centralized sign-out teardown (specs/multiuser-p0-signout-namespace-
    // clear-plan.md §1): the namespace pointer must be gone so nothing
    // resolves to this account for the next user on this device.
    const lastUserId = await page.evaluate(() =>
      window.localStorage.getItem("scorecard_last_user_id"),
    );
    expect(lastUserId).toBeNull();
  });
});
