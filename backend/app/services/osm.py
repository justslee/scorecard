"""OpenStreetMap Overpass API service for golf course features."""

import asyncio
import logging
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
) -> Optional[dict]:
    """POST *query* to the Overpass interpreter with one retry on transient failures.

    Transient failures (HTTP 429 / 5xx, or ``httpx`` timeout / transport errors)
    are retried once after :data:`_RETRY_BACKOFF_S` seconds.  Non-transient HTTP
    errors (any 4xx other than 429) are logged and returned immediately as
    ``None`` without a retry.  A clean 200 response with an empty ``"elements"``
    list is **never** retried — that is a real "no data" result, not a fault.

    Args:
        client: An open ``httpx.AsyncClient`` (caller controls timeout).
        query: Raw Overpass QL query string.
        log_tag: Label prepended to log messages (use the calling function's name
            so the source is visible in the log stream).

    Returns:
        Parsed JSON ``dict`` on success, or ``None`` after a persistent failure.
        Callers should treat ``None`` as an empty/error result and log or surface
        accordingly — this function never raises.
    """
    for attempt in range(2):
        try:
            resp = await client.post(
                OVERPASS_URL,
                data={"data": query},
                headers=_OVERPASS_HEADERS,
            )
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            _log.warning(
                "%s request error (attempt %d/2) url=%s exc=%r",
                log_tag, attempt + 1, OVERPASS_URL, exc,
            )
            if attempt == 0:
                await asyncio.sleep(_RETRY_BACKOFF_S)
                continue
            return None

        if resp.is_success:
            return resp.json()

        body = resp.text[:200].strip()
        if resp.status_code in _TRANSIENT_STATUS_CODES:
            _log.warning(
                "%s transient HTTP %d (attempt %d/2) url=%s body=%r",
                log_tag, resp.status_code, attempt + 1, OVERPASS_URL, body,
            )
            if attempt == 0:
                await asyncio.sleep(_RETRY_BACKOFF_S)
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
            or natural_tag == "water"
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
            elif golf_tag == "bunker":
                feature_type = "bunker"
                bucket = bunkers
            else:  # water_hazard, lateral_water_hazard, natural=water
                feature_type = "water"
                bucket = water

            bucket.append({
                "type": "Feature",
                "geometry": polygon,
                "properties": {
                    "featureType": feature_type,
                    "osm_id": osm_id,
                },
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


# ── HTTP fetch functions ───────────────────────────────────────────────────────

async def search_golf_courses(
    name: Optional[str] = None,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    radius_m: int = 10000,
) -> list[dict]:
    """Search OSM for golf courses by name and/or location."""
    around = ""
    if lat is not None and lng is not None:
        around = f"(around:{radius_m},{lat},{lng})"

    name_filter = osm_name_filter(name) if name else ""

    if not name_filter and not around:
        return []

    query = f"""
[out:json][timeout:8];
(
  way["leisure"="golf_course"]{name_filter}{around};
  relation["leisure"="golf_course"]{name_filter}{around};
);
out center;
"""

    async with httpx.AsyncClient(timeout=10) as client:
        data = await _post_with_retry(client, query, log_tag="search_golf_courses")
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
            "source": "osm",
        })

    return results[:15]


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

    return results[:25]


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
