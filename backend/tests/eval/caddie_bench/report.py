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
    weighted_correctness_score: float  # 0..1, correctness dims weighted 2x (§5b)
    degraded_rate: float
    contested_rate: float
    canary_all_pass: bool  # True = TEETH MISSING (a canary scored good) -> run must fail
    canary_count: int
    det_check_pass_rate: dict[str, float]
    latency_p50_ms: Optional[float]
    latency_p95_ms: Optional[float]
    failure_class_counts: dict[str, int] = field(default_factory=dict)


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
    judged = [r for r in results if r.judge is not None]
    dim_scores: dict[JudgeDimension, list[int]] = defaultdict(list)
    for r in judged:
        for dim, v in r.judge.scores.items():
            dim_scores[dim].append(v)

    dim_pass_rate: dict[str, float] = {}
    for dim in JudgeDimension:
        vals = dim_scores.get(dim, [])
        dim_pass_rate[dim.value] = (sum(1 for v in vals if v == 2) / len(vals)) if vals else 0.0

    weighted_num = 0.0
    weighted_den = 0.0
    for dim, vals in dim_scores.items():
        weight = 2 if dim in CORRECTNESS_DIMENSIONS else 1
        weighted_num += sum(vals) * weight
        weighted_den += len(vals) * 2 * weight  # max score per item is 2
    weighted_correctness = (weighted_num / weighted_den) if weighted_den else 0.0

    degraded_rate = (sum(1 for r in results if r.degraded) / len(results)) if results else 0.0
    contested_rate = (sum(1 for r in judged if r.contested) / len(judged)) if judged else 0.0

    canary_results = [r for r in results if r.case_id.startswith("canary__")]
    canary_all_pass = any(
        r.judge is not None
        and (r.judge.failure_class == FailureClass.GOOD or all(v == 2 for v in r.judge.scores.values()))
        for r in canary_results
    )

    det_totals: Counter = Counter()
    det_passed: Counter = Counter()
    for r in results:
        for dc in r.det_checks:
            det_totals[dc.check.value] += 1
            if dc.passed:
                det_passed[dc.check.value] += 1
    det_pass_rate = {k: (det_passed[k] / v if v else 0.0) for k, v in det_totals.items()}

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
        degraded_rate=degraded_rate,
        contested_rate=contested_rate,
        canary_all_pass=canary_all_pass,
        canary_count=len(canary_results),
        det_check_pass_rate=det_pass_rate,
        latency_p50_ms=p50,
        latency_p95_ms=p95,
        failure_class_counts=dict(failure_counts),
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

    lines.append(f"# Caddie Bench Report — run `{meta.run_id}`")
    lines.append("")
    lines.append("## Run header")
    lines.append(f"- Synth model: `{meta.synth_model}` (effort `{meta.synth_effort}`)")
    lines.append(f"- Judge model: `{meta.judge_model}`")
    lines.append(f"- Cases: {meta.case_count}  ·  Total cost: ${meta.total_cost_usd:.4f}  ·  Wall time: {meta.wall_time_s:.0f}s")
    lines.append("")

    lines.append("## Headline")
    lines.append(f"- **Weighted correctness score: {headline.weighted_correctness_score:.1%}**"
                 " (correctness dimensions weighted 2x)")
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
