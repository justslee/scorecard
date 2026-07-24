"""Tier-1 (G1) — offline, stubbed, CI-gated suite for the caddie bench
(specs/caddie-bench-plan.md §6 G1). No network, no key, no DB, no Docker.

Covers: schema + question-bank load-time validation; fixture load for all
pilot holes; position containment for every pilot case (re-verified here,
independently of `geometry.sample_position`'s own internal verification);
full harness end-to-end with a STUBBED synth (canned answers) + STUBBED
judge + VECTOR renderer; report generation from canned results; runner
gate-refusal (no env -> exit 2); filename-glob pins; the `_LiveSynth`
non-recursion fix + the real-call canary + `--render-mode`.
"""

from __future__ import annotations

import json
import os
import pathlib

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from tests.eval.caddie_bench import extract_fixtures, geometry as geo, harness  # noqa: E402
from tests.eval.caddie_bench import judge_noise, questions as q  # noqa: E402
from tests.eval.caddie_bench import render, report, run_caddie_bench  # noqa: E402
from tests.eval.caddie_bench.geometry import GeometrySamplingError, _in_any, _point_in_polygon_feature  # noqa: E402
from tests.eval.caddie_bench.schema import (  # noqa: E402
    BAGS_PATH,
    HOLES_DIR,
    QUESTIONS_V1_PATH,
    BagId,
    BenchCase,
    ConditionsId,
    JudgeScores,
    LieCategory,
    PositionSpec,
    QuestionType,
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


# ── cycle-3 commit 2: CaseResult schema round-trip (additive fields) ───────


def test_case_result_old_format_line_loads_with_degrade_fields_defaulted_none(tmp_path):
    """An old (pre-instrumentation) results.jsonl line — written before
    `degrade_reason`/`raw_synth_text` existed — must still round-trip: the
    two new fields default to None, `extra='forbid'` notwithstanding."""
    old_line = json.dumps({
        "case_id": "holeA__slot0__owner__x",
        "resolved": {"lat": 1.0, "lng": 2.0, "lie": "tee", "distance_to_green_yards": 400.0, "shot_bearing_deg": 0.0},
        "intent": "advice", "answer": "old-format answer", "degraded": True,
        "engine_ref": {"club": "driver"}, "det_checks": [], "cost_usd": 0.0, "latency_ms": 100.0,
    })
    path = tmp_path / "old_run.jsonl"
    path.write_text(old_line + "\n")

    results = report.load_results(path)
    assert len(results) == 1
    assert results[0].degrade_reason is None
    assert results[0].raw_synth_text is None


def test_case_result_new_format_line_round_trips_degrade_fields(tmp_path):
    from tests.eval.caddie_bench.schema import CaseResult, ResolvedPosition

    result = CaseResult(
        case_id="holeA__slot0__owner__x",
        resolved=ResolvedPosition(lat=1.0, lng=2.0, lie=LieCategory.TEE, distance_to_green_yards=400.0, shot_bearing_deg=0.0),
        intent="advice", answer="new-format answer", degraded=True, engine_ref={"club": "driver"},
        degrade_reason="validator:side-flip", raw_synth_text="the raw pre-validation text",
    )
    path = tmp_path / "new_run.jsonl"
    path.write_text(result.model_dump_json() + "\n")

    loaded = report.load_results(path)
    assert len(loaded) == 1
    assert loaded[0].degrade_reason == "validator:side-flip"
    assert loaded[0].raw_synth_text == "the raw pre-validation text"


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


# ── caddie-bench-cycle2-plan.md §2.2 — run_case threads resolved.shot_bearing
#    into the live-path solve (harness.py:~430), fixing a live-vs-bench
#    physics mismatch (build_strategy_payload used to solve with bearing 0.0
#    while engine_ref above already used the true bearing) ─────────────────


async def test_run_case_threads_resolved_shot_bearing_into_run_strategy_turn(monkeypatch):
    fixtures = {fx.fixture_id: fx for fx in _all_hole_fixtures()}
    fx = next(iter(fixtures.values()))
    bank = load_question_bank(QUESTIONS_V1_PATH)
    bags = load_bags(BAGS_PATH)
    phrasing = next(p for p in bank if p.question_type == QuestionType.TEE_STRATEGY)

    case = BenchCase(
        id="bearing-thread-test", hole_fixture=fx.fixture_id, bag=BagId.OWNER,
        conditions=ConditionsId.INTO_20, position=PositionSpec(lie=LieCategory.TEE, seed=1),
        question_type=QuestionType.TEE_STRATEGY, phrasing_id=phrasing.phrasing_id,
    )

    captured: dict = {}
    real_run_strategy_turn = harness.run_strategy_turn

    async def _spy(*args, **kwargs):
        captured.update(kwargs)
        return await real_run_strategy_turn(*args, **kwargs)

    monkeypatch.setattr(harness, "run_strategy_turn", _spy)

    resolved = geo.sample_position(fx, case.position)
    # run_case's own _stub_db_seams()/_stub_synth() already wrap the call.
    await harness.run_case(case, fx, phrasing, bags[case.bag], synth=_canned_synth)

    assert "shot_bearing_deg" in captured
    assert captured["shot_bearing_deg"] == pytest.approx(resolved.shot_bearing_deg)


async def test_run_case_into_20_ground_truth_contains_headwind_language():
    """Functional pin, not just the plumbing above: an INTO_20 case's
    ground truth (what the model actually sees) states the wind-vs-shot-line
    headwind phrase — the whole point of Fix B."""
    fixtures = {fx.fixture_id: fx for fx in _all_hole_fixtures()}
    fx = next(iter(fixtures.values()))
    bank = load_question_bank(QUESTIONS_V1_PATH)
    bags = load_bags(BAGS_PATH)
    phrasing = next(p for p in bank if p.question_type == QuestionType.TEE_STRATEGY)

    case = BenchCase(
        id="into20-wind-test", hole_fixture=fx.fixture_id, bag=BagId.OWNER,
        conditions=ConditionsId.INTO_20, position=PositionSpec(lie=LieCategory.TEE, seed=1),
        question_type=QuestionType.TEE_STRATEGY, phrasing_id=phrasing.phrasing_id,
    )

    captured_ground_truth: dict = {}

    async def _spy_synth(ground_truth: str, *, model: str) -> tuple[str, dict]:
        captured_ground_truth["text"] = ground_truth
        return await _canned_synth(ground_truth, model=model)

    await harness.run_case(case, fx, phrasing, bags[case.bag], synth=_spy_synth)

    assert "headwind — into you" in captured_ground_truth["text"]


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


# ── cycle-3 commit 3: judge_noise.py gate-refusal + filename-glob pin ──────


def test_judge_noise_filename_does_not_match_pytest_test_glob():
    filename = pathlib.Path(judge_noise.__file__).name
    assert not filename.startswith("test_"), "judge_noise.py must never match pytest's test_*.py collection glob"


def test_judge_noise_refuses_without_env(monkeypatch):
    monkeypatch.delenv("CADDIE_EVAL_LIVE", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert judge_noise.main(["--run-id", "whatever"]) == judge_noise._EXIT_GATE_REFUSAL


def test_judge_noise_refuses_with_only_one_of_two_gates(monkeypatch):
    monkeypatch.setenv("CADDIE_EVAL_LIVE", "1")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert judge_noise.main(["--run-id", "whatever"]) == judge_noise._EXIT_GATE_REFUSAL


def test_judge_noise_requires_run_id_argument():
    with pytest.raises(SystemExit):
        judge_noise.main([])


# ── cycle-3 commit 3: compute_noise_stats (pure, offline) ──────────────────


def test_compute_noise_stats_respects_shot_reachability_na_and_computes_expected_arithmetic():
    """Hand-computed double-pass sample: one positioning case (its
    shot_reachability pair disagrees: first=2, second=0) and one approach
    case (its OWN shot_reachability pair, first=0/second=1, must be
    EXCLUDED entirely per Commit 1's N/A rule -- if it leaked in, it would
    corrupt every downstream number). Every other dimension agrees cleanly
    (2, 2) on both cases/both passes."""
    from tests.eval.caddie_bench.schema import JudgeDimension

    all_two = {d.value: 2 for d in JudgeDimension}
    all_conf = {d.value: 0.9 for d in JudgeDimension}

    a_first = JudgeScores(scores=dict(all_two), confidence=dict(all_conf), failure_class="good")
    a_second_scores = dict(all_two)
    a_second_scores["shot_reachability"] = 0
    a_second = JudgeScores(scores=a_second_scores, confidence=dict(all_conf), failure_class="good")

    b_first_scores = dict(all_two)
    b_first_scores["shot_reachability"] = 0  # must be EXCLUDED (case B is non-positioning)
    b_first = JudgeScores(scores=b_first_scores, confidence=dict(all_conf), failure_class="good")
    b_second_scores = dict(all_two)
    b_second_scores["shot_reachability"] = 1  # must be EXCLUDED too
    b_second = JudgeScores(scores=b_second_scores, confidence=dict(all_conf), failure_class="good")

    pairs = [("caseA", a_first, a_second), ("caseB", b_first, b_second)]
    engine_refs = {"caseA": {"shot_kind": "positioning"}, "caseB": {"shot_kind": "approach"}}

    stats = judge_noise.compute_noise_stats(pairs, engine_refs)

    sr = stats["per_dimension"]["shot_reachability"]
    assert sr["n_applicable"] == 1, "only the positioning case's shot_reachability pair counts"
    assert sr["exact_agreement_rate"] == pytest.approx(0.0)
    assert sr["pass_flip_rate"] == pytest.approx(1.0)
    assert sr["mean_abs_delta"] == pytest.approx(2.0)
    assert sr["q_pass_repeat"] == pytest.approx(0.0)

    nc = stats["per_dimension"]["numbers_coherence"]
    assert nc["n_applicable"] == 2
    assert nc["exact_agreement_rate"] == pytest.approx(1.0)
    assert nc["pass_flip_rate"] == pytest.approx(0.0)
    assert nc["mean_abs_delta"] == pytest.approx(0.0)
    assert nc["q_pass_repeat"] == pytest.approx(1.0)

    # Hand-computed (see docstring in judge_noise.compute_noise_stats for the
    # formulas): shot_reachability contributes num=2*1.0=2.0/den=2*2=4 (its
    # one true-pass case-dim scores [2, 0], mean 1.0); the other 5
    # correctness dims (weight 2, both case-dims true-pass at 2.0 mean)
    # contribute 5*(2*2.0)/5*(2*2)=20.0/20; the 4 crux dims (weight 1)
    # contribute 4*(1*2.0)/4*(1*2)=8.0/8. Total 30.0/32 = 93.75%.
    assert stats["ceiling_expected"] == pytest.approx(30 / 32)
    # band_optimistic: every case-dim's max(a,b) -> shot_reachability's only
    # pair maxes to 2 (perfect), everything else already 2 -> 60/60 = 100%.
    assert stats["band_optimistic"] == pytest.approx(1.0)
    # band_pessimistic: shot_reachability's only pair mins to 0 (num
    # contribution drops from 4 to 0) -> (60-4)/60 = 56/60.
    assert stats["band_pessimistic"] == pytest.approx(56 / 60)


def test_compute_noise_stats_dimension_with_zero_applicable_pairs_reports_none_not_zero():
    """An all-approach sample has zero applicable shot_reachability
    case-dims — every per-dimension metric must be None (never a misleading
    0.0/1.0), and the dimension must be excluded from ceiling/band, not
    silently zeroed (a perfect all-2s sample still yields 100% everywhere)."""
    from tests.eval.caddie_bench.schema import JudgeDimension

    all_two = {d.value: 2 for d in JudgeDimension}
    all_conf = {d.value: 0.9 for d in JudgeDimension}
    first = JudgeScores(scores=dict(all_two), confidence=dict(all_conf), failure_class="good")
    second = JudgeScores(scores=dict(all_two), confidence=dict(all_conf), failure_class="good")

    stats = judge_noise.compute_noise_stats([("caseA", first, second)], {"caseA": {"shot_kind": "approach"}})

    sr = stats["per_dimension"]["shot_reachability"]
    assert sr == {
        "n_applicable": 0, "exact_agreement_rate": None, "pass_flip_rate": None,
        "mean_abs_delta": None, "q_pass_repeat": None,
    }
    assert stats["ceiling_expected"] == pytest.approx(1.0)
    assert stats["band_optimistic"] == pytest.approx(1.0)
    assert stats["band_pessimistic"] == pytest.approx(1.0)


def test_compute_noise_stats_stored_first_pass_agreement_bonus():
    from tests.eval.caddie_bench.schema import JudgeDimension

    all_two = {d.value: 2 for d in JudgeDimension}
    all_conf = {d.value: 0.9 for d in JudgeDimension}
    first = JudgeScores(scores=dict(all_two), confidence=dict(all_conf), failure_class="good")
    second = JudgeScores(scores=dict(all_two), confidence=dict(all_conf), failure_class="good")
    pairs = [("caseA", first, second), ("caseB", first, second)]
    engine_refs = {"caseA": {"shot_kind": "positioning"}, "caseB": {"shot_kind": "approach"}}

    stored_a = JudgeScores(scores=dict(all_two), confidence=dict(all_conf), failure_class="good")
    b_stored_scores = dict(all_two)
    b_stored_scores["numbers_coherence"] = 0  # deliberate mismatch on case B only
    stored_b = JudgeScores(scores=b_stored_scores, confidence=dict(all_conf), failure_class="good")

    stats = judge_noise.compute_noise_stats(
        pairs, engine_refs, stored_first={"caseA": stored_a, "caseB": stored_b},
    )
    agreement = stats["stored_first_pass_agreement"]
    assert agreement["shot_reachability"] == pytest.approx(1.0), "only caseA counted -- SR is N/A on caseB"
    assert agreement["numbers_coherence"] == pytest.approx(0.5), "caseA matches, caseB's stored verdict mismatches"
    assert agreement["hazard_awareness"] == pytest.approx(1.0), "untouched dimension, both cases match"


def test_compute_noise_stats_omits_stored_first_pass_agreement_key_when_not_given():
    from tests.eval.caddie_bench.schema import JudgeDimension

    all_two = {d.value: 2 for d in JudgeDimension}
    all_conf = {d.value: 0.9 for d in JudgeDimension}
    first = JudgeScores(scores=dict(all_two), confidence=dict(all_conf), failure_class="good")
    second = JudgeScores(scores=dict(all_two), confidence=dict(all_conf), failure_class="good")

    stats = judge_noise.compute_noise_stats([("caseA", first, second)], {"caseA": {"shot_kind": "positioning"}})
    assert "stored_first_pass_agreement" not in stats


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


# ── 7. Post-Fable-review fixes (B2, #4, #6, #7, #10, #11) ───────────────────


def test_build_session_normalizes_the_bag_like_prod_session_load():
    """B2: `harness.build_session` must run the bag through
    `normalize_club_distances` exactly like prod's session-load chokepoint
    (`app/caddie/session.py`), so a non-canonical club key never survives
    into the bench's `RoundSession.club_distances` (the LIVE synth's bag
    context) even though `generate_recommendation`'s own oracle call already
    normalizes internally — the two must never diverge."""
    from app.caddie.types import WeatherConditions

    weather = WeatherConditions(wind_speed_mph=0.0, wind_direction=0)
    session = harness.build_session(
        {}, {"3iron": 240, "driver": 300}, 8.0, weather, current_hole=1,
    )
    assert "3iron" not in session.club_distances, "a non-canonical club key must be dropped, matching prod"
    assert session.club_distances.get("4iron") is None, "raw '3iron' must NOT silently alias to '4iron'"
    assert session.club_distances["driver"] == 300


def test_bomber_bag_has_no_non_canonical_clubs():
    """B2: fixtures/bags.json's BOMBER must carry its long iron under a
    canonical key (4iron), never the non-canonical '3iron' the canonical
    taxonomy (starting at 4-iron) drops."""
    from app.caddie.club_selection import normalize_club_distances

    bags = load_bags(BAGS_PATH)
    bomber = bags[BagId.BOMBER].clubs
    assert "3iron" not in bomber
    assert bomber.get("4iron") == 240
    normalized = normalize_club_distances(dict(bomber))
    assert normalized == bomber, "every BOMBER club must already be canonical (survive normalization unchanged)"


def _slot_key(case) -> str:
    """(hole_fixture, slotN, bag) — the stable fields `_stable_condition`
    hashes — deliberately EXCLUDES the phrasing_id suffix of `case.id`,
    since phrasing selection is a separate, order-dependent counter
    (`phrasing_i`, out of scope for #10) that legitimately differs when the
    hole iteration order changes; only the CONDITION must not."""
    return f"{case.hole_fixture}__{case.id.split('__')[1]}__{case.bag.value}"


def test_build_cases_condition_assignment_is_independent_of_hole_enumeration_order():
    """#10: a case's condition must be a pure function of its own stable
    fields (hole, slot, bag) — NOT of where its hole fell in the iteration
    order. Building the SAME two-hole subset in reversed order must assign
    the SAME condition to each (hole, slot, bag) triple (this is exactly
    what breaks `--holes`/`--resume`/`--only-failures` subset runs under the
    old enumeration-counter assignment)."""
    fixtures = _all_hole_fixtures()[:2]
    bank = load_question_bank(QUESTIONS_V1_PATH)

    forward = {_slot_key(c): c.conditions for c in q.build_cases(fixtures, bank, include_canaries=False)}
    reversed_cases = {_slot_key(c): c.conditions for c in q.build_cases(list(reversed(fixtures)), bank, include_canaries=False)}

    assert forward.keys() == reversed_cases.keys()
    mismatches = {k: (forward[k], reversed_cases[k]) for k in forward if forward[k] != reversed_cases[k]}
    assert not mismatches, f"conditions must not depend on hole enumeration order: {mismatches}"


def test_build_cases_position_seed_is_a_stable_bag_constant_not_a_hash():
    """#4: `PositionSpec.seed` must be `slot_i * 7 + <stable per-bag int>` —
    never `hash(bag.value)`, which is process-randomized (PYTHONHASHSEED)
    and made the case dump differ across separate process runs."""
    fixtures = _all_hole_fixtures()
    bank = load_question_bank(QUESTIONS_V1_PATH)
    cases = q.build_cases(fixtures, bank, include_canaries=False)
    from tests.eval.caddie_bench.schema import BagId as _BagId

    expected_bag_seed = {_BagId.OWNER: 0, _BagId.SHORT_HITTER: 1, _BagId.BOMBER: 2}
    slot_seeds: dict[str, int] = {}
    for c in cases:
        if c.question_type.value == "fact_distance":
            continue  # FACT cases hardcode seed=99, out of scope for the slot formula
        slot_i = int(c.id.split("__slot")[1].split("__")[0])
        expected = slot_i * 7 + expected_bag_seed[c.bag]
        slot_seeds[c.id] = c.position.seed
        assert c.position.seed == expected, f"{c.id}: seed {c.position.seed} != expected {expected}"


def test_report_excludes_fact_class_from_correctness_headline_and_reports_routing_separately():
    """#6: FACT-class results (case id contains `__fact__`) must never
    contribute to `weighted_correctness_score`/`dimension_pass_rate` — even
    if (defensively) a FACT result somehow carries a judge score — and their
    routing correctness (`intent == "fact"`) is surfaced as its own
    `fact_routing_accuracy`, separate from the advice headline."""
    from tests.eval.caddie_bench.schema import CaseResult, DetCheckName, DetCheckResult, ResolvedPosition

    good = _canned_judge_scores("all_pass")
    bad = _canned_judge_scores("all_fail")

    advice_good = CaseResult(
        case_id="holeA__slot0__owner__x", resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.TEE, distance_to_green_yards=400, shot_bearing_deg=0),
        intent="advice", answer="x", degraded=False, engine_ref={"club": "driver"}, det_checks=[], judge=good,
    )
    # A FACT case defensively carrying a judge score (should never happen
    # post-fix, but the filter must still hold if it did) — an all-FAIL
    # score that, if counted, would drag weighted_correctness down.
    fact_with_stray_judge = CaseResult(
        case_id="holeA__fact__q1", resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.FAIRWAY, distance_to_green_yards=150, shot_bearing_deg=0),
        intent="fact", answer="150 to the green.", degraded=False, engine_ref={"club": "7iron"},
        det_checks=[DetCheckResult(check=DetCheckName.NUMBERS_CLOSE, passed=True)], judge=bad,
    )
    fact_misrouted = CaseResult(
        case_id="holeB__fact__q2", resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.FAIRWAY, distance_to_green_yards=150, shot_bearing_deg=0),
        intent="advice", answer="not a fact readout", degraded=False, engine_ref={"club": "7iron"}, det_checks=[],
    )

    headline = report.compute_headline([advice_good, fact_with_stray_judge, fact_misrouted])
    # weighted_correctness must reflect ONLY the advice_good case (all-pass).
    assert headline.weighted_correctness_score == pytest.approx(1.0)
    assert headline.fact_case_count == 2
    assert headline.fact_routing_accuracy == pytest.approx(0.5)  # 1 of 2 FACT cases actually routed to "fact"


# ── cycle-3 commit 1: shot_reachability is N/A off a positioning shot ──────


def test_compute_headline_excludes_shot_reachability_off_positioning_shots():
    """Cycle-3 commit 1 contract: shot_reachability is N/A on a
    non-positioning (approach) shot — `report.compute_headline` must exclude
    it from BOTH the per-dimension pass rate AND the weighted
    numerator/denominator when `engine_ref['shot_kind'] != 'positioning'`.
    Fixture: one positioning case (shot_reachability=2, everything else 2)
    plus one approach case (shot_reachability=0 — a spurious judge zero —
    everything else 2).

    Hand-computed BEFORE this fix (both cases' shot_reachability counted in
    the weighted score): the 5 other correctness dims (weight 2, both cases
    pass) contribute num=8/den=8 each = 40/40; shot_reachability (weight 2,
    values [2, 0]) contributes num=4/den=8; the 4 crux dims (weight 1, both
    cases pass) contribute num=4/den=4 each = 16/16. Total: 60/64 = 93.75%.

    AFTER this fix (the approach case's shot_reachability dropped from BOTH
    numerator and denominator, per the plan's contract): shot_reachability
    now only counts the positioning case's value=2, contributing num=4/den=4.
    Total: 60/60 = 100%.
    """
    from tests.eval.caddie_bench.schema import CaseResult, JudgeDimension, ResolvedPosition

    all_two = {d.value: 2 for d in JudgeDimension}
    all_conf = {d.value: 0.9 for d in JudgeDimension}

    positioning_scores = JudgeScores(scores=dict(all_two), confidence=dict(all_conf), failure_class="good")

    approach_raw_scores = dict(all_two)
    approach_raw_scores["shot_reachability"] = 0
    approach_scores = JudgeScores(scores=approach_raw_scores, confidence=dict(all_conf), failure_class="good")

    positioning_case = CaseResult(
        case_id="holeA__slot0__owner__x",
        resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.TEE, distance_to_green_yards=400, shot_bearing_deg=0),
        intent="advice", answer="positioning answer", degraded=False,
        engine_ref={"club": "driver", "shot_kind": "positioning"}, det_checks=[], judge=positioning_scores,
    )
    approach_case = CaseResult(
        case_id="holeB__slot0__owner__x",
        resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.FAIRWAY, distance_to_green_yards=150, shot_bearing_deg=0),
        intent="advice", answer="approach answer", degraded=False,
        engine_ref={"club": "7iron", "shot_kind": "approach"}, det_checks=[], judge=approach_scores,
    )

    headline = report.compute_headline([positioning_case, approach_case])

    assert headline.dimension_pass_rate["shot_reachability"] == pytest.approx(1.0), (
        "the approach case's spurious 0 must never enter the positioning-only pass rate"
    )
    assert headline.dimension_n["shot_reachability"] == 1, "only the positioning case is applicable"
    assert headline.weighted_correctness_score == pytest.approx(1.0)

    # The before-fix number, proving this is a real fix and not a no-op.
    before_fix_weighted = 60 / 64
    assert before_fix_weighted == pytest.approx(0.9375)
    assert headline.weighted_correctness_score > before_fix_weighted


def test_judge_prompt_shot_kind_gloss_is_conditional_on_positioning():
    """Commit 1: the ENGINE REFERENCE gloss must never attach the
    'out of reach' positioning language to a non-positioning (approach)
    shot, and vice versa — the previous SHARED gloss misled the judge into
    flagging reachable approaches as if the flag weren't the target (the
    68/84 spurious-zero bug this commit fixes)."""
    from tests.eval.caddie_bench import judge as judge_mod
    from tests.eval.caddie_bench.schema import ResolvedPosition

    case = BenchCase(
        id="gloss-test", hole_fixture="whatever", bag=BagId.OWNER, conditions=ConditionsId.CALM,
        position=PositionSpec(lie=LieCategory.FAIRWAY, seed=1), question_type=QuestionType.CLUB_SELECTION,
        phrasing_id="p1",
    )
    resolved = ResolvedPosition(lat=1, lng=2, lie=LieCategory.FAIRWAY, distance_to_green_yards=150, shot_bearing_deg=0)

    positioning_ref = {"club": "driver", "shot_kind": "positioning", "raw_yards": 260, "target_yards": 260}
    approach_ref = {"club": "7iron", "shot_kind": "approach", "raw_yards": 150, "target_yards": 150}

    positioning_text, _ = judge_mod.judge_prompt(case, resolved, positioning_ref, "answer text", "det summary")
    approach_text, _ = judge_mod.judge_prompt(case, resolved, approach_ref, "answer text", "det summary")

    assert "out of reach for THIS swing" in positioning_text
    assert "NOT the aim target" in positioning_text

    assert "positioning = out of reach" not in approach_text
    assert "out of reach" not in approach_text
    assert "NOT the aim target" not in approach_text
    assert "the green IS reachable" in approach_text
    assert "aiming at or relative to the flag is CORRECT" in approach_text

    # Rubric scope language: "shot_kind=positioning" scope, and the trigger
    # clause's own line must not contain a bare "approach" keyword.
    assert "shot_kind=positioning" in positioning_text
    sr_line = next(line for line in positioning_text.split("\n") if line.startswith("- shot_reachability:"))
    assert "approach" not in sr_line.lower()


def test_det_check_pass_rate_overall_aggregates_across_every_check():
    """#11: an overall det-check pass rate must be computed and surfaced in
    the headline (DET_CHECK_WEIGHT was an unused, misleading constant —
    removed; this is the actual fix)."""
    from tests.eval.caddie_bench.schema import CaseResult, DetCheckName, DetCheckResult, ResolvedPosition

    result = CaseResult(
        case_id="holeA__slot0__owner__x", resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.TEE, distance_to_green_yards=400, shot_bearing_deg=0),
        intent="advice", answer="x", degraded=False, engine_ref={"club": "driver"},
        det_checks=[
            DetCheckResult(check=DetCheckName.NUMBERS_CLOSE, passed=True),
            DetCheckResult(check=DetCheckName.INJECTION, passed=True),
            DetCheckResult(check=DetCheckName.LENGTH_CAPS, passed=False),
            DetCheckResult(check=DetCheckName.HAZARD_ONLY_FROM_INPUT, passed=True),
        ],
    )
    headline = report.compute_headline([result])
    assert headline.det_check_pass_rate_overall == pytest.approx(0.75)


def test_det_check_weight_constant_was_removed():
    """#11: the unused `DET_CHECK_WEIGHT` constant is gone (kept the report
    honest instead of leaving a dangling implied-but-unused weight)."""
    from tests.eval.caddie_bench import schema as schema_mod

    assert not hasattr(schema_mod, "DET_CHECK_WEIGHT")


# ── cycle-3 commit 2: degrade_reason_counts headline ────────────────────────


def test_compute_headline_degrade_reason_counts_categorizes_and_buckets_unknown():
    """Two instrumented degrades (one validator, one exception), one
    pre-instrumentation degrade (degraded=True, degrade_reason=None -- must
    bucket under "unknown(pre-instrumentation)", never be silently dropped),
    and one non-degraded case (must not appear at all)."""
    from tests.eval.caddie_bench.schema import CaseResult, ResolvedPosition

    def _r(case_id, degraded, degrade_reason):
        return CaseResult(
            case_id=case_id,
            resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.TEE, distance_to_green_yards=400, shot_bearing_deg=0),
            intent="advice", answer="x", degraded=degraded, engine_ref={"club": "driver"},
            degrade_reason=degrade_reason,
        )

    results = [
        _r("holeA__slot0__owner__x", True, "validator:side-flip"),
        _r("holeB__slot0__owner__x", True, "exception:RuntimeError"),
        _r("holeC__slot0__owner__x", True, None),  # pre-instrumentation
        _r("holeD__slot0__owner__x", False, None),  # not degraded at all
    ]
    headline = report.compute_headline(results)
    assert headline.degrade_reason_counts == {
        "validator:side-flip": 1, "exception:RuntimeError": 1, "unknown(pre-instrumentation)": 1,
    }
    assert sum(headline.degrade_reason_counts.values()) == sum(1 for r in results if r.degraded)


def test_generate_report_includes_a_degrade_reasons_section():
    from tests.eval.caddie_bench.schema import CaseResult, ResolvedPosition

    results = [
        CaseResult(
            case_id="holeA__slot0__owner__x",
            resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.TEE, distance_to_green_yards=400, shot_bearing_deg=0),
            intent="advice", answer="x", degraded=True, engine_ref={"club": "driver"},
            degrade_reason="validator:hazard-type",
        ),
    ]
    meta = report.RunMeta(run_id="degrade-reasons-test", case_count=len(results))
    text = report.generate_report(results, meta)
    assert "## Degrade reasons" in text
    assert "validator:hazard-type" in text


# ── 8. LIVE-synth recursion fix + real-call canary + --render-mode ─────────
#
# A live smoke test found `run_caddie_bench._LiveSynth` recursing into
# itself (~980 deep -> RecursionError) instead of ever reaching the real
# OpenAI-backed `synthesize_strategy` — every case silently fell through to
# the engine's degraded fallback line, and the judge graded THAT (observed:
# degraded_rate 100%, synth latency p50 98ms). This section pins the fix
# (non-recursive delegation), the run-level self-detecting canary that makes
# this failure mode loud instead of silent, and the new `--render-mode` flag.


class _RealCallRecorder:
    """Stands in for the REAL, un-patched `synthesize_strategy` — records
    exactly how many times it was actually invoked."""

    def __init__(self):
        self.calls = 0

    async def __call__(self, ground_truth: str, *, model: str) -> tuple[str, dict]:
        self.calls += 1
        return "stub advice text", {"input_tokens": 11, "output_tokens": 22}


async def test_live_synth_wrapper_delegates_to_the_saved_original_exactly_once_not_recursively(monkeypatch):
    """Pins the recursion fix. Wiring mirrors the live runner EXACTLY:
    (1) `app.caddie.strategy.synthesize_strategy` is the real (here, stub)
        function.
    (2) `_LiveSynth(...)` is constructed — it must capture that real
        reference right here, before anything is patched.
    (3) `harness._stub_synth` then patches the module attribute to the
        wrapper ITSELF (`strategy_mod.synthesize_strategy = synth`).
    (4) The advice path calls `strategy_mod.synthesize_strategy(...)` — i.e.
        the wrapper.

    With the OLD wrapper (a lazy `from app.caddie.strategy import
    synthesize_strategy` done INSIDE `__call__`), step 4 re-resolves the
    module attribute at call time — which by then IS the wrapper — so the
    call recurses into itself and this test goes RED (RecursionError, and
    the stub's `.calls` never increments). The FIXED wrapper delegates to
    the reference captured in step 2 and never re-resolves the patched
    name."""
    from app.caddie import strategy as strategy_mod

    stub = _RealCallRecorder()
    monkeypatch.setattr(strategy_mod, "synthesize_strategy", stub)

    cost_log: list[dict] = []
    case_id_ref = ["case-1"]
    synth = run_caddie_bench._LiveSynth(model="gpt-5.6-sol", cost_log=cost_log, case_id_ref=case_id_ref)

    # The seam `harness._stub_synth` actually installs in the live runner.
    monkeypatch.setattr(strategy_mod, "synthesize_strategy", synth)

    text, usage = await strategy_mod.synthesize_strategy("ground truth text", model="gpt-5.6-sol")

    assert stub.calls == 1, "the saved original must be called exactly once — never recursively"
    assert text == "stub advice text"
    assert usage == {"input_tokens": 11, "output_tokens": 22}
    assert len(cost_log) == 1, "a cost/latency record must be captured for the call"
    assert cost_log[0]["case_id"] == "case-1"
    assert cost_log[0]["call"] == "synth"
    assert cost_log[0]["model"] == "gpt-5.6-sol"
    assert synth.last_latency_ms >= 0.0
    assert synth.last_cost_usd > 0.0


async def test_run_reconstruction_propagates_degrade_reason_and_raw_synth_text(monkeypatch, tmp_path):
    """Teeth pin (cycle-3 commit 2): the explicit `CaseResult(...)`
    reconstruction inside `run()` is the silent-drop trap — if a future edit
    forgets to copy `degrade_reason`/`raw_synth_text` from `harness.run_case`'s
    result onto `final`, this test goes RED (the JSONL line loses both
    fields on a real degrade). End-to-end through the real `run()`, with the
    synth + judge seams stubbed so it stays fully offline."""
    import argparse

    from app.caddie import strategy as strategy_mod

    monkeypatch.setenv("CADDIE_EVAL_LIVE", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-fake-test-key-not-real")
    monkeypatch.setattr(run_caddie_bench, "RUNS_DIR", tmp_path)

    # A rejectable narrative: pebble_beach_h3 has no mapped water (sanity
    # pinned by test_hazard_only_from_input_goes_red_on_ungrounded_hazard in
    # test_bench_teeth.py), so naming "water" trips the hazard-type check
    # deterministically -> degraded=True, degrade_reason="validator:hazard-type".
    reject_text = "Driver off the tee, watch the water down the left, commit to the shot."

    async def _stub_synth(ground_truth: str, *, model: str):
        return reject_text, {"input_tokens": 10, "output_tokens": 10}

    monkeypatch.setattr(strategy_mod, "synthesize_strategy", _stub_synth)

    async def _stub_judge_case(*args, **kwargs):
        return _canned_judge_scores("all_pass"), {"input_tokens": 5, "output_tokens": 5}

    monkeypatch.setattr(run_caddie_bench.judge_mod, "judge_case", _stub_judge_case)

    args = argparse.Namespace(
        budget_usd=10.0, max_cases=1, only_failures=None, holes=["pebble_beach_h3"],
        resume=None, min_weighted_correctness=0.0, report_out=None, render_mode="vector",
    )
    exit_code = await run_caddie_bench.run(args)
    # This 1-case synthetic run is deliberately 100% degraded (that's the
    # scenario under test) -- it correctly trips the UNRELATED real-call
    # canary (report.py's own guard against a 100%-degraded run masquerading
    # as real), which is irrelevant to what this test proves. Results are
    # already written to disk by the time that check runs (see run()).
    assert exit_code == run_caddie_bench._EXIT_REAL_CALL_CANARY_INVALID

    results_path = next(tmp_path.glob("*/results.jsonl"))
    loaded = report.load_results(results_path)
    assert len(loaded) == 1
    assert loaded[0].degraded is True
    assert loaded[0].degrade_reason == "validator:hazard-type"
    assert loaded[0].raw_synth_text == reject_text


def test_check_real_call_canary_flags_a_synthetic_100pct_degraded_98ms_run_invalid():
    """Feeds the run-level checker exactly the observed failure signature
    (degraded_rate=1.0, synth latency p50=98ms) and asserts it flags the run
    INVALID — the assertion the bug silently skipped."""
    headline = report.HeadlineStats(
        case_count=10, dimension_pass_rate={}, weighted_correctness_score=0.0,
        correctness_dims_pass_rate=0.0, crux_dims_pass_rate=0.0, degraded_rate=1.0,
        contested_rate=0.0, canary_all_pass=False, canary_count=0, det_check_pass_rate={},
        det_check_pass_rate_overall=1.0, fact_routing_accuracy=None, fact_case_count=0,
        latency_p50_ms=98.0, latency_p95_ms=110.0,
    )
    result = report.check_real_call_canary(headline)
    assert result.invalid is True
    assert len(result.reasons) == 2, "both the degraded-rate AND the latency signal should fire here"


def test_check_real_call_canary_passes_a_healthy_run():
    headline = report.HeadlineStats(
        case_count=10, dimension_pass_rate={}, weighted_correctness_score=0.9,
        correctness_dims_pass_rate=0.9, crux_dims_pass_rate=0.9, degraded_rate=0.1,
        contested_rate=0.0, canary_all_pass=False, canary_count=0, det_check_pass_rate={},
        det_check_pass_rate_overall=1.0, fact_routing_accuracy=None, fact_case_count=0,
        latency_p50_ms=1850.0, latency_p95_ms=2400.0,
    )
    result = report.check_real_call_canary(headline)
    assert result.invalid is False
    assert result.reasons == []


def test_check_real_call_canary_never_flags_an_empty_run():
    headline = report.HeadlineStats(
        case_count=0, dimension_pass_rate={}, weighted_correctness_score=0.0,
        correctness_dims_pass_rate=0.0, crux_dims_pass_rate=0.0, degraded_rate=0.0,
        contested_rate=0.0, canary_all_pass=False, canary_count=0, det_check_pass_rate={},
        det_check_pass_rate_overall=0.0, fact_routing_accuracy=None, fact_case_count=0,
        latency_p50_ms=None, latency_p95_ms=None,
    )
    assert report.check_real_call_canary(headline).invalid is False


def test_generate_report_prepends_a_failed_banner_when_the_canary_trips():
    from tests.eval.caddie_bench.schema import CaseResult, ResolvedPosition

    # 3 degraded, 0 real results, latency ~98ms each — reproduces the exact
    # observed bug signature end to end (through CaseResult -> compute_headline
    # -> generate_report), not just the isolated HeadlineStats checker.
    results = [
        CaseResult(
            case_id=f"holeA__slot{i}__owner__x",
            resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.TEE, distance_to_green_yards=400, shot_bearing_deg=0),
            intent="advice", answer="degraded fallback line", degraded=True, engine_ref={"club": "driver"},
            det_checks=[], latency_ms=98.0,
        )
        for i in range(3)
    ]
    meta = report.RunMeta(run_id="smoke-test", case_count=len(results))
    text = report.generate_report(results, meta)
    assert text.startswith("# 🚨 FAILED — REAL-CALL CANARY TRIPPED — RUN INVALID 🚨")
    assert "degraded_rate" in text
    assert "never reached the real model" in text


def test_generate_report_has_no_failed_banner_on_a_healthy_run():
    from tests.eval.caddie_bench.schema import CaseResult, ResolvedPosition

    results = [
        CaseResult(
            case_id="holeA__slot0__owner__x",
            resolved=ResolvedPosition(lat=1, lng=2, lie=LieCategory.TEE, distance_to_green_yards=400, shot_bearing_deg=0),
            intent="advice", answer="real advice", degraded=False, engine_ref={"club": "driver"},
            det_checks=[], latency_ms=1800.0,
        )
    ]
    meta = report.RunMeta(run_id="healthy-run", case_count=len(results))
    text = report.generate_report(results, meta)
    assert not text.startswith("# 🚨 FAILED")
    assert text.startswith("# Caddie Bench Report")


def test_run_refuses_satellite_render_mode_without_maps_key(monkeypatch):
    """#4: satellite (the default) hard-requires a maps key — the run must
    refuse fast (gate-refusal exit code), before spending any budget on
    fixture loading or a synth/judge call, and vector must never trip this."""
    monkeypatch.setenv("CADDIE_EVAL_LIVE", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-fake-test-key-not-real")
    monkeypatch.delenv("GOOGLE_MAPS_KEY", raising=False)
    monkeypatch.delenv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", raising=False)

    assert run_caddie_bench.main(["--render-mode", "satellite"]) == run_caddie_bench._EXIT_GATE_REFUSAL


def test_render_mode_rejects_an_out_of_taxonomy_choice(monkeypatch):
    """Exercises the REAL `main()` argparse wiring (argument parsing happens
    before the env gate, so this doesn't need CADDIE_EVAL_LIVE/OPENAI_API_KEY
    set) — a typo'd `--render-mode` must be rejected by argparse itself."""
    with pytest.raises(SystemExit):
        run_caddie_bench.main(["--render-mode", "not-a-real-mode"])


def test_render_mode_defaults_to_satellite(monkeypatch):
    """No `--render-mode` passed -> the default must behave as satellite:
    with no maps key, the run still refuses (same gate-refusal path as
    passing `--render-mode satellite` explicitly)."""
    monkeypatch.setenv("CADDIE_EVAL_LIVE", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-fake-test-key-not-real")
    monkeypatch.delenv("GOOGLE_MAPS_KEY", raising=False)
    monkeypatch.delenv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", raising=False)

    assert run_caddie_bench.main([]) == run_caddie_bench._EXIT_GATE_REFUSAL


def test_render_mode_vector_never_requires_a_maps_key(monkeypatch):
    """`--render-mode vector` must NEVER raise/refuse for a missing maps key
    — it passes the satellite-key gate and proceeds into the run (which then
    exits on the empty/degenerate case set, NOT on a maps-key refusal)."""
    monkeypatch.setenv("CADDIE_EVAL_LIVE", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-fake-test-key-not-real")
    monkeypatch.delenv("GOOGLE_MAPS_KEY", raising=False)
    monkeypatch.delenv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", raising=False)

    exit_code = run_caddie_bench.main(["--render-mode", "vector", "--max-cases", "0"])
    assert exit_code != run_caddie_bench._EXIT_GATE_REFUSAL


def test_exit_code_constants_are_distinct_and_documented():
    codes = {
        run_caddie_bench._EXIT_PASS, run_caddie_bench._EXIT_MISSED_BAR,
        run_caddie_bench._EXIT_GATE_REFUSAL, run_caddie_bench._EXIT_BUDGET_ABORT,
        run_caddie_bench._EXIT_REAL_CALL_CANARY_INVALID,
    }
    assert codes == {0, 1, 2, 3, 4}, "exit codes must stay distinct — a collision would hide which failure mode fired"
