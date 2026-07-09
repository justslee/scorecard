# Carry-Aware Side Validation — Implementation Plan

Precision fix to `validate_guide`'s side-flip pass (`backend/app/caddie/guide_writer.py`).
Today `sides_by_type: dict[str, set[str]]` collapses away `carry_yards`, so on Bethpage
hole 4 (bunkers L~275 / R~390 / C~470-495) `_acceptable_sides("bunker")` = {left, right}
and the FALSE claim "right bunkers off the tee at 265" passes. Fix: when a side claim
co-occurs with a yardage number, validate the (side, carry) PAIR against real hazards.
Fail-closed throughout; whole-guide reject (return `None`), never a scrub or placeholder
(NORTHSTAR: honest empties, no fabricated data).

**Only logic file changed:** `backend/app/caddie/guide_writer.py`. Backend-only — no
frontend impact (tsc/lint/build/voice-tests unaffected).

## 1. Data structure change (in `validate_guide`, ~line 513)

Replace the `sides_by_type` build with a structure that retains carries:

```python
hazards_by_type: dict[str, list[tuple[str, int]]] = {}   # type -> [(line_side, carry_yards)]
for hz in hazards:
    hazards_by_type.setdefault(hz.type, []).append((hz.line_side, hz.carry_yards))
```

(`Hazard.line_side: str` and `.carry_yards: int` — `backend/app/caddie/types.py:58`.)

Pass `hazards_by_type` to `_has_side_flip`. Inside `_has_side_flip`, derive
`sides_by_type = {t: {s for s, _ in pairs} for t, pairs in hazards_by_type.items()}`
once at the top so `_acceptable_sides` keeps its EXACT current signature and semantics
for the no-number path. Update rule 6 of the `validate_guide` docstring and the
`_has_side_flip` docstring to describe the carry-aware behavior.

## 2. New constants (next to `_SIDE_WINDOW_WORDS`, ~line 357)

```python
_CARRY_TOLERANCE_YARDS = 25
_MIN_PLAUSIBLE_CARRY = 100   # below this, "hole 12"/"par 4"-style numbers, never a claimed carry
_MAX_PLAUSIBLE_CARRY = 650
_CARRY_NUMBER_PATTERN = re.compile(
    r"\b(\d{2,3})(?!\d)(?:\s*[-–]\s*\d{2,3}(?!\d))?\s*(?:y(?:ds?)?|yards?)?\b"
)
```

Binding rules (builder must pin each with a test or inline comment):
- Group 1 is the bound value; for a range ("470-495") bind the FIRST number (the range
  tail is consumed by the same match so 495 never binds separately). "265", "390y",
  "390 yds", "390 yards" all bind 265/390.
- After regex match, parse `int(group(1))` and DISCARD the match unless
  `_MIN_PLAUSIBLE_CARRY <= n <= _MAX_PLAUSIBLE_CARRY`. This (plus the 2-3-digit regex
  and `(?!\d)` guards) prevents binding "par 4", "hole 7", "in 2", "hole 12", or a
  digit-run fragment of a longer number.
- A discarded/implausible number is as if absent — the occurrence falls back to the
  side-only path. Never widen: implausible numbers must not auto-pass anything.

## 3. Algorithm change in `_has_side_flip` (~lines 386-463)

Keep the existing per-field tokenization, `_word_idx`, side-hit collection, opposition
exclusion (`_SIDE_OPPOSITION_PATTERN`), window, and nearest-side selection UNCHANGED.
Per field, additionally collect number hits once:
`number_hits = [(_word_idx(m.start(1)), int(m.group(1))) for m in _CARRY_NUMBER_PATTERN.finditer(lowered) if plausible]`.

For each hazard-keyword occurrence (`hz_idx`), AFTER the existing nearest-side selection
produces `nearest_side` (i.e. only when a non-opposition side claim is bound — a keyword
with no bound side word stays ignored exactly as today, including "carry the bunker at
265" with no side word, and "miss right of the bunker at 240" where opposition excludes
the side):

1. Candidate numbers: `abs(idx - hz_idx) <= _SIDE_WINDOW_WORDS` (reuse the same window
   constant; distance is to the HAZARD keyword occurrence, never to the side word, and
   never "any number in the field").
2. Nearest number: `min(candidates, key=lambda hit: (abs(hit[0] - hz_idx), hit[0] < hz_idx))`
   — identical tie-break style to the side selection: ties prefer the number AFTER the
   keyword. No opposition filtering for numbers (pure proximity binding; see edge table
   for the accepted lay-up over-rejection).
3. **No bound number** → current behavior verbatim:
   `nearest_side not in _acceptable_sides(canonical_type, sides_by_type)` → return True.
4. **Bound number `n`** → new helper decides; on failure return True (reject):

```python
def _side_and_carry_supported(
    canonical_type: str,
    claimed_side: str,
    claimed_carry: int,
    hazards_by_type: dict[str, list[tuple[str, int]]],
) -> bool:
    """True iff a real hazard of this type sits on the claimed side (a 'center'/on-line
    hazard supports EITHER lateral side, mirroring _acceptable_sides) AND its surveyed
    carry_yards is within _CARRY_TOLERANCE_YARDS of the claimed number."""
    return any(
        (side == claimed_side or side == "center")
        and abs(carry - claimed_carry) <= _CARRY_TOLERANCE_YARDS
        for side, carry in hazards_by_type.get(canonical_type, [])
    )
```

Anti-bypass invariant (a reviewer will attack this both directions): EACH hazard-keyword
occurrence binds its OWN nearest side and its OWN nearest number. A truthful
"right bunker at 390" elsewhere in the field must never launder a co-located false
"left bunker at 390" or "right bunker at 265" — each occurrence is checked independently
and ANY failing occurrence rejects the whole guide.

## 4. Edge-case table (behavioral contract)

Geometry shorthand: H4 = bunkers L@275, R@390, C@470 + C@495 (hole-4 shape).

| Guide text (type is mapped) | Geometry | Result | Why |
|---|---|---|---|
| "the right bunker at 390" | H4 | PASS | R@390 within ±25 |
| "right bunkers off the tee at 265" | H4 | REJECT | nearest right/center carries 390/470 — not within ±25 of 265 (the incident lie) |
| "right bunker at 390 ... left bunker at 390" (one field) | H4 | REJECT | 2nd occurrence binds its own 390; L is @275 |
| "right bunker at 390 is fine; the right bunker at 265 crosses" | H4 | REJECT | per-occurrence nearest number; 265 can't borrow 390 |
| "right-side bunkers" (no number) | H4 | PASS | unchanged side-only path; right ∈ acceptable sides |
| "right-side bunkers" (no number) | L-only bunker | REJECT | unchanged (incident regression tests) |
| "carry the bunker at 265" (no side word) | any | ignored | no side claim bound — unchanged; distance-only claims out of scope |
| "miss right of the fairway bunker at 240" | L@245 | ignored | opposition excludes the side word → no side claim → number never checked |
| "bunker left at 220" | C@220 | PASS | center supports either side; carry matches |
| "bunker left at 300" | C@220 | REJECT | side ok via center, carry off by 80 |
| "right bunker" + number >6 words away | H4 | PASS | number outside window → side-only path |
| "bunker left on hole 12" | L@245 | PASS | 12 < 100 → implausible, not bound → side-only |
| "bunkers at 470-495 dead center... right" | H4 | PASS | range binds 470; C@470 within ±25 |
| "lay up to 240, short of the left bunker" | L@280 | REJECT | accepted fail-closed cost: target yardage binds by proximity; document in a code comment (precision over leniency, honest empty) |

## 5. Tests (the teeth)

### `backend/tests/test_bethpage_validation.py` — `TestHole4HazardSideRegression` (~line 409), REAL fixture hazards
Add two tests (assert the fixture precondition first so drift is diagnosable):
1. **Hole-4 TRUTH passes:** precondition `any(h.line_side == "right" and abs(h.carry_yards - 390) <= 25 for h in hole4_hazards)`; then a guide with e.g. `miss_side="The right bunker at 390 pinches the second landing zone."` → `validate_guide(guide, hole4_hazards) is not None`.
2. **Incident LIE rejects:** guide with `miss_side="Watch the right bunkers off the tee at 265."` against the SAME full `hole4_hazards` list → `is None`. (This is the claim the old side-set check could NOT reject — see `test_full_hazard_list_side_sets_are_pinned`; update only that test's reality-note docstring to say the carry-aware check now closes the numbered variant while bare no-number "right bunkers" remains side-set-backed. No assertion changes.)

### `backend/tests/test_guide_writer.py` — side-check block (starts ~line 318), synthetic hazards
Add a helper `_hole4_like_bunkers()` returning `[Hazard(type="bunker", line_side="left", carry_yards=275), (right, 390), (center, 470)]` (set `side` too, matching existing helpers). New tests:
- side + correct distance PASS: "the right bunker at 390" → not None; also "390y" and "390 yards" variants.
- side + wrong distance REJECT: "the right bunker at 265" → None.
- number-stuffing bypass REJECT: one field containing BOTH a true "right bunker at 390" phrase AND a false "left bunker at 390" phrase → None.
- no-number claims unchanged: "right-side bunkers" vs `_hole4_like_bunkers()` → not None (side set contains right); and vs `_left_bunker()` → None (existing behavior).
- window boundary: number >`_SIDE_WINDOW_WORDS` words from the keyword is not bound → side-only path passes for a true side.
- implausible number not bound: "bunker left on hole 12" vs `_left_bunker()` → not None.
- range binding: "bunkers dead center at 470-495" style claim vs `_hole4_like_bunkers()` → not None (binds 470).

### Regression (must pass UNCHANGED)
- ALL existing side-check tests, `test_guide_writer.py` ~lines 342-448 — verified compatible: the only existing side+number text is "Carry the bunkers on the right at 265." vs L@245, which now rejects via the carry path instead of the side path (same outcome).
- Eval Tier-1 (`backend/tests/eval`) — verified compatible: golden `validate_guide_rejects` guides with numbers ("right at 265" vs L@290, "left at 265" vs R@290, "left at 220" vs no hazards) still reject; all `validate_guide_accepts` guides contain no bound side+number pair. Do not edit golden files.

## 6. Verification gates (builder runs; no local Postgres — DB-backed tests run in CI)

```
cd backend && ruff check .
cd backend && pytest tests/test_guide_writer.py tests/test_bethpage_validation.py tests/eval
```

Frontend gates (tsc/lint/build/voice-tests) are unaffected — backend-only change; do not run or modify frontend.
