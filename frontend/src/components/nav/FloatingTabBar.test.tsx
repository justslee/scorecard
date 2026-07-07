// @vitest-environment jsdom
// The Looper orb in the tab island (specs/looper-orb-plan.md): tap summons,
// long-press summons already-listening, drift cancels.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/tee-time" }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));

import FloatingTabBar from "./FloatingTabBar";
import { onLooperOpen, type LooperOpenDetail } from "@/lib/looper-bus";

describe("FloatingTabBar — the Looper orb", () => {
  let received: LooperOpenDetail[];
  let off: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    received = [];
    off = onLooperOpen((d) => received.push(d));
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
    cleanup();
  });

  it("renders the orb and no Partners tab", () => {
    render(<FloatingTabBar />);
    expect(screen.getByLabelText("Talk to Looper")).toBeTruthy();
    expect(screen.queryByLabelText("Partners")).toBeNull();
    expect(screen.getByLabelText("Home")).toBeTruthy();
    expect(screen.getByLabelText("Tee times")).toBeTruthy();
  });

  it("tap summons Looper for the current page's context, not listening", () => {
    render(<FloatingTabBar />);
    const orb = screen.getByLabelText("Talk to Looper");
    fireEvent.pointerDown(orb, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(orb);
    expect(received).toEqual([{ context: "tee-time", listening: false }]);
  });

  it("long-press summons already listening (and pointer-up after doesn't double-fire)", () => {
    render(<FloatingTabBar />);
    const orb = screen.getByLabelText("Talk to Looper");
    fireEvent.pointerDown(orb, { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(400);
    fireEvent.pointerUp(orb);
    expect(received).toEqual([{ context: "tee-time", listening: true }]);
  });

  it("finger drift cancels the press entirely", () => {
    render(<FloatingTabBar />);
    const orb = screen.getByLabelText("Talk to Looper");
    // jsdom's synthetic pointer events drop clientX/Y — construct MouseEvents
    // (which carry coordinates) with pointer event types instead.
    fireEvent(orb, new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    fireEvent(orb, new MouseEvent("pointermove", { clientX: 10, clientY: 40, bubbles: true })); // scrolling
    vi.advanceTimersByTime(400);
    fireEvent(orb, new MouseEvent("pointerup", { bubbles: true }));
    expect(received).toEqual([]);
  });
});
