"""On-demand, LIVE strategy-synthesis latency probe (specs/caddie-smart
-strategy-tool-plan.md §5). Measures `strategy.synthesize_strategy`'s round
trip against a fixture GROUND TRUTH block (no DB, no session) — the leg of
`get_strategy` this backend fully controls: session load + payload assembly
are the existing, already-fast per-tool endpoints (§0.2 budget: ≤200ms), so
this probe isolates the ONE new networked call.

NEVER runs in CI. Same three-guard shape as `run_latency.py`:
  1. Filename does not match `test_*.py` — pytest never collects this module
     (pinned in `test_substance_teeth.py`).
  2. `main()` refuses to run unless BOTH `OPENAI_API_KEY` and
     `CADDIE_EVAL_LIVE=1` are set — this probe needs the OpenAI key (the
     strategy brain is OpenAI, NOT Anthropic); CI sets neither.
  3. `.github/workflows/ci.yml` is not modified by this item.

Invocation (never in CI):
    cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_strategy_latency --n 5

`--model` sweeps the fallback tiers (gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna);
`--effort` A/Bs `low` vs `none` reasoning effort. Key-free by construction: the
report is latency + usage token counts only, never the API key or the
synthesized narrative's full text (a 60-char preview only, for a human sanity
check when reading the report).

IMPORTANT: import-safe with NO env / NO network required at import time — the
OPENAI_API_KEY-touching call is deferred into `_run_async`, invoked only after
the gate in `main()` passes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Optional

from tests.eval.run_latency import _p95

_LAST_RUN_PATH = Path(__file__).parent / "last_strategy_latency_run.json"  # gitignored


# A fixture GROUND TRUTH block — hand-built (no DB, no live session) but in
# the exact shape `strategy.format_strategy_ground_truth` renders, so the
# probe measures the real synthesize_strategy call against realistic input
# size/shape. Mirrors a golden-style scenario: a mid-length par 4, a driver
# tee shot, one bunker hazard, a green read.
_FIXTURE_GROUND_TRUTH = """GROUND TRUTH (authoritative — the deterministic caddie engine). Every number and hazard below is fixed; there are NO other hazards.

RECOMMENDATION:
  Tee-shot numbers for hole 7 (AUTHORITATIVE — they close: 410 - 276 = 134): 410 to the green (GPS yardage); plays like 415 today; Driver — 300 stored, carries 266 and totals 276 in these conditions; leaves about 135 in. Speak ONLY these numbers for this tee shot.

CONDITIONS:
  Weather: 68.0F, wind 6.0mph from 210 degrees.
  Plays like 415y (raw 410y, elevation change 8.0ft).
  Hole 7 hazards: bunker L 245y, water R 300y — the COMPLETE list — there are NO others.
  Green slope: back-to-front, moderate.

CARRIES:
  bunker left carry 245y
  water right carry 300y

SHAPE:
  Doglegs left at ~230y.

GREEN READ:
  Uphill leave side: right. Leave it right of the pin for the uphill putt.

PLAYER:
  Handicap: 12.0. Club distances: {"7iron": 160, "driver": 300, "pw": 120}."""


def _redact_narrative(text: str) -> str:
    """Preview only — never the full synthesized narrative in a persisted
    report (this tool measures latency, not a content archive)."""
    flat = " ".join(text.split())
    return flat[:60] + ("…" if len(flat) > 60 else "")


async def _run_async(n: int, model: str, effort: str) -> tuple[list[float], list[dict]]:
    # Deferred import: touches OPENAI_API_KEY / other app modules only after
    # main()'s gate has already passed.
    from app.caddie import strategy

    os.environ["CADDIE_STRATEGY_REASONING_EFFORT"] = effort

    latencies_ms: list[float] = []
    previews: list[dict] = []
    for i in range(n):
        start = time.monotonic()
        text, usage = await strategy.synthesize_strategy(_FIXTURE_GROUND_TRUTH, model=model)
        elapsed_ms = (time.monotonic() - start) * 1000
        latencies_ms.append(elapsed_ms)
        preview = {
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "text_preview": _redact_narrative(text),
        }
        previews.append(preview)
        print(f"[{i + 1}/{n}] synth round-trip: {elapsed_ms:.0f}ms — {preview}")
    return latencies_ms, previews


def run(args: argparse.Namespace) -> int:
    latencies_ms, previews = asyncio.run(_run_async(args.n, args.model, args.effort))

    p50 = statistics.median(latencies_ms)
    p95 = _p95(latencies_ms)

    report = {
        "n": args.n,
        "model": args.model,
        "reasoning_effort": args.effort,
        "latencies_ms": [round(ms, 1) for ms in latencies_ms],
        "p50_ms": round(p50, 1),
        "p95_ms": round(p95, 1),
        "p95_clamped_to_observed_max": True,
        "calls": previews,
    }
    # Key-free by construction: latency + usage numbers + a short redacted
    # preview only, never the API key or the full narrative.
    _LAST_RUN_PATH.write_text(json.dumps(report, indent=2))

    print()
    print(
        f"Strategy synthesis latency ({args.model}, effort={args.effort}) over "
        f"{args.n} calls — p50 {p50:.0f}ms, p95 {p95:.0f}ms"
    )
    print(f"Full report written to: {_LAST_RUN_PATH}")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="On-demand LIVE strategy-synthesis latency probe. Never runs in CI — see module docstring.",
    )
    parser.add_argument("--n", type=int, default=5)
    parser.add_argument(
        "--model", type=str, default=None,
        help="Override CADDIE_STRATEGY_MODEL for this run (e.g. gpt-5.6-terra, gpt-5.6-luna).",
    )
    parser.add_argument(
        "--effort", type=str, default="none", choices=["none", "low", "medium", "high", "xhigh", "max"],
        help="Reasoning effort to A/B (default: none, the production default as of the "
        "2026-07-17 on-box A/B — see strategy._strategy_reasoning_effort).",
    )
    args = parser.parse_args(argv)

    if not os.getenv("OPENAI_API_KEY") or os.getenv("CADDIE_EVAL_LIVE") != "1":
        print(
            "Strategy latency probe is gated OFF by default (never runs in CI). To run it on-demand:\n"
            "  cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_strategy_latency --n 5\n"
            "Requires OPENAI_API_KEY set AND CADDIE_EVAL_LIVE=1.",
            file=sys.stderr,
        )
        return 2

    if args.model is None:
        # Deferred import — see module docstring; safe here, the gate above
        # already confirmed we're proceeding.
        from app.caddie import strategy

        args.model = strategy._strategy_model()

    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
