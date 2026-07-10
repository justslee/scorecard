# Caddie slope-framing reconcile — implementation plan

Backlog id: `caddie-slope-framing-reconcile` (P3, minor, low risk, depends on `caddie-green-slope-spatial`).
This plan is the contract; implement it without re-planning. **Pure prose/logic — zero geometry change.**

## 0. The problem (verified in code, 2026-07-09)

Two modules describe the SAME green tilt from opposite ends, and both can surface in one caddie answer:

1. `backend/app/caddie/slope_advice.py::slope_miss_advice()` — APPROACH framing ("where to aim your
   shot into the green"). Surfaced by `backend/app/caddie/aim_point.py:351` as a P2 reasoning line.
   For a slope dropping to the golfer's LEFT (rel ≈ 270°) it currently returns:
   `"Green tilts {qualifier} right to left — favor the right / high side"` (slope_advice.py:100-106).
2. `backend/app/caddie/green_geometry.py::green_read()` — PUTT framing ("which miss leaves the uphill
   putt"). Surfaced by the `get_green_read` tool (`backend/app/caddie/tools.py::green_read_payload`,
   lines 428-482). For the same slope its `read_line` is:
   `"Green falls to your left — right side is the high side; a miss left leaves the uphill putt."`

So one answer can contain "favor the RIGHT" and "miss LEFT for the uphill putt" — geometrically
consistent (both agree RIGHT is the high side; pinned by
`backend/tests/test_green_geometry.py::test_green_read_never_disagrees_with_slope_advice_on_the_high_side`,
lines 257-276) but contradictory-SOUNDING, because slope_advice names only the high side and never says
*why* (aim margin), while green_read names the low side and does say why (uphill putt).

This is a spoken-framing coherence bug, NOT a sign bug. Nothing in this plan touches rotation/sign math.

## 1. Decision: approach (a) — re-frame slope_advice's two lateral strings; touch nothing else

Chosen: **(a)** Rewrite ONLY the two lateral prose strings in `slope_advice.py` so they use the exact
vocabulary and causal chain green_read already speaks (high side / miss-the-low-side-leaves-the-uphill-putt),
while making the APPROACH purpose explicit ("aim ..."). Both purposes then read as one coherent thought:
*aim at the high side; if you miss, the low side leaves the uphill putt.*

Rejected:

- **(b) Suppress/defer one cue.** `generate_recommendation` (aim_point.py) runs before and independently of
  the LLM's tool loop — at compose time it cannot know whether the model will later call `get_green_read`
  for that hole. Suppression would require plumbing session/tool state into a pure function (new coupling,
  new shared state), and it deletes genuinely useful approach advice. Larger diff, worse product, and the
  conditional itself is a new place for a side-selection bug. Rejected.
- **(c) Shared side-naming helper called by both modules.** Requires editing `green_geometry.py` — a module
  the repo has been burned on three times and whose `read_line` is the grounded source of truth the LLM
  cites verbatim (`GREEN_GROUNDING_RULE`). A helper that maps fall_side→high_side is itself a fresh
  opportunity for an inversion, and an import edge between the two modules for two strings is over-
  engineering. The existing cross-consistency test already guarantees the modules agree on geometry; only
  the words need aligning. Rejected.

Why (a) is smallest/safest: it changes two f-strings and comments in one file. `rel` branch logic,
thresholds (45/135/225/315), severity gating, and the `{qualifier}` mechanism are untouched, so no new
sign-error surface exists. green_read stays the single authoritative voice for putt-side facts; slope_advice
merely adopts its vocabulary.

## 2. Exact edits

### 2.1 `backend/app/caddie/slope_advice.py` — the ONLY product-code file touched

**Edit A — rel ≈ 90° branch (lines 86-92).** Replace the returned string:

- OLD:
  ```python
  return (
      f"Green tilts {qualifier} left to right — "
      "favor the left / high side to control your approach angle"
  )
  ```
- NEW (exact):
  ```python
  return (
      f"Green tilts {qualifier} left to right — "
      "aim left, the high side; a miss right sits below the hole and leaves the uphill putt"
  )
  ```

**Edit B — rel ≈ 270° branch (lines 100-106).** Replace the returned string:

- OLD:
  ```python
  return (
      f"Green tilts {qualifier} right to left — "
      "favor the right / high side"
  )
  ```
- NEW (exact):
  ```python
  return (
      f"Green tilts {qualifier} right to left — "
      "aim right, the high side; a miss left sits below the hole and leaves the uphill putt"
  )
  ```

**Edit C — docstring/comments (no behavior).** Add a short "Framing contract" paragraph to the module
docstring (after the "Severity gating" section) stating: the lateral strings deliberately reuse
`green_geometry.GreenRead`'s vocabulary — the HIGH side is where to AIM the approach (safer margin,
above-the-hole feed), the LOW/fall side is where a MISS leaves the uphill putt; same physical tilt, two
purposes, one shared naming; the pairing is pinned by `tests/test_green_geometry.py` Sec.6d. Update the two
branch comments at the edit sites to say `# framing contract: aim = high side; uphill-putt leave = fall/low side`.

Do NOT change: the front-to-back string (lines 82-85), the back-to-front string (lines 96-99), the
`rel` computation, the branch thresholds, `_ADVICE_SEVERITIES`, or the `qualifier` words ("hard"/"moderately").

### 2.2 Files explicitly NOT changed

- `backend/app/caddie/green_geometry.py` — untouched (hard constraint; `read_line`, `GreenRead`,
  `GREEN_GROUNDING_RULE`, all math stay byte-identical).
- `backend/app/caddie/aim_point.py` — no change. It appends `slope_miss_advice()`'s string verbatim at
  priority P2 (line 351-353); the new string drops into the same slot.
- `backend/app/caddie/tools.py::green_read_payload` — no change.
- **Shared types: NOT touched.** No `types.ts` ↔ `models.py` (or `app/caddie/types.py`) sync needed —
  `GreenSlope` and the reasoning payload shapes are unchanged (reasoning is already `list[str]`).
- No DB, no migrations, no network, no new deps, no frontend.

## 3. Four-quadrant coherence check (post-change; the builder verifies each row)

`rel = (slope_direction − approach_bearing) % 360`. green_read's `rel_angle_deg` is the same quantity
(green_geometry.py:163), so the rows line up directly.

| rel quadrant | slope_advice (after) | green_read read_line | Coherent? |
|---|---|---|---|
| ≈ 0° (front-to-back, drops away) | UNCHANGED: "…front-to-back — the back edge is lower; playing to pin depth keeps you below the hole" | "Green runs front to back, away from you — long is below the hole." (depth="long") | Yes — both say back/long is low, no lateral words in either. No edit. |
| ≈ 90° (drops right) | "…left to right — aim left, the high side; a miss right sits below the hole and leaves the uphill putt" | "Green falls to your right — left side is the high side; a miss right leaves the uphill putt." | Yes — identical high side ("left"), identical uphill-leave miss ("right"), shared phrase "leaves the uphill putt". |
| ≈ 180° (back-to-front, drops toward) | UNCHANGED: "…back-to-front — leave it below the hole; miss short" | "Green runs back to front, toward you — short is below the hole." (depth="short") | Yes — both say short is low/below the hole. No edit. |
| ≈ 270° (drops left) | "…right to left — aim right, the high side; a miss left sits below the hole and leaves the uphill putt" | "Green falls to your left — right side is the high side; a miss left leaves the uphill putt." | Yes — the owner case now reads as one thought instead of a contradiction. |

Known, accepted seam (document, don't change): green_read's lateral deadband is ±20° around the line
(DEADBAND_DEG) while slope_advice's quadrants split at ±45°. For rel in e.g. (20°, 45°], green_read names a
fall side while slope_advice speaks only front/back depth. That is coherent-by-omission (slope_advice emits
no lateral word there, so no contradictory-sounding pair is possible) and moving slope_advice's thresholds
would be a logic change — explicitly out of scope.

## 4. Edge cases (all preserved, all already tested)

- `green_slope is None` → `None` (unchanged; `test_none_slope_returns_none`).
- `flat` / `mild` severity → `None`, no noise (unchanged; `TestSeverityGating`,
  `test_flat_slope_adds_nothing_to_reasoning`).
- fall_side=="none" quadrants (rel ≈ 0°/180°): strings unchanged; both already share green_read's
  "below the hole" depth framing (table above) — still read coherently with `uphill_leave_depth`.
- severe vs moderate: `{qualifier}` slot preserved in both new strings — "hard"/"moderately" behavior
  identical (`test_qualifier_word_severe`/`_moderate` keep passing; new exact-string tests below also pin
  the qualifier inside the lateral strings).
- Determinism: pure f-strings, unchanged (`TestDeterminism`).
- NORTHSTAR check: each new string is still ONE short sentence (comparable in length to green_read's
  read_line); no extra reasoning items are added, so the P2 slot count and the reasoning cap behavior in
  `test_reasoning_priority.py` are unaffected.

## 5. Tests — the teeth (write these FIRST; they must FAIL against current strings)

### 5.1 NEW in `backend/tests/test_slope_advice.py` — exact-string pins (fail pre-change)

Add a class `TestLateralFramingContract` with four tests pinning the FULL new strings:

```python
class TestLateralFramingContract:
    """The lateral strings share green_read's vocabulary: aim = HIGH side,
    uphill-putt leave = LOW/fall side. Exact-string pins — a wording drift or a
    side flip fails loudly. (Reconcile: caddie-slope-framing-reconcile.)"""

    def test_moderate_left_to_right_exact(self):
        s = _slope(direction=90.0, severity="moderate")
        assert slope_miss_advice(s, approach_bearing_deg=0.0) == (
            "Green tilts moderately left to right — "
            "aim left, the high side; a miss right sits below the hole and leaves the uphill putt"
        )

    def test_severe_left_to_right_exact(self):
        s = _slope(direction=90.0, severity="severe")
        assert slope_miss_advice(s, approach_bearing_deg=0.0) == (
            "Green tilts hard left to right — "
            "aim left, the high side; a miss right sits below the hole and leaves the uphill putt"
        )

    def test_moderate_right_to_left_exact(self):
        s = _slope(direction=270.0, severity="moderate")
        assert slope_miss_advice(s, approach_bearing_deg=0.0) == (
            "Green tilts moderately right to left — "
            "aim right, the high side; a miss left sits below the hole and leaves the uphill putt"
        )

    def test_severe_right_to_left_exact(self):
        s = _slope(direction=270.0, severity="severe")
        assert slope_miss_advice(s, approach_bearing_deg=0.0) == (
            "Green tilts hard right to left — "
            "aim right, the high side; a miss left sits below the hole and leaves the uphill putt"
        )
```

Pre-change these FAIL (current strings say "favor the … / high side"); post-change they PASS. Load-bearing,
not cosmetic: they pin BOTH the aim side and the uphill-leave side per quadrant, so a future sign flip in
either branch fails all four.

### 5.2 NEW cross-module coherence test in `backend/tests/test_green_geometry.py` (Sec.6d, alongside line 257-276)

```python
@pytest.mark.parametrize(
    "beta,alpha",
    [
        (0.0, 90.0),    # rel=90  — falls right
        (0.0, 270.0),   # rel=270 — falls left (owner case)
        (225.0, 315.0), # rel=90  — falls right, non-trivial beta
        (225.0, 135.0), # rel=270 — falls left, non-trivial beta
    ],
)
def test_slope_advice_lateral_framing_matches_green_read(beta, alpha):
    """Framing reconcile (caddie-slope-framing-reconcile): when both modules
    speak about the same lateral tilt, slope_advice must (1) tell the player to
    AIM at green_read's high side, and (2) name green_read's uphill_leave_side
    as the miss that leaves the uphill putt — same words, no opposite-sounding
    cues. A sign flip in slope_advice's rel branches makes aim==fall_side and
    fails here."""
    read = green_read(alpha, _MODERATE_GRADE, _MODERATE_SEVERITY, beta)
    slope = GreenSlope(
        direction=alpha, severity=_MODERATE_SEVERITY,
        percent_grade=_MODERATE_GRADE, description="test",
    )
    advice = slope_miss_advice(slope, beta)
    assert advice is not None
    low = advice.lower()
    assert f"aim {read.high_side}" in low            # aim = HIGH side
    assert f"aim {read.fall_side}" not in low        # never aim at the low side (sign-flip tooth)
    assert f"a miss {read.uphill_leave_side}" in low # miss low side -> uphill putt
    assert "uphill putt" in low                      # shared causal phrase with read_line
```

Pre-change: FAILS on every row (`"aim ..."` and `"uphill putt"` absent from current strings). Post-change:
PASSES. This is the contract that makes the reconcile durable across future copy edits.

### 5.3 UPDATE (deliberate strengthen) — `test_green_geometry.py:276`

In `test_green_read_never_disagrees_with_slope_advice_on_the_high_side`, the final assertion
`assert expected_high_side_word in advice.lower()` becomes **non-discriminating** after this change
(every lateral advice now contains BOTH side words — "aim right … a miss left …"). Strengthen it to:

```python
    assert f"aim {expected_high_side_word}" in advice.lower()
```

Classification: this is a deliberate assertion update required BY the intended copy change so the test keeps
discriminating high vs low side — it is a strengthening, not a masking. Do not delete or loosen anything
else in that test.

### 5.4 Inventory of existing tests that touch the changed strings (audit — none need edits)

All existing lateral assertions in `backend/tests/test_slope_advice.py` are frame-agnostic substrings that
remain true under the new strings — leave them as-is (keeping them passing on both old and new wording is
fine; they were never the sign guard, 5.1/5.2 now are):

- `TestRightToLeftSlope` (lines 111-135): asserts `"right"`, `"high"` — still present ("aim right, the high side").
- `TestLeftToRightSlope` (lines 141-159): asserts `"left"`, `"high"` — still present.
- `test_boundary_just_above_45_degrees` (lines 235-240): asserts `"left to right"` — phrase preserved verbatim.
- Back-to-front / front-to-back tests (lines 63-105, 165-183, 205-226): strings unchanged, untouched.
- `TestWiredIntoRecommendation` (lines 265-337): keys on `"miss short"`/`"below the hole"` for a
  back-to-front slope — unchanged, untouched.

No test anywhere pins `"favor the"` from these strings (`test_guide_writer.py:234` and
`integration/test_caddie_session_message.py:46` contain their own unrelated "favor the left side" fixtures —
do NOT touch them). `test_reasoning_priority.py` uses a back-to-front slope and never asserts slope prose —
untouched.

## 6. Gates (exact commands; sequence matters)

From `/Users/justinlee/projects/scorecard/backend` (all pure — no DB, no network; CI runs the full suite
including DB tests):

1. **Red first** — add the tests from 5.1 and 5.2 (and the 5.3 strengthen) with slope_advice.py still
   unmodified, then run:
   `uv run pytest tests/test_slope_advice.py::TestLateralFramingContract tests/test_green_geometry.py::test_slope_advice_lateral_framing_matches_green_read -q`
   → EXPECT FAILURES (8 failing: 4 exact-string + 4 parametrized rows). This proves the change is load-bearing.
2. Apply the Section 2.1 edits.
3. `uv run pytest tests/test_slope_advice.py tests/test_green_geometry.py -q` → all pass.
4. `uv run pytest tests/test_reasoning_priority.py -q` → all pass (caller-level, proves P2 slot/cap behavior unchanged).
5. `uv run pytest tests/test_realtime_grounding.py tests/test_caddie_caching.py -q` → all pass
   (proves `GREEN_GROUNDING_RULE` and prompt assembly are byte-identical — we never touched green_geometry.py).
6. Sanity: `git diff --stat` shows exactly 3 files: `app/caddie/slope_advice.py`,
   `tests/test_slope_advice.py`, `tests/test_green_geometry.py`. Anything else = stop, you drifted.

## 7. Classification & impact

- **NOTICEABLE**: the caddie's spoken/reasoning line for moderate/severe side-tilted greens changes wording
  (approach advice now says "aim <side>, the high side; a miss <other side> … leaves the uphill putt").
  Owner-visible on any hole with a mapped lateral green slope.
- No shared-type change (types.ts / models.py / app/caddie/types.py untouched), no API shape change
  (reasoning stays `list[str]`), no DB, no migration, no frontend, no new deps, no prompt/grounding-rule change.
- Risk: low. Geometry, thresholds, gating, and green_geometry.py are byte-identical; the only behavior
  delta is two prose strings, and the new cross-module test makes any future divergence (wording OR sign)
  fail CI.

## 8. Builder sequencing (summary)

1. Write 5.1 + 5.2 tests, apply 5.3 strengthen → run gate 1 → confirm red.
2. Apply Edits A + B + C in `slope_advice.py`.
3. Run gates 3-6 → confirm green and diff scope.
