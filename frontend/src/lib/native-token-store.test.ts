import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock both backends the store touches: the CURRENT Keychain-backed plugin
// and the PRIOR plaintext @capacitor/preferences store (kept mocked so the
// one-time migrate-then-delete path is exercised). When the backend is
// swapped again, only these mocks (and the imports in
// native-token-store.ts) change.
const keychainStore = new Map<string, string>();
const prefsStore = new Map<string, string>();

vi.mock("@aparajita/capacitor-secure-storage", () => ({
  // Real values don't matter here — the store never branches on them, it
  // just threads them through to SecureStorage.set as opaque args.
  KeychainAccess: { whenUnlockedThisDeviceOnly: 1 },
  SecureStorage: {
    get: vi.fn(async (key: string) =>
      keychainStore.has(key) ? keychainStore.get(key)! : null,
    ),
    set: vi.fn(async (key: string, value: string) => {
      keychainStore.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      const had = keychainStore.has(key);
      keychainStore.delete(key);
      return had;
    }),
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefsStore.has(key) ? prefsStore.get(key)! : null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      prefsStore.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      prefsStore.delete(key);
    }),
  },
}));

const JWT_KEY = "__clerk_client_jwt";

// The store caches its one-time migration promise at MODULE scope (by
// design — see native-token-store.ts). Re-import fresh via
// vi.resetModules() before every test so tests don't leak that singleton
// into each other.
async function importStore() {
  return await import("./native-token-store");
}

describe("native-token-store", () => {
  beforeEach(() => {
    keychainStore.clear();
    prefsStore.clear();
    vi.resetModules();
  });

  it("returns null when no token has been stored", async () => {
    const { getNativeToken } = await importStore();
    expect(await getNativeToken()).toBeNull();
  });

  it("round-trips a stored token", async () => {
    const { getNativeToken, setNativeToken } = await importStore();
    await setNativeToken("jwt-abc");
    expect(await getNativeToken()).toBe("jwt-abc");
  });

  it("clears the token (the sign-out path) so it no longer reads back", async () => {
    const { getNativeToken, setNativeToken, clearNativeToken } =
      await importStore();
    await setNativeToken("jwt-abc");
    await clearNativeToken();
    expect(await getNativeToken()).toBeNull();
  });

  it("clear is safe to call when nothing is stored", async () => {
    const { getNativeToken, clearNativeToken } = await importStore();
    await expect(clearNativeToken()).resolves.toBeUndefined();
    expect(await getNativeToken()).toBeNull();
  });

  it("migrates a legacy plaintext Preferences token into the Keychain and deletes the plaintext entry", async () => {
    prefsStore.set(JWT_KEY, "legacy-plaintext-jwt");
    const { getNativeToken } = await importStore();

    expect(await getNativeToken()).toBe("legacy-plaintext-jwt");
    expect(keychainStore.get(JWT_KEY)).toBe("legacy-plaintext-jwt");
    expect(prefsStore.has(JWT_KEY)).toBe(false); // plaintext residue purged
  });

  it("does not resurrect the plaintext entry on subsequent reads/writes after migration", async () => {
    prefsStore.set(JWT_KEY, "legacy-plaintext-jwt");
    const { getNativeToken, setNativeToken } = await importStore();

    await getNativeToken(); // triggers migration
    await setNativeToken("fresh-jwt"); // normal write, post-migration

    expect(await getNativeToken()).toBe("fresh-jwt");
    expect(prefsStore.has(JWT_KEY)).toBe(false);
  });

  it("migration is race-safe under concurrent getNativeToken calls (no double-migrate, no lost token)", async () => {
    prefsStore.set(JWT_KEY, "legacy-plaintext-jwt");
    const { getNativeToken } = await importStore();

    const results = await Promise.all([
      getNativeToken(),
      getNativeToken(),
      getNativeToken(),
    ]);

    expect(results).toEqual([
      "legacy-plaintext-jwt",
      "legacy-plaintext-jwt",
      "legacy-plaintext-jwt",
    ]);
    expect(keychainStore.get(JWT_KEY)).toBe("legacy-plaintext-jwt");
    expect(prefsStore.has(JWT_KEY)).toBe(false);
  });

  it("sign-out clears both the Keychain entry and any lingering plaintext Preferences entry", async () => {
    const { setNativeToken, clearNativeToken, getNativeToken } =
      await importStore();
    await setNativeToken("jwt-abc");
    prefsStore.set(JWT_KEY, "stale-plaintext-residue"); // simulate leftover residue

    await clearNativeToken();

    expect(keychainStore.has(JWT_KEY)).toBe(false);
    expect(prefsStore.has(JWT_KEY)).toBe(false);
    expect(await getNativeToken()).toBeNull();
  });
});
