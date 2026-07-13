# Guide Validator: Cross-Side Number Binding Fix — Implementation Plan

**File under change:** `backend/app/caddie/guide_writer.py` (only)
**Tests under change:** `backend/tests/test_guide_writer.py` (additions only — no existing test edited)
**Scope:** internal validator logic only. No shared shapes touched — `frontend/src/lib/types.ts` / `backend/app/models.py` sync is not implicated.
**Design simulated end-to-end** against the live `_side_and_carry_supported`/`_acceptable_sides` predicates on a 31-case matrix: 31/31 correct, and the ONLY old→new accept flips are the three grounded Black 11 variants. Current gate baseline: 137/137 passing.

---

## 1. Root cause

`_has_side_flip` (`guide_writer.py` L499–650) anchors on each hazard-keyword occurrence and:

1. Builds `candidates` — every left/right word within `_SIDE_WINDOW_WORDS=6` words of the keyword, minus opposition-separated ones (L592–611).
2. Collapses them to ONE `nearest_side` per keyword occurrence (L615–618: nearest by word distance, ties prefer the side word after the keyword).
3. Binds EVERY plausible number within 6 words of the keyword (L634–636) and requires ALL of them to be supported on that single `nearest_side` (L643–649).

Step 3's "ALL numbers on ONE side" is the defect. It was a deliberate cycle-115 fail-closed fix (comment block L621–633) for the co-located-false-number bypass ("The 265-yard right bunker sits 390 off the tee" — a nearest-number tie-break let the false 265 hide behind the true 390). Requiring every in-window number to be supported closed that — but by binding numbers to the *keyword's* side rather than to the side word each number *grammatically claims*, it cannot tell two adjacent cross-side clauses apart.

Bethpage BLACK 11 (par 4), geometry bunker LEFT {245, 415}, bunker RIGHT {270, 325, 420}. Grounded text: `"the 245-left bunker and the 270/325 right-side bunkers"`. Tokenization (verified against the live patterns): tokens `the(0) 245-left(1) bunker(2) and(3) the(4) 270/325(5) right-side(6) bunkers(7)`; numbers `245@1, 270@5, 325@5`; sides `left@1, right@6`; keywords `bunker@2, bunkers@7`.

- Keyword `bunker@2`: `nearest_side = left` (dist 1). In-window numbers: 245, 270, 325 — ALL checked as `(bunker, left, n)`. 270 and 325 are RIGHT carries → `_side_and_carry_supported("bunker","left",270,…)` is False → whole guide rejected.
- Mirror failure on `bunkers@7`: `nearest_side = right` sweeps up 245 (dist 6, in-window) → `(bunker, right, 245)` False → rejects again.

Every number in the text is grounded on its true side; the guide is false-rejected and BLACK 11 stays honest-empty forever. `validate_guide` docstring rule 6 (L674–702) describes the old binding and must be updated.

**Untouched (correct, reviewer-cleared):** `_carry_runs` (L428–456), `_side_and_carry_supported` (L459–496), `_acceptable_sides` (L419–425), all constants (`_SIDE_PATTERN` L370, `_SIDE_WINDOW_WORDS` L371, `_SIDE_OPPOSITION_PATTERN` L386–388, carry constants L399–401, `_CARRY_BRIDGE_YARDS` L413, `_CARRY_NUMBER_PATTERN` L414–416), `_HAZARD_PATTERNS`, and the type scan / injection / structural checks in `validate_guide`.

---

## 2. Design decision: per-number side attribution (option 2), no segmentation

### Option 1 — clause/segment scoping: REJECTED

Splitting fields on `","`/`";"`/`" and "`/`" but "`/`" then "`/`" while "` and grouping hazard+side+numbers per segment fails on two grounds:

1. **It breaks legitimate number lists.** RED 8's grounded shape `"left bunkers at 160 and 195"` uses "and" as a *list* conjunction inside one claim. Any segmentation that splits BLACK 11's "and" also strands `195` in its own hazard-less, side-less segment. There is no reliable lexical test distinguishing list-"and" from clause-"and".
2. **It creates the cross-clause-smuggle escape hatch.** A number stranded in a segment with no hazard keyword must either be ignored (a fabricated number now escapes checking entirely — a strict LOOSENING of the guard) or re-attached across the boundary (which reintroduces exactly the cross-contamination being fixed). Segmentation converts the false-reject bug into a false-accept bug; fail-closed forbids that trade.

### Option 3 — hybrid (segmentation limiting attribution candidates): REJECTED

The 6-word keyword window already bounds how far a foreign side word can pollute attribution; adding clause boundaries on top buys almost nothing while importing option 1's list-"and" ambiguity into the candidate filter. More moving parts, same guarantees.

### Option 2 — per-number side attribution: CHOSEN

Keep everything about the existing per-keyword anchoring — window, opposition exclusion, hazard-first/side-first span logic, `nearest_side`, and the "check EVERY in-window number" invariant (the cycle-115 guarantee). Change only *which side* each bound number is checked against: the side word **nearest to that number** among the keyword's own candidate set, i.e. the side the number grammatically claims ("245-left", "265-yard right bunker", "right … at 390" all place the governing side word adjacent-or-nearest to the number). Ambiguity (a distance tie between different side values) collapses to the old binding (`nearest_side`), so ties can never accept anything the cycle-115 code rejected.

Plus one fail-closed addition, discovered during design and required for soundness: the keyword's `nearest_side` **side-only check now runs unconditionally**, not only when no numbers bound. Without it, per-number attribution opens a new escape: `"the right bunker and the 245 left bunker"` on a left-only hole — `nearest_side("bunker"@2) = right`, but 245 attributes to `left` and passes, leaving the flipped "right bunker" claim unchecked by any pair. The unconditional side check closes it. Crucially, this addition is **behaviorally invisible on every previously-passing input**, by the implication proven in §2a.

### 2a. Accept-set proof sketch (include a condensed version in the code comment)

Notation per keyword occurrence *k*: `ns(k)` = nearest side (unchanged computation), `W(k)` = in-window plausible numbers (unchanged), `attr(n)` = per-number attributed side, with `attr(n) = ns(k)` on a distance tie between different side values.

- **Old rule:** if `W(k)` empty → `ns(k) ∈ _acceptable_sides` else reject. If non-empty → `∀n ∈ W(k): supported(type, ns(k), n)` else reject.
- **New rule:** `ns(k) ∈ _acceptable_sides` (always) AND `∀n ∈ W(k): supported(type, attr(n), n)`.

Key implication: `_side_and_carry_supported(type, s, n)` = True requires a non-empty carry group for `s` or `"center"` (L487–495) ⇒ `s ∈ sides_by_type[type]`, or `"center" ∈ sides` ⇒ `_acceptable_sides ⊇ {left, right}` (L419–425). Either way `s ∈ _acceptable_sides(type)`. Therefore **any passing pair check implies the side-only check for that side** — making the unconditional side check free on old accepts:

- **Single side word in the field** (covers cycle-115, number-stuffing per-occurrence, all single-clause guides): `attr(n) = ns(k)` for every n → pair checks byte-identical to old; side-only check implied by any pair pass, identical to old when `W(k)` empty. **Old ≡ new.**
- **No numbers bound:** pair loop empty; side-only check verbatim old behavior. **Old ≡ new.**
- **Distance ties:** collapse to `ns(k)` → the checked pair is exactly the old pair. **No new accepts via ties.**
- **The only inputs that flip reject→accept:** multi-side-word fields where some `n` is strictly nearest to a *different* candidate side word than `ns(k)`, is supported on that attributed side, AND `ns(k)` itself is a real side. That is precisely the grammatically-correctly-attributed cross-side set (BLACK 11).
- **The only inputs that flip accept→reject:** some `n` strictly nearest to a side word that does NOT support it while `ns(k)` did, or a number-less flipped `ns(k)` whose numbers all attribute elsewhere — both are *more* correct rejections of wrong-side claims. Nothing previously-rejected-and-fabricated becomes acceptable.

---

## 3. The algorithm, token/index level

All inside `_has_side_flip`, per field / per keyword occurrence. Steps 1–6 are byte-for-byte today's code; 7–9 are the change.

1. `lowered = field.lower()`; `tokens = re.finditer(r"\S+", lowered)`; `_word_idx` closure — **unchanged** (L557–566).
2. `side_hits = [(word_idx, side, char_start, char_end)]` from `_SIDE_PATTERN` — **unchanged** (L568–573). `_word_idx(m.start())` gives the *token* index, so `"245-left"` puts the side at token 1.
3. `number_hits = [(word_idx, n)]` from `_CARRY_NUMBER_PATTERN.finditer`, plausibility-filtered by `_MIN/_MAX_PLAUSIBLE_CARRY` — **unchanged** (L578–582). `_word_idx(m.start(1))` means `"270/325"` yields two hits both at token 5, and a range `"470-495"` yields one hit (470).
4. Per canonical type present in `sides_by_type`, per `_HAZARD_PATTERNS[type]` match: `hz_idx`, `hz_start`, `hz_end` — **unchanged** (L584–590).
5. `candidates = [(idx, side)]`: window `abs(idx - hz_idx) <= _SIDE_WINDOW_WORDS`; the hazard-first (exclude side word from span) vs side-first (include it) `between` slice; `_SIDE_OPPOSITION_PATTERN.search(between)` exclusion — **unchanged verbatim** (L592–611). Opposition-excluded side words can never govern a number either (they never enter `candidates`), preserving "away from the left bunker" semantics automatically.
6. `if not candidates: continue`; `nearest_side = min(candidates, key=lambda hit: (abs(hit[0] - hz_idx), hit[0] < hz_idx))` — **unchanged** (L613–618).
7. **NEW — unconditional side-only check, hoisted out of the no-numbers branch:**
   ```
   if nearest_side not in _acceptable_sides(canonical_type, sides_by_type): return True
   ```
   (Same expression as today's L639–640, executed before number binding instead of only when `number_candidates` is empty.) When no numbers bind, control then hits an empty pair loop — the no-number path is behaviorally verbatim. `_acceptable_sides` center handling preserved untouched.
8. `number_candidates = [hit for hit in number_hits if abs(hit[0] - hz_idx) <= _SIDE_WINDOW_WORDS]` — **unchanged** (L634–636). Every in-window plausible number is still checked; none dropped (cycle-115 invariant intact).
9. **NEW — per-number attribution replaces the single-side pair check** (replaces L637–649):
   For each `(n_idx, carry)` in `number_candidates`:
   - `best = min(abs(c_idx - n_idx) for (c_idx, _) in candidates)`
   - `tied_sides = {side for (c_idx, side) in candidates if abs(c_idx - n_idx) == best}` (a set of side *values*, so two occurrences of the same word don't fake a tie)
   - `attributed = tied_sides.pop() if len(tied_sides) == 1 else nearest_side` — **tie ⇒ collapse to the cycle-115 binding** (grammar genuinely ambiguous; check exactly the pair the old fail-closed code checked, so ties admit no new accepts).
   - `if not _side_and_carry_supported(canonical_type, attributed, carry, hazards_by_type): return True`

Distance is word-index distance between the number's token and the side word's token; `"245-left"` is distance 0 (same token). Attribution candidates are exactly the keyword's `candidates` — a side word out of the keyword's window or opposition-excluded can never govern a number bound to that keyword.

---

## 4. Exact edits

All in `backend/app/caddie/guide_writer.py`. No signature changes; `_has_side_flip(text_fields, hazards_by_type) -> bool` unchanged externally.

1. **Optional small helper** (recommended, matches the file's `_carry_runs`-style decomposition): module-level `_attributed_side(n_idx, candidates, nearest_side) -> str` implementing step 9's attribution + tie-collapse, with a docstring explaining: per-number grammatical binding, why candidates are the keyword's opposition-filtered set, and why ties collapse to `nearest_side` (fail-closed to cycle-115 semantics — cite "The 265-yard right bunker sits 390 off the tee"). Placed between `_side_and_carry_supported` and `_has_side_flip`. (Inlining acceptable but the helper makes the tie rule directly unit-testable.)
2. **`_has_side_flip` body** (L613–649 region): hoist the `_acceptable_sides` check to run unconditionally after `nearest_side` is computed; keep `number_candidates` construction verbatim; replace the `any(not _side_and_carry_supported(canonical_type, nearest_side, …))` block with the per-number attributed-pair loop.
3. **`_has_side_flip` docstring** (L503–552): rewrite the CARRY-AWARE EXTENSION paragraph. Must state: every in-window plausible number is STILL checked (cycle-115 all-numbers invariant intact — keep the 265/390 example verbatim); what changed is the side each number is checked AGAINST — the side word nearest to THAT number among the keyword's opposition-filtered candidates, tie ⇒ `nearest_side`; the keyword's `nearest_side` is now ALWAYS side-only checked (with the "the right bunker and the 245 left bunker" escape as rationale, and the §2a one-line implication for why this is invisible on old accepts); the BLACK 11 cross-side false-reject as the motivating incident (this plan's filename as citation).
4. **The L620–633 comment block** above the number-binding code: keep the cycle-115 rationale, extend it with the cross-side-binding rationale rather than replacing it (the reviewer history there is load-bearing).
5. **`validate_guide` docstring rule 6** (L674–702): update the CARRY-AWARE sentence — the (side, carry) pair is now (per-number attributed side, number), each number bound to the side word grammatically nearest it within the keyword's window; keyword-nearest side is always side-only checked; a legitimately both-sides sentence no longer cross-contaminates. Everything else in rule 6 stays.
6. **Nothing else.** No edits to `_carry_runs`, `_side_and_carry_supported`, `_acceptable_sides`, any constant, any pattern, the type scan, injection scan, or structural checks.

---

## 5. Test matrix

New section in `backend/tests/test_guide_writer.py`, header `# ── Cross-side number binding (guide-validator-cross-side-binding-plan.md) ──`, following the file's `_guide(...)`/fixture-helper conventions. New fixture `_black11_like_both_sides()` → bunker L {245, 415}, R {270, 325, 420}.

**MUST REJECT (`validate_guide(...) is None`):**

| # | Text | Geometry | Why |
|---|---|---|---|
| R1 true side-flip w/ number | `"bunker left at 245 catches drives"` | bunker R-only {245} | 245 attributes left; left empty → pair fails; side-only also fails |
| R2 cycle-115 co-located (existing `test_carry_check_rejects_tie_break_laundering`, unedited) | `"The 265-yard right bunker sits 390 off the tee."` | hole4-like | single side word ⇒ attr ≡ nearest_side; (right,265) fails |
| R3 number-stuffing (existing test, unedited) | `"The right bunker at 390 is fine; the left bunker at 390 is not."` | hole4-like | 2nd keyword's 390 attributes left → fails |
| R4 wrong-side in legit both-sides | `"the 300-left bunker and the 270 right-side bunkers"` | black11-like | 300 attributes left; left runs [220,270]∪[390,440]; 300 ∉ |
| R5 cross-clause smuggle | `"the 245-left bunker, and a bunker at 380 right"` | black11-like | 380 attributes right; right windows [245,350]∪[395,445]; 380 ∉ |
| R6 reattribution escape (pins the new unconditional side check) | `"the right bunker and the 245 left bunker"` | left-only {245} | 245 attributes left (passes) but nearest_side(bunker@2)=right unchecked by any pair → side-only must catch |
| R7 tie collapses to nearest_side | `"left rough 390 by right bunker"` | bunker L{390} R{200} | 390 tie → nearest_side=right → (right,390) ∉ [175,225] |
| R8 side + wrong distance (existing tests, unedited) | `"The right bunker at 265 …"` | hole4-like | unchanged |
| R9 genuine-gap fabrication (existing carry-span tests, unedited) | BLACK7/11 fixtures | unchanged |

**MUST PASS (`validate_guide(...) is not None`):**

| # | Text | Geometry | Notes |
|---|---|---|---|
| P1 BLACK 11 verbatim | `"the 245-left bunker and the 270/325 right-side bunkers"` | black11-like | THE incident; both occurrences pass |
| P2 mirror order | `"the 270/325 right-side bunkers and the 245-left bunker"` | same | order-independence |
| P3 embedded | `"Favor the gap between the 245-left bunker and the 270/325 right-side bunkers."` | same | 245 at dist-6 from `bunkers`, boundary-inclusive |
| P4 RED 8 list-"and" | `"left bunkers at 160 and 195 guard the drive"` | RED8 L{160,195,365} R{225,360} | no segmentation regression; 160→195 bridges |
| P5 tie companion to R7 | `"left rough 390 by right bunker"` | bunker L{200} R{390} | tie → nearest_side=right → (right,390) supported |
| P7 range binds first (existing test, unedited) | `"Bunkers right at 470-495 …"` | hole4-like | unchanged; center path exercised |
| P8 out-of-window never binds (existing, unedited) | | hole4-like | unchanged |
| P9 no-number side-only pair (existing, unedited) | | | pins no-number path verbatim |
| P10 opposition (existing, unedited) | "away from the right bunkers" (reject), "Miss right of the fairway bunker" (pass), "bunker right of the fairway" (reject) | | opposition-excluded side words neither anchor nor govern |
| P11 implausible numbers (existing, unedited) | `"Bunker left on hole 12 …"` | left-only | unchanged |
| P12 single-sample ±25 edges (existing, unedited) | | | tolerance math untouched |

**Optional direct-helper tests** (if `_attributed_side` added): unique-nearest wins; same-side-value "tie" is not a tie; different-side-value tie returns `nearest_side`.

**Edge cases (no code change, note in comments):**
- Numbers in-window but NO candidate side words → keyword skipped before any check (today's behavior).
- Side word in one clause, hazard adjacent within 6 words ("trouble right, and the bunker at 245", L-only) → still rejects (pre-existing conservative fail-closed).
- **Known pre-existing limitation, NOT fixed here (document, do not test-pin a false-reject):** cross-TYPE number pollution — `"bunker left at 245 and water right at 190"` false-rejects under old AND new (245 in the `water` keyword's window, checked vs water geometry). Per-number *side* attribution cannot fix number→*keyword/type* binding. Rejects identically before/after — zero regression — follow-up candidate, out of scope.

---

## 6. Gates

From `backend/`:
1. `ruff check .` — clean.
2. Full cycle-116 gate set (verified today: 137 passed, offline/no-DB):
   ```
   uv run pytest tests/test_guide_writer.py tests/test_bethpage_validation.py \
     tests/test_course_guides.py tests/test_regen_rejected_guides.py \
     tests/test_guide_read_revalidation.py tests/test_session_guide_revalidate.py \
     tests/test_guide_consumption.py
   ```
   Expected: 137 + new tests passed, zero existing tests modified, zero flips. In particular `test_carry_check_rejects_tie_break_laundering`, `test_carry_check_rejects_number_stuffing_bypass`, `test_carry_check_rejects_side_with_wrong_distance`, all `test_carry_span_*`, all `test_side_check_*` must pass unedited.
3. Backend-only — no frontend surface reads validator internals; no tsc/vitest needed.
4. After merge, BLACK 7+11 regen is an on-box eng-lead step per the existing `backend/scripts/regen_rejected_guides.py` runbook (black UUID `2b8caab5-2c55-5752-8cda-336c3a396dac`) — out of builder scope.

---

## 7. Risks & adversarial review focus

1. **Hardest angle — new accepts via attribution.** Reviewer should construct a fabricated number that a) sits in a keyword window, b) is strictly nearest to a side word whose geometry *happens* to support it, while the sentence semantically claims the other side. §2a: attribution follows the side word nearest the number — what a human reader binds it to. The genuinely ambiguous middle (exact ties) collapses to the cycle-115 binding, admitting nothing new. Push with concrete sentences; tie-collapse is the backstop.
2. **The unconditional side-only check must be provably free on old accepts.** The §2a implication (`_side_and_carry_supported` pass ⇒ side ∈ `_acceptable_sides`, incl. the center-group path L487–495 vs L424–425) is the load-bearing lemma; a future edit to either function could silently break the equivalence. Builder should note this coupling in both docstrings.
3. **Tie subtleties.** Ties are over side *values*, not occurrences; distance is token-index based, so "245-left" is distance 0. Reviewer should check `_word_idx(m.start(1))` (range/slash) and `_word_idx(m.start())` (sides) stay consistent.
4. **Window boundary drift.** P3 places 245 at exactly distance 6 from `bunkers`; an off-by-one surfaces there.
5. **What this does NOT fix** (not a regression): cross-type number pollution / cross-type nearest-side mis-anchoring (§5 last bullet) false-reject identically before and after. Fail-closed preserved.
