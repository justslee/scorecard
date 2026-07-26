// @vitest-environment jsdom
//
// P0 login-blocked fix (specs/p0-login-blocked-plan.md §1/§2). NativeAuthDiag
// used to render on every native build ("native OR opt-in") and, when it did
// render, was a fixed full-width slab that occluded the sign-in controls —
// the release blocker. It is now:
//   - flag-only at runtime (no more "native" arm) — renders null when
//     NEXT_PUBLIC_AUTH_DIAG is unset, belt-and-suspenders behind the build-
//     time exclusion in SignInClient.tsx (proven separately by
//     scripts/assert-no-auth-diag.mjs).
//   - non-occluding by default when the flag IS set — a small collapsed
//     chip, never a slab, so even a flagged dev/sim build can't cover the
//     sign-in form.

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const useAuthMock = vi.fn(() => ({ isLoaded: true, isSignedIn: false }));
vi.mock("@clerk/react", () => ({
  useAuth: () => useAuthMock(),
}));

async function importNativeAuthDiag() {
  return (await import("./NativeAuthDiag")).default;
}

describe("NativeAuthDiag — flag-only gate, non-occluding default", () => {
  beforeEach(() => {
    vi.resetModules();
    useAuthMock.mockClear();
    delete process.env.NEXT_PUBLIC_AUTH_DIAG;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_AUTH_DIAG;
    cleanup();
  });

  it("renders nothing when NEXT_PUBLIC_AUTH_DIAG is unset (the real-build case)", async () => {
    const NativeAuthDiag = await importNativeAuthDiag();
    const { container } = render(<NativeAuthDiag />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("diag")).toBeNull();
    expect(screen.queryByText(/Auth diag/)).toBeNull();
  });

  it("renders the collapsed chip (not the full slab) when the flag is set", async () => {
    process.env.NEXT_PUBLIC_AUTH_DIAG = "1";
    const NativeAuthDiag = await importNativeAuthDiag();
    render(<NativeAuthDiag />);

    // The collapsed default is a small "diag" chip...
    expect(screen.getByText("diag")).toBeTruthy();
    // ...never the full readout (rows like "loaded"/"signed") up front.
    expect(screen.queryByText("loaded")).toBeNull();
    expect(screen.queryByText(/Auth diag/)).toBeNull();
  });

  it("expands to the full readout on tap, and collapses again on a second tap", async () => {
    process.env.NEXT_PUBLIC_AUTH_DIAG = "1";
    const NativeAuthDiag = await importNativeAuthDiag();
    render(<NativeAuthDiag />);

    fireEvent.click(screen.getByText("diag"));
    expect(screen.getByText(/Auth diag/)).toBeTruthy();
    expect(screen.getByText("loaded")).toBeTruthy();

    fireEvent.click(screen.getByText(/Auth diag/));
    expect(screen.queryByText("loaded")).toBeNull();
    expect(screen.getByText("diag")).toBeTruthy();
  });
});
