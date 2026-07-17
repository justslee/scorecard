"""Regression fixtures pinned to real Bethpage RED ground truth —
specs/caddie-tree-span-gap-plan.md §4a/§4b (owner P0: RED tree distances
"wrong off the tee").

The committed fixture (`tests/fixtures/bethpage_red_trees.json`) carries
holes 1, 5, 6 (the tree-bearing holes) — tee/green/hole-line geometry plus
every raw tree/woods feature, reconstructed into a FeatureCollection here and
run through the SAME `extract_hole_hazards`/`format_hazards_line` used in
production. `deployed` in the fixture records the ALREADY-VERIFIED (during
planning, independent geodesic ground truth ±5y) engine output — test 1 below
re-proves that reconstruction still reproduces it bit-for-bit, so every other
test in this file is provably exercising the real deployed carries, not a
synthetic stand-in. Do NOT reference the scratchpad the fixture was built
from — this file is the committed source of truth.
"""

from __future__ import annotations

import json
import pathlib
import re

import pytest

from app.caddie.hazards import extract_hole_hazards, format_hazards_line

FIXTURE_PATH = pathlib.Path(__file__).parent / "fixtures" / "bethpage_red_trees.json"


@pytest.fixture(scope="module")
def fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text())


def _build_fc(hole: dict) -> dict:
    """Reconstruction recipe pinned by the plan (§4a): each tee geometry as
    `featureType: "tee"`, `green_geom` as `"green"`, `hole_line` as a
    `"hole"` LineString, each tree feature with `featureType` = its `ft`."""
    features: list[dict] = []
    for tee_geom in hole["tees"]:
        features.append({"type": "Feature", "properties": {"featureType": "tee"}, "geometry": tee_geom})
    features.append({"type": "Feature", "properties": {"featureType": "green"}, "geometry": hole["green_geom"]})
    features.append({
        "type": "Feature",
        "properties": {"featureType": "hole"},
        "geometry": {"type": "LineString", "coordinates": hole["hole_line"]},
    })
    for tf in hole["tree_features"]:
        features.append({"type": "Feature", "properties": {"featureType": tf["ft"]}, "geometry": tf["geom"]})
    return {"type": "FeatureCollection", "features": features}


def _tree_hazards_for(fixture: dict, hole_number: str) -> list:
    fc = _build_fc(fixture[hole_number])
    return [hz for hz in extract_hole_hazards(fc) if hz.type == "trees"]


class TestFixtureReconstruction:
    """§4b test 1: carry invariance — the chain math itself is untouched by
    this plan; reconstructing from the committed fixture must still
    reproduce the already-verified deployed per-side carries EXACTLY."""

    @pytest.mark.parametrize("hole_number", ["1", "5", "6"])
    def test_extracted_tree_carries_match_deployed_ground_truth(self, fixture, hole_number):
        fc = _build_fc(fixture[hole_number])
        hazards = extract_hole_hazards(fc)
        by_side: dict[str, list[int]] = {}
        for hz in hazards:
            if hz.type == "trees":
                by_side.setdefault(hz.side, []).append(hz.carry_yards)
        for side in by_side:
            by_side[side].sort()

        expected = fixture[hole_number]["deployed"]["tree_carries_by_side"]
        assert by_side == expected, (
            f"hole {hole_number}: reconstructed tree carries {by_side} != "
            f"deployed ground truth {expected} — the chain math (untouched "
            f"by this plan) no longer reproduces the deployed engine output"
        )


class TestHole1SplitLine:
    """§4b tests 2/3 — the owner's actual complaint, Bethpage RED 1."""

    def test_hole_1_split_renders_both_gap_separated_runs(self, fixture):
        hazards = _tree_hazards_for(fixture, "1")
        line = format_hazards_line(1, hazards)
        assert line == "Hole 1 hazards: trees L 265-480y, trees R 385-475y"
        # The OLD collapsed-range tokens must not appear as their own token —
        # word-bounded, not a raw substring check: "385-475y" (the NEW,
        # correct right-side run) legitimately ends in the digits "5-475y",
        # so a bare `"5-475" not in line` would false-fail on the correct
        # output. `\b5-475y\b` only matches the OLD collapsed token
        # ("trees R 5-475y") as a standalone number, never a suffix of 385.
        assert not re.search(r"\b5-475y\b", line), f"old collapsed range leaked into: {line!r}"
        assert not re.search(r"\b30-480y\b", line), f"old collapsed range leaked into: {line!r}"

    def test_hole_1_drive_zone_is_structurally_clear(self, fixture):
        """The owner's complaint, asserted structurally (not just by exact
        string match): parse every rendered tree range and assert none of
        them claims trees across the proven open drive zone — no LEFT range
        intersects [70, 260] and no RIGHT range intersects [90, 380] (the
        real open zones with 5y rounding margin either side of the near-tee
        suppression boundary and the real gap edges)."""
        hazards = _tree_hazards_for(fixture, "1")
        line = format_hazards_line(1, hazards)

        # Parse every "SIDE lo[-hi]y" token, including each " and "-joined
        # segment of a split trees group — mirrors the eval harness's
        # `finditer` discipline for hazard tokens (tests/eval/checks.py).
        ranges_by_side: dict[str, list[tuple[int, int]]] = {"L": [], "R": []}
        for m in re.finditer(r"trees\s+([LR])\s+((?:\d+(?:-\d+)?y(?:\s+and\s+)?)+)", line):
            side, segments = m.group(1), m.group(2)
            for seg_m in re.finditer(r"(\d+)(?:-(\d+))?y", segments):
                lo = int(seg_m.group(1))
                hi = int(seg_m.group(2)) if seg_m.group(2) else lo
                ranges_by_side[side].append((lo, hi))

        def _intersects(a: tuple[int, int], b: tuple[int, int]) -> bool:
            return a[0] <= b[1] and b[0] <= a[1]

        for lo, hi in ranges_by_side["L"]:
            assert not _intersects((lo, hi), (70, 260)), (
                f"LEFT range {lo}-{hi}y wrongly claims trees across the proven open drive zone: {line!r}"
            )
        for lo, hi in ranges_by_side["R"]:
            assert not _intersects((lo, hi), (90, 380)), (
                f"RIGHT range {lo}-{hi}y wrongly claims trees across the proven open drive zone: {line!r}"
            )


class TestHole6ContinuityAntiOverfit:
    """§4b test 4 — anti-overfit anchor: a genuinely continuous tree line
    (95/60/55y intra-line gaps, all <= TREE_RUN_SPLIT_GAP_YDS) must NOT be
    split, and its only run must NOT be near-tee suppressed despite starting
    at 40y (suppression requires >= 2 runs on the side)."""

    def test_hole_6_stays_one_continuous_run(self, fixture):
        hazards = _tree_hazards_for(fixture, "6")
        line = format_hazards_line(6, hazards)
        assert line == "Hole 6 hazards: trees R 40-310y"


class TestHole5MergedGap:
    """§4b test 5 — a 50y intra-line gap merges (well under the 120y
    threshold), unchanged from before this plan."""

    def test_hole_5_merges_the_50y_gap(self, fixture):
        hazards = _tree_hazards_for(fixture, "5")
        line = format_hazards_line(5, hazards)
        assert line == "Hole 5 hazards: trees R 105-170y"
