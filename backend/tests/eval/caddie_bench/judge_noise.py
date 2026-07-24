"""Judge-noise double-pass measurement (Target 5, caddie-bench-cycle3-plan.md
Commit 3) — "Measure, never tune toward agreement."

Takes an already-completed run (`runs/<run_id>/`) and re-judges a random
sample of its judged advice cases TWICE, fresh, with the CURRENT judge
prompt (never reusing the stored verdict — this measures the judge as it is
today, post caddie-bench-cycle3-plan.md Commit 1's shot_reachability fix).
The disagreement between the two fresh passes is the judge's own noise
floor; `compute_noise_stats` turns that into an honest ceiling on the
weighted-correctness headline (`report.compute_headline`'s own metric) — if
that ceiling is well under 100%, then 100% weighted is unreachable at any
caddie quality without further judge-noise work, and this module's output
says so with data, never a guess.

Same three guards as `run_caddie_bench.py` / `tests/eval/run_tier2.py`:
  1. Filename does NOT match `test_*.py` — pytest never collects this module
     (pinned by `test_bench_teeth.py`).
  2. `main()` refuses to run unless BOTH `OPENAI_API_KEY` and
     `CADDIE_EVAL_LIVE=1` are set.
  3. No CI workflow invokes this file.

Invocation (never in CI — run yourself, against an already-completed run):
    cd backend && CADDIE_EVAL_LIVE=1 OPENAI_API_KEY=... uv run python -m \\
        tests.eval.caddie_bench.judge_noise --run-id <run_id> --sample-size 30
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
from typing import Optional

from tests.eval.caddie_bench import geometry as geo
from tests.eval.caddie_bench import judge as judge_mod
from tests.eval.caddie_bench import questions as q
from tests.eval.caddie_bench import report
from tests.eval.caddie_bench.run_caddie_bench import _cost_usd  # reused, never forked (§7 pricing table)
from tests.eval.caddie_bench.schema import (
    BAGS_PATH,
    CORRECTNESS_DIMENSIONS,
    HOLES_DIR,
    QUESTIONS_V1_PATH,
    RUNS_DIR,
    BenchCase,
    CaseResult,
    JudgeDimension,
    JudgeScores,
    load_bags,
    load_question_bank,
)

# Exit codes mirror run_caddie_bench.py's taxonomy — a subset applies here
# (no per-case bar to miss; no "canary" concept for a double-pass sample).
_EXIT_PASS = 0
_EXIT_GATE_REFUSAL = 2
_EXIT_BUDGET_ABORT = 3


def _is_fact_or_canary(case_id: str) -> bool:
    """§ sampling exclusion — canaries are deliberately bad and would
    understate noise on the pass boundary; FACT-class cases are never
    judged at all (`judge is None` already filters them, this is
    defensive/explicit, same discipline as `report._is_fact_case`)."""
    return "__fact__" in case_id or case_id.startswith("canary__")


def _det_summary(result: CaseResult) -> str:
    """Rebuilds the SAME det_summary string `run_caddie_bench.run()` feeds
    the judge — a stored-field reconstruction, never a re-computation (the
    det checks themselves are frozen at write time in `result.det_checks`)."""
    return "; ".join(f"{d.check.value}={'PASS' if d.passed else 'FAIL'}" for d in result.det_checks)


def sample_judged_advice_cases(
    results: list[CaseResult], *, sample_size: int, seed: int,
) -> list[CaseResult]:
    """Deterministic (seeded) sample of judged, non-FACT, non-canary
    results — the population `compute_noise_stats` measures noise over."""
    pool = [r for r in results if r.judge is not None and not _is_fact_or_canary(r.case_id)]
    if len(pool) <= sample_size:
        return pool
    return random.Random(seed).sample(pool, sample_size)


def compute_noise_stats(
    pairs: list[tuple[str, JudgeScores, JudgeScores]],
    engine_refs: dict[str, dict],
    *,
    stored_first: Optional[dict[str, JudgeScores]] = None,
) -> dict:
    """Pure, offline-testable analysis of a double-pass judge sample.

    `pairs`: one `(case_id, first_fresh_pass, second_fresh_pass)` tuple per
    sampled case (both passes independent, current-prompt `judge_case`
    calls — never the run's originally stored verdict).
    `engine_refs`: `case_id -> engine_ref dict`, used ONLY to respect Commit
    1's N/A rule (shot_reachability pairs are counted only on cases where
    `engine_ref["shot_kind"] == "positioning"` — mirrors
    `report.compute_headline`'s own exclusion exactly, never a second
    definition of applicability).
    `stored_first` (optional, bonus, §-cheap-signal): `case_id ->
    JudgeScores`, the run's ORIGINALLY STORED first-pass verdict — when
    given, also reports per-dimension exact-agreement of the fresh first
    pass against it (the cheap before/after contested/clarity signal; the
    stored run predates Commit 1's prompt fix).

    Returns a dict — see the per-key comments below for exact formulas
    (kept in code, not prose elsewhere, so the numbers are auditable):
      - "n_cases": sample size actually analyzed.
      - "per_dimension": {dim: {n_applicable, exact_agreement_rate,
        pass_flip_rate, mean_abs_delta, q_pass_repeat}} — a dim with
        n_applicable=0 (e.g. shot_reachability on an all-approach sample)
        reports every metric as None, never a misleading 0.0/1.0.
      - "ceiling_expected": weighted score of a hypothetically PERFECT
        caddie = sum(w_d * E[score|true-pass]_d) / sum(w_d * 2), where
        E[score|true-pass]_d is the mean of BOTH passes' scores over
        case-dims where max(a,b)==2 (at least one judge saw the pass) —
        dims with zero true-pass case-dims are excluded from both the sum
        and the denominator (never silently treated as a 0).
      - "band_optimistic" / "band_pessimistic": the SAME weighted formula
        `report.compute_headline` uses (correctness dims 2x), but applied to
        every sampled case-dim's max(a,b) / min(a,b) value respectively —
        NOT restricted to the true-pass subset.
      - "stored_first_pass_agreement" (only present when `stored_first` is
        given): {dim: exact-agreement rate of the fresh first pass vs the
        run's stored verdict, or None if no comparable cases}.
    """
    per_dim_pairs: dict[JudgeDimension, list[tuple[int, int]]] = {d: [] for d in JudgeDimension}
    for case_id, a, b in pairs:
        shot_kind = (engine_refs.get(case_id) or {}).get("shot_kind")
        for dim in JudgeDimension:
            if dim == JudgeDimension.SHOT_REACHABILITY and shot_kind != "positioning":
                continue
            per_dim_pairs[dim].append((a.scores[dim], b.scores[dim]))

    def _weight(dim: JudgeDimension) -> int:
        return 2 if dim in CORRECTNESS_DIMENSIONS else 1

    per_dimension: dict[str, dict] = {}
    for dim in JudgeDimension:
        vals = per_dim_pairs[dim]
        n = len(vals)
        if n == 0:
            per_dimension[dim.value] = {
                "n_applicable": 0, "exact_agreement_rate": None, "pass_flip_rate": None,
                "mean_abs_delta": None, "q_pass_repeat": None,
            }
            continue
        exact = sum(1 for av, bv in vals if av == bv) / n
        flip = sum(1 for av, bv in vals if (av == 2) != (bv == 2)) / n
        mean_abs = statistics.fmean(abs(av - bv) for av, bv in vals)
        # Symmetrized pass-repeat probability: each pair contributes twice,
        # once in each ordering, so the estimate doesn't depend on which
        # fresh call happened to be labeled "first".
        repeat_num = 0
        repeat_den = 0
        for av, bv in vals:
            if av == 2:
                repeat_den += 1
                repeat_num += 1 if bv == 2 else 0
            if bv == 2:
                repeat_den += 1
                repeat_num += 1 if av == 2 else 0
        q = (repeat_num / repeat_den) if repeat_den else None
        per_dimension[dim.value] = {
            "n_applicable": n, "exact_agreement_rate": exact, "pass_flip_rate": flip,
            "mean_abs_delta": mean_abs, "q_pass_repeat": q,
        }

    ceiling_num = 0.0
    ceiling_den = 0.0
    for dim in JudgeDimension:
        vals = per_dim_pairs[dim]
        true_pass_scores = [s for av, bv in vals for s in (av, bv) if max(av, bv) == 2]
        if not true_pass_scores:
            continue
        e_score = statistics.fmean(true_pass_scores)
        w = _weight(dim)
        ceiling_num += w * e_score
        ceiling_den += w * 2
    ceiling_expected = (ceiling_num / ceiling_den) if ceiling_den else 0.0

    def _band(reducer) -> float:
        num = 0.0
        den = 0.0
        for dim in JudgeDimension:
            vals = per_dim_pairs[dim]
            if not vals:
                continue
            w = _weight(dim)
            num += w * sum(reducer(av, bv) for av, bv in vals)
            den += w * 2 * len(vals)
        return (num / den) if den else 0.0

    result: dict = {
        "n_cases": len(pairs),
        "per_dimension": per_dimension,
        "ceiling_expected": ceiling_expected,
        "band_optimistic": _band(max),
        "band_pessimistic": _band(min),
    }

    if stored_first is not None:
        stored_agreement: dict[str, Optional[float]] = {}
        for dim in JudgeDimension:
            n = 0
            agree = 0
            for case_id, a, _b in pairs:
                shot_kind = (engine_refs.get(case_id) or {}).get("shot_kind")
                if dim == JudgeDimension.SHOT_REACHABILITY and shot_kind != "positioning":
                    continue
                stored = stored_first.get(case_id)
                if stored is None:
                    continue
                n += 1
                if a.scores[dim] == stored.scores[dim]:
                    agree += 1
            stored_agreement[dim.value] = (agree / n) if n else None
        result["stored_first_pass_agreement"] = stored_agreement

    return result


def _print_table(stats: dict) -> None:
    print(f"Judge-noise sample: {stats['n_cases']} cases")
    print(f"{'dimension':<24}{'n':>5}{'exact':>8}{'flip':>8}{'|delta|':>10}{'q_pass':>8}")
    for dim in JudgeDimension:
        d = stats["per_dimension"][dim.value]
        if d["n_applicable"] == 0:
            print(f"{dim.value:<24}{0:>5}{'--':>8}{'--':>8}{'--':>10}{'--':>8}")
            continue
        print(
            f"{dim.value:<24}{d['n_applicable']:>5}{d['exact_agreement_rate']:>8.1%}"
            f"{d['pass_flip_rate']:>8.1%}{d['mean_abs_delta']:>10.2f}"
            f"{(d['q_pass_repeat'] if d['q_pass_repeat'] is not None else float('nan')):>8.1%}"
        )
    print()
    print(f"Implied weighted-score ceiling (perfect caddie): {stats['ceiling_expected']:.1%}")
    print(f"Run-sample band: pessimistic {stats['band_pessimistic']:.1%} .. optimistic {stats['band_optimistic']:.1%}")
    if "stored_first_pass_agreement" in stats:
        print("Fresh-vs-stored first-pass agreement (before/after Commit 1 signal):")
        for dim in JudgeDimension:
            rate = stats["stored_first_pass_agreement"].get(dim.value)
            print(f"  {dim.value:<24}{'--' if rate is None else f'{rate:.1%}'}")


async def run(args: argparse.Namespace) -> int:
    run_dir = RUNS_DIR / args.run_id
    results_path = run_dir / "results.jsonl"
    if not results_path.exists():
        print(f"no results.jsonl at {results_path} — is --run-id correct?", file=sys.stderr)
        return _EXIT_GATE_REFUSAL

    results = report.load_results(results_path)
    sample = sample_judged_advice_cases(results, sample_size=args.sample_size, seed=args.seed)
    if not sample:
        print("no judged advice cases to sample (empty/degenerate run) — nothing to measure.", file=sys.stderr)
        return _EXIT_GATE_REFUSAL

    bank = load_question_bank(QUESTIONS_V1_PATH)
    load_bags(BAGS_PATH)  # sanity: fail loudly here, not mid-sample, if bags are broken
    hole_paths = sorted(HOLES_DIR.glob("*.json"))
    fixtures = {p.stem: geo.load_hole_fixture(p) for p in hole_paths}
    fx_list = list(fixtures.values())
    all_cases: dict[str, BenchCase] = {c.id: c for c in q.build_cases(fx_list, bank)}

    model = os.getenv("CADDIE_BENCH_JUDGE_MODEL", "gpt-5.6-sol")
    total_cost = 0.0
    pairs: list[tuple[str, JudgeScores, JudgeScores]] = []
    engine_refs: dict[str, dict] = {}
    stored_first: dict[str, JudgeScores] = {}

    for result in sample:
        projected = 0.05
        if total_cost + projected > args.budget_usd:
            print(
                f"BUDGET CAP: stopping before case {result.case_id!r} — running ${total_cost:.4f} + "
                f"projected ${projected:.4f} > cap ${args.budget_usd:.2f}", file=sys.stderr,
            )
            return _EXIT_BUDGET_ABORT

        case = all_cases.get(result.case_id)
        if case is None:
            raise RuntimeError(
                f"case_id {result.case_id!r} from {results_path} not found in the current "
                "fixtures/question-bank build_cases() population -- fixtures/bank must have "
                "changed since this run; judge_noise never re-samples geometry, it re-judges "
                "exactly the run's own cases."
            )
        fx = fixtures[case.hole_fixture]
        composite_path = run_dir / "composites" / f"{case.id}.png"
        if not composite_path.exists():
            raise RuntimeError(
                f"missing composite for case {case.id!r} at {composite_path} -- "
                "run_caddie_bench.py must have already rendered it; judge_noise never re-renders."
            )
        det_summary = _det_summary(result)

        first, usage1 = await judge_mod.judge_case(
            case, result.resolved, result.engine_ref, result.answer, det_summary,
            composite_path=composite_path, model=model,
            hole_number=fx.hole_number, par=fx.par, hole_yards=fx.yards,
        )
        second, usage2 = await judge_mod.judge_case(
            case, result.resolved, result.engine_ref, result.answer, det_summary,
            composite_path=composite_path, model=model,
            hole_number=fx.hole_number, par=fx.par, hole_yards=fx.yards,
        )
        total_cost += _cost_usd(model, usage1.get("input_tokens", 0), usage1.get("output_tokens", 0))
        total_cost += _cost_usd(model, usage2.get("input_tokens", 0), usage2.get("output_tokens", 0))

        pairs.append((case.id, first, second))
        engine_refs[case.id] = result.engine_ref
        if result.judge is not None:
            stored_first[case.id] = result.judge

    stats = compute_noise_stats(pairs, engine_refs, stored_first=stored_first)
    stats["run_id"] = args.run_id
    stats["sample_size"] = len(pairs)
    stats["seed"] = args.seed
    stats["total_cost_usd"] = round(total_cost, 4)

    out_path = run_dir / "judge_noise.json"
    out_path.write_text(json.dumps(stats, indent=2))
    print(f"Wrote {out_path}")
    _print_table(stats)
    return _EXIT_PASS


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--sample-size", type=int, default=30)
    parser.add_argument("--seed", type=int, default=3)
    parser.add_argument("--budget-usd", type=float, default=3.00)
    args = parser.parse_args(argv)

    if os.getenv("CADDIE_EVAL_LIVE") != "1" or not os.getenv("OPENAI_API_KEY"):
        print(
            "judge_noise is gated OFF by default (never runs in CI). To run it on-demand, "
            "against an already-completed caddie_bench run:\n"
            "  cd backend && CADDIE_EVAL_LIVE=1 OPENAI_API_KEY=... uv run python -m "
            "tests.eval.caddie_bench.judge_noise --run-id <run_id> --sample-size 30\n"
            "Requires OPENAI_API_KEY set AND CADDIE_EVAL_LIVE=1.",
            file=sys.stderr,
        )
        return _EXIT_GATE_REFUSAL

    import asyncio

    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
