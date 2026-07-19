"use client";

// SLICE-6 SEAM (onboarding-voice-first-intro): this static screen is replaced by
// the real voice moment — openLooper({ context: "general", listening: true,
// presentation: "full" }) from lib/looper-bus.ts — keeping this step's
// PUT {onboardingStep:'done'} → publish → replace('/') completion contract
// intact.

/** Onboarding Step 4 — Meet your caddie (PLACEHOLDER).
 *  specs/onboarding-shell-and-gate-plan.md §3.
 *
 *  The REAL production orb is already on screen bottom-right (via the
 *  shouldShowCaddieOrb change; idle, no pulse, intro chips deferred) — this
 *  step deliberately does NOT render a second orb or any bespoke mic UI.
 */

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

export default function MeetCaddieStep({ busy, error, onContinue }: MeetCaddieStepProps) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <div style={{ marginTop: "18vh", flex: 1 }}>
        <div style={questionStyle}>Meet your caddie.</div>
        <div style={{ ...subLabelStyle, maxWidth: 300, lineHeight: 1.55 }}>
          That quiet dot in the corner is your caddie. Tap it any time — reading a shot, picking a
          course, settling a bet. It&apos;s already looking after your book.
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {error && (
          <div role="status" aria-live="polite" style={errorLineStyle}>
            {error}
          </div>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onContinue}
          style={{ ...primaryPillStyle, ...pillDisabledStyle(busy) }}
        >
          Open your book
        </button>
      </div>
    </div>
  );
}
