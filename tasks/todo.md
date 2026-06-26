# Scorecard AI Engineering Team — Build Plan

## Goal
Stand up an always-on, self-improving team of Claude agents that move Scorecard
forward autonomously. The owner (CEO) stays hands-off: when a **major feature**
is ready he gets an email with a clip + a link to a **live, playable build**,
plays with it on his phone, and replies "ship it" (or redirects). Minor work
ships silently. He is only pinged for major features or a genuine decision.

## Locked decisions (2026-06-21)
- **Autonomy: PR-gated.** Agents branch + open PRs; they NEVER push to `main`.
  Nothing reaches production without the owner's approval.
- **Budget: Max $100 (5x) subscription + small capped overflow.** No per-token
  billing on the subscription path; the team runs on the subscription/Cowork path
  (programmatic paths — Agent SDK / `claude -p` / GitHub Actions — meter at API
  rates, so we avoid them for the agent loop). "Usage credits" ENABLED with a
  **$50/mo cap, auto-reload OFF**: subscription quota first, then ≤$50 API-rate
  overflow to finish high-value work, then hard-stop. Model tiering: Haiku
  (triage/tests/digests) · Sonnet (builder/PM/release) · Opus
  (architecture/review/security/retro).
- **Command center: Notion.** Board (Backlog → In Progress → Needs Review →
  Shipped) + the always-on record. GitHub PRs are the technical source of truth.
- **Delivery + notifications: email, immediate, major-only.**
  - The artifact the owner receives is a **playable live app**, not a PR.
  - Channel = **Gmail** (already connected). Timing = **immediate when playable**.
  - **Major feature** → email with a ~15s screen clip + "▶ Open live app" button
    + permanent staging link. Approve by replying in plain English; an agent
    reads the reply and promotes to prod or iterates.
  - **Minor change** (tests, refactors, dep bumps, copy, small UX) → silent merge
    to staging, no email; visible in the staging app + Notion board.
  - Urgent push (blocked / needs a product decision) → phone push, reserved.

## Locked decisions (2026-06-26)
- **PR unit = a TestFlight-noticeable change, not one item.** To stop frequent approvals,
  all work accumulates on ONE rolling branch `integration/next` (one open PR → `main`).
  Each item is classified **noticeable** (user-visible on TestFlight) or **silent**
  (tests/refactors/infra/docs/deps). The owner is asked to approve only when the bundle
  contains ≥1 noticeable change; silent work rides along and merges with it. The owner's
  single "ship it" approves the whole bundle, then a fresh `integration/next` is cut.
- **Approval alert = Claude Code push; record/reply = Notion board.** Notion CANNOT push the
  owner — the Notion MCP is authed AS the owner's own account, so an @-mention is a
  self-mention and Notion suppresses it (verified 2026-06-26: test mention sent no
  notification). So the *buzz* goes via `PushNotification` (reaches the phone once **Remote
  Control** is paired — `claude remote-control`, scan QR in the Claude mobile app, enable push
  in `/config`). The "Looper — Product Board" (`28cd03a5-3b70-4191-a07d-5017b133051d`) card is
  the durable record + reply thread; owner replies "ship it" in the session or on the card
  (polled via get-comments). Gmail is a fallback (needs one-time OAuth; email-to-self DOES
  deliver, unlike a Notion self-mention).

## Delivery model (how "go play with it" works)
- **Per-feature preview** — every PR gets its own Vercel preview URL; this is the
  link in the email, so each feature is judged cleanly in isolation.
- **Permanent staging app** — an installable PWA (`scorecard-staging…`) the owner
  keeps on his home screen; always the latest build, openable anytime.
- **Reply-to-approve loop** — release agent deploys → captures clip/screenshots →
  emails owner → watches Gmail for the reply → "ship it" merges + promotes to
  prod; feedback re-dispatches the builder and re-pings.

## Budget, limits & the always-on duty cycle
- **Limits (Max 5x):** a rolling 5-hour session window + weekly caps (all-models
  and Sonnet-only), shared with the owner's own interactive use. Hitting a limit
  hard-stops; there is no native auto-resume.
- **Governor (we build it):** on limit, checkpoint first — commit WIP, write
  `tasks/progress.md`, flip the Notion card to "paused → resumes HH:MM". Every
  feature is committed incrementally, so a stop is a clean pause.
- **Auto-resume:** an external macOS `launchd`/cron trigger (immune to Claude's
  limits) relaunches the loop just after the reset. Weekly cap = outer bound.
- **Protect the human:** bias builders to overnight; reserve daytime quota for the
  owner; the owner's interactive use always takes priority.
- **Overflow discipline:** the $50 cap is a buffer to finish near-done work, not a
  budget to burn; if overflow runs hot, throttle to subscription-only.
- **Verify-before-schedule:** a tiny test run (watch Settings → Usage) confirms the
  scheduler stays on-subscription before any recurring schedule.
- **More throughput later:** Max 20x ($200, ~4× quota) or a dedicated agent API key.

## Design principles (grounded in verified 2026 practice)
- Start simple; reserve multi-agent for review + parallel work (it's ~15× tokens).
- Every task is gated by a check the agent can run: voice-tests + typecheck +
  build + Playwright E2E against the live preview.
- One feature at a time, commit after each; JSON backlog + progress file so long
  unattended runs survive context resets.
- Adversarial review in a fresh context before anything is "done."
- Human-in-the-loop at the altitude of direction + outcomes, not keystrokes.

---

## Phase 0 — Lay the rails  (the build to start on approval)

### A. Repo foundations & guardrails  *(local, reversible)*
- [ ] Project `CLAUDE.md` (commands, conventions, branch/PR etiquette, "verify
      before done", explicit do-not-touch list)
- [ ] `.claude/settings.json`: allow web for agents; `auto` permission mode for
      routines; allowlist safe commands (npm run lint/build, voice-tests, gh,
      git commit + push-to-branch)
- [ ] Guardrail hooks: block edits to `.env*`, `deploy/`, Supabase migrations;
      block destructive bash + force-push to `main`; PostToolUse lint/typecheck;
      Stop-hook gate = CI green

### B. The team (`.claude/agents/*.md`)  *(local, reversible)*
- [ ] `eng-lead` — orchestrator / dispatch · opus
- [ ] `product-manager` — specs from goals + gaps, tags major/minor · sonnet
- [ ] `builder` — explore→plan→code→commit, worktree-isolated, one feature · sonnet
- [ ] `reviewer` — adversarial diff review (correctness + security) · opus
- [ ] `qa` — voice-tests + typecheck + build + Playwright E2E vs preview · sonnet
- [ ] `designer` — screenshot + clip vs intent, file polish · sonnet
- [ ] `release-manager` — deploy preview, capture clip, email owner, watch reply,
      promote to prod · sonnet
- [ ] `retro` — weekly lessons + backlog grooming · opus

### C. Quality gates / CI  *(file is local; activates on push)*
- [ ] GitHub Actions on every PR: voice-tests harness, `tsc` typecheck,
      `next build`, ESLint, backend ruff
- [ ] Playwright scaffold + 2–3 smoke E2E (home loads, start round, enter score)
      against the preview URL
- [ ] ⚠️ Branch protection on `main` (require PR + green checks) — *outward, gated*

### D. Preview prototypes + staging app
- [ ] ⚠️ Enable Vercel per-PR preview deploys; preview URL auto-posts to PR — *gated*
- [ ] ⚠️ Permanent staging deployment (installable PWA) = "always the latest" — *gated*
- [ ] Preview/staging env vars → shared **staging backend** so prototypes function
- [ ] Verify Vercel Comments for in-app feedback

### E. Command center (Notion)
- [ ] ⚠️ Create "Scorecard — Product Board" DB (Status, Agent, PR link, Preview
      link, Major/Minor, Risk, Screenshots) — *outward, gated*
- [ ] ⚠️ Create "Daily Standup" / record page — *gated*
- [ ] Wire agents to read/write the board (status, links, screenshots)

### F. Notification + approval loop (email, immediate, major-only)
- [ ] major/minor classifier on backlog items (PM/eng-lead)
- [ ] release-manager: major PR green → deploy preview, capture clip + shots,
      ⚠️ email owner via Gmail with clip + "Open app" + staging link — *gated (first send)*
- [ ] Gmail reply-watcher: "ship it" → merge + promote; feedback → re-dispatch + re-ping
- [ ] minor changes: silent merge to staging, no email
- [ ] urgent push (PushNotification) reserved for blocked / needs-decision

### G. Always-on engine + backlog seed
- [ ] Seed `backlog.json` + `SPEC.md` template from the gap list: unit tests for
      `lib/games.ts` & `lib/voice/*`, OCR scan flow, stats/trends, Postgres
      migration, low-confidence voice-parse UX
- [ ] ⚠️ Schedule ONE nightly Builder routine on a low-risk task (manual
      trigger / dry-run first) — *starts subscription/credit usage, gated*

### H. Limit governor & cost guardrails
- [ ] ⚠️ Settings → Usage: enable usage credits, set $50/mo cap, auto-reload OFF
      — *owner action, gated*
- [ ] Governor: detect limit / parse "resets at HH:MM"; checkpoint (commit +
      `tasks/progress.md` + Notion "paused"); record reset time
- [ ] ⚠️ External `launchd`/cron resume trigger that relaunches the loop after
      reset — *gated*
- [ ] Overnight build window; reserve daytime headroom for the owner

---

## Phase 1 — Prove one loop end-to-end (week 1)
- [ ] Nightly Builder ships a low-risk PR → preview → review/QA gates → (if we
      tag it "major" for the test) owner gets the email → plays → approves.
      Validate the full pipeline before scaling.

## Phase 2 — The full team (weeks 2–4)
- [ ] PM grooming routine; Reviewer+QA as a parallel Workflow; parallel builders
      via worktrees; point at the real backlog (OCR, stats, Postgres).

## Phase 3 — Compounding (ongoing)
- [ ] Weekly Retro; expanding eval suite; Notion cost panel; auto-merge trivial
      PRs (dep bumps, tests) once trusted.

---

## Your steady-state interface
On the days a major feature lands: one email → tap → play on your phone → reply
"ship it" or redirect. ~5 minutes, only when there's something real to see.
Everything minor just appears in your installed Staging app. Dispatch new
priorities anytime in plain English.

## Review (filled in after each phase)
- _Phase 0 results: TBD_
