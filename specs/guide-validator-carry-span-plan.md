# Guide Validator — Carry-Span (Contiguous-Run) Acceptance Plan

Precision fix to the strategy-guide grounding validator in
`backend/app/caddie/guide_writer.py`. Scope: the (side, carry) acceptance
predicate `_side_and_carry_supported` ONLY. The validator stays fail-CLOSED,
whole-guide-reject, and remains the no-fake-data guard — nothing else in
`validate_guide` / `_has_side_flip` changes behavior.

## 1. The bug (verified in code)

`_has_side_flip` binds each hazard-keyword occurrence to a nearby side word
and every plausible in-window yardage number, then asks
`_side_and_carry_supported(type, side, carry, hazards_by_type)` whether the
claim is grounded. The current predicate (guide_writer.py ~line 416) accepts
iff SOME single hazard of that type on that side (or "center") has stored
`carry_yards` within `_CARRY_TOLERANCE_YARDS` (25) of the claimed number:

    abs(carry - claimed_carry) <= _CARRY_TOLERANCE_YARDS   # per-sample point test

But `carry_yards` is a DISCRETE sample of an extended feature:

- A bunker Hazard is its polygon **centroid** carry (`_feature_point` →
  `_ring_centroid`, hazards.py ~line 169).
- A tree line emits at most a **near/far pair per side**
  (`_extract_tree_line_hazards`, `_TREE_ENTRY_CAP_PER_SIDE = 2`): the
  min-carry and max-carry surviving observations, i.e. the two samples
  BRACKET one continuous line. `format_hazards_line` already speaks the pair
  as a range ("trees L 145-360y").

So a legitimately-grounded carry falling in a >50y gap between two samples of
the SAME (type, side) feature group false-rejects the whole guide (with a
25y tolerance, any gap g > 2*25 leaves an uncovered dead zone of g-50 yards).
This has negative-cached 5 of 36 mapped holes honest-empty.

Probed prod geometry (the worked examples and test-fixture values below):

| Hole | type/side carry samples |
|---|---|
| RED 1 (par 4)   | NO bunkers; trees L {145, 360}, trees R {265, 355} |
| RED 8 (par 4)   | bunker L {160, 195, 365}; bunker R {225, 360} |
| RED 18 (par 4)  | bunker L {215, 225}; bunker R {255, 380}; bunker C {370}; trees R {10, 380} |
| BLACK 7 (par 5) | bunker R {170, 430, 520}; bunker L {355, 525}; trees L {5, 575}; trees R {20, 480} |
| BLACK 11 (par 4)| bunker L {245, 415}; bunker R {270, 325, 420}; trees R {5, 190} |

Pure examples of the bug: RED 1 "trees pinch from ~250 on the left" is
rejected (250 is 105y from the 145 sample, 110y from 360 — but the two
samples ARE the endpoints of one continuous line). BLACK 11 "bunkers right
at ~298" is rejected (28y from 270, 27y from 325 — one staggered complex).

## 2. The rule

Replace the per-sample point test inside `_side_and_carry_supported` with a
**contiguous-run span test**, computed per (type, stored-side group):

For a claimed `(canonical_type, claimed_side, claimed_carry)`:

1. Candidate side groups = the claimed side's group and the "center" group
   (exactly the sides the current predicate accepts — a center/on-line hazard
   supports either lateral claim, mirroring `_acceptable_sides`). Groups are
   NEVER merged with each other: runs are built within one stored
   `line_side` group at a time.
2. For each candidate group, sort its `carry_yards` samples and split them
   into **maximal contiguous runs**:
   - `canonical_type == "trees"`: the whole side group is ONE run
     `[min, max]` — unconditional bridge. Justified by construction:
     `_tree_hazard` emits at most a near/far PAIR per side whose two carries
     are the bracket of one continuous line; `format_hazards_line` already
     asserts that same span as a range to both mouths. The validator should
     accept exactly what our own stored representation asserts.
   - Every other type (bunker, water, ob): consecutive samples belong to the
     same run iff their gap is `<= _CARRY_BRIDGE_YARDS` (new constant, 60).
3. Accept iff `run_min - _CARRY_TOLERANCE_YARDS <= claimed_carry <=
   run_max + _CARRY_TOLERANCE_YARDS` for SOME run of SOME candidate group.
   Reject otherwise (a number outside every run window is fabricated).

New module constant next to `_CARRY_TOLERANCE_YARDS`:

    _CARRY_BRIDGE_YARDS = 60

Suggested shape (builder may inline; keep `_side_and_carry_supported`'s
signature EXACTLY as-is — `_has_side_flip` is untouched):

    def _carry_runs(carries: list[int], bridge: int | None) -> list[tuple[int, int]]:
        # sorted input; bridge=None -> one run spanning min..max (trees)

    def _side_and_carry_supported(canonical_type, claimed_side, claimed_carry, hazards_by_type) -> bool:
        pairs = hazards_by_type.get(canonical_type, [])
        for group_side in (claimed_side, "center"):
            carries = sorted(c for s, c in pairs if s == group_side)
            if not carries:
                continue
            bridge = None if canonical_type == "trees" else _CARRY_BRIDGE_YARDS
            for lo, hi in _carry_runs(carries, bridge):
                if lo - _CARRY_TOLERANCE_YARDS <= claimed_carry <= hi + _CARRY_TOLERANCE_YARDS:
                    return True
        return False

### 2a. Parameter justification

**Margin stays `_CARRY_TOLERANCE_YARDS` (25), reused, not a new number.** A
run containing a single sample `{c}` yields window `[c-25, c+25]` — byte-
identical to today's per-sample test. Since every old accept is "some sample
within 25", and every sample sits inside some run whose window contains
`[sample-25, sample+25]`, **the new predicate is a strict superset of the old
one for accepts**: no currently-PASSING guide or test can flip to reject.
Black 16 / Red 15 / Pebble 18 and every existing `test_carry_check_*` case
are safe by construction. Only rejects can change, and only inside a bridged
gap's interior.

**Bunker bridge = 60y.** Constraints, from the real geometry:
- B must exceed 50 to change anything at all (gaps <= 2×25 have no dead zone).
- Must bridge the observed same-complex cluster gap: BLACK 11 R 270->325
  (55y). 55 <= 60 OK.
- Must NOT bridge any observed genuinely-separate gap. Smallest such gap in
  the probed set is 90y (BLACK 7 R 430->520 — layup vs. green-side complexes
  on a par 5); then 95 (BLACK 11 R 325->420), 125 (RED 18 R), 135 (RED 8 R),
  170 (×3), 260 (BLACK 7 R). 60 < 90 with a 30y safety margin OK.
- Attack-surface bound: bridging one gap g adds only `g - 50` yards of newly
  acceptable interior (<= 10y at g = 60), and chained runs only form where
  real bunkers actually sit every <= 60y — i.e. a genuinely continuous complex.

60 sits low in the (55, 90) feasible band — fail-closed bias. Water/ob use
the same 60 (same discrete-centroid representation; no prod counterexample).

### 2b. THE adversarial case — numeric proof (BLACK 7, bunker R {170, 430, 520})

Fabricated claim: "carry the right bunker at 300".
- Right group sorted: 170, 430, 520. Gaps: 430-170 = **260 > 60** (split),
  520-430 = **90 > 60** (split). Runs: {170}, {430}, {520}.
- Center group: empty. Candidate windows:
  [145, 195] ∪ [405, 455] ∪ [495, 545].
- 300 ∉ any window → `_side_and_carry_supported` returns False →
  `_has_side_flip` returns True → **whole guide REJECTED**. OK

Tree bridge cannot reopen this hole: runs are computed per `canonical_type`
key of `hazards_by_type` — a "bunker" keyword claim only ever reads
`hazards_by_type["bunker"]`. BLACK 7's trees R {20, 480} span [0->505] exists
ONLY under the `"trees"` key; the bunker claim at 300 above still rejects
with trees present (pinned by a test, §4). Conversely "trees right at 250"
on BLACK 7 accepts via the trees-R run [20-25, 480+25] — which is exactly
what `format_hazards_line` already tells the caddie ("trees R 20-480y").

Tree bridging is span-BOUNDED, not an unconditional accept: RED 1 trees R
{265, 355} → window [240, 380]; a claimed "trees right at 200" still
rejects (200 < 240). And the type-not-present catch is untouched: any
"trees" claim on a hole with no trees entries rejects before this predicate
ever runs.

### 2c. More worked examples (become test fixtures)

- RED 1 trees L {145, 360} → one run, window [120, 385]. "Trees pinch the
  left from about 250" → 250 ∈ [120, 385] → PASS (was reject). The pure
  tree-line-gap false reject, fixed.
- BLACK 11 bunker R {270, 325, 420}: gaps 55, 95 → runs {270, 325}, {420};
  windows [245, 350] ∪ [395, 445]. "Bunkers right at 300" → PASS (was
  reject). Fabricated "right bunker at 370" → 370 ∉ windows → REJECT
  (45 from 325, 50 from 420 — mid-gap of a genuine 95y gap).
- RED 18 bunker R {255, 380} + C {370}: right runs {255}, {380}; center run
  {370}. Windows [230, 280] ∪ [355, 405] ∪ [345, 395]. Legit 255 → PASS;
  fabricated mid-gap 320 → REJECT.
- RED 8 bunker L {160, 195, 365}: runs {160, 195}, {365} — windows
  [135, 220] ∪ [340, 390]; identical coverage to today (gap 35 < 50 had no
  dead zone). Honest caveat: if RED 8's original rejection was a claim > 25y
  off a single long bunker's centroid (extent, not gap), the regen will
  reject it again and the hole stays honest-empty — that is fail-closed and
  acceptable; this plan fixes the sampled-gap class only.
- Bethpage Black 4 regression (existing incident tests): real right-side
  bunker carries are all > 350, so any right-group run window has
  `min >= 350 - 25 = 325`; the incident lie "right bunkers at 265" still
  rejects. `test_hole4_*` in test_bethpage_validation.py must pass unedited.

## 3. What does NOT change (preserved guarantees)

- `_has_side_flip` — binding, `_SIDE_WINDOW_WORDS`, opposition phrases,
  all-in-window-numbers fail-closed binding, tie-break laundering defense:
  untouched. The fix needs NO companion change there — the predicate's
  notion of "supported" is the only thing that was wrong.
- `_CARRY_TOLERANCE_YARDS`, `_MIN/_MAX_PLAUSIBLE_CARRY`,
  `_CARRY_NUMBER_PATTERN`: unchanged.
- Type-not-present scan, side-flip catch, both-sides-wrong-number catch
  (§2b/2c proofs), injection pattern, newline check, structural caps:
  unchanged.
- `hazards.py`: NO changes (extraction stays as-is; the fix is entirely in
  the validator's interpretation of the stored samples).
- Backend-only: no frontend files, no tsc/vitest. No DB schema change.
- `test_corridor_*` do not import guide_writer — untouched by construction.
- Existing test files pass with ZERO edits (never edit a test to make it
  pass): every current `validate_guide` case in test_guide_writer.py,
  test_bethpage_validation.py, test_session_guide_revalidate.py,
  test_guide_read_revalidation.py, test_course_guides.py is either
  single-sample (identical windows) or has all gaps > 60 (identical runs).

Docstrings to update (accuracy, since they describe the old point test):
`_side_and_carry_supported`, the CARRY-AWARE paragraph of `_has_side_flip`,
and rule 6 of `validate_guide` — state the run/bridge/margin rule and the
trees near/far-bracket rationale, referencing this spec.

## 4. Test matrix (exact cases the builder must add)

### backend/tests/test_guide_writer.py  (new section "Carry-span runs")

Fixtures (hand-pinned from the probed prod geometry above):
- `_black7_right_like_bunkers()` → bunker R {170, 430, 520} (+ optionally
  L {355, 525}).
- `_black11_right_like_bunkers()` → bunker R {270, 325, 420}.
- `_red1_like_trees()` → trees L {145, 360}, trees R {265, 355}.
- `_black7_like_mixed()` → bunker R {170, 430, 520} + trees R {20, 480}.

Tests:
1. `test_carry_span_passes_within_bridged_bunker_cluster` — BLACK 11-like,
   "Bunkers right at 300 pinch the landing zone" → PASSES (was reject).
2. `test_carry_span_passes_tree_line_mid_span` — RED 1-like, "Trees pinch
   the left side from about 250" → PASSES (was reject).
3. `test_carry_span_rejects_fabricated_carry_in_genuine_bunker_gap` —
   BLACK 7-like, "Carry the right bunker at 300" → REJECTS (the reviewer's
   adversarial case; comment the 260y/90y gap math from §2b).
4. `test_carry_span_rejects_fabricated_carry_outside_all_hazards` —
   BLACK 7-like, "right bunker at 600" → REJECTS.
5. `test_carry_span_rejects_mid_gap_between_separate_runs` — BLACK 11-like,
   "right bunker at 370" → REJECTS (95y gap stays split).
6. `test_carry_span_tree_bridge_does_not_leak_into_bunker_claims` —
   `_black7_like_mixed()`, "Carry the right bunker at 300" → REJECTS even
   though trees R span [20, 480] covers 300.
7. `test_carry_span_tree_window_is_bounded` — RED 1-like, "trees right at
   200" → REJECTS (below the right line's [240, 380] window).
8. `test_carry_span_wrong_side_and_number_still_rejects` — regression lock
   on the original incident class: bunkers L {275} / R {390} / C {470},
   "right bunker at 265" → REJECTS (mirror the existing
   `test_carry_check_rejects_side_with_wrong_distance`; do not edit that one).
9. `test_carry_span_single_sample_window_identical_to_old_tolerance` —
   single bunker L {245}: 220 & 270 pass, 195 & 295 reject (exact ±25 edges
   preserved).

### backend/tests/test_bethpage_validation.py  (real-OSM-geometry lock)

In the incident-class test group (after `test_hole4_*`): add a Black 7 case
driven off the ASSEMBLED fixture (`extract_hole_hazards` on hole 7 of the
assembled Black course, same pattern as `hole4_hazards`):
10. `test_black7_right_bunkers_have_a_genuine_gap` — sanity-pin the premise:
    sorted right-side bunker carries contain at least one adjacent gap
    > 150y (guards against fixture drift silently voiding test 11).
11. `test_black7_fabricated_mid_gap_right_carry_rejects` — validate_guide on
    a guide claiming "Carry the right bunker at 300" against hole 7's
    extracted hazards → None. (If fixture-vs-prod carry drift ever moves the
    gap, derive the claimed number as the midpoint of the largest right-side
    gap instead of hard-coding 300 — keep the test premise, not the literal.)
12. Existing `test_hole4_*` — unedited, green.

### Files verified as needing NO changes
- backend/tests/test_course_guides.py (mocked pipeline — behavior-neutral),
  test_session_guide_revalidate.py, test_guide_read_revalidation.py,
  test_guide_consumption.py, tests/eval/* (revalidation call sites unchanged).

## 5. On-box regen (eng-lead executes AFTER fix lands + QA green; NOT the builder)

Target: exactly RED 1/8/18 + BLACK 7/11 — all negative-cached
(`green.properties.strategy_guide_attempted_at` set, no `strategy_guide`).

**Marker-clearing mechanism — CONFIRMED from courses_mapped.py (~line 480):**
`update_green_feature_properties` does a JSONB merge
(`properties || cast(:patch as jsonb)` via `json.dumps(patch)`). Passing
`{"strategy_guide_attempted_at": None}` serializes to JSON `null`; `||`
REPLACES the key's value with `null` (merge-null, key stays present — it is
NOT deleted). That is sufficient: `get_course` returns the property as
Python `None`, and the negative-cache guard in
`course_guides._precompute_course_guides` is
`if green_props.get("strategy_guide_attempted_at") is not None: continue` —
JSON-null reads as None, so the hole is re-attempted. The `strategy_guide`
key is untouched by the merge.

**Recommendation: committed guarded operator script (not ad-hoc on-box
python)** — `backend/scripts/regen_rejected_guides.py`, mirroring the
`ingest_osm_course.py` operator-script pattern and `run_guide_backfill`'s
env-gating discipline. Reviewable, repeatable, and the exact clearing
semantics live in the repo instead of a shell history. Spec:
- Env gate `REGEN_GUIDES` = `course_id:hole,hole;course_id:hole,...`
  (empty ⇒ no-op, safe-by-default like GUIDE_BACKFILL_COURSES). Hard cap
  `REGEN_GUIDES_MAX_HOLES` (default 10) across the whole spec.
- Per hole: fetch course via `courses_mapped.get_course`; SKIP (log) any
  hole that already HAS a `strategy_guide` (never clear a marker under a
  live guide) or has no marker; otherwise
  `await update_green_feature_properties(course_id, hole,
  {"strategy_guide_attempted_at": None})`.
- Then `await _precompute_course_guides(course_id)` ONCE per course (it
  skips every guided/marked hole; only the cleared holes re-research).
- `--dry-run` flag: print what would be cleared, write nothing.
- Builder adds this script + a small offline test of its spec parser/cap
  (no DB) if straightforward; DB behavior is exercised on-box.

**On-box run (eng-lead):** instance `i-0826ae70df62d9fe8`, deployed app at
`/home/ubuntu/scorecard` — do NOT touch its branch; regen only after the fix
is available in the checkout used to run. From that checkout: `.venv` venv,
`.env` provides DATABASE_URL + ANTHROPIC_API_KEY, export
`LOOPER_SECRETS_DISABLED=1` (bypasses stale Secrets Manager). Model:
`claude-sonnet-5` (GUIDE_WRITER_MODEL default). Course UUIDs:
red=`269e1f2e-65cc-5cf6-a9b0-f5908e298155`,
black=`2b8caab5-2c55-5752-8cda-336c3a396dac`. E.g.:

    REGEN_GUIDES="269e1f2e-65cc-5cf6-a9b0-f5908e298155:1,8,18;2b8caab5-2c55-5752-8cda-336c3a396dac:7,11" \
    LOOPER_SECRETS_DISABLED=1 .venv/bin/python backend/scripts/regen_rejected_guides.py

Verify: logs show per-hole "guide writer hole=..." then either a persisted
guide or "guide rejected by grounding validation" (a re-reject = the claim
was NOT the sampled-gap class — leave honest-empty, report back). Confirm
via `get_course` that regenerated holes now carry `strategy_guide`.

## 6. Gates

- `cd backend && ruff check .`
- Targeted non-DB pytest:
  `cd backend && uv run pytest tests/test_guide_writer.py tests/test_bethpage_validation.py tests/test_course_guides.py`
  (DB-backed tests are CI-gated — no local Postgres; these three are offline.)
- Backend-only change — confirmed: no frontend surface touches guide
  validation; no tsc/vitest run needed.

## 7. Out of scope (explicitly)

- No change to `extract_hole_hazards` / `_tree_hazard` sampling.
- No change to tolerance 25, plausibility bounds, window size, or binding.
- No relaxation for the long-single-bunker-extent class (single centroid
  > 25y from a legit claim) — fail-closed; revisit only with evidence from
  the regen results.
