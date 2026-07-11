// The caddie page-context registry (specs/orb-s2-context-contract-teetime-plan.md §9).
// Pure module — no DOM needed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerCaddieContext,
  getCaddieContext,
  onCaddieContextChange,
  setCaddieOrbState,
  getCaddieOrbState,
  onCaddieOrbState,
  type CaddieSurfaceContext,
  type CaddieOrbState,
} from "./caddie-context";

function surfaceCtx(id: CaddieSurfaceContext["id"] = "courses"): CaddieSurfaceContext {
  return { id, kind: "surface", summon: vi.fn() };
}

describe("caddie-context registry", () => {
  beforeEach(() => {
    // Reset module-level state between tests: unregister whatever is active.
    const ctx = getCaddieContext();
    if (ctx) registerCaddieContext(ctx)(); // register-then-immediately-unregister clears it
  });

  it("register → getCaddieContext returns it; unregister → null", () => {
    const ctx = surfaceCtx();
    const unregister = registerCaddieContext(ctx);
    expect(getCaddieContext()).toBe(ctx);
    unregister();
    expect(getCaddieContext()).toBeNull();
  });

  it("exclusivity / last-writer-wins: A then B → active is B", () => {
    const a = surfaceCtx("courses");
    const b = surfaceCtx("round-setup");
    registerCaddieContext(a);
    registerCaddieContext(b);
    expect(getCaddieContext()).toBe(b);
  });

  it("stale unregister is a no-op (StrictMode double-mount safety)", () => {
    const a = surfaceCtx("courses");
    const b = surfaceCtx("round-setup");
    const unregA = registerCaddieContext(a);
    const unregB = registerCaddieContext(b);
    unregA(); // stale — must not clobber B
    expect(getCaddieContext()).toBe(b);
    unregB();
    expect(getCaddieContext()).toBeNull();
  });

  it("same-shape double register (two objects, same id): second wins, first's cleanup no-op", () => {
    const a: CaddieSurfaceContext = { id: "courses", kind: "surface", summon: vi.fn() };
    const b: CaddieSurfaceContext = { id: "courses", kind: "surface", summon: vi.fn() };
    const unregA = registerCaddieContext(a);
    registerCaddieContext(b);
    unregA();
    expect(getCaddieContext()).toBe(b);
  });

  it("subscription fires on register/unregister with the new value; unsubscribe stops delivery", () => {
    const seen: Array<ReturnType<typeof getCaddieContext>> = [];
    const off = onCaddieContextChange((ctx) => seen.push(ctx));
    const a = surfaceCtx();
    const unreg = registerCaddieContext(a);
    expect(seen).toEqual([a]);
    unreg();
    expect(seen).toEqual([a, null]);
    off();
    registerCaddieContext(surfaceCtx());
    expect(seen).toEqual([a, null]); // no further delivery after unsubscribe
  });

  it("general fallback contract: fresh module state → getCaddieContext() is null", () => {
    expect(getCaddieContext()).toBeNull();
  });
});

describe("caddie-context orb-state channel", () => {
  beforeEach(() => {
    // Drain back to idle between tests (setCaddieOrbState no-ops if already
    // idle, so drive it via the public setter using whatever state is live).
    if (getCaddieOrbState() !== "idle") setCaddieOrbState("idle");
  });

  it("set/get/subscribe/unsubscribe; setting the same state doesn't re-notify", () => {
    const seen: CaddieOrbState[] = [];
    const off = onCaddieOrbState((s) => seen.push(s));
    setCaddieOrbState("confirming");
    expect(getCaddieOrbState()).toBe("confirming");
    setCaddieOrbState("confirming"); // no-op, same state
    expect(seen).toEqual(["confirming"]);
    setCaddieOrbState("idle");
    expect(seen).toEqual(["confirming", "idle"]);
    off();
    setCaddieOrbState("listening");
    expect(seen).toEqual(["confirming", "idle"]); // no further delivery
    setCaddieOrbState("idle"); // reset for other tests
  });
});
