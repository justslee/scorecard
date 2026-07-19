"use client";

/**
 * useAuthFlow — headless state machine over Clerk's Future API
 * (`useSignIn()`/`useSignUp()`), built for the custom yardage-book login
 * screen (specs/login-screen-visual-plan.md §2).
 *
 * Every Clerk call below is verbatim from the PROVEN
 * `AuthSpikePanel.tsx` (specs/auth-headless-spike-verdict.md §3) — same
 * sequences, same Future-API-as-primary posture (classic API is not used
 * here at all; Apple/Google native ID-token wiring, which needs the classic
 * surface, is disabled this slice — see OAuthButtons.tsx).
 *
 * UI-free and fully unit-testable: no DOM, no styling, no navigation.
 *
 * Credential-no-log discipline: this file must never console.* / template-
 * interpolate a password/code/token — enforced by
 * scripts/assert-no-credential-log.mjs (now scanning `src/components/auth`).
 * State only ever stores the ALREADY-MAPPED uniform copy (`authErrorCopy`),
 * never `error.message` / `error.longMessage` (which can leak account
 * existence — see the enumeration-hygiene table below). No `getToken()`
 * calls live in this directory — tokens stay in the clerk-js/Keychain
 * bridge. No `signOut()` calls — the sign-out invariant stays centralized
 * in `ClerkTokenBridge`.
 */

import { useCallback, useRef, useState } from "react";
import { useSignIn, useSignUp } from "@clerk/react";

export type Intent = "signIn" | "signUp";
export type EmailMethod = "code" | "password";
export type FlowOwner = "signIn" | "signUp";
export type Step = "method" | "email" | "code" | "done";

export interface AuthFlowState {
  step: Step;
  intent: Intent;
  emailMethod: EmailMethod;
  emailAddress: string;
  flowOwner: FlowOwner | null;
  busy: boolean;
  /** Already-mapped uniform copy — never a raw Clerk message. */
  error: string | null;
  resendAvailableAt: number | null;
}

export interface UseAuthFlowResult {
  state: AuthFlowState;
  chooseEmail: () => void;
  submitPassword: (email: string, password: string) => Promise<void>;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (code: string) => Promise<void>;
  resendCode: () => Promise<void>;
  back: () => void;
  toggleIntent: () => void;
  toggleEmailMethod: () => void;
}

const RESEND_COOLDOWN_MS = 30_000;

const OFFLINE_COPY = "You're offline — sign-in needs a connection.";
const GENERIC_COPY = "Something went wrong on our end. Try again.";
const PASSWORD_MISMATCH_COPY = "That email and password don't match.";

/**
 * Enumeration hygiene — error-code → uniform copy (login-screen-visual plan
 * §5). Raw Clerk `message`/`longMessage` are NEVER rendered or stored (they
 * leak account existence). `"offline"` is a synthetic (non-Clerk) code used
 * by this module's own offline pre-check / thrown-transport-error catch.
 */
export function authErrorCopy(code: string): string {
  switch (code) {
    // Password path: not-found and wrong-password are BYTE-IDENTICAL copy —
    // no existence leak.
    case "form_identifier_not_found":
    case "form_password_incorrect":
    // Sign-up pivot fallback (the pivot itself is silent; this only surfaces
    // if the pivoted sign-in also fails).
    case "form_identifier_exists":
      return PASSWORD_MISMATCH_COPY;
    case "form_code_incorrect":
      return "That code isn't right — check the email and try again.";
    case "verification_expired":
    case "verification_failed":
      return "That code expired. Tap resend and we'll send a fresh one.";
    case "too_many_requests":
      return "A lot of attempts just now. Give it a minute, then try again.";
    case "form_password_pwned":
      return "That password showed up in a known breach — pick a different one.";
    case "form_password_length_too_short":
    case "form_password_validation_failed":
    case "form_password_size_in_bytes_exceeded":
      return "Passwords need at least 8 characters.";
    case "form_param_format_invalid":
      return "That doesn't look like an email address.";
    case "offline":
      return OFFLINE_COPY;
    default:
      return GENERIC_COPY;
  }
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Minimal shape of what the Future-API methods return — a mapped Clerk `code`. */
type MaybeError = { error: { code: string } | null };

export function useAuthFlow(initialIntent: Intent): UseAuthFlowResult {
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();

  const [state, setState] = useState<AuthFlowState>({
    step: "method",
    intent: initialIntent,
    emailMethod: "code",
    emailAddress: "",
    flowOwner: null,
    busy: false,
    error: null,
    resendAvailableAt: null,
  });

  // Synchronous re-entrancy guard — every action no-ops while an action is
  // in flight. A ref (not state.busy) so the check is correct even mid-render.
  const busyRef = useRef(false);

  const patch = useCallback((p: Partial<AuthFlowState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  /** Runs `fn`, guarding re-entrancy + offline + thrown transport errors. */
  const guarded = useCallback(
    async (fn: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      patch({ busy: true, error: null });
      try {
        if (isOffline()) {
          patch({ error: authErrorCopy("offline") });
          return;
        }
        await fn();
      } catch {
        // Thrown transport error (offline / network failure) — never a raw
        // exception message.
        patch({ error: authErrorCopy("offline") });
      } finally {
        busyRef.current = false;
        patch({ busy: false });
      }
    },
    [patch],
  );

  const mapAndSet = useCallback(
    (result: MaybeError): boolean => {
      // `session_exists` — treated as success, not surfaced as an error.
      if (result.error && result.error.code !== "session_exists") {
        patch({ error: authErrorCopy(result.error.code) });
        return false;
      }
      return true;
    },
    [patch],
  );

  const chooseEmail = useCallback(() => {
    if (busyRef.current) return;
    patch({ step: "email", error: null });
  }, [patch]);

  const submitPassword = useCallback(
    (email: string, password: string) =>
      guarded(async () => {
        patch({ emailAddress: email });
        if (state.intent === "signIn") {
          const { error } = await signIn.password({ emailAddress: email, password });
          if (error && error.code !== "session_exists") {
            patch({ error: authErrorCopy(error.code) });
            return;
          }
          const { error: finalizeError } = await signIn.finalize();
          if (!mapAndSet({ error: finalizeError })) return;
          patch({ step: "done" });
          return;
        }

        // intent === "signUp"
        const { error } = await signUp.password({ emailAddress: email, password });
        if (error) {
          if (error.code === "form_identifier_exists") {
            // Silent pivot: the account already exists — try signing in with
            // the same credentials instead. Success = user just signs in;
            // failure = uniform "don't match" copy. Zero enumeration leak.
            const pivot = await signIn.password({ emailAddress: email, password });
            if (pivot.error && pivot.error.code !== "session_exists") {
              patch({ error: PASSWORD_MISMATCH_COPY });
              return;
            }
            const finalized = await signIn.finalize();
            if (!mapAndSet({ error: finalized.error })) return;
            patch({ step: "done" });
            return;
          }
          patch({ error: authErrorCopy(error.code) });
          return;
        }
        // Password sign-up still verifies email (spike-proven sequence).
        const { error: sendErr } = await signUp.verifications.sendEmailCode();
        if (!mapAndSet({ error: sendErr })) return;
        patch({
          flowOwner: "signUp",
          step: "code",
          resendAvailableAt: Date.now() + RESEND_COOLDOWN_MS,
        });
      }),
    [guarded, mapAndSet, patch, signIn, signUp, state.intent],
  );

  const sendCode = useCallback(
    (email: string) =>
      guarded(async () => {
        patch({ emailAddress: email });
        if (state.intent === "signIn") {
          const { error } = await signIn.emailCode.sendCode({ emailAddress: email });
          if (error) {
            if (error.code === "form_identifier_not_found") {
              // Silent pivot: no account yet — create one and send the
              // sign-up verification code instead. Identical "code sent"
              // step either way — zero enumeration leak.
              const created = await signUp.create({ emailAddress: email });
              if (!mapAndSet({ error: created.error })) return;
              const sent = await signUp.verifications.sendEmailCode();
              if (!mapAndSet({ error: sent.error })) return;
              patch({
                flowOwner: "signUp",
                step: "code",
                resendAvailableAt: Date.now() + RESEND_COOLDOWN_MS,
              });
              return;
            }
            patch({ error: authErrorCopy(error.code) });
            return;
          }
          patch({
            flowOwner: "signIn",
            step: "code",
            resendAvailableAt: Date.now() + RESEND_COOLDOWN_MS,
          });
          return;
        }

        // intent === "signUp"
        const { error } = await signUp.create({ emailAddress: email });
        if (error) {
          if (error.code === "form_identifier_exists") {
            // Silent pivot: account already exists — send a sign-in code
            // instead. Same "code sent" step either way.
            const sent = await signIn.emailCode.sendCode({ emailAddress: email });
            if (!mapAndSet({ error: sent.error })) return;
            patch({
              flowOwner: "signIn",
              step: "code",
              resendAvailableAt: Date.now() + RESEND_COOLDOWN_MS,
            });
            return;
          }
          patch({ error: authErrorCopy(error.code) });
          return;
        }
        const sent = await signUp.verifications.sendEmailCode();
        if (!mapAndSet({ error: sent.error })) return;
        patch({
          flowOwner: "signUp",
          step: "code",
          resendAvailableAt: Date.now() + RESEND_COOLDOWN_MS,
        });
      }),
    [guarded, mapAndSet, patch, signIn, signUp, state.intent],
  );

  const verifyCode = useCallback(
    (code: string) =>
      guarded(async () => {
        if (state.flowOwner === "signIn") {
          const { error } = await signIn.emailCode.verifyCode({ code });
          if (!mapAndSet({ error })) return;
          const { error: finalizeError } = await signIn.finalize();
          if (!mapAndSet({ error: finalizeError })) return;
          patch({ step: "done" });
        } else if (state.flowOwner === "signUp") {
          const { error } = await signUp.verifications.verifyEmailCode({ code });
          if (!mapAndSet({ error })) return;
          const { error: finalizeError } = await signUp.finalize();
          if (!mapAndSet({ error: finalizeError })) return;
          patch({ step: "done" });
        }
      }),
    [guarded, mapAndSet, patch, signIn, signUp, state.flowOwner],
  );

  const resendCode = useCallback(
    () =>
      guarded(async () => {
        // Politeness guard — never an automatic client retry loop.
        if (state.resendAvailableAt !== null && Date.now() < state.resendAvailableAt) {
          return;
        }
        if (state.flowOwner === "signIn") {
          const { error } = await signIn.emailCode.sendCode({ emailAddress: state.emailAddress });
          if (!mapAndSet({ error })) return;
        } else if (state.flowOwner === "signUp") {
          const { error } = await signUp.verifications.sendEmailCode();
          if (!mapAndSet({ error })) return;
        }
        patch({ resendAvailableAt: Date.now() + RESEND_COOLDOWN_MS });
      }),
    [guarded, mapAndSet, patch, signIn, signUp, state.emailAddress, state.flowOwner, state.resendAvailableAt],
  );

  const back = useCallback(() => {
    if (busyRef.current) return;
    setState((s) => {
      if (s.step === "code") return { ...s, step: "email", error: null };
      if (s.step === "email") return { ...s, step: "method", error: null };
      return s;
    });
  }, []);

  const toggleIntent = useCallback(() => {
    if (busyRef.current) return;
    setState((s) => ({ ...s, intent: s.intent === "signIn" ? "signUp" : "signIn", error: null }));
  }, []);

  const toggleEmailMethod = useCallback(() => {
    if (busyRef.current) return;
    setState((s) => ({
      ...s,
      emailMethod: s.emailMethod === "code" ? "password" : "code",
      error: null,
    }));
  }, []);

  return {
    state,
    chooseEmail,
    submitPassword,
    sendCode,
    verifyCode,
    resendCode,
    back,
    toggleIntent,
    toggleEmailMethod,
  };
}
