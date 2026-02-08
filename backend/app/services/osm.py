"""OpenStreetMap Overpass API service for golf course features."""

import httpx
import re
import math
from typing import Optional

OVERPASS_URL = "https://overpass-api.de/api/interpreter"


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
            headers={"Content-Type": "application/x-www-form-urlencoded"},
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
            headers={"Content-Type": "application/x-www-form-urlencoded"},
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

    Returns categorized features for hazard analysis.
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
            headers={"Content-Type": "application/x-www-form-urlencoded"},
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
