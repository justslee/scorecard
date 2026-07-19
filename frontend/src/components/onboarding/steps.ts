// Pure, framework-free onboarding sub-step logic (unit-testable, no React,
// no fetch). specs/onboarding-shell-and-gate-plan.md §2.9.

import type { OnboardingStepState } from "@/lib/identity";

export type SubStep = "name" | "handicap" | "bag" | "intro";

export const SUB_STEP_ORDER: SubStep[] = ["name", "handicap", "bag", "intro"];

/** Server's last-COMPLETED step → the sub-step to show. 'done' → null (leave). */
export function initialSubStep(step: OnboardingStepState): SubStep | null {
  if (step === "done") return null;
  if (step === "name") return "handicap";
  if (step === "handicap") return "bag";
  if (step === "bag") return "intro";
  return "name"; // null / 'unknown'-shouldn't-reach / anything else → start
}

// F2 (login-onboarding-epic-polish-review §4) — `fetchAPI` (lib/api.ts) has
// no timeout, so a hung write (`updateGolferProfile` / `saveGolferBagAsync`)
// pins `busy` forever with no recovery. `withStallTimeout` races an awaited
// write against a timer and rejects on timeout, so it falls into the SAME
// existing catch block (SAVE_ERROR_COPY) the caller already has — zero new
// copy, zero new UI state. A late-resolving write is idempotent (same PUT
// payload replayed), so letting it keep running in the background is safe.
export const WRITE_STALL_TIMEOUT_MS = 15_000;

export function withStallTimeout<T>(p: Promise<T>, ms = WRITE_STALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stall-timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
