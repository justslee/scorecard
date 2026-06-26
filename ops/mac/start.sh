#!/usr/bin/env bash
# Always-on (UNATTENDED) Looper agent runner for this Mac.
#
#   ./ops/mac/start.sh
#   then, inside the session:  /loop 4h Act as eng-lead — sync main, build the next backlog item, open a PR.
#
# Launches in `auto` permission mode so the unattended loop never hangs on a prompt:
# a classifier auto-approves routine work and blocks risky actions — and the guard hook
# (.claude/hooks/guard.sh) still HARD-blocks edits to .env / deploy/ / migrations, plus
# destructive recursive deletes, force-pushes, and pushes to main — no matter the mode.
# Branch protection is the final backstop.
#
# `--remote-control` enables Remote Control on the loop session so its approval push
# notifications reach your PHONE (and you can reply "ship it" from the Claude mobile app).
# Pair once: open the Claude app → Code → tap this session (or scan the QR shown on start).
# Without this flag, PushNotification only reaches the desktop ("Remote Control inactive").
#
# Stays on your Max subscription (interactive). Do NOT use `claude -p` — it meters at API rates.
#
# FIRST PROOF RUN should be SUPERVISED instead: from the repo root run plain `claude`
# (it prompts so you can watch/approve each step) before trusting this unattended runner.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec caffeinate -dimsu claude --remote-control "Looper loop" --permission-mode auto
