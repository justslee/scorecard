import { describe, expect, it } from "vitest";
import {
  expectingFromMissing,
  MAX_FOLLOWUP_TURNS,
  nextConvoStep,
} from "./round-setup-convo";

describe("expectingFromMissing", () => {
  it("prioritizes course over players", () => {
    expect(expectingFromMissing(["course", "players"])).toBe("course");
  });
  it("returns players when only players missing", () => {
    expect(expectingFromMissing(["players"])).toBe("players");
  });
  it("returns undefined when nothing missing", () => {
    expect(expectingFromMissing([])).toBeUndefined();
    expect(expectingFromMissing(undefined)).toBeUndefined();
  });
});

describe("nextConvoStep", () => {
  it("asks the follow-up when the parse is incomplete", () => {
    const step = nextConvoStep(
      {
        courseName: "",
        playerNames: ["Dan"],
        missing: ["course"],
        followUpQuestion: "Which course are you playing?",
        complete: false,
      },
      0,
    );
    expect(step.kind).toBe("ask");
    if (step.kind === "ask") {
      expect(step.question).toBe("Which course are you playing?");
      expect(step.expecting).toBe("course");
      expect(step.config.playerNames).toEqual(["Dan"]);
    }
  });

  it("completes when the backend says complete", () => {
    const step = nextConvoStep(
      { courseName: "Pebble", playerNames: ["Dan"], complete: true, missing: [] },
      1,
    );
    expect(step.kind).toBe("complete");
    if (step.kind === "complete") {
      expect(step.config).toEqual({
        courseName: "Pebble",
        playerNames: ["Dan"],
        teeName: undefined,
      });
    }
  });

  it("completes (no infinite loop) once the follow-up cap is reached, even if incomplete", () => {
    const step = nextConvoStep(
      {
        courseName: "",
        playerNames: [],
        missing: ["course", "players"],
        followUpQuestion: "Which course are you playing?",
        complete: false,
      },
      MAX_FOLLOWUP_TURNS,
    );
    expect(step.kind).toBe("complete");
  });

  it("completes when there's no question even if not flagged complete", () => {
    const step = nextConvoStep(
      { courseName: "Pebble", playerNames: ["Dan"], followUpQuestion: null },
      0,
    );
    expect(step.kind).toBe("complete");
  });

  it("carries the tee through and defaults missing fields", () => {
    const step = nextConvoStep(
      { courseName: "Pebble", playerNames: ["Dan"], teeName: "Blue", complete: true },
      0,
    );
    if (step.kind === "complete") {
      expect(step.config.teeName).toBe("Blue");
    }
  });
});
