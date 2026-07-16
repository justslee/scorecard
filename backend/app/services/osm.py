"""OpenStreetMap Overpass API service for golf course features."""

import asyncio
import logging
import math
import re
from typing import Optional

import httpx

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

_USER_AGENT = "Looper/1.0 (golf course mapping)"
_log = logging.getLogger(__name__)

# HTTP status codes that indicate a transient Overpass failure and warrant one retry.
# 429 = rate-limited, 5xx = server-side errors (the public endpoint intermittently
# returns 504 under load — a single retry avoids a confusing "0 holes" ingest).
_TRANSIENT_STATUS_CODES: frozenset[int] = frozenset({429, 500, 502, 503, 504})

# Back-off between the first attempt and the single retry (seconds).
_RETRY_BACKOFF_S: float = 2.0

# All Overpass requests include a User-Agent; the public endpoint returns 406 without one.
_OVERPASS_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": _USER_AGENT,
}


# ── Overpass HTTP helper (retry + logging) ────────────────────────────────────

async def _post_with_retry(
    client: httpx.AsyncClient,
    query: str,
    log_tag: str = "Overpass",
    *,
    max_attempts: int = 2,
    backoff_s: float = _RETRY_BACKOFF_S,
) -> Optional[dict]:
    """POST *query* to the Overpass interpreter with one retry on transient failures.

    Transient failures (HTTP 429 / 5xx, or ``httpx`` timeout / transport errors)
    are retried once after *backoff_s* seconds (default :data:`_RETRY_BACKOFF_S`).
    Non-transient HTTP errors (any 4xx other than 429) are logged and returned
    immediately as ``None`` without a retry.  A clean 200 response with an empty
    ``"elements"`` list is **never** retried — that is a real "no data" result,
    not a fault.

    Args:
        client: An open ``httpx.AsyncClient`` (caller controls timeout).
        query: Raw Overpass QL query string.
        log_tag: Label prepended to log messages (use the calling function's name
            so the source is visible in the log stream).
        max_attempts: Total attempts including the first (default 2 = one retry).
            The interactive search path passes 1 to skip the retry entirely and
            stay inside its tight latency budget.
        backoff_s: Seconds to sleep before the retry. The interactive search path
            passes a shorter value (0.5s) than the ingest-path default (2s).

    Returns:
        Parsed JSON ``dict`` on success, or ``None`` after a persistent failure.
        Callers should treat ``None`` as an empty/error result and log or surface
        accordingly — this function never raises.
    """
    for attempt in range(max_attempts):
        try:
            resp = await client.post(
                OVERPASS_URL,
                data={"data": query},
                headers=_OVERPASS_HEADERS,
            )
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            _log.warning(
                "%s request error (attempt %d/%d) url=%s exc=%r",
                log_tag, attempt + 1, max_attempts, OVERPASS_URL, exc,
            )
            if attempt < max_attempts - 1:
                await asyncio.sleep(backoff_s)
                continue
            return None

        if resp.is_success:
            return resp.json()

        body = resp.text[:200].strip()
        if resp.status_code in _TRANSIENT_STATUS_CODES:
            _log.warning(
                "%s transient HTTP %d (attempt %d/%d) url=%s body=%r",
                log_tag, resp.status_code, attempt + 1, max_attempts, OVERPASS_URL, body,
            )
            if attempt < max_attempts - 1:
                await asyncio.sleep(backoff_s)
                continue
            return None

        # Non-transient HTTP error (e.g. 400 Bad Request, 406 No User-Agent).
        _log.warning(
            "%s non-retryable HTTP %d url=%s body=%r",
            log_tag, resp.status_code, OVERPASS_URL, body,
        )
        return None

    return None  # exhausted both attempts (should be unreachable)


# ── Pure geometry parsers (unit-testable, no I/O) ─────────────────────────────

def _parse_way_to_polygon(geom: list[dict]) -> Optional[dict]:
    """Convert Overpass way geometry (list of ``{lat, lon}``) to a GeoJSON Polygon.

    Returns ``None`` if the geometry has fewer than 4 points (degenerate ring).
    Closes the ring automatically if the first and last coordinate pair differ.
    """
    if len(geom) < 4:
        return None
    ring: list[list[float]] = [[p["lon"], p["lat"]] for p in geom]
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def _parse_way_to_linestring(geom: list[dict]) -> Optional[dict]:
    """Convert Overpass way geometry (list of ``{lat, lon}``) to a GeoJSON LineString.

    Returns ``None`` if fewer than 2 points are present.
    """
    if len(geom) < 2:
        return None
    coords: list[list[float]] = [[p["lon"], p["lat"]] for p in geom]
    return {"type": "LineString", "coordinates": coords}


def _parse_relation_to_multipolygon(el: dict) -> Optional[dict]:
    """Convert an Overpass ``relation`` element's ``role: "outer"`` members into
    a GeoJSON MultiPolygon — one member ring per polygon.

    Same outer-only pattern as :func:`_parse_boundary_geometry`'s relation
    branch (inner rings/holes-in-the-polygon are intentionally ignored; a
    waste-bunker complex's grass island doesn't need modelling for carry
    purposes, matching that existing convention). Extracted as its own
    function (rather than only inline in ``_parse_boundary_geometry``) so
    ``_parse_course_geometry_response`` can reuse it for ``golf=bunker`` /
    ``natural=sand`` relations (specs/map-fieldtest-v119-plan.md Item 2 —
    the ingest query previously only asked for ``way["golf"="bunker"]``, so
    a waste complex mapped as a multipolygon relation was invisible).

    Returns ``None`` if the relation has no usable outer-ring geometry.
    """
    outers = [
        m for m in el.get("members", [])
        if m.get("role") == "outer" and m.get("geometry")
    ]
    polys: list[list[list[list[float]]]] = []
    for m in outers:
        ring = [[p["lon"], p["lat"]] for p in m["geometry"]]
        if len(ring) < 4:
            continue
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        polys.append([ring])
    if not polys:
        return None
    return {"type": "MultiPolygon", "coordinates": polys}


def _parse_course_geometry_response(
    data: dict,
    course_name_filter: Optional[str] = None,
) -> dict:
    """Parse a raw Overpass JSON response into categorized GeoJSON Feature lists.

    This is a pure function (no I/O) and the unit-test target for I0.

    Args:
        data: Raw JSON dict from Overpass (expected to have an ``"elements"`` list).
        course_name_filter: If given, only ``golf=hole`` ways whose
            ``golf:course:name`` tag matches this value (case-insensitive) are
            included.  All other feature types (green, fairway, tee, bunker,
            water, rough, woods, trees) are always included regardless of this
            filter — terrain features are unlabeled by course and are assigned
            to the nearest hole by the spatial join.

    Returns:
        Dict with keys: ``holes``, ``greens``, ``fairways``, ``tees``,
        ``bunkers``, ``water``, ``rough``, ``woods``, ``trees``.
        Each value is a list of GeoJSON Feature dicts::

            {
                "type": "Feature",
                "geometry": <GeoJSON LineString | Polygon | Point>,
                "properties": {
                    "featureType": "<type>",
                    "osm_id": "way/<id>" | "node/<id>",
                    # holes also carry: ref, par, handicap, name
                },
            }

        Terrain feature types added for fuller map rendering:
        - ``"rough"``  — ``golf=rough`` polygon ways
        - ``"woods"``  — ``natural=wood``, ``landuse=forest``, ``natural=scrub``,
          or closed ``natural=tree_row`` ways (open tree_row linestrings skipped)
        - ``"tree"``   — individual ``natural=tree`` node points (Point geometry)
    """
    holes: list[dict] = []
    greens: list[dict] = []
    fairways: list[dict] = []
    tees: list[dict] = []
    bunkers: list[dict] = []
    water: list[dict] = []
    rough: list[dict] = []
    woods: list[dict] = []
    trees: list[dict] = []

    name_lower = course_name_filter.lower() if course_name_filter else None

    for el in data.get("elements", []):
        el_type = el.get("type")
        tags = el.get("tags", {})

        # ── Individual tree nodes → Point features ────────────────────────────
        if el_type == "node":
            if tags.get("natural") == "tree":
                trees.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [el["lon"], el["lat"]],
                    },
                    "properties": {
                        "featureType": "tree",
                        "osm_id": f"node/{el['id']}",
                    },
                })
            continue

        # ── Bunker/waste-complex relations → MultiPolygon (v1.1.9 Item 2) ──────
        # The only relations this query requests are golf=bunker and
        # natural=sand (both queried as `relation[...]` in fetch_course_geometry)
        # — a multipolygon-mapped waste bunker complex, invisible to the
        # way-only query this replaced. A waste/sand area is a bunker for
        # carry purposes, so it lands in the same `bunkers` bucket as an
        # ordinary way bunker — one feature, one MultiPolygon geometry (both
        # geometry consumers — tee-shot-overlays.ts, hazards.py — accept
        # MultiPolygon, mirroring the existing fairway MultiPolygon handling).
        if el_type == "relation":
            if tags.get("golf") == "bunker" or tags.get("natural") == "sand":
                multipolygon = _parse_relation_to_multipolygon(el)
                if multipolygon is not None:
                    bunkers.append({
                        "type": "Feature",
                        "geometry": multipolygon,
                        "properties": {
                            "featureType": "bunker",
                            "osm_id": f"relation/{el['id']}",
                        },
                    })
            continue

        if el_type != "way":
            continue

        geom = el.get("geometry", [])
        golf_tag = tags.get("golf", "")
        natural_tag = tags.get("natural", "")
        landuse_tag = tags.get("landuse", "")
        osm_id = f"way/{el['id']}"

        if golf_tag == "hole":
            # Apply course-name filter for multi-course facilities (e.g. Bethpage Black).
            # Only hole ways are filtered — terrain features (rough/woods/trees) are
            # unlabeled by course and are assigned via the spatial join.
            if name_lower is not None:
                el_course_name = tags.get("golf:course:name", "")
                if el_course_name.lower() != name_lower:
                    continue

            linestring = _parse_way_to_linestring(geom)
            if linestring is None:
                continue

            par_str = tags.get("par", "")
            hcp_str = tags.get("handicap", "")
            holes.append({
                "type": "Feature",
                "geometry": linestring,
                "properties": {
                    "featureType": "hole",
                    "osm_id": osm_id,
                    "ref": tags.get("ref"),
                    "par": int(par_str) if par_str.isdigit() else None,
                    "handicap": int(hcp_str) if hcp_str.isdigit() else None,
                    "name": tags.get("name"),
                    # Carry the OSM course name so the spatial join can do
                    # cross-course rejection without re-fetching.
                    "course_name": tags.get("golf:course:name"),
                },
            })

        elif (
            golf_tag in ("green", "fairway", "tee", "bunker", "water_hazard", "lateral_water_hazard")
            or natural_tag in ("water", "sand")
        ):
            polygon = _parse_way_to_polygon(geom)
            if polygon is None:
                continue

            if golf_tag == "green":
                feature_type = "green"
                bucket = greens
            elif golf_tag == "fairway":
                feature_type = "fairway"
                bucket = fairways
            elif golf_tag == "tee":
                feature_type = "tee"
                bucket = tees
            elif golf_tag == "bunker" or natural_tag == "sand":
                # natural=sand (a waste bunker) is a bunker for carry
                # purposes — same bucket as golf=bunker (v1.1.9 Item 2).
                feature_type = "bunker"
                bucket = bunkers
            else:  # water_hazard, lateral_water_hazard, natural=water
                feature_type = "water"
                bucket = water

            properties: dict = {
                "featureType": feature_type,
                "osm_id": osm_id,
            }
            if feature_type == "tee":
                # Preserve the tee-box's OSM ref/name tags (e.g. golf:name /
                # ref = "White") so the frontend's named-tee-box match
                # (lib/course/tee-anchor.ts resolveTeeAnchor) can anchor
                # "from the tee" geometry to the player's actual selected tee
                # instead of an arbitrary box (spec:
                # multi-tee-anchor-reconciliation). Additive — no shape
                # change for existing rows without these tags.
                ref = tags.get("ref") or tags.get("golf:name")
                name = tags.get("name")
                if ref:
                    properties["ref"] = ref
                if name:
                    properties["name"] = name
            bucket.append({
                "type": "Feature",
                "geometry": polygon,
                "properties": properties,
            })

        elif golf_tag == "rough":
            # golf=rough → outer rough grass corridor around the fairway
            polygon = _parse_way_to_polygon(geom)
            if polygon is None:
                continue
            rough.append({
                "type": "Feature",
                "geometry": polygon,
                "properties": {"featureType": "rough", "osm_id": osm_id},
            })

        elif (
            natural_tag in ("wood", "scrub")
            or landuse_tag == "forest"
            or natural_tag == "tree_row"
        ):
            # Woods, forest, scrub, and closed tree_row ways → woods polygon.
            # Open tree_row linestrings are skipped (< 4 pts → _parse_way_to_polygon
            # returns None), keeping only closed polygon-shaped tree rows.
            polygon = _parse_way_to_polygon(geom)
            if polygon is None:
                continue
            woods.append({
                "type": "Feature",
                "geometry": polygon,
                "properties": {"featureType": "woods", "osm_id": osm_id},
            })

    return {
        "holes": holes,
        "greens": greens,
        "fairways": fairways,
        "tees": tees,
        "bunkers": bunkers,
        "water": water,
        "rough": rough,
        "woods": woods,
        "trees": trees,
    }


# Generic golf words dropped from a name query so the remaining significant words
# drive the match (order-independent, qualifier-tolerant).
_OSM_STOPWORDS = {"golf", "course", "club", "links", "cc", "gc", "the", "at", "and", "&", "-"}


def osm_name_filter(name: str) -> str:
    """Build the Overpass `["name"~...]` filter(s) for a course-name query.

    Matches ALL significant words (any order) so "bethpage black golf course"
    matches OSM's "Bethpage Black" and "pebble golf" matches "Pebble Beach Golf
    Links". Chained `["name"~w,i]` filters are ANDed by Overpass. Falls back to the
    raw phrase when the query is only stopwords. Strips quotes/backslashes to keep
    the Overpass regex safe.
    """
    def _safe(s: str) -> str:
        return re.sub(r'["\'\\]', "", s)

    words = [_safe(w) for w in name.split()]
    significant = [w for w in words if w and w.lower() not in _OSM_STOPWORDS]
    if significant:
        return "".join(f'["name"~"{w}",i]' for w in significant)
    phrase = _safe(name).strip()
    return f'["name"~"{phrase}",i]' if phrase else ""


# ── Distance sort (pure, no I/O) ───────────────────────────────────────────────

# Result caps for the two Overpass-backed search functions below. Named so the
# cap is self-explanatory wherever it's referenced (prod code and tests alike).
_MAX_COURSE_RESULTS = 15  # search_golf_courses: name/nearby course search
_MAX_GEOMETRY_RESULTS = 25  # search_osm_with_geometry: boundary-search results


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in meters (mirrors course_finder._haversine_m)."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _sort_by_distance(results: list[dict], lat: float, lng: float) -> list[dict]:
    """Sort *results* by distance from ``(lat, lng)``, nearest first (pure, no I/O).

    Key is ``(haversine_m(lat, lng, center), name)`` — the name tie-break gives
    deterministic ordering for exact-distance ties, matching routing.py's
    ``(distance_miles, course_name)`` convention. A result with a missing/None
    ``center`` lat or lng sorts last (``math.inf``) instead of raising. Python's
    sort is stable, so ties beyond the key fall back to original Overpass order.
    """
    def _key(r: dict) -> tuple[float, str]:
        center = r.get("center") or {}
        clat, clng = center.get("lat"), center.get("lng")
        if clat is None or clng is None:
            dist = math.inf
        else:
            dist = _haversine_m(lat, lng, clat, clng)
        return (dist, r.get("name", ""))

    return sorted(results, key=_key)


# ── HTTP fetch functions ───────────────────────────────────────────────────────

async def search_golf_courses(
    name: Optional[str] = None,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    radius_m: int = 10000,
    *,
    interactive: bool = False,
) -> list[dict]:
    """Search OSM for golf courses by name and/or location.

    ``interactive=True`` (the live-search path, ``routes/course_search.py``)
    uses a tight latency budget so a single slow request can't stall the UI:
    ``[timeout:4]`` server-side, 5s client timeout, at most ONE retry with a
    short 0.5s backoff (vs. the 2s ingest-path backoff). Non-interactive
    callers (course ingest) keep the generous defaults.
    """
    around = ""
    if lat is not None and lng is not None:
        around = f"(around:{radius_m},{lat},{lng})"

    name_filter = osm_name_filter(name) if name else ""

    if not name_filter and not around:
        return []

    overpass_timeout = 4 if interactive else 8
    query = f"""
[out:json][timeout:{overpass_timeout}];
(
  way["leisure"="golf_course"]{name_filter}{around};
  relation["leisure"="golf_course"]{name_filter}{around};
);
out center;
"""

    client_timeout = 5 if interactive else 10
    backoff_s = 0.5 if interactive else _RETRY_BACKOFF_S
    async with httpx.AsyncClient(timeout=client_timeout) as client:
        data = await _post_with_retry(
            client, query, log_tag="search_golf_courses", backoff_s=backoff_s,
        )
    if data is None:
        return []

    results = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if tags.get("leisure") != "golf_course":
            continue
        center = el.get("center")
        if not center:
            continue
        results.append({
            "osm_id": f"{el['type']}/{el['id']}",
            "name": tags.get("name", "Golf Course"),
            "address": ", ".join(
                filter(None, [tags.get("addr:city"), tags.get("addr:state")])
            )
            or None,
            "center": {"lat": center["lat"], "lng": center.get("lon", center.get("lng"))},
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "source": "osm",
        })

    if lat is not None and lng is not None:
        results = _sort_by_distance(results, lat, lng)

    return results[:_MAX_COURSE_RESULTS]


async def search_osm_with_geometry(
    name: Optional[str] = None,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    radius_m: int = 50000,
) -> list[dict]:
    """Search OSM for golf courses with full boundary geometry."""
    around = ""
    if lat is not None and lng is not None:
        around = f"(around:{radius_m},{lat},{lng})"

    name_filter = osm_name_filter(name) if name else ""

    if not name_filter and not around:
        return []

    query = f"""
[out:json][timeout:25];
(
  way["leisure"="golf_course"]{name_filter}{around};
  relation["leisure"="golf_course"]{name_filter}{around};
);
out center;
>;
out geom;
"""

    async with httpx.AsyncClient(timeout=30) as client:
        data = await _post_with_retry(client, query, log_tag="search_osm_with_geometry")
    if data is None:
        return []

    results = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if tags.get("leisure") != "golf_course":
            continue

        center = el.get("center")
        boundary = None

        if el["type"] == "way":
            geom = el.get("geometry", [])
            if len(geom) >= 4:
                ring = [[p["lon"], p["lat"]] for p in geom]
                if ring[0] != ring[-1]:
                    ring.append(ring[0])
                boundary = {"type": "Polygon", "coordinates": [ring]}
                if not center:
                    lats = [p["lat"] for p in geom]
                    lons = [p["lon"] for p in geom]
                    center = {
                        "lat": (min(lats) + max(lats)) / 2,
                        "lon": (min(lons) + max(lons)) / 2,
                    }
        elif el["type"] == "relation":
            outers = [
                m for m in el.get("members", [])
                if m.get("role") == "outer" and m.get("geometry")
            ]
            if outers:
                polys = []
                for m in outers:
                    ring = [[p["lon"], p["lat"]] for p in m["geometry"]]
                    if len(ring) >= 4:
                        if ring[0] != ring[-1]:
                            ring.append(ring[0])
                        polys.append([ring])
                if polys:
                    boundary = {"type": "MultiPolygon", "coordinates": polys}
                if not center and outers[0].get("geometry"):
                    geom = outers[0]["geometry"]
                    lats = [p["lat"] for p in geom]
                    lons = [p["lon"] for p in geom]
                    center = {
                        "lat": (min(lats) + max(lats)) / 2,
                        "lon": (min(lons) + max(lons)) / 2,
                    }

        if not boundary or not center:
            continue

        results.append({
            "osm_id": f"{el['type']}/{el['id']}",
            "name": tags.get("name", "(Unnamed golf course)"),
            "center": {"lat": center["lat"], "lng": center.get("lon", center.get("lng"))},
            "boundary": boundary,
            "tags": tags,
        })

    if lat is not None and lng is not None:
        results = _sort_by_distance(results, lat, lng)

    return results[:_MAX_GEOMETRY_RESULTS]


def _parse_boundary_geometry(el: dict) -> Optional[dict]:
    """Parse an Overpass ``way`` or ``relation`` element into a GeoJSON boundary.

    - ``way``      → ``Polygon`` (single outer ring), via :func:`_parse_way_to_polygon`.
    - ``relation`` → ``MultiPolygon`` built from every ``role: "outer"`` member
      that carries geometry (multi-course facilities sometimes map each
      sub-course's boundary as one outer ring within a shared relation).
      Inner rings (holes in the polygon) are intentionally ignored — course
      boundaries are used only as a coarse hole-selection filter here, not
      for precise area calculations.

    Returns ``None`` if the element has no usable ring geometry.
    """
    el_type = el.get("type")

    if el_type == "way":
        return _parse_way_to_polygon(el.get("geometry", []))

    if el_type == "relation":
        outers = [
            m for m in el.get("members", [])
            if m.get("role") == "outer" and m.get("geometry")
        ]
        polys: list[list[list[list[float]]]] = []
        for m in outers:
            ring = [[p["lon"], p["lat"]] for p in m["geometry"]]
            if len(ring) < 4:
                continue
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            polys.append([ring])
        if polys:
            return {"type": "MultiPolygon", "coordinates": polys}
        return None

    return None


async def fetch_golf_course_boundaries(
    lat: float,
    lng: float,
    radius_m: int = 3000,
) -> list[dict]:
    """Fetch NAMED ``leisure=golf_course`` boundary polygons within *radius_m*.

    Used by the ingest script's ``--boundary-name`` hole-selection path for
    multi-course facilities where individual ``golf=hole`` ways carry no
    ``golf:course:name`` tag (e.g. Pebble Beach: Pebble Beach Golf Links +
    Spyglass Hill + The Links at Spanish Bay + Peter Hay share one Overpass
    neighbourhood with 79 untagged hole ways). The named course-boundary
    polygon lets the ingest pipeline select holes geographically instead.

    Always an **anchored** ``(around:radius_m,lat,lng)`` Overpass query — never
    an unanchored planet-wide query.  Handles both OSM element shapes:

    - ``way``      → simple closed-ring boundary → GeoJSON ``Polygon``.
    - ``relation`` → multipolygon boundary (outer ring(s) only) → GeoJSON
      ``MultiPolygon``.

    Args:
        lat, lng: Search centre (decimal degrees).
        radius_m: Search radius in metres (default 3000).

    Returns:
        List of ``{"osm_id": str, "name": str, "boundary": <GeoJSON dict>}``.
        Elements with no ``name`` tag or no usable ring geometry are skipped.
        Empty list on Overpass failure.
    """
    query = f"""
[out:json][timeout:30];
(
  way["leisure"="golf_course"](around:{radius_m},{lat},{lng});
  relation["leisure"="golf_course"](around:{radius_m},{lat},{lng});
);
out geom;
"""
    async with httpx.AsyncClient(timeout=30) as client:
        data = await _post_with_retry(client, query, log_tag="fetch_golf_course_boundaries")
    if data is None:
        return []

    results: list[dict] = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if tags.get("leisure") != "golf_course":
            continue
        name = tags.get("name")
        if not name:
            continue
        boundary = _parse_boundary_geometry(el)
        if boundary is None:
            continue
        results.append({
            "osm_id": f"{el['type']}/{el['id']}",
            "name": name,
            "boundary": boundary,
        })

    return results


async def fetch_course_features(
    lat: float,
    lng: float,
    radius_m: int = 2000,
) -> dict:
    """Fetch detailed golf features (bunkers, water, fairways, greens) near a course.

    Returns categorized features with centroid geometry (existing callers depend on
    this shape; use :func:`fetch_course_geometry` for full polygon geometry).
    """
    query = f"""
[out:json][timeout:15];
(
  way["golf"="bunker"](around:{radius_m},{lat},{lng});
  way["golf"="green"](around:{radius_m},{lat},{lng});
  way["golf"="fairway"](around:{radius_m},{lat},{lng});
  way["golf"="tee"](around:{radius_m},{lat},{lng});
  way["natural"="water"](around:{radius_m},{lat},{lng});
  way["golf"="water_hazard"](around:{radius_m},{lat},{lng});
  way["golf"="lateral_water_hazard"](around:{radius_m},{lat},{lng});
  way["golf"="hole"](around:{radius_m},{lat},{lng});
  node["golf"="pin"](around:{radius_m},{lat},{lng});
);
out geom;
"""

    async with httpx.AsyncClient(timeout=20) as client:
        data = await _post_with_retry(client, query, log_tag="fetch_course_features")
    if data is None:
        return {"bunkers": [], "water": [], "fairways": [], "greens": [], "pins": []}

    bunkers = []
    water = []
    fairways = []
    greens = []
    pins = []

    for el in data.get("elements", []):
        tags = el.get("tags", {})
        golf_tag = tags.get("golf", "")
        natural_tag = tags.get("natural", "")

        # Compute centroid from geometry
        geom = el.get("geometry", [])
        if el["type"] == "node":
            centroid = {"lat": el.get("lat", 0), "lng": el.get("lon", 0)}
        elif geom:
            lats = [p["lat"] for p in geom]
            lons = [p["lon"] for p in geom]
            centroid = {
                "lat": sum(lats) / len(lats),
                "lng": sum(lons) / len(lons),
            }
        else:
            continue

        feature = {
            "osm_id": f"{el['type']}/{el['id']}",
            "center": centroid,
            "hole_ref": tags.get("ref"),
        }

        if golf_tag == "bunker":
            bunkers.append(feature)
        elif golf_tag in ("water_hazard", "lateral_water_hazard") or natural_tag == "water":
            water.append(feature)
        elif golf_tag == "fairway":
            fairways.append(feature)
        elif golf_tag == "green":
            greens.append(feature)
        elif golf_tag == "pin":
            pins.append(feature)

    return {
        "bunkers": bunkers,
        "water": water,
        "fairways": fairways,
        "greens": greens,
        "pins": pins,
    }


async def fetch_course_geometry(
    lat: float,
    lng: float,
    radius_m: int = 2000,
    course_name: Optional[str] = None,
) -> dict:
    """Fetch full polygon/linestring geometry for golf features near a course.

    Unlike :func:`fetch_course_features` (which returns centroids only), this
    returns full ring geometry via Overpass ``out geom`` for:

    - ``golf=green|fairway|tee|bunker`` ways → GeoJSON Polygon features
    - ``natural=water`` / ``golf=water_hazard|lateral_water_hazard`` → GeoJSON Polygon
    - ``golf=hole`` ways → GeoJSON LineString features

    Parsing is handled by :func:`_parse_course_geometry_response`, which is a
    pure function and the primary unit-test target.

    Args:
        lat: Latitude of the course center.
        lng: Longitude of the course center.
        radius_m: Search radius in metres (default 2000).
        course_name: If set, ``golf=hole`` ways are filtered to those whose
            ``golf:course:name`` tag matches this string (case-insensitive).
            Useful for multi-course facilities — e.g. pass ``"Black"`` at
            Bethpage State Park to get only Bethpage Black holes.

    Returns:
        Dict with keys: ``holes``, ``greens``, ``fairways``, ``tees``,
        ``bunkers``, ``water``, ``rough``, ``woods``, ``trees``.
        Each value is a list of GeoJSON Feature dicts ready for storage via
        :func:`~app.services.courses_mapped.upsert_course`.
        Returns an empty structure on HTTP failure.
    """
    _empty: dict = {
        "holes": [],
        "greens": [],
        "fairways": [],
        "tees": [],
        "bunkers": [],
        "water": [],
        "rough": [],
        "woods": [],
        "trees": [],
    }

    query = f"""
[out:json][timeout:30];
(
  way["golf"="green"](around:{radius_m},{lat},{lng});
  way["golf"="fairway"](around:{radius_m},{lat},{lng});
  way["golf"="tee"](around:{radius_m},{lat},{lng});
  way["golf"="bunker"](around:{radius_m},{lat},{lng});
  relation["golf"="bunker"](around:{radius_m},{lat},{lng});
  way["natural"="sand"](around:{radius_m},{lat},{lng});
  relation["natural"="sand"](around:{radius_m},{lat},{lng});
  way["natural"="water"](around:{radius_m},{lat},{lng});
  way["golf"="water_hazard"](around:{radius_m},{lat},{lng});
  way["golf"="lateral_water_hazard"](around:{radius_m},{lat},{lng});
  way["golf"="hole"](around:{radius_m},{lat},{lng});
  way["golf"="rough"](around:{radius_m},{lat},{lng});
  way["natural"="wood"](around:{radius_m},{lat},{lng});
  way["landuse"="forest"](around:{radius_m},{lat},{lng});
  way["natural"="scrub"](around:{radius_m},{lat},{lng});
  way["natural"="tree_row"](around:{radius_m},{lat},{lng});
  node["natural"="tree"](around:{radius_m},{lat},{lng});
);
out geom;
"""

    async with httpx.AsyncClient(timeout=30) as client:
        data = await _post_with_retry(client, query, log_tag="fetch_course_geometry")
    if data is None:
        return _empty

    return _parse_course_geometry_response(data, course_name_filter=course_name)
