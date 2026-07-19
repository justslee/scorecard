// @vitest-environment jsdom
//
// Gate 3 — SIGN-OUT CLEARS KEYCHAIN VIA THE CENTRAL OBSERVER
// (specs/auth-headless-spike-plan.md §6). Proves ClerkTokenBridge's existing
// wasSignedIn-guarded transition observer still fires correctly:
//   1. signed-in -> signed-out (native)  => clearNativeToken() called ONCE
//   2. cold-start (never signed in)      => clearNativeToken() NEVER called
//   3. same transition, non-native       => clearNativeToken() NEVER called
//
// This spike adds NO per-site clearNativeToken() calls anywhere — clearing
// stays centralized here, exactly as it is today. This test only proves the
// EXISTING behavior, unchanged by the spike.

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const clearNativeToken = vi.fn(async () => undefined);
vi.mock("@/lib/native-token-store", () => ({
  clearNativeToken: (...args: unknown[]) => clearNativeToken(...(args as [])),
}));

vi.mock("@/lib/auth-token", () => ({
  setTokenGetter: vi.fn(),
}));

vi.mock("@/lib/auth-diag", () => ({
  setAuthDiag: vi.fn(),
}));

const isNativePlatform = vi.fn(() => true);
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativePlatform() },
}));

// useAuth() mock — the test drives isLoaded/isSignedIn transitions by
// re-rendering with a new mocked return value.
const useAuthMock = vi.fn();
vi.mock("@clerk/react", () => ({
  useAuth: () => useAuthMock(),
}));

async function importBridge() {
  return (await import("./ClerkTokenBridge")).default;
}

function authState(isLoaded: boolean, isSignedIn: boolean) {
  return { isLoaded, isSignedIn, getToken: vi.fn(async () => null) };
}

describe("ClerkTokenBridge — sign-out clears the Keychain via the central observer", () => {
  beforeEach(() => {
    vi.resetModules();
    clearNativeToken.mockClear();
    isNativePlatform.mockReturnValue(true);
    useAuthMock.mockReset();
  });

  it("signed-in -> signed-out (native) clears the native token exactly once", async () => {
    const ClerkTokenBridge = await importBridge();
    useAuthMock.mockReturnValue(authState(true, true));
    const { rerender } = render(<ClerkTokenBridge />);

    useAuthMock.mockReturnValue(authState(true, false));
    await act(async () => {
      rerender(<ClerkTokenBridge />);
    });

    expect(clearNativeToken).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("cold start (never signed in) never clears — restore is not clobbered", async () => {
    const ClerkTokenBridge = await importBridge();
    useAuthMock.mockReturnValue(authState(false, false));
    const { rerender } = render(<ClerkTokenBridge />);

    useAuthMock.mockReturnValue(authState(true, false));
    await act(async () => {
      rerender(<ClerkTokenBridge />);
    });

    expect(clearNativeToken).not.toHaveBeenCalled();
    cleanup();
  });

  it("the same signed-in -> signed-out transition on a NON-native platform never clears", async () => {
    isNativePlatform.mockReturnValue(false);
    const ClerkTokenBridge = await importBridge();
    useAuthMock.mockReturnValue(authState(true, true));
    const { rerender } = render(<ClerkTokenBridge />);

    useAuthMock.mockReturnValue(authState(true, false));
    await act(async () => {
      rerender(<ClerkTokenBridge />);
    });

    expect(clearNativeToken).not.toHaveBeenCalled();
    cleanup();
  });

  it("does not clear while still loading, even after a prior signed-in state", async () => {
    const ClerkTokenBridge = await importBridge();
    useAuthMock.mockReturnValue(authState(true, true));
    const { rerender } = render(<ClerkTokenBridge />);

    // isLoaded flips false transiently — the guard (`if (!isLoaded) return;`)
    // must skip this render entirely, not treat it as a sign-out.
    useAuthMock.mockReturnValue(authState(false, false));
    await act(async () => {
      rerender(<ClerkTokenBridge />);
    });

    expect(clearNativeToken).not.toHaveBeenCalled();
    cleanup();
  });
});
