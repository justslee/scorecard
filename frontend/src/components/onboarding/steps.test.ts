import { describe, it, expect, vi } from "vitest";
import { initialSubStep, SUB_STEP_ORDER, withStallTimeout } from "./steps";

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

describe("withStallTimeout (F2, login-onboarding-epic-polish-review §4)", () => {
  it("resolves with the original value when the promise settles before the timeout", async () => {
    vi.useFakeTimers();
    try {
      const result = await withStallTimeout(Promise.resolve("ok"), 15_000);
      expect(result).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects if the promise never settles within the timeout", async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<never>(() => {});
      const raced = withStallTimeout(hung, 15_000);
      let rejected = false;
      raced.catch(() => {
        rejected = true;
      });

      await vi.advanceTimersByTimeAsync(15_001);

      expect(rejected).toBe(true);
      await expect(raced).rejects.toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates the original rejection reason when the promise rejects before the timeout", async () => {
    vi.useFakeTimers();
    try {
      const boom = new Error("write failed");
      await expect(withStallTimeout(Promise.reject(boom), 15_000)).rejects.toBe(boom);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the default 15s timeout when none is passed", async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<never>(() => {});
      const raced = withStallTimeout(hung);
      let rejected = false;
      raced.catch(() => {
        rejected = true;
      });

      await vi.advanceTimersByTimeAsync(14_000);
      expect(rejected).toBe(false);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(rejected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
