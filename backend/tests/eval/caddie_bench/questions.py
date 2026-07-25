"""Question-bank loader + case-matrix expansion (specs/caddie-bench-plan.md
§1, §2). Pure — no I/O beyond `load_question_bank` (delegated to schema.py).

The bank itself (`fixtures/questions_v1.jsonl`) is HAND-AUTHORED for v1 (this
cycle, per the builder's contract — a fully offline/deterministic seed bank).
`generate_phrasings` below is the gated `--generate` mode the plan reserves
for a future LLM-batch expansion; it never runs automatically and this
module never calls it on import or in `build_cases`.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path
from typing import Optional

from tests.eval.caddie_bench import geometry as geo
from tests.eval.caddie_bench.schema import (
    BagId,
    BenchCase,
    ConditionsId,
    LieCategory,
    Phrasing,
    PositionSpec,
    QuestionType,
)

# ── Case-matrix expansion (§2) ───────────────────────────────────────────────

# The plan's per-hole position plan: par-4/5 holes get 6 position "slots",
# par-3 holes get 4. Each slot names a LieCategory + a default along_pct + the
# QuestionType(s) that make sense from it. When a hole's fixture doesn't map
# a lie a slot wants (geometry.available_lies), the slot substitutes the
# fallback lie/question pair named in parens below rather than silently
# dropping the slot or fabricating a position.

# cycle-4 (specs/caddie-bench-cycle4-plan.md §C(ii)) rebalance toward
# ordinary golf. Measured before (150 cases): fairway 50, rough 42, tee 28,
# bunker 24, greenside 3, recovery 3 -- 46% trouble lies, and the TEE slot
# (where the owner's actual "4-iron on a driver hole" incident lives) was
# structurally under-weighted. The RECOVERY_TREES slot is removed (it
# substituted to ROUGH on 6 of 7 holes anyway -- the mix's hidden rough
# inflation); QuestionType.RECOVERY stays in the bank (bank-coverage is
# bank-side, not slot-side) and recovery scenarios are noted in the backlog
# as a future dedicated suite. A second TEE slot (CHALLENGE_WHY) is the
# aggression surface -- "why that club / why not go at it?" is exactly the
# question that should surface a timid or reckless pick.
_PAR45_SLOTS: tuple[tuple[LieCategory, Optional[float], QuestionType], ...] = (
    (LieCategory.TEE, None, QuestionType.TEE_STRATEGY),
    (LieCategory.TEE, None, QuestionType.CHALLENGE_WHY),      # "why that club / why not go at it?" — the aggression surface
    (LieCategory.FAIRWAY, 0.35, QuestionType.LAYUP_VS_GO),
    (LieCategory.FAIRWAY, 0.65, QuestionType.CLUB_SELECTION),
    (LieCategory.ROUGH, 0.5, QuestionType.MISS_SIDE_BAIL),
    (LieCategory.BUNKER, 0.7, QuestionType.CARRY_QUESTION),
)

_PAR3_SLOTS: tuple[tuple[LieCategory, Optional[float], QuestionType], ...] = (
    (LieCategory.TEE, None, QuestionType.CLUB_SELECTION),
    (LieCategory.TEE, None, QuestionType.WIND_ADJUST),        # wind club-adjust is asked ON the tee
    (LieCategory.GREENSIDE, None, QuestionType.APPROACH_GREEN),
    (LieCategory.BUNKER, 0.9, QuestionType.CARRY_QUESTION),
)

# Fallback substitution when a slot's ideal lie isn't mapped on a given hole.
_LIE_FALLBACK: dict[LieCategory, LieCategory] = {
    LieCategory.RECOVERY_TREES: LieCategory.ROUGH,
    LieCategory.BUNKER: LieCategory.GREENSIDE,
}
_QTYPE_FALLBACK_FOR_LIE: dict[LieCategory, QuestionType] = {
    LieCategory.ROUGH: QuestionType.APPROACH_GREEN,
    LieCategory.GREENSIDE: QuestionType.APPROACH_GREEN,
}

# Round-robin conditions assignment (plan §2: "conditions rotate rather than
# multiply"). Assigned via a STABLE per-case hash (#10 fix — see
# `_stable_condition`), never an enumeration counter: a counter makes each
# case's condition depend on the ORDER holes were iterated in, so `--holes`/
# `--resume`/`--only-failures` subsets silently reassign different
# conditions to the same case id than a full run would.
_CONDITIONS_ROTATION: tuple[ConditionsId, ...] = (ConditionsId.CALM, ConditionsId.CROSS_15, ConditionsId.INTO_20)

_BAGS_ORDER: tuple[BagId, ...] = (BagId.OWNER, BagId.SHORT_HITTER, BagId.BOMBER)

# Stable per-bag seed component (#4 fix) — Python's `hash(str)` is
# process-randomized (PYTHONHASHSEED) unless disabled, so `hash(bag.value)`
# made `PositionSpec.seed` (and therefore the full case dump) differ across
# separate process runs even though nothing about the case logically
# changed. A fixed dict keyed by the closed `BagId` enum is byte-stable
# forever, in every process.
_BAG_SEED: dict[BagId, int] = {BagId.OWNER: 0, BagId.SHORT_HITTER: 1, BagId.BOMBER: 2}


def _stable_condition(*stable_parts: str) -> ConditionsId:
    """A per-case condition assignment that's a pure function of STABLE
    fields (hole fixture id, slot index, bag) — never of enumeration order —
    so the same case id always gets the same condition regardless of which
    subset of holes/cases a given run covers (#10)."""
    key = "|".join(stable_parts)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    idx = int(digest, 16) % len(_CONDITIONS_ROTATION)
    return _CONDITIONS_ROTATION[idx]


def _phrasing_for(bank: list[Phrasing], qtype: QuestionType, lie: LieCategory, index: int) -> Phrasing:
    """Deterministically pick the `index`-th (mod len) phrasing whose
    question_type matches and whose lie_constraint (if any) includes `lie`."""
    candidates = [
        p for p in bank
        if p.question_type == qtype and (not p.lie_constraint or lie in p.lie_constraint)
    ]
    if not candidates:
        # Constraint too narrow for this lie -- fall back to any phrasing of
        # this question_type (still deterministic).
        candidates = [p for p in bank if p.question_type == qtype]
    if not candidates:
        raise ValueError(f"question bank has no phrasings at all for question_type={qtype.value!r}")
    return candidates[index % len(candidates)]


def build_cases(
    hole_fixtures: list[geo.HoleFixture],
    bank: list[Phrasing],
    *,
    include_fact: bool = True,
    include_canaries: bool = True,
) -> list[BenchCase]:
    """POSITION x HOLE x PLAYER x CONDITIONS x QTYPE x PHRASING expansion
    (§1/§2) over the given holes. Deterministic — no randomness; every case
    id and phrasing selection is a pure function of hole order + slot index +
    bag order."""
    cases: list[BenchCase] = []
    phrasing_i = 0

    for fx in hole_fixtures:
        slots = _PAR3_SLOTS if fx.par == 3 else _PAR45_SLOTS
        available = geo.available_lies(fx)
        for slot_i, (lie, along_pct, qtype) in enumerate(slots):
            resolved_lie = lie
            resolved_qtype = qtype
            if resolved_lie not in available:
                fallback_lie = _LIE_FALLBACK.get(resolved_lie, LieCategory.ROUGH)
                resolved_lie = fallback_lie if fallback_lie in available else LieCategory.TEE
                resolved_qtype = _QTYPE_FALLBACK_FOR_LIE.get(resolved_lie, qtype)
            pct = along_pct if resolved_lie in (LieCategory.FAIRWAY, LieCategory.ROUGH) else None
            for bag in _BAGS_ORDER:
                conditions = _stable_condition(fx.fixture_id, str(slot_i), bag.value)
                phrasing = _phrasing_for(bank, resolved_qtype, resolved_lie, phrasing_i)
                phrasing_i += 1
                case_id = f"{fx.fixture_id}__slot{slot_i}__{bag.value}__{phrasing.phrasing_id}"
                cases.append(BenchCase(
                    id=case_id,
                    hole_fixture=fx.fixture_id,
                    bag=bag,
                    conditions=conditions,
                    position=PositionSpec(lie=resolved_lie, along_pct=pct, seed=slot_i * 7 + _BAG_SEED[bag]),
                    question_type=resolved_qtype,
                    phrasing_id=phrasing.phrasing_id,
                ))

        if include_fact:
            # One FACT-class case per hole (§2 "+8 FACT-class cases").
            phrasing = _phrasing_for(bank, QuestionType.FACT_DISTANCE, LieCategory.FAIRWAY, phrasing_i)
            phrasing_i += 1
            case_id = f"{fx.fixture_id}__fact__{phrasing.phrasing_id}"
            cases.append(BenchCase(
                id=case_id, hole_fixture=fx.fixture_id, bag=BagId.OWNER, conditions=ConditionsId.CALM,
                position=PositionSpec(lie=LieCategory.FAIRWAY if LieCategory.FAIRWAY in available else LieCategory.TEE, along_pct=0.5, seed=99),
                question_type=QuestionType.FACT_DISTANCE, phrasing_id=phrasing.phrasing_id,
            ))

    if include_canaries:
        cases.extend(build_canary_cases(hole_fixtures, bank))

    return cases


# ── Canary (poison-pill) cases (§5c anti-gaming) ─────────────────────────────

# cycle-4 commit 6 (reviewer BLOCKING B2): each tuple gains (min_par,
# min_yards) — a GEOMETRIC REQUIREMENT the bound fixture must satisfy,
# defaulted (0, 0) meaning "any fixture is fine" (this canary's poison is
# self-contained: fabricated/inconsistent numbers, not hole-specific). Only
# the 5th (timid) canary carries a real requirement — see its own comment.
_CANARY_ANSWERS: tuple[tuple[QuestionType, int, int, str], ...] = (
    (
        QuestionType.TEE_STRATEGY, 0, 0,
        "Just smash driver as hard as you can right at the flag, there's nothing out there to "
        "worry about, no bunkers, no water, no trees, you can't miss this one.",
    ),
    (
        QuestionType.CLUB_SELECTION, 0, 0,
        "Hit your 9-iron, it's only 240 yards and that'll get there easy, plays way shorter than "
        "the number says.",
    ),
    (
        QuestionType.MISS_SIDE_BAIL, 0, 0,
        "Miss it right into the water, that side is totally safe and there's no penalty over there "
        "at all, favor right without any worry.",
    ),
    (
        QuestionType.CARRY_QUESTION, 0, 0,
        "You need to carry it 310 yards to clear that bunker, then it plays like 280, then it's "
        "really only 350 total, so just carry the 310 and you're fine at 280.",
    ),
    # cycle-4 (specs/caddie-bench-cycle4-plan.md §B4) — the TIMID canary. The
    # 4 canaries above are all RECKLESS-tail poison pills; the bench was
    # structurally blind to the owner's actual complaint (a caddie that's too
    # conservative) until aggression_realism existed to fail this on its
    # merits. Self-contradicting on its own terms (names no evidence, then
    # admits "nothing really out there") — the judge MUST score it bad.
    #
    # BLOCKING fix (reviewer, commit 6): the original `i % len(hole_fixtures)`
    # binding landed this on `bethpage_black_h8` (par 3, 210y) purely by
    # positional accident — the owner bag's 4-iron (230y) OVER-clubs a 210y
    # par 3, and "driver is way too risky" is incoherent on a par 3, so the
    # timid tail was only accidentally tested (and the rubric's own
    # anti-hedging clause would tell the judge to ignore the incoherent
    # rhetoric anyway). min_par=4/min_yards=500 forces this onto a genuinely
    # long, clear par-4/5 where under-clubbing to a 4-iron is UNAMBIGUOUSLY
    # timid — bethpage_black_h4 (517y), the owner's own incident geometry.
    (
        QuestionType.TEE_STRATEGY, 4, 500,
        "Let's just take the 4-iron and lay it back safe out there, driver is way too "
        "risky on this hole, no reason to take on trouble even though there's nothing "
        "really out there, smart play is always the short club.",
    ),
)


def build_canary_cases(hole_fixtures: list[geo.HoleFixture], bank: list[Phrasing]) -> list[BenchCase]:
    """5 poison-pill cases (§2/§5c, 4 -> 5 in cycle-4) — a deliberately BAD
    canned answer the judge MUST score bad. The run fails (exit 1) if the
    judge passes any of these (see run_caddie_bench.py / test_bench_teeth
    .py).

    BLOCKING fix (reviewer, cycle-4 commit 6): binding used to be a bare
    `hole_fixtures[i % len(hole_fixtures)]` — purely positional, so it could
    (and did) land a canary on a fixture where its answer isn't even
    coherent, AND adding any unrelated fixture reshuffles every binding.
    A canary with a REAL geometric requirement (min_par/min_yards > 0) now
    picks the alphabetically-first fixture satisfying it — deterministic,
    and correct regardless of what else exists in the population, unlike
    positional indexing. Canaries with no real requirement (0, 0) keep the
    exact `i % len(hole_fixtures)` binding they had before this fix — their
    poison is self-contained (fabricated/inconsistent numbers), not
    hole-dependent, so this is intentionally unchanged, not overlooked."""
    cases: list[BenchCase] = []
    for i, (qtype, min_par, min_yards, bad_answer) in enumerate(_CANARY_ANSWERS):
        if min_par or min_yards:
            candidates = sorted(
                (fx for fx in hole_fixtures if fx.par >= min_par and (fx.yards or 0) >= min_yards),
                key=lambda fx: fx.fixture_id,
            )
            if not candidates:
                # A restricted `--holes` subset (a targeted/debug run) may
                # legitimately not include a fixture long enough to arm this
                # canary's requirement -- skip it (loudly) rather than crash
                # the whole run; the full fixture set always satisfies it
                # (pinned by test_timid_canary_is_present_in_build_canary_
                # cases), so this only ever fires on a deliberately narrowed
                # `--holes` list.
                print(
                    f"WARNING: canary #{i} ({qtype.value}) requires min_par={min_par}/"
                    f"min_yards={min_yards} but none of the given hole_fixtures satisfy it -- "
                    "skipping this canary for this run.",
                    file=sys.stderr,
                )
                continue
            fx = candidates[0]
        else:
            fx = hole_fixtures[i % len(hole_fixtures)]
        available = geo.available_lies(fx)
        lie = LieCategory.TEE if LieCategory.TEE in available else next(iter(available))
        phrasing = _phrasing_for(bank, qtype, lie, i)
        cases.append(BenchCase(
            id=f"canary__{fx.fixture_id}__{qtype.value}",
            hole_fixture=fx.fixture_id, bag=BagId.OWNER, conditions=ConditionsId.CALM,
            position=PositionSpec(lie=lie, along_pct=0.5 if lie in (LieCategory.FAIRWAY, LieCategory.ROUGH) else None, seed=13),
            question_type=qtype, phrasing_id=phrasing.phrasing_id,
            canary=True, canary_answer=bad_answer,
        ))
    return cases


# ── Gated bank generation (--generate; never invoked automatically) ─────────


def generate_phrasings(out_path: Path) -> None:
    """Reserved for a future LLM-batch bank expansion (plan §1). NOT
    implemented offline (would require a live model call) — refuses unless
    explicitly gated, mirroring the other LIVE/gated entry points in this
    package. v1's bank is hand-authored; this exists so the CLI shape is in
    place for a future `questions_v2.jsonl` generation run."""
    if os.getenv("CADDIE_BENCH_GENERATE") != "1":
        raise RuntimeError(
            "generate_phrasings is gated OFF — set CADDIE_BENCH_GENERATE=1 and provide a real "
            "model-batch implementation before running. v1's bank is hand-authored; see "
            "fixtures/questions_v1.jsonl."
        )
    raise NotImplementedError(
        "LLM-batch phrasing generation is not implemented in this cycle — v1's bank is "
        "hand-authored per the builder's contract. A future cycle wires this to a real batch "
        "call and writes questions_v2.jsonl."
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", action="store_true")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "fixtures" / "questions_v2.jsonl")
    args = parser.parse_args(argv)
    if not args.generate:
        parser.print_help(sys.stderr)
        return 2
    try:
        generate_phrasings(args.out)
    except (RuntimeError, NotImplementedError) as e:
        print(str(e), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
