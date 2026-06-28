/**
 * Playwright global setup — Clerk testing token
 *
 * Playwright's globalSetup must export a default function (not use the test()
 * runner API). This function is called once before the entire test suite.
 *
 * When CLERK_SECRET_KEY is present, clerkSetup() calls the Clerk API to obtain
 * a short-lived testing token and writes it to the CLERK_TESTING_TOKEN env var.
 * Subsequent tests call setupClerkTestingToken({ page }) to inject that token
 * into the browser, which tells Clerk "this is an automated test" and lets the
 * bot-detection layer accept OTP code 424242 for +clerk_test addresses.
 *
 * When CLERK_SECRET_KEY is absent (local dev without credentials, CI before
 * secrets are wired) this function is a no-op; Tier 2 tests self-skip.
 */

import { clerkSetup } from "@clerk/testing/playwright";

export default async function globalSetup(): Promise<void> {
  if (!process.env.CLERK_SECRET_KEY) {
    console.log(
      "[clerk setup] CLERK_SECRET_KEY not set — skipping testing-token fetch. " +
        "Tier 2 tests (full sign-in flow) will self-skip.",
    );
    return;
  }

  // clerkSetup() reads CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY from env and
  // sets CLERK_FAPI + CLERK_TESTING_TOKEN for the rest of the test run.
  await clerkSetup({
    publishableKey:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
      process.env.CLERK_PUBLISHABLE_KEY,
  });
}
