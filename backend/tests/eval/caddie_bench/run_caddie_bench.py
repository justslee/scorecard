"""The gated LIVE pilot/full runner (specs/caddie-bench-plan.md §1
run_caddie_bench.py). Same three guards as `tests/eval/run_tier2.py`:

  1. Filename does NOT match `test_*.py` — pytest never collects this module
     (pinned by `test_bench_teeth.py`).
  2. `main()` refuses to run unless BOTH `OPENAI_API_KEY` and
     `CADDIE_EVAL_LIVE=1` are set.
  3. No CI workflow invokes this file.

Plus (§1): `--budget-usd` (pilot default 40.00) enforced BEFORE every
synth/judge call against a refuse-unknown-model pricing table; `--max-cases`,
`--only-failures <run_id>`, `--holes`, `--resume <run_id>` (per-case JSONL is
appended case-by-case — resumable at the case level); `--render-mode
{vector,satellite}` (default satellite, the owner's fidelity flow — hard-
requires `GOOGLE_MAPS_KEY`/`NEXT_PUBLIC_GOOGLE_MAPS_KEY`; `vector` never
touches a key, for an offline/no-key smoke). Writes
`runs/<run_id>/{results.jsonl, costs.jsonl, composites/}` — all gitignored,
all key-free. Exit codes mirror run_tier2: 0 pass-bar met / 1 missed /
2 gate refusal (incl. satellite mode with no maps key) / 3 budget abort /
4 REAL-CALL CANARY TRIPPED — run-level self-check that the synth call
actually left the process (see `report.check_real_call_canary` /
`REAL_CALL_CANARY_MAX_DEGRADED_RATE` / `REAL_CALL_CANARY_MIN_SYNTH_LATENCY_MS`);
this run's numbers must be treated as invalid and discarded, never graded.

Invocation (never in CI — run this yourself, after a reviewer signs off on
the judge rubric, per the builder's contract):
    cd backend && CADDIE_EVAL_LIVE=1 OPENAI_API_KEY=... uv run python -m \\
        tests.eval.caddie_bench.run_caddie_bench --budget-usd 8.00
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Optional

from tests.eval.caddie_bench import geometry as geo
from tests.eval.caddie_bench import harness, judge as judge_mod, questions as q, render, report
from tests.eval.caddie_bench.schema import (
    BAGS_PATH,
    HOLES_DIR,
    QUESTIONS_V1_PATH,
    RUNS_DIR,
    CaseResult,
    QuestionType,
    load_bags,
    load_question_bank,
)

# Pricing, $ per 1,000,000 tokens (input, output) — VERIFY against OpenAI's
# published pricing page before the first live run (plan §7). Refuses
# (raises) on an unknown model rather than silently costing $0 — same
# discipline as run_tier2._PRICING_PER_MTOK_USD.
_PRICING_PER_MTOK_USD: dict[str, tuple[float, float]] = {
    "gpt-5.6-sol": (1.75, 14.00),
}

# Exit codes (documented in the module docstring above).
_EXIT_PASS = 0
_EXIT_MISSED_BAR = 1
_EXIT_GATE_REFUSAL = 2
_EXIT_BUDGET_ABORT = 3
_EXIT_REAL_CALL_CANARY_INVALID = 4


def _cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    if model not in _PRICING_PER_MTOK_USD:
        raise RuntimeError(
            f"no pricing entry for model {model!r} — refusing to run rather than guess $0. "
            "Add it to _PRICING_PER_MTOK_USD in run_caddie_bench.py first."
        )
    in_price, out_price = _PRICING_PER_MTOK_USD[model]
    return (input_tokens / 1_000_000) * in_price + (output_tokens / 1_000_000) * out_price


class _LiveSynth:
    """Stateful `synthesize_strategy`-shaped callable — tracks cost/latency
    on itself so `harness.run_case` can read them back after the call
    (`run_strategy_turn` doesn't return token usage to its caller).

    BUG FIX (self-recursion): the original saved a reference to
    `app.caddie.strategy.synthesize_strategy` via a lazy `from ... import`
    done INSIDE `__call__`. `harness._stub_synth` patches that exact module
    attribute (`strategy_mod.synthesize_strategy = synth`, i.e. this
    instance) before `run_strategy_turn` ever calls it — so once patched,
    re-resolving the name at call time returned THIS wrapper, not the real
    OpenAI-backed function. The wrapper called itself, recursed ~980 deep,
    hit RecursionError, and every case silently fell through to the engine's
    degraded line instead of ever reaching the real model (observed:
    degraded_rate 100%, synth latency p50 98ms — invalidating the pilot).

    Fix: capture the ORIGINAL callable ONCE at construction time, before
    `_stub_synth` ever installs this wrapper (this instance is always built
    before the first `harness.run_case` call — see `run()` below), and
    delegate to that saved reference forever after. Never re-resolve
    `strategy.synthesize_strategy` inside `__call__` — that name IS this
    wrapper once a case is in flight."""

    def __init__(self, model: str, cost_log: list[dict], case_id_ref: list[str]):
        from app.caddie.strategy import synthesize_strategy as real_synthesize_strategy

        self.model = model
        self.cost_log = cost_log
        self.case_id_ref = case_id_ref  # mutable 1-elem list holding the CURRENT case id
        self.last_cost_usd = 0.0
        self.last_latency_ms = 0.0
        # cycle-3 commit 2 — the raw pre-validation synth text for the CURRENT
        # in-flight case, reset at the top of every `__call__` (see there).
        self.last_raw_text: Optional[str] = None
        # The REAL, un-patched synth — resolved once, before any patch exists.
        self._real_synthesize_strategy = real_synthesize_strategy

    async def __call__(self, ground_truth: str, *, model: str) -> tuple[str, dict]:
        # Staleness guard (cycle-3 commit 2): cleared FIRST, before the real
        # call — if the call raises, `last_raw_text` must never leak the
        # PREVIOUS case's text onto this one.
        self.last_raw_text = None
        start = time.monotonic()
        text, usage = await self._real_synthesize_strategy(ground_truth, model=model)
        self.last_raw_text = text
        self.last_latency_ms = (time.monotonic() - start) * 1000
        self.last_cost_usd = _cost_usd(model, usage.get("input_tokens", 0), usage.get("output_tokens", 0))
        self.cost_log.append({
            "case_id": self.case_id_ref[0], "call": "synth", "model": model,
            "input_tokens": usage.get("input_tokens", 0), "output_tokens": usage.get("output_tokens", 0),
            "usd": round(self.last_cost_usd, 6),
        })
        return text, usage


def _append_jsonl(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj) + "\n")


async def run(args: argparse.Namespace) -> int:
    # #4: satellite (the default, owner's fidelity flow) hard-requires a
    # maps key — `render.fetch_base_tile` also raises on this, but only at
    # the FIRST case's render, after we've already spent a synth+judge call.
    # Fail fast, before any budget is spent. VECTOR mode must NEVER require
    # (or even look at) a maps key.
    if args.render_mode == "satellite" and not (
        os.getenv("GOOGLE_MAPS_KEY") or os.getenv("NEXT_PUBLIC_GOOGLE_MAPS_KEY")
    ):
        print(
            "--render-mode satellite (the default) requires GOOGLE_MAPS_KEY (or "
            "NEXT_PUBLIC_GOOGLE_MAPS_KEY) set — refusing to start a run that would fail "
            "on the first render. Pass --render-mode vector for an offline/no-key smoke.",
            file=sys.stderr,
        )
        return _EXIT_GATE_REFUSAL

    run_id = args.resume or time.strftime("%Y%m%d-%H%M%S")
    out_dir = RUNS_DIR / run_id
    results_path = out_dir / "results.jsonl"
    costs_path = out_dir / "costs.jsonl"

    bank = load_question_bank(QUESTIONS_V1_PATH)
    bags = load_bags(BAGS_PATH)
    hole_paths = sorted(HOLES_DIR.glob("*.json"))
    if args.holes:
        wanted = set(args.holes)
        hole_paths = [p for p in hole_paths if p.stem in wanted]
    fixtures = {p.stem: geo.load_hole_fixture(p) for p in hole_paths}
    fx_list = list(fixtures.values())
    by_phrasing = {p.phrasing_id: p for p in bank}

    cases = q.build_cases(fx_list, bank)
    if args.only_failures:
        prior_path = RUNS_DIR / args.only_failures / "results.jsonl"
        prior = report.load_results(prior_path)
        failing_ids = {
            r.case_id for r in prior
            if r.judge is not None and r.judge.failure_class.value != "good"
        }
        cases = [c for c in cases if c.id in failing_ids]
    if args.max_cases is not None:
        cases = cases[: args.max_cases]

    already_done: set[str] = set()
    if results_path.exists():
        already_done = {r.case_id for r in report.load_results(results_path)}
        cases = [c for c in cases if c.id not in already_done]

    cost_log: list[dict] = []
    case_id_ref = [""]
    synth = _LiveSynth(model=os.getenv("CADDIE_STRATEGY_MODEL", "gpt-5.6-sol"), cost_log=cost_log, case_id_ref=case_id_ref)

    total_cost = 0.0
    per_case_costs: list[float] = []
    aborted = False
    start_wall = time.monotonic()
    n_run = 0

    for case in cases:
        if len(per_case_costs) >= 5:
            projected = statistics.quantiles(per_case_costs, n=20)[18]
        elif per_case_costs:
            projected = max(per_case_costs)
        else:
            projected = 0.05
        if total_cost + projected > args.budget_usd:
            print(
                f"BUDGET CAP: stopping before case {case.id!r} — running ${total_cost:.4f} + "
                f"projected ${projected:.4f} > cap ${args.budget_usd:.2f}", file=sys.stderr,
            )
            aborted = True
            break

        case_id_ref[0] = case.id
        fx = fixtures[case.hole_fixture]
        phrasing = by_phrasing[case.phrasing_id]
        bag = bags[case.bag]

        result = await harness.run_case(case, fx, phrasing, bag, synth=synth)

        composite_path = render.render_case(case, fx, result.resolved, mode=args.render_mode, out_dir=out_dir)
        det_summary = "; ".join(f"{d.check.value}={'PASS' if d.passed else 'FAIL'}" for d in result.det_checks)

        # #6 fix: FACT-class cases are canned one-liner distance readouts —
        # the full 10-dim advice rubric (club corridor, miss-side evidence,
        # strategic depth, ...) doesn't apply to them and dragged the
        # weighted-correctness headline. Skip the LLM judge entirely for
        # FACT cases (`judge=None` -> `report.compute_headline` naturally
        # excludes them from weighted correctness/per-dim pass rate/worst-10,
        # same filter it already applies); their routing correctness
        # (`result.intent == "fact"`) is reported separately (report.py).
        if case.question_type == QuestionType.FACT_DISTANCE:
            first_scores, second_scores, contested, judge_cost = None, None, False, 0.0
        else:
            first_scores, judge_usage = await judge_mod.judge_case(
                case, result.resolved, result.engine_ref, result.answer, det_summary,
                composite_path=composite_path, hole_number=fx.hole_number, par=fx.par, hole_yards=fx.yards,
            )
            judge_cost = _cost_usd(judge_mod._judge_model(), judge_usage.get("input_tokens", 0), judge_usage.get("output_tokens", 0)) if judge_usage else 0.0
            cost_log.append({
                "case_id": case.id, "call": "judge", "model": judge_mod._judge_model(),
                "input_tokens": judge_usage.get("input_tokens", 0), "output_tokens": judge_usage.get("output_tokens", 0),
                "usd": round(judge_cost, 6),
            })

            # #5 fix: the second-pass judge call's own usage used to be
            # discarded entirely (`_usage` thrown away inside judge.py) —
            # logged nowhere, counted nowhere, so the runner wrote no
            # `judge2` cost line and `--budget-usd` undercounted ~15% of
            # judge calls (every second-pass case). `second_pass_if_needed`
            # now returns the usage; log + fold it into this case's cost.
            second_scores, contested, judge2_usage = await judge_mod.second_pass_if_needed(
                first_scores, result.det_checks, case, result.resolved, result.engine_ref, result.answer,
                det_summary, composite_path=composite_path, hole_number=fx.hole_number, par=fx.par, hole_yards=fx.yards,
            )
            if judge2_usage:
                judge2_cost = _cost_usd(
                    judge_mod._judge_model(), judge2_usage.get("input_tokens", 0), judge2_usage.get("output_tokens", 0),
                )
                judge_cost += judge2_cost
                cost_log.append({
                    "case_id": case.id, "call": "judge2", "model": judge_mod._judge_model(),
                    "input_tokens": judge2_usage.get("input_tokens", 0), "output_tokens": judge2_usage.get("output_tokens", 0),
                    "usd": round(judge2_cost, 6),
                })

        case_cost = result.cost_usd + judge_cost
        total_cost += case_cost
        per_case_costs.append(case_cost)
        n_run += 1

        final = CaseResult(
            case_id=result.case_id, resolved=result.resolved, intent=result.intent, answer=result.answer,
            degraded=result.degraded, engine_ref=result.engine_ref, det_checks=result.det_checks,
            judge=first_scores, judge_second=second_scores, contested=contested,
            cost_usd=case_cost, latency_ms=result.latency_ms,
            # cycle-3 commit 2 — this explicit constructor is the silent-drop
            # trap: without copying these two fields from `result` (already
            # populated by `harness.run_case`), they'd default to None here
            # and every degrade would look uninstrumented. Teeth-tested.
            degrade_reason=result.degrade_reason, raw_synth_text=result.raw_synth_text,
        )
        _append_jsonl(results_path, json.loads(final.model_dump_json()))
        for entry in cost_log:
            _append_jsonl(costs_path, entry)
        cost_log.clear()

        print(f"[{n_run}/{len(cases)}] {case.id} — ${case_cost:.4f} (running total ${total_cost:.4f})")

    all_results = report.load_results(results_path) if results_path.exists() else []
    headline = report.compute_headline(all_results)
    meta = report.RunMeta(
        run_id=run_id, synth_model=synth.model, judge_model=judge_mod._judge_model(),
        synth_effort=os.getenv("CADDIE_STRATEGY_REASONING_EFFORT", "none"),
        total_cost_usd=sum(r.cost_usd for r in all_results), wall_time_s=time.monotonic() - start_wall,
        case_count=len(all_results),
    )
    report_path = report.write_report(all_results, meta, Path(args.report_out) if args.report_out else out_dir / "report.md")
    print(f"Report written to: {report_path}")

    # Self-detecting real-call canary — evaluated EVERY run, including a
    # `--max-cases 2` smoke, so the recursion bug (or anything else that
    # keeps the synth call from ever leaving the process) can never again
    # silently produce fallback-graded numbers that look like a real pilot.
    real_call_canary = report.check_real_call_canary(headline)
    if real_call_canary.invalid:
        print("=" * 78, file=sys.stderr)
        print("REAL-CALL CANARY TRIPPED — RUN INVALID, DO NOT TRUST THESE NUMBERS", file=sys.stderr)
        for reason in real_call_canary.reasons:
            print(f"  - {reason}", file=sys.stderr)
        print(
            "The synth call almost certainly never reached the real model (e.g. a "
            "self-referential patch/recursion) and every graded case may be the "
            "engine's degraded fallback line, not real advice from the model under test.",
            file=sys.stderr,
        )
        print("=" * 78, file=sys.stderr)
        return _EXIT_REAL_CALL_CANARY_INVALID

    if aborted:
        return _EXIT_BUDGET_ABORT
    if headline.canary_all_pass:
        print("CANARY GATE FAILED: at least one poison-pill case scored GOOD — the judge has no teeth.", file=sys.stderr)
        return _EXIT_MISSED_BAR
    if headline.weighted_correctness_score < args.min_weighted_correctness:
        return _EXIT_MISSED_BAR
    return _EXIT_PASS


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--budget-usd", type=float, default=40.00)
    parser.add_argument("--max-cases", type=int, default=None)
    parser.add_argument("--only-failures", default=None, metavar="RUN_ID")
    parser.add_argument("--holes", nargs="*", default=None, metavar="HOLE_FIXTURE_ID")
    parser.add_argument("--resume", default=None, metavar="RUN_ID")
    parser.add_argument("--min-weighted-correctness", type=float, default=0.85)
    parser.add_argument("--report-out", default=None)
    # #4: was a manual sed of the `mode="satellite"` literal at the
    # render_case call site — not load-bearing, easy to forget to revert.
    # satellite (default) = the owner's fidelity flow, judged against;
    # vector = zero-network/zero-key substrate for an offline smoke.
    parser.add_argument(
        "--render-mode", choices=["vector", "satellite"], default="satellite",
        help="Composite renderer backend (default: satellite, the owner's fidelity flow; "
        "requires GOOGLE_MAPS_KEY). Use 'vector' for a key-free/offline smoke.",
    )
    args = parser.parse_args(argv)

    if os.getenv("CADDIE_EVAL_LIVE") != "1" or not os.getenv("OPENAI_API_KEY"):
        print(
            "caddie_bench is gated OFF by default (never runs in CI). To run it on-demand "
            "(after a reviewer signs off on the judge rubric):\n"
            "  cd backend && CADDIE_EVAL_LIVE=1 OPENAI_API_KEY=... uv run python -m "
            "tests.eval.caddie_bench.run_caddie_bench --budget-usd 8.00\n"
            "Requires OPENAI_API_KEY set AND CADDIE_EVAL_LIVE=1.",
            file=sys.stderr,
        )
        return _EXIT_GATE_REFUSAL

    import asyncio

    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
