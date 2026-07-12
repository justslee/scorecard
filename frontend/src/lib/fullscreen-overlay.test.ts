// Full-screen overlay registry tests (specs/caddie-orb-map-mode-ghost-plan.md §4.1).
// Pure module — no DOM needed. Mirrors caddie-context.test.ts.

import { describe, it, expect } from "vitest";
import {
  registerFullscreenOverlay,
  isFullscreenOverlayActive,
  onFullscreenOverlayChange,
} from "./fullscreen-overlay";

describe("fullscreen-overlay registry", () => {
  it("fresh module state → isFullscreenOverlayActive() is false", () => {
    expect(isFullscreenOverlayActive()).toBe(false);
  });

  it("register → true; unregister → false", () => {
    const unregister = registerFullscreenOverlay();
    expect(isFullscreenOverlayActive()).toBe(true);
    unregister();
    expect(isFullscreenOverlayActive()).toBe(false);
  });

  it("two registrations (A, B): unregister A → still true; unregister B → false", () => {
    const unregA = registerFullscreenOverlay();
    const unregB = registerFullscreenOverlay();
    expect(isFullscreenOverlayActive()).toBe(true);
    unregA(); // superseded/stale — must not clobber the still-live overlay
    expect(isFullscreenOverlayActive()).toBe(true);
    unregB();
    expect(isFullscreenOverlayActive()).toBe(false);
  });

  it("double-unregister robustness: A-reg, A-unreg, B-reg, A-unreg-again → still true", () => {
    const unregA = registerFullscreenOverlay();
    unregA();
    expect(isFullscreenOverlayActive()).toBe(false);
    const unregB = registerFullscreenOverlay();
    unregA(); // stale double-unregister — no-op
    expect(isFullscreenOverlayActive()).toBe(true);
    unregB(); // clean up
    expect(isFullscreenOverlayActive()).toBe(false);
  });

  it("subscription fires only on flips with the boolean; unsubscribe stops delivery", () => {
    const seen: boolean[] = [];
    const off = onFullscreenOverlayChange((active) => seen.push(active));

    const unregA = registerFullscreenOverlay(); // 0 -> 1: flips true
    expect(seen).toEqual([true]);

    const unregB = registerFullscreenOverlay(); // 1 -> 2: no flip
    expect(seen).toEqual([true]);

    unregA(); // 2 -> 1: no flip
    expect(seen).toEqual([true]);

    unregB(); // 1 -> 0: flips false
    expect(seen).toEqual([true, false]);

    off();
    const unregC = registerFullscreenOverlay();
    expect(seen).toEqual([true, false]); // no further delivery after unsubscribe
    unregC(); // clean up
  });
});
