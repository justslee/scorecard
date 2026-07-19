// @vitest-environment jsdom
//
// AuthGate's 4th (onboarding) state (specs/onboarding-shell-and-gate-plan.md
// §1.3/§6). Proves the existing-user safety invariant at the component level:
//   - onboardingStep === 'unknown' -> PaperLoading, NEVER children, NEVER a
//     redirect to /onboarding (the zero-flash tri-state)
//   - null / 'name' (not done) -> redirect to /onboarding
//   - 'done' -> children
//   - already on /onboarding + non-done -> children pass through (the flow
//     itself owns redirecting a 'done' user back to '/')
//   - NEXT_PUBLIC_AUTH_BYPASS=1 -> children, with zero onboarding evaluation
//   - signed-out states are unchanged

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

const useAuthMock = vi.fn();
vi.mock("@clerk/react", () => ({
  useAuth: () => useAuthMock(),
}));

const pathnameMock = vi.fn(() => "/");
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
  useRouter: () => ({ replace: replaceMock }),
}));

const useMeMock = vi.fn();
vi.mock("@/lib/identity", () => ({
  useMe: () => useMeMock(),
}));

vi.mock("@/app/sign-in/[[...sign-in]]/SignInClient", () => ({
  default: () => <div data-testid="sign-in-client">sign in</div>,
}));

async function importAuthGate() {
  return (await import("./AuthGate")).default;
}

function authState(isLoaded: boolean, isSignedIn: boolean) {
  return { isLoaded, isSignedIn };
}

function meState(onboardingStep: string | null | "unknown", userId: string | null = "user_1") {
  return {
    userId,
    isLoaded: true,
    isSignedIn: Boolean(userId),
    onboardingStep,
  };
}

const Children = () => <div data-testid="app-children">app</div>;

describe("AuthGate — onboarding 4th state", () => {
  beforeEach(() => {
    vi.resetModules();
    useAuthMock.mockReset();
    useMeMock.mockReset();
    pathnameMock.mockReset();
    replaceMock.mockClear();
    pathnameMock.mockReturnValue("/");
    delete process.env.NEXT_PUBLIC_AUTH_BYPASS;
  });

  afterEach(() => {
    cleanup();
    delete process.env.NEXT_PUBLIC_AUTH_BYPASS;
  });

  it("'unknown' -> PaperLoading, never children, never redirects", async () => {
    const AuthGate = await importAuthGate();
    useAuthMock.mockReturnValue(authState(true, true));
    useMeMock.mockReturnValue(meState("unknown"));

    render(
      <AuthGate>
        <Children />
      </AuthGate>,
    );

    expect(screen.queryByTestId("app-children")).toBeNull();
    expect(screen.getByText("Preparing your book")).toBeTruthy();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("null (brand-new row) -> redirects to /onboarding", async () => {
    const AuthGate = await importAuthGate();
    useAuthMock.mockReturnValue(authState(true, true));
    useMeMock.mockReturnValue(meState(null));

    render(
      <AuthGate>
        <Children />
      </AuthGate>,
    );

    expect(screen.queryByTestId("app-children")).toBeNull();
    expect(replaceMock).toHaveBeenCalledWith("/onboarding");
  });

  it("'name' (partially onboarded) -> redirects to /onboarding", async () => {
    const AuthGate = await importAuthGate();
    useAuthMock.mockReturnValue(authState(true, true));
    useMeMock.mockReturnValue(meState("name"));

    render(
      <AuthGate>
        <Children />
      </AuthGate>,
    );

    expect(screen.queryByTestId("app-children")).toBeNull();
    expect(replaceMock).toHaveBeenCalledWith("/onboarding");
  });

  it("'done' -> renders children, never redirects", async () => {
    const AuthGate = await importAuthGate();
    useAuthMock.mockReturnValue(authState(true, true));
    useMeMock.mockReturnValue(meState("done"));

    render(
      <AuthGate>
        <Children />
      </AuthGate>,
    );

    expect(screen.getByTestId("app-children")).toBeTruthy();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("already on /onboarding, step not done -> children pass through (no redirect loop)", async () => {
    const AuthGate = await importAuthGate();
    pathnameMock.mockReturnValue("/onboarding");
    useAuthMock.mockReturnValue(authState(true, true));
    useMeMock.mockReturnValue(meState("name"));

    render(
      <AuthGate>
        <Children />
      </AuthGate>,
    );

    expect(screen.getByTestId("app-children")).toBeTruthy();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("NEXT_PUBLIC_AUTH_BYPASS=1 -> children immediately, zero onboarding evaluation", async () => {
    process.env.NEXT_PUBLIC_AUTH_BYPASS = "1";
    const AuthGate = await importAuthGate();
    useAuthMock.mockReturnValue(authState(true, true));
    // Even a NOT-done step must never funnel a bypass build into onboarding —
    // the bypass short-circuit is evaluated first, unconditionally.
    useMeMock.mockReturnValue(meState("name"));

    render(
      <AuthGate>
        <Children />
      </AuthGate>,
    );

    expect(screen.getByTestId("app-children")).toBeTruthy();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("signed-out states are unchanged: !isLoaded -> PaperLoading", async () => {
    const AuthGate = await importAuthGate();
    useAuthMock.mockReturnValue(authState(false, false));
    useMeMock.mockReturnValue(meState("unknown", null));

    render(
      <AuthGate>
        <Children />
      </AuthGate>,
    );

    expect(screen.queryByTestId("app-children")).toBeNull();
    expect(screen.getByText("Preparing your book")).toBeTruthy();
  });

  it("signed-out states are unchanged: !isSignedIn -> SignInClient inline", async () => {
    const AuthGate = await importAuthGate();
    useAuthMock.mockReturnValue(authState(true, false));
    useMeMock.mockReturnValue(meState("unknown", null));

    render(
      <AuthGate>
        <Children />
      </AuthGate>,
    );

    expect(screen.getByTestId("sign-in-client")).toBeTruthy();
    expect(screen.queryByTestId("app-children")).toBeNull();
  });
});
