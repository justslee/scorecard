// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  shouldDismissSheetDrag,
  useBodyScrollLock,
  SHEET_DISMISS_DISTANCE,
  SHEET_DISMISS_VELOCITY,
} from "./sheet";

describe("shouldDismissSheetDrag", () => {
  it("dismisses on a long enough downward drag", () => {
    expect(shouldDismissSheetDrag(SHEET_DISMISS_DISTANCE + 1, 0)).toBe(true);
  });

  it("dismisses on a fast enough downward flick even if short", () => {
    expect(shouldDismissSheetDrag(10, SHEET_DISMISS_VELOCITY + 1)).toBe(true);
  });

  it("does NOT dismiss a small, slow drag (springs back)", () => {
    expect(shouldDismissSheetDrag(SHEET_DISMISS_DISTANCE - 1, SHEET_DISMISS_VELOCITY - 1)).toBe(false);
  });

  it("does NOT dismiss exactly at the thresholds (strictly greater)", () => {
    expect(shouldDismissSheetDrag(SHEET_DISMISS_DISTANCE, SHEET_DISMISS_VELOCITY)).toBe(false);
  });

  it("never dismisses on an upward drag/flick", () => {
    expect(shouldDismissSheetDrag(-300, -2000)).toBe(false);
  });

  it("honours custom thresholds", () => {
    expect(shouldDismissSheetDrag(60, 0, { distance: 50 })).toBe(true);
    expect(shouldDismissSheetDrag(60, 0, { distance: 100 })).toBe(false);
  });
});

describe("useBodyScrollLock", () => {
  // jsdom doesn't implement window.scrollTo (it logs a noisy "Not implemented").
  // The hook only calls it to restore position, so stub it to a no-op.
  beforeAll(() => {
    vi.stubGlobal("scrollTo", () => {});
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    // Reset any inline styles left on body between tests.
    document.body.removeAttribute("style");
  });

  it("pins the body fixed while locked and restores on unlock", () => {
    const { rerender, unmount } = renderHook(({ locked }) => useBodyScrollLock(locked), {
      initialProps: { locked: false },
    });

    // Not locked yet — body untouched.
    expect(document.body.style.position).toBe("");

    rerender({ locked: true });
    expect(document.body.style.position).toBe("fixed");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("none");

    rerender({ locked: false });
    expect(document.body.style.position).toBe("");
    expect(document.body.style.overflow).toBe("");

    unmount();
  });

  it("captures the scroll offset into body.top while locked, then clears it", () => {
    // jsdom doesn't implement layout scrolling, so stub scrollY to a real offset.
    const spy = vi.spyOn(window, "scrollY", "get").mockReturnValue(250);
    try {
      const { rerender } = renderHook(({ locked }) => useBodyScrollLock(locked), {
        initialProps: { locked: true },
      });
      expect(document.body.style.top).toBe("-250px");
      rerender({ locked: false });
      expect(document.body.style.top).toBe("");
    } finally {
      spy.mockRestore();
    }
  });
});
