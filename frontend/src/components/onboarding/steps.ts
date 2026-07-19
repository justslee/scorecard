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
