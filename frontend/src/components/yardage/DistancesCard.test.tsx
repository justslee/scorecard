// @vitest-environment jsdom
/**
 * Render tests for DistancesCard (specs/fcb-caption-proximity-plan.md §3).
 *
 * RoundPageClient can't render in jsdom (mapbox-gl / Capacitor / Clerk /
 * framer-motion, plus a documented map-view crash history), so the F/C/B
 * source-caption re-anchor is proven here on the extracted, pure
 * presentational component instead.
 */

import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import DistancesCard from "./DistancesCard";
import { T, DEFAULT_ACCENT } from "@/components/yardage/tokens";

afterEach(() => {
  cleanup();
});

// jsdom's CSSStyleDeclaration normalizes hex colors to rgb(...) on read, so
// compare against the same normalized form rather than the raw hex token.
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

const baseProps = {
  fcbTiles: [
    { k: "Front", v: 138, color: "#a8553f" },
    { k: "Center", v: 150, color: T.ink },
    { k: "Back", v: 164, color: "#5d7285" },
  ],
  windTile: { v: "8mph", sub: "into" },
  elevTile: { v: "+2ft", sub: "uphill" },
  playsTile: { v: "152Y", sub: "wind-adj" },
};

describe("DistancesCard", () => {
  it("adjacency: the caption is the immediately-preceding sibling of the F/C/B tile row", () => {
    render(
      <DistancesCard {...baseProps} fcbCaption={{ text: "from the tee", isLive: false }} />,
    );
    const captionEl = screen.getByTestId("fcb-caption");
    const tileRowEl = screen.getByTestId("fcb-tile-row");
    // The caption span sits inside its own flex-align wrapper div; that
    // wrapper div is what must be the tile row's immediately-preceding
    // sibling — i.e. no stat-grid or other node sits between them.
    expect(captionEl.parentElement?.nextElementSibling).toBe(tileRowEl);
  });

  it("the Wind/Elev/Plays stat grid precedes the caption in document order (not the old top placement)", () => {
    render(
      <DistancesCard {...baseProps} fcbCaption={{ text: "from the tee", isLive: false }} />,
    );
    const captionEl = screen.getByTestId("fcb-caption");
    const windLabel = screen.getByText("Wind");
    // DOCUMENT_POSITION_PRECEDING (2) set on captionEl relative to windLabel
    // means windLabel comes BEFORE captionEl in the document.
    const position = captionEl.compareDocumentPosition(windLabel);
    expect(Boolean(position & Node.DOCUMENT_POSITION_PRECEDING)).toBe(true);
  });

  it("wrapper padding carries the safe-area clearance token (root pill-bar clearance)", () => {
    const { container } = render(
      <DistancesCard {...baseProps} fcbCaption={{ text: "from the tee", isLive: false }} />,
    );
    const wrapper = container.querySelector("[data-overlay]") as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.style.padding).toContain("env(safe-area-inset-bottom)");
    expect(wrapper.style.padding).toContain("max(");
  });

  it("data-overlay is preserved on the root (map tap/zoom relies on closest('[data-overlay]'))", () => {
    const { container } = render(
      <DistancesCard {...baseProps} fcbCaption={{ text: "from the tee", isLive: false }} />,
    );
    expect(container.querySelector("[data-overlay]")).toBeTruthy();
  });

  it("live: shows the accent-dot text in DEFAULT_ACCENT", () => {
    render(
      <DistancesCard {...baseProps} fcbCaption={{ text: "● from where you stand", isLive: true }} />,
    );
    const captionEl = screen.getByTestId("fcb-caption");
    expect(captionEl.textContent).toBe("● from where you stand");
    expect(captionEl.style.color).toBe(hexToRgb(DEFAULT_ACCENT));
  });

  it("from-tee: shows the tee text in pencilSoft", () => {
    render(
      <DistancesCard {...baseProps} fcbCaption={{ text: "from the tee", isLive: false }} />,
    );
    const captionEl = screen.getByTestId("fcb-caption");
    expect(captionEl.textContent).toBe("from the tee");
    expect(captionEl.style.color).toBe(hexToRgb(T.pencilSoft));
  });
});
