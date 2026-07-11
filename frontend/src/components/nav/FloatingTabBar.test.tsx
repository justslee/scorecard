// @vitest-environment jsdom
// The floating tab island (specs/omnipresent-caddie-orb-plan.md, slice S1):
// plain 4-tab bar — Home, Courses, Tee times, Profile. The caddie voice
// invocation no longer lives here; it moved to the omnipresent CaddieOrb
// (see CaddieOrb.test.tsx for the tap/hold/drift pointer semantics, which
// migrated verbatim).

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/tee-time" }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));

import FloatingTabBar from "./FloatingTabBar";

describe("FloatingTabBar — 4-tab island", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders exactly the 4 tabs, no orb, no Partners tab", () => {
    render(<FloatingTabBar />);
    expect(screen.getByLabelText("Home")).toBeTruthy();
    expect(screen.getByLabelText("Courses")).toBeTruthy();
    expect(screen.getByLabelText("Tee times")).toBeTruthy();
    expect(screen.getByLabelText("Profile")).toBeTruthy();
    expect(screen.queryByLabelText("Partners")).toBeNull();
    expect(screen.queryByLabelText("Talk to Looper")).toBeNull();
    expect(screen.queryByLabelText("Talk to your caddie")).toBeNull();
  });
});
