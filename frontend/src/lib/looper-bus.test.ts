// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { looperContextForPath, openLooper, onLooperOpen } from "./looper-bus";

describe("looperContextForPath", () => {
  it("maps routes to contexts", () => {
    expect(looperContextForPath("/tee-time")).toBe("tee-time");
    expect(looperContextForPath("/courses")).toBe("courses");
    expect(looperContextForPath("/courses/view")).toBe("courses");
    expect(looperContextForPath("/")).toBe("general");
    expect(looperContextForPath("/players")).toBe("general");
    expect(looperContextForPath("/profile")).toBe("general");
  });
});

describe("openLooper / onLooperOpen", () => {
  it("delivers the detail to subscribers", () => {
    const cb = vi.fn();
    const off = onLooperOpen(cb);
    openLooper({ context: "tee-time", listening: true });
    expect(cb).toHaveBeenCalledWith({ context: "tee-time", listening: true });
    off();
  });

  it("unsubscribe stops delivery", () => {
    const cb = vi.fn();
    const off = onLooperOpen(cb);
    off();
    openLooper({ context: "general", listening: false });
    expect(cb).not.toHaveBeenCalled();
  });
});
