"""Unit tests for the shared caddie yardage-context formatter
(`_format_yardage_line`, specs/caddie-yardage-gps-selected-tee-plan.md §2.4/§5).

Pure function — no DB, no LLM. Locks the PROVENANCE labeling and, critically,
the par-4/5 tee-GEOMETRY FLOOR: geometry understates a doglegged/routed hole,
so the caddie's spoken number must be a floor ("at least …"), matching the
frontend "at least …" caption (hole-yardage.ts) so no surface states an
understated number as if it were exact.
"""

import os

# Importing app.routes.caddie initializes the DB engine, which raises at import
# time when DATABASE_URL is unset. This test does zero DB I/O — stub a
# placeholder before import (same pattern as test_caddie_caching.py).
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from app.routes.caddie import _format_yardage_line  # noqa: E402


def test_gps_is_the_players_real_number():
    line = _format_yardage_line(
        hole_number=3,
        par=3,
        distance_to_green_yards=204,
        hole_yards=231,
        yardage_basis="gps",
    )
    assert "204 yards" in line
    assert "GPS" in line
    assert "real number" in line
    assert "178" not in line
    assert "400" not in line


def test_tee_card_is_exact_and_names_the_tee():
    line = _format_yardage_line(
        hole_number=3,
        par=3,
        distance_to_green_yards=None,
        hole_yards=231,
        yardage_basis="tee-card",
        tee_name="Black",
    )
    assert "231 yards" in line
    assert "Black tees" in line
    assert "at least" not in line  # a real tee card is exact, not a floor
    assert "178" not in line


def test_par3_tee_geometry_is_exact_not_a_floor():
    # A par 3 is essentially straight tee-to-green — geometry is exact, no floor.
    line = _format_yardage_line(
        hole_number=3,
        par=3,
        distance_to_green_yards=None,
        hole_yards=232,
        yardage_basis="tee-geom",
        tee_name="Black",
    )
    assert "232 yards" in line
    assert "at least" not in line
    assert "Black tees" in line


def test_par4_tee_geometry_is_stated_as_a_floor():
    # Par 4/5 geometry understates a routed/dogleg hole → floor, never exact.
    line = _format_yardage_line(
        hole_number=7,
        par=4,
        distance_to_green_yards=None,
        hole_yards=380,
        yardage_basis="tee-geom",
        tee_name="Black",
    )
    assert "at least 380 yards" in line
    assert "straight-line" in line
    assert "may play longer" in line
    assert "Black tees" in line


def test_par5_tee_geometry_is_also_a_floor():
    line = _format_yardage_line(
        hole_number=13,
        par=5,
        distance_to_green_yards=None,
        hole_yards=505,
        yardage_basis="tee-geom",
        tee_name="Blue",
    )
    assert "at least 505 yards" in line


def test_no_signal_is_honestly_unknown_never_fabricated():
    line = _format_yardage_line(
        hole_number=4,
        par=None,
        distance_to_green_yards=None,
        hole_yards=None,
        yardage_basis=None,
    )
    assert "yardage unknown" in line
    assert "400" not in line
    assert "178" not in line
