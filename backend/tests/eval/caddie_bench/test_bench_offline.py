"""Tier-1 (G1) — offline, stubbed, CI-gated suite for the caddie bench
(specs/caddie-bench-plan.md §6 G1). No network, no key, no DB, no Docker.

Covers: schema + question-bank load-time validation; fixture load for all
pilot holes; position containment for every pilot case (re-verified here,
independently of `geometry.sample_position`'s own internal verification);
full harness end-to-end with a STUBBED synth (canned answers) + STUBBED
judge + VECTOR renderer; report generation from canned results; runner
gate-refusal (no env -> exit 2); filename-glob pins.
"""

from __future__ import annotations

import json
import os
import pathlib

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from tests.eval.caddie_bench import extract_fixtures, geometry as geo, harness  # noqa: E402
from tests.eval.caddie_bench import questions as q  # noqa: E402
from tests.eval.caddie_bench import render, report, run_caddie_bench  # noqa: E402
from tests.eval.caddie_bench.geometry import GeometrySamplingError, _in_any, _point_in_polygon_feature  # noqa: E402
from tests.eval.caddie_bench.schema import (  # noqa: E402
    BAGS_PATH,
    HOLES_DIR,
    QUESTIONS_V1_PATH,
    BagId,
    JudgeScores,
    LieCategory,
    load_bags,
    load_question_bank,
)

CANNED_DIR = pathlib.Path(__file__).parent / "fixtures" / "canned"

# ── 1. Schema + question-bank load-time validation ──────────────────────────


def test_question_bank_loads_and_covers_every_type():
    bank = load_question_bank(QUESTIONS_V1_PATH)
    assert len(bank) >= 100
    from tests.eval.caddie_bench.schema import QuestionType
    covered = {p.question_type for p in bank}
    assert covered == set(QuestionType), f"bank is missing question types: {set(QuestionType) - covered}"


def test_question_bank_rejects_duplicate_text(tmp_path):
    bad = tmp_path / "dupes.jsonl"
    bad.write_text(
        '{"phrasing_id": "a", "question_type": "tee_strategy", "text": "What should I hit?"}\n'
        '{"phrasing_id": "b", "question_type": "club_selection", "text": "what should i hit?"}\n'
    )
    with pytest.raises(ValueError, match="duplicate phrasing text"):
        load_question_bank(bad)


def test_question_bank_rejects_unknown_question_type(tmp_path):
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"phrasing_id": "a", "question_type": "not_a_real_type", "text": "hi"}\n')
    with pytest.raises(ValueError):
        load_question_bank(bad)


def test_bags_load_all_three():
    bags = load_bags(BAGS_PATH)
    assert set(bags) == set(BagId)
    assert bags[BagId.OWNER].handicap == 3.0
    assert "driver" in bags[BagId.OWNER].clubs


# ── 2. Fixture load for all pilot holes ──────────────────────────────────


def _all_hole_fixtures() -> list[geo.HoleFixture]:
    paths = sorted(HOLES_DIR.glob("*.json"))
    assert len(paths) >= 8, f"expected >= 8 pilot hole fixtures, found {len(paths)}: {paths}"
    return [geo.load_hole_fixture(p) for p in paths]


def test_all_pilot_holes_load_and_build_intel():
    for fx in _all_hole_fixtures():
        intel = geo.hole_intel_from_fixture(fx)
        assert intel.par == fx.par
        assert intel.hole_number == fx.hole_number


def test_extract_fixtures_filename_matches_pattern_for_extracted_holes():
    """Every fixture the extractor wrote follows the `<slug>_h<N>.json`
    naming convention `geometry.load_hole_fixture` depends on."""
    for fx in _all_hole_fixtures():
        assert fx.fixture_id.split("_h")[-1].isdigit()


# ── 3. Position containment for EVERY pilot case (re-verified here) ────────


def _reverify_containment(fx: geo.HoleFixture, lie: LieCategory, lon: float, lat: float) -> None:
    """Independent re-check (not just trusting sample_position's own
    internals) — for polygon lies, the point must verify INSIDE the matching
    polygon type; for ROUGH it must verify OUTSIDE fairway/bunker/water/green."""
    features = fx.features["features"]
    fairway = geo._features_of_type(fx.features, "fairway")
    bunker = geo._features_of_type(fx.features, "bunker")
    water = geo._features_of_type(fx.features, "water")
    green = geo._features_of_type(fx.features, "green")

    if lie == LieCategory.BUNKER:
        assert _in_any(lon, lat, bunker), "BUNKER position must verify inside a real bunker polygon"
    elif lie == LieCategory.GREENSIDE:
        assert green, "GREENSIDE case requires a mapped green"
        assert not any(_point_in_polygon_feature(lon, lat, f) for f in green), "GREENSIDE must verify OUTSIDE the green"
        # B3 (non-blocking #9): a greenside point must also clear any mapped
        # greenside bunker/water — not just the green polygon itself.
        assert not _in_any(lon, lat, bunker) and not _in_any(lon, lat, water), (
            "GREENSIDE must verify outside mapped bunker/water too"
        )
    elif lie == LieCategory.ROUGH:
        assert not _in_any(lon, lat, fairway) and not _in_any(lon, lat, bunker) and not _in_any(lon, lat, water) and not _in_any(lon, lat, green), (
            "ROUGH must verify outside fairway/bunker/water/green"
        )
    elif lie == LieCategory.FAIRWAY and fairway:
        assert _in_any(lon, lat, fairway), "FAIRWAY position must verify inside a mapped fairway polygon"
    elif lie == LieCategory.FAIRWAY and not fairway:
        # B3: the fixture has no mapped fairway polygon (the "centerline IS
        # the fairway" fallback, e.g. Bethpage Black hole 7) — this branch
        # used to be a silent no-op (the `and fairway` guard above skipped
        # it entirely), so the CI re-verifier never actually checked these
        # cases. Assert the fallback point is at least clear of any mapped
        # bunker/water/green (never a mislabeled hazard point).
        assert not _in_any(lon, lat, bunker) and not _in_any(lon, lat, water) and not _in_any(lon, lat, green), (
            "no-fairway-polygon FAIRWAY fallback must verify outside mapped bunker/water/green"
        )
    elif lie == LieCategory.RECOVERY_TREES:
        assert not _in_any(lon, lat, fairway) and not _in_any(lon, lat, green), "RECOVERY_TREES must verify outside fairway/green"
    # TEE has no polygon to check against in every fixture; sampling it is a
    # direct read of the tee coordinate, nothing to re-verify.
    del features


def test_every_pilot_case_position_is_verified_and_re_verified():
    fixtures = {fx.fixture_id: fx for fx in _all_hole_fixtures()}
    bank = load_question_bank(QUESTIONS_V1_PATH)
    cases = q.build_cases(list(fixtures.values()), bank)
    assert len(cases) >= 100
    checked = 0
    for case in cases:
        fx = fixtures[case.hole_fixture]
        resolved = geo.sample_position(fx, case.position)  # raises on failure — no try/except
        assert resolved.distance_to_green_yards >= 0
        _reverify_containment(fx, resolved.lie, resolved.lng, resolved.lat)
        checked += 1
    assert checked == len(cases)


def test_sample_position_raises_on_unmappable_bunker():
    """A hole fixture with zero bunker features must RAISE, never silently
    resolve some other point and call it a bunker. All 8 committed pilot
    fixtures happen to have >=1 mapped bunker, so this builds a synthetic
    bunker-free fixture directly (same {_provenance, par, features} shape) to
    exercise the raise."""
    from tests.eval.caddie_bench.schema import PositionSpec

    real = _all_hole_fixtures()[0]
    no_bunker_features = {
        "type": "FeatureCollection",
        "features": [f for f in real.features["features"] if (f.get("properties") or {}).get("featureType") != "bunker"],
    }
    fx = geo.HoleFixture(
        fixture_id=real.fixture_id, hole_number=real.hole_number, par=real.par, yards=real.yards,
        features=no_bunker_features, provenance="synthetic bunker-free variant for a sampler-teeth test",
    )
    assert not geo._features_of_type(fx.features, "bunker")
    with pytest.raises(GeometrySamplingError):
        geo.sample_position(fx, PositionSpec(lie=LieCategory.BUNKER, seed=1))


# ── 4. Full harness end-to-end: stubbed synth + stubbed judge + vector
#      renderer -> report from canned results ────────────────────────────


async def _canned_synth(ground_truth: str, *, model: str) -> tuple[str, dict]:
    return (
        "Driver off the tee, favor the fairway away from the bunkers, that leaves a full wedge in.",
        {"input_tokens": 500, "output_tokens": 40},
    )


def _canned_judge_scores(verdict_key: str) -> JudgeScores:
    verdicts = json.loads((CANNED_DIR / "judge_verdicts.json").read_text())
    return JudgeScores.model_validate(verdicts[verdict_key])


async def test_harness_end_to_end_offline_produces_a_sample_report(tmp_path):
    fixtures = {fx.fixture_id: fx for fx in _all_hole_fixtures()}
    bank = load_question_bank(QUESTIONS_V1_PATH)
    bags = load_bags(BAGS_PATH)
    by_phrasing = {p.phrasing_id: p for p in bank}

    cases = q.build_cases(list(fixtures.values()), bank)
    sample_cases = [c for c in cases if not c.canary][:6] + [c for c in cases if c.canary][:2]

    results = []
    for case in sample_cases:
        fx = fixtures[case.hole_fixture]
        phrasing = by_phrasing[case.phrasing_id]
        bag = bags[case.bag]
        result = await harness.run_case(case, fx, phrasing, bag, synth=_canned_synth)

        composite_path = render.render_case(case, fx, result.resolved, mode="vector", out_dir=tmp_path)
        assert composite_path.exists()

        verdict_key = "all_fail" if case.canary else "all_pass"
        judge_scores = _canned_judge_scores(verdict_key)

        from tests.eval.caddie_bench.schema import CaseResult
        results.append(CaseResult(
            case_id=result.case_id, resolved=result.resolved, intent=result.intent, answer=result.answer,
            degraded=result.degraded, engine_ref=result.engine_ref, det_checks=result.det_checks,
            judge=judge_scores, cost_usd=0.0, latency_ms=result.latency_ms,
        ))

    assert len(results) == 8
    resolved_examples = [(r.case_id, round(r.resolved.lat, 4), round(r.resolved.lng, 4), round(r.resolved.distance_to_green_yards, 1)) for r in results[:2]]
    print("resolved position examples:", resolved_examples)

    meta = report.RunMeta(run_id="offline-smoke", synth_model="canned", judge_model="canned", case_count=len(results), total_cost_usd=0.0, wall_time_s=0.1)
    md = report.write_report(results, meta, tmp_path / "report.md")
    text = md.read_text()
    assert "Weighted correctness score" in text
    assert "Canary outcome" in text
    # All 4 canaries scored all_fail here (2 sampled) -> canary gate PASS.
    headline = report.compute_headline(results)
    assert headline.canary_all_pass is False


def test_report_generation_flags_canary_gate_failure_when_a_canary_scores_good():
    from tests.eval.caddie_bench.schema import CaseResult, ResolvedPosition, DetCheckResult, DetCheckName

    good = _canned_judge_scores("all_pass")
    bad_result = CaseResult(
        case_id="canary__x__tee_strategy",
        resolved=ResolvedPosition(lat=1.0, lng=2.0, lie=LieCategory.TEE, distance_to_green_yards=400, shot_bearing_deg=10),
        intent="advice", answer="bad canary answer", degraded=False, engine_ref={"club": "driver"},
        det_checks=[DetCheckResult(check=DetCheckName.NUMBERS_CLOSE, passed=True)],
        judge=good,  # canary incorrectly scored GOOD -> teeth missing
    )
    headline = report.compute_headline([bad_result])
    assert headline.canary_all_pass is True


# ── 5. Runner gate-refusal + filename-glob pins ──────────────────────────


def test_run_caddie_bench_refuses_without_env(monkeypatch):
    monkeypatch.delenv("CADDIE_EVAL_LIVE", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert run_caddie_bench.main([]) == 2


def test_run_caddie_bench_refuses_with_only_one_of_two_gates(monkeypatch):
    monkeypatch.setenv("CADDIE_EVAL_LIVE", "1")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert run_caddie_bench.main([]) == 2


def test_run_caddie_bench_filename_does_not_match_pytest_test_glob():
    filename = pathlib.Path(run_caddie_bench.__file__).name
    assert not filename.startswith("test_"), "run_caddie_bench.py must never match pytest's test_*.py collection glob"


def test_extract_fixtures_filename_does_not_match_pytest_test_glob():
    filename = pathlib.Path(extract_fixtures.__file__).name
    assert not filename.startswith("test_")


def test_extract_fixtures_refuses_without_env(monkeypatch):
    monkeypatch.delenv("CADDIE_BENCH_EXTRACT", raising=False)
    assert extract_fixtures.main([]) == 2


def test_pricing_table_refuses_unknown_model():
    with pytest.raises(RuntimeError, match="no pricing entry"):
        run_caddie_bench._cost_usd("not-a-real-model", 100, 10)


# ── 6. build_cases sanity (case-count math §2) ──────────────────────────


def test_build_cases_produces_the_planned_case_count():
    fixtures = _all_hole_fixtures()
    bank = load_question_bank(QUESTIONS_V1_PATH)
    cases = q.build_cases(fixtures, bank)
    canaries = [c for c in cases if c.canary]
    assert len(canaries) == 4
    ids = [c.id for c in cases]
    assert len(ids) == len(set(ids)), "case ids must be unique"
    assert len(cases) >= 100


def test_bags_json_matches_owner_bag_from_corner_tree_forward_bound_test():
    """The OWNER bag must match `_OWNER_BAG` in
    test_corner_tree_forward_bound.py exactly (the builder's contract)."""
    import sys

    sys.path.insert(0, str(pathlib.Path(__file__).parent.parent.parent))
    from tests.test_corner_tree_forward_bound import _OWNER_BAG

    bags = load_bags(BAGS_PATH)
    assert bags[BagId.OWNER].clubs == _OWNER_BAG
    assert bags[BagId.OWNER].handicap == 3.0
