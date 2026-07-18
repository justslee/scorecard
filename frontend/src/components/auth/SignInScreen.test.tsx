// @vitest-environment jsdom
//
// SignInScreen — render smoke test (login-screen-visual plan §1 file list).
// Proves the e2e-contract copy survives ("Your yardage book" — Tier-1
// literal-text pin), the disabled-OAuth treatment, the live email pill, and
// that zero prebuilt-Clerk widget DOM (`.cl-*` / `input[name="identifier"]`)
// leaks through. `useAuthFlow` is mocked here — its own transitions are
// fully covered by useAuthFlow.test.ts; this file is purely a render smoke
// over a fixed "method" step.

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isSignedIn: false }),
}));

// Same passthrough pattern as CaddieOrb.test.tsx — jsdom has no rAF, so
// framer-motion's real animation runtime is swapped for plain DOM passthrough.
vi.mock("framer-motion", () => {
  const Passthrough = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const { initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...rest } = props;
    return React.createElement("div", { ...rest, ref });
  });
  Passthrough.displayName = "motion.div";
  return {
    motion: { div: Passthrough },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useReducedMotion: () => false,
  };
});

const flowState = {
  step: "method" as const,
  intent: "signIn" as const,
  emailMethod: "code" as const,
  emailAddress: "",
  flowOwner: null,
  busy: false,
  error: null as string | null,
  resendAvailableAt: null,
};

vi.mock("./useAuthFlow", () => ({
  useAuthFlow: () => ({
    state: flowState,
    chooseEmail: vi.fn(),
    submitPassword: vi.fn(),
    sendCode: vi.fn(),
    verifyCode: vi.fn(),
    resendCode: vi.fn(),
    back: vi.fn(),
    toggleIntent: vi.fn(),
    toggleEmailMethod: vi.fn(),
  }),
}));

import SignInScreen from "./SignInScreen";

afterEach(() => {
  cleanup();
});

describe("SignInScreen — render smoke", () => {
  it("shows the e2e-contract kicker text 'Your yardage book'", () => {
    render(<SignInScreen intent="signIn" />);
    expect(screen.getByText("Your yardage book")).toBeTruthy();
  });

  it("shows the 'Looper.' wordmark", () => {
    render(<SignInScreen intent="signIn" />);
    expect(screen.getByText("Looper.")).toBeTruthy();
  });

  it("renders Apple and Google as aria-disabled, live email pill enabled", () => {
    render(<SignInScreen intent="signIn" />);

    const apple = screen.getByRole("button", { name: "Continue with Apple" }) as HTMLButtonElement;
    expect(apple.disabled).toBe(true);
    expect(apple.getAttribute("aria-disabled")).toBe("true");

    const google = screen.getByRole("button", { name: "Continue with Google" }) as HTMLButtonElement;
    expect(google.disabled).toBe(true);
    expect(google.getAttribute("aria-disabled")).toBe("true");

    const email = screen.getByRole("button", { name: "Continue with email" }) as HTMLButtonElement;
    expect(email.disabled).toBe(false);
  });

  it("shows the honest disabled-OAuth caption", () => {
    render(<SignInScreen intent="signIn" />);
    expect(screen.getByText(/Apple & Google coming online shortly/i)).toBeTruthy();
  });

  it("renders zero prebuilt-Clerk widget DOM", () => {
    const { container } = render(<SignInScreen intent="signIn" />);
    expect(container.querySelector('input[name="identifier"]')).toBeNull();
    expect(container.querySelector("[class*='cl-']")).toBeNull();
  });

  it("does not render home content ('Recent rounds')", () => {
    render(<SignInScreen intent="signIn" />);
    expect(screen.queryByText("Recent rounds")).toBeNull();
  });
});
