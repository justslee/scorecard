/**
 * Onboarding E2E — Slice 4 (specs/onboarding-shell-and-gate-plan.md §6).
 *
 * Tier-2 pattern (needs CLERK_SECRET_KEY — same skip discipline as
 * auth.spec.ts). The profile API is fully MOCKED via page.route over an
 * in-test mutable mockProfile, so these tests need neither a real backend
 * nor a fresh Clerk sign-up — the existing Clerk test user
 * (looper+clerk_test@looperapp.org) is reused, and its "server" onboarding
 * state is entirely controlled by the mock.
 *
 * Proves the existing-user safety invariant from both directions:
 *   1. A brand-new row (onboardingStep: null) is funneled through all 4
 *      steps to Home, force-quit-mid-flow resumes at the right sub-step.
 *   2. An already-'done' row NEVER sees onboarding, even for one frame.
 */

import { test, expect, type Page } from "@playwright/test";
import { signInWithEmailCode } from "./helpers";

const hasSecretKey = !!process.env.CLERK_SECRET_KEY;

interface MockProfile {
  id: string;
  name: string | null;
  handicap: number | null;
  homeCourse: string | null;
  clubDistances: Record<string, number>;
  onboardingStep: string | null;
}

/** Mocks GET/POST/PUT /api/profile/golfer over a mutable in-test profile —
 *  every PUT body is recorded (in order) so tests can assert the exact
 *  write contract at each onboarding step. */
async function mockProfileApi(
  page: Page,
  initialOnboardingStep: string | null,
): Promise<{ puts: Record<string, unknown>[] }> {
  const mockProfile: MockProfile = {
    id: "mock-profile-id",
    name: null,
    handicap: null,
    homeCourse: null,
    clubDistances: {},
    onboardingStep: initialOnboardingStep,
  };
  const puts: Record<string, unknown>[] = [];

  await page.route("**/api/profile/golfer", async (route) => {
    const request = route.request();
    const method = request.method();

    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockProfile),
      });
      return;
    }

    if (method === "PUT" || method === "POST") {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      puts.push(body);
      if ("name" in body) mockProfile.name = body.name as string | null;
      if ("handicap" in body) mockProfile.handicap = body.handicap as number | null;
      if ("homeCourse" in body) mockProfile.homeCourse = body.homeCourse as string | null;
      if ("clubDistances" in body) {
        mockProfile.clubDistances = body.clubDistances as Record<string, number>;
      }
      if ("onboardingStep" in body) {
        mockProfile.onboardingStep = body.onboardingStep as string | null;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockProfile),
      });
      return;
    }

    await route.continue();
  });

  return { puts };
}

test.describe("Onboarding — Slice 4 (needs CLERK_SECRET_KEY)", () => {
  test.beforeEach(async ({}, testInfo) => {
    if (!hasSecretKey) {
      testInfo.annotations.push({
        type: "skip-reason",
        description: "CLERK_SECRET_KEY not set — skipping onboarding E2E.",
      });
    }
  });

  test("new-user end-to-end: Name -> Handicap -> Bag -> Meet-your-caddie -> Home", async ({
    page,
  }) => {
    test.skip(!hasSecretKey, "CLERK_SECRET_KEY not set.");

    const { puts } = await mockProfileApi(page, null);

    await signInWithEmailCode(page);
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
    await expect(page.getByText("What should your caddie call you?")).toBeVisible();

    // Continue disabled on empty and on whitespace-only.
    const nameInput = page.getByLabel("Your name");
    const nameContinue = page.getByRole("button", { name: "Continue" });
    await expect(nameContinue).toBeDisabled();
    await nameInput.fill("   ");
    await expect(nameContinue).toBeDisabled();

    await nameInput.fill("Jess");
    await expect(nameContinue).toBeEnabled();
    await nameContinue.click();

    await expect.poll(() => puts.at(-1)).toMatchObject({ name: "Jess", onboardingStep: "name" });

    // Handicap — "I'm not sure" path (explicit null clear).
    await expect(page.getByText(/What.s your handicap\?/)).toBeVisible();
    await page.getByRole("button", { name: /not sure/i }).click();

    await expect
      .poll(() => puts.at(-1))
      .toMatchObject({ handicap: null, onboardingStep: "handicap" });

    // Bag — defaults prefilled from DEFAULT_BAG_CAMEL; 7-iron -> 160.
    await expect(page.getByText(/What.s in the bag\?/)).toBeVisible();
    await expect(page.getByLabel("7-iron")).toHaveValue("160");

    const putsBeforeBag = puts.length;
    await page.getByRole("button", { name: "Use these" }).click();
    await expect.poll(() => puts.length).toBeGreaterThanOrEqual(putsBeforeBag + 2);

    const bagPuts = puts.slice(putsBeforeBag);
    const bagWrite = bagPuts.find(
      (p) => (p.clubDistances as Record<string, number> | undefined)?.sevenIron === 160,
    );
    expect(bagWrite).toBeTruthy();
    const stepWrite = bagPuts.find((p) => p.onboardingStep === "bag");
    expect(stepWrite).toBeTruthy();

    // Meet your caddie — the voice moment. Offline (no live audio session),
    // the golfer can't actually talk, so the completion affordance is the
    // always-present "Maybe later" (the "Open your book" finish appears only
    // after a real 'listening' session — covered by voice-tests + manual/
    // designer pass). Both go through the same onContinue -> done contract.
    await expect(page.getByText("Ask your caddie anything.")).toBeVisible();
    await page.getByRole("button", { name: "Maybe later" }).click();

    await expect.poll(() => puts.at(-1)).toMatchObject({ onboardingStep: "done" });
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByText("Recent rounds")).toBeVisible({ timeout: 15_000 });
  });

  test("voice-intro skip: 'Maybe later' from the intro step writes done and lands Home", async ({
    page,
  }) => {
    test.skip(!hasSecretKey, "CLERK_SECRET_KEY not set.");

    // A server 'bag' step resumes straight to the intro sub-step (initialSubStep).
    const { puts } = await mockProfileApi(page, "bag");

    await signInWithEmailCode(page);
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
    await expect(page.getByText("Ask your caddie anything.")).toBeVisible();

    // Never a dead end: the quiet escape is present + enabled from first render.
    const maybeLater = page.getByRole("button", { name: "Maybe later" });
    await expect(maybeLater).toBeEnabled();
    await maybeLater.click();

    await expect.poll(() => puts.at(-1)).toMatchObject({ onboardingStep: "done" });
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByText("Recent rounds")).toBeVisible({ timeout: 15_000 });
  });

  test("voice-intro mic-deny: denied mic is not a dead end — sheet shows the error, skip still completes", async ({
    page,
  }) => {
    test.skip(!hasSecretKey, "CLERK_SECRET_KEY not set.");

    // Resume straight to the intro step (server 'bag'); do NOT grant mic
    // permission, so the real orb's getUserMedia rejects with NotAllowedError.
    const { puts } = await mockProfileApi(page, "bag");

    await signInWithEmailCode(page);
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
    await expect(page.getByText("Ask your caddie anything.")).toBeVisible();

    // Tap the REAL production orb (its idle aria-label) — the one standardized
    // invocation; there is no bespoke mic on this step.
    await page.getByRole("button", { name: /Talk to your caddie/ }).click();

    // Production deny path: useLooperDictation sets "Microphone access denied."
    // and CaddieOrbSheet promotes docked -> full so the error is visible.
    await expect(page.getByText("Microphone access denied.")).toBeVisible({ timeout: 15_000 });

    // Close the full sheet and confirm the step is still completable.
    await page.getByRole("button", { name: "Close Looper" }).click();
    const maybeLater = page.getByRole("button", { name: "Maybe later" });
    await expect(maybeLater).toBeEnabled();
    await maybeLater.click();

    await expect.poll(() => puts.at(-1)).toMatchObject({ onboardingStep: "done" });
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  });

  test("existing-user zero-onboarding: a 'done' row never sees /onboarding", async ({ page }) => {
    test.skip(!hasSecretKey, "CLERK_SECRET_KEY not set.");

    await mockProfileApi(page, "done");

    const visitedPaths: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      try {
        visitedPaths.push(new URL(frame.url()).pathname);
      } catch {
        // Non-http(s) navigation — ignore.
      }
    });

    await signInWithEmailCode(page);
    await expect(page.getByText("Recent rounds")).toBeVisible({ timeout: 15_000 });

    expect(visitedPaths.some((p) => p.startsWith("/onboarding"))).toBe(false);
    await expect(page.getByText("What should your caddie call you?")).toHaveCount(0);
  });

  test("mid-flow kill/resume: reload after Name lands on Handicap, not Name or Home", async ({
    page,
  }) => {
    test.skip(!hasSecretKey, "CLERK_SECRET_KEY not set.");

    await mockProfileApi(page, null);

    await signInWithEmailCode(page);
    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });

    await page.getByLabel("Your name").fill("Alex");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/What.s your handicap\?/)).toBeVisible();

    // The kill/relaunch analogue: cold re-hydration through the real gate.
    await page.reload();

    await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
    await expect(page.getByText(/What.s your handicap\?/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("What should your caddie call you?")).toHaveCount(0);
    await expect(page.getByText("Recent rounds")).toHaveCount(0);
  });
});
