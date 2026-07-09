"""
Private-club filter — excludes known-private clubs from tee-time routing
results BEFORE the MAX_COURSES cap (specs/teetime-s0-plan.md §2).

Matching is EXACT normalized-name equality (name or alias) — NEVER substring
or token-subset — with an optional `near` geo anchor and optional exact
provider ids. See ``backend/data/private_clubs.json`` for the JSON shape:

  {
    "clubs": [
      {
        "name": "Liberty National Golf Club",
        "aliases": ["Liberty National Golf Course", "Liberty National"],
        "ids": [],
        "near": {"lat": 40.7095, "lng": -74.0532, "radius_miles": 10}
      }
    ]
  }

- `name` (required): canonical full name.
- `aliases` (optional): known source variants — OSM often tags "… Golf
  Course" where Places says "… Golf Club".
- `ids` (optional): exact provider-namespaced ids (``gplaces-<placeId>``,
  ``way/<n>``) — zero-false-positive matches once an offender's id is known.
- `near` (optional but strongly recommended): geo anchor; when both the
  entry and the discovered course have coordinates, the name match only
  excludes within `radius_miles`.

False-positive risks & mitigations:
  - Same stripped name, different place ("Riverside Country Club" private in
    one state vs "Riverside Golf Course" public in another): mitigated by
    `near` — set it on every entry when known.
  - Suffix-folding collisions: only ONE trailing suffix is stripped, and only
    from the fixed generic set below — "Liberty National" never folds
    further to "Liberty".
  - False negatives (unlisted variants, e.g. "Liberty National GC"): accepted
    for S0 — "gc" is in the suffix set; other variants belong in `aliases`.
    A later per-course fact record (S1 CourseBookingCapability.is_private)
    supersedes this list.

Loading policy: parsed eagerly on first use, module-cached, path injectable
for tests. Raises on missing/malformed JSON — the file is checked into the
repo, so a broken edit must fail loudly rather than silently readmitting a
private club (fail-open here would be the silent-fake-data bug in a new
costume).
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PATH = Path(__file__).parent.parent.parent.parent / "data" / "private_clubs.json"

# Generic suffixes stripped (ONE, trailing only) during normalization. Order
# matters only in that longer/more-specific phrases are checked first so
# "golf club" doesn't get matched as a false partial of something else.
_GENERIC_SUFFIXES = (
    "golf club", "golf course", "golf links", "country club", "golf resort", "gc", "cc",
)

_WHITESPACE_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\s]")


@dataclass(frozen=True)
class NearAnchor:
    lat: float
    lng: float
    radius_miles: float


@dataclass(frozen=True)
class PrivateClubEntry:
    name: str
    aliases: tuple[str, ...] = ()
    ids: tuple[str, ...] = ()
    near: NearAnchor | None = None


def normalize(name: str) -> str:
    """NFKD-fold to ASCII, casefold, strip punctuation, collapse whitespace,
    then strip ONE trailing generic suffix from the fixed set. Exact-equality
    input only — callers must never treat this as a substring/token match."""
    folded = unicodedata.normalize("NFKD", name or "")
    ascii_only = "".join(ch for ch in folded if not unicodedata.combining(ch))
    stripped_punct = _PUNCT_RE.sub(" ", ascii_only.casefold())
    collapsed = _WHITESPACE_RE.sub(" ", stripped_punct).strip()
    for suffix in _GENERIC_SUFFIXES:
        if collapsed == suffix:
            return ""
        if collapsed.endswith(f" {suffix}"):
            return collapsed[: -(len(suffix) + 1)].strip()
    return collapsed


def _haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


_cache: dict[Path, tuple[PrivateClubEntry, ...]] = {}


def load_private_clubs(path: Path = DEFAULT_PATH) -> tuple[PrivateClubEntry, ...]:
    """Parse `path` into private-club entries. Module-cached per path.

    Raises (FileNotFoundError / JSONDecodeError / KeyError) on missing or
    malformed JSON — fail-loud, see module docstring."""
    if path in _cache:
        return _cache[path]

    raw = json.loads(path.read_text())
    clubs_raw = raw["clubs"]  # raises KeyError if the shape is wrong

    entries: list[PrivateClubEntry] = []
    for c in clubs_raw:
        near_raw = c.get("near")
        near = NearAnchor(
            lat=float(near_raw["lat"]),
            lng=float(near_raw["lng"]),
            radius_miles=float(near_raw["radius_miles"]),
        ) if near_raw else None
        entries.append(PrivateClubEntry(
            name=c["name"],
            aliases=tuple(c.get("aliases") or ()),
            ids=tuple(c.get("ids") or ()),
            near=near,
        ))

    result = tuple(entries)
    _cache[path] = result
    return result


def is_private(course: dict, clubs: tuple[PrivateClubEntry, ...] | None = None) -> bool:
    """True iff `course` matches a private-club entry.

    1. course["id"]/course["osm_id"] is in any entry's `ids`, OR
    2. normalize(course["name"]) equals normalize(entry.name) or any
       normalize(alias), AND (if the entry has `near` and the course has a
       center) haversine(course.center, entry.near) <= radius_miles. Entries
       without `near`, or courses without a center, match on name alone.
       Exact equality only — never substring/token-subset matching.
    """
    clubs = clubs if clubs is not None else load_private_clubs()

    course_id = str(course.get("id") or course.get("osm_id") or "")
    course_name = normalize(course.get("name") or "")
    center = course.get("center") or {}
    has_center = center.get("lat") is not None and center.get("lng") is not None

    for entry in clubs:
        if course_id and course_id in entry.ids:
            return True

        if not course_name:
            continue
        entry_names = {normalize(entry.name)} | {normalize(a) for a in entry.aliases}
        if course_name not in entry_names:
            continue

        if entry.near is not None and has_center:
            dist = _haversine_miles(
                center["lat"], center["lng"], entry.near.lat, entry.near.lng
            )
            if dist <= entry.near.radius_miles:
                return True
            continue  # same normalized name, outside the anchor radius — not a match

        return True  # no `near` on the entry, or no center on the course — name alone matches

    return False


def exclude_private(
    courses: list[dict], clubs: tuple[PrivateClubEntry, ...] | None = None
) -> list[dict]:
    """Return `courses` with every private-club match removed."""
    clubs = clubs if clubs is not None else load_private_clubs()
    return [c for c in courses if not is_private(c, clubs)]
