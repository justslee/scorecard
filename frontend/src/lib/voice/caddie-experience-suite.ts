/**
 * The named "caddie-experience" suite (specs/caddie-experience-harness-plan.md
 * §1) — a single-source-of-truth manifest of every test file that measures
 * the owner's eight caddie-experience dimensions (see the dimension table in
 * the root CADDIE_EXPERIENCE.md and specs/caddie-experience-harness-plan.md
 * §0):
 *
 *   1 no dupes · 2 smart caddie · 3 flowing conversation · 4 non-robotic
 *   voice · 5 consistency · 6 reliability · 7 minimal loading · 8
 *   well-integrated
 *
 * `file` is a REPO-ROOT-relative path (not frontend-relative) — dims 2/4/5
 * are measured entirely on the backend (`backend/tests/eval/`), so this
 * manifest spans both stacks. `caddie-experience-suite.test.ts`'s manifest
 * guard existence-checks every entry (frontend AND backend) relative to the
 * repo root; `vitest.caddie-experience.config.ts` filters to just the
 * `frontend/`-prefixed entries for its runnable `include` list (a `.py` path
 * obviously isn't a vitest test file). This is what makes suite MEMBERSHIP
 * falsifiable — a renamed/deleted file fails the guard by naming the exact
 * missing path; a dimension that loses all its coverage fails the guard too
 * (see caddie-experience-suite.test.ts's RED-proof comment).
 *
 * Not chosen (plan §1): a mega test file importing other test files (breaks
 * per-file env docblocks like `// @vitest-environment jsdom`); bare
 * name-pattern glob args to vitest (silent no-match drift if a file is
 * renamed) — the manifest + its guard test is what makes membership
 * falsifiable instead of assumed.
 */

export interface CaddieExperienceSuiteEntry {
  /** Repo-root-relative path, e.g. "frontend/src/lib/voice/foo.test.ts" or
   *  "backend/tests/eval/test_foo.py". */
  file: string;
  /** Which of the eight caddie-experience dimensions (1-8) this file measures. */
  dimensions: number[];
}

export const CADDIE_EXPERIENCE_SUITE: CaddieExperienceSuiteEntry[] = [
  // ── Frontend — realtime transport + voice-pipeline unit suites ──────────
  { file: "frontend/src/lib/voice/realtime-attribution.test.ts", dimensions: [1, 6] },
  { file: "frontend/src/lib/voice/realtime-dispatch.test.ts", dimensions: [8] },
  { file: "frontend/src/lib/voice/realtime-lifecycle.test.ts", dimensions: [6] },
  // NEW (specs/caddie-live-p0-connect-hole-plan.md §4) — Bug A: the
  // pre-connect connect state machine (stall -> retry -> connect-failed,
  // mic-deny, dead-warm, telemetry).
  { file: "frontend/src/hooks/useCaddieLiveSession.connect.test.tsx", dimensions: [6] },
  { file: "frontend/src/lib/voice/realtime-noinput.test.ts", dimensions: [1, 3] },
  { file: "frontend/src/lib/voice/realtime-ordering.test.ts", dimensions: [1, 3] },
  { file: "frontend/src/lib/voice/realtime-warm.test.ts", dimensions: [6, 7] },
  { file: "frontend/src/lib/voice/warm-session.test.ts", dimensions: [6, 7] },
  { file: "frontend/src/lib/voice/priming-echo.test.ts", dimensions: [1] },
  { file: "frontend/src/lib/voice/caddie-turn-timing.test.ts", dimensions: [7] },
  { file: "frontend/src/lib/voice/telemetry.test.ts", dimensions: [7] },
  { file: "frontend/src/lib/voice/idle-timer.test.ts", dimensions: [6] },
  { file: "frontend/src/lib/voice/noinput-clarifier.test.ts", dimensions: [3, 6] },

  // ── Frontend — components ────────────────────────────────────────────
  // The ONE shared caddie/user turn primitive (specs/caddie-transcript-
  // render-unify-plan.md) every live surface renders through — order-as-
  // given/no-dedup/no-re-key invariants (dim 1) + the calm flowing-
  // conversation idiom (dim 3, dim 8 well-integrated across surfaces).
  { file: "frontend/src/components/yardage/Transcript.test.tsx", dimensions: [3, 8] },
  { file: "frontend/src/components/CaddieSheet.realtime.test.tsx", dimensions: [1, 3, 6] },
  { file: "frontend/src/components/CaddieOrbSheet.test.tsx", dimensions: [3, 8] },
  { file: "frontend/src/components/CaddieSheet.handsfree.test.tsx", dimensions: [3, 6] },
  // NEW (this plan, §4) — glitches BETWEEN turns already had coverage above;
  // this file covers a drop/hole-change WHILE an assistant answer streams.
  { file: "frontend/src/components/CaddieSheet.realtime-glitch.test.tsx", dimensions: [1, 6] },

  // ── Backend — dims measured only in backend/tests/eval (2 smart caddie,
  // 4 non-robotic voice, 5 consistency) — see backend/tests/eval/README.md ──
  { file: "backend/tests/eval/test_golden_tier1.py", dimensions: [2, 3] },
  { file: "backend/tests/eval/test_realtime_session_config.py", dimensions: [4] },
  { file: "backend/tests/eval/test_substance_teeth.py", dimensions: [5] },
  // NEW (caddie-advice-stability-tee-shot-plan.md §3.8) — DECISION_GROUNDING_RULE
  // pins the club CALL to the engine's decision (dim 2 smart caddie) and is the
  // direct fix for the 2026-07-15 recommendation-flip consistency defect (dim 5).
  { file: "backend/tests/test_decision_grounding_prompt.py", dimensions: [2, 5] },
];
