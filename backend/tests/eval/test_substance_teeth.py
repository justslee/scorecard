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
