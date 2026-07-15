"""
Tests for the pure, network-free schema-drift canary
(specs/teetime-s4f-coverage-flywheel-plan.md §4, §8).

Zero network: every case reads a checked-in fixture (or an in-test mutated
COPY of one) as raw bytes and calls `check_shape` directly — the exact same
function `coverage_flywheel.py canary` would run against a live capture, but
here fully offline and deterministic.

`query_date` is DERIVED from each fixture's own contents at test runtime
(never hardcoded against a live clock) — the same pattern
`test_tee_time_foreup.py` / `test_tee_time_teeitup.py` / etc. already use.

NOTE on `teeitup_empty.json`: transcribing teeitup.py's REAL `_do_fetch`
guard (module docstring / plan §4a rule 1), only a top-level array with
LENGTH ZERO is drift. `teeitup_empty.json` is `[{"teetimes": [], ...}]` — one
real facility record with an empty `teetimes` list (a genuinely closed/
not-yet-released day) — so under rule 1 it is NOT drift; `check_shape`
correctly reports `healthy=True, entries=0` at `expect_nonempty=False`. It
DOES become drift under `expect_nonempty=True` (rule 3, "no-entries") — the
canary's own known-good-course mode always asks with `expect_nonempty=True`,
so a real empty day and true schema drift are deliberately indistinguishable
from that mode alone (plan §9 "canary false alarms", mitigated by the
exit-code-only cron contract). This file asserts BOTH sides of that
distinction rather than the "actually drift... per rule 1" framing in the
plan's prose, which does not match teeitup.py's actual `_do_fetch` guard
(verified against the real code, not invented) — flagged in the PR notes.
"""

from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from app.services.tee_times.schema_canary import check_shape

_FIX = Path(__file__).parent / "fixtures"
_TZ = ZoneInfo("America/New_York")


def _bytes(name: str) -> bytes:
    return (_FIX / name).read_bytes()


def _json(name: str):
    return json.loads((_FIX / name).read_text())


# ── foreup ───────────────────────────────────────────────────────────────────

_FOREUP_RAW = _json("foreup_18mile_times.json")
_FOREUP_DATE = _FOREUP_RAW[0]["time"].split(" ")[0]


class TestForeupCanary:
    def test_good_fixture_is_healthy(self):
        r = check_shape(
            "foreup", _bytes("foreup_18mile_times.json"),
            query_date=_FOREUP_DATE, party_size=1, expect_nonempty=True,
        )
        assert r.healthy is True
        assert r.reason == ""
        assert r.entries > 0

    def test_wrapped_top_level_is_drift(self):
        wrapped = json.dumps({"data": _FOREUP_RAW}).encode()
        r = check_shape("foreup", wrapped, query_date=_FOREUP_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason == "top-level-shape"
        assert r.entries == 0

    def test_non_json_body_is_drift(self):
        r = check_shape("foreup", b"not json at all", query_date=_FOREUP_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason == "non-json"

    def test_renamed_entries_key_yields_zero_entries_caught_by_expect_nonempty(self):
        """A skip-tolerant `_normalize_day` silently drops a renamed field —
        `healthy=True, entries=0` under expect_nonempty=False (looks like a
        real empty day!), but `expect_nonempty=True` catches it (rule 3)."""
        renamed = copy.deepcopy(_FOREUP_RAW)
        for entry in renamed:
            entry["open_spots"] = entry.pop("available_spots")
        body = json.dumps(renamed).encode()

        lenient = check_shape("foreup", body, query_date=_FOREUP_DATE, party_size=1, expect_nonempty=False)
        assert lenient.healthy is True
        assert lenient.entries == 0

        strict = check_shape("foreup", body, query_date=_FOREUP_DATE, party_size=1, expect_nonempty=True)
        assert strict.healthy is False
        assert strict.reason == "no-entries"

    def test_implausible_player_count_is_drift(self):
        mutated = copy.deepcopy(_FOREUP_RAW)
        mutated[0]["available_spots"] = 999
        r = check_shape("foreup", json.dumps(mutated).encode(), query_date=_FOREUP_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason.startswith("implausible:")
        assert "players" in r.reason


# ── teeitup ──────────────────────────────────────────────────────────────────

_TEEITUP_RAW = _json("teeitup_golfnyc_times.json")
_TEEITUP_FIRST_TEETIME = _TEEITUP_RAW[0]["teetimes"][0]["teetime"]
_TEEITUP_DATE = (
    datetime.fromisoformat(_TEEITUP_FIRST_TEETIME.replace("Z", "+00:00"))
    .astimezone(_TZ)
    .strftime("%Y-%m-%d")
)


class TestTeeItUpCanary:
    def test_good_fixture_is_healthy(self):
        r = check_shape(
            "teeitup", _bytes("teeitup_golfnyc_times.json"),
            query_date=_TEEITUP_DATE, party_size=1, expect_nonempty=True,
        )
        assert r.healthy is True
        assert r.entries > 0

    def test_empty_top_level_array_is_drift(self):
        """teeitup.py `_do_fetch` treats a ZERO-length top-level array as
        drift (a queried facility always returns >=1 dayInfo-wrapped
        record) — the exact condition rule 1 mirrors."""
        r = check_shape("teeitup", b"[]", query_date=_TEEITUP_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason == "top-level-shape"

    def test_real_empty_day_capture_is_healthy_when_not_expecting_nonempty(self):
        r = check_shape(
            "teeitup", _bytes("teeitup_empty.json"),
            query_date="2026-01-01", party_size=1, expect_nonempty=False,
        )
        assert r.healthy is True
        assert r.entries == 0

    def test_same_capture_flagged_under_expect_nonempty(self):
        r = check_shape(
            "teeitup", _bytes("teeitup_empty.json"),
            query_date="2026-01-01", party_size=1, expect_nonempty=True,
        )
        assert r.healthy is False
        assert r.reason == "no-entries"

    def test_renamed_teetimes_key_caught_by_expect_nonempty(self):
        renamed = copy.deepcopy(_TEEITUP_RAW)
        for rec in renamed:
            rec["tt"] = rec.pop("teetimes")
        r = check_shape(
            "teeitup", json.dumps(renamed).encode(),
            query_date=_TEEITUP_DATE, party_size=1, expect_nonempty=True,
        )
        assert r.healthy is False
        assert r.reason == "no-entries"

    def test_implausible_max_players_is_drift(self):
        mutated = copy.deepcopy(_TEEITUP_RAW)
        mutated[0]["teetimes"][0]["maxPlayers"] = 999
        r = check_shape("teeitup", json.dumps(mutated).encode(), query_date=_TEEITUP_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason.startswith("implausible:")


# ── chronogolf ───────────────────────────────────────────────────────────────

_CHRONOGOLF_RAW = _json("chronogolf_rockspring_times.json")
_CHRONOGOLF_DATE = _CHRONOGOLF_RAW[0]["date"]
_CHRONOGOLF_BOOKABLE_IDX = next(
    i for i, e in enumerate(_CHRONOGOLF_RAW)
    if e.get("out_of_capacity") is False and e.get("green_fees")
)


class TestChronogolfCanary:
    def test_good_fixture_is_healthy(self):
        r = check_shape(
            "chronogolf", _bytes("chronogolf_rockspring_times.json"),
            query_date=_CHRONOGOLF_DATE, party_size=1, expect_nonempty=True,
        )
        assert r.healthy is True
        assert r.entries > 0

    def test_real_verified_empty_array_is_healthy_not_drift(self):
        """Documented in chronogolf.py's "EMPTY-ARRAY DECISION": a bare `[]`
        IS a real verified-empty day for this engine — never drift."""
        r = check_shape("chronogolf", b"[]", query_date=_CHRONOGOLF_DATE, party_size=1)
        assert r.healthy is True
        assert r.entries == 0

    def test_wrapped_top_level_is_drift(self):
        wrapped = json.dumps({"teetimes": _CHRONOGOLF_RAW}).encode()
        r = check_shape("chronogolf", wrapped, query_date=_CHRONOGOLF_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason == "top-level-shape"

    def test_implausible_price_is_drift(self):
        mutated = copy.deepcopy(_CHRONOGOLF_RAW)
        mutated[_CHRONOGOLF_BOOKABLE_IDX]["green_fees"][0]["green_fee"] = 99999
        r = check_shape("chronogolf", json.dumps(mutated).encode(), query_date=_CHRONOGOLF_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason.startswith("implausible:")
        assert "price_usd" in r.reason


# ── clubprophet ──────────────────────────────────────────────────────────────

_CLUBPROPHET_RAW = _json("clubprophet_harborlinks_times.json")
_CLUBPROPHET_DATE = _CLUBPROPHET_RAW["content"][0]["startTime"][:10]
_CLUBPROPHET_BOOKABLE_IDX = next(
    i for i, e in enumerate(_CLUBPROPHET_RAW["content"]) if e.get("maxPlayer") is not None
)


class TestClubProphetCanary:
    def test_good_fixture_is_healthy(self):
        r = check_shape(
            "clubprophet", _bytes("clubprophet_harborlinks_times.json"),
            query_date=_CLUBPROPHET_DATE, party_size=1, expect_nonempty=True,
        )
        assert r.healthy is True
        assert r.entries > 0

    def test_no_teetimes_message_is_healthy_real_empty(self):
        r = check_shape(
            "clubprophet", _bytes("clubprophet_harborlinks_empty.json"),
            query_date="2026-01-01", party_size=1, expect_nonempty=False,
        )
        assert r.healthy is True
        assert r.entries == 0

    def test_missing_content_key_is_drift(self):
        mutated = copy.deepcopy(_CLUBPROPHET_RAW)
        del mutated["content"]
        r = check_shape("clubprophet", json.dumps(mutated).encode(), query_date=_CLUBPROPHET_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason == "top-level-shape"

    def test_unexpected_message_key_is_drift(self):
        """An error/unknown messageKey must NOT be silently read as empty
        (clubprophet.py's "EMPTY / DRIFT DECISION")."""
        mutated = copy.deepcopy(_CLUBPROPHET_RAW)
        mutated["content"] = {"messageKey": "SOME_OTHER_MESSAGE"}
        r = check_shape("clubprophet", json.dumps(mutated).encode(), query_date=_CLUBPROPHET_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason == "top-level-shape"

    def test_implausible_max_player_is_drift(self):
        mutated = copy.deepcopy(_CLUBPROPHET_RAW)
        mutated["content"][_CLUBPROPHET_BOOKABLE_IDX]["maxPlayer"] = 999
        r = check_shape("clubprophet", json.dumps(mutated).encode(), query_date=_CLUBPROPHET_DATE, party_size=1)
        assert r.healthy is False
        assert r.reason.startswith("implausible:")


# ── quick18 ──────────────────────────────────────────────────────────────────

_QUICK18_TIMES_HTML = (_FIX / "quick18_searchmatrix_times.html").read_text()


class TestQuick18Canary:
    def test_good_fixture_is_healthy(self):
        r = check_shape(
            "quick18", _bytes("quick18_searchmatrix_times.html"),
            query_date="2026-01-01", party_size=1, expect_nonempty=True,
        )
        assert r.healthy is True
        assert r.entries > 0

    def test_real_empty_day_is_healthy(self):
        r = check_shape(
            "quick18", _bytes("quick18_searchmatrix_empty.html"),
            query_date="2026-01-01", party_size=1, expect_nonempty=False,
        )
        assert r.healthy is True
        assert r.entries == 0

    def test_missing_matrix_table_is_drift(self):
        """An anti-bot interstitial / redesign that drops the table element —
        quick18.py's own `saw_table` guard (`_parse_matrix` returns `None`)."""
        truncated = _QUICK18_TIMES_HTML.replace("matrixTable", "matrixTableRenamed")
        r = check_shape("quick18", truncated.encode(), query_date="2026-01-01", party_size=1, expect_nonempty=True)
        assert r.healthy is False
        assert r.reason == "top-level-shape"

    def test_non_html_garbage_body_is_drift(self):
        r = check_shape("quick18", b"<html><body>nope</body></html>", query_date="2026-01-01", party_size=1, expect_nonempty=True)
        assert r.healthy is False
        assert r.reason == "top-level-shape"
