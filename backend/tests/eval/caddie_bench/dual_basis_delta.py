"""Cycle-4 dual-basis delta report.

Prints BOTH headline bases for a new run, and the like-for-like delta against
a prior run, so the 53.4 -> 77.0 -> ? trajectory stays interpretable:

  * NEW basis   = 11 dims (incl. aggression_realism), satellite-judged, 189 cases
  * LEGACY basis = the same run scored over the original 10 dims only

The ONLY honest comparison against a pre-cycle-4 run is
`prior.weighted_correctness_score` (10-dim) vs this run's
`weighted_correctness_score_legacy10` (10-dim) — that is what "delta" means
below. The new-basis number has no prior and starts its own trajectory.

Read-only: reads runs/<id>/results.jsonl, makes no network/DB/LLM call and
writes nothing. `DATABASE_URL` is only the same never-connected placeholder
the other bench commands need (import-chain side effect, see README).

Usage (from backend/):
  DATABASE_URL=postgresql+asyncpg://unused:unused@localhost:5432/unused \
    uv run python -m tests.eval.caddie_bench.dual_basis_delta <NEW_RUN_ID> [PRIOR_RUN_ID]
"""
from __future__ import annotations

import sys
from pathlib import Path

# Run from `backend/` (the repo's usual cwd for bench commands); this file
# lives at backend/tests/eval/caddie_bench/, so `backend/` is 3 levels up.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tests.eval.caddie_bench.report import compute_headline, load_results  # noqa: E402

RUNS = Path("tests/eval/caddie_bench/runs")


def headline_for(run_id: str):
    p = RUNS / run_id / "results.jsonl"
    if not p.exists():
        raise SystemExit(f"no results.jsonl for run {run_id!r} at {p}")
    results = load_results(p)
    return compute_headline(results), len(results)


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def main(argv: list[str]) -> int:
    if not argv:
        raise SystemExit(__doc__)
    new_id = argv[0]
    prior_id = argv[1] if len(argv) > 1 else None

    new, new_n = headline_for(new_id)

    print(f"\n{'=' * 68}\nCADDIE BENCH — DUAL-BASIS HEADLINE\n{'=' * 68}")
    print(f"run: {new_id}   results lines: {new_n}   judged advice cases: {new.case_count}")
    print()
    print(f"  NEW basis   (11-dim, satellite)  weighted correctness : {pct(new.weighted_correctness_score)}")
    print(f"  LEGACY basis(10-dim, comparable) weighted correctness : {pct(new.weighted_correctness_score_legacy10)}")
    print(f"  correctness dims (7, unweighted avg)                  : {pct(new.correctness_dims_pass_rate)}")
    print(f"  owner-crux dims (4, unweighted avg)                   : {pct(new.crux_dims_pass_rate)}")
    print(f"  degraded rate                                         : {pct(new.degraded_rate)}")
    print(f"  contested rate                                        : {pct(new.contested_rate)}")
    print(f"  canary_all_pass (True = TEETH MISSING, run invalid)   : {new.canary_all_pass}  "
          f"(canaries: {new.canary_count})")
    print(f"  det-check pass rate (overall)                         : {pct(new.det_check_pass_rate_overall)}")
    if new.fact_routing_accuracy is not None:
        print(f"  FACT routing accuracy                                 : {pct(new.fact_routing_accuracy)}")

    print("\n  per-dimension pass rate:")
    for dim, rate in sorted(new.dimension_pass_rate.items(), key=lambda kv: kv[1]):
        print(f"    {dim:<24} {pct(rate)}")

    if prior_id:
        prior, prior_n = headline_for(prior_id)
        d = new.weighted_correctness_score_legacy10 - prior.weighted_correctness_score
        print(f"\n{'-' * 68}\nLIKE-FOR-LIKE DELTA vs prior run {prior_id} (both on the 10-dim basis)\n{'-' * 68}")
        print(f"  prior (10-dim): {pct(prior.weighted_correctness_score)}   "
              f"[{prior.case_count} judged cases]")
        print(f"  this  (10-dim): {pct(new.weighted_correctness_score_legacy10)}   "
              f"[{new.case_count} judged cases]")
        print(f"  DELTA         : {d * 100:+.1f} pts")
        print(f"  degraded rate : {pct(prior.degraded_rate)} -> {pct(new.degraded_rate)}")
        print("\n  NOTE: the case SET also changed this cycle (150 -> 189 cases, trouble lies")
        print("  46.0% -> 28.6%), so this delta is NOT a pure caddie-quality delta — it mixes")
        print("  the engine fix with a deliberately more realistic scenario mix. Report it as")
        print("  such; do not attribute the whole movement to the caddie.")
        print(f"\n  NEW-basis number ({pct(new.weighted_correctness_score)}) has NO prior — it starts")
        print("  the honest trajectory going forward (11-dim, satellite-judged).")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
