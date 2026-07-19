"use client";

/**
 * SignInScreen — the custom headless login screen (login-screen-visual plan
 * §3): a full-bleed yardage-book hero (the 548yd hcp-1 par-5 dogleg,
 * rendered COMPLETE and STATIC — no animation, that's Slice 3) over a
 * hairline paper sheet with Apple/Google (rendered, live-disabled) and a
 * fully live email flow (code-primary, password-secondary).
 *
 * Dumb renderer over `useAuthFlow` — all Clerk state/transitions live
 * there; this component only reads `state` and calls the action functions.
 * Zero prebuilt-Clerk DOM (`<SignIn>`/`<SignUp>` from @clerk/react) — this
 * is a fully custom composition built from `yardage/tokens.ts` values only.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FocusEvent } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useAuth } from "@clerk/react";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import HoleIllustration from "@/components/yardage/HoleIllustration";
import OAuthButtons from "./OAuthButtons";
import { useAuthFlow, type Intent } from "./useAuthFlow";

const HERO_HOLE_NUMBER = 4; // HOLES[3] — 548yd, par 5, hcp 1, the signature dogleg.

// ── "Play once, on cold arrival only" (specs/login-animation-moment-plan.md
// §3.1, modeled on CaddieOrb's INTRO_SEEN_KEY pattern) ───────────────────────
const HERO_DRAW_SEEN_KEY = "looper.loginHeroDrawSeen";
let heroIntroPlayedThisSession = false; // module-scope latch — blocks a replay within this tab session even if the localStorage write below fails (private mode).

/** Render-time, pure — safe to double-invoke under StrictMode. Any read
 *  error (private mode, storage disabled, no `window` yet) is treated as
 *  "seen" → static: the safest default against replay annoyance. A healthy
 *  first-ever install returns `null` here → plays. */
function readHeroDrawSeen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(HERO_DRAW_SEEN_KEY) != null;
  } catch {
    return true;
  }
}

// SignInScreen-side entrances (beats 2/5/10 of specs/login-animation-moment-
// plan.md §2) — the hero's own 9 beats live in HoleIllustration's `INTRO`
// constant; these three numbers are pinned to that same storyboard clock
// (seconds from hero mount) but live here since they animate SignInScreen's
// own static blocks, not the SVG.
const INTRO_HEADER = { delay: 0.2, duration: 0.4 }; // beat 2 — page header
const INTRO_SHEET = { delay: 0.35, duration: 0.45 }; // beat 5 — sheet composes in
const INTRO_WORDMARK = { delay: 1.7, duration: 0.5 }; // beat 10 — the signature

// ── Shared step styles (all from yardage/tokens.ts — no new design language) ──
const pill: CSSProperties = {
  height: 56,
  width: "100%",
  borderRadius: 999,
  fontFamily: T.sans,
  fontSize: 15,
  fontWeight: 500,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  WebkitAppearance: "none",
  cursor: "pointer",
};

const primaryPill: CSSProperties = {
  ...pill,
  background: T.ink,
  color: T.paper,
};

const hairlinePill: CSSProperties = {
  ...pill,
  background: "transparent",
  color: T.ink,
  border: `1px solid ${T.hairline}`,
};

const quietLink: CSSProperties = {
  background: "none",
  border: "none",
  // Invisible hit-padding — 13px underline text alone was under the 44pt
  // one-handed touch target. Negative margin cancels the padding's layout
  // footprint so surrounding flex `gap` reads exactly as before — bigger tap
  // area, no visual shift.
  padding: "15px 8px",
  margin: "-15px -8px",
  fontFamily: T.sans,
  fontSize: 13,
  color: T.pencil,
  textDecoration: "underline",
  textUnderlineOffset: 3,
  cursor: "pointer",
  alignSelf: "center",
};

const overLabel: CSSProperties = {
  display: "block",
  fontFamily: T.mono,
  fontSize: 9,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: T.pencil,
  marginBottom: 6,
};

const underlineInput: CSSProperties = {
  width: "100%",
  fontSize: 17, // >=16px is mandatory — blocks iOS auto-zoom.
  fontFamily: T.sans,
  color: T.ink,
  background: "transparent",
  border: "none",
  borderBottom: `1px solid ${T.hairline}`,
  padding: "6px 0 10px",
  outline: "none",
};

const errorLine: CSSProperties = {
  fontFamily: T.sans,
  fontSize: 13,
  color: T.errorInk,
};

function useFocusScrollIntoView() {
  return (e: FocusEvent<HTMLInputElement>) => {
    const el = e.target;
    setTimeout(() => {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 300);
  };
}

export default function SignInScreen({ intent }: { intent: Intent }) {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const flow = useAuthFlow(intent);
  const { state } = flow;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const onFocusScroll = useFocusScrollIntoView();

  const heroRef = useRef<HTMLDivElement>(null);
  const [heroSize, setHeroSize] = useState(280);

  // Decision (read-time, render-pure — §3.1): whether THIS mount wants the
  // draw. Lazy initializer so it only evaluates once per mount, even under
  // StrictMode's double-invocation — the burn below is split into its own
  // effect specifically so that double-invocation can't eat the intro (an
  // initializer that both read AND wrote would see its own write on the
  // second StrictMode pass and never play in dev).
  const [wantsIntro] = useState(() => !heroIntroPlayedThisSession && !readHeroDrawSeen());

  // Burn (effect, on mount) — regardless of reduced motion, so "once per
  // install" stays literal: a reduced-motion user never gets a surprise
  // animation later just because this mount didn't play it.
  useEffect(() => {
    if (!wantsIntro) return;
    heroIntroPlayedThisSession = true;
    try {
      window.localStorage.setItem(HERO_DRAW_SEEN_KEY, "1");
    } catch {
      // Private mode / storage disabled — the module latch above already
      // blocks a replay within this session; a replay on the NEXT cold
      // private-mode open is accepted (specs/login-animation-moment-plan.md §6.3).
    }
  }, [wantsIntro]);

  const playIntro = wantsIntro && !reduceMotion;

  // Direct /sign-in or /sign-up visit while already signed in (AuthGate's
  // auth-route branch renders children unconditionally) — bounce home. When
  // mounted inline from AuthGate (signed-out on a non-auth route),
  // isSignedIn flips true and AuthGate itself swaps this component out for
  // children — nothing else to do there.
  useEffect(() => {
    if (isSignedIn) router.replace("/");
  }, [isSignedIn, router]);

  // Hero sizing: min(viewport width - 48, hero height - 96).
  useEffect(() => {
    function recompute() {
      const el = heroRef.current;
      if (!el) return;
      const w = window.innerWidth - 48;
      const h = el.clientHeight - 96;
      setHeroSize(Math.max(120, Math.min(w, h)));
    }
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, []);

  // Resend-cooldown countdown ticker.
  useEffect(() => {
    if (state.step !== "code" || !state.resendAvailableAt) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [state.step, state.resendAvailableAt]);

  const cooldownRemaining = state.resendAvailableAt
    ? Math.max(0, Math.ceil((state.resendAvailableAt - now) / 1000))
    : 0;

  const primaryPasswordLabel = state.intent === "signIn" ? "Sign in" : "Create account";

  const transition = reduceMotion ? { duration: 0 } : { duration: 0.15 };

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        fontFamily: T.sans,
      }}
    >
      {/* ── HERO — top ~62%, static, chrome-free, pointer-events none ── */}
      <div
        ref={heroRef}
        style={{
          height: "62dvh",
          flexShrink: 0,
          position: "relative",
          pointerEvents: "none",
        }}
      >
        <motion.div
          initial={playIntro ? { opacity: 0, y: 6 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: INTRO_HEADER.delay, duration: INTRO_HEADER.duration, ease: T.ease }}
          style={{
            position: "absolute",
            top: "max(14px, env(safe-area-inset-top))",
            right: 24,
            fontFamily: T.mono,
            fontSize: 8.5,
            letterSpacing: 1.8,
            textTransform: "uppercase",
            color: T.pencil,
          }}
        >
          NO 4 · PAR 5 · 548 YDS · HCP 1
        </motion.div>

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <HoleIllustration
            holeNumber={HERO_HOLE_NUMBER}
            variant="hero"
            playIntro={playIntro}
            showDetail
            accent={T.accent}
            size={heroSize}
          />
        </div>

        <motion.div
          initial={playIntro ? { opacity: 0, y: 6 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: INTRO_WORDMARK.delay, duration: INTRO_WORDMARK.duration, ease: T.ease }}
          style={{ position: "absolute", left: 24, bottom: 24 }}
        >
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 52,
              letterSpacing: -1,
              color: T.ink,
              lineHeight: 1,
            }}
          >
            Looper.
          </div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 8.5,
              letterSpacing: 1.8,
              textTransform: "uppercase",
              color: T.pencil,
              marginTop: 10,
            }}
          >
            Your yardage book
          </div>
        </motion.div>
      </div>

      {/* ── SHEET — bottom ~38%, steps swap inside ── */}
      <div
        style={{
          flexGrow: 1,
          background: T.paper,
          borderTop: `1px solid ${T.hairline}`,
          borderRadius: "20px 20px 0 0",
          padding: "20px 24px max(24px, env(safe-area-inset-bottom))",
          display: "flex",
          flexDirection: "column",
          // Short steps (email/code) have little content and otherwise pin to
          // the top, leaving a dead lower third. Centering composes them; the
          // taller `method` step (OAuth + divider + 2 buttons) fills enough
          // of the sheet that centering reads the same as top-aligned there.
          justifyContent: "center",
        }}
      >
        <motion.div
          initial={playIntro ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: INTRO_SHEET.delay, duration: INTRO_SHEET.duration, ease: T.ease }}
        >
        <AnimatePresence mode="wait" initial={false}>
          {state.step === "method" && (
            <motion.div
              key="method"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <OAuthButtons />

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1, height: 1, background: T.hairline }} />
                <span
                  style={{
                    fontFamily: T.mono,
                    fontSize: 11,
                    color: T.pencil,
                  }}
                >
                  or
                </span>
                <div style={{ flex: 1, height: 1, background: T.hairline }} />
              </div>

              <button type="button" onClick={flow.chooseEmail} style={hairlinePill}>
                Continue with email
              </button>

              <button type="button" onClick={flow.toggleIntent} style={quietLink}>
                {state.intent === "signIn" ? "New here? Create an account" : "Have an account? Sign in"}
              </button>
            </motion.div>
          )}

          {state.step === "email" && (
            <motion.div
              key="email"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <button type="button" onClick={flow.back} style={quietLink}>
                ‹ Back
              </button>

              <div>
                <label style={overLabel} htmlFor="auth-email">
                  Email
                </label>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={onFocusScroll}
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  aria-label="Email address"
                  placeholder="you@email.com"
                  className="auth-input"
                  style={underlineInput}
                />
              </div>

              {state.emailMethod === "password" && (
                <div>
                  <label style={overLabel} htmlFor="auth-password">
                    Password
                  </label>
                  <input
                    id="auth-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={onFocusScroll}
                    autoComplete={state.intent === "signIn" ? "current-password" : "new-password"}
                    aria-label="Password"
                    placeholder="Your password"
                    className="auth-input"
                    style={underlineInput}
                  />
                </div>
              )}

              {state.error && (
                <div role="status" aria-live="polite" style={errorLine}>
                  {state.error}
                </div>
              )}

              <button
                type="button"
                disabled={state.busy}
                onClick={() =>
                  state.emailMethod === "password"
                    ? flow.submitPassword(email, password)
                    : flow.sendCode(email)
                }
                style={{ ...primaryPill, opacity: state.busy ? 0.6 : 1 }}
              >
                {state.busy
                  ? "One moment…"
                  : state.emailMethod === "password"
                    ? primaryPasswordLabel
                    : "Email me a code"}
              </button>

              <button type="button" onClick={flow.toggleEmailMethod} style={quietLink}>
                {state.emailMethod === "password" ? "Email me a code instead" : "Use a password instead"}
              </button>
            </motion.div>
          )}

          {state.step === "code" && (
            <motion.div
              key="code"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <button type="button" onClick={flow.back} style={quietLink}>
                ‹ Back
              </button>

              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 11,
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                  color: T.pencil,
                }}
              >
                WE EMAILED A CODE TO {state.emailAddress}
              </div>

              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onFocus={onFocusScroll}
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Six-digit code"
                placeholder="000000"
                className="auth-input"
                style={{
                  ...underlineInput,
                  fontFamily: T.mono,
                  fontSize: 24,
                  letterSpacing: 6,
                  textAlign: "center",
                }}
              />

              {state.error && (
                <div role="status" aria-live="polite" style={errorLine}>
                  {state.error}
                </div>
              )}

              <button
                type="button"
                disabled={state.busy}
                onClick={() => flow.verifyCode(code)}
                style={{ ...primaryPill, opacity: state.busy ? 0.6 : 1 }}
              >
                {state.busy ? "One moment…" : "Verify"}
              </button>

              <button
                type="button"
                disabled={cooldownRemaining > 0 || state.busy}
                onClick={flow.resendCode}
                style={{ ...quietLink, opacity: cooldownRemaining > 0 ? 0.5 : 1 }}
              >
                {cooldownRemaining > 0 ? `Resend code (${cooldownRemaining}s)` : "Resend code"}
              </button>
            </motion.div>
          )}

          {state.step === "done" && (
            <motion.div
              key="done"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transition}
              style={{
                fontFamily: T.mono,
                fontSize: 11,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                color: T.pencil,
                textAlign: "center",
                padding: "12px 0",
              }}
            >
              You&apos;re in — one moment…
            </motion.div>
          )}
        </AnimatePresence>
        </motion.div>
      </div>

      {/* Inline styles can't target ::placeholder (no pseudo-element in the
          CSSProperties style prop) — a scoped styled-jsx rule is the smallest
          way to give the boxless underline inputs a findable placeholder
          without introducing a new styling approach. */}
      <style jsx>{`
        .auth-input::placeholder {
          color: ${T.pencilSoft};
          opacity: 1;
        }
      `}</style>
    </div>
  );
}
