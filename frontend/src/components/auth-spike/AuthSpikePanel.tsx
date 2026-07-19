"use client";

/**
 * AuthSpikePanel — the throwaway UI for the auth-headless-spike
 * (specs/auth-headless-spike-plan.md §2/§3/§6/§7 step 3). Deliberately ugly:
 * plain HTML, no yardage-book styling. Only reachable at /dev/auth-spike
 * when NEXT_PUBLIC_AUTH_SPIKE=1 — never linked to from the real app.
 *
 * Exercises every headless flow named in the plan:
 *   §3.1  email+password / email-code sign-in AND sign-up (Future API)
 *   §3.2  Google OAuth — web redirect (signIn.sso)
 *   §3.3  Google OAuth — native ID-token (authenticateWithGoogleOneTap)
 *   §3.4  Sign in with Apple — native ID-token (classic clerk.client.signIn.create)
 *   §3.5  headless sign-out
 *   Gate 1 — capture/compare JWT parity against the prebuilt-widget baseline
 *   "ping backend" — an existing authenticated GET, to prove the unchanged
 *   backend accepts whatever session the flow produced.
 *
 * Credential-no-log discipline (Gate 4): this file must never console.log /
 * setAuthDiag / template-interpolate a password, code, idToken, identityToken,
 * or rawNonce — enforced by scripts/assert-no-credential-log.mjs.
 */

import { useState } from "react";
import { useAuth, useClerk, useSignIn, useSignUp } from "@clerk/react";
import { Capacitor } from "@capacitor/core";
import NativeAuthDiag from "@/components/NativeAuthDiag";
import { getGolferProfileAsync } from "@/lib/api";
import { claimShape, decodeJwtPayload, assertJwtParity, type JwtClaimShape } from "@/lib/auth-spike/jwt-parity";
import { generateNonce } from "@/lib/auth-spike/nonce";
import { nativeAppleIdToken, nativeGoogleIdToken } from "@/lib/auth-spike/native-social";

// ── Ugly, plain styles — deliberately not yardage-book (spike UI, never shipped) ──
const box: React.CSSProperties = {
  border: "1px solid #999",
  padding: 12,
  margin: "12px 0",
  fontFamily: "monospace",
  fontSize: 13,
  background: "#fafafa",
};
const row: React.CSSProperties = { display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" };
const input: React.CSSProperties = { padding: 4, fontFamily: "monospace" };
const btn: React.CSSProperties = { padding: "4px 10px", cursor: "pointer" };
const pre: React.CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11 };

/** Uniform, non-enumerating status line — shows the Clerk error `code` only (not raw messages). */
function errCode(e: unknown): string {
  if (e && typeof e === "object" && "code" in e) return String((e as { code: unknown }).code);
  return e instanceof Error ? e.message : String(e);
}

export default function AuthSpikePanel() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const clerk = useClerk();
  const isNative = Capacitor.isNativePlatform();

  const [log, setLog] = useState<string[]>([]);
  const append = (line: string) => setLog((l) => [...l.slice(-30), line]);

  // Email/password/code form state (dev-only spike UI — plain fields, no
  // masking beyond the native input type; never logged, see box above).
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  // Gate-1 JWT parity state — only the CLAIM SHAPE is retained, never the raw JWT.
  const [baseline, setBaseline] = useState<JwtClaimShape | null>(null);

  async function withStatus(label: string, fn: () => Promise<void>) {
    append(`${label}… `);
    try {
      await fn();
      append(`${label}: ok`);
    } catch (e) {
      append(`${label}: FAILED (${errCode(e)})`);
    }
  }

  // ── §3.1 email + password ──────────────────────────────────────────────
  const signInPassword = () =>
    withStatus("signIn.password", async () => {
      const { error } = await signIn.password({ emailAddress: email, password });
      if (error) throw error;
      const { error: finalizeError } = await signIn.finalize();
      if (finalizeError) throw finalizeError;
    });

  const signUpPassword = () =>
    withStatus("signUp.password", async () => {
      const { error } = await signUp.password({ emailAddress: email, password });
      if (error) throw error;
      const { error: sendErr } = await signUp.verifications.sendEmailCode();
      if (sendErr) throw sendErr;
      append("signUp.password: verification code sent — enter it, then tap verify+finalize");
    });

  const signUpPasswordVerifyFinalize = () =>
    withStatus("signUp.verifyEmailCode+finalize", async () => {
      const { error } = await signUp.verifications.verifyEmailCode({ code });
      if (error) throw error;
      const { error: finalizeError } = await signUp.finalize();
      if (finalizeError) throw finalizeError;
    });

  // ── §3.1 email code ─────────────────────────────────────────────────────
  const signInEmailCodeSend = () =>
    withStatus("signIn.emailCode.sendCode", async () => {
      const { error } = await signIn.emailCode.sendCode({ emailAddress: email });
      if (error) throw error;
    });

  const signInEmailCodeVerify = () =>
    withStatus("signIn.emailCode.verifyCode+finalize", async () => {
      const { error } = await signIn.emailCode.verifyCode({ code });
      if (error) throw error;
      const { error: finalizeError } = await signIn.finalize();
      if (finalizeError) throw finalizeError;
    });

  const signUpEmailCodeCreate = () =>
    withStatus("signUp.create+sendEmailCode", async () => {
      const { error } = await signUp.create({ emailAddress: email });
      if (error) throw error;
      const { error: sendErr } = await signUp.verifications.sendEmailCode();
      if (sendErr) throw sendErr;
    });

  // ── §3.2 Google web (pure FAPI redirect) ────────────────────────────────
  const googleWeb = () =>
    withStatus("signIn.sso (google web)", async () => {
      const origin = window.location.origin;
      const { error } = await signIn.sso({
        strategy: "oauth_google",
        redirectUrl: `${origin}/sso-callback`,
        redirectCallbackUrl: `${origin}/dev/auth-spike`,
      });
      if (error) throw error; // success case navigates away; no code after this runs
    });

  // ── §3.3 Google native ID-token ─────────────────────────────────────────
  const googleNative = () =>
    withStatus("google native ID-token", async () => {
      const rawNonce = generateNonce();
      const { idToken } = await nativeGoogleIdToken(rawNonce);
      const resource = await clerk.authenticateWithGoogleOneTap({ token: idToken });
      if (!resource.createdSessionId) throw new Error("no createdSessionId from authenticateWithGoogleOneTap");
      await clerk.setActive({ session: resource.createdSessionId });
    });

  // ── §3.4 Apple native ID-token (classic resource — no Future-API equivalent) ──
  const appleNative = () =>
    withStatus("apple native ID-token", async () => {
      const rawNonce = generateNonce();
      const { idToken } = await nativeAppleIdToken(rawNonce);
      const res = await clerk.client.signIn.create({ strategy: "oauth_token_apple", token: idToken });
      if (res.status === "complete" && res.createdSessionId) {
        await clerk.setActive({ session: res.createdSessionId });
      } else if (res.firstFactorVerification?.status === "transferable") {
        const up = await clerk.client.signUp.create({ transfer: true });
        if (!up.createdSessionId) throw new Error("transfer sign-up produced no createdSessionId");
        await clerk.setActive({ session: up.createdSessionId });
      } else {
        throw new Error(`unexpected signIn status: ${res.status}`);
      }
    });

  // ── §3.5 headless sign-out ───────────────────────────────────────────────
  const headlessSignOut = () =>
    withStatus("signOut", async () => {
      await clerk.signOut();
    });

  // ── Gate 1: capture baseline / compare ──────────────────────────────────
  const captureBaseline = () =>
    withStatus("capture baseline", async () => {
      const token = await getToken();
      if (!token) throw new Error("getToken() returned null — not signed in?");
      setBaseline(claimShape(decodeJwtPayload(token)));
    });

  const compareToBaseline = () =>
    withStatus("compare JWT parity", async () => {
      if (!baseline) throw new Error("capture a baseline first");
      const token = await getToken();
      if (!token) throw new Error("getToken() returned null — not signed in?");
      const candidate = claimShape(decodeJwtPayload(token));
      const result = assertJwtParity(baseline, candidate);
      append(
        result.ok
          ? `PARITY PASS — iss=${candidate.iss} azp=${candidate.azp}`
          : `PARITY DIFF — ${JSON.stringify(result.diffs)}`,
      );
    });

  // ── ping backend ─────────────────────────────────────────────────────────
  const pingBackend = () =>
    withStatus("ping backend (GET /api/profile/golfer)", async () => {
      const profile = await getGolferProfileAsync();
      append(`ping backend: ${profile ? "200 (profile found)" : "200 (no profile yet)"}`);
    });

  return (
    <div style={{ padding: 16, fontFamily: "monospace", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 16 }}>auth-headless-spike (NEXT_PUBLIC_AUTH_SPIKE=1)</h1>
      <p style={pre}>
        loaded={String(isLoaded)} signed={String(isSignedIn ?? false)} native={String(isNative)}
      </p>

      <div style={box}>
        <strong>Email / password / code</strong>
        <div style={row}>
          <input style={input} placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input style={input} placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input style={input} placeholder="code" value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <div style={row}>
          <button style={btn} onClick={signInPassword}>sign-in: password</button>
          <button style={btn} onClick={signUpPassword}>sign-up: password (send code)</button>
          <button style={btn} onClick={signUpPasswordVerifyFinalize}>sign-up: verify code + finalize</button>
        </div>
        <div style={row}>
          <button style={btn} onClick={signInEmailCodeSend}>sign-in: send email code</button>
          <button style={btn} onClick={signInEmailCodeVerify}>sign-in: verify code + finalize</button>
          <button style={btn} onClick={signUpEmailCodeCreate}>sign-up: email-code create (send code)</button>
        </div>
      </div>

      <div style={box}>
        <strong>Google / Apple</strong>
        <div style={row}>
          <button style={btn} onClick={googleWeb}>Google (web redirect)</button>
          <button style={btn} onClick={googleNative} disabled={!isNative}>Google (native ID-token){!isNative && " — native only"}</button>
          <button style={btn} onClick={appleNative} disabled={!isNative}>Apple (native ID-token){!isNative && " — native only"}</button>
        </div>
      </div>

      <div style={box}>
        <strong>Sign-out / JWT parity / backend</strong>
        <div style={row}>
          <button style={btn} onClick={headlessSignOut}>headless signOut()</button>
          <button style={btn} onClick={captureBaseline}>capture baseline (widget sign-in first)</button>
          <button style={btn} onClick={compareToBaseline}>compare to baseline</button>
          <button style={btn} onClick={pingBackend}>ping backend</button>
        </div>
        {baseline && (
          <p style={pre}>baseline: iss={baseline.iss} azp={baseline.azp} keys={baseline.claimKeys.join(",")}</p>
        )}
      </div>

      <div style={box}>
        <strong>Log</strong>
        <pre style={pre}>{log.join("\n")}</pre>
      </div>

      <NativeAuthDiag />
    </div>
  );
}
