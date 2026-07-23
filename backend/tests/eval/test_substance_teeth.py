"""Teeth for the pure consistency-probe extractor (`substance.py`) — proves
extraction is phrasing-insensitive AND that its own diff/report machinery can
go RED (specs/caddie-experience-harness-plan.md §3). "An eval that can't
fail is worse than none" — same audit warning this whole harness answers.

Runs in CI now (unlike `run_consistency.py`, the gated live sampler this
module's machinery underlies).
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pathlib  # noqa: E402
import tempfile  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402

from tests.eval.schema import GOLDEN_SET_PATH, load_golden_set  # noqa: E402
from tests.eval.substance import (  # noqa: E402
    AnswerSubstance,
    extract_substance,
    load_consistency_probes,
    substance_variance,
)


_CLUB_DISTANCES = {"7iron": 160, "driver": 250, "3wood": 235}


# ── Extraction correctness ───────────────────────────────────────────────


def test_extract_substance_parses_club_yardage_and_hazard():
    answer = "Take the 7 iron here — it's a carry of 240 to clear the bunker on the right."
    substance = extract_substance(answer, _CLUB_DISTANCES)
    assert substance.club == "7iron"
    assert 240 in substance.yardages
    assert substance.hazards == frozenset({"bunker"})


def test_extract_substance_does_not_extract_mph_as_yardage():
    """caddie-bench-cycle2-plan.md §3.2: wind speed ("15 mph") must never
    false-positive as a yardage — the exact "3-digit wind heading" false-
    positive class the README already flags, now hit for real once wind-
    aware answers speak mph. The real distance (160) is still extracted."""
    answer = "needs 160, wind is 15 mph"
    substance = extract_substance(answer, _CLUB_DISTANCES)
    assert substance.yardages == (160,)


def test_extract_substance_still_extracts_bare_compass_heading():
    """A bare 3-digit compass heading (no "mph" suffix) is unchanged — the
    lookahead only excludes the mph-suffixed case."""
    answer = "wind is coming from 210 degrees at 15 mph, needs 160"
    substance = extract_substance(answer, _CLUB_DISTANCES)
    assert 210 in substance.yardages
    assert 160 in substance.yardages
    assert 15 not in substance.yardages


def test_extract_substance_club_recognizes_spelled_out_forms_not_just_endorsed():
    """Pin (P4, caddie-consistency-probe-substance-coverage part a): the
    digit-word aliasing (checks.py `_DIGIT_WORDS`) already handles spelled
    clubs for plain `.club` extraction, not just `.endorsed_club` — a future
    regression of that lexicon must go RED here, not just in the endorsement
    tests above."""
    assert extract_substance("Three wood here.", _CLUB_DISTANCES).club == "3wood"
    assert extract_substance("seven iron off the deck.", _CLUB_DISTANCES).club == "7iron"


def test_extract_substance_is_phrasing_insensitive_paraphrase_pair():
    """The exact point of the extractor: two differently-WORDED answers with
    the SAME underlying advice must extract to the SAME substance."""
    a = "I'd hit the 7 iron. Carry is about 240 to clear the right bunker."
    b = "Go with your 7-iron here — you need roughly 240 in the air to get over that bunker on the right side."
    sa = extract_substance(a, _CLUB_DISTANCES)
    sb = extract_substance(b, _CLUB_DISTANCES)
    assert sa.club == sb.club == "7iron"
    assert sa.hazards == sb.hazards == frozenset({"bunker"})
    report = substance_variance([sa, sb])
    assert report.consistent, report


# ── substance_variance diff/report machinery — RED-proof ────────────────


def test_substance_variance_flags_distinct_clubs_as_inconsistent():
    """RED-proof: a genuine club disagreement across samples goes RED."""
    samples = [
        extract_substance("Hit the driver.", _CLUB_DISTANCES),
        extract_substance("Hit the driver here.", _CLUB_DISTANCES),
        extract_substance("Go with the 3-wood.", _CLUB_DISTANCES),
    ]
    report = substance_variance(samples)
    assert report.distinct_clubs == 2
    assert not report.consistent


def test_substance_variance_goes_red_on_a_blind_stubbed_extractor():
    """RED-proof: a stubbed extractor that regresses to `club=None` on a
    club-bearing answer (a broken club-mention regex, say) must not vanish
    silently into the diff — mixing its blind output in with real samples
    must surface as a club disagreement, not a quiet pass."""
    real_samples = [extract_substance("Take the 7 iron here.", _CLUB_DISTANCES) for _ in range(3)]
    assert all(s.club == "7iron" for s in real_samples)  # sanity: real extractor sees the club
    assert substance_variance(real_samples).consistent

    blind = AnswerSubstance(
        club=None, yardages=real_samples[0].yardages, hazards=real_samples[0].hazards, endorsed_club=None,
    )
    mixed = real_samples[:2] + [blind]
    report = substance_variance(mixed)
    assert report.distinct_clubs == 2
    assert not report.consistent, "a regressed (blind) extractor mixed into real samples must be caught"


def test_substance_variance_flags_hazard_disagreement():
    a = extract_substance("Watch the bunker on the right.", _CLUB_DISTANCES)
    b = extract_substance("Watch the water on the right.", _CLUB_DISTANCES)
    report = substance_variance([a, b])
    assert report.hazard_symmetric_diff_max == 2  # {bunker} ^ {water} == {bunker, water}
    assert not report.consistent


def test_substance_variance_flags_yardage_spread_beyond_tolerance():
    a = extract_substance("It's 150 to the pin.", _CLUB_DISTANCES)
    b = extract_substance("It's 175 to the pin.", _CLUB_DISTANCES)
    report = substance_variance([a, b], yardage_tolerance=5)
    assert report.yardage_spread_max == 25
    assert not report.consistent


def test_substance_variance_requires_at_least_one_sample():
    with pytest.raises(ValueError):
        substance_variance([])


def test_substance_variance_empty_substance_is_no_signal_not_consistent():
    """RED-proof for the P4 no-fabrication bug: a fully-empty sample set
    (no sample states a club, yardage, hazard, or endorsement) must NOT read
    as a vacuous `consistent=True` — the no-fabrication rule applies to GREEN
    verdicts too. Before the fix, `substance_variance` returned
    `consistent=True` here (distinct_clubs<=1, no hazard diff, no yardage
    spread, no endorsement disagreement — all trivially satisfied by
    nothing), which is exactly the vacuous pass this test pins closed."""
    answer = "Trust your gut and commit."
    samples = [extract_substance(answer, _CLUB_DISTANCES) for _ in range(3)]
    assert all(
        s.club is None and not s.yardages and not s.hazards and s.endorsed_club is None
        for s in samples
    ), "fixture must carry zero substance on every dimension to test the NO-SIGNAL path"
    report = substance_variance(samples)
    assert report.has_signal is False
    assert report.consistent is False
    assert any("NO-SIGNAL" in note for note in report.notes)


def test_substance_variance_partial_signal_stays_a_real_disagreement():
    """CAUTION case from the plan: SOME samples carry a club and others are
    None is a genuine inconsistency (distinct_clubs>=2), not a no-signal
    situation — `has_signal` must be True and `consistent` must stay False."""
    samples = [
        extract_substance("Take the 7 iron here.", _CLUB_DISTANCES),
        extract_substance("Trust your gut and commit.", _CLUB_DISTANCES),
    ]
    report = substance_variance(samples)
    assert report.has_signal is True
    assert report.distinct_clubs == 2
    assert report.consistent is False


# ── Decision-grounding fidelity (caddie-advice-stability-tee-shot-plan.md
# §3.5/§3.7): `AnswerSubstance.club` is the FIRST-mentioned club regardless of
# whether the answer endorses or rejects it — in the 2026-07-15 baseline's
# answers that's usually "3wood" whether the caddie recommends it OR argues
# for the driver instead, which is exactly why the 3/2 flip only surfaced by
# eyeballing. `endorsed_club` is the falsifiable fix: it reads the club the
# answer actually RECOMMENDS via a closed endorsement-cue lexicon. Fixtures
# below are shaped on the real baseline answers (3 lay-up, 2 driver). ─────

_LAYUP_ANSWERS = [
    "The 3-wood is the call here.",
    "Safe play with the 3 wood into this green.",
    "I'd lay up with the three-wood — that's the play.",
]
_DRIVER_ANSWERS = [
    "I'd stick with driver here.",
    "Stick with driver and favor left.",
]


def test_extract_substance_endorsed_club_reads_lay_up_direction():
    for answer in _LAYUP_ANSWERS:
        substance = extract_substance(answer, _CLUB_DISTANCES)
        assert substance.endorsed_club == "3wood", (answer, substance)


def test_extract_substance_endorsed_club_reads_driver_direction():
    for answer in _DRIVER_ANSWERS:
        substance = extract_substance(answer, _CLUB_DISTANCES)
        assert substance.endorsed_club == "driver", (answer, substance)


def test_substance_variance_catches_the_3_2_recommendation_flip():
    """RED-proof for the 2026-07-15 defect itself: `club` alone reads
    "3wood" as the FIRST mention in most of these answers regardless of
    direction, so the flip would NOT surface via `distinct_clubs`. Only
    `distinct_endorsements` catches it — this reproduces the BEFORE state as
    a red the suite can run, not just eyeball."""
    samples = [extract_substance(a, _CLUB_DISTANCES) for a in _LAYUP_ANSWERS + _DRIVER_ANSWERS]
    report = substance_variance(samples)
    assert report.distinct_endorsements == 2
    assert not report.consistent


def test_substance_variance_5_of_5_driver_is_green():
    """AFTER state: same club recommended every time -> consistent."""
    answers = [
        "I'd stick with driver here.",
        "Stick with driver off the tee.",
        "Stay with driver — no reason to lay up.",
        "Take the driver, it's the play.",
        "Driver is the call today.",
    ]
    samples = [extract_substance(a, _CLUB_DISTANCES) for a in answers]
    assert all(s.endorsed_club == "driver" for s in samples)
    report = substance_variance(samples)
    assert report.distinct_endorsements == 1
    assert report.consistent


def test_substance_variance_all_none_endorsements_stay_consistent():
    """Vacuous probes (no endorsement cue anywhere in any sample) must not
    flip their existing True verdict just because `endorsed_club` now
    exists — `distinct_endorsements` counts a single distinct `None` value,
    not zero samples' worth of disagreement."""
    answers = [
        "Watch the bunker on the right, carry is about 240.",
        "There is a bunker right at 240, favor the left side.",
    ]
    samples = [extract_substance(a, _CLUB_DISTANCES) for a in answers]
    assert all(s.endorsed_club is None for s in samples)
    report = substance_variance(samples)
    assert report.distinct_endorsements == 1
    assert report.consistent


# ── golden/consistency_probes.jsonl loading — fail-closed ───────────────


def test_consistency_probes_jsonl_loads_and_references_real_scenario_ids():
    known_ids = {s.id for s in load_golden_set(GOLDEN_SET_PATH)}
    from tests.eval.substance import CONSISTENCY_PROBES_PATH

    probes = load_consistency_probes(CONSISTENCY_PROBES_PATH, known_ids)
    assert probes, "consistency_probes.jsonl must be non-empty"
    for probe in probes:
        assert probe.scenario_id in known_ids


# Representative "on-target" answers per probed scenario — names the bag's
# ideal club (within `club_within_one`'s tolerance of the scenario's
# question/hole yardage) plus the hole yardage itself. This is a CI
# invariant, not a hope: it proves each probed scenario CAN carry measurable
# substance, so a probe going NO-SIGNAL live (as `club-call-150y-mid-iron`
# and `plays-like-uphill-club-call` did on 2026-07-15) is a caddie-prompt
# regression to investigate, not a probe that was doomed to be vacuous.
_PROBE_REPRESENTATIVE_ANSWERS: dict[str, str] = {
    "club-call-150y-mid-iron": "8 iron is the play from 150.",
    "club-call-240y-off-tee": "Driver is the call from 240.",
    "followup-3wood-after-driver": "3-wood works well here, 235 off the tee.",
}


def test_consistency_probe_scenarios_can_carry_measurable_substance():
    """Every probe in `consistency_probes.jsonl` must reference a scenario
    whose bag/question shape lets a representative on-target answer extract
    non-empty substance (`club` is not `None`) — replaces the P4 vacuous
    probes (`club-call-150y-mid-iron`'s prior spelling gap, and
    `plays-like-uphill-club-call`'s strategic question that need not name a
    bag club) with signal-capable scenarios."""
    known_ids = {s.id for s in load_golden_set(GOLDEN_SET_PATH)}
    scenarios = {s.id: s for s in load_golden_set(GOLDEN_SET_PATH)}
    from tests.eval.substance import CONSISTENCY_PROBES_PATH

    probes = load_consistency_probes(CONSISTENCY_PROBES_PATH, known_ids)
    for probe in probes:
        assert probe.scenario_id in _PROBE_REPRESENTATIVE_ANSWERS, (
            f"add a representative on-target answer for {probe.scenario_id!r} to "
            "_PROBE_REPRESENTATIVE_ANSWERS so this stays a real CI invariant"
        )
        scenario = scenarios[probe.scenario_id]
        answer = _PROBE_REPRESENTATIVE_ANSWERS[probe.scenario_id]
        substance = extract_substance(answer, scenario.situation.player.club_distances)
        assert substance.club is not None, (
            f"scenario {probe.scenario_id!r}'s representative answer {answer!r} extracted no "
            "club — this scenario cannot carry measurable substance, do not probe it"
        )


def test_load_consistency_probes_fails_loudly_on_unknown_scenario_id():
    """RED-proof: an unknown scenario_id must fail LOUDLY at load time, not
    be silently accepted and probe nothing real."""
    known_ids = {"a-real-scenario-id"}
    with tempfile.TemporaryDirectory() as tmp:
        bad_path = Path(tmp) / "bad_probes.jsonl"
        bad_path.write_text('{"scenario_id": "does-not-exist", "n": 3}\n')
        with pytest.raises(ValueError, match="unknown scenario_id"):
            load_consistency_probes(bad_path, known_ids)


# ── run_consistency.py is never collected by pytest ──────────────────────


def test_run_consistency_filename_does_not_match_pytest_test_glob():
    import tests.eval.run_consistency as run_consistency_mod

    filename = pathlib.Path(run_consistency_mod.__file__).name
    assert not filename.startswith("test_"), (
        "run_consistency.py must never match pytest's test_*.py collection glob — "
        "it is invoked explicitly via `uv run python -m tests.eval.run_consistency`"
    )
    assert not hasattr(run_consistency_mod, "test_main"), "no function named like a pytest test in run_consistency"


def test_run_strategy_latency_filename_does_not_match_pytest_test_glob():
    """specs/caddie-smart-strategy-tool-plan.md §5 — the new gated strategy-
    synthesis latency probe follows the same never-collected-by-pytest
    contract as run_consistency.py/run_latency.py above."""
    import tests.eval.run_strategy_latency as run_strategy_latency_mod

    filename = pathlib.Path(run_strategy_latency_mod.__file__).name
    assert not filename.startswith("test_"), (
        "run_strategy_latency.py must never match pytest's test_*.py collection glob — "
        "it is invoked explicitly via `uv run python -m tests.eval.run_strategy_latency`"
    )
    assert not hasattr(run_strategy_latency_mod, "test_main"), (
        "no function named like a pytest test in run_strategy_latency"
    )
