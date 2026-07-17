// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  looperContextForPath,
  openLooper,
  onLooperOpen,
  sendLooperDockedGesture,
  onLooperDockedGesture,
} from "./looper-bus";

describe("looperContextForPath", () => {
  it("maps routes to contexts", () => {
    expect(looperContextForPath("/tee-time")).toBe("tee-time");
    expect(looperContextForPath("/courses")).toBe("courses");
    expect(looperContextForPath("/courses/")).toBe("courses");
    expect(looperContextForPath("/courses/view")).toBe("general");
    expect(looperContextForPath("/courses/pebble-beach")).toBe("general");
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

  it("presentation is optional — a summon that omits it delivers no field (back-compat: undefined, not a forced default)", () => {
    const cb = vi.fn();
    const off = onLooperOpen(cb);
    openLooper({ context: "tee-time", listening: true });
    expect(cb).toHaveBeenCalledWith({ context: "tee-time", listening: true });
    const [detail] = cb.mock.calls[0] as [{ presentation?: "docked" | "full" }];
    expect(detail.presentation).toBeUndefined();
    off();
  });

  it("presentation round-trips through the bus untouched", () => {
    const cb = vi.fn();
    const off = onLooperOpen(cb);
    openLooper({ context: "general", listening: true, presentation: "docked" });
    expect(cb).toHaveBeenCalledWith({ context: "general", listening: true, presentation: "docked" });
    openLooper({ context: "general", listening: false, presentation: "full" });
    expect(cb).toHaveBeenLastCalledWith({ context: "general", listening: false, presentation: "full" });
    off();
  });
});

describe("sendLooperDockedGesture / onLooperDockedGesture", () => {
  it("delivers the gesture to subscribers", () => {
    const cb = vi.fn();
    const off = onLooperDockedGesture(cb);
    sendLooperDockedGesture("send");
    expect(cb).toHaveBeenCalledWith("send");
    sendLooperDockedGesture("cancel");
    expect(cb).toHaveBeenCalledWith("cancel");
    off();
  });

  it("unsubscribe stops delivery", () => {
    const cb = vi.fn();
    const off = onLooperDockedGesture(cb);
    off();
    sendLooperDockedGesture("send");
    expect(cb).not.toHaveBeenCalled();
  });
});
