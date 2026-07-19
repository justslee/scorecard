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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isSignedIn: false }),
}));

// Same passthrough pattern as CaddieOrb.test.tsx / HoleIllustration.test.tsx
// — jsdom has no rAF, so framer-motion's real animation runtime is swapped
// for plain DOM passthrough. Covers `motion.div` (SignInScreen's own
// wordmark/header/sheet entrances) PLUS `motion.g/path/rect/circle/text`
// (login-animation-moment plan §5 — the real HoleIllustration import needs
// these now; without them `<motion.rect>` etc. resolve to `undefined` and
// the suite crashes).
vi.mock("framer-motion", () => {
  const tagFor: Record<string, string> = {
    div: "div",
    g: "g",
    path: "path",
    rect: "rect",
    circle: "circle",
    text: "text",
  };
  const cache = new Map<string, React.ForwardRefExoticComponent<Record<string, unknown>>>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const domTag = tagFor[tag];
        if (!domTag) return undefined;
        const cached = cache.get(domTag);
        if (cached) return cached;
        const Passthrough = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
          const {
            initial: _initial,
            animate: _animate,
            exit: _exit,
            transition: _transition,
            variants: _variants,
            custom: _custom,
            ...rest
          } = props;
          return React.createElement(domTag, { ...rest, ref });
        });
        Passthrough.displayName = `motion.${domTag}`;
        cache.set(domTag, Passthrough);
        return Passthrough;
      },
    },
  );
  return {
    motion,
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

const HERO_DRAW_SEEN_KEY = "looper.loginHeroDrawSeen";

// jsdom in this repo doesn't ship window.localStorage — stub a minimal
// in-memory implementation so the "play once" guard in SignInScreen (which
// touches localStorage in a useEffect) has something to read/write. Same
// pattern as CaddieOrb.test.tsx. A fresh stub every test is the "clear"
// (each `beforeEach` starts from an empty store).
function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (n: number) => Object.keys(store)[n] ?? null,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeLocalStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

// login-animation-moment plan §3.1/§3.2/§5 — "play once, on cold arrival
// only". `heroIntroPlayedThisSession` is a module-scope latch inside
// SignInScreen.tsx, so each of these tests resets the module registry and
// re-imports fresh — otherwise the latch set by an earlier test in this file
// would leak into the next one.
describe("SignInScreen — hero intro 'play once' (login-animation-moment plan §3)", () => {
  it("first mount writes the seen flag to localStorage", async () => {
    expect(localStorage.getItem(HERO_DRAW_SEEN_KEY)).toBeNull();

    vi.resetModules();
    const { default: FreshSignInScreen } = await import("./SignInScreen");
    render(<FreshSignInScreen intent="signIn" />);

    await waitFor(() => {
      expect(localStorage.getItem(HERO_DRAW_SEEN_KEY)).toBe("1");
    });
  });

  it("still renders the full screen when the flag is already set (no replay)", async () => {
    localStorage.setItem(HERO_DRAW_SEEN_KEY, "1");

    vi.resetModules();
    const { default: FreshSignInScreen } = await import("./SignInScreen");
    render(<FreshSignInScreen intent="signIn" />);

    expect(screen.getByText("Your yardage book")).toBeTruthy();
    expect(screen.getByText("Looper.")).toBeTruthy();
  });

  it("still renders the full screen when localStorage throws (private mode)", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("private mode — storage disabled");
      },
      setItem: () => {
        throw new Error("private mode — storage disabled");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });

    vi.resetModules();
    const { default: FreshSignInScreen } = await import("./SignInScreen");
    render(<FreshSignInScreen intent="signIn" />);

    expect(screen.getByText("Your yardage book")).toBeTruthy();
    expect(screen.getByText("Looper.")).toBeTruthy();
  });
});
