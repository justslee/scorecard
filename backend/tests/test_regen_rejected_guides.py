"""Offline unit tests for scripts/regen_rejected_guides.py's pure spec
parser + hard cap (guide-validator-carry-span-plan.md §5).

No network, no database — `parse_regen_guides_spec` is a pure function with
no import of any DB-touching module (the DB-touching op, `_regen`, late-
imports `app.services.*` only inside its own function body). Loaded by file
path since `backend/scripts/` is a standalone-script directory, not an
importable package.
"""

from __future__ import annotations

import importlib.util
import pathlib

_SCRIPT_PATH = pathlib.Path(__file__).parent.parent / "scripts" / "regen_rejected_guides.py"

_spec = importlib.util.spec_from_file_location("regen_rejected_guides", _SCRIPT_PATH)
assert _spec is not None and _spec.loader is not None
regen_rejected_guides = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(regen_rejected_guides)

parse_regen_guides_spec = regen_rejected_guides.parse_regen_guides_spec


def test_empty_spec_is_a_noop():
    assert parse_regen_guides_spec("", 10) == []
    assert parse_regen_guides_spec("   ", 10) == []


def test_single_course_single_hole():
    assert parse_regen_guides_spec("abc-123:7", 10) == [("abc-123", [7])]


def test_single_course_multiple_holes():
    assert parse_regen_guides_spec("abc-123:1,8,18", 10) == [("abc-123", [1, 8, 18])]


def test_multiple_courses():
    spec = "course-a:1,8,18;course-b:7,11"
    assert parse_regen_guides_spec(spec, 10) == [
        ("course-a", [1, 8, 18]),
        ("course-b", [7, 11]),
    ]


def test_whitespace_around_tokens_is_trimmed():
    spec = " course-a : 1 , 8 , 18 ; course-b : 7 , 11 "
    assert parse_regen_guides_spec(spec, 10) == [
        ("course-a", [1, 8, 18]),
        ("course-b", [7, 11]),
    ]


def test_malformed_chunk_missing_colon_is_skipped():
    """A chunk with no ':' can't be split into course_id/holes -- skip it
    rather than raise; this is operator input, not a code constant."""
    assert parse_regen_guides_spec("no-colon-here;course-b:7", 10) == [("course-b", [7])]


def test_empty_course_id_is_skipped():
    assert parse_regen_guides_spec(":1,2;course-b:7", 10) == [("course-b", [7])]


def test_non_digit_hole_token_is_skipped():
    """A stray non-numeric hole token is dropped, not fatal -- the rest of
    that course's real hole numbers still parse."""
    assert parse_regen_guides_spec("course-a:1,eighteen,8", 10) == [("course-a", [1, 8])]


def test_course_with_zero_valid_holes_is_dropped_entirely():
    assert parse_regen_guides_spec("course-a:not-a-number;course-b:7", 10) == [("course-b", [7])]


def test_hard_cap_truncates_within_one_course():
    """The cap applies across the WHOLE spec, mid-course if needed."""
    assert parse_regen_guides_spec("course-a:1,2,3,4,5", 3) == [("course-a", [1, 2, 3])]


def test_hard_cap_truncates_across_courses():
    spec = "course-a:1,8,18;course-b:7,11"
    # 5 holes total requested; cap 4 -> course-a keeps all 3, course-b keeps
    # only its first (7), and 11 is dropped.
    assert parse_regen_guides_spec(spec, 4) == [("course-a", [1, 8, 18]), ("course-b", [7])]


def test_hard_cap_drops_a_course_entirely_once_exhausted():
    spec = "course-a:1,8,18;course-b:7,11"
    assert parse_regen_guides_spec(spec, 3) == [("course-a", [1, 8, 18])]


def test_zero_or_negative_cap_is_a_noop():
    assert parse_regen_guides_spec("course-a:1,8,18", 0) == []
    assert parse_regen_guides_spec("course-a:1,8,18", -5) == []


def test_default_cap_constant_matches_plan():
    assert regen_rejected_guides._REGEN_GUIDES_MAX_HOLES_DEFAULT == 10


def test_max_holes_from_env_default(monkeypatch):
    monkeypatch.delenv("REGEN_GUIDES_MAX_HOLES", raising=False)
    assert regen_rejected_guides._max_holes_from_env() == 10


def test_max_holes_from_env_override(monkeypatch):
    monkeypatch.setenv("REGEN_GUIDES_MAX_HOLES", "3")
    assert regen_rejected_guides._max_holes_from_env() == 3


def test_max_holes_from_env_invalid_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("REGEN_GUIDES_MAX_HOLES", "not-a-number")
    assert regen_rejected_guides._max_holes_from_env() == 10
