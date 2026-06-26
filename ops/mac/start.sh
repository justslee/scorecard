#!/usr/bin/env bash
# Start the Looper agent loop on this Mac, kept awake.
# Then, inside the Claude session, run e.g.:
#   /loop 4h Act as eng-lead — sync main, build the next backlog item, open a PR.
# Stays on your Max subscription (interactive). Do NOT use `claude -p` here — it meters at API rates.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec caffeinate -dimsu claude
