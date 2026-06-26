# Scorecard — Project Guide for Claude

Mobile-first, voice-driven golf app. Next.js 16 frontend (Vercel) + FastAPI
backend. See @tasks/todo.md for the autonomous AI-team build plan and
@scorecard-ai-team.md for how the team operates.

## Commands (agents can't guess these)
- Frontend dev: `cd frontend && npm run dev` (http://localhost:3000)
- Build: `cd frontend && npm run build`  ·  Lint: `cd frontend && npm run lint`
- Typecheck: `cd frontend && npx tsc --noEmit`
- Voice regression tests (deterministic, offline — a CI gate):
  `cd frontend && npx tsx voice-tests/runner.ts --smoke`
- Backend dev: `cd backend && uv sync && python -m uvicorn app.main:app --reload` (:8000)
- Backend lint: `cd backend && ruff check .`

## Architecture (where things live)
- Types source of truth: `frontend/src/lib/types.ts` + `backend/app/models.py` — keep in sync
- Voice pipeline: `frontend/src/lib/voice/*` (Zod schemas + heuristics + repair loop)
- Games engine: `frontend/src/lib/games.ts` (15 formats; isolated — safe to extend with tests)
- Caddie: `frontend/src/components/CaddiePanel.tsx` + `backend/app/caddie/*`
- Course / GolfAPI: `frontend/src/lib/golf-api.ts` + `backend/app/routes/golf.py`
- Backend storage = JSON files in `backend/data/` (no real DB yet)

## Conventions
- TypeScript strict. Match the surrounding code's style, naming, and comment density.
- Follow patterns in neighboring files; don't add dependencies without a real need.
- Keep `types.ts` and `models.py` consistent whenever you touch shared shapes.

## Workflow rules (IMPORTANT)
- Work on ONE feature at a time. Commit after each with a descriptive message.
- After changes, run lint + typecheck + voice-tests smoke. Don't declare done until they pass.
- NEVER push to `main`. Branch + open a PR. A human approves every merge.
- Update `tasks/progress.md` (done / in-progress / blocked) before ending a session,
  so work survives context resets and usage-limit pauses.
- Verify before done: show evidence (test output, screenshot) — don't assert success.
- Major changes (auth, data handling, new endpoints or dependencies, or any new
  user-facing capability) MUST pass the `/security-review` skill (and `/code-review`)
  before the PR is marked ready — fold in the findings or fix them.

## Do NOT touch (also enforced by .claude/hooks/guard.sh)
- `**/.env*` (secrets), `deploy/**` (prod infra), `backend/supabase/migrations/**`
- Never force-push; never push to `main`; never edit or delete tests to make them pass.
