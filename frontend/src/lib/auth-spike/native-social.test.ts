// Mocked-plugin tests for the native-social wrapper
// (specs/auth-headless-spike-plan.md §6 Gate 4 nonce-binding half): the
// nonce we generate is forwarded into SocialLogin.login()'s options, and an
// ID token whose `nonce` claim doesn't match is rejected BEFORE it would
// ever reach Clerk.

import { beforeEach, describe, expect, it, vi } from "vitest";

function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "RS256" })}.${b64url(payload)}.fake-signature`;
}

const isNativePlatform = vi.fn(() => true);
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativePlatform() },
}));

const initialize = vi.fn(async (_options: unknown) => undefined);
const login = vi.fn(async (_options: unknown) => ({}) as unknown);
vi.mock("@capgo/capacitor-social-login", () => ({
  SocialLogin: {
    initialize: (options: unknown) => initialize(options),
    login: (options: unknown) => login(options),
  },
}));

async function importWrapper() {
  return await import("./native-social");
}

describe("native-social wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    isNativePlatform.mockReturnValue(true);
    initialize.mockClear();
    login.mockClear();
  });

  describe("nativeGoogleIdToken", () => {
    it("forwards the nonce into SocialLogin.login options and returns idToken on a match", async () => {
      const { nativeGoogleIdToken } = await importWrapper();
      const rawNonce = "nonce-abc-123";
      const idToken = makeFakeJwt({ sub: "g1", nonce: rawNonce });
      login.mockResolvedValueOnce({
        provider: "google",
        result: { responseType: "online", idToken, accessToken: null, profile: {} },
      });

      const result = await nativeGoogleIdToken(rawNonce);

      expect(login).toHaveBeenCalledWith({
        provider: "google",
        options: { nonce: rawNonce },
      });
      expect(result).toEqual({ idToken });
    });

    it("rejects when the returned idToken's nonce claim mismatches", async () => {
      const { nativeGoogleIdToken, NonceMismatchError } = await importWrapper();
      const rawNonce = "nonce-abc-123";
      const idToken = makeFakeJwt({ sub: "g1", nonce: "some-other-nonce" });
      login.mockResolvedValueOnce({
        provider: "google",
        result: { responseType: "online", idToken, accessToken: null, profile: {} },
      });

      await expect(nativeGoogleIdToken(rawNonce)).rejects.toBeInstanceOf(NonceMismatchError);
    });

    it("throws when not on a native platform (never calls the plugin)", async () => {
      isNativePlatform.mockReturnValue(false);
      const { nativeGoogleIdToken } = await importWrapper();
      await expect(nativeGoogleIdToken("n")).rejects.toThrow(/native platform/);
      expect(login).not.toHaveBeenCalled();
    });

    it("throws when the plugin returns offline mode (no idToken)", async () => {
      const { nativeGoogleIdToken } = await importWrapper();
      login.mockResolvedValueOnce({
        provider: "google",
        result: { responseType: "offline", serverAuthCode: "code" },
      });
      await expect(nativeGoogleIdToken("n")).rejects.toThrow(/idToken/);
    });
  });

  describe("nativeAppleIdToken", () => {
    it("forwards the nonce into SocialLogin.login options and returns idToken on a match", async () => {
      const { nativeAppleIdToken } = await importWrapper();
      const rawNonce = "nonce-xyz-789";
      const idToken = makeFakeJwt({ sub: "a1", nonce: rawNonce });
      login.mockResolvedValueOnce({
        provider: "apple",
        result: { idToken, accessToken: null, profile: { user: "a1", email: null, givenName: null, familyName: null } },
      });

      const result = await nativeAppleIdToken(rawNonce);

      expect(login).toHaveBeenCalledWith({
        provider: "apple",
        options: { nonce: rawNonce },
      });
      expect(result).toEqual({ idToken });
    });

    it("accepts an Apple-style SHA-256(nonce) claim", async () => {
      const { nativeAppleIdToken } = await importWrapper();
      const { sha256Hex } = await import("./nonce");
      const rawNonce = "nonce-xyz-789";
      const hashed = await sha256Hex(rawNonce);
      const idToken = makeFakeJwt({ sub: "a1", nonce: hashed });
      login.mockResolvedValueOnce({
        provider: "apple",
        result: { idToken, accessToken: null, profile: { user: "a1", email: null, givenName: null, familyName: null } },
      });

      const result = await nativeAppleIdToken(rawNonce);
      expect(result).toEqual({ idToken });
    });

    it("rejects when the returned idToken's nonce claim mismatches", async () => {
      const { nativeAppleIdToken, NonceMismatchError } = await importWrapper();
      const rawNonce = "nonce-xyz-789";
      const idToken = makeFakeJwt({ sub: "a1", nonce: "wrong-nonce" });
      login.mockResolvedValueOnce({
        provider: "apple",
        result: { idToken, accessToken: null, profile: { user: "a1", email: null, givenName: null, familyName: null } },
      });

      await expect(nativeAppleIdToken(rawNonce)).rejects.toBeInstanceOf(NonceMismatchError);
    });

    it("throws when not on a native platform (never calls the plugin)", async () => {
      isNativePlatform.mockReturnValue(false);
      const { nativeAppleIdToken } = await importWrapper();
      await expect(nativeAppleIdToken("n")).rejects.toThrow(/native platform/);
      expect(login).not.toHaveBeenCalled();
    });
  });

  it("initializes the plugin exactly once even across both providers", async () => {
    const { nativeGoogleIdToken, nativeAppleIdToken } = await importWrapper();
    const rawNonce = "n";
    const googleToken = makeFakeJwt({ sub: "g1", nonce: rawNonce });
    const appleToken = makeFakeJwt({ sub: "a1", nonce: rawNonce });
    login
      .mockResolvedValueOnce({
        provider: "google",
        result: { responseType: "online", idToken: googleToken, accessToken: null, profile: {} },
      })
      .mockResolvedValueOnce({
        provider: "apple",
        result: { idToken: appleToken, accessToken: null, profile: { user: "a1", email: null, givenName: null, familyName: null } },
      });

    await nativeGoogleIdToken(rawNonce);
    await nativeAppleIdToken(rawNonce);

    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
