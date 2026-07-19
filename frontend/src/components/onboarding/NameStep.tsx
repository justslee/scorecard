"use client";

/** Onboarding Step 1 — Name (required). specs/onboarding-shell-and-gate-plan.md §3. */

import { useState } from "react";
import {
  questionStyle,
  underlineInputStyle,
  primaryPillStyle,
  errorLineStyle,
  pillDisabledStyle,
  type StepWriteProps,
} from "./OnboardingFlow";

interface NameStepProps extends StepWriteProps {
  /** Prefilled from getHydratedGolferProfile()?.name — resume-safe. */
  initialValue: string;
  onContinue: (name: string) => void;
}

export default function NameStep({ initialValue, busy, error, onContinue }: NameStepProps) {
  const [value, setValue] = useState(initialValue);
  const disabled = busy || value.trim() === "";

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <div style={{ marginTop: "18vh", flex: 1 }}>
        <div style={questionStyle}>What should your caddie call you?</div>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Your name"
          autoComplete="given-name"
          aria-label="Your name"
          className="onboarding-input"
          style={{ ...underlineInputStyle, marginTop: 28 }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {error && (
          <div role="status" aria-live="polite" style={errorLineStyle}>
            {error}
          </div>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onContinue(value.trim())}
          style={{ ...primaryPillStyle, ...pillDisabledStyle(disabled) }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
