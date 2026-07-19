"use client";

/**
 * OnboardingFlow — the resumable first-run onboarding shell + state machine
 * (specs/onboarding-shell-and-gate-plan.md §2.10/§3). Loaded client-only via
 * app/onboarding/page.tsx's dynamic() (SignInClient pattern) so it never runs
 * at static-export prerender.
 *
 * Quiet, yardage-book UX — no card chrome, no step numbers, no "wizard"
 * framing: an oversize serif-italic question, an underline input, and a
 * scorecard-row hairline tick strip. Every step AWAITS its server write
 * before advancing, so a force-quit mid-flow resumes exactly where the
 * server says (steps.ts's initialSubStep).
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { useMe, publishOnboardingStep, getHydratedGolferProfile } from "@/lib/identity";
import { updateGolferProfile } from "@/lib/api";
import { saveGolferBagAsync } from "@/lib/storage-api";
import type { GolferProfile } from "@/lib/types";
import { initialSubStep, SUB_STEP_ORDER, type SubStep } from "./steps";
import NameStep from "./NameStep";
import HandicapStep from "./HandicapStep";
import BagStep from "./BagStep";
import MeetCaddieStep from "./MeetCaddieStep";

/** Copy shown under the buttons on a failed write — the user stays put. */
export const SAVE_ERROR_COPY = "Couldn't save — check your connection and try again.";

const KICKER_FOR_STEP: Record<SubStep, string> = {
  name: "INTRODUCTIONS",
  handicap: "YOUR GAME",
  bag: "THE BAG",
  intro: "ONE LAST THING",
};

// ── Shared step styles (yardage/tokens.ts values only — no new design language,
//    mirrors SignInScreen.tsx's local style-const pattern). Exported so the 4
//    step components share one exact look. ──────────────────────────────────
export const questionStyle: CSSProperties = {
  fontFamily: T.serif,
  fontStyle: "italic",
  fontSize: 34,
  letterSpacing: -0.8,
  lineHeight: 1.12,
  color: T.ink,
};

export const subLabelStyle: CSSProperties = {
  fontFamily: T.sans,
  fontSize: 13,
  color: T.inkSoft,
  lineHeight: 1.5,
  marginTop: 10,
};

export const underlineInputStyle: CSSProperties = {
  width: "100%",
  fontFamily: T.serif,
  fontSize: 24,
  color: T.ink,
  background: "transparent",
  border: "none",
  borderBottom: `1px solid ${T.hairline}`,
  borderRadius: 0,
  padding: "6px 0",
  outline: "none",
};

const pillBase: CSSProperties = {
  height: 52,
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

export const primaryPillStyle: CSSProperties = {
  ...pillBase,
  background: T.ink,
  color: T.paper,
};

export const hairlinePillStyle: CSSProperties = {
  ...pillBase,
  background: "transparent",
  color: T.inkSoft,
  border: `1px solid ${T.hairline}`,
};

export const errorLineStyle: CSSProperties = {
  fontFamily: T.mono,
  fontSize: 10,
  letterSpacing: 0.6,
  color: T.errorInk,
};

export function pillDisabledStyle(disabled: boolean): CSSProperties {
  return disabled ? { opacity: 0.35 } : {};
}

/** Every step component gets the same write-state props. */
export interface StepWriteProps {
  busy: boolean;
  error: string | null;
}

/** Calm paper placeholder — matches SignInClient's PaperShell — shown while
 *  onboardingStep is 'unknown' or the initial sub-step hasn't resolved yet. */
function LoadingShell() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "max(14px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom))",
        fontFamily: T.sans,
      }}
    >
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 44,
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
          color: T.pencil,
          textTransform: "uppercase",
          marginTop: 10,
        }}
      >
        Getting set up
      </div>
    </div>
  );
}

/** Scorecard-row hairline tick strip — 4 segments evoking scorecard column
 *  separators. `index` is the CURRENT sub-step's position (0-3). */
function ProgressTicks({ index }: { index: number }) {
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
      {SUB_STEP_ORDER.map((step, i) => {
        const color = i < index ? T.ink : i === index ? T.accent : T.hairline;
        return (
          <div key={step} style={{ position: "relative", width: 22, height: 4 }}>
            <div style={{ position: "absolute", left: 0, top: 1, width: 1, height: 3, background: color }} />
            <div style={{ position: "absolute", left: 0, top: 3, width: 22, height: 1, background: color }} />
          </div>
        );
      })}
    </div>
  );
}

export default function OnboardingFlow() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const { userId, onboardingStep } = useMe();

  const [subStep, setSubStep] = useState<SubStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  // Initialize the sub-step ONCE from the hydrated server step — no route
  // chain, no second fetch in the normal path (the plan's §1.1 contract).
  useEffect(() => {
    if (onboardingStep === "unknown") return;
    if (initializedRef.current) return;
    initializedRef.current = true;

    const initial = initialSubStep(onboardingStep);
    if (initial === null) {
      // Already 'done' — a done user deep-linked to /onboarding. Bounce home.
      router.replace("/");
      return;
    }
    setSubStep(initial);
  }, [onboardingStep, router]);

  const advanceTo = useCallback((next: SubStep) => {
    setError(null);
    setSubStep(next);
  }, []);

  const handleName = useCallback(
    async (name: string) => {
      setBusy(true);
      setError(null);
      try {
        await updateGolferProfile({ name, onboardingStep: "name" });
        if (userId) publishOnboardingStep(userId, "name");
        advanceTo("handicap");
      } catch {
        setError(SAVE_ERROR_COPY);
      } finally {
        setBusy(false);
      }
    },
    [userId, advanceTo],
  );

  const handleHandicap = useCallback(
    async (handicap: number | null) => {
      setBusy(true);
      setError(null);
      try {
        await updateGolferProfile({ handicap, onboardingStep: "handicap" });
        if (userId) publishOnboardingStep(userId, "handicap");
        advanceTo("bag");
      } catch {
        setError(SAVE_ERROR_COPY);
      } finally {
        setBusy(false);
      }
    },
    [userId, advanceTo],
  );

  const handleBag = useCallback(
    async (clubDistances: GolferProfile["clubDistances"] | null) => {
      setBusy(true);
      setError(null);
      try {
        if (clubDistances) {
          await saveGolferBagAsync(clubDistances);
        }
        await updateGolferProfile({ onboardingStep: "bag" });
        if (userId) publishOnboardingStep(userId, "bag");
        advanceTo("intro");
      } catch {
        setError(SAVE_ERROR_COPY);
      } finally {
        setBusy(false);
      }
    },
    [userId, advanceTo],
  );

  const handleDone = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await updateGolferProfile({ onboardingStep: "done" });
      if (userId) publishOnboardingStep(userId, "done");
      router.replace("/");
    } catch {
      setError(SAVE_ERROR_COPY);
    } finally {
      setBusy(false);
    }
  }, [userId, router]);

  if (!subStep) {
    return <LoadingShell />;
  }

  const profile = getHydratedGolferProfile();
  const currentIndex = SUB_STEP_ORDER.indexOf(subStep);
  const transition = reduceMotion ? { duration: 0 } : { duration: 0.2, ease: T.ease };
  const motionProps = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: 8 },
      };

  return (
    <div
      style={{
        // Bounded (not minHeight) so the Bag step's internal list is the
        // ONLY thing that scrolls — a growing page (minHeight) let the whole
        // viewport stretch past the buttons on short screens (designer
        // BLOCKING finding). Steps 1/2/4 have short content and fit
        // comfortably within one viewport, so this is a no-op for them.
        height: "100dvh",
        overflow: "hidden",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        display: "flex",
        flexDirection: "column",
        padding: "max(24px, env(safe-area-inset-top)) 28px max(28px, env(safe-area-inset-bottom))",
        fontFamily: T.sans,
      }}
    >
      <div
        style={{
          maxWidth: 340,
          width: "100%",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 8.5,
            letterSpacing: 1.8,
            textTransform: "uppercase",
            color: T.pencil,
            marginBottom: 10,
          }}
        >
          {KICKER_FOR_STEP[subStep]}
        </div>
        <ProgressTicks index={currentIndex} />

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={subStep}
            {...motionProps}
            transition={transition}
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
          >
            {subStep === "name" && (
              <NameStep initialValue={profile?.name ?? ""} busy={busy} error={error} onContinue={handleName} />
            )}
            {subStep === "handicap" && (
              <HandicapStep busy={busy} error={error} onContinue={handleHandicap} />
            )}
            {subStep === "bag" && <BagStep busy={busy} error={error} onContinue={handleBag} />}
            {subStep === "intro" && <MeetCaddieStep busy={busy} error={error} onContinue={handleDone} />}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Global (not scoped) so the step components' own .onboarding-input
          elements — rendered from separate files — pick up the placeholder
          color. Same technique as SignInScreen.tsx's .auth-input rule. */}
      <style jsx global>{`
        .onboarding-input::placeholder {
          color: ${T.pencilSoft};
          opacity: 1;
        }
      `}</style>
    </div>
  );
}
