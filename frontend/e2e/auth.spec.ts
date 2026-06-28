/**
 * Auth smoke tests — Looper E2E gate
 *
 * These tests cover the critical sign-in path that our existing gates
 * (voice-tests, vitest, next build) never exercise. A broken sign-in
 * was the #1 QA gap the owner called out.
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

import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { test, expect } from "@playwright/test";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const hasPublicKey = !!(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
  process.env.CLERK_PUBLISHABLE_KEY
);
const hasSecretKey = !!process.env.CLERK_SECRET_KEY;

/**
 * The Looper Clerk dev-instance test user.
 * Create (or verify) in the Clerk dashboard → Users → "looper+clerk_test@looperapp.org".
 * Any +clerk_test address auto-accepts OTP 424242 in Clerk dev/test mode.
 */
const TEST_USER_EMAIL = "looper+clerk_test@looperapp.org";

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
    // "Your yardage book" is the mono kicker on SignInClient — unique to the
    // sign-in screen; it does NOT appear on the home page after auth.
    await expect(page.getByText("Your yardage book")).toBeVisible({
      timeout: 15_000,
    });

    // Confirm the Looper masthead is shown (not a blank/crash or home content).
    await expect(page.getByText("Looper.").first()).toBeVisible({
      timeout: 5_000,
    });

    // Confirm no home-page content leaked through the gate.
    await expect(page.getByText("Recent rounds")).not.toBeVisible();
  });
});

// ─── Tier 2: Full sign-in flow + core journeys ────────────────────────────────

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

  test("completes sign-in with Clerk test user and reaches home", async ({
    page,
  }) => {
    test.skip(
      !hasSecretKey,
      "CLERK_SECRET_KEY not set — skipping full sign-in flow.",
    );

    // Inject the Clerk testing token so bot-detection accepts OTP 424242.
    await setupClerkTestingToken({ page });

    await page.goto("/");

    // Wait for the sign-in screen.
    await expect(page.getByText("Your yardage book")).toBeVisible({
      timeout: 15_000,
    });

    // Enter the test user email. Clerk's SignIn widget with routing="hash"
    // renders the identifier field at the root URL (embedded in AuthGate).
    const emailInput = page.locator('input[name="identifier"]');
    await emailInput.waitFor({ timeout: 10_000 });
    await emailInput.fill(TEST_USER_EMAIL);

    // Submit the email to proceed to the OTP step.
    await page.locator('button[type="submit"]').first().click();

    // Clerk transitions to OTP entry. The widget renders up to 6 individual
    // digit inputs. Typing into the first input propagates through all of them.
    const firstDigit = page
      .locator(
        // Multiple possible Clerk OTP field selectors across versions.
        [
          'input[data-otp-input-index="0"]',
          'input[aria-label*="digit 1"], input[aria-label*="Digit 1"]',
          ".cl-otpCodeFieldInput",
          'input[autocomplete="one-time-code"]',
        ].join(", "),
      )
      .first();

    await firstDigit.waitFor({ timeout: 10_000 });
    // Focus the first digit and type; Clerk moves focus automatically.
    await firstDigit.focus();
    await page.keyboard.type("424242");

    // Submit OTP (Clerk auto-submits on the last digit, but also provide a click
    // fallback in case auto-submit doesn't fire in the headless environment).
    const submitBtn = page.locator('button[type="submit"]').first();
    const homeContent = page.getByText("Recent rounds");

    // Wait for either auto-completion or the submit button to appear & be clicked.
    await Promise.race([
      homeContent.waitFor({ timeout: 15_000 }),
      submitBtn
        .waitFor({ timeout: 3_000 })
        .then(() => submitBtn.click())
        .catch(() => undefined),
    ]);

    // After sign-in, the AuthGate clears and the home page renders.
    await expect(homeContent).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Your yardage book")).not.toBeVisible();
  });

  test("home screen shows expected shell after sign-in", async ({ page }) => {
    test.skip(
      !hasSecretKey,
      "CLERK_SECRET_KEY not set — skipping core journey.",
    );

    await setupClerkTestingToken({ page });
    await page.goto("/");

    // Sign in (same flow as above — compact version).
    await expect(page.getByText("Your yardage book")).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('input[name="identifier"]').fill(TEST_USER_EMAIL);
    await page.locator('button[type="submit"]').first().click();

    const firstDigit = page
      .locator(
        [
          'input[data-otp-input-index="0"]',
          'input[aria-label*="digit 1"], input[aria-label*="Digit 1"]',
          ".cl-otpCodeFieldInput",
          'input[autocomplete="one-time-code"]',
        ].join(", "),
      )
      .first();
    await firstDigit.waitFor({ timeout: 10_000 });
    await firstDigit.focus();
    await page.keyboard.type("424242");

    // Wait for home to appear.
    await expect(page.getByText("Recent rounds")).toBeVisible({
      timeout: 15_000,
    });

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

    await setupClerkTestingToken({ page });
    await page.goto("/");

    await expect(page.getByText("Your yardage book")).toBeVisible({
      timeout: 15_000,
    });
    await page.locator('input[name="identifier"]').fill(TEST_USER_EMAIL);
    await page.locator('button[type="submit"]').first().click();

    const firstDigit = page
      .locator(
        [
          'input[data-otp-input-index="0"]',
          'input[aria-label*="digit 1"], input[aria-label*="Digit 1"]',
          ".cl-otpCodeFieldInput",
          'input[autocomplete="one-time-code"]',
        ].join(", "),
      )
      .first();
    await firstDigit.waitFor({ timeout: 10_000 });
    await firstDigit.focus();
    await page.keyboard.type("424242");
    await expect(page.getByText("Recent rounds")).toBeVisible({
      timeout: 15_000,
    });

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
});
