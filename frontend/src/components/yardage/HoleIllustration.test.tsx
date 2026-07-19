// @vitest-environment jsdom
//
// HoleIllustration — pins the `login-animation-moment` contract
// (specs/login-animation-moment-plan.md §5): the interactive variant's DOM
// stays byte-identical to pre-Slice-3 (no added wrapper `<g>`s, the dashed
// centerline keeps its exact dash pattern), the hero variant renders its
// full final element set with or without `playIntro`, and the NEW pen-stroke
// path only mounts when `playIntro` is actually driving the draw.
//
// framer-motion is mocked to a plain-DOM passthrough (same pattern as
// CaddieOrb.test.tsx / SignInScreen.test.tsx) — jsdom has no rAF, so the real
// animation runtime can't run; this only needs to prove which SVG tags/attrs
// render, not that the animation timing is correct.

import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("framer-motion", () => {
  const passthroughTags = new Set(["g", "path", "rect", "circle", "text"]);
  const cache = new Map<string, React.ForwardRefExoticComponent<Record<string, unknown>>>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!passthroughTags.has(tag)) return undefined;
        const cached = cache.get(tag);
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
          return React.createElement(tag, { ...rest, ref });
        });
        Passthrough.displayName = `motion.${tag}`;
        cache.set(tag, Passthrough);
        return Passthrough;
      },
    },
  );
  return {
    motion,
    useReducedMotion: () => false,
  };
});

import HoleIllustration from "./HoleIllustration";

afterEach(() => {
  cleanup();
});

// HOLES[3] (holeNumber=4) — the sign-in hero's signature hole, 1 hazard.
const HERO_HOLE_NUMBER = 4;

describe("HoleIllustration — interactive variant (default)", () => {
  it("renders the draggable aim reticle set", () => {
    const { container } = render(<HoleIllustration holeNumber={HERO_HOLE_NUMBER} />);
    expect(screen.getByLabelText("Drag aim target")).toBeTruthy();
    // The reticle's crosshair lives on a nested <g> (position translate +
    // scale-on-grab split) — present alongside the hit circle.
    expect(container.querySelectorAll("circle[fill='none']").length).toBeGreaterThan(0);
  });

  it("keeps the dashed centerline's exact dash pattern", () => {
    const { container } = render(<HoleIllustration holeNumber={HERO_HOLE_NUMBER} />);
    const dashed = container.querySelectorAll('path[stroke-dasharray="1.5 1.8"]');
    expect(dashed.length).toBe(1);
  });

  it("adds NO wrapper <g>s — pinned element-count snapshot", () => {
    const { container } = render(<HoleIllustration holeNumber={HERO_HOLE_NUMBER} />);
    // Unchanged from pre-Slice-3: flag's outer translate <g>, tee's outer
    // translate <g>, the aim-reticle's outer translate <g>, and its nested
    // scale <g>. No hero orchestrator, no hero-only inner wrappers, no
    // hazard wrapper — hazards render as bare <circle>/<rect>.
    expect(container.querySelectorAll("g").length).toBe(4);
    // No pen stroke, no motion orchestrator artifacts — total <path> count
    // is exactly ribbon + centerline + flag triangle.
    expect(container.querySelectorAll("path").length).toBe(3);
  });
});

describe("HoleIllustration — hero variant, playIntro off (default/replay-guard/reduced-motion)", () => {
  it("renders the full final element set", () => {
    const { container } = render(<HoleIllustration holeNumber={HERO_HOLE_NUMBER} variant="hero" showDetail />);
    expect(container.querySelector('circle[fill^="url(#green-grad"]')).toBeTruthy(); // green disc
    expect(container.querySelectorAll("path").length).toBe(3); // ribbon + centerline + flag triangle, no pen stroke
    expect(screen.getByText("TEE")).toBeTruthy();
    expect(screen.getByText("GRN")).toBeTruthy();
  });

  it("renders NO pen stroke", () => {
    const { container } = render(<HoleIllustration holeNumber={HERO_HOLE_NUMBER} variant="hero" showDetail />);
    // Only the dashed centerline matches stroke="#1a2a1a" — the pen stroke
    // (also #1a2a1a, no dasharray) is absent.
    const inkPaths = container.querySelectorAll('path[stroke="#1a2a1a"]');
    expect(inkPaths.length).toBe(1);
    expect(inkPaths[0].getAttribute("stroke-dasharray")).toBe("1.5 1.8");
  });

  it("renders zero reticle/drag DOM (hero has no aim UI)", () => {
    render(<HoleIllustration holeNumber={HERO_HOLE_NUMBER} variant="hero" showDetail />);
    expect(screen.queryByLabelText("Drag aim target")).toBeNull();
  });
});

describe("HoleIllustration — hero variant, playIntro true", () => {
  it("includes the pen stroke", () => {
    const { container } = render(
      <HoleIllustration holeNumber={HERO_HOLE_NUMBER} variant="hero" showDetail playIntro />,
    );
    const inkPaths = container.querySelectorAll('path[stroke="#1a2a1a"]');
    // Centerline (dashed) + the new solid pen-stroke overlay.
    expect(inkPaths.length).toBe(2);
    const penStroke = Array.from(inkPaths).find((p) => !p.getAttribute("stroke-dasharray"));
    expect(penStroke).toBeTruthy();
    expect(penStroke?.getAttribute("stroke-linecap")).toBe("round");
    expect(penStroke?.getAttribute("stroke-width")).toBe("0.35");
    expect(container.querySelectorAll("path").length).toBe(4); // ribbon + centerline + flag triangle + pen stroke
  });

  it("still renders the full final element set (settles identical to playIntro off)", () => {
    const { container } = render(
      <HoleIllustration holeNumber={HERO_HOLE_NUMBER} variant="hero" showDetail playIntro />,
    );
    expect(container.querySelector('circle[fill^="url(#green-grad"]')).toBeTruthy();
    expect(screen.getByText("TEE")).toBeTruthy();
    expect(screen.getByText("GRN")).toBeTruthy();
  });
});
