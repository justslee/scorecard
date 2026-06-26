# Progress log

The team writes here so work survives context resets and usage-limit pauses.
Format: date — done / in-progress / blocked.

## 2026-06-21
- **Done:** Phase 0 foundation — project `CLAUDE.md`, `.claude/settings.json` +
  `guard.sh` guardrail hook (tested), the 8-agent team in `.claude/agents/`,
  and a seeded `backlog.json`.
- **In progress (local, safe):** CI workflow, Playwright smoke tests, the limit
  governor, the release email/clip templates, and the `scorecard-ai-team.md`
  concept doc.
- **Blocked / awaiting owner go:** create the Notion board, enable Vercel
  previews + staging, GitHub branch protection on `main`, set the $50 usage-credit
  cap, and schedule the first (dry-run) routine.
- **First task when the loop starts:** `test-games-engine` (lowest risk).

## 2026-06-23
- **Plan pivot (approved):** secure, owner-only **native iOS beta** (TestFlight via
  Xcode Cloud) on **AWS** (RDS replaces Supabase), email approvals, **always-on**
  agent team on the EC2. Full plan: `~/.claude/plans/snazzy-sniffing-summit.md`.
- **Done:** Phase A2 — owner-only auth gate → **PR #24** (`feat/owner-only-auth-gate`).
  Discovery: `backend/app/db/engine.py` already uses a generic `DATABASE_URL`/asyncpg,
  so the backend is already RDS-ready — "dropping Supabase" is mainly a frontend + config change.
- **Next:** B1/A3 — relocate course CRUD to the backend over the DB, remove the client
  Supabase path + `NEXT_PUBLIC_SUPABASE_*`, and remove the browser Anthropic key (`ocr.ts`).
- **Owner-only (blocked on you):** AWS infra (RDS, Secrets Manager, IAM, ALB/ACM, CloudWatch),
  Apple/Xcode Cloud setup, rotate keys, `deploy/` + EC2 systemd units, Settings → Usage $50 cap.

### 2026-06-23 (later)
- Shipped **PR #25** (`feat/ocr-server-side`): scorecard OCR moved server-side, browser
  Anthropic key removed. Plus `.gitignore` hardened, `infra/looper-aws.yaml` CloudFormation
  drafted (owner reviews + applies; guardrail blocks `deploy/`), `release-manager` rewritten
  for the TestFlight/always-on loop, git-sync added to `eng-lead`/`builder`, `OWNER_SETUP.md` written.
- **Open PRs for owner review:** #24 (auth gate), #25 (OCR server-side), #26 (caddie client authed), #27 (dead apiKey removed).
- **Clean no-infra wins: DONE** (#24–#27). **Remaining is RDS-gated** (verify against the real
  backend, so do it after RDS is up): course CRUD → new `/api/courses/mapped` routes over RDS,
  then repoint `golf-api.ts` + `voice-parser.ts` (the backend parse-transcript returns a
  different shape — verify before swapping), then B3 static export. Then Capacitor (C).

## 2026-06-26
- **Done:** backlog `voice-nickname-jt` (priority 1) → **PR #47** (`fix/voice-nickname-jt`).
  Made the local score parser's explicit-pattern pass nickname-aware (`aliasesForPlayer`),
  with a collision guard so a real `JT` player isn't conflated with `Justin`. Fixes the last
  failing smoke case. Gates: **voice-tests 260/260**, tsc clean, build OK, no new lint.
  Minor change (no auth/data/endpoints/deps) — eng-lead ran an adversarial reviewer pass; not
  pinging owner. **Follow-up:** promote voice-tests to a *required* CI gate (separate PR).
- **Next ready backlog items:** `test-games-engine` (P2), `test-voice-pipeline` (P3),
  `frontend-lint-cleanup` (P9), `tee-time-finder` Phase 1 (P8). Several majors need specs.
