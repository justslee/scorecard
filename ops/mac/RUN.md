# Running the Looper agent team on your Mac

The team's brain lives in **this repo** (`.claude/agents`, `.claude/hooks`,
`.claude/settings.json`, `CLAUDE.md`, `backlog.json`, `tasks/`). It is **not
device-specific** — any Mac with Claude Code + your Max login + this repo runs the same
team. This Mac is the team's home; the **EC2 hosts only the app backend**, not the agents.

## One-time setup
1. Install Claude Code and **log in with your Max plan** (once per machine).
2. Install the toolchain the agents use to build + verify:
   ```
   brew install node uv gh git
   ```
3. Clone the repo, install deps, and authorize pushes:
   ```
   git clone https://github.com/justslee/scorecard.git && cd scorecard
   ( cd frontend && npm install )      # NOTE: the Node project is in frontend/, not the repo root
   ( cd backend && uv sync )
   gh auth login                       # agents open PRs — needs push access
   ```
4. (optional) Keep the Mac awake automatically:
   ```
   cp ops/mac/com.looper.keepawake.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.looper.keepawake.plist
   ```

## Run the loop  (subscription path — NOT `claude -p`, which meters at API rates)

**First time — SUPERVISED** (watch + approve once, before trusting it unattended):
```
cd <repo> && claude        # plain: prompts on each action so you can review
```
Then drive it, e.g.:
> Act as the builder: build `test-games-engine` — add Vitest, write tests, run the gates, open a PR. Show me the output first.

Tip: pick **"Yes, and don't ask again"** for repeated safe commands to taper the prompts.

**After you trust it — UNATTENDED (always-on):**
```
./ops/mac/start.sh         # launches `claude --remote-control "Looper loop" --permission-mode auto`
```
This starts the loop with **Remote Control** enabled so approval push notifications reach your
**phone** and you can reply "ship it" from the Claude mobile app. **Pair once:** open the Claude
app → **Code** → tap the "Looper loop" session (or scan the QR the command prints on start). Keep
the Mac awake + online (the keepawake plist below) — if it sleeps/loses network >~10 min the
Remote Control session times out. To enable Remote Control on an *already-running* loop without
restarting, run **`/remote-control`** inside that session.

Then self-pace:
> /loop 4h Act as eng-lead — sync main, build the next backlog item, run the gates, open a PR.

In `auto` mode a classifier auto-approves routine work; the **guard hook still hard-blocks**
`.env` / `deploy/` / migrations / `rm -rf` / force-push / push-to-`main` no matter the mode;
branch protection gates production. That layered backstop is what makes hands-off safe.

## The governor (usage limits)
When you hit the 5-hour/weekly Max limit, the session checkpoints (commits WIP + updates
`tasks/progress.md`) and stops — every feature is committed incrementally, so a stop is a
clean pause. Reopen the session after the reset to resume.

## Verify before trusting it overnight
- Watch **Settings → Usage** during the first runs: confirm spend stays on your **subscription**,
  not the metered agent credit. If you see API-rate metering, stop — something is using
  `claude -p` / the Agent SDK.
- Run it **supervised for a day** before leaving it unattended.

## Why the Mac, not EC2, for the agents
Running the loop under your **interactive Max login** keeps it on the flat $100 subscription.
A headless `claude -p` loop on a Linux EC2 would meter at full API rates. So: **EC2 = app
backend; this Mac = the agent team.**
