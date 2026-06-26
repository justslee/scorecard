# Running the Looper agent team on your Mac (always-on)

The team's brain lives in **this repo** (`.claude/agents`, `.claude/hooks`,
`.claude/settings.json`, `CLAUDE.md`, `backlog.json`, `tasks/`, `specs/`). It is **not
device-specific** — any Mac with Claude Code + your Max login + this repo runs the same
team. This Mac is the team's home; the **EC2 hosts only the app backend**, not the agents.

## One-time setup
1. Install Claude Code and **log in with your Max plan** (once per machine).
2. Clone/pull this repo.
3. (optional) Keep the Mac awake automatically:
   ```
   cp ops/mac/com.looper.keepawake.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.looper.keepawake.plist
   ```

## Run the loop  (subscription path — NOT `claude -p`, which meters at API rates)
From the repo root:
```
./ops/mac/start.sh        # = caffeinate -dimsu claude  (keeps the Mac awake)
```
Then, inside the Claude session, either:
- **Drive it directly:** *"Act as eng-lead: sync main, pick the next backlog item, build it, open a PR."*
- **Self-pace:** `/loop 4h Act as eng-lead — sync main, build the next backlog item, open a PR.`

## The governor (usage limits)
When you hit the 5-hour/weekly Max limit, the session checkpoints (commits WIP + updates
`tasks/progress.md`) and stops. Reopen the session after the reset to resume — every feature
is committed incrementally, so a stop is a clean pause. (A relaunch-after-reset wrapper can
automate this once we've verified the billing path.)

## Verify before trusting it overnight
- Watch **Settings → Usage** during the first runs: confirm spend stays on your **subscription**,
  not the metered agent credit. If you see API-rate metering, stop — something is using
  `claude -p`/the Agent SDK, which bills at API rates (post-Jun-15).
- Run it **supervised for a day** before leaving it unattended.

## Why the Mac, not EC2, for the agents
Running the loop under your **interactive Max login** keeps it on the flat $100 subscription.
A headless `claude -p` loop on a Linux EC2 would meter at full API rates. So: **EC2 = app
backend; this Mac = the agent team.**
