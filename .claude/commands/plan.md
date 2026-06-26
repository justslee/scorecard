---
description: Produce an opus implementation plan for a task before any code
---
Use the `Plan` subagent **on the opus model** to produce a concrete implementation plan for:

$ARGUMENTS

The plan MUST cover:
- the approach (how, in steps);
- the critical files to touch;
- edge cases and risks;
- any shared types to keep in sync (`frontend/src/lib/types.ts` ↔ `backend/app/models.py`);
- the exact gates that will verify it (`lint`, `tsc --noEmit`, `voice-tests --smoke`, `next build`, `ruff`).

Follow `NORTHSTAR.md` — protect the quiet, voice-first, yardage-book feel. Do not write any
code. Save the plan to `specs/<task-slug>-plan.md` and summarize it back.

This is the same opus planning step the `eng-lead` runs before handing work to the `builder`.
