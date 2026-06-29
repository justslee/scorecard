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
