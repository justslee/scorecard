// P0 login-blocked fix (specs/p0-login-blocked-plan.md §2 "make the dev
// diagnostic honest"): regression test for the exact artifact that
// manufactured the phantom "stale-token wedge" defect.
//
// The old shape tracked one global `authHeaderReceived` (written by the
// after-hook) alongside a free-floating `lastFapiPath` (written by the
// before-hook) — two independently-overwritten fields that could describe
// TWO DIFFERENT requests. A readout like "auth-hdr=false path=/v1/client"
// could actually mean "/v1/environment (no auth header, expected) was the
// last RESPONSE; /v1/client happened to be the last REQUEST" — a coherent-
// looking but meaningless pairing. `lastResponse` is now written atomically,
// once, by the after-hook only, so path/status/authHeaderPresent always
// describe the SAME response.

import { describe, expect, it, beforeEach } from "vitest";
import {
  getAuthDiag,
  recordFapiResponse,
  setAuthDiag,
} from "./auth-diag";

describe("auth-diag — atomic per-response record", () => {
  beforeEach(() => {
    // Reset the module-level state between tests via a full overwrite —
    // setAuthDiag merges, so drive every field back to its default shape.
    setAuthDiag({
      tokenRestored: false,
      nativeApiDisabled: false,
      lastError: null,
      isNativeSent: false,
      lastRequestPath: null,
      lastResponse: null,
      responseByPath: {},
    });
  });

  it("an /v1/environment response (no auth header) followed by an /v1/client response (auth header) leaves auth-hdr(/v1/client)=true and lastResponse describing /v1/client only", () => {
    // Healthy-run ordering: /v1/environment always answers first with no
    // authorization header (this is what manufactured the false auth-hdr=false
    // reading in the falsified "stale-token wedge" hypothesis).
    recordFapiResponse({
      path: "/v1/environment",
      status: 200,
      authHeaderPresent: false,
    });
    recordFapiResponse({
      path: "/v1/client",
      status: 200,
      authHeaderPresent: true,
    });

    const diag = getAuthDiag();

    // The per-path map keeps BOTH responses distinctly — /v1/environment's
    // false does not clobber, or get clobbered by, /v1/client's true.
    expect(diag.responseByPath["/v1/environment"]).toEqual({
      path: "/v1/environment",
      status: 200,
      authHeaderPresent: false,
    });
    expect(diag.responseByPath["/v1/client"]).toEqual({
      path: "/v1/client",
      status: 200,
      authHeaderPresent: true,
    });

    // lastResponse is the LAST atomic write — it must describe /v1/client,
    // never a stitched-together mix of the two calls.
    expect(diag.lastResponse).toEqual({
      path: "/v1/client",
      status: 200,
      authHeaderPresent: true,
    });
    expect(diag.lastResponse?.path).toBe("/v1/client");
  });

  it("lastRequestPath (before-hook) and lastResponse (after-hook) are independent fields that can legitimately describe different calls", () => {
    // Before-hook fires for /v1/client...
    setAuthDiag({ isNativeSent: true, lastRequestPath: "/v1/client" });
    // ...but the environment response resolves first (typical ordering).
    recordFapiResponse({
      path: "/v1/environment",
      status: 200,
      authHeaderPresent: false,
    });

    const diag = getAuthDiag();
    // Both fields are real and neither overwrites the other — they are NOT
    // meant to be read as one row (the exact bug this shape prevents).
    expect(diag.lastRequestPath).toBe("/v1/client");
    expect(diag.lastResponse?.path).toBe("/v1/environment");
  });

  it("recordFapiResponse never touches the independent scalar fields written by setAuthDiag", () => {
    setAuthDiag({ tokenRestored: true, isNativeSent: true });
    recordFapiResponse({ path: "/v1/client", status: 200, authHeaderPresent: true });

    const diag = getAuthDiag();
    expect(diag.tokenRestored).toBe(true);
    expect(diag.isNativeSent).toBe(true);
  });
});
