// Gate-1 offline tests (specs/auth-headless-spike-plan.md §6) — pure logic,
// no Clerk, no network, no crypto verification. Synthetic JWT-shaped
// fixtures only; decodeJwtPayload never checks the signature.

import { describe, expect, it } from "vitest";
import { assertJwtParity, claimShape, decodeJwtPayload } from "./jwt-parity";

/** Build a syntactically-valid (unsigned) JWT string from a payload object. */
function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = b64url({ alg: "RS256", typ: "JWT" });
  const body = b64url(payload);
  return `${header}.${body}.fake-signature`;
}

const BASELINE_PAYLOAD = {
  iss: "https://clerk.example.com",
  azp: "https://looper.app",
  sub: "user_123",
  sid: "sess_abc",
  fva: [1, -1],
};

describe("decodeJwtPayload", () => {
  it("decodes the middle segment without touching the signature", () => {
    const jwt = makeFakeJwt(BASELINE_PAYLOAD);
    expect(decodeJwtPayload(jwt)).toEqual(BASELINE_PAYLOAD);
  });

  it("throws on a malformed token (not 3 segments)", () => {
    expect(() => decodeJwtPayload("not-a-jwt")).toThrow();
  });
});

describe("claimShape", () => {
  it("extracts iss/azp and sorted claim keys", () => {
    const shape = claimShape(BASELINE_PAYLOAD);
    expect(shape.iss).toBe("https://clerk.example.com");
    expect(shape.azp).toBe("https://looper.app");
    expect(shape.claimKeys).toEqual(["azp", "fva", "iss", "sid", "sub"]);
  });

  it("leaves iss/azp undefined when absent rather than throwing", () => {
    const shape = claimShape({ sub: "user_123" });
    expect(shape.iss).toBeUndefined();
    expect(shape.azp).toBeUndefined();
  });
});

describe("assertJwtParity", () => {
  const baseline = claimShape(BASELINE_PAYLOAD);

  it("passes when iss/azp/shape are identical to the baseline", () => {
    const candidate = claimShape({ ...BASELINE_PAYLOAD, sub: "user_999", sid: "sess_xyz" });
    const result = assertJwtParity(baseline, candidate);
    expect(result.ok).toBe(true);
    expect(result.diffs).toEqual([]);
  });

  it("flags a wrong azp with a named diff", () => {
    const candidate = claimShape({ ...BASELINE_PAYLOAD, azp: "https://evil.example.com" });
    const result = assertJwtParity(baseline, candidate);
    expect(result.ok).toBe(false);
    expect(result.diffs).toContainEqual({
      field: "azp",
      baseline: "https://looper.app",
      candidate: "https://evil.example.com",
    });
  });

  it("flags a missing claim with a named diff", () => {
    const { fva: _fva, ...withoutFva } = BASELINE_PAYLOAD;
    const candidate = claimShape(withoutFva);
    const result = assertJwtParity(baseline, candidate);
    expect(result.ok).toBe(false);
    const diff = result.diffs.find((d) => d.field === "claimKeys");
    expect(diff).toBeDefined();
    expect(diff!.baseline).toContain("fva");
    expect(diff!.candidate).not.toContain("fva");
  });

  it("flags an extra claim with a named diff", () => {
    const candidate = claimShape({ ...BASELINE_PAYLOAD, act: { sub: "impersonator" } });
    const result = assertJwtParity(baseline, candidate);
    expect(result.ok).toBe(false);
    const diff = result.diffs.find((d) => d.field === "claimKeys");
    expect(diff).toBeDefined();
    expect(diff!.candidate).toContain("act");
    expect(diff!.baseline).not.toContain("act");
  });

  it("flags a wrong iss with a named diff", () => {
    const candidate = claimShape({ ...BASELINE_PAYLOAD, iss: "https://not-clerk.example.com" });
    const result = assertJwtParity(baseline, candidate);
    expect(result.ok).toBe(false);
    expect(result.diffs).toContainEqual({
      field: "iss",
      baseline: "https://clerk.example.com",
      candidate: "https://not-clerk.example.com",
    });
  });

  it("can report multiple diffs at once", () => {
    const candidate = claimShape({ sub: "user_123", azp: "https://evil.example.com" });
    const result = assertJwtParity(baseline, candidate);
    expect(result.ok).toBe(false);
    const fields = result.diffs.map((d) => d.field).sort();
    expect(fields).toEqual(["azp", "claimKeys", "iss"]);
  });
});
