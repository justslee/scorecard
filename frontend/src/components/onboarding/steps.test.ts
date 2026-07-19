import { describe, it, expect } from "vitest";
import { initialSubStep, SUB_STEP_ORDER } from "./steps";

describe("initialSubStep", () => {
  it.each([
    [null, "name"],
    ["name", "handicap"],
    ["handicap", "bag"],
    ["bag", "intro"],
    ["done", null],
  ] as const)("server step %s -> sub-step %s", (step, expected) => {
    expect(initialSubStep(step)).toBe(expected);
  });

  it("treats 'unknown' the same as a brand-new user (should never actually reach here)", () => {
    expect(initialSubStep("unknown")).toBe("name");
  });
});

describe("SUB_STEP_ORDER", () => {
  it("is the fixed 4-step order", () => {
    expect(SUB_STEP_ORDER).toEqual(["name", "handicap", "bag", "intro"]);
  });
});
