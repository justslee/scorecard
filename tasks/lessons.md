# Lessons

The `retro` agent appends concrete, specific lessons here so the team stops
repeating mistakes. Format: "X broke because Y; from now on do Z."

_(none yet — the first weekly retro will populate this)_

- **Never bring up a local DB/container to verify backend tests.** This Mac has no local
  Postgres; an agent tried `docker run postgres:16` + waited on the image pull and HUNG the
  cycle (2026-06-28, course-reviews-surface B3). Backend integration tests run in the CI
  backend gate (Postgres). Locally: `ruff` + non-DB tests only; trust CI for DB-backed checks;
  never spin up or wait on a container.
