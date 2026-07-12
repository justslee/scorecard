"""Par-vs-yardage sanity guard (specs/caddie-numbers-coherence-plan.md §4.3,
§7). Owner incident (2026-07-12, Bethpage RED 3): the card showed
"PAR 3 · 355 YDS" — no real par 3 plays 280+ yards from any normal tee, so a
355y "par 3" implies the stored par is wrong. This guard is data-independent
(no DB access required) and fires on the shared yardage/context formatters
BOTH mouths use — `_format_yardage_line` (routes/caddie.py, text mouth) and
`_situation_block` (voice_prompts.py, realtime mouth) — so a suspect par is
flagged everywhere, never silently trusted.

The DB verification + origin trace for the ACTUAL Bethpage Red 3 stored par
(specs §4.3 "Verification + source fix") is a noted follow-up — this file
only locks the data-independent guard.

No network, no real database.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.types import HoleIntelligence  # noqa: E402
from app.caddie.voice_prompts import _situation_block, format_par_sanity_note  # noqa: E402
from app.routes.caddie import _format_yardage_line  # noqa: E402


# ── format_par_sanity_note (the shared pure helper) ─────────────────────────


def test_par3_over_280_yards_fires():
    note = format_par_sanity_note(par=3, yards=355)
    assert "two-shot hole" in note
    assert "suspect" in note


def test_par3_under_280_yards_no_flag():
    note = format_par_sanity_note(par=3, yards=240)
    assert note == ""


def test_par4_no_flag_regardless_of_yardage():
    note = format_par_sanity_note(par=4, yards=466)
    assert note == ""


def test_par3_exactly_at_threshold_no_flag():
    note = format_par_sanity_note(par=3, yards=280)
    assert note == ""


def test_unknown_par_or_yardage_no_flag():
    assert format_par_sanity_note(par=None, yards=355) == ""
    assert format_par_sanity_note(par=3, yards=None) == ""


# ── Text mouth: _format_yardage_line ────────────────────────────────────────


def test_format_yardage_line_flags_suspect_par3():
    line = _format_yardage_line(
        hole_number=3, par=3, distance_to_green_yards=None,
        hole_yards=355, yardage_basis="tee-card", tee_name="Black",
    )
    assert "two-shot hole" in line
    assert "suspect" in line


def test_format_yardage_line_no_flag_for_normal_par3():
    line = _format_yardage_line(
        hole_number=3, par=3, distance_to_green_yards=None,
        hole_yards=231, yardage_basis="tee-card", tee_name="Black",
    )
    assert "suspect" not in line
    assert "two-shot" not in line


def test_format_yardage_line_no_flag_for_par4():
    line = _format_yardage_line(
        hole_number=1, par=4, distance_to_green_yards=None,
        hole_yards=466, yardage_basis="tee-card", tee_name="Black",
    )
    assert "suspect" not in line


# ── Realtime mouth: _situation_block ────────────────────────────────────────


def test_situation_block_flags_suspect_par3():
    session = RoundSession(
        round_id="r1", user_id="u1", current_hole=3,
        hole_intel={3: HoleIntelligence(hole_number=3, par=3, yards=355)},
    )
    block = _situation_block(session)
    assert "two-shot hole" in block
    assert "suspect" in block


def test_situation_block_no_flag_for_normal_hole():
    session = RoundSession(
        round_id="r1", user_id="u1", current_hole=1,
        hole_intel={1: HoleIntelligence(hole_number=1, par=4, yards=466)},
    )
    block = _situation_block(session)
    assert "suspect" not in block
