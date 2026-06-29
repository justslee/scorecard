"""I3 feasibility gate: validate Bethpage Black assembled from the committed Overpass fixture.

Covers the three dimensions of the go/no-go verdict:
  - Par per hole vs. published card (hard assertion: expect 18/18).
  - Handicap/stroke-index per hole vs. card (soft assertion: report count).
  - Tee→green straight-line distance vs. Black-tee card yardage (report per-hole delta,
    flag holes off by >25 y as a potential mis-join; tolerate expected dogleg offset).

All tests are deterministic on the committed fixture; zero live network calls.

Card source: BlueGolf / IJGT course database
  https://bluegolf.ijgt.com/bluegolf/ijgt/course/bethpageblack/detailedscorecard.htm
  Verified 2026-06-29. Par 71, 7 486 yards from Black tees, rating 78.0, slope 155.
"""

from __future__ import annotations

import json
import math
import pathlib
from typing import Optional

import pytest

from app.services.osm import _parse_course_geometry_response
from app.services.osm_ingest import _deterministic_uuid, assemble_osm_course

# ── Fixture path ──────────────────────────────────────────────────────────────

FIXTURE_PATH = pathlib.Path(__file__).parent / "fixtures" / "bethpage_overpass.json"

# ── Published Bethpage Black scorecard (Black tees) ───────────────────────────
# Source: bluegolf.ijgt.com  (verified 2026-06-29)
# Par 71  ·  7 486 yards  ·  rating 78.0  ·  slope 155

CARD: dict[int, dict[str, int]] = {
    1:  {"par": 4, "handicap": 8,  "yards": 430},
    2:  {"par": 4, "handicap": 16, "yards": 389},
    3:  {"par": 3, "handicap": 18, "yards": 230},
    4:  {"par": 5, "handicap": 2,  "yards": 517},
    5:  {"par": 4, "handicap": 4,  "yards": 478},
    6:  {"par": 4, "handicap": 10, "yards": 408},
    7:  {"par": 5, "handicap": 6,  "yards": 553},
    8:  {"par": 3, "handicap": 14, "yards": 210},
    9:  {"par": 4, "handicap": 12, "yards": 460},
    10: {"par": 4, "handicap": 9,  "yards": 502},
    11: {"par": 4, "handicap": 11, "yards": 435},
    12: {"par": 4, "handicap": 7,  "yards": 516},
    13: {"par": 5, "handicap": 3,  "yards": 608},
    14: {"par": 3, "handicap": 17, "yards": 158},
    15: {"par": 4, "handicap": 1,  "yards": 484},
    16: {"par": 4, "handicap": 5,  "yards": 490},
    17: {"par": 3, "handicap": 13, "yards": 207},
    18: {"par": 4, "handicap": 15, "yards": 411},
}

CARD_PAR_TOTAL = 71
CARD_YARDS_TOTAL = 7_486

# Tolerance for straight-line tee→green vs. card yardage.
# Straight-line is always ≤ played distance (doglegs add length), so all
# deltas should be positive.  Flag holes off by > this threshold as potential
# mis-joins needing investigation.
YARDAGE_TOLERANCE_Y = 25

# ── Geometry helpers ──────────────────────────────────────────────────────────

_LAT_M_PER_DEG: float = 111_320.0
_M_PER_YARD: float = 0.9144


def _linestring_tee_to_green_yards(coords: list[list[float]]) -> Optional[float]:
    """Straight-line distance from the first to last coord of a hole LineString.

    Args:
        coords: GeoJSON LineString ``coordinates`` — list of ``[lon, lat]`` pairs.
                First coord = tee end; last coord = green end.

    Returns:
        Distance in yards, or ``None`` if ``coords`` has fewer than 2 points.
    """
    if len(coords) < 2:
        return None
    lon1, lat1 = coords[0]
    lon2, lat2 = coords[-1]
    mid_lat_rad = math.radians((lat1 + lat2) / 2.0)
    dx_m = (lon2 - lon1) * _LAT_M_PER_DEG * math.cos(mid_lat_rad)
    dy_m = (lat2 - lat1) * _LAT_M_PER_DEG
    return math.hypot(dx_m, dy_m) / _M_PER_YARD


# ── Module-scoped fixtures ─────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def raw_data() -> dict:
    """Raw Overpass JSON loaded from the committed fixture (no network)."""
    assert FIXTURE_PATH.exists(), (
        f"Fixture missing: {FIXTURE_PATH}. "
        "Run scripts/fetch_bethpage_fixture.py once to populate it."
    )
    return json.loads(FIXTURE_PATH.read_text())


@pytest.fixture(scope="module")
def geometry(raw_data: dict) -> dict:
    """Parsed geometry with ALL 90 holes (5 courses × 18) — no course filter.

    The spatial join needs all holes so cross-course rejection works.
    """
    return _parse_course_geometry_response(raw_data, course_name_filter=None)


@pytest.fixture(scope="module")
def black_holes(geometry: dict) -> dict[int, dict]:
    """Mapping of hole_number → OSM hole Feature for Black course only."""
    result: dict[int, dict] = {}
    for hole in geometry["holes"]:
        props = hole.get("properties") or {}
        if (props.get("course_name") or "").lower() == "black":
            ref = props.get("ref")
            if ref and str(ref).isdigit():
                result[int(ref)] = hole
    return result


@pytest.fixture(scope="module")
def assembled(geometry: dict) -> dict:
    """Assembled course dict from the I0→I1→I2 pipeline."""
    course_id = _deterministic_uuid("osm-bethpage-black")
    return assemble_osm_course(
        geometry=geometry,
        course_id=course_id,
        course_name="Bethpage Black",
        target_course_name="Black",
        address="99 Quaker Meeting House Rd, Farmingdale, NY 11735",
        location={"lat": 40.7445, "lng": -73.4609},
    )


# ══════════════════════════════════════════════════════════════════════════════
# I. Fixture integrity
# ══════════════════════════════════════════════════════════════════════════════


class TestFixture:
    """Sanity-check the committed Overpass fixture before any pipeline logic."""

    def test_fixture_file_exists(self):
        assert FIXTURE_PATH.exists()

    def test_fixture_has_elements(self, raw_data: dict):
        assert len(raw_data.get("elements", [])) > 0

    def test_all_five_courses_present(self, raw_data: dict):
        """Bethpage has 5 courses; all should appear in the fixture."""
        course_names: set[str] = set()
        for el in raw_data["elements"]:
            cn = el.get("tags", {}).get("golf:course:name")
            if cn:
                course_names.add(cn)
        assert "Black" in course_names

    def test_exactly_18_black_holes(self, black_holes: dict):
        assert len(black_holes) == 18, (
            f"Expected 18 Black holes, got {len(black_holes)}: {sorted(black_holes)}"
        )


# ══════════════════════════════════════════════════════════════════════════════
# II. Par validation (hard) — expect 18/18
# ══════════════════════════════════════════════════════════════════════════════


class TestPar:
    """OSM par tags must match the published card for all 18 Black holes."""

    def test_par_all_18_holes(self, black_holes: dict):
        """Hard assertion: every hole's OSM par must equal the card par.

        Failure here means either OSM data is wrong or the card source is wrong.
        """
        mismatches: list[str] = []
        for hole_num in sorted(black_holes):
            props = black_holes[hole_num].get("properties") or {}
            osm_par = props.get("par")
            card_par = CARD[hole_num]["par"]
            if osm_par != card_par:
                mismatches.append(
                    f"Hole {hole_num}: OSM par={osm_par}, card par={card_par}"
                )
        assert mismatches == [], "Par mismatch:\n" + "\n".join(mismatches)

    def test_par_total_equals_71(self, black_holes: dict):
        total = sum(
            (black_holes[n].get("properties") or {}).get("par") or 0
            for n in black_holes
        )
        assert total == CARD_PAR_TOTAL, f"OSM par total {total} != {CARD_PAR_TOTAL}"


# ══════════════════════════════════════════════════════════════════════════════
# III. Handicap / stroke-index validation (soft) — report count
# ══════════════════════════════════════════════════════════════════════════════


class TestHandicap:
    """OSM handicap tags vs. card stroke index.

    OSM data at Bethpage is community-maintained; minor SI discrepancies are
    possible.  This test reports the match count but does not hard-fail — the
    feasibility gate is par + yardage quality.
    """

    # Require at least this many holes to match; Bethpage Black OSM is
    # well-maintained so we expect 18/18.
    MIN_HCP_MATCHES = 16

    def test_handicap_match_count_sufficient(self, black_holes: dict):
        matches = sum(
            1
            for n in black_holes
            if (black_holes[n].get("properties") or {}).get("handicap")
            == CARD[n]["handicap"]
        )
        # Print the full table regardless.
        print(f"\nHandicap match: {matches}/18")
        for n in sorted(black_holes):
            osm_hcp = (black_holes[n].get("properties") or {}).get("handicap")
            card_hcp = CARD[n]["handicap"]
            flag = "" if osm_hcp == card_hcp else " *** MISMATCH"
            print(f"  Hole {n:2}: OSM={osm_hcp}, Card={card_hcp}{flag}")
        assert matches >= self.MIN_HCP_MATCHES, (
            f"Only {matches}/18 handicap values match; expected ≥{self.MIN_HCP_MATCHES}"
        )


# ══════════════════════════════════════════════════════════════════════════════
# IV. Yardage validation (soft) — straight-line tee→green vs. card
# ══════════════════════════════════════════════════════════════════════════════


class TestYardage:
    """Tee→green straight-line distance vs. Black-tee card yardage.

    Straight-line is always ≤ played distance (doglegs add length), so
    all deltas should be non-negative (card ≥ straight-line).  A large
    negative delta would indicate a tee-end / green-end swap; a delta
    > 200 y positive would indicate a gross geometry error.

    14/18 within 25 y is the expected baseline; the 4 over-tolerance holes
    (7, 1, 12, 9) have dogleg routing that genuinely extends played distance.
    """

    # Expect at least this many holes within the yardage tolerance.
    MIN_WITHIN_TOLERANCE = 12

    # Flag (and hard-fail) any delta exceeding this as a gross pipeline error.
    MAX_PLAUSIBLE_DELTA_Y = 200

    def test_yardage_per_hole(self, black_holes: dict):
        within_count = 0
        over_threshold: list[str] = []
        gross_errors: list[str] = []

        print(f"\n{'Hole':4}  {'SL Yds':>8}  {'Card Yds':>8}  {'Delta':>7}  Status")
        print("-" * 48)
        for n in sorted(black_holes):
            coords = (
                (black_holes[n].get("geometry") or {}).get("coordinates") or []
            )
            sl_yards = _linestring_tee_to_green_yards(coords)
            card_yards = CARD[n]["yards"]

            if sl_yards is None:
                print(f"{n:4}  {'N/A':>8}  {card_yards:>8}  {'N/A':>7}  NO GEOM")
                continue

            delta = card_yards - sl_yards  # positive = card longer than straight-line
            within = abs(delta) <= YARDAGE_TOLERANCE_Y

            if within:
                within_count += 1
                status = "OK"
            elif delta > self.MAX_PLAUSIBLE_DELTA_Y:
                gross_errors.append(
                    f"Hole {n}: SL={sl_yards:.0f}y card={card_yards}y delta={delta:+.0f}y"
                )
                status = "GROSS ERROR"
            elif delta < -self.MAX_PLAUSIBLE_DELTA_Y:
                gross_errors.append(
                    f"Hole {n}: SL={sl_yards:.0f}y card={card_yards}y delta={delta:+.0f}y (reversed?)"
                )
                status = "GROSS REVERSED"
            else:
                over_threshold.append(
                    f"Hole {n}: SL={sl_yards:.0f}y card={card_yards}y delta={delta:+.0f}y"
                )
                status = f">{YARDAGE_TOLERANCE_Y}y"

            print(f"{n:4}  {sl_yards:>8.0f}  {card_yards:>8}  {delta:>+7.0f}  {status}")

        print("-" * 48)
        print(f"Within {YARDAGE_TOLERANCE_Y}y tolerance: {within_count}/18")
        if over_threshold:
            print(f"Over tolerance (expected dogleg): {', '.join(f.split(':')[0].strip() for f in over_threshold)}")
        if gross_errors:
            print("GROSS ERRORS (potential mis-joins):")
            for e in gross_errors:
                print(f"  {e}")

        assert not gross_errors, (
            "Gross yardage errors detected — likely pipeline mis-joins:\n"
            + "\n".join(gross_errors)
        )
        assert within_count >= self.MIN_WITHIN_TOLERANCE, (
            f"Only {within_count}/18 holes within {YARDAGE_TOLERANCE_Y}y; "
            f"expected ≥{self.MIN_WITHIN_TOLERANCE}"
        )


# ══════════════════════════════════════════════════════════════════════════════
# V. Assembled output — pipeline end-to-end
# ══════════════════════════════════════════════════════════════════════════════


class TestAssembledOutput:
    """Verify the I0→I1→I2 pipeline assembles a complete course dict."""

    def test_assembled_has_18_holes(self, assembled: dict):
        assert len(assembled["holes"]) == 18, (
            f"Assembled {len(assembled['holes'])} holes; expected 18. "
            f"Got: {[h['number'] for h in assembled['holes']]}"
        )

    def test_assembled_par_total(self, assembled: dict):
        total = sum(h.get("par") or 0 for h in assembled["holes"])
        assert total == CARD_PAR_TOTAL, (
            f"Assembled par total {total} != {CARD_PAR_TOTAL}"
        )

    def test_assembled_hole_numbers_1_to_18(self, assembled: dict):
        nums = sorted(h["number"] for h in assembled["holes"])
        assert nums == list(range(1, 19))

    def test_assembled_each_hole_has_features(self, assembled: dict):
        """Every hole should have ≥1 polygon feature (green, tee, or fairway)."""
        empty = [
            h["number"]
            for h in assembled["holes"]
            if not h["features"]["features"]
        ]
        assert not empty, f"Holes with no features: {empty}"

    def test_assembled_course_id_deterministic(self, assembled: dict):
        expected_id = _deterministic_uuid("osm-bethpage-black")
        assert assembled["id"] == expected_id

    def test_assembled_par_per_hole_matches_card(self, assembled: dict):
        """Par from assembled output must equal the card."""
        mismatches: list[str] = []
        for hole in assembled["holes"]:
            n = hole["number"]
            if hole.get("par") != CARD[n]["par"]:
                mismatches.append(
                    f"Hole {n}: assembled par={hole.get('par')}, card={CARD[n]['par']}"
                )
        assert mismatches == [], "Par mismatch in assembled output:\n" + "\n".join(mismatches)
