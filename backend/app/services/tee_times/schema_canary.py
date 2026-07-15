"""
Schema-drift canary — S4f coverage flywheel (specs/teetime-s4f-coverage
-flywheel-plan.md §4, parent plan specs/teetime-availability-everywhere-plan.md
§9 "no live hits in CI, ever").

Pure, network-free drift detector: given a RAW response BODY already
captured (by `coverage_flywheel.py canary`, or a checked-in test fixture),
decide whether that shape still matches what the live adapter expects.
Reuses each adapter's OWN parse layer — `_normalize_day` (foreup, teeitup,
chronogolf, clubprophet) or `_parse_matrix` (quick18) — NEVER duplicates
parsing logic. This module makes zero network calls and is safe to run in
CI on every commit against the checked-in fixtures.

"Drift" is precisely any of, checked IN ORDER (plan §4a):

  1. Top-level shape guard — transcribed from each adapter's own `_do_fetch`
     guard (the exact condition that makes the LIVE adapter degrade to
     `None`, "couldn't check"):
       - foreup:      body not a JSON list.
       - teeitup:     body not a JSON list, OR an EMPTY list (teeitup.py
                       `_do_fetch` line ~407 treats a zero-length top-level
                       array as drift, NOT an empty day — a queried facility
                       always returns at least one `dayInfo`-wrapped record).
       - chronogolf:  body not a JSON list (an EMPTY list IS a real verified-
                       empty day for chronogolf — see chronogolf.py's
                       "EMPTY-ARRAY DECISION" docstring — so it is NOT drift).
       - clubprophet: body not a JSON object with a "content" key; `content`
                       is neither a list NOR an object with
                       `messageKey == "NO_TEETIMES"` (clubprophet.py's
                       "EMPTY / DRIFT DECISION").
       - quick18:     `_parse_matrix` returns `None` (the `matrixTable`
                       element is absent — parse raised, or `saw_table` is
                       false: an anti-bot interstitial or a redesign, per
                       quick18.py's "EMPTY / DRIFT DECISION").
  2. Plausibility pass over the normalized day dicts each adapter's own
     parser produced: `time` parses as "%H:%M"; players (or quick18's
     `max_players`) is an int in 1..8; `price_usd` is `None` or a value with
     `0 < price_usd < 2000`; `holes` is 9 or 18. Any violation -> drift, with
     the offending field named in `reason`.
  3. `expect_nonempty=True` (fixture/canary mode against a capture that is
     KNOWN to be non-empty): zero normalized entries -> drift. This is what
     catches a silently renamed key that a skip-tolerant `_normalize_day`
     just drops (e.g. `teetimes` -> `teeTimes` yields 0 entries, not an
     exception) — a check_shape(expect_nonempty=False) call would otherwise
     see a "healthy, 0 entries" result and miss the drift entirely.

`query_date` is supplied by the caller and, in tests, is DERIVED from the
fixture (never hardcoded against a live clock) — same pattern
`test_tee_time_teeitup.py` / `test_tee_time_foreup.py` / etc. already use.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime

from .adapters.chronogolf import _normalize_day as _chronogolf_normalize_day
from .adapters.clubprophet import _normalize_day as _clubprophet_normalize_day
from .adapters.quick18 import _parse_matrix as _quick18_parse_matrix
from .adapters.teeitup import _normalize_day as _teeitup_normalize_day
from .foreup import _normalize_day as _foreup_normalize_day

# Mirrors clubprophet.py's `_NO_TEETIMES_MESSAGE_KEY` — a literal, not parse
# logic, so duplicating the constant here (rather than importing a private
# name across an unrelated concern) keeps this module's only coupling to
# clubprophet.py the actual parse function.
_NO_TEETIMES_MESSAGE_KEY = "NO_TEETIMES"

_PLATFORMS = ("foreup", "teeitup", "chronogolf", "clubprophet", "quick18")


@dataclass(frozen=True)
class CanaryResult:
    platform: str
    healthy: bool
    reason: str          # "" | "non-json" | "top-level-shape" | "no-entries" | "implausible: ..."
    entries: int          # normalized day-dicts observed


def _entry_players(d: dict) -> object:
    """`players` for every adapter's normalized day dict, except quick18
    (whose dict carries `min_players`/`max_players` — the real remaining-
    capacity ceiling is `max_players`, same field quick18.py itself reports
    as `TeeTimeSlot.players`)."""
    if "players" in d:
        return d["players"]
    return d.get("max_players")


def _plausible(entries: list[dict]) -> str | None:
    """The offending-field reason string, or `None` when every entry passes
    (plan §4a rule 2 — "plausible ranges")."""
    for d in entries:
        t = d.get("time")
        try:
            datetime.strptime(t, "%H:%M")
        except (ValueError, TypeError):
            return f"implausible: time={t!r}"

        players = _entry_players(d)
        if not isinstance(players, int) or isinstance(players, bool) or not (1 <= players <= 8):
            return f"implausible: players={players!r}"

        price = d.get("price_usd")
        if price is not None and not (isinstance(price, (int, float)) and 0 < price < 2000):
            return f"implausible: price_usd={price!r}"

        holes = d.get("holes")
        if holes not in (9, 18):
            return f"implausible: holes={holes!r}"
    return None


def _json_shape_entries(
    platform: str, data: object, *, query_date: str, party_size: int
) -> tuple[list[dict] | None, str | None]:
    """Rule 1 (top-level shape guard) for the JSON-bodied platforms, then the
    adapter's own `_normalize_day`. Returns `(entries, None)` on a shape that
    matches the live adapter's expectation, or `(None, reason)` on drift."""
    if platform == "foreup":
        if not isinstance(data, list):
            return None, "top-level-shape"
        return _foreup_normalize_day(data, query_date=query_date, party_size=party_size), None

    if platform == "teeitup":
        if not isinstance(data, list) or len(data) == 0:
            return None, "top-level-shape"
        return _teeitup_normalize_day(data, query_date=query_date, party_size=party_size), None

    if platform == "chronogolf":
        if not isinstance(data, list):
            return None, "top-level-shape"
        return _chronogolf_normalize_day(data, query_date=query_date, party_size=party_size), None

    if platform == "clubprophet":
        if not isinstance(data, dict) or "content" not in data:
            return None, "top-level-shape"
        content = data["content"]
        if isinstance(content, list):
            return _clubprophet_normalize_day(content, query_date=query_date, party_size=party_size), None
        if isinstance(content, dict) and content.get("messageKey") == _NO_TEETIMES_MESSAGE_KEY:
            return [], None   # real verified-empty day — not drift.
        return None, "top-level-shape"

    raise ValueError(f"schema_canary: unknown platform {platform!r}")


def _quick18_shape_entries(raw_body: bytes) -> tuple[list[dict] | None, str | None]:
    html_text = raw_body.decode("utf-8", errors="replace")
    parsed = _quick18_parse_matrix(html_text)
    if parsed is None:
        return None, "top-level-shape"
    return parsed, None


def check_shape(
    platform: str,
    raw_body: bytes,
    *,
    query_date: str,
    party_size: int = 1,
    expect_nonempty: bool = False,
) -> CanaryResult:
    """Pure, network-free drift check (module docstring). `raw_body` is
    exactly what the live HTTP response body would be — a checked-in fixture
    read as bytes, or a capture handed in by `coverage_flywheel.py canary`."""
    if platform == "quick18":
        entries, reason = _quick18_shape_entries(raw_body)
    else:
        try:
            data = json.loads(raw_body)
        except Exception:
            return CanaryResult(platform=platform, healthy=False, reason="non-json", entries=0)
        entries, reason = _json_shape_entries(
            platform, data, query_date=query_date, party_size=party_size
        )

    if reason is not None:
        return CanaryResult(platform=platform, healthy=False, reason=reason, entries=0)

    assert entries is not None  # reason is None iff entries was produced
    bad = _plausible(entries)
    if bad is not None:
        return CanaryResult(platform=platform, healthy=False, reason=bad, entries=len(entries))

    if expect_nonempty and len(entries) == 0:
        return CanaryResult(platform=platform, healthy=False, reason="no-entries", entries=0)

    return CanaryResult(platform=platform, healthy=True, reason="", entries=len(entries))
