// @vitest-environment jsdom
//
// GamePicker — money-honesty regression (tournament-settlement-honesty-
// plan.md §5, reviewer BLOCKING #2). Locks in:
//   - a non-stake-taking format (stableford) never renders a stake row, and
//     shows the honest, format-agnostic "no money" note once selected — the
//     old copy ("Points game — no money settlement") was factually wrong for
//     stroke/vegas/bb/scr, none of which are points games;
//   - the note is format-agnostic: it also renders for stroke (a non-points,
//     non-stake format, and the /round/new DEFAULT selection);
//   - a stake-taking format (skins) DOES render the stake row;
//   - an unmet-roster-requirement format (match play with rosterSize=3)
//     renders disabled with the honest sub-copy and never fires onToggle.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import GamePicker from "./GamePicker";
import { GAME_OPTIONS } from "@/lib/round-games";
import type { GameId } from "@/lib/round-games";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

function renderPicker(overrides: {
  selected?: { id: GameId; stake: string }[];
  rosterSize?: number;
  onToggle?: (id: GameId) => void;
} = {}) {
  const onToggle = overrides.onToggle ?? vi.fn();
  const onStakeFor = vi.fn();
  const onDone = vi.fn();
  render(
    <GamePicker
      accent="#3a5a3a"
      selected={overrides.selected ?? []}
      onToggle={onToggle}
      onStakeFor={onStakeFor}
      onDone={onDone}
      rosterSize={overrides.rosterSize}
    />
  );
  return { onToggle, onStakeFor, onDone };
}

describe("GamePicker — stake honesty (STAKE_GAME_IDS)", () => {
  it("stableford selected: renders no $ stake row, and shows the points-only note", () => {
    renderPicker({ selected: [{ id: "stable", stake: "" }] });

    // The four flat-rate stake buttons only ever appear inside a stake row.
    expect(screen.queryByText("$2")).toBeNull();
    expect(screen.queryByText("$10")).toBeNull();
    expect(screen.getByText("No money on this one — nothing to settle.")).toBeTruthy();
  });

  it("skins selected: renders the $ stake row", () => {
    renderPicker({ selected: [{ id: "skins", stake: "$5" }] });

    expect(screen.getByText("$2")).toBeTruthy();
    expect(screen.getByText("$5")).toBeTruthy();
    expect(screen.getByText("$10")).toBeTruthy();
    expect(screen.getByText("$20")).toBeTruthy();
    expect(screen.queryByText("No money on this one — nothing to settle.")).toBeNull();
  });

  it('"No stakes" selected shows neither a stake row nor the no-money note', () => {
    renderPicker({ selected: [{ id: "none", stake: "" }] });

    expect(screen.queryByText("$2")).toBeNull();
    expect(screen.queryByText("No money on this one — nothing to settle.")).toBeNull();
  });

  it("stroke selected: renders no $ stake row and shows the honest no-money note — stroke is the /round/new default and isn't a points game, so the copy must be format-agnostic", () => {
    renderPicker({ selected: [{ id: "stroke", stake: "" }] });

    expect(screen.queryByText("$2")).toBeNull();
    expect(screen.getByText("No money on this one — nothing to settle.")).toBeTruthy();
  });
});

describe("GamePicker — roster requirement (ROSTER_REQUIREMENT)", () => {
  it("rosterSize=3: match play row is disabled with the 1v1 sub-copy, and onToggle never fires on click", () => {
    const { onToggle } = renderPicker({ rosterSize: 3 });

    const matchLabel = GAME_OPTIONS.find((g) => g.id === "match")!.l;
    expect(screen.getByText("Match play is 1v1 — opponent picker coming.")).toBeTruthy();

    fireEvent.click(screen.getByText(matchLabel));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("rosterSize=3: wolf row is disabled with the foursome sub-copy, and onToggle never fires on click", () => {
    const { onToggle } = renderPicker({ rosterSize: 3 });

    const wolfLabel = GAME_OPTIONS.find((g) => g.id === "wolf")!.l;
    expect(screen.getByText("Wolf needs a foursome.")).toBeTruthy();

    fireEvent.click(screen.getByText(wolfLabel));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("rosterSize=2: match play is selectable — onToggle fires on click, normal sub-copy shown", () => {
    const { onToggle } = renderPicker({ rosterSize: 2 });

    const matchOption = GAME_OPTIONS.find((g) => g.id === "match")!;
    expect(screen.queryByText("Match play is 1v1 — opponent picker coming.")).toBeNull();
    expect(screen.getByText(matchOption.sub)).toBeTruthy();

    fireEvent.click(screen.getByText(matchOption.l));
    expect(onToggle).toHaveBeenCalledWith("match");
  });

  it("no rosterSize prop: no row is disabled (undefined treated as no requirement check)", () => {
    const { onToggle } = renderPicker({});

    expect(screen.queryByText("Match play is 1v1 — opponent picker coming.")).toBeNull();
    expect(screen.queryByText("Wolf needs a foursome.")).toBeNull();

    const matchOption = GAME_OPTIONS.find((g) => g.id === "match")!;
    fireEvent.click(screen.getByText(matchOption.l));
    expect(onToggle).toHaveBeenCalledWith("match");
  });
});
