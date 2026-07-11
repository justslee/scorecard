"""Per-hole elevation precompute — the bulk compute-once job.

specs/course-intel-static-persistence-plan.md (v2) §5a. Lives in its own small
services module (not `routes/caddie.py`) so `routes/courses_mapped.py`
(PRIMARY — create/re-map) can import the precompute job without a
route -> route circular import, mirroring `app/services/course_guides.py`'s
`_precompute_course_guides` for exactly the same reason.

Moved verbatim from `app/routes/caddie.py`: `_feature_center`,
`_green_persisted_elevation`, `_precompute_course_elevations`. Adds
`elevation_coords_key` — the content-addressed invalidation stamp (plan §4):
key-equality between the stored tee/green centers and the persisted key
means the persisted elevation/slope data is still valid; a mismatch (or a
missing key, e.g. legacy/ingest-seeded blobs) means the hole must be
resampled. Only this precompute job stamps the key — it is the only writer
that samples the canonical stored (post-`get_course`) centers.
"""

from __future__ import annotations

import logging
from typing import Optional

from app.services import courses_mapped
from app.services.course_spatial import _ring_centroid
from app.services.elevation import sample_course_elevations

log = logging.getLogger("looper.course_elevation")


def _green_persisted_elevation(stored_hole: Optional[dict]) -> Optional[dict]:
    """Pull the green feature's persisted elevation subset from a stored hole
    (as returned by `courses_mapped.get_course`), or None when absent."""
    if not stored_hole:
        return None
    feats = (stored_hole.get("features") or {}).get("features") or []
    for f in feats:
        props = f.get("properties") or {}
        if props.get("featureType") == "green" and props.get("tee_elevation_ft") is not None:
            return props  # full props dict; build_hole_intelligence reads only elevation keys
    return None


def _feature_center(feats: list[dict], feature_type: str) -> Optional[tuple[float, float]]:
    """(lng, lat) centre of the first WELL-FORMED feature of `feature_type`.

    A malformed feature (missing/invalid geometry) must not blind the whole
    hole: skip it and keep scanning later same-type features rather than
    returning None on the first bad one.
    """
    for f in feats:
        if (f.get("properties") or {}).get("featureType") != feature_type:
            continue
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates")
        gtype = geom.get("type")
        try:
            if gtype == "Point":
                return (coords[0], coords[1])
            if gtype == "Polygon":
                lon, lat = _ring_centroid(coords[0])
                return (lon, lat)
            if gtype == "MultiPolygon":
                lon, lat = _ring_centroid(coords[0][0])
                return (lon, lat)
        except (TypeError, IndexError, KeyError):
            continue  # malformed feature — keep scanning remaining same-type features
    return None


def elevation_coords_key(tee_c: tuple[float, float], green_c: tuple[float, float]) -> str:
    """Content-addressed stamp of the exact (lng, lat) centers sampled for one
    hole's elevation/slope. 6 dp ≈ 0.11 m — far below any real re-map, far
    above float noise; both comparison sides always come from the same
    `get_course` -> `ST_AsGeoJSON` pipeline, so this is deterministic."""
    tee_lng, tee_lat = tee_c
    green_lng, green_lat = green_c
    return f"{tee_lng:.6f},{tee_lat:.6f};{green_lng:.6f},{green_lat:.6f}"


async def _precompute_course_elevations(course_id: str) -> None:
    """Seed per-hole elevation into green-feature properties so the 2nd
    course-intel open shows elevation instantly. Best-effort: never raises.

    Idempotent + self-healing: a hole is skipped only when its persisted
    `elevation_coords_key` matches the CURRENT stored tee/green centers.
    Missing key (legacy/write-back/ingest-seeded data) or a mismatched key
    (a re-map moved the geometry) triggers a resample + overwrite, stamped
    with the fresh key.
    """
    try:
        course = await courses_mapped.get_course(course_id)
        if not course:
            return

        # Build the minimal LineString hole list sample_course_elevations
        # expects (tee = coords[0], green = coords[-1]), deriving tee/green
        # centres from stored polygon features. Only holes whose persisted
        # key doesn't match the CURRENT centers are sampled (idempotent +
        # self-healing on re-map + avoids re-hitting USGS).
        synth_holes: list[dict] = []
        key_by_hole: dict[int, str] = {}
        SYNTH_NAME = "precompute"
        for h in course.get("holes", []):
            feats = (h.get("features") or {}).get("features") or []
            green_c = _feature_center(feats, "green")
            tee_c = _feature_center(feats, "tee")
            if green_c is None or tee_c is None:
                continue  # absent != zero — cannot sample; skip
            current_key = elevation_coords_key(tee_c, green_c)
            persisted = _green_persisted_elevation(h)
            if persisted is not None and persisted.get("elevation_coords_key") == current_key:
                continue  # already persisted for these exact centers — idempotent skip
            key_by_hole[h["number"]] = current_key
            synth_holes.append({
                "type": "Feature",
                "properties": {"course_name": SYNTH_NAME, "ref": h["number"]},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [tee_c[0], tee_c[1]],      # [lng, lat] tee   -> coords[0]
                        [green_c[0], green_c[1]],  # [lng, lat] green -> coords[-1]
                    ],
                },
            })

        if not synth_holes:
            return  # nothing to do — zero USGS calls

        profiles = await sample_course_elevations(synth_holes, SYNTH_NAME)  # 2 batched calls
        for hole_number, profile in profiles.items():  # omit-on-missing already applied
            try:
                patch = courses_mapped._elevation_patch(profile)
                patch["elevation_coords_key"] = key_by_hole[hole_number]
                await courses_mapped.update_green_feature_properties(
                    course_id, hole_number, patch
                )
            except Exception:
                log.warning("precompute write-back failed hole %s", hole_number, exc_info=True)
    except Exception:
        log.warning("elevation precompute failed course=%s", course_id, exc_info=True)
