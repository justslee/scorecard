"""Shared course-finding helpers (Google Places + Mapbox + name de-dupe).

Extracted from routes/course_search.py so other services (e.g. the tee-time
AffiliateLinkProvider) can find real courses WITHOUT HTTP-calling our own API.
The route module keeps thin aliases to these functions, so its behavior and
its tests are unchanged.
"""

from __future__ import annotations

import logging
import math
import os
import re
import unicodedata
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)

MAPBOX_TOKEN = os.getenv("NEXT_PUBLIC_MAPBOX_TOKEN", os.getenv("MAPBOX_TOKEN", ""))
# Server-side Google Places key (NOT the iOS-SDK bundle-restricted key — that
# won't work for the Places web service). Set GOOGLE_PLACES_API_KEY in the backend
# env / Secrets Manager to a key with the "Places API (New)" enabled.
GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")


# ── Relevance gate + ranking (pure, unit-tested) ──────────────────────────────
# Generic golf words dropped from the QUERY before matching so "bethpage black
# golf course" behaves like "bethpage black". Mirrors osm._OSM_STOPWORDS plus
# "country" (as in "country club"). Name tokens keep their stopwords so an
# all-stopword query ("golf club") can still match "The Golf Club at ...".
QUERY_STOPWORDS: frozenset[str] = frozenset(
    {"golf", "course", "club", "links", "country", "cc", "gc", "the", "at", "and"}
)

# Sources whose rows come from OUR database (mapped/local courses) — ranked
# above external (osm / google_places) hits within the same relevance tier.
LOCAL_SOURCES: frozenset[str] = frozenset({"mapped", "local"})


def _fold(text: str) -> str:
    """Lowercase + strip accents (NFKD) + drop apostrophes.

    Apostrophes are removed rather than split so "St Andrew's" folds to
    "st andrews" and the query "andrews" still prefix-matches."""
    text = text.replace("'", "").replace("’", "")
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower()


def name_tokens(name: str) -> list[str]:
    """ALL alphanumeric tokens of a course name, folded (stopwords kept)."""
    return re.findall(r"[a-z0-9]+", _fold(name))


def significant_tokens(text: str) -> list[str]:
    """Folded tokens minus golf stopwords; falls back to ALL tokens when the
    text is only stopwords (so "golf club" is still a usable query)."""
    tokens = name_tokens(text)
    significant = [t for t in tokens if t not in QUERY_STOPWORDS]
    return significant or tokens


def normalize_query(q: str) -> str:
    """Normalized cache key / comparison form of a search query.

    "Bethpage  Golf Course" and "bethpage" normalize identically — under the
    prefix gate they are equivalent queries, so they can share a cache entry.
    Sorted (not just joined) so word order doesn't fragment the cache either —
    "black bethpage" and "bethpage black" are the same query under the gate
    (which is order-independent), so they should be the same cache entry."""
    return " ".join(sorted(significant_tokens(q)))


def matches_query_prefix(name: str, q: str) -> bool:
    """Relevance gate: EVERY significant query token must prefix-match some
    token of the course name (case/punctuation/accent-insensitive).

    "bethpa" → "Bethpage Black Course" ✓, "Bethel Island" ✗.
    "bethpage black" → "Bethpage Black" ✓, "Bethpage Red" ✗.
    Applied to ALL /api/courses/search results regardless of source, so
    geocoder towns and unrelated nearby courses can never be emitted."""
    q_tokens = significant_tokens(q)
    if not q_tokens:
        return False
    n_tokens = name_tokens(name)
    return all(any(nt.startswith(qt) for nt in n_tokens) for qt in q_tokens)


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in meters (mirrors shots._haversine_yards)."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def rank_courses(
    courses: list[dict], q: str, anchor: dict | None = None
) -> list[dict]:
    """Tiered, stable ranking of relevance-gated results.

    Tiers (best first): exact normalized-name match > all-token prefix match >
    local/mapped source > distance to *anchor* (when one exists) > alpha.
    ``sorted`` is stable, so input order is preserved within equal keys."""
    q_sig = sorted(significant_tokens(q))

    def key(c: dict) -> tuple:
        name = c.get("name") or ""
        exact = 0 if sorted(significant_tokens(name)) == q_sig else 1
        prefix = 0 if matches_query_prefix(name, q) else 1
        local = 0 if c.get("source") in LOCAL_SOURCES else 1
        center = c.get("center") or {}
        if anchor and center.get("lat") is not None and center.get("lng") is not None:
            dist = _haversine_m(anchor["lat"], anchor["lng"], center["lat"], center["lng"])
        else:
            dist = math.inf
        return (exact, prefix, local, dist, _fold(name))

    return sorted(courses, key=key)


# ── Write-through identity (deterministic UUIDs, pure) ────────────────────────

def deterministic_course_id(key: str) -> str:
    """Stable UUID for an external course hit — the osm_ingest convention
    (SHA-1 of "golfapi:{key}"), so a later richer ingest of the same course
    lands on the SAME courses row with no migration."""
    from app.services.osm_ingest import _deterministic_uuid  # pure, no DB

    return _deterministic_uuid(key)


def external_course_key(course: dict) -> str | None:
    """Stable source key for an external hit: "osm-way/123" for OSM results
    (which carry osm_id, not id), else the provider-namespaced id
    ("gplaces-..."). None when the hit has no usable identity."""
    osm_id = course.get("osm_id")
    if osm_id:
        return f"osm-{osm_id}"
    cid = course.get("id")
    if cid:
        return str(cid)
    return None


def attach_stable_ids(courses: list[dict]) -> list[dict]:
    """Give id-less hits (OSM) the deterministic UUID of their source key so
    the wire id matches the write-through courses row. Provider-namespaced ids
    (gplaces-...) are left as-is; osm_id is preserved either way, so
    external_course_key stays stable after this mutation."""
    for c in courses:
        if not c.get("id"):
            key = external_course_key(c)
            if key:
                c["id"] = deterministic_course_id(key)
    return courses


def external_course_rows(hits: list[dict]) -> list[dict]:
    """Pure mapping of external search hits → courses-table write-through rows
    (id, name, address, lat, lng). Deterministic: the same hit always produces
    the same row id, which is what makes ON CONFLICT DO NOTHING idempotent.
    Hits without a name, center, or stable key are skipped."""
    rows: list[dict] = []
    for c in hits:
        key = external_course_key(c)
        center = c.get("center") or {}
        name = (c.get("name") or "").strip()
        if not key or not name:
            continue
        if center.get("lat") is None or center.get("lng") is None:
            continue
        rows.append({
            "id": deterministic_course_id(key),
            "name": name,
            "address": c.get("address"),
            "lat": center["lat"],
            "lng": center["lng"],
        })
    return rows


async def search_google_places(
    query: str, *, api_key: str | None = None, timeout_s: float = 8.0,
    raise_on_error: bool = False,
) -> list[dict]:
    """Robust text search for a golf course by name via Google Places API (New).

    "Bethpage Black" → "Bethpage Black Course" with a precise location, which the
    fragile OSM name-match + Mapbox geocoding chain misses. No-op (returns []) when
    the key is absent, so search still works without it.

    ``api_key`` overrides the module-level key (the route passes its own global
    so tests can monkeypatch it there).

    Any HTTP failure or non-success status is logged at WARNING (with the HTTP
    status when available) so a misconfigured/disabled key doesn't fail
    silently — course-search-v2 diagnosis: this used to swallow errors with NO
    logging, so a prod 403 SERVICE_DISABLED was invisible.

    ``raise_on_error``: when True, re-raises instead of swallowing after
    logging, so a caller with its own leg-health/observability wrapper (see
    routes/course_search.py `_run_leg`) can distinguish "error" from a genuine
    empty match. Defaults to False so existing callers (this module's own
    default behavior, tee_times/affiliate.py) are unaffected."""
    key = api_key if api_key is not None else GOOGLE_PLACES_API_KEY
    if not key:
        return []
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": (
            "places.id,places.displayName,places.formattedAddress,"
            "places.location,places.websiteUri,places.rating"
        ),
    }
    body = {"textQuery": query, "includedType": "golf_course", "maxResultCount": 10}
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        try:
            resp = await client.post(url, headers=headers, json=body)
            if not resp.is_success:
                log.warning(
                    "search_google_places: HTTP %d for query=%r body=%s",
                    resp.status_code, query, resp.text[:300],
                )
                if raise_on_error:
                    raise RuntimeError(f"google places status={resp.status_code}")
                return []
            data = resp.json()
            out: list[dict] = []
            for p in data.get("places", []):
                loc = p.get("location") or {}
                lat, lng = loc.get("latitude"), loc.get("longitude")
                if lat is None or lng is None:
                    continue
                out.append({
                    "id": f"gplaces-{p.get('id')}",
                    "name": (p.get("displayName") or {}).get("text") or query,
                    "address": p.get("formattedAddress"),
                    "center": {"lat": lat, "lng": lng},
                    "website": p.get("websiteUri"),
                    "rating": p.get("rating"),
                    "source": "google_places",
                })
            return out
        except Exception:
            if raise_on_error:
                raise
            log.warning("search_google_places: request failed for query=%r", query, exc_info=True)
            return []


def dedupe_by_name(courses: list[dict]) -> list[dict]:
    """First occurrence of each course name wins. Callers list geometry-rich OSM
    results before location-only ones, so geometry wins on a name tie."""
    seen: set[str] = set()
    out: list[dict] = []
    for c in courses:
        key = (c.get("name") or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def mapbox_geocode_url(query: str) -> str:
    """Build the Mapbox geocoding URL for a user query.

    Mapbox puts the search term in the URL PATH, so the query must be encoded —
    `quote(safe="")` escapes "/", "?", "#", "." etc. so a query like "foo/bar"
    or "../x" can't manipulate the request path (path-injection guard)."""
    return f"https://api.mapbox.com/geocoding/v5/mapbox.places/{quote(query, safe='')}.json"


async def search_mapbox(
    query: str, *, token: str | None = None, timeout_s: float = 8.0
) -> list[dict]:
    """Search Mapbox for places (fallback when OSM has no results)."""
    tok = token if token is not None else MAPBOX_TOKEN
    if not tok:
        return []
    url = mapbox_geocode_url(query)
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        try:
            resp = await client.get(url, params={"limit": 10, "access_token": tok})
            if not resp.is_success:
                return []
            data = resp.json()
            return [
                {
                    "id": f"mapbox-{f['id']}",
                    "name": f.get("text") or f.get("place_name", "").split(",")[0] or query,
                    "address": f.get("place_name"),
                    "center": {"lat": f["center"][1], "lng": f["center"][0]},
                    "source": "mapbox",
                }
                for f in data.get("features", [])
            ]
        except Exception:
            return []
