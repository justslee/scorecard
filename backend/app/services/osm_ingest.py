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
from typing import Any, Optional

from app.services.course_spatial import build_course_feature_collection

# ── Default tee sets ──────────────────────────────────────────────────────────
# Mirrors courses_mapped.DEFAULT_TEE_SETS so callers don't need to import it.

_DEFAULT_TEE_SETS: list[dict[str, Any]] = [
    {"name": "Black", "color": "#1a1a1a"},
    {"name": "Blue",  "color": "#2563eb"},
    {"name": "White", "color": "#e5e5e5"},
    {"name": "Red",   "color": "#dc2626"},
]


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
                    },
                    ...  # one entry per hole that received ≥1 polygon
                ],
            }
    """
    all_holes: list[dict] = geometry.get("holes", [])

    # Flatten all polygon feature types for the spatial join.
    polygons: list[dict] = (
        geometry.get("greens",   [])
        + geometry.get("fairways", [])
        + geometry.get("tees",     [])
        + geometry.get("bunkers",  [])
        + geometry.get("water",    [])
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

    return {
        "id":       course_id,
        "name":     course_name,
        "address":  address,
        "location": location,
        "teeSets":  tee_sets if tee_sets is not None else list(_DEFAULT_TEE_SETS),
        "holes":    hole_dicts,
    }
