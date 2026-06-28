import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Capacitor Preferences backend so we test the store contract, not the
// native plugin. When the backend is swapped to a Keychain plugin, only the
// mock target (and the import in native-token-store.ts) changes.
const store = new Map<string, string>();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: store.has(key) ? store.get(key)! : null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      store.delete(key);
    }),
  },
}));

import {
  clearNativeToken,
  getNativeToken,
  setNativeToken,
} from "./native-token-store";

describe("native-token-store", () => {
  beforeEach(() => store.clear());

  it("returns null when no token has been stored", async () => {
    expect(await getNativeToken()).toBeNull();
  });

  it("round-trips a stored token", async () => {
    await setNativeToken("jwt-abc");
    expect(await getNativeToken()).toBe("jwt-abc");
  });

  it("clears the token (the sign-out path) so it no longer reads back", async () => {
    await setNativeToken("jwt-abc");
    await clearNativeToken();
    expect(await getNativeToken()).toBeNull();
  });

  it("clear is safe to call when nothing is stored", async () => {
    await expect(clearNativeToken()).resolves.toBeUndefined();
    expect(await getNativeToken()).toBeNull();
  });
});
