"""Markdown report generator — pure: `runs/<id>/results.jsonl` -> markdown
(specs/caddie-bench-plan.md §1 report.py). Never touches the network; the
only I/O is reading a results JSONL / writing the `.md` file (+ copying the
worst-10 gallery images, which the caller passes in already-resolved).
"""

from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from tests.eval.caddie_bench.schema import (
    CORRECTNESS_DIMENSIONS,
    CaseResult,
    FailureClass,
    JudgeDimension,
)

# The 4 owner-crux dimensions (§5b: everything in JudgeDimension NOT in
# CORRECTNESS_DIMENSIONS) — the owner's felt caddie experience
# ([[caddie-experience-crux]]) lives here; a rosy weighted-correctness score
# must never hide weak crux scores, so these are reported as their OWN
# headline line, never folded into the correctness number.
CRUX_DIMENSIONS: frozenset[JudgeDimension] = frozenset(JudgeDimension) - CORRECTNESS_DIMENSIONS

# ── Real-call canary (self-detecting "the synth call never left the process")
#
# A `run_caddie_bench.py` wiring bug can make the LIVE synth seam silently
# resolve to itself (or otherwise short-circuit before reaching the real
# model) — every case then falls through to the engine's degraded fallback
# line, and the judge grades THAT, not real advice. That produced a run with
# degraded_rate=100% and a synth-call p50 latency of ~98ms (a real
# `gpt-5.6-sol` call takes well over a second). These are named, run-level
# thresholds so that failure mode can never again silently produce
# fallback-graded numbers that look like a real pilot.
REAL_CALL_CANARY_MAX_DEGRADED_RATE = 0.5  # >= this fraction degraded => synth call is suspect
REAL_CALL_CANARY_MIN_SYNTH_LATENCY_MS = 1000.0  # a real gpt-5.6-sol call takes >1s; below this it never left the process


@dataclass
class RunMeta:
    run_id: str
    synth_model: str = ""
    judge_model: str = ""
    synth_effort: str = ""
    total_cost_usd: float = 0.0
    wall_time_s: float = 0.0
    case_count: int = 0


@dataclass
class HeadlineStats:
    case_count: int
    dimension_pass_rate: dict[str, float]
    weighted_correctness_score: float  # 0..1, correctness dims weighted 2x (§5b) — ADVICE cases only (#6)
    correctness_dims_pass_rate: float  # 0..1, unweighted avg of the 6 correctness dims (reviewer meta-note)
    crux_dims_pass_rate: float  # 0..1, unweighted avg of the 4 owner-crux dims (reviewer meta-note)
    degraded_rate: float
    contested_rate: float
    canary_all_pass: bool  # True = TEETH MISSING (a canary scored good) -> run must fail
    canary_count: int
    det_check_pass_rate: dict[str, float]
    det_check_pass_rate_overall: float  # 0..1, aggregate across every det check (#11)
    fact_routing_accuracy: Optional[float]  # FACT-class cases: fraction that routed to Intent.FACT (#6)
    fact_case_count: int
    latency_p50_ms: Optional[float]
    latency_p95_ms: Optional[float]
    failure_class_counts: dict[str, int] = field(default_factory=dict)
    # cycle-3 commit 1: per-dimension APPLICABLE count -- shot_reachability is
    # only applicable/aggregated on positioning-shot cases (see the `continue`
    # in the dim_scores loop below), so its own `n` can be far smaller than
    # `case_count`; without this a small positioning sample could masquerade
    # as a full-population rate in the report table.
    dimension_n: dict[str, int] = field(default_factory=dict)


@dataclass
class RealCallCanaryResult:
    invalid: bool
    reasons: list[str] = field(default_factory=list)


def check_real_call_canary(headline: HeadlineStats) -> RealCallCanaryResult:
    """Run-level self-check: does this run look like the synth call actually
    reached the real model? Evaluated on EVERY run (including a
    `--max-cases 2` smoke) — see `REAL_CALL_CANARY_*` above for why. An empty
    run (0 cases, e.g. an `--only-failures` resume with nothing left to
    retry) has no signal either way and is never flagged."""
    if headline.case_count == 0:
        return RealCallCanaryResult(invalid=False)

    reasons: list[str] = []
    if headline.degraded_rate >= REAL_CALL_CANARY_MAX_DEGRADED_RATE:
        reasons.append(
            f"degraded_rate {headline.degraded_rate:.1%} >= {REAL_CALL_CANARY_MAX_DEGRADED_RATE:.0%} "
            "(nearly every case fell through to the engine's fallback line)"
        )
    if headline.latency_p50_ms is not None and headline.latency_p50_ms < REAL_CALL_CANARY_MIN_SYNTH_LATENCY_MS:
        reasons.append(
            f"latency p50 {headline.latency_p50_ms:.0f}ms < {REAL_CALL_CANARY_MIN_SYNTH_LATENCY_MS:.0f}ms "
            "(too fast for a real model call — it never left the process)"
        )
    return RealCallCanaryResult(invalid=bool(reasons), reasons=reasons)


def _is_fact_case(case_id: str) -> bool:
    # FACT-class case ids are always `<hole_fixture>__fact__<phrasing_id>`
    # (questions.py::build_cases) — same "id substring" convention
    # `compute_headline` already uses for `canary__` ids.
    return "__fact__" in case_id


def load_results(path: Path) -> list[CaseResult]:
    results: list[CaseResult] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            results.append(CaseResult.model_validate(json.loads(line)))
    return results


def compute_headline(results: list[CaseResult]) -> HeadlineStats:
    # #6: FACT-class cases (canned distance readouts) never get the 10-dim
    # advice rubric (the runner skips the LLM judge for them — `judge is
    # None`); this filter is explicit/defensive too, so the headline stays
    # ADVICE-only even if a result somehow carries both a FACT case id and a
    # judge score (e.g. older run data from before this fix).
    judged = [r for r in results if r.judge is not None and not _is_fact_case(r.case_id)]
    dim_scores: dict[JudgeDimension, list[int]] = defaultdict(list)
    for r in judged:
        for dim, v in r.judge.scores.items():
            # Commit 1: shot_reachability is N/A off a positioning shot (the
            # rubric/judge only meaningfully scores it when the ENGINE
            # REFERENCE says shot_kind=positioning — an out-of-reach shot).
            # `engine_ref` is a plain dict on every CaseResult, so this reads
            # the deterministic oracle rather than trusting the judge to
            # self-declare applicability; old runs re-aggregate correctly
            # too, with zero re-spend.
            if dim == JudgeDimension.SHOT_REACHABILITY and (r.engine_ref or {}).get("shot_kind") != "positioning":
                continue
            dim_scores[dim].append(v)

    dim_pass_rate: dict[str, float] = {}
    dim_n: dict[str, int] = {}
    for dim in JudgeDimension:
        vals = dim_scores.get(dim, [])
        dim_pass_rate[dim.value] = (sum(1 for v in vals if v == 2) / len(vals)) if vals else 0.0
        dim_n[dim.value] = len(vals)

    weighted_num = 0.0
    weighted_den = 0.0
    for dim, vals in dim_scores.items():
        weight = 2 if dim in CORRECTNESS_DIMENSIONS else 1
        weighted_num += sum(vals) * weight
        weighted_den += len(vals) * 2 * weight  # max score per item is 2
    weighted_correctness = (weighted_num / weighted_den) if weighted_den else 0.0

    # Reviewer meta-note: report the 6 correctness dims AND the 4 owner-crux
    # dims as SEPARATE headline numbers (unweighted avg pass rate each) —
    # never let a rosy weighted-correctness hide weak crux scores.
    correctness_rates = [dim_pass_rate[d.value] for d in CORRECTNESS_DIMENSIONS if dim_scores.get(d)]
    crux_rates = [dim_pass_rate[d.value] for d in CRUX_DIMENSIONS if dim_scores.get(d)]
    correctness_dims_pass_rate = statistics.fmean(correctness_rates) if correctness_rates else 0.0
    crux_dims_pass_rate = statistics.fmean(crux_rates) if crux_rates else 0.0

    degraded_rate = (sum(1 for r in results if r.degraded) / len(results)) if results else 0.0
    contested_rate = (sum(1 for r in judged if r.contested) / len(judged)) if judged else 0.0

    canary_results = [r for r in results if r.case_id.startswith("canary__")]
    canary_all_pass = any(
        r.judge is not None
        and (r.judge.failure_class == FailureClass.GOOD or all(v == 2 for v in r.judge.scores.values()))
        for r in canary_results
    )

    # #6: FACT-class routing correctness, reported separately from the
    # advice rubric — "did this case route to Intent.FACT" (recorded on
    # every `CaseResult.intent`, judged or not).
    fact_results = [r for r in results if _is_fact_case(r.case_id)]
    fact_routing_accuracy = (
        (sum(1 for r in fact_results if r.intent == "fact") / len(fact_results)) if fact_results else None
    )

    det_totals: Counter = Counter()
    det_passed: Counter = Counter()
    for r in results:
        for dc in r.det_checks:
            det_totals[dc.check.value] += 1
            if dc.passed:
                det_passed[dc.check.value] += 1
    det_pass_rate = {k: (det_passed[k] / v if v else 0.0) for k, v in det_totals.items()}
    # #11: DET_CHECK_WEIGHT was declared but never wired anywhere — an
    # unused constant implying det checks fed the headline when they
    # didn't. Deleted it; instead surface an aggregate det-check pass rate
    # directly in the headline (not just the lower per-check table), so a
    # deterministic RED is visible at a glance, never buried.
    det_total_all = sum(det_totals.values())
    det_check_pass_rate_overall = (sum(det_passed.values()) / det_total_all) if det_total_all else 0.0

    latencies = [r.latency_ms for r in results if r.latency_ms > 0]
    p50 = statistics.median(latencies) if latencies else None
    p95 = (
        statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 5
        else (max(latencies) if latencies else None)
    )

    failure_counts: Counter = Counter(r.judge.failure_class.value for r in judged if r.judge is not None)

    return HeadlineStats(
        case_count=len(results),
        dimension_pass_rate=dim_pass_rate,
        weighted_correctness_score=weighted_correctness,
        correctness_dims_pass_rate=correctness_dims_pass_rate,
        crux_dims_pass_rate=crux_dims_pass_rate,
        degraded_rate=degraded_rate,
        contested_rate=contested_rate,
        canary_all_pass=canary_all_pass,
        canary_count=len(canary_results),
        det_check_pass_rate=det_pass_rate,
        det_check_pass_rate_overall=det_check_pass_rate_overall,
        fact_routing_accuracy=fact_routing_accuracy,
        fact_case_count=len(fact_results),
        latency_p50_ms=p50,
        latency_p95_ms=p95,
        failure_class_counts=dict(failure_counts),
        dimension_n=dim_n,
    )


def failure_class_pareto(results: list[CaseResult]) -> list[tuple[str, str, str, str, int]]:
    """(failure_class, question_type_placeholder, lie, hole, count) rows,
    sorted by count desc. `question_type` isn't on `CaseResult` (only on the
    `BenchCase` that produced it) — callers with the source cases should join
    beforehand; this pure function works off what `CaseResult` alone carries
    (failure_class x lie x hole, parsed from `case_id`'s `<hole_fixture>__...`
    prefix)."""
    counts: Counter = Counter()
    for r in results:
        if r.judge is None or r.judge.failure_class == FailureClass.GOOD:
            continue
        hole = r.case_id.split("__")[0]
        counts[(r.judge.failure_class.value, r.resolved.lie.value, hole)] += 1
    rows = [(fc, "-", lie, hole, n) for (fc, lie, hole), n in counts.items()]
    return sorted(rows, key=lambda row: -row[-1])


def worst_cases(results: list[CaseResult], n: int = 10) -> list[CaseResult]:
    """Lowest weighted-score cases first (judged cases only); ties broken by
    case_id for determinism."""
    def _score(r: CaseResult) -> float:
        if r.judge is None:
            return 99.0
        return sum(r.judge.scores.values())

    judged = [r for r in results if r.judge is not None]
    return sorted(judged, key=lambda r: (_score(r), r.case_id))[:n]


def generate_report(
    results: list[CaseResult], meta: RunMeta, *,
    worst_gallery_paths: Optional[dict[str, Path]] = None,
    delta_against: Optional["HeadlineStats"] = None,
) -> str:
    """Pure markdown generation from resolved results + run metadata."""
    headline = compute_headline(results)
    lines: list[str] = []

    real_call_canary = check_real_call_canary(headline)
    if real_call_canary.invalid:
        lines.append("# 🚨 FAILED — REAL-CALL CANARY TRIPPED — RUN INVALID 🚨")
        lines.append("")
        lines.append(
            "**Do not trust any number below.** The synth call almost certainly never "
            "reached the real model — every graded case may be the engine's degraded "
            "fallback line, not real advice. Reasons:"
        )
        for reason in real_call_canary.reasons:
            lines.append(f"- {reason}")
        lines.append("")
        lines.append("---")
        lines.append("")

    lines.append(f"# Caddie Bench Report — run `{meta.run_id}`")
    lines.append("")
    lines.append("## Run header")
    lines.append(f"- Synth model: `{meta.synth_model}` (effort `{meta.synth_effort}`)")
    lines.append(f"- Judge model: `{meta.judge_model}`")
    lines.append(f"- Cases: {meta.case_count}  ·  Total cost: ${meta.total_cost_usd:.4f}  ·  Wall time: {meta.wall_time_s:.0f}s")
    lines.append("")

    lines.append("## Headline")
    lines.append(f"- **Weighted correctness score: {headline.weighted_correctness_score:.1%}**"
                 " (correctness dimensions weighted 2x — ADVICE cases only, FACT excluded, #6)")
    # Reviewer meta-note: correctness AND owner-crux reported as SEPARATE
    # lines — never let a rosy weighted-correctness hide weak crux scores.
    lines.append(f"- Correctness dims pass rate (unweighted avg of the 6): {headline.correctness_dims_pass_rate:.1%}")
    lines.append(f"- **Owner-crux dims pass rate (unweighted avg of the 4 — the felt experience): {headline.crux_dims_pass_rate:.1%}**")
    lines.append(f"- Deterministic pre-check pass rate (overall, all checks): {headline.det_check_pass_rate_overall:.1%}")
    if headline.fact_routing_accuracy is not None:
        lines.append(f"- FACT-class routing accuracy: {headline.fact_routing_accuracy:.1%} ({headline.fact_case_count} cases, reported separately — not judged on the advice rubric)")
    lines.append(f"- Degraded rate: {headline.degraded_rate:.1%}")
    lines.append(f"- Contested rate (second-pass disagreement): {headline.contested_rate:.1%}")
    lines.append(
        f"- Canary outcome: {'**FAIL — a canary scored GOOD, the judge has no teeth**' if headline.canary_all_pass else 'PASS (all canaries correctly scored bad)'}"
        f" ({headline.canary_count} canaries)"
    )
    if headline.latency_p50_ms is not None:
        lines.append(f"- Latency p50/p95: {headline.latency_p50_ms:.0f}ms / {headline.latency_p95_ms:.0f}ms")
    lines.append("")

    lines.append("## Per-dimension pass rate (judge, score==2)")
    lines.append("| Dimension | Pass rate |")
    lines.append("|---|---|")
    for dim in JudgeDimension:
        marker = " (2x weighted)" if dim in CORRECTNESS_DIMENSIONS else ""
        if dim == JudgeDimension.SHOT_REACHABILITY:
            marker += f", positioning shots only, n={headline.dimension_n.get(dim.value, 0)}"
        lines.append(f"| {dim.value}{marker} | {headline.dimension_pass_rate.get(dim.value, 0.0):.1%} |")
    lines.append("")

    lines.append("## Deterministic pre-check pass rate")
    lines.append("| Check | Pass rate |")
    lines.append("|---|---|")
    for check, rate in sorted(headline.det_check_pass_rate.items()):
        lines.append(f"| {check} | {rate:.1%} |")
    lines.append("")

    lines.append("## Failure-class Pareto (count x lie x hole)")
    pareto = failure_class_pareto(results)
    if pareto:
        lines.append("| Failure class | Lie | Hole | Count |")
        lines.append("|---|---|---|---|")
        for fc, _qt, lie, hole, n in pareto[:30]:
            lines.append(f"| {fc} | {lie} | {hole} | {n} |")
    else:
        lines.append("_No non-GOOD judged cases._")
    lines.append("")

    lines.append("## Engine-flagged cases (`engine_looks_wrong`)")
    flagged = [r for r in results if r.judge is not None and r.judge.engine_looks_wrong]
    if flagged:
        for r in flagged:
            lines.append(f"- `{r.case_id}`: {r.judge.reason}")
    else:
        lines.append("_None._")
    lines.append("")

    lines.append("## Worst-10 case gallery")
    for r in worst_cases(results, 10):
        img_note = ""
        if worst_gallery_paths and r.case_id in worst_gallery_paths:
            img_note = f" — ![{r.case_id}]({worst_gallery_paths[r.case_id]})"
        fc = r.judge.failure_class.value if r.judge else "unjudged"
        lines.append(f"- `{r.case_id}` ({fc}){img_note}: {r.answer[:160]!r}")
    lines.append("")

    if delta_against is not None:
        lines.append("## Delta vs prior run")
        prior = delta_against.weighted_correctness_score
        cur = headline.weighted_correctness_score
        lines.append(f"- Weighted correctness: {prior:.1%} -> {cur:.1%} ({(cur - prior) * 100:+.1f}pp)")
        lines.append(f"- Degraded rate: {delta_against.degraded_rate:.1%} -> {headline.degraded_rate:.1%}")
        lines.append("")

    lines.append("## Cost log summary")
    lines.append(f"- Total: ${sum(r.cost_usd for r in results):.4f} over {len(results)} cases")
    lines.append("")

    return "\n".join(lines)


def write_report(results: list[CaseResult], meta: RunMeta, out_path: Path, **kwargs) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(generate_report(results, meta, **kwargs))
    return out_path
