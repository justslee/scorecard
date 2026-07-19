/**
 * Shared Playwright helpers — extracted from auth.spec.ts so both the auth
 * suite and onboarding.spec.ts (Slice 4, specs/onboarding-shell-and-gate-plan.md
 * §2.16) can drive the same sign-in flow without duplicating it. Zero
 * behavior change from the original inline version in auth.spec.ts.
 */

import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * The Looper Clerk dev-instance test user.
 * Create (or verify) in the Clerk dashboard → Users → "looper+clerk_test@looperapp.org".
 * Any +clerk_test address auto-accepts OTP 424242 in Clerk dev/test mode.
 */
export const TEST_USER_EMAIL = "looper+clerk_test@looperapp.org";

/**
 * Drives the full custom headless sign-in flow (email/code — the primary
 * method) from the home page's inline AuthGate sign-in screen through to
 * the signed-in home shell. The aria-labels/button names below are the
 * test contract kept in sync with SignInScreen.tsx (login-screen-visual
 * plan §3).
 */
export async function signInWithEmailCode(page: Page) {
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await expect(page.getByText("Your yardage book")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByLabel("Email address").fill(TEST_USER_EMAIL);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByLabel("Six-digit code").fill("424242");
  await page.getByRole("button", { name: "Verify" }).click();
}
