// @vitest-environment jsdom
// The omnipresent CaddieOrb (specs/omnipresent-caddie-orb-plan.md, slice S1):
// tap summons, long-press summons already-listening, drift cancels. Pointer
// semantics migrated verbatim from the old center-nav LooperOrb — same bus,
// same payloads, same haptics; this file replaces that coverage.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/tee-time" }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));

import CaddieOrb from "./CaddieOrb";
import { onLooperOpen, type LooperOpenDetail } from "@/lib/looper-bus";

// jsdom in this repo doesn't ship window.localStorage — stub a minimal
// in-memory implementation so the one-time-intro guard in CaddieOrb (which
// touches localStorage in a useEffect) has something to read/write.
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

describe("CaddieOrb", () => {
  let received: LooperOpenDetail[];
  let off: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    received = [];
    off = onLooperOpen((d) => received.push(d));
    vi.stubGlobal("localStorage", makeLocalStorage());
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders on a SHOW route with the caddie aria-label", () => {
    render(<CaddieOrb />);
    expect(screen.getByLabelText("Talk to your caddie")).toBeTruthy();
  });

  it("tap summons the caddie for the current page's context, not listening", () => {
    render(<CaddieOrb />);
    const orb = screen.getByLabelText("Talk to your caddie");
    fireEvent.pointerDown(orb, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(orb);
    expect(received).toEqual([{ context: "tee-time", listening: false }]);
  });

  it("long-press summons already listening (and pointer-up after doesn't double-fire)", () => {
    render(<CaddieOrb />);
    const orb = screen.getByLabelText("Talk to your caddie");
    fireEvent.pointerDown(orb, { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(400);
    fireEvent.pointerUp(orb);
    expect(received).toEqual([{ context: "tee-time", listening: true }]);
  });

  it("finger drift cancels the press entirely", () => {
    render(<CaddieOrb />);
    const orb = screen.getByLabelText("Talk to your caddie");
    // jsdom's synthetic pointer events drop clientX/Y — construct MouseEvents
    // (which carry coordinates) with pointer event types instead.
    fireEvent(orb, new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    fireEvent(orb, new MouseEvent("pointermove", { clientX: 10, clientY: 40, bubbles: true })); // scrolling
    vi.advanceTimersByTime(400);
    fireEvent(orb, new MouseEvent("pointerup", { bubbles: true }));
    expect(received).toEqual([]);
  });
});
