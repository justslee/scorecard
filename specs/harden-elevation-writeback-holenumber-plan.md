# Plan: harden-elevation-writeback-holenumber

Backend-only, SILENT data-integrity hardening. No frontend change. No Alembic/SQL
migration. No shared-type change. Best-effort write-back stays best-effort — nothing
here may raise or drop intel.

## Goal

The static per-hole elevation write-back added in `0200576` trusts the request's hole
numbering as the WRITE-BACK KEY. Close three gaps without regressing the two behaviours
that are already correct (strict SQL match, "absent != zero" never-synthesize):

1. `hole_number = hole_coords.get("holeNumber", 1)` in `build_hole_intelligence`
   (`backend/app/caddie/course_intel.py:59`) DEFAULTS an ABSENT holeNumber to `1`, and
   that same value is the write-back key at `:132-133` — so a request with no holeNumber
   silently persists elevation (computed from whatever `tee`/`green` the request carried)
   onto stored **hole 1**. A silent wrong-hole write.
2. `hole_coordinates` is typed `list[dict]` (`backend/app/caddie/types.py:200`), so
   holeNumber gets NO pydantic validation. A `str`/`float`/`None`/negative/`0`/huge/`bool`
   flows straight into the SQL `:hole_number` param.
3. No skip+log when the write-back key is invalid — it silently no-ops or mis-writes.

Fix: SEPARATE the display hole number from the write-back key. The returned
`HoleIntelligence.hole_number` keeps its current safe default so intel is never dropped.
The WRITE-BACK fires ONLY when holeNumber is a validated int in `1..36`. Defense in depth:
`update_green_feature_properties` also validates and returns `False` before SQL.

## Ground-truth anchors (verified — build on exactly these)

- `build_hole_intelligence` (`backend/app/caddie/course_intel.py:28-162`):
  - `:59` `hole_number = hole_coords.get("holeNumber", 1)` — used as BOTH display and write key.
  - `:127-136` write-back branch: fires when `course_id and tee_elev is not None and
    green_elev is not None`, calls `courses_mapped.update_green_feature_properties(course_id,
    hole_number, courses_mapped._elevation_patch(profile))` inside a `try/except` that only
    `log.warning`s (never re-raises — best-effort).
  - `:153-162` returns `HoleIntelligence(hole_number=hole_number, ...)`.
  - The module already establishes the reject-bool idiom: `isinstance(x, int) and not
    isinstance(x, bool)` (`:67`, `:70`, `:75`). Mirror it.
- `update_green_feature_properties` (`backend/app/services/courses_mapped.py:397-433`):
  strict SQL match on `h.course_id` + `h.hole_number` + `hf.feature_type='green'`; no
  positional fallback; `if not patch: return False` guard already at `:411-412`; returns
  `(rowcount or 0) > 0`. A non-existent hole is already a safe no-op returning `False`.
  DO NOT touch the SQL or the absent-vs-zero logic.
- Route wiring `get_course_intel` (`backend/app/routes/caddie.py:1109-1138`): loops
  `request.hole_coordinates`, passes `course_id=owned_session.course_id if owned_session
  else None`. The display number still drives `hole_intel_map[intel.hole_number]` (`:1133`)
  and the stored-hole lookup (`:1123`) — those must keep working on a defaulted number.
- Tests to extend (non-DB, no DB marker): `backend/tests/test_course_intel_static_read.py`
  (stubs `app.db` in `sys.modules`, monkeypatches `courses_mapped.update_green_feature_properties`
  — the exact mocking style to mirror) and `backend/tests/test_course_intel_resilience.py`.

## Chosen range bound: 1..36 inclusive

- Real golf hole numbers are `>= 1`; `0`, negative, `None`, and non-ints are never valid keys.
- A single stored course record can legitimately carry up to a 36-hole facility (two 18s /
  combined layouts) numbered `1..36`; 9- and 18-hole courses are the common case and fit
  comfortably inside it. `36` is generous enough to never reject legitimate data yet tight
  enough that a garbage value (a lat like `40`, a huge id, a float index) is caught.
- The strict SQL match already makes a valid-but-nonexistent number (e.g. `27` on an 18-hole
  course) a safe no-op returning `False`, so the bound only needs to exclude nonsense, not
  perfectly fit each course's hole count.

## Approach — surgical changes

### 1. Shared validation helper (ONE source of truth for the bound)

Add `_valid_hole_number(value) -> bool` as a module-level helper in
`backend/app/services/courses_mapped.py` (natural home — it owns the write key and the
range constant lives beside the SQL that consumes it). Define a `_MAX_HOLE_NUMBER = 36`
constant next to it.

    def _valid_hole_number(value) -> bool:
        # bool is an int subclass — reject it explicitly (mirrors course_intel's idiom).
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
            and 1 <= value <= _MAX_HOLE_NUMBER
        )

Rationale for placing it in courses_mapped: `course_intel.py` already imports
`from app.services import courses_mapped`, so the gate helper is reused with no new import
and the `1..36` bound is never duplicated (same "kept in ONE place" discipline as
`_elevation_patch`).

### 2. Gate the write-back in `course_intel.py`

- Keep `:59` `hole_number = hole_coords.get("holeNumber", 1)` UNCHANGED — this stays the
  DISPLAY value that flows into `HoleIntelligence.hole_number` and the route's maps, so a
  bad/absent number never drops the hole's intel.
- Read the RAW candidate separately (no default): `raw_hole_number = hole_coords.get("holeNumber")`.
- In the write-back branch (`:127`), gate on the validated key. When invalid, SKIP the write
  and log ONCE at `debug`/`info` (non-spammy — a whole 18-hole round with absent numbers must
  not emit 18 warnings), do NOT raise:

      if course_id and tee_elev is not None and green_elev is not None:
          if courses_mapped._valid_hole_number(raw_hole_number):
              profile = compute_hole_elevation_profile(tee_elev, green_elev, slope_result)
              try:
                  await courses_mapped.update_green_feature_properties(
                      course_id, raw_hole_number, courses_mapped._elevation_patch(profile)
                  )
              except Exception:  # noqa: BLE001 — persistence is best-effort; never sink intel
                  log.warning("elevation write-back failed for hole %s", raw_hole_number, exc_info=True)
          else:
              log.debug(
                  "skip elevation write-back: invalid holeNumber %r (course %s)",
                  raw_hole_number, course_id,
              )

  Note the write key is now `raw_hole_number` (the VALIDATED value), never the defaulted
  `hole_number`. Display still uses `hole_number` at `:154`.

### 3. Defense in depth in `update_green_feature_properties`

At the top of `backend/app/services/courses_mapped.py:397` (right beside the existing
`if not patch: return False` guard at `:411`), reject an invalid key BEFORE opening a
session / executing SQL:

    if not _valid_hole_number(hole_number):
        log.debug("update_green_feature_properties: invalid hole_number %r (course %s)", hole_number, course_id)
        return False

This hardens EVERY caller (the precompute path already derives numbers from stored data so
it is safe, but this makes the function safe by contract). Confirm `courses_mapped` has a
module logger; if it lacks one, add `log = logging.getLogger("looper.courses_mapped")`
near the top (check imports — add `import logging` only if absent).

### 4. No shared-type change (confirmed)

`hole_coordinates` stays `list[dict]` in `backend/app/caddie/types.py:200`. Tightening it to
a pydantic item model would be a broader, behaviour-visible change (it would 422 malformed
requests instead of degrading gracefully) — out of scope and against the "never sink intel"
principle. `frontend/src/lib/types.ts` and `backend/app/models.py` are untouched. This is
backend-internal hardening only.

## Edge cases (all must SKIP the write / return False, never raise, never mis-write)

- holeNumber absent → display defaults to 1, write-back SKIPPED (the core bug).
- holeNumber = `"3"` (str) → rejected (isinstance int fails).
- holeNumber = `3.0` (float) → rejected.
- holeNumber = `None` (explicit) → rejected.
- holeNumber = `0` → rejected (below range).
- holeNumber = `-1` → rejected.
- holeNumber = `9999` (huge) → rejected (above range).
- holeNumber = `True` / `False` (bool) → rejected (bool is an int subclass).
- holeNumber = `1`..`36` (valid int) → write-back proceeds UNCHANGED.
- Any invalid value → `HoleIntelligence.hole_number` still populated (intel not dropped).
- The already-correct behaviours are UNCHANGED: strict SQL match, and "absent != zero"
  (partial live compute with a None endpoint still never writes).

## Tests (non-DB unit, pytest, NO db marker) — extend existing files

Extend `backend/tests/test_course_intel_static_read.py` (mirror its `sys.modules` app.db
stub + `monkeypatch.setattr(courses_mapped, "update_green_feature_properties", ...)` style;
use an `AsyncMock`/async fake to assert call-vs-no-call). Add:

`build_hole_intelligence` write-key gating (drive a live compute: both `fetch_elevation_cached`
and `compute_green_slope` mocked to return real values, `course_id` set, `persisted_elevation=None`):
1. `test_writeback_skipped_when_holenumber_absent` — `hole_coords` has no `holeNumber`;
   assert `update_green_feature_properties` NOT called; assert returned `intel.hole_number == 1`
   (display default preserved, intel not dropped).
2. `test_writeback_skipped_for_malformed_holenumber` — parametrize over
   `"3"`, `3.0`, `None`, `0`, `-1`, `9999`, `True`, `False`; assert NOT called each time and
   `intel.hole_number` is still populated.
3. `test_writeback_proceeds_for_valid_holenumber` — parametrize `1`, `18`, `36`; assert
   `update_green_feature_properties` called exactly once with `(course_id, holeNumber, patch)`
   where patch is the `_elevation_patch` shape (elevation math unchanged from today).

`_valid_hole_number` unit (pure, no async):
4. `test_valid_hole_number_accepts_1_to_36` and `test_valid_hole_number_rejects_*` covering
   the same malformed set + boundary `0`/`37`.

`update_green_feature_properties` defense-in-depth (assert it returns False WITHOUT executing
SQL — because `app.db` is stubbed, `async_session` is a MagicMock; assert it was never
awaited/entered, so an early return proves no SQL):
5. `test_update_green_feature_returns_false_on_invalid_hole_number` — parametrize the malformed
   set; assert `False` and that the DB session context was never opened.

Confirm the existing `test_live_compute_partial_elevation_never_writes_back` (absent != zero)
and `test_persisted_hit_skips_all_elevation_calls` still pass unchanged.

## Gates (this machine has NO local Postgres — never spin up a DB container)

- `cd backend && ruff check .`
- `cd backend && uv run pytest tests/test_course_intel_static_read.py tests/test_course_intel_resilience.py -q`
  (or the repo's standard `cd backend && uv run pytest -q -m "not db"` — all new tests are
  non-DB and must run without a database).

The DB-backed integration round-trip (a real wrong-key write being rejected against live
PostGIS) is verified by the CI backend gate's Postgres service, NOT locally — same boundary
the `0200576` commit documented.

## Files to touch

- `backend/app/services/courses_mapped.py` — add `_MAX_HOLE_NUMBER` + `_valid_hole_number`;
  add the early-return guard at the top of `update_green_feature_properties` (`:397-433`);
  ensure a module logger exists.
- `backend/app/caddie/course_intel.py` — read `raw_hole_number` without default; gate the
  write-back branch (`:127-136`) on `_valid_hole_number`; keep `hole_number` (defaulted) as
  display only.
- `backend/tests/test_course_intel_static_read.py` — new gating + helper + defense-in-depth tests.

## Non-goals / do-not-regress

- Do NOT change the write-back SQL, the strict hole match, or the absent-vs-zero rule.
- Do NOT make the write-back raise — it stays best-effort (log-only).
- Do NOT tighten shared request/response types or add pydantic validation to
  `hole_coordinates`.
- Do NOT alter the returned `HoleIntelligence.hole_number` default behaviour.
