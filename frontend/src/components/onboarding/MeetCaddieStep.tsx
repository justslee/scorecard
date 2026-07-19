"use client";

// Onboarding Step 4 — Meet your caddie (the REAL voice moment).
// specs/onboarding-voice-first-intro-plan.md (Slice 6), approach (A).
//
// The hinge step where onboarding stops being a form and proves the product
// before Home. This screen is a serif INVITATION composed toward the real
// production CaddieOrb — which is already on screen bottom-right on
// /onboarding (shouldShowCaddieOrb SHOW_EXACT). The golfer uses the orb's
// EXACT production gestures (tap = talk; hold = full chat sheet) to run the
// LIVE caddie session, grounded server-side in the bag they entered two steps
// ago (Slice 5). So "How far does my 7-iron go?" answers with THEIR number.
//
// Deliberately renders NO orb, NO mic button, and calls NO openLooper itself
// (the one standardized invocation is the real orb — never a bespoke mic, per
// the omnipresent-orb product rule). It only listens, read-only, to the orb
// state channel to know when the golfer has actually talked, so it can offer
// the "Open your book" finish. Both "Maybe later" and "Open your book" go
// through the SAME onContinue (OnboardingFlow.handleDone: PUT
// {onboardingStep:'done'} -> publish -> replace('/')) — never a dead end, even
// if the mic is denied (the production deny path surfaces the full sheet's
// error line; the golfer closes it and "Maybe later" is still there).

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { T } from "@/components/yardage/tokens";
import { getCaddieOrbState, onCaddieOrbState, type CaddieOrbState } from "@/lib/caddie-context";
import {
  questionStyle,
  subLabelStyle,
  primaryPillStyle,
  errorLineStyle,
  pillDisabledStyle,
  type StepWriteProps,
} from "./OnboardingFlow";

interface MeetCaddieStepProps extends StepWriteProps {
  onContinue: () => void;
}

/** Quiet, illustrative asks — NOT tappable (the real orb is the only
 *  invocation). The first is the magic-moment ask: it answers with the
 *  golfer's own just-entered 7-iron carry. Designer owns final copy. */
const EXAMPLE_ASKS = [
  "How far does my 7-iron go?",
  "What club for 150 to a back pin?",
  "Find me a tee time Saturday morning.",
];

export default function MeetCaddieStep({ busy, error, onContinue }: MeetCaddieStepProps) {
  const reduceMotion = useReducedMotion();

  // Read-only: flip true the first time the mic is actually HOT ('listening',
  // never 'connecting' — a denied mic never reaches 'listening', so a failed
  // attempt never reveals the finish pill; the golfer exits via "Maybe later"
  // instead). Module-level pub-sub, SSR-inert (no window). Handles the orb
  // already listening at mount.
  const [hasSpoken, setHasSpoken] = useState(false);
  useEffect(() => {
    const mark = (s: CaddieOrbState) => {
      if (s === "listening") setHasSpoken(true);
    };
    mark(getCaddieOrbState());
    return onCaddieOrbState(mark);
  }, []);

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      {/* Smaller top margin than the earlier steps (their 18vh) — this step
          carries more content (invitation + sub-line + three asks) and must
          still fit 375x667 inside OnboardingFlow's bounded height:100dvh /
          overflow:hidden container without pushing the CTAs off-screen. */}
      <div style={{ marginTop: "6vh" }}>
        <div style={questionStyle}>Ask your caddie anything.</div>
        <div style={{ ...subLabelStyle, maxWidth: 300, lineHeight: 1.55 }}>
          Tap the mark in the corner and just talk — it already knows your bag.
          Hold it for the full chat.
        </div>

        <div style={{ marginTop: 30 }}>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 8.5,
              letterSpacing: 1.8,
              textTransform: "uppercase",
              color: T.pencil,
              marginBottom: 12,
            }}
          >
            Try
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {EXAMPLE_ASKS.map((ask) => (
              <div
                key={ask}
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 18,
                  lineHeight: 1.3,
                  color: T.inkSoft,
                }}
              >
                &ldquo;{ask}&rdquo;
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Spacer pushes the CTA block to the bottom; the extra bottom clearance
          keeps the finish pill above the real orb's bottom-right footprint. */}
      <div style={{ flex: 1, minHeight: 24 }} />

      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 56 }}>
        {error && (
          <div role="status" aria-live="polite" style={errorLineStyle}>
            {error}
          </div>
        )}

        {hasSpoken ? (
          // Appears only after the golfer has actually talked to the caddie —
          // the clear "you've met, now go in" finish. Fade-in unless reduced
          // motion (then it just appears).
          <motion.button
            type="button"
            disabled={busy}
            onClick={onContinue}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.25, ease: T.ease }}
            style={{ ...primaryPillStyle, ...pillDisabledStyle(busy) }}
          >
            Open your book
          </motion.button>
        ) : (
          // Always present + enabled from the first render (never gated on
          // hasSpoken) — voice-first, but tapping-out is never a dead end.
          // Quiet, left-aligned, not guilt-y.
          <button
            type="button"
            disabled={busy}
            onClick={onContinue}
            style={{
              alignSelf: "flex-start",
              background: "transparent",
              border: "none",
              // Generous invisible hit padding (≥44px tall) for a one-handed,
              // possibly-gloved, on-course tap — cancelled by the negative
              // margin so the visual size/position is unchanged (Northstar).
              padding: "14px 8px",
              margin: "-14px -8px",
              fontFamily: T.sans,
              fontSize: 13,
              color: T.pencil,
              cursor: "pointer",
              WebkitAppearance: "none",
              ...pillDisabledStyle(busy),
            }}
          >
            Maybe later
          </button>
        )}
      </div>
    </div>
  );
}
