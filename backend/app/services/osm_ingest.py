"""Pure assembly layer for OSM → mapped-course ingest pipeline (I2 Bethpage POC).

No network, no database, no new dependencies.  The two exported symbols are:

- ``_deterministic_uuid(key)`` — mirrors the frontend ``deterministicUUID()``
  in ``golf-api.ts`` (SHA-1 of ``"golfapi:{key}"``, version-5 and variant bits,
  UUID string).  Identical output means a later GolfAPI id discovery produces
  the same row UUID without a migration.
- ``assemble_osm_course(...)`` — combines I0 geometry + I1 spatial-join into
  the exact dict shape ``upsert_course`` expects.  Unit-test target for I2.
"""

from __future__ import annotations

import hashlib
import math
from typing import Any, Optional

from app.services.course_spatial import (
    _point_in_ring,
    _ring_bbox,
    _ring_centroid,
    build_course_feature_collection,
)

# ── Default tee sets ──────────────────────────────────────────────────────────
# Mirrors courses_mapped.DEFAULT_TEE_SETS so callers don't need to import it.

_DEFAULT_TEE_SETS: list[dict[str, Any]] = [
    {"name": "Black", "color": "#1a1a1a"},
    {"name": "Blue",  "color": "#2563eb"},
    {"name": "White", "color": "#e5e5e5"},
    {"name": "Red",   "color": "#dc2626"},
]


def _should_abort_empty(n_assembled_holes: int) -> bool:
    """Return True if the assembled course has zero holes and the write should abort.

    Used by the ingest script as a guard against writing a useless empty course
    record to the database — which would silently overwrite any previously-ingested
    good data and produce confusing downstream results.

    Args:
        n_assembled_holes: Length of the ``"holes"`` list returned by
            :func:`assemble_osm_course`.

    Returns:
        ``True``  → abort; do not call ``upsert_course``.
        ``False`` → proceed; the course has at least one hole.
    """
    return n_assembled_holes == 0


# ── Boundary-polygon hole selection ────────────────────────────────────────────
#
# Alternative to the ``golf:course:name`` tag filter (``fetch_course_geometry``'s
# ``course_name`` arg) for multi-course facilities where individual hole ways
# carry NO course-name tag at all — e.g. Pebble Beach: 79 ``golf=hole`` ways
# spanning Pebble Beach Golf Links + Spyglass Hill + The Links at Spanish Bay +
# Peter Hay, none tagged.  Instead, a NAMED ``leisure=golf_course`` boundary
# polygon (fetched via ``osm.fetch_golf_course_boundaries``) is used to select
# which hole LineStrings belong to the target course geographically.
#
# The selected holes are re-tagged with ``properties.course_name =
# target_course_name`` so the *rest* of the pipeline — ``assemble_osm_course``'s
# par/handicap merge, ``build_course_feature_collection``'s cross-course polygon
# rejection, and ``elevation.sample_course_elevations`` — all keep working
# unmodified via the existing tag-matching mechanism.  Holes NOT selected are
# left untouched (course_name stays whatever it was, usually ``None`` at
# untagged venues) so they remain available for nearest-hole distance
# comparisons during cross-course polygon rejection — a stray green whose
# nearest line is actually a neighbouring, non-selected hole is still excluded.

def _point_in_boundary(lon: float, lat: float, boundary: dict) -> bool:
    """Point-in-polygon test against a GeoJSON ``Polygon`` or ``MultiPolygon``.

    Reuses the ray-casting :func:`~app.services.course_spatial._point_in_ring`
    test.  For a ``MultiPolygon`` (OSM relation boundaries — e.g. a shared
    multi-course facility mapped as one relation per sub-course) the point is
    considered inside if it falls within ANY of the sub-polygons' outer rings.
    Interior rings (polygon "holes") are intentionally ignored — course
    boundaries are used only as a coarse hole-selection filter here.

    Args:
        lon, lat: Query point (decimal degrees).
        boundary: GeoJSON ``Polygon`` or ``MultiPolygon`` dict (as returned by
            ``osm.fetch_golf_course_boundaries``).

    Returns:
        ``True`` if the point falls inside any outer ring of *boundary*.
    """
    geom_type = boundary.get("type")
    coords = boundary.get("coordinates") or []

    if geom_type == "Polygon":
        rings = [coords[0]] if coords and coords[0] else []
    elif geom_type == "MultiPolygon":
        rings = [poly[0] for poly in coords if poly and poly[0]]
    else:
        return False

    for ring in rings:
        if len(ring) < 4:
            continue
        _, clat = _ring_centroid(ring)
        cos_lat = math.cos(math.radians(clat))
        bbox = _ring_bbox(ring)
        if _point_in_ring(lon, lat, ring, cos_lat, bbox):
            return True
    return False


def _hole_inside_boundary(
    coords: list[list[float]],
    boundary: dict,
    min_fraction: float,
) -> bool:
    """Return ``True`` if at least *min_fraction* of *coords* fall inside *boundary*."""
    if not coords:
        return False
    n_inside = sum(1 for pt in coords if _point_in_boundary(pt[0], pt[1], boundary))
    return (n_inside / len(coords)) >= min_fraction


def apply_boundary_hole_selection(
    holes: list[dict],
    boundary: dict,
    target_course_name: str,
    min_fraction: float = 0.5,
) -> list[dict]:
    """Tag hole LineStrings that fall inside *boundary* with the target course name.

    Args:
        holes: GeoJSON hole Feature list (LineString geometry), e.g. the
            ``"holes"`` key of ``fetch_course_geometry(...)``'s return value.
            Should contain ALL courses' holes (unfiltered) so cross-course
            polygon rejection downstream still has the full hole set to compare
            against.
        boundary: GeoJSON ``Polygon``/``MultiPolygon`` for the target course,
            e.g. one entry's ``"boundary"`` from
            ``osm.fetch_golf_course_boundaries``.
        target_course_name: Value written to ``properties.course_name`` on
            every selected hole — pass the same string as
            ``assemble_osm_course``'s ``target_course_name`` argument so the
            rest of the pipeline recognises these holes as the target course.
        min_fraction: Minimum fraction (0.0–1.0) of a hole's LineString
            vertices that must fall inside *boundary* to select it (default
            0.5 — majority rule tolerates a tee box or green that pokes
            slightly outside a hand-drawn OSM boundary, or a hole whose ways
            are stitched from more than one OSM segment).

    Returns:
        A NEW list — same length and order as *holes*.  Selected hole dicts
        are shallow-copied with a replaced ``properties`` dict (so the caller
        never mutates *holes* in place); non-selected holes are the original
        dict objects, unmodified.
    """
    result: list[dict] = []
    for hole in holes:
        coords = (hole.get("geometry") or {}).get("coordinates") or []
        if _hole_inside_boundary(coords, boundary, min_fraction):
            props = dict(hole.get("properties") or {})
            props["course_name"] = target_course_name
            tagged_hole = dict(hole)
            tagged_hole["properties"] = props
            result.append(tagged_hole)
        else:
            result.append(hole)
    return result


def match_boundary_by_name(boundaries: list[dict], query: str) -> Optional[dict]:
    """Find the boundary dict whose ``name`` best matches *query* (case-insensitive).

    Exact (case-insensitive) matches win over substring matches, so an exact
    OSM name always beats an incidental partial hit.  Substring matching is
    tried in both directions so a shorter query like ``"Pebble Beach"`` still
    matches an OSM name of ``"Pebble Beach Golf Links"``, and vice versa.

    Args:
        boundaries: List of dicts as returned by
            ``osm.fetch_golf_course_boundaries`` (each with a ``"name"`` key).
        query: The ``--boundary-name`` CLI value to search for.

    Returns:
        The matching boundary dict, or ``None`` if *boundaries* is empty, or
        no entry's name overlaps *query* at all.
    """
    q = query.strip().lower()
    if not q:
        return None

    substring_match: Optional[dict] = None
    for b in boundaries:
        name = (b.get("name") or "").strip().lower()
        if not name:
            continue
        if name == q:
            return b
        if substring_match is None and (q in name or name in q):
            substring_match = b
    return substring_match


def _deterministic_uuid(key: str) -> str:
    """Deterministic UUID v5-style from *key*, identical to the frontend.

    The frontend ``deterministicUUID(input)`` (``golf-api.ts``) hashes
    ``"golfapi:{input}"`` with SHA-1, takes the first 16 bytes, sets the
    UUID version-5 (``b[6] = (b[6] & 0x0f) | 0x50``) and RFC 4122 variant
    (``b[8] = (b[8] & 0x3f) | 0x80``) bits, then formats as a UUID string.

    This Python implementation produces the **identical** UUID for the same
    key, which is load-bearing for per-course coexistence:

    - Homegrown-only courses use e.g. ``key = "osm-bethpage-black"``
      → SHA-1 input is ``"golfapi:osm-bethpage-black"``.
    - When a GolfAPI course ID (say ``12345``) is discovered for Bethpage
      Black, pass ``key = "golfapi-12345"`` — the frontend import flow
      uses ``deterministicUUID("golfapi-12345")`` for the same SHA-1
      input, so both sides land on the identical row UUID with no migration.

    Args:
        key: Stable string identifier (e.g. ``"osm-bethpage-black"``).

    Returns:
        UUID v5-style string: ``xxxxxxxx-xxxx-5xxx-8xxx-xxxxxxxxxxxx``.
    """
    raw = hashlib.sha1(f"golfapi:{key}".encode()).digest()
    b = bytearray(raw[:16])
    b[6] = (b[6] & 0x0F) | 0x50  # version 5
    b[8] = (b[8] & 0x3F) | 0x80  # variant 10xx (RFC 4122)
    h = b.hex()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def assemble_osm_course(
    geometry: dict[str, list[dict]],
    course_id: str,
    course_name: str,
    target_course_name: str,
    address: Optional[str] = None,
    location: Optional[dict[str, float]] = None,
    tee_sets: Optional[list[dict[str, Any]]] = None,
    hole_elevations: Optional[dict[int, dict]] = None,
) -> dict[str, Any]:
    """Combine I0 geometry + I1 spatial join into the ``upsert_course`` input dict.

    This is the pure, unit-testable assembly step between the Overpass fetch
    (``fetch_course_geometry`` / I0) and the DB write (``upsert_course`` / I2).

    Steps performed:

    1. Collect all polygon feature lists (greens + fairways + tees + bunkers
       + water) from *geometry* into a flat list.
    2. Call :func:`~app.services.course_spatial.build_course_feature_collection`
       (I1 spatial join) which assigns each polygon to its nearest hole across
       **all** courses and returns only the polygons belonging to
       *target_course_name*, grouped by hole.
    3. Merge ``par`` / ``handicap`` from the OSM hole LineStrings (which carry
       those tags from the Overpass ``ref`` / ``par`` / ``handicap`` OSM tags
       parsed in I0).  ``build_course_feature_collection`` leaves those fields
       as ``None`` by design; the caller (this function) is expected to fill them.
    4. Wrap everything in the top-level dict shape ``upsert_course`` expects.

    **Yardages are intentionally left empty** (``{}`` per hole).  They come
    from the physical scorecard in the I3 validation step; merge via a second
    ``upsert_course`` call or a future migration endpoint.

    Args:
        geometry:
            Output of ``fetch_course_geometry(lat, lng, radius, course_name=None)``
            — a dict with keys ``holes``, ``greens``, ``fairways``, ``tees``,
            ``bunkers``, ``water``.  **The** ``holes`` **list must contain ALL
            courses' hole LineStrings** (not pre-filtered to *target_course_name*)
            so the spatial join can reject polygons that are physically closer to a
            neighbouring course's hole.
        course_id:
            Deterministic UUID string (use :func:`_deterministic_uuid`).
        course_name:
            Human-readable display name, e.g. ``"Bethpage Black"``.
        target_course_name:
            OSM ``golf:course:name`` value to select (case-insensitive),
            e.g. ``"Black"``.
        address:
            Optional address string (stored as-is).
        location:
            Optional ``{"lat": float, "lng": float}`` course centre.
        tee_sets:
            Optional list of ``{"name": str, "color": str}`` dicts.
            Defaults to ``[Black, Blue, White, Red]``.
        hole_elevations:
            Optional mapping of hole number (int) →
            ``compute_hole_elevation_profile`` result dict::

                {
                    "tee_elevation_ft":   float,
                    "green_elevation_ft": float,
                    "net_change_ft":      float,   # positive = uphill
                    "green_slope":        dict | None,
                }

            When provided, each matching hole dict gains an ``"elevation"`` key.
            Holes without a matching entry are left unchanged (no ``"elevation"``
            key).  Passing ``None`` (the default) keeps the output shape
            identical to earlier iterations — no existing callers break.

    Returns:
        Dict matching the :func:`~app.services.courses_mapped.upsert_course`
        input schema::

            {
                "id":       str,
                "name":     str,
                "address":  str | None,
                "location": {"lat": float, "lng": float} | None,
                "teeSets":  [{"name": str, "color": str}, ...],
                "holes": [
                    {
                        "number":   int,
                        "par":      int | None,   # from OSM; None if untagged
                        "handicap": int | None,   # from OSM; None if untagged
                        "yardages": {},            # empty — filled from card (I3)
                        "features": {              # GeoJSON FeatureCollection
                            "type": "FeatureCollection",
                            "features": [...]
                        },
                        # present only when hole_elevations supplies this hole:
                        "elevation": {
                            "tee_elevation_ft":   float,
                            "green_elevation_ft": float,
                            "net_change_ft":      float,
                            "green_slope":        dict | None,
                        } | None,
                    },
                    ...  # one entry per hole that received ≥1 polygon
                ],
            }
    """
    all_holes: list[dict] = geometry.get("holes", [])

    # Flatten all polygon + point feature types for the spatial join.
    # rough/woods are polygon features; trees are Point features (handled by
    # the updated assign_features_to_holes which accepts Point geometry).
    polygons: list[dict] = (
        geometry.get("greens",   [])
        + geometry.get("fairways", [])
        + geometry.get("tees",     [])
        + geometry.get("bunkers",  [])
        + geometry.get("water",    [])
        + geometry.get("rough",    [])
        + geometry.get("woods",    [])
        + geometry.get("trees",    [])
    )

    # I1: spatial join — assigns each polygon to the nearest hole across ALL
    # courses, then keeps only polygons belonging to target_course_name.
    hole_dicts = build_course_feature_collection(
        all_holes, polygons, target_course_name
    )

    # Build a par / handicap index from the target course's hole LineStrings.
    # OSM ref tags are strings ("1"–"18"); key on the string to match the
    # ``number`` field after _ref_to_int conversion.
    target_lower = target_course_name.lower()
    par_hcp_by_ref: dict[str, tuple[Optional[int], Optional[int]]] = {}
    for hole in all_holes:
        props = hole.get("properties") or {}
        if (props.get("course_name") or "").lower() == target_lower:
            ref = props.get("ref")
            if ref is not None:
                par_hcp_by_ref[str(ref)] = (
                    props.get("par"),
                    props.get("handicap"),
                )

    # Merge par / handicap into each hole dict.
    # build_course_feature_collection leaves them as None (by design, the
    # caller is responsible for filling them from external data).
    for hole_dict in hole_dicts:
        ref_str = str(hole_dict["number"])
        par, hcp = par_hcp_by_ref.get(ref_str, (None, None))
        if par is not None:
            hole_dict["par"] = par
        if hcp is not None:
            hole_dict["handicap"] = hcp

    # Attach the golf=hole way itself (featureType "hole" LineString) to each
    # hole's FeatureCollection. The spatial join only groups POLYGON features,
    # but the played line must survive to hole_features (geom is
    # geometry(Geometry, 4326) — LineString stores fine) so
    # app.caddie.hazards.extract_hole_hazards can classify hazard side/carry
    # against the PLAYED polyline instead of the tee→green chord, which
    # mirrors sides on doglegs (hazard-side-flip incident, Bethpage Black 4).
    hole_way_by_ref: dict[str, dict] = {}
    for hole in all_holes:
        props = hole.get("properties") or {}
        if (props.get("course_name") or "").lower() != target_lower:
            continue
        ref = props.get("ref")
        geom = hole.get("geometry") or {}
        if ref is not None and geom.get("type") == "LineString":
            hole_way_by_ref[str(ref)] = hole
    for hole_dict in hole_dicts:
        way = hole_way_by_ref.get(str(hole_dict["number"]))
        if way is not None:
            # Same shape as the joined polygons: original properties
            # (featureType "hole", osm_id, ref, ...) + geometry, as parsed
            # by osm._parse_course_geometry_response.
            hole_dict["features"]["features"].append(
                {
                    "type": "Feature",
                    "properties": (way.get("properties") or {}),
                    "geometry": way.get("geometry"),
                }
            )

    # I4: Optionally attach per-hole elevation profile (3DEP / EPQS sampled).
    # ``hole_elevations`` is intentionally additive — callers that do not yet
    # have elevation data (or tests that don't care about it) pass nothing and
    # the output shape is identical to I2 / I3.
    if hole_elevations:
        for hole_dict in hole_dicts:
            elev = hole_elevations.get(hole_dict["number"])
            if elev is not None:
                hole_dict["elevation"] = elev

    return {
        "id":       course_id,
        "name":     course_name,
        "address":  address,
        "location": location,
        "teeSets":  tee_sets if tee_sets is not None else list(_DEFAULT_TEE_SETS),
        "holes":    hole_dicts,
    }


def embed_elevation_in_green_features(course_data: dict) -> None:
    """Inject per-hole elevation data into each hole's green feature properties (in-place).

    ``assemble_osm_course`` attaches elevation to ``hole_dict["elevation"]`` when
    ``hole_elevations`` is supplied.  However ``upsert_course`` does **not** persist
    that top-level hole key — it only stores feature ``properties`` as jsonb.  This
    function bridges the gap by copying the elevation fields into the **green feature's
    ``properties``** so they survive the DB round-trip and are returned by
    ``get_course`` inside the feature's ``properties`` dict.

    Fields written to the green feature's properties::

        tee_elevation_ft   — elevation at the tee in feet
        green_elevation_ft — elevation at the green centre in feet
        delta_ft           — net_change_ft alias (positive = uphill, negative = downhill)
        plays_like_yards   — plays-like yardage adjustment (PLAYS_LIKE_YARD_PER_FT = 1/3)

    Storage guarantee:
        ``upsert_course`` stores each feature's ``properties`` dict as jsonb in the
        ``hole_features.properties`` column.  ``get_course`` reads that jsonb and
        spreads it into the returned feature's ``"properties"`` dict — so these
        fields round-trip without any schema change or migration.

    Only the **green** feature type receives elevation fields.  Tee, fairway, bunker,
    water, rough, woods, and tree features are not modified.  Holes without an
    ``"elevation"`` key (i.e. where USGS returned None for that hole) are skipped.

    Modifies *course_data* in-place; returns ``None``.

    Args:
        course_data: dict produced by :func:`assemble_osm_course` (after the optional
            ``hole_elevations`` attachment step).
    """
    for hole in course_data.get("holes", []):
        elev = hole.get("elevation")
        if not elev:
            continue
        fields: dict = {
            "tee_elevation_ft":   elev["tee_elevation_ft"],
            "green_elevation_ft": elev["green_elevation_ft"],
            "delta_ft":           elev["net_change_ft"],   # alias for storage/frontend
            "plays_like_yards":   elev.get("plays_like_yards", 0.0),
        }
        # green_slope: populated during ingest via the 3DEP Sobel batch; None
        # for holes sampled before this feature was wired (or if USGS returned
        # insufficient grid data).  Stored as a jsonb sub-dict — no migration.
        if elev.get("green_slope") is not None:
            fields["green_slope"] = elev["green_slope"]
        features = (hole.get("features") or {}).get("features") or []
        for feature in features:
            props = feature.get("properties") or {}
            if props.get("featureType") == "green":
                # Shallow-copy before mutating so module-level test fixtures
                # (shared dict objects from course_spatial) are not contaminated.
                props = dict(props)
                props.update(fields)
                feature["properties"] = props
