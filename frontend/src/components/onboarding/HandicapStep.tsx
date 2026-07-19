"use client";

/** Onboarding Step 2 — Handicap (optional; equal-weight not-sure path).
 *  specs/onboarding-shell-and-gate-plan.md §3. */

import { useState } from "react";
import {
  questionStyle,
  subLabelStyle,
  underlineInputStyle,
  primaryPillStyle,
  hairlinePillStyle,
  errorLineStyle,
  pillDisabledStyle,
  type StepWriteProps,
} from "./OnboardingFlow";

interface HandicapStepProps extends StepWriteProps {
  /** null = "I'm not sure" (explicit clear); a number = the parsed handicap. */
  onContinue: (handicap: number | null) => void;
}

/** [0, 54], one decimal place ok — matches the plan's validation contract. */
function parseHandicap(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,2}(\.\d)?$/.test(trimmed)) return null;
  const n = parseFloat(trimmed);
  if (isNaN(n) || n < 0 || n > 54) return null;
  return n;
}

export default function HandicapStep({ busy, error, onContinue }: HandicapStepProps) {
  const [raw, setRaw] = useState("");
  const parsed = parseHandicap(raw);
  const continueDisabled = busy || raw.trim() === "" || parsed === null;
  const notSureDisabled = busy;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <div style={{ marginTop: "18vh", flex: 1 }}>
        <div style={questionStyle}>What&apos;s your handicap?</div>
        <div style={subLabelStyle}>Roughly is fine — we&apos;ll refine it as you play.</div>
        <input
          type="text"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          inputMode="decimal"
          placeholder="12.4"
          aria-label="Your handicap"
          className="onboarding-input"
          style={{ ...underlineInputStyle, marginTop: 28, width: 120 }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {error && (
          <div role="status" aria-live="polite" style={errorLineStyle}>
            {error}
          </div>
        )}
        <button
          type="button"
          disabled={continueDisabled}
          onClick={() => parsed !== null && onContinue(parsed)}
          style={{ ...primaryPillStyle, ...pillDisabledStyle(continueDisabled) }}
        >
          Continue
        </button>
        <button
          type="button"
          disabled={notSureDisabled}
          onClick={() => onContinue(null)}
          style={{ ...hairlinePillStyle, ...pillDisabledStyle(notSureDisabled) }}
        >
          I&apos;m not sure — I don&apos;t have one
        </button>
      </div>
    </div>
  );
}
