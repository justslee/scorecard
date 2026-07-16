// @vitest-environment jsdom
//
// Transcript / ConversationTurn — the ONE shared caddie/user turn primitive
// (specs/caddie-transcript-render-unify-plan.md §5.1). Pins the hard
// invariant: renders EXACTLY the given array, in the given order, keyed by
// the caller's `turn.key` — visuals only, never sort/dedup/filter/re-key.

import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { Transcript, ConversationTurn, type TranscriptTurn } from "./Transcript";

afterEach(() => {
  cleanup();
});

describe("ConversationTurn", () => {
  it("user turn shows the 'You' caption", () => {
    const turn: TranscriptTurn = { key: "0", speaker: "user", text: "What club from 150?" };
    render(<ConversationTurn turn={turn} />);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("What club from 150?")).toBeTruthy();
  });

  it("caddie turn shows the given speakerLabel caption", () => {
    const turn: TranscriptTurn = { key: "0", speaker: "caddie", text: "Smooth 7-iron." };
    render(<ConversationTurn turn={turn} speakerLabel="Strategist" />);
    expect(screen.getByText("Strategist")).toBeTruthy();
    expect(screen.getByText("Smooth 7-iron.")).toBeTruthy();
  });

  it("caddie turn defaults speakerLabel to 'Caddy' when omitted", () => {
    const turn: TranscriptTurn = { key: "0", speaker: "caddie", text: "Take one more club." };
    render(<ConversationTurn turn={turn} />);
    expect(screen.getByText("Caddy")).toBeTruthy();
  });

  it("streaming caddie turn renders at full opacity with a live pulse, no dimming", () => {
    const turn: TranscriptTurn = { key: "0", speaker: "caddie", text: "Take one", streaming: true };
    const { container } = render(<ConversationTurn turn={turn} speakerLabel="Caddy" />);
    const body = screen.getByText("Take one");
    expect(body.style.opacity === "" || body.style.opacity === "1").toBe(true);
    // PulseDot renders two nested <span> elements (halo + dot) — assert at
    // least one extra span shows up in the caption row beyond the label span.
    const spans = container.querySelectorAll("span");
    expect(spans.length).toBeGreaterThan(1);
  });

  it("streaming user (display) turn renders a blinking caret", () => {
    const turn: TranscriptTurn = { key: "0", speaker: "user", text: "What about the wind", streaming: true };
    const { container } = render(<ConversationTurn turn={turn} size="display" accent="#3a4a8a" />);
    // The caret is a motion.span with an inline background matching accent.
    const caretCandidates = Array.from(container.querySelectorAll("span")).filter(
      (el) => (el as HTMLElement).style.background === "rgb(58, 74, 138)",
    );
    expect(caretCandidates.length).toBe(1);
  });

  it("non-streaming turn renders no caret and no pulse extras", () => {
    const turn: TranscriptTurn = { key: "0", speaker: "user", text: "Plain question" };
    const { container } = render(<ConversationTurn turn={turn} accent="#3a4a8a" />);
    const caretCandidates = Array.from(container.querySelectorAll("span")).filter(
      (el) => (el as HTMLElement).style.background === "rgb(58, 74, 138)",
    );
    expect(caretCandidates.length).toBe(0);
  });

  it("renders the leading slot (e.g. VoiceSheet medallion)", () => {
    const turn: TranscriptTurn = { key: "0", speaker: "caddie", text: "Hello" };
    render(<ConversationTurn turn={turn} leading={<div data-testid="medallion">M</div>} />);
    expect(screen.getByTestId("medallion")).toBeTruthy();
  });

  it("renders the captionTrailing slot (e.g. VoiceSheet Waveform)", () => {
    const turn: TranscriptTurn = { key: "0", speaker: "caddie", text: "Hello" };
    render(<ConversationTurn turn={turn} captionTrailing={<div data-testid="waveform">~</div>} />);
    expect(screen.getByTestId("waveform")).toBeTruthy();
  });
});

describe("Transcript — order/key invariants (plan §2.2 hard invariant)", () => {
  it("renders the array in the EXACT given order, even non-chronological", () => {
    // Both caddie turns (no user quote glyph) so the assertion below can
    // compare `.textContent` directly without the curly-quote artifact.
    const turns: TranscriptTurn[] = [
      { key: "b", speaker: "caddie", text: "Second logically, rendered first." },
      { key: "a", speaker: "caddie", text: "First logically, rendered second." },
    ];
    render(<Transcript turns={turns} speakerLabel="Caddy" />);
    const bodies = screen.getAllByText(/rendered (first|second)\./);
    expect(bodies.map((el) => el.textContent)).toEqual([
      "Second logically, rendered first.",
      "First logically, rendered second.",
    ]);
  });

  it("never dedups — two turns with identical text render as two distinct nodes", () => {
    const turns: TranscriptTurn[] = [
      { key: "0", speaker: "user", text: "Same thing twice" },
      { key: "1", speaker: "user", text: "Same thing twice" },
    ];
    render(<Transcript turns={turns} />);
    expect(screen.getAllByText("Same thing twice")).toHaveLength(2);
  });

  it("never filters — an empty-text streaming turn still renders (caption only)", () => {
    const turns: TranscriptTurn[] = [
      { key: "0", speaker: "caddie", text: "", streaming: true },
      { key: "1", speaker: "user", text: "Real question" },
    ];
    render(<Transcript turns={turns} speakerLabel="Caddy" />);
    expect(screen.getByText("Real question")).toBeTruthy();
    expect(screen.getAllByText("Caddy")).toHaveLength(1);
  });

  it("preserves caller key identity — reordering the same keys moves the same DOM nodes", () => {
    // Both caddie turns (no user quote glyph) so `.textContent` compares
    // cleanly without the curly-quote artifact.
    const first: TranscriptTurn[] = [
      { key: "x", speaker: "caddie", text: "Alpha" },
      { key: "y", speaker: "caddie", text: "Beta" },
    ];
    const { rerender } = render(<Transcript turns={first} speakerLabel="Caddy" />);
    const alphaNodeBefore = screen.getByText("Alpha");

    const reordered: TranscriptTurn[] = [
      { key: "y", speaker: "caddie", text: "Beta" },
      { key: "x", speaker: "caddie", text: "Alpha" },
    ];
    rerender(<Transcript turns={reordered} speakerLabel="Caddy" />);
    const alphaNodeAfter = screen.getByText("Alpha");

    // Same underlying DOM node instance survives the reorder (React reused
    // it because the key was preserved) — proves no internal re-keying.
    expect(alphaNodeAfter).toBe(alphaNodeBefore);
    // And it now renders SECOND in DOM order.
    const texts = screen.getAllByText(/^(Alpha|Beta)$/).map((el) => el.textContent);
    expect(texts).toEqual(["Beta", "Alpha"]);
  });
});
