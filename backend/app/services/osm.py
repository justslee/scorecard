"""OpenStreetMap Overpass API service for golf course features."""

import httpx
import re
from typing import Optional

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

_USER_AGENT = "Looper/1.0 (golf course mapping)"

# All Overpass requests include a User-Agent; the public endpoint returns 406 without one.
_OVERPASS_HEADERS = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": _USER_AGENT,
}


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
            water) are always included regardless of this filter.

    Returns:
        Dict with keys: ``holes``, ``greens``, ``fairways``, ``tees``,
        ``bunkers``, ``water``.  Each value is a list of GeoJSON Feature dicts::

            {
                "type": "Feature",
                "geometry": <GeoJSON LineString | Polygon>,
                "properties": {
                    "featureType": "<type>",
                    "osm_id": "way/<id>",
                    # holes also carry: ref, par, handicap, name
                },
            }
    """
    holes: list[dict] = []
    greens: list[dict] = []
    fairways: list[dict] = []
    tees: list[dict] = []
    bunkers: list[dict] = []
    water: list[dict] = []

    name_lower = course_name_filter.lower() if course_name_filter else None

    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue

        tags = el.get("tags", {})
        geom = el.get("geometry", [])
        golf_tag = tags.get("golf", "")
        natural_tag = tags.get("natural", "")
        osm_id = f"way/{el['id']}"

        if golf_tag == "hole":
            # Apply course-name filter for multi-course facilities (e.g. Bethpage Black).
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

    return {
        "holes": holes,
        "greens": greens,
        "fairways": fairways,
        "tees": tees,
        "bunkers": bunkers,
        "water": water,
    }


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

    name_filter = ""
    if name:
        safe = re.sub(r'["\']', "", name)
        name_filter = f'["name"~"{safe}",i]'

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
        resp = await client.post(
            OVERPASS_URL,
            data={"data": query},
            headers=_OVERPASS_HEADERS,
        )
        if not resp.is_success:
            return []
        data = resp.json()

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

    name_filter = ""
    if name:
        safe = re.sub(r'["\']', "", name)
        name_filter = f'["name"~"{safe}",i]'

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
        resp = await client.post(
            OVERPASS_URL,
            data={"data": query},
            headers=_OVERPASS_HEADERS,
        )
        if not resp.is_success:
            return []
        data = resp.json()

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
        resp = await client.post(
            OVERPASS_URL,
            data={"data": query},
            headers=_OVERPASS_HEADERS,
        )
        if not resp.is_success:
            return {"bunkers": [], "water": [], "fairways": [], "greens": [], "pins": []}
        data = resp.json()

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
        ``bunkers``, ``water``.  Each value is a list of GeoJSON Feature dicts
        ready for storage via
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
    }

    query = f"""
[out:json][timeout:25];
(
  way["golf"="green"](around:{radius_m},{lat},{lng});
  way["golf"="fairway"](around:{radius_m},{lat},{lng});
  way["golf"="tee"](around:{radius_m},{lat},{lng});
  way["golf"="bunker"](around:{radius_m},{lat},{lng});
  way["natural"="water"](around:{radius_m},{lat},{lng});
  way["golf"="water_hazard"](around:{radius_m},{lat},{lng});
  way["golf"="lateral_water_hazard"](around:{radius_m},{lat},{lng});
  way["golf"="hole"](around:{radius_m},{lat},{lng});
);
out geom;
"""

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            OVERPASS_URL,
            data={"data": query},
            headers=_OVERPASS_HEADERS,
        )
        if not resp.is_success:
            return _empty
        data = resp.json()

    return _parse_course_geometry_response(data, course_name_filter=course_name)
