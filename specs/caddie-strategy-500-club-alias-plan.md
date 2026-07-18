# Plan — P0: strategy endpoint 500s on LLM club shorthand ('7i'/'3w') + int TypeError

Owner P0 field bug (live round today, v1.1.14). Strategy endpoint 500s repeatedly during
real play → reaches the owner as the voice's "I'm not getting a clear read of the strategy
right now." Prod journalctl 12:50–12:56 ET. Classified **NOTICEABLE** (owner hit it today).

## Root cause (confirmed by code trace, base 0756ae5 == v1.1.14)

1. **Club shorthand crash.** An LLM-natural club token (`'7i'`, `'3w'` — from asks like
   "what about a 3-wood?") enters an un-normalized club ingress and lands in the bag /
   engine, then the strategy path hands it to physics:
   - Ingress A — `record_shot` dispatch (`tools.py:994`): `club = str(args.get("club") or "").strip()`
     is stored raw into `session.shot_history` (the model's stated shorthand source).
   - Ingress B — `session.club_distances = request.club_distances` (`routes/caddie.py:349`
     and the second bag-set site): the client/profile bag is assigned with keys un-normalized.
   - Crash path: `strategy.py:112 build_strategy_payload` → `:147 recommend_payload`
     → `aim_point.py generate_recommendation` → `club_selection.normalize_club_distances`
     (passes unknown keys through unchanged) → `select_club`/`compute_adjustments` →
     `physics._club_ref('7i')` (`physics.py:363`) raises
     `ValueError: unknown club '7i'; expected one of [...]`.
   - The exception is raised **inside `build_strategy_payload`, before** `run_strategy_turn`'s
     synth-degrade guard (which only catches OpenAI errors/timeouts/validation), so it
     propagates → route → **500** → client tool dies → voice paraphrases a vague failure.
   - Note: `get_shot_distance` already normalizes via `_canonical_club` (`tools.py:733`) and
     degrades to `available:false` — the strategy/recommendation bag path is the gap.

2. **int TypeError** (`expected string or bytes-like object, got 'int'`, 12:54:12, same
   family). A model-supplied arg typed as `int` (e.g. `"club": 7`) reaches a regex/string op
   before coercion. Builder must **reproduce it** (send int-typed `club`/`hole` args through
   the strategy + record_shot dispatch) and fix at the **exact frame** with str coercion at
   the boundary. `_as_int` (`tools.py:933`) already coerces numerics; ensure club is
   `str(...)`-coerced everywhere it enters (record_shot/get_shot_distance already do — find
   the path that doesn't; suspect any `re.*`/`.strip()`/`.lower()` consuming a raw arg, e.g.
   `_canonical_club` on a non-str, or a bag key that's non-str).

## The fix — defense in depth (owner spec A/B/C/D)

### A. One shared club-alias normalizer, reused (do NOT invent a divergent table)
- **Move** `_CLUB_ALIASES` + `_canonical_club` out of `tools.py` into a shared module that
  `club_selection.py` can import without a cycle. `tools.py` already imports `club_selection`,
  so **put the canonical table + `canonical_club()` in `club_selection.py`** (or a tiny
  `club_aliases.py`) and re-export/import from `tools.py` so `get_shot_distance`/`record_shot`
  keep identical behavior. One table, one source of truth.
- **Extend** the table to cover every alias the owner listed (case-insensitive, whitespace/
  hyphen tolerant — the lookup already lowercases + strips spaces/hyphens):
  `'3w'→3wood`, `'5w'→5wood`, `'7i'→7iron` (all irons 4–9 via `f"{n}i"`), `'p'/'pw'→pw`,
  `'sand wedge'/'sandwedge'→sw`, `'lob'/'lobwedge'→lw`, `'hybrid'/'3h'→hybrid`,
  `'driver'/'d'→driver`. Verify existing entries; add the missing ones (`'p'→pw`, `'lob'→lw`,
  `'d'→driver`, `'3h'→hybrid`). Keep the `CLUB_DISPLAY_NAMES`-derived base. Coerce input to
  `str` inside `canonical_club()` so a non-str arg can't raise there either.
- **Apply the normalizer at the bag chokepoint**: `normalize_club_distances`
  (`club_selection.py`) is the ONE function every recommendation's bag passes through
  (`generate_recommendation`, `aim_point`). Run each key through `canonical_club()` there.
  Also normalize `record_shot`'s club arg (dispatch, `tools.py:994`) and the
  `session.club_distances = request.club_distances` assignment(s) in `routes/caddie.py`,
  so `'3w'` yields **correct 3wood numbers**, not just a non-crash.

### B. Unknown club must NEVER 500 (two layers)
- Layer 1 — in `normalize_club_distances`: a key that is still unknown after aliasing is
  **dropped with a `log.warning`** (one per dropped key, key-safe) rather than passed to
  physics. Physics never receives a non-canonical club again.
- Layer 2 — wrap `build_strategy_payload` (the whole payload assembly) in a `try/except`:
  on ANY exception, **`log.warning`/`log.exception`** (key-free) and degrade — return the
  honest `available:false` / engine-numbers shape the synth already falls back to, never let
  the exception escape to the route. Extend the synth's existing degrade discipline to the
  payload build, per owner. **The reviewer must confirm no 500 path remains reachable from
  tool args, and that this catch LOGS (so it can't silently mask a real bug).**

### C. int TypeError — fix at the exact frame
- Reproduce, locate the exact `re.*`/string frame, coerce the offending arg to `str` (or
  `_as_int` for a numeric) at the boundary. Prefer boundary coercion over a defensive
  `str()` deep in the engine.

### D. Tests (all offline/deterministic; DB-backed ones run in CI)
- Alias table: every listed alias → its canonical key (parametrized), case/space/hyphen
  variants.
- `'3w'` end-to-end through the strategy route/`run_strategy_turn`: **no 500**, and the
  numbers are the **3wood** numbers (not a fallback).
- Unknown club `'shovel'` in the bag / as a record_shot arg → **graceful**: dropped from the
  bag with a warning; strategy returns a no-crash answer (engine line / honest note), not 500.
- int-typed args (`"club": 7`) → **no crash**.
- `build_strategy_payload` with a forced internal error → degrades (available:false /
  numbers), never raises.
- Existing suites stay green (voice-tests smoke, ruff, tsc/build; backend integration in CI).

## Files (expected touch set)
- `backend/app/caddie/club_selection.py` — home the shared alias table + `canonical_club()`;
  `normalize_club_distances` aliases + drops-with-warning.
- `backend/app/caddie/tools.py` — import the shared normalizer; normalize `record_shot` club
  arg; keep `get_shot_distance` behavior; possible int-frame fix.
- `backend/app/caddie/strategy.py` — `build_strategy_payload` try/except degrade.
- `backend/app/routes/caddie.py` — normalize the `session.club_distances = request.*` bag
  assignment(s).
- `backend/tests/...` — the D tests.
- Keep `frontend/src/lib/types.ts` ↔ `backend/app/models.py` in sync ONLY if a shape changes
  (this fix should not need one).

## Guardrails
- No fake-data fallbacks: dropped/unknown clubs degrade to honest empty/engine numbers, never
  a fabricated stand-in; every fallback logs a warning so real bugs surface.
- One table, mirrored from the existing `_CLUB_ALIASES`; never a second divergent vocab.
- Never touch main; never force-push. On usage/529: checkpoint + stop.
