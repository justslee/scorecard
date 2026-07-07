# Lessons

The `retro` agent appends concrete, specific lessons here so the team stops
repeating mistakes. Format: "X broke because Y; from now on do Z."

_(none yet — the first weekly retro will populate this)_

- **Never bring up a local DB/container to verify backend tests.** This Mac has no local
  Postgres; an agent tried `docker run postgres:16` + waited on the image pull and HUNG the
  cycle (2026-06-28, course-reviews-surface B3). Backend integration tests run in the CI
  backend gate (Postgres). Locally: `ruff` + non-DB tests only; trust CI for DB-backed checks;
  never spin up or wait on a container.

## Session lessons (2026-06-29)
- **Direct `builder` dispatch beats the nested `eng-lead` agent for loop reliability.** Invoking
  the eng-lead AGENT (which spawns Plan+builder+reviewer+qa+designer and iterates) STALLED twice
  (once waiting on a Docker DB pull, once waiting on its nested builder) and needed manual
  self-heal. Dispatching a DIRECT `builder` agent with the MAIN loop doing pick→gate→commit
  completed cleanly every time. Prefer direct builders; pull in reviewer/designer as separate
  direct agents only for MAJOR/risky/user-facing changes.
- **Self-heal stalled cycles:** if an agent committed its feature but left bookkeeping unfinished,
  verify gates + finalize the backlog rather than rebuild (the work is usually already there).
- **Homegrown course data is VIABLE** (Bethpage POC): OSM gives perfect par/handicap + polygons,
  a spatial join assigns them, 3DEP/NAIP are free — no GolfAPI. Best-case course though; the long
  tail of poorly-mapped courses (NAIP digitization/ML) is the multi-month hard part.
- **Don't let the bundle grow unshipped indefinitely.** Value is locked until shipped/deployed;
  several built features ended up dormant (need wiring) or deploy-gated. Surface "ship the bundle"
  as the leverage early + keep a ship-ready PR; don't manufacture marginal/dormant features to
  feed the loop when the real unlock is an owner ship/decision.

## Session lessons (2026-07-07 — 9 ships, 3 process incidents)
- **CI catches async/ordering races that human review misses; cover them with DETERMINISTIC
  tests, not review.** #104's streamed caddie reply double-rendered its tail ("Smooth 6.Smooth 6.")
  because a coalesced flush fired AFTER the authoritative answer was set — a race the reviewer
  read past but full-suite CI surfaced (fixed 56df95f). The lesson is not "review harder": for any
  streaming/timer/async code, write tests that CONTROL the scheduler — mock `requestAnimationFrame`
  and `framer-motion` to synchronous/passthrough stand-ins, emit tokens via a hand-controlled
  `deferredStream()` (never real `setTimeout`), and give the real rAF-coalescer its own fake-timer
  test (0b0d67e). Scope rAF/timer checks to `window.*` so one file's `vi.useFakeTimers()` polyfill
  can't leak a dead stub into a later jsdom file. A test that passes only sometimes is a product
  race until proven otherwise — bisect to the one file, don't retry-until-green.
- **`ship.sh` (and any deploy script) must never be piped, must `set -o pipefail`, and must
  assert its cwd + use absolute paths.** #104's ship piped `ship.sh` through another command, which
  swallowed the exit code and masked a wrong-working-directory failure TWICE before it was caught.
  From now on: run deploy scripts un-piped; start them with `set -euo pipefail`; assert the expected
  repo/dir at the top and fail loudly if wrong; reference files by absolute path, never a relative
  path that depends on cwd.
- **Verify a deploy/CI run by matching `headSha`, never by recency (`--limit 1`).** During #104
  recovery, `gh run list` returned a STALE deploy run (an older run that happened to be newest in
  the list), so the pipeline "verified" the wrong build. From now on: resolve the exact run for the
  commit you shipped (`gh run list --json headSha,conclusion,databaseId ... | select(.headSha==SHA)`
  / deploy status filtered by SHA), and confirm the DEPLOYED artifact's SHA equals the merged SHA —
  recency is not identity. (Same class as the #100 piped-`gh pr checks` swallow: gate on structured
  fields, never scraped/`head`-ed output.)
