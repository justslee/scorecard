"""On-demand, LIVE-model consistency probe (specs/caddie-experience-harness
-plan.md §3, dim 5 "consistency" — owner directive: "same club, same
yardages, same hazards named across repeated questions").

NEVER runs in CI. Same three independent guards as `run_tier2.py`:
  1. Filename does not match `test_*.py` — pytest never collects this module
     (`test_substance_teeth.py::test_run_consistency_filename_does_not_match_pytest_test_glob`
     pins this).
  2. `main()` refuses to run unless BOTH `ANTHROPIC_API_KEY` and
     `CADDIE_EVAL_LIVE=1` are set — CI sets neither.
  3. `.github/workflows/ci.yml` is not modified by this item; there is no
     job or step that could invoke this file.

Invocation (never in CI — run this yourself when you want a live read):
    cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_consistency --budget-usd 0.50

Design: for each probe in `golden/consistency_probes.jsonl`, sample the SAME
candidate call (`run_tier2._build_candidate_messages`, same builder/prompt
Tier 2 uses — "we eval what ships") `n` times at temperature=0.7 (sampling
variance is the entire point of this probe), extract `AnswerSubstance` per
answer (`substance.py`, pure), and report `substance_variance`. ZERO judge
calls — this probe is pure deterministic post-processing on live answers, so
cost is candidate-call cost only, no judge pricing needed.

IMPORTANT: import-safe with NO env / NO network required at import time (same
contract as `run_tier2.py` — it's imported by `test_substance_teeth.py` to
pin its filename) — all gating and all client construction happens inside
main()/run().
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional

from tests.eval.run_tier2 import _build_candidate_messages, _cost_usd

_LAST_RUN_PATH = Path(__file__).parent / "last_consistency_run.json"  # gitignored

_DEFAULT_CANDIDATE_MODEL = "claude-sonnet-4-5-20250929"
# First-call cost guess (refined to a running average once at least one call
# has completed) — used only for the budget-cap projection below.
_FIRST_CALL_COST_GUESS_USD = 0.02


def run(args: argparse.Namespace) -> int:
    import anthropic

    from tests.eval.schema import GOLDEN_SET_PATH, load_golden_set
    from tests.eval.substance import CONSISTENCY_PROBES_PATH, extract_substance, load_consistency_probes, substance_variance

    scenarios = {s.id: s for s in load_golden_set(GOLDEN_SET_PATH)}
    probes = load_consistency_probes(CONSISTENCY_PROBES_PATH, set(scenarios.keys()))

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    total_cost = 0.0
    calls_made = 0
    reports: list[dict] = []
    any_inconsistent = False
    aborted = False

    for probe in probes:
        scenario = scenarios[probe.scenario_id]
        instructions, messages = _build_candidate_messages(scenario)
        answers: list[str] = []

        for i in range(probe.n):
            projected = (total_cost / calls_made) if calls_made else _FIRST_CALL_COST_GUESS_USD
            if total_cost + projected > args.budget_usd:
                print(
                    f"BUDGET CAP: stopping mid-probe {probe.scenario_id!r} call {i + 1}/{probe.n} — "
                    f"running cost ${total_cost:.4f} + projected ${projected:.4f} > cap ${args.budget_usd:.2f}",
                    file=sys.stderr,
                )
                aborted = True
                break

            message = client.messages.create(
                model=args.candidate_model, max_tokens=300, temperature=0.7,
                system=instructions, messages=messages,
            )
            answer = "".join(b.text for b in message.content if getattr(b, "type", None) == "text")
            usage = message.usage
            total_cost += _cost_usd(args.candidate_model, usage.input_tokens, usage.output_tokens)
            calls_made += 1
            answers.append(answer)

        if aborted:
            break

        substances = [extract_substance(a, scenario.situation.player.club_distances) for a in answers]
        report = substance_variance(substances, yardage_tolerance=probe.yardage_tolerance)
        if not report.consistent:
            any_inconsistent = True
        reports.append({
            "scenario_id": probe.scenario_id,
            "n": probe.n,
            "answers": answers,
            "substances": [
                {
                    "club": s.club,
                    "endorsed_club": s.endorsed_club,
                    "yardages": list(s.yardages),
                    "hazards": sorted(s.hazards),
                }
                for s in substances
            ],
            "variance": {
                "distinct_clubs": report.distinct_clubs,
                "club_agreement_rate": report.club_agreement_rate,
                "hazard_symmetric_diff_max": report.hazard_symmetric_diff_max,
                "yardage_spread_max": report.yardage_spread_max,
                "distinct_endorsements": report.distinct_endorsements,
                "consistent": report.consistent,
                "notes": report.notes,
            },
        })
        print(
            f"{probe.scenario_id}: {len(answers)}/{probe.n} sampled — "
            f"consistent={report.consistent} (running cost ${total_cost:.4f})"
        )

    out = {
        "probes_run": len(reports),
        "probes_total": len(probes),
        "aborted_on_budget": aborted,
        "total_cost_usd": round(total_cost, 4),
        "budget_usd": args.budget_usd,
        "candidate_model": args.candidate_model,
        "any_inconsistent": any_inconsistent,
        "reports": reports,
    }
    # Key-free by construction: answers + substance + counts + $ only — never
    # an API key, a session token, or anything else sensitive.
    _LAST_RUN_PATH.write_text(json.dumps(out, indent=2))

    print()
    print(f"Ran {len(reports)}/{len(probes)} probes — ${total_cost:.4f} spent (cap ${args.budget_usd:.2f})")
    print(f"Full report written to: {_LAST_RUN_PATH}")

    if aborted:
        return 3
    if any_inconsistent:
        return 1
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="On-demand LIVE consistency probe over golden/consistency_probes.jsonl. "
                     "Never runs in CI — see module docstring.",
    )
    parser.add_argument("--budget-usd", type=float, default=0.50)
    parser.add_argument("--candidate-model", default=os.getenv("ANTHROPIC_MODEL", _DEFAULT_CANDIDATE_MODEL))
    args = parser.parse_args(argv)

    if not os.getenv("ANTHROPIC_API_KEY") or os.getenv("CADDIE_EVAL_LIVE") != "1":
        print(
            "Consistency probe is gated OFF by default (never runs in CI). To run it on-demand:\n"
            "  cd backend && CADDIE_EVAL_LIVE=1 uv run python -m tests.eval.run_consistency --budget-usd 0.50\n"
            "Requires ANTHROPIC_API_KEY set AND CADDIE_EVAL_LIVE=1.",
            file=sys.stderr,
        )
        return 2

    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
