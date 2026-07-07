"""Voice error hygiene (owner escalation 2026-07-07: raw '{"detail": "list
index out of range"}' rendered in the CaddieSheet).

Two invariants:
1. `_first_text` never raises on an empty/odd Claude response — the empty
   case that produced the IndexError.
2. The catch-all details are calm sentences, never raw exception text.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from app.routes.caddie import _CADDIE_ERROR_DETAIL, _first_text  # noqa: E402


class _Block:
    def __init__(self, text=None, type_="text"):
        if text is not None:
            self.text = text
        self.type = type_


class _Msg:
    def __init__(self, content):
        self.content = content


def test_first_text_empty_content_returns_empty_string():
    assert _first_text(_Msg([])) == ""


def test_first_text_missing_content_returns_empty_string():
    assert _first_text(object()) == ""


def test_first_text_skips_non_text_blocks():
    assert _first_text(_Msg([_Block(type_="tool_use"), _Block(text="hey")])) == "hey"


def test_first_text_normal_case():
    assert _first_text(_Msg([_Block(text="Easy 7-iron.")])) == "Easy 7-iron."


def test_error_detail_is_a_calm_sentence_not_an_exception():
    assert "index" not in _CADDIE_ERROR_DETAIL.lower()
    assert "error" not in _CADDIE_ERROR_DETAIL.lower()
    assert _CADDIE_ERROR_DETAIL.endswith(".")


# ── Legacy course-id rescue (owner's 2026-07-07 round: slug id crashed every
# session start → no intel/hazards/elev/weather for the whole round) ──

from app.routes.caddie import _safe_course_uuid  # noqa: E402


def test_safe_course_uuid_accepts_uuids():
    assert (
        _safe_course_uuid("2b8caab5-2c55-5752-8cda-336c3a396dac")
        == "2b8caab5-2c55-5752-8cda-336c3a396dac"
    )


def test_safe_course_uuid_rejects_legacy_slugs_and_junk():
    assert _safe_course_uuid("bethpage-black") is None
    assert _safe_course_uuid("") is None
    assert _safe_course_uuid(None) is None
    assert _safe_course_uuid(123) is None
