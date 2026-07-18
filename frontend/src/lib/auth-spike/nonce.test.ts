import { describe, expect, it } from "vitest";
import { generateNonce, sha256Hex, verifyIdTokenNonce } from "./nonce";

function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "RS256" })}.${b64url(payload)}.fake-signature`;
}

describe("generateNonce", () => {
  it("produces a 64-char hex string (32 random bytes)", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is different on every call", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });
});

describe("sha256Hex", () => {
  it("matches a known SHA-256 test vector", async () => {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic for the same input", async () => {
    const nonce = generateNonce();
    expect(await sha256Hex(nonce)).toBe(await sha256Hex(nonce));
  });
});

describe("verifyIdTokenNonce", () => {
  it("accepts a raw (unhashed) nonce echo — Google's behavior", async () => {
    const rawNonce = generateNonce();
    const idToken = makeFakeJwt({ sub: "u1", nonce: rawNonce });
    expect(await verifyIdTokenNonce(idToken, rawNonce)).toBe(true);
  });

  it("accepts a SHA-256(rawNonce) claim — Apple's behavior", async () => {
    const rawNonce = generateNonce();
    const hashed = await sha256Hex(rawNonce);
    const idToken = makeFakeJwt({ sub: "u1", nonce: hashed });
    expect(await verifyIdTokenNonce(idToken, rawNonce)).toBe(true);
  });

  it("rejects a mismatched nonce claim (replay/tamper)", async () => {
    const rawNonce = generateNonce();
    const idToken = makeFakeJwt({ sub: "u1", nonce: "some-other-value" });
    expect(await verifyIdTokenNonce(idToken, rawNonce)).toBe(false);
  });

  it("rejects a token with no nonce claim at all", async () => {
    const rawNonce = generateNonce();
    const idToken = makeFakeJwt({ sub: "u1" });
    expect(await verifyIdTokenNonce(idToken, rawNonce)).toBe(false);
  });

  it("rejects a malformed token instead of throwing", async () => {
    expect(await verifyIdTokenNonce("not-a-jwt", generateNonce())).toBe(false);
  });
});
