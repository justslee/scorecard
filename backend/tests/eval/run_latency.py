"""On-demand, LIVE ephemeral-mint latency probe (specs/caddie-experience
-harness-plan.md §5, dim 7 "minimal loading"). Measures the ONE leg of
cold-open latency this backend fully controls: the round-trip of
`mint_ephemeral_session` (POST to OpenAI's Realtime `client_secrets`
endpoint). Client-side latency (WebRTC connect + greeting) needs an on-box
TestFlight run — see CADDIE_EXPERIENCE.md's latency methodology section.

NEVER runs in CI. Same guard shape as `run_tier2.py` / `run_consistency.py`:
  1. Filename does not match `test_*.py` — pytest never collects this module.
  2. `main()` refuses to run unless BOTH `OPENAI_API_KEY` and
     `CADDIE_EVAL_LIVE=1` are set — CI sets neither.
  3. `.github/workflows/ci.yml` is not modified by this item.

Invocation (never in CI):
    cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_latency --n 5

Key-free by construction: the OpenAI response's ephemeral `client_secret` (or
its GA `value` field) is REDACTED before any print or JSON write — this tool
measures and reports latency numbers, it must never leak a usable session
credential.

IMPORTANT: import-safe with NO env / NO network required at import time (the
DB/OPENAI_API_KEY-touching import of `app.services.realtime_relay` is
deferred into `_run_async`, called only after the gate in `main()` passes).
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

_LAST_RUN_PATH = Path(__file__).parent / "last_latency_run.json"  # gitignored


def _redact(response: dict) -> dict:
    """Never print/persist a real client_secret — this tool measures
    latency, it must never leak a usable ephemeral credential."""
    redacted = dict(response)
    if "client_secret" in redacted:
        redacted["client_secret"] = "[REDACTED]"
    if "value" in redacted:
        redacted["value"] = "[REDACTED]"
    return redacted


async def _run_async(n: int) -> list[float]:
    from app.services.realtime_relay import mint_ephemeral_session

    latencies_ms: list[float] = []
    for i in range(n):
        start = time.monotonic()
        response = await mint_ephemeral_session("You are a caddie.", None)
        elapsed_ms = (time.monotonic() - start) * 1000
        latencies_ms.append(elapsed_ms)
        print(f"[{i + 1}/{n}] mint round-trip: {elapsed_ms:.0f}ms — {_redact(response)}")
    return latencies_ms


def run(args: argparse.Namespace) -> int:
    latencies_ms = asyncio.run(_run_async(args.n))

    p50 = statistics.median(latencies_ms)
    p95 = statistics.quantiles(latencies_ms, n=20)[18] if len(latencies_ms) >= 5 else max(latencies_ms)

    report = {
        "n": args.n,
        "latencies_ms": [round(ms, 1) for ms in latencies_ms],
        "p50_ms": round(p50, 1),
        "p95_ms": round(p95, 1),
    }
    # Key-free by construction: latency numbers only, never a client_secret.
    _LAST_RUN_PATH.write_text(json.dumps(report, indent=2))

    print()
    print(f"Ephemeral mint latency over {args.n} calls — p50 {p50:.0f}ms, p95 {p95:.0f}ms")
    print(f"Full report written to: {_LAST_RUN_PATH}")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="On-demand LIVE ephemeral-mint latency probe. Never runs in CI — see module docstring.",
    )
    parser.add_argument("--n", type=int, default=5)
    args = parser.parse_args(argv)

    if not os.getenv("OPENAI_API_KEY") or os.getenv("CADDIE_EVAL_LIVE") != "1":
        print(
            "Latency probe is gated OFF by default (never runs in CI). To run it on-demand:\n"
            "  cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_latency --n 5\n"
            "Requires OPENAI_API_KEY set AND CADDIE_EVAL_LIVE=1.",
            file=sys.stderr,
        )
        return 2

    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
