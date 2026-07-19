// Proves AuthGate's route allowlist is unchanged by the auth-headless-spike
// dev-flag wiring (specs/auth-headless-spike-plan.md §2/§7 step 1).
//
//   - flag OFF (no extraPrefixes arg, matching the default build's
//     SPIKE_AUTH_PREFIXES = []) => identical prefix behavior to before the
//     spike existed: only /sign-in and /sign-up (and sub-paths/#-hashes)
//     pass.
//   - flag ON (extraPrefixes = ["/dev/auth-spike", "/sso-callback"]) => the
//     spike routes additionally pass through; nothing else changes.
//
// This is the "prove zero-change first" test called out by the plan's build
// sequence step 1 — it must be written and green before any spike UI exists.

import { describe, expect, it } from "vitest";
import { isAuthRoute, isOnboardingRoute } from "./AuthGate";

describe("isAuthRoute — flag OFF (default build, byte-identical to today)", () => {
  it("passes /sign-in and its sub-paths", () => {
    expect(isAuthRoute("/sign-in")).toBe(true);
    expect(isAuthRoute("/sign-in/factor-one")).toBe(true);
    expect(isAuthRoute("/sign-in#/verify")).toBe(true);
  });

  it("passes /sign-up and its sub-paths", () => {
    expect(isAuthRoute("/sign-up")).toBe(true);
    expect(isAuthRoute("/sign-up/verify-email-address")).toBe(true);
  });

  it("rejects every other route, including the spike's own routes", () => {
    expect(isAuthRoute("/")).toBe(false);
    expect(isAuthRoute("/round/abc")).toBe(false);
    expect(isAuthRoute("/dev/auth-spike")).toBe(false);
    expect(isAuthRoute("/sso-callback")).toBe(false);
  });

  it("does not partial-match unrelated routes with a shared prefix substring", () => {
    // "/sign-in-something" should NOT match "/sign-in" (no "/" or "#" boundary).
    expect(isAuthRoute("/sign-in-something")).toBe(false);
    expect(isAuthRoute("/sign-upgrade")).toBe(false);
  });

  it("calling with an explicit empty array is identical to calling with none", () => {
    const routes = ["/sign-in", "/sign-up", "/", "/dev/auth-spike", "/sso-callback"];
    for (const r of routes) {
      expect(isAuthRoute(r, [])).toBe(isAuthRoute(r));
    }
  });
});

describe("isAuthRoute — flag ON (spike prefixes passed explicitly)", () => {
  const SPIKE_PREFIXES = ["/dev/auth-spike", "/sso-callback"];

  it("still passes the original /sign-in and /sign-up routes", () => {
    expect(isAuthRoute("/sign-in", SPIKE_PREFIXES)).toBe(true);
    expect(isAuthRoute("/sign-up", SPIKE_PREFIXES)).toBe(true);
  });

  it("additionally passes the spike's own routes and their sub-paths", () => {
    expect(isAuthRoute("/dev/auth-spike", SPIKE_PREFIXES)).toBe(true);
    expect(isAuthRoute("/sso-callback", SPIKE_PREFIXES)).toBe(true);
    expect(isAuthRoute("/sso-callback#/verify", SPIKE_PREFIXES)).toBe(true);
  });

  it("still rejects unrelated app routes (spike prefixes are not a general bypass)", () => {
    expect(isAuthRoute("/", SPIKE_PREFIXES)).toBe(false);
    expect(isAuthRoute("/round/abc", SPIKE_PREFIXES)).toBe(false);
    expect(isAuthRoute("/profile", SPIKE_PREFIXES)).toBe(false);
  });
});

// isOnboardingRoute (specs/onboarding-shell-and-gate-plan.md §1.3/§6) — the
// 4th AuthGate state's route boundary, same rules as isAuthRoute.
describe("isOnboardingRoute", () => {
  it("passes /onboarding and its sub-paths / hash fragments", () => {
    expect(isOnboardingRoute("/onboarding")).toBe(true);
    expect(isOnboardingRoute("/onboarding/")).toBe(true);
    expect(isOnboardingRoute("/onboarding#x")).toBe(true);
  });

  it("does not partial-match a route with a shared prefix substring", () => {
    expect(isOnboardingRoute("/onboarding-x")).toBe(false);
  });

  it("rejects unrelated routes", () => {
    expect(isOnboardingRoute("/")).toBe(false);
    expect(isOnboardingRoute("/profile")).toBe(false);
  });
});
