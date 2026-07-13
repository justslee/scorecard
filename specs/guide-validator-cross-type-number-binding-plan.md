# Guide Validator: Cross-Type Number Binding Fix — Implementation Plan

**File under change:** `backend/app/caddie/guide_writer.py` (only)
**Tests under change:** `backend/tests/test_guide_writer.py` (additions only — no existing test edited)
**Scope:** internal validator logic only. No shared shapes touched — `frontend/src/lib/types.ts` / `backend/app/models.py` sync is not implicated (§6).
**Sibling:** `specs/guide-validator-cross-side-binding-plan.md` (cycle 118, landed 12cec56). This plan is the TYPE axis of the same number-binding bug and mirrors that plan's structure and §2a proof style.
**Baseline pinned:** `tests/test_guide_writer.py` 97 in-file tests / 160 across the 7-file validator suite, all green, none edited.

---

## 0. FINALIZED RULE — one paragraph, plus one directive correction

**The rule as finalized:** within `_has_side_flip`, per text field, build the set of *checking occurrences* — every hazard-keyword occurrence of a type PRESENT in `sides_by_type` (matched by `_NUMBER_BINDING_PATTERNS`, defined below) that has ≥1 window-filtered, opposition-excluded candidate side word. At a checking occurrence `k` of type `T`, an in-window plausible number `n` is checked against `T` **unless a checking occurrence of a DIFFERENT present type is STRICTLY nearer to `n`** (word-index distance), in which case `n` is skipped at `k` and checked at its globally-nearest checking occurrence(s) instead — against THAT occurrence's type, with side attribution via the existing `_attributed_side` computed from THAT occurrence's own candidates. A cross-type distance **tie is not a steal**: every tied occurrence checks the number (fail-closed — ambiguity means the number must be grounded against every tied nearest type). Same-type occurrences NEVER shadow each other — within one type, cycle-115/118 semantics are byte-identical. `trees` occurrences participate as owners/checkers for *re-routed numbers only* (see the correction below); everything else about the validator — the type scan, `_acceptable_sides`, `_attributed_side`, `_side_and_carry_supported`, `_carry_runs`, all constants, the unconditional keyword `nearest_side` side-only check, injection/newline/length checks — is untouched.

**Directive correction (must-read; discovered during design, changes nothing about intent):** the cycle-119 directive says "attribute each number to the nearest keyword occurrence across ALL present-type keyword occurrences." As literally stated against today's code, **that does not fix the observed incident**, because `trees` has NO keyword in `_HAZARD_KEYWORD_TO_TYPE` (L322–337) and therefore no pattern in `_HAZARD_PATTERNS` (L346–353): a "trees … 190 right" phrase produces **zero** keyword occurrences, so 190's globally-nearest occurrence is still "bunkers" and the false-reject survives verbatim. The fix therefore introduces a **binding/ownership-only** trees pattern (`_NUMBER_BINDING_PATTERNS = {**_HAZARD_PATTERNS, "trees": …}`), used ONLY inside `_has_side_flip` for number ownership and for checking re-routed numbers against trees geometry. It is deliberately NOT added to `_HAZARD_KEYWORD_TO_TYPE`, so the `validate_guide` type scan (L800–804) is byte-identical — adding trees there would newly reject every honest tree mention on holes whose OSM data has no trees mapped (OSM tree coverage is sparse; e.g. Red 3 has zero mapped trees per the cycle-52 record), a false-reject expansion this cycle must not ship.

---

## 1. Mechanism: how today's per-type binding leaks across types

`_has_side_flip` (`guide_writer.py` L528–730), per field:

1. `side_hits` from `_SIDE_PATTERN` (L619–624); `number_hits` from `_CARRY_NUMBER_PATTERN`, plausibility-filtered to `[100, 650]` (L629–633).
2. **Outer loop `for canonical_type in sides_by_type:`** (L635) with `pattern = _HAZARD_PATTERNS.get(canonical_type)` (L636–638) — each present type is processed in isolation.
3. Per keyword occurrence of THAT type: `candidates` (window 6 + opposition filter, L643–662), `nearest_side` (L666–670), the cycle-118 unconditional side-only check (L685–686).
4. `number_candidates = [hit for hit in number_hits if abs(hit[0] - hz_idx) <= _SIDE_WINDOW_WORDS]` (L717–719) — **EVERY plausible number within 6 words of THIS type's keyword**, with no awareness that a different present type's keyword may sit grammatically closer to the number.
5. Each such number is checked `_side_and_carry_supported(canonical_type, attributed, carry, …)` (L724–729) — i.e. against **THIS type's geometry**, whatever phrase the number actually belongs to.

So in a multi-hazard sentence, proximity leaks across types: a number that grammatically belongs to hazard type A's phrase but sits ≤6 words from a type-B keyword is demanded to be a type-B carry. Cycle 118 fixed exactly this bug on the SIDE axis (`_attributed_side`, L499–525); the TYPE axis was documented as the known residual in the sibling plan §5 (last bullet) and observed live in cycle 118's Black 11 regen:

**Observed incident (Bethpage Black 11 regen candidate, cycle-118 record in `tasks/progress.md`):** a trees carry "190 right" in the same sentence as a "bunkers" phrase. 190 is a REAL right-side trees carry in Black 11's geometry, but it lands inside the "bunkers" keyword's 6-word window, `_attributed_side` binds it to "right", and it is checked as `_side_and_carry_supported("bunker", "right", 190, …)` against bunker right {270, 325, 420} → runs [245,350] ∪ [395,445] → 190 ∉ either → the fully-grounded guide is false-rejected and Black 11 stays honest-empty.

Representative shape (token math verified against the live regexes — `_word_idx` gives token indices): `"Lay up short of the bunkers, with trees right at 190."` → tokens `lay(0) up(1) short(2) of(3) the(4) bunkers,(5) with(6) trees(7) right(8) at(9) 190(10)`. `bunkers@5` is a keyword occurrence; `right@8` is in its window (hazard-first `between = " with trees "`, no opposition) → `nearest_side = right` (real side, side-only passes); `190@10` at distance 5 ≤ 6 → checked as (bunker, right, 190) → **rejects**, even though `trees@7` (distance 3, strictly nearer) is the phrase 190 belongs to. Note "trees" today is not a keyword at all — nothing anchors on it, and the type scan doesn't see it either (pre-existing; unchanged by this plan).

**Untouched (correct, reviewer-cleared):** `_attributed_side` (L499–525), `_side_and_carry_supported` (L459–496), `_carry_runs` (L428–456), `_acceptable_sides` (L419–425), all constants (`_SIDE_PATTERN`/`_SIDE_WINDOW_WORDS` L370–371, `_SIDE_OPPOSITION_PATTERN` L386–388, `_CARRY_TOLERANCE_YARDS` L399, `_MIN/_MAX_PLAUSIBLE_CARRY` L400–401, `_CARRY_BRIDGE_YARDS` L413, `_CARRY_NUMBER_PATTERN` L414–416, `_MAX_FIELD_CHARS` L355), `_HAZARD_KEYWORD_TO_TYPE`/`_HAZARD_PATTERNS` (L322–353), the type scan (L800–804), the injection scan (L815–822), the newline check (L829–831), structural checks (L833–847).

---

## 2. The rule, precisely, and the minimal diff shape

### 2.1 Definitions (per field)

- **Occurrence field** `O`: for each `canonical_type in sides_by_type` (present types only), each match of `_NUMBER_BINDING_PATTERNS[canonical_type]`, KEPT only if its `candidates` list (computed exactly as today: window ≤ `_SIDE_WINDOW_WORDS`, opposition-excluded) is non-empty. Stored as `(canonical_type, hz_idx, candidates, nearest_side)`. Candidates-less occurrences are dropped exactly as today's `if not candidates: continue` — they neither check nor own (a phrase that can't check a number must never steal it; see §2a Lemma 1 and §3.6).
- **Checker types**: types with a pattern in `_HAZARD_PATTERNS` (water/bunker/ob) — these run the unconditional `nearest_side` side-only check and check all their owned in-window numbers, as today.
- **Ownership-only type**: `trees` (present in geometry via `_extract_tree_line_hazards`, `hazards.py`) — its occurrences own numbers and check the numbers re-routed to them, but run NO side-only check and validate NO number that no checker-type occurrence would have checked (re-routing-only; keeps the §2a flip-set characterization exact and leaves standalone trees sentences exactly as unvalidated as they are today).
- **Steal predicate**: occurrence `k` of type `T` skips in-window number `n` iff `∃ (T', hz_idx') ∈ O` with `T' ≠ T` and `abs(hz_idx' - n_idx) < abs(hz_idx - n_idx)`. Strictly `<`: a tie is NOT a steal. Same-type occurrences are excluded from the predicate entirely.
- **Ownership** (the directive's phrasing, satisfied): `k` owns `n` iff `abs(n_idx - hz_idx)` equals the minimum distance over all different-type occurrences… equivalently, `k` checks `n` iff no strictly-nearer different-type occurrence exists. On a genuine cross-type tie, BOTH tied occurrences own and check `n`.

### 2.2 New module-level pieces (placed with the other side-flip constants / helpers)

```python
# Ownership-only binding pattern for trees. Trees are DELIBERATELY not in
# _HAZARD_KEYWORD_TO_TYPE: adding them to the type scan would newly reject
# every honest tree mention on a hole whose OSM data has no trees mapped
# (coverage is sparse — Red 3 has zero). This pattern exists ONLY so a
# number grammatically bound to a PRESENT trees feature is owned by — and
# checked against — trees geometry instead of polluting a neighbor type's
# check (guide-validator-cross-type-number-binding-plan.md). Occurrence
# scanning is gated on the type being in sides_by_type, so a "trees" word on
# a trees-less hole contributes no occurrence and can never shelter a number.
_TREES_BINDING_PATTERN = re.compile(r"\b(?:trees?|tree\s?lines?|woods|pines?)\b")
_NUMBER_BINDING_PATTERNS: dict[str, "re.Pattern[str]"] = {
    **_HAZARD_PATTERNS, "trees": _TREES_BINDING_PATTERN,
}
```

```python
def _owns_number(
    n_idx: int, hz_idx: int, canonical_type: str,
    occurrences: list[tuple[str, int, list[tuple[int, str]], str]],
) -> bool:
    """True unless a checking occurrence of a DIFFERENT present type is
    STRICTLY nearer to the number — the number grammatically belongs to that
    phrase and is checked there instead (against THAT type's geometry, with
    _attributed_side over THAT occurrence's candidates). A cross-type
    distance TIE is NOT a steal: every tied occurrence keeps checking the
    number (fail-closed — an ambiguous number must be grounded against every
    tied nearest type, so a tie can never launder an accept). Same-type
    occurrences never shadow each other: within one type, every in-window
    number is checked at every occurrence exactly as before (cycle-115/118
    semantics byte-identical)."""
    d = abs(n_idx - hz_idx)
    return not any(
        abs(o_idx - n_idx) < d
        for o_type, o_idx, _cands, _ns in occurrences
        if o_type != canonical_type
    )
```

Mirrors `_attributed_side` in size/placement/testability (directly unit-testable, like the sibling's helper tests at test file L1120–1138).

### 2.3 Minimal diff shape inside `_has_side_flip` (L635–729 region)

Restructure the per-field body from "loop types → loop occurrences → inline candidates → check" into "**build occurrences once → loop occurrences → check**". Steps 1–3 relocate today's code verbatim; only the marked lines are new.

```python
# Build ALL present-type checking occurrences ONCE per field — the
# cross-type ownership field (guide-validator-cross-type-number-binding-
# plan.md). Candidates/nearest_side computation is today's code, verbatim,
# hoisted; candidates-less occurrences are dropped exactly as before and
# can neither check nor own.
occurrences: list[tuple[str, int, list[tuple[int, str]], str]] = []
for canonical_type in sides_by_type:
    pattern = _NUMBER_BINDING_PATTERNS.get(canonical_type)          # NEW (was _HAZARD_PATTERNS)
    if pattern is None:
        continue
    for hz_match in pattern.finditer(lowered):
        hz_idx = _word_idx(hz_match.start())
        hz_start, hz_end = hz_match.start(), hz_match.end()
        candidates = ...                                            # L643–662 verbatim
        if not candidates:
            continue                                                # L664–665 verbatim
        _, nearest_side = min(...)                                  # L666–670 verbatim
        occurrences.append((canonical_type, hz_idx, candidates, nearest_side))

for canonical_type, hz_idx, candidates, nearest_side in occurrences:
    is_checker_type = canonical_type in _HAZARD_PATTERNS            # NEW (trees = ownership-only)
    if is_checker_type and nearest_side not in _acceptable_sides(   # cycle-118 check, kept
        canonical_type, sides_by_type                               # unconditional for checker
    ):                                                              # types, NOT extended to trees
        return True
    number_candidates = [                                           # L717–719 verbatim
        hit for hit in number_hits if abs(hit[0] - hz_idx) <= _SIDE_WINDOW_WORDS
    ]
    for n_idx, carry in number_candidates:
        if not _owns_number(n_idx, hz_idx, canonical_type, occurrences):   # NEW: stolen →
            continue                                                       # checked at owner
        if not is_checker_type and not any(                          # NEW: trees validate only
            o_type in _HAZARD_PATTERNS                               # RE-ROUTED numbers — a number
            and abs(o_idx - n_idx) <= _SIDE_WINDOW_WORDS             # no checker-type occurrence
            for o_type, o_idx, _c, _n in occurrences                 # would have checked stays
        ):                                                           # unvalidated (see plan §2a)
            continue
        attributed = _attributed_side(n_idx, candidates, nearest_side)     # cycle-118, composed
        if not _side_and_carry_supported(canonical_type, attributed, carry, hazards_by_type):
            return True
```

Side attribution is intact and composed correctly: `_attributed_side` runs at the OWNING occurrence, over THAT occurrence's own window-filtered, opposition-excluded candidates and THAT occurrence's `nearest_side` tie-fallback — the number's side claim and type claim are now both read from the phrase it grammatically belongs to. `_has_side_flip`'s signature is unchanged.

Docstring edits (required, same discipline as cycle 118): `_has_side_flip` docstring gets a CROSS-TYPE paragraph after the cross-side one (keep the 265/390 and Black-11 cross-side examples verbatim; add the observed trees-in-bunker-window incident, the steal/tie rule, the trees ownership-only rationale, and the §2a one-line coverage lemma); the L688–716 comment block is EXTENDED, not replaced (reviewer history is load-bearing); `validate_guide` docstring rule 6 (L754–792) gets two sentences: each bound number is checked against the type of the present-type hazard keyword grammatically nearest to it (ties → every tied type), and trees participate in that binding without joining the type scan. Nothing else in the file changes.

---

## 2a. Soundness / strict-superset-of-rejection-power proof (sibling §2a style)

Notation per field: `C_old` = candidates-bearing occurrences of `_HAZARD_PATTERNS` types (today's checkers). `O = C_old ∪ Tr` where `Tr` = candidates-bearing trees occurrences (present-type only). Old pair-check set: `{(k, n) : k ∈ C_old, dist(n, k) ≤ 6}`. New pair-check set: `{(k, n) : k ∈ O, dist(n, k) ≤ 6, _owns_number(n, k), and if k ∈ Tr then ∃ v ∈ C_old with dist(n, v) ≤ 6}`. Side-only checks: identical set (`C_old`, unconditional) — trees excluded by construction.

**Lemma 1 (coverage — invariant 1, no bypass).** Every number with ≥1 old check has ≥1 new check. Proof: let `n` have some old checker, so `K_n = {k ∈ O : dist(n,k) ≤ 6}` is non-empty and contains a `C_old` member `v`. Let `k*` be any minimal-distance member of `K_n`. (a) `k*` is not stolen: a strictly-nearer different-type occurrence would be at distance `< dist(n,k*) ≤ 6`, hence in-window, hence in `K_n`, contradicting minimality. (b) If `k* ∈ Tr`, the re-routing gate is satisfied by `v`. So `(k*, n)` is checked. ∎ Consequently a **fabricated number** — one within `_CARRY_TOLERANCE_YARDS` of NO type's contiguous runs on any side — fails `_side_and_carry_supported` at `k*` whatever `k*`'s type is (the helper returns True only when the carry lands in a real run of the checked type, L486–496), so the guide still rejects. A fabricated number can only "escape all checks" if it escaped them under the OLD code too (out-of-window of every checker — today's P8 behavior, unchanged; no NEW escape is opened: the new check set removes a check at `k` only when a strictly-nearer different-type checking occurrence exists, and Lemma 1 shows the nearest one always checks).

**Lemma 2 (invariant 2 — wrong-type claim still rejects).** "The right bunker at 190" (190 a real trees carry, NO trees keyword within `dist(190) − 1` words — e.g. none at all): every different-type occurrence is at distance ≥ the bunker keyword's, so `_owns_number` is True at the bunker occurrence → 190 is checked as (bunker, right, 190) → bunker runs don't contain it → REJECT. The steal requires an explicit, strictly-nearer, present-type, side-claiming keyword occurrence — the text must actually SAY the other hazard phrase next to the number. Claiming a trees number for a bunker (or any cross-type mislabel where the mislabeled type's keyword is the number's nearest) rejects exactly as before. ∎

**Lemma 3 (invariant 3 — strict verdict-flip characterization).** If a field contains NO steal (no number with a strictly-nearer different-type checking occurrence), the new check set is EXACTLY the old one: pattern-type occurrences check all their in-window numbers (no skip fires), and trees occurrences check nothing (every trees-owned number either has no checker-type window — re-routing gate fails — or… note: if a trees occurrence owns a number that IS in a checker's window, that is by definition a steal). Hence: **single-present-type fields, all cycle-118 r1–r9/p1–p12 inputs, all carry-span inputs, all cycle-115 inputs are byte-identical in behavior** (they contain occurrences of at most one type — no different-type occurrence exists to steal). The verdict can change ONLY on fields with ≥1 steal, and the change per steal is precisely: check `(T_victim, n)` removed; check(s) `(T_owner, n)` at the globally-nearest occurrence(s) present instead (already present under old when the owner is a checker type; added when the owner is trees). Direction: **reject→accept** requires every remaining check to pass — i.e. every number grounded, per `_side_and_carry_supported`, against the type AND side of the phrase grammatically nearest to it, plus every keyword's own side-only check passing — the grammatically-cross-type-correct set (the observed incident) and nothing else. **accept→reject** occurs only when a trees-owned check fails where the old victim check passed (the number was previously accepted against the WRONG type by coincidence, e.g. "240 through the trees" where 240 happens to be a real bunker carry but our trees span ends at 190) — a more-correct rejection under the same proximity-grammar axiom the whole validator (and cycle 118) already stands on, and never *masking*: the victim occurrence's own side-only check and all its still-owned numbers remain independently checked (§3.5), so no false claim elsewhere in the sentence is hidden by the re-routing. ∎

**Lemma 4 (invariant 4 — ties fail closed).** A cross-type tie means neither occurrence is strictly nearer, so `_owns_number` is True at BOTH → the number is checked against EVERY tied nearest type (each with its own `_attributed_side`). For checker-type ties this reproduces the old checks at those occurrences verbatim (old checked every in-window occurrence, a superset); requiring the number to pass ALL tied types is the fail-closed reading of genuine ambiguity — a tie can only ADD a rejection relative to resolving it, never admit an accept that resolving it would have rejected. A trees-side tie adds one reject-capable check on top of the old ones. A SAME-type "tie" is a non-event by construction (same-type occurrences are excluded from the predicate; both occurrences check against the same geometry exactly as they did before — idempotent). ∎

**Invariant 5 (nothing loosened).** Zero edits to: `_MAX_FIELD_CHARS` (240) and structural checks; the type scan (trees NOT added to `_HAZARD_KEYWORD_TO_TYPE`; an absent type is still rejected by L800–804 exactly as before — and inside `_has_side_flip`, only PRESENT types produce occurrences, so an absent-type keyword can't even own a number, though such guides are already dead at the type scan); `_acceptable_sides`; `_CARRY_TOLERANCE_YARDS`; `_CARRY_BRIDGE_YARDS`; injection and newline checks; and the cycle-118 **unconditional** keyword `nearest_side` side-only check, which still runs for every candidates-bearing water/bunker/ob occurrence before any number logic. The sibling plan's §2a implication (pair-pass ⇒ side ∈ `_acceptable_sides`) is untouched because neither `_side_and_carry_supported` nor `_acceptable_sides` changes.

---

## 3. Edge cases

1. **Number equidistant to same-type vs different-type keywords** ("bunker₁ … n … bunker₂/trees" with mixed distances): same-type occurrences never steal, so `n` stays checked at every same-type in-window occurrence unless a *different*-type occurrence is strictly nearer than that particular occurrence. A same-type occurrence being nearest does NOT protect a farther same-type occurrence from a different-type steal in between (each occurrence evaluates the predicate for itself) — Lemma 1 still guarantees the global-nearest check runs, and same-type checks are same-geometry, so no laundering surface exists.
2. **In-window of A, "global-nearest out-of-window" — can't happen:** a stealing occurrence is strictly nearer than `dist(n, A) ≤ _SIDE_WINDOW_WORDS`, hence itself within the window of `n`. Every steal hands the number to an occurrence that has it in-window (and, being candidates-bearing, actually checks it — Lemma 1(b)).
3. **Type present in geometry, no keyword in field:** contributes zero occurrences; no steal, no check — behavior identical to today. Conversely a keyword whose type is ABSENT from geometry never enters `occurrences` (loop is over `sides_by_type`) — it cannot shelter a number — and the guide is already rejected by the type scan anyway (water/bunker/ob) or ignored (trees words on trees-less holes, unchanged today-behavior).
4. **Overlapping windows / multiple occurrences of one type:** each occurrence binds its own candidates and numbers independently, exactly as cycle 118 left it; the only new interaction is the different-type strict-nearest skip. A number inside two same-type windows is still checked at both.
5. **Nearest-passing keyword "hiding" a farther keyword's false claim:** it can't. Re-routing removes only the STOLEN number's check at the victim occurrence. The victim's own unconditional `nearest_side` side-only check still runs, and every number the victim still owns (its own phrase's numbers — strictly nearest to it or tied) is still checked against the victim's type. Test R5 pins this: a grounded trees phrase sitting next to a bunker phrase with a flipped side (or a bad owned number) still rejects.
6. **Sideless (candidates-less) phrases cannot steal:** "carry the trees at 190, bunkers right at 270" — the trees occurrence has no candidate side word, is dropped from `occurrences` (today's `continue`), and 190 stays checked against bunker: the old false-reject survives (honest residual, §5.1). This is deliberate fail-closed design: an occurrence that performs no check must never take a number away from one that does — the alternative (side-agnostic checking at sideless occurrences) would newly validate every bare "carry the X at N" claim in the corpus, an accept→reject flip class far outside this fix's characterization.
7. **Trailing-keyword adjacency mis-ownership:** in "bunkers at 270, trees right at 190", token distances are `270→bunkers = 2` but `270→trees = 1` — 270 is STOLEN by trees and checked against trees geometry → still rejects (verdict unchanged vs old reject when 270 isn't a trees carry, but for the wrong reason; and it keeps this particular grounded sentence false-rejected). Distance is direction-blind; a number sandwiched between its true governor and the next phrase's keyword can mis-own. Documented residual (§5.2); the regen writer re-rolls phrasing, and the P1/P3 shapes (comma/word separation) pass.
8. **Plausibility filter unchanged:** "hole 12"/"par 4" numbers never enter `number_hits` (L629–633) — they neither bind nor steal.

---

## 4. Tests and gates

New section in `backend/tests/test_guide_writer.py`: `# ── Cross-type number binding (guide-validator-cross-type-number-binding-plan.md) ──`, following the `_guide(...)` / fixture conventions and the existing `test_cross_side_*` naming. New fixture:

```python
def _black11_like_with_trees() -> list[Hazard]:
    return _black11_like_both_sides() + [
        Hazard(type="trees", side="right", line_side="right", carry_yards=150),
        Hazard(type="trees", side="right", line_side="right", carry_yards=190),
    ]
```
(bunker L{245,415} R{270,325,420}; trees R near/far bracket {150,190} → one unconditional-bridge run, window [125,215].)

**MUST PASS (`validate_guide(...) is not None`):**

| # | Name | Text | Why |
|---|---|---|---|
| P1 | `test_cross_type_p1_observed_trees_carry_in_bunker_window_now_passes` | `"Lay up short of the bunkers, with trees right at 190."` | THE incident shape. 190: dist 5 to `bunkers@5` (old: checked vs bunker → rejected), dist 3 to `trees@7` → stolen → (trees, right, 190) ∈ [125,215] → passes. Token math in §1. |
| P2 | `test_cross_type_p2_mirror_order_passes` | `"Trees right at 190, then lay up short of the bunkers."` | order-independence of the steal. |
| P3 | `test_cross_type_p3_combined_side_and_type_composition_passes` | `"the 245-left bunker and the 270/325 right-side bunkers, trees right at 190"` | Full side×type composition, hand-verified: 245 owned by `bunker@2` (attributed left); 270/325 tie `bunker@2`/`trees@8` at dist 3 → both keep… `bunkers@7` (dist 2) checks them attributed right, trees does NOT check them (`bunkers@7` strictly nearer than `trees@8`); 190 owned by `trees@8` (checker window via `bunkers@7`, dist 4) → (trees, right, 190). Everything grounded → passes. |
| P4 | `test_cross_type_p4_no_trees_keyword_no_behavior_change_passes` | cycle-118 P1 sentence on `_black11_like_with_trees()` | trees PRESENT in geometry but no trees keyword in field → zero steals → cycle-118 verdict preserved with the richer geometry. |

**MUST REJECT (`validate_guide(...) is None`):**

| # | Name | Text / setup | Why |
|---|---|---|---|
| R1 | `test_cross_type_r1_fabricated_number_still_rejects_at_owner` | `"Lay up short of the bunkers, with trees right at 500."` on `_black11_like_with_trees()` | 500 stolen by trees, fails vs trees runs; fabricated numbers reject wherever they're checked (Lemma 1). |
| R2 | `test_cross_type_r2_wrong_type_claimed_number_rejects` | `"The right bunker at 190 catches drives."` on `_black11_like_with_trees()` | invariant 2: no trees keyword → 190 owned by bunker → (bunker, right, 190) ∉ [245,350]∪[395,445] → rejects, even though 190 is a real trees carry. |
| R3 | `test_cross_type_r3_stolen_number_unsupported_by_owner_rejects` | `"Lay up short of the bunkers, with trees right at 270."` | 270 stolen by trees; real bunker-right carry but NOT a trees carry → rejects (accept→reject only via more-correct proximity grammar; pins Lemma 3's direction analysis deliberately, with a comment). |
| R4 | `test_cross_type_r4_cross_type_tie_checks_every_tied_type` | `"…the bunkers at 200 near trees right…"` with trees R{200}, bunker R{270,325} | 200 equidistant (2/2) to `bunkers` and `trees` → tie, no steal → still checked vs bunker → rejects exactly as old (invariant 4). |
| R5 | `test_cross_type_r5_grounded_trees_phrase_does_not_launder_victims_own_claims` | `"the left bunkers at 245, with trees right at 190"` on geometry with bunkers RIGHT-only | trees steal of 190 succeeds, but the bunker keyword's own flipped `nearest_side`/owned 245 still checked → rejects (§3.5). |
| R6 | `test_cross_type_r6_sideless_trees_phrase_cannot_steal` | `"Carry the trees at 190, short of the bunkers right at 270."` (190 in the bunkers window) | candidates-less trees occurrence dropped → 190 stays checked vs bunker → rejects (pins §3.6 / residual §5.1 as REJECT — fail-closed preserved, not silently "fixed"). |
| R7 | `test_cross_type_r7_absent_type_keyword_cannot_shelter` | `"…bunkers right at 270, water right at 190…"` on a NO-water hole | dead at the type scan exactly as before (invariant 5); also pins that absent types never enter `occurrences`. |

**Helper tests** (`_owns_number` direct): strictly-nearer different type → False; tie → True; same-type nearer → True; empty different-type field → True.

**Byte-identical regression pins (unedited, must stay green):** the entire cross-side suite `test_cross_side_r1..r9`, `test_cross_side_p1..p12`, `test_attributed_side_*` (test file L868–1138), all `test_carry_span_*`, `test_carry_check_*`, `test_side_check_*`, and the cycle-115 tie-break/number-stuffing tests — all single-present-type keyword fields ⇒ Lemma 3 zero-steal ⇒ identical code path outcomes.

**Gates (from `backend/`):**
1. `ruff check .` — clean.
2. `uv run pytest tests/test_guide_writer.py tests/test_bethpage_validation.py tests/test_course_guides.py tests/test_regen_rejected_guides.py tests/test_guide_read_revalidation.py tests/test_session_guide_revalidate.py tests/test_guide_consumption.py` — expected **160 baseline + new tests, zero existing tests modified, zero flips** (baseline pinned: 97 in `test_guide_writer.py`, 160 suite-wide).
3. Test diff must be pure-add (0 deletions) — same discipline as cycle 118 QA.
4. Post-land: on-box Black 7+11 regen per the existing sanctioned runbook (`backend/scripts/regen_rejected_guides.py`, black UUID `2b8caab5-2c55-5752-8cda-336c3a396dac`) — eng-lead step, out of builder scope.

---

## 5. Residuals the rule does NOT cover (honest list)

1. **Sideless cross-type phrases can't rescue their numbers** (§3.6): "carry the trees at 190" next to a sided bunker phrase still false-rejects — a candidates-less occurrence neither checks nor owns. Deliberate fail-closed trade; would need a side-agnostic carry check to fix, which expands the flip set beyond this plan's proof.
2. **Direction-blind distance** (§3.7): "bunkers at 270, trees right at 190" mis-owns 270 to trees (dist 1 vs 2) and keeps that grounded sentence rejected. Proximity ≈ grammar remains an approximation, as in cycle 118.
3. **Standalone trees claims stay unvalidated**: a field containing only trees phrases (numbers, sides — real or invented) is neither type-scanned nor number-checked, exactly as today. Re-routing-only scope; extending validation to trees claims is a separate, riskier cycle (sparse OSM trees ⇒ false-reject exposure on the anti-hallucination control's honest side).
4. **Equidistant cross-type ties keep old rejects** (invariant 4 by design): a grounded sentence whose number genuinely ties two types' keywords still rejects unless BOTH types support it.
5. **`slope` hazards** have no binding pattern; numbers near slope wording are unaffected (as today).
6. **Trees geometry sparseness**: a stolen number is now judged against the OSM trees bracket (mitigated by the unconditional `trees` bridge — one run spanning the full near/far bracket — plus ±25y tolerance); an under-mapped tree line can still false-reject a re-routed real carry.

## 6. Shared-types check

Backend-only: edits confined to `backend/app/caddie/guide_writer.py` + `backend/tests/test_guide_writer.py`. `validate_guide` and `_has_side_flip` signatures unchanged; `Hazard` (`backend/app/caddie/types.py`) and `HoleStrategyGuide` shapes untouched; nothing in `backend/app/models.py` changes, so no `frontend/src/lib/types.ts` mirror is implicated. No API surface, no DB shape, no frontend gate (tsc/vitest not needed).

## 7. Adversarial review focus for the builder's reviewer

1. Try to construct a fabricated number that escapes ALL checks under the new rule — Lemma 1's minimality argument is the defense; the only unchecked numbers are those unchecked under old code too (out of every checker window / candidates-less-only windows).
2. Try to launder a wrong-type number via a strictly-nearer present-type keyword whose geometry happens to support it — that requires the text to place a REAL, side-attributed, carry-grounded claim of that type nearest the number, i.e. a grounded sentence (the intended accept), with ties collapsing to checking everything.
3. Verify the re-routing gate for trees (`in some checker-type window`) can't be used to make a trees check DISAPPEAR that Lemma 1 needs — the gate only prunes numbers that had NO old check.
4. Off-by-one at window boundary 6 and strict `<` vs `<=` in `_owns_number` (P1 places the victim at distance 5, R4 pins the tie).
5. Confirm `occurrences` hoisting changed no candidates/nearest_side/opposition behavior (pure relocation).
