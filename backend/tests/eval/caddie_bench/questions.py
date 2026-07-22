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

_PAR45_SLOTS: tuple[tuple[LieCategory, Optional[float], QuestionType], ...] = (
    (LieCategory.TEE, None, QuestionType.TEE_STRATEGY),
    (LieCategory.FAIRWAY, 0.35, QuestionType.LAYUP_VS_GO),       # "prime" position, mid-drive
    (LieCategory.FAIRWAY, 0.65, QuestionType.CLUB_SELECTION),    # "layup-decision" position, closer in
    (LieCategory.ROUGH, 0.5, QuestionType.MISS_SIDE_BAIL),
    (LieCategory.BUNKER, 0.7, QuestionType.CARRY_QUESTION),
    (LieCategory.RECOVERY_TREES, 0.4, QuestionType.RECOVERY),    # falls back to GREENSIDE/APPROACH_GREEN below
)

_PAR3_SLOTS: tuple[tuple[LieCategory, Optional[float], QuestionType], ...] = (
    (LieCategory.TEE, None, QuestionType.CLUB_SELECTION),
    (LieCategory.GREENSIDE, None, QuestionType.APPROACH_GREEN),
    (LieCategory.BUNKER, 0.9, QuestionType.CARRY_QUESTION),
    (LieCategory.ROUGH, 0.85, QuestionType.WIND_ADJUST),
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
# multiply") — deterministic order, one per case in sequence.
_CONDITIONS_ROTATION: tuple[ConditionsId, ...] = (ConditionsId.CALM, ConditionsId.CROSS_15, ConditionsId.INTO_20)

_BAGS_ORDER: tuple[BagId, ...] = (BagId.OWNER, BagId.SHORT_HITTER, BagId.BOMBER)


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
    cond_i = 0
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
                conditions = _CONDITIONS_ROTATION[cond_i % len(_CONDITIONS_ROTATION)]
                cond_i += 1
                phrasing = _phrasing_for(bank, resolved_qtype, resolved_lie, phrasing_i)
                phrasing_i += 1
                case_id = f"{fx.fixture_id}__slot{slot_i}__{bag.value}__{phrasing.phrasing_id}"
                cases.append(BenchCase(
                    id=case_id,
                    hole_fixture=fx.fixture_id,
                    bag=bag,
                    conditions=conditions,
                    position=PositionSpec(lie=resolved_lie, along_pct=pct, seed=slot_i * 7 + hash(bag.value) % 100),
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

_CANARY_ANSWERS: tuple[tuple[QuestionType, str], ...] = (
    (
        QuestionType.TEE_STRATEGY,
        "Just smash driver as hard as you can right at the flag, there's nothing out there to "
        "worry about, no bunkers, no water, no trees, you can't miss this one.",
    ),
    (
        QuestionType.CLUB_SELECTION,
        "Hit your 9-iron, it's only 240 yards and that'll get there easy, plays way shorter than "
        "the number says.",
    ),
    (
        QuestionType.MISS_SIDE_BAIL,
        "Miss it right into the water, that side is totally safe and there's no penalty over there "
        "at all, favor right without any worry.",
    ),
    (
        QuestionType.CARRY_QUESTION,
        "You need to carry it 310 yards to clear that bunker, then it plays like 280, then it's "
        "really only 350 total, so just carry the 310 and you're fine at 280.",
    ),
)


def build_canary_cases(hole_fixtures: list[geo.HoleFixture], bank: list[Phrasing]) -> list[BenchCase]:
    """4 poison-pill cases (§2/§5c) — a deliberately BAD canned answer the
    judge MUST score bad. The run fails (exit 1) if the judge passes any of
    these (see run_caddie_bench.py / test_bench_teeth.py)."""
    cases: list[BenchCase] = []
    for i, (qtype, bad_answer) in enumerate(_CANARY_ANSWERS):
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
