import { mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';
import { CADDIE_EXPERIENCE_SUITE } from './src/lib/voice/caddie-experience-suite';

// Named "caddie-experience" gate (specs/caddie-experience-harness-plan.md
// §1): runs ONLY the frontend files listed in the manifest (backend .py
// entries in the same manifest are documentation/existence-checked only —
// they run via `cd backend && uv run pytest tests/eval`, not vitest).
//
// This file inherits everything else from vitest.config.ts (the `@` alias,
// environment default) via mergeConfig for zero drift — BUT vite/vitest's
// mergeConfig CONCATENATES array fields rather than replacing them (verified
// empirically: `mergeConfig({include:['a']}, {include:['b']})` ->
// `{include:['a','b']}`), so `test.include` is force-set AFTER the merge to
// exactly the suite's list — otherwise this config would silently inherit
// the base's `src/**/*.test.ts` glob too and run the ENTIRE suite, defeating
// the whole point of a focused gate.
const FRONTEND_PREFIX = 'frontend/';
const suiteInclude = CADDIE_EXPERIENCE_SUITE.filter((entry) => entry.file.startsWith(FRONTEND_PREFIX)).map(
  (entry) => entry.file.slice(FRONTEND_PREFIX.length),
);

const config = mergeConfig(baseConfig, { test: { include: suiteInclude } });
config.test = { ...config.test, include: suiteInclude };

export default config;
