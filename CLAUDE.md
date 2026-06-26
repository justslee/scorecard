# Looper — Project Guide for Claude

Looper is a mobile-first, voice-driven golf app. Next.js 16 frontend + FastAPI backend.

## Northstar & design (READ FIRST)
Every change MUST follow @NORTHSTAR.md — the product Northstar and the yardage-book design
foundation. Match the existing voice-first, calm, on-paper feel; never drift into generic
SaaS/dashboard UI. The `designer` agent reviews every user-facing change against it.

See @tasks/todo.md for the build plan and @ops/mac/RUN.md for how the team runs.

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
- **Bundle to ship (2026-06-26).** The unit of a PR is a **material change the owner would
  notice on a new TestFlight build** — NOT one item. All work accumulates on one rolling
  branch `integration/next` (one open PR → `main`). The owner is asked to approve only when
  that bundle contains ≥1 noticeable change; silent work (tests/refactors/infra/docs/deps)
  rides along and merges with it. Approval **alert** = email from a **dedicated approvals
  account** (`looper.approvals@gmail.com`) to the owner's personal address — never his personal inbox;
  the **Notion board** ("Looper — Product Board") is the record. Owner replies "ship it" by
  email (watched in the dedicated mailbox) or on the card. (A Notion @-mention can't notify —
  the MCP is authed as the owner.) See `.claude/agents/eng-lead.md`.
- **Notifications: rare by design.** Push the owner (phone, via Remote Control) only for
  (a) a noticeable-bundle **approval request**, (b) a **massive bundle or a major backend
  change the owner can test** (e.g. a deployed API/data-layer change he can hit on staging —
  ping with how to test it), or (c) a genuine **blocker / product decision**.
  NEVER push for routine progress: small silent merges, per-item completion, gate runs, or
  status. Routine silent work just appears on the board — no ping.
- NEVER push to `main`. A human approves every merge (now in noticeable-sized bundles).
- Update `tasks/progress.md` (done / in-progress / blocked) before ending a session,
  so work survives context resets and usage-limit pauses.
- Verify before done: show evidence (test output, screenshot) — don't assert success.
- Major changes (auth, data handling, new endpoints or dependencies, or any new
  user-facing capability) MUST pass the `/security-review` skill (and `/code-review`)
  before the PR is marked ready — fold in the findings or fix them.

## Do NOT touch (also enforced by .claude/hooks/guard.sh)
- `**/.env*` (secrets), `deploy/**` (prod infra), `backend/supabase/migrations/**`
- Never force-push; never push to `main`; never edit or delete tests to make them pass.
