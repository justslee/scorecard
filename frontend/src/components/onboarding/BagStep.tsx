"use client";

/** Onboarding Step 3 — Bag (defaults pre-filled, skippable).
 *  specs/onboarding-shell-and-gate-plan.md §3.
 *
 *  Reuses the exact CLUB_CONFIG list from the profile Bag editor (no
 *  duplication) and DEFAULT_BAG_CAMEL (lib/caddie/clubs.ts) for sensible
 *  pre-fills, so a first-run golfer can accept-and-move-on.
 */

import { useState } from "react";
import { T } from "@/components/yardage/tokens";
import { CLUB_CONFIG } from "@/app/profile/page";
import type { ClubKey } from "@/app/profile/page";
import { DEFAULT_BAG_CAMEL } from "@/lib/caddie/clubs";
import type { GolferProfile } from "@/lib/types";
import {
  questionStyle,
  subLabelStyle,
  primaryPillStyle,
  hairlinePillStyle,
  errorLineStyle,
  pillDisabledStyle,
  type StepWriteProps,
} from "./OnboardingFlow";

interface BagStepProps extends StepWriteProps {
  /** null = skip (clubDistances stays {}). */
  onContinue: (clubDistances: GolferProfile["clubDistances"] | null) => void;
}

function initialDraft(): Record<ClubKey, string> {
  const draft = {} as Record<ClubKey, string>;
  for (const { key } of CLUB_CONFIG) {
    const v = DEFAULT_BAG_CAMEL[key];
    draft[key] = v != null ? String(v) : "";
  }
  return draft;
}

export default function BagStep({ busy, error: writeError, onContinue }: BagStepProps) {
  const [draft, setDraft] = useState<Record<ClubKey, string>>(initialDraft);
  const [validationError, setValidationError] = useState<string | null>(null);

  const error = validationError ?? writeError;

  function handleUseThese() {
    const clubDistances: GolferProfile["clubDistances"] = {};
    for (const { key, label } of CLUB_CONFIG) {
      const raw = (draft[key] ?? "").trim();
      if (raw === "") continue; // leave key absent — same as the profile Bag editor
      const n = Math.round(parseFloat(raw));
      if (isNaN(n) || n <= 0 || n > 500) {
        setValidationError(`Invalid distance for ${label}`);
        return;
      }
      clubDistances[key] = n;
    }
    setValidationError(null);
    onContinue(clubDistances);
  }

  function handleSkip() {
    setValidationError(null);
    onContinue(null);
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ marginBottom: 4 }}>
        <div style={questionStyle}>What&apos;s in the bag?</div>
        <div style={subLabelStyle}>Carry yardages — so your caddie knows your game. Close is good enough.</div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", marginTop: 14, minHeight: 0 }}>
        {CLUB_CONFIG.map(({ key, label }, i) => (
          <div
            key={key}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              alignItems: "center",
              minHeight: 40,
              borderTop: i === 0 ? "none" : `1px solid ${T.hairlineSoft}`,
            }}
          >
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                color: T.pencil,
              }}
            >
              {label}
            </div>
            <input
              type="text"
              inputMode="numeric"
              value={draft[key] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              placeholder="—"
              aria-label={label}
              className="onboarding-input"
              style={{
                width: 64,
                textAlign: "right",
                fontFamily: T.serif,
                fontSize: 17,
                color: T.ink,
                background: "transparent",
                border: "none",
                borderBottom: `1px solid ${T.hairline}`,
                borderRadius: 0,
                padding: "6px 0",
                outline: "none",
              }}
            />
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          paddingTop: 14,
          marginTop: 10,
          borderTop: `1px solid ${T.hairline}`,
        }}
      >
        {error && (
          <div role="status" aria-live="polite" style={errorLineStyle}>
            {error}
          </div>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={handleUseThese}
          style={{ ...primaryPillStyle, ...pillDisabledStyle(busy) }}
        >
          Use these
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={handleSkip}
          style={{ ...hairlinePillStyle, ...pillDisabledStyle(busy) }}
        >
          Skip — set up later
        </button>
      </div>
    </div>
  );
}
