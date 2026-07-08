"""Mapped-course storage over RDS (PostGIS).

Ports `frontend/src/lib/courses/storage.ts` off Supabase onto the shared async
SQLAlchemy session. Schema lives in migration 001_course_mapping_schema.sql
(courses / tee_sets / holes / hole_yardages / hole_features + PostGIS).

All geometry is handled with raw SQL (ST_MakePoint / ST_GeomFromGeoJSON /
ST_AsGeoJSON / ST_DWithin) — same queries the Supabase client issued, so no new
dependency is needed.
"""

import json
import logging
from typing import Any, Optional

from sqlalchemy import text

from app.db.engine import async_session

log = logging.getLogger("looper.courses_mapped")

# Real hole numbers are 1..N; a single stored course record can legitimately
# carry up to a 36-hole facility (two 18s / combined layouts). Used to reject
# a non-hole-number write-back key (str/float/None/negative/0/huge/bool)
# BEFORE it ever reaches SQL — see `_valid_hole_number`.
_MAX_HOLE_NUMBER = 36

DEFAULT_TEE_SETS = [
    {"name": "Black", "color": "#1a1a1a"},
    {"name": "Blue", "color": "#2563eb"},
    {"name": "White", "color": "#e5e5e5"},
    {"name": "Red", "color": "#dc2626"},
]


def _location(lng: Optional[float], lat: Optional[float]) -> Optional[dict]:
    if lng is None or lat is None:
        return None
    return {"lat": lat, "lng": lng}


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if value is not None else None


def _as_obj(value: Any) -> Any:
    """jsonb / geojson columns may come back as str or already-decoded dict."""
    if isinstance(value, str):
        return json.loads(value)
    return value


def _list_item(row: Any) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "address": row["address"],
        "location": _location(row["lng"], row["lat"]),
        "updatedAt": _iso(row["updated_at"]),
    }


# ── List ──────────────────────────────────────────────────────────────────────
async def list_courses(search: Optional[str] = None) -> list[dict]:
    """List courses, optionally filtered/ranked by a name/address search term.

    Without ``search``: most-recently-updated first (unchanged behavior — the
    course editor's plain listing).

    With ``search``: RANKED, not chronological — a prefix match on the course
    name (``name ilike 'q%'``) beats a fuzzy trigram ``similarity()`` match,
    which beats a substring/address hit; ties break by ``similarity()``
    descending. Backed by the ``pg_trgm`` GIN index on ``courses.name``
    (migration 011_courses_trgm_index) so this stays fast as the write-through
    course index (external search hits persisted by /api/courses/search) grows.
    """
    if not search:
        sql = """
            select id::text as id, name, address,
                   ST_X(location::geometry) as lng, ST_Y(location::geometry) as lat,
                   updated_at
            from public.courses
            order by updated_at desc
        """
        async with async_session() as db:
            rows = (await db.execute(text(sql))).mappings().all()
        return [_list_item(r) for r in rows]

    sql = """
        select id::text as id, name, address,
               ST_X(location::geometry) as lng, ST_Y(location::geometry) as lat,
               updated_at,
               similarity(name, :q) as sim
        from public.courses
        where name ilike :prefix or name ilike :contains or address ilike :contains
           or similarity(name, :q) > 0.2
        order by
          (name ilike :prefix) desc,
          similarity(name, :q) desc,
          updated_at desc
    """
    params: dict[str, Any] = {"q": search, "prefix": f"{search}%", "contains": f"%{search}%"}
    async with async_session() as db:
        rows = (await db.execute(text(sql), params)).mappings().all()
    return [_list_item(r) for r in rows]


# ── Nearby (PostGIS radius) ────────────────────────────────────────────────────
async def nearby_courses(lat: float, lng: float, radius_meters: float = 50000) -> list[dict]:
    sql = """
        select id::text as id, name, address,
               ST_X(location::geometry) as lng, ST_Y(location::geometry) as lat,
               updated_at
        from public.courses
        where location is not null
          and ST_DWithin(location, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :radius)
        order by location <-> ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
    """
    async with async_session() as db:
        rows = (
            await db.execute(text(sql), {"lat": lat, "lng": lng, "radius": radius_meters})
        ).mappings().all()
    return [_list_item(r) for r in rows]


# ── Get single course (with tees / holes / yardages / features) ────────────────
async def get_course(course_id: str) -> Optional[dict]:
    async with async_session() as db:
        course = (
            await db.execute(
                text(
                    """
                    select id::text as id, name, address,
                           ST_X(location::geometry) as lng, ST_Y(location::geometry) as lat,
                           created_at, updated_at
                    from public.courses
                    where id = :id
                    """
                ),
                {"id": course_id},
            )
        ).mappings().first()
        if not course:
            return None

        tee_rows = (
            await db.execute(
                text("select id::text as id, name, color from public.tee_sets where course_id = :id"),
                {"id": course_id},
            )
        ).mappings().all()

        hole_rows = (
            await db.execute(
                text(
                    """
                    select id::text as id, hole_number, par, handicap
                    from public.holes
                    where course_id = :id
                    order by hole_number
                    """
                ),
                {"id": course_id},
            )
        ).mappings().all()

        # Yardages + features joined through holes so we never need an IN list.
        yardage_rows = (
            await db.execute(
                text(
                    """
                    select hy.hole_id::text as hole_id, hy.tee_set_id::text as tee_set_id, hy.yards
                    from public.hole_yardages hy
                    join public.holes h on h.id = hy.hole_id
                    where h.course_id = :id
                    """
                ),
                {"id": course_id},
            )
        ).mappings().all()

        feature_rows = (
            await db.execute(
                text(
                    """
                    select hf.id::text as id, hf.hole_id::text as hole_id, hf.feature_type,
                           hf.tee_set_id::text as tee_set_id,
                           ST_AsGeoJSON(hf.geom) as geom, hf.properties
                    from public.hole_features hf
                    join public.holes h on h.id = hf.hole_id
                    where h.course_id = :id
                    """
                ),
                {"id": course_id},
            )
        ).mappings().all()

    tee_name_by_id = {ts["id"]: ts["name"] for ts in tee_rows}
    tee_sets = [{"name": ts["name"], "color": ts["color"] or "#888888"} for ts in tee_rows]

    holes: list[dict] = []
    for h in hole_rows:
        yardages: dict[str, int] = {}
        for y in yardage_rows:
            if y["hole_id"] == h["id"]:
                tee_name = tee_name_by_id.get(y["tee_set_id"])
                if tee_name:
                    yardages[tee_name] = y["yards"]

        features = []
        for f in feature_rows:
            if f["hole_id"] != h["id"]:
                continue
            props = _as_obj(f["properties"]) or {}
            features.append(
                {
                    "type": "Feature",
                    "id": f["id"],
                    "properties": {
                        **props,
                        "featureType": f["feature_type"],
                        "hole": h["hole_number"],
                        "teeSet": tee_name_by_id.get(f["tee_set_id"]) if f["tee_set_id"] else None,
                    },
                    "geometry": _as_obj(f["geom"]),
                }
            )

        holes.append(
            {
                "number": h["hole_number"],
                "par": h["par"],
                "handicap": h["handicap"] or h["hole_number"],
                "yardages": yardages,
                "features": {"type": "FeatureCollection", "features": features},
            }
        )

    # Ensure 18 holes exist (fill missing with defaults), matching storage.ts.
    holes_by_number = {h["number"]: h for h in holes}
    full_holes = [
        holes_by_number.get(
            i,
            {
                "number": i,
                "par": 4,
                "handicap": i,
                "yardages": {},
                "features": {"type": "FeatureCollection", "features": []},
            },
        )
        for i in range(1, 19)
    ]

    return {
        "id": course["id"],
        "name": course["name"],
        "address": course["address"],
        "location": _location(course["lng"], course["lat"]) or {"lat": 0, "lng": 0},
        "teeSets": tee_sets if tee_sets else list(DEFAULT_TEE_SETS),
        "holes": full_holes,
        "createdAt": _iso(course["created_at"]),
        "updatedAt": _iso(course["updated_at"]),
    }


# ── Upsert (create or update) ──────────────────────────────────────────────────
async def upsert_course(course: dict) -> Optional[dict]:
    course_id = course["id"]
    name = course["name"]
    address = course.get("address")
    location = course.get("location")
    tee_sets = course.get("teeSets") or []
    holes = course.get("holes") or []

    async with async_session() as db:
        # Course row
        await db.execute(
            text(
                """
                insert into public.courses (id, name, address, location)
                values (
                    :id, :name, :address,
                    case when :has_loc then ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography else null end
                )
                on conflict (id) do update set
                    name = excluded.name,
                    address = excluded.address,
                    location = excluded.location,
                    updated_at = now()
                """
            ),
            {
                "id": course_id,
                "name": name,
                "address": address,
                "has_loc": bool(location),
                "lng": location.get("lng") if location else None,
                "lat": location.get("lat") if location else None,
            },
        )

        # Tee sets
        for ts in tee_sets:
            await db.execute(
                text(
                    """
                    insert into public.tee_sets (course_id, name, color)
                    values (:course_id, :name, :color)
                    on conflict (course_id, name) do update set color = excluded.color, updated_at = now()
                    """
                ),
                {"course_id": course_id, "name": ts["name"], "color": ts.get("color")},
            )

        tee_rows = (
            await db.execute(
                text("select id::text as id, name from public.tee_sets where course_id = :id"),
                {"id": course_id},
            )
        ).mappings().all()
        tee_set_id_by_name = {ts["name"]: ts["id"] for ts in tee_rows}

        # Holes
        for hole in holes:
            features = (hole.get("features") or {}).get("features") or []
            yardages = hole.get("yardages") or {}
            has_features = len(features) > 0
            has_yardages = any(bool(v) for v in yardages.values())
            par = hole.get("par", 4)
            # Skip untouched default holes (matches storage.ts).
            if not has_features and not has_yardages and par == 4:
                continue

            hole_row = (
                await db.execute(
                    text(
                        """
                        insert into public.holes (course_id, hole_number, par, handicap)
                        values (:course_id, :hole_number, :par, :handicap)
                        on conflict (course_id, hole_number) do update set
                            par = excluded.par, handicap = excluded.handicap, updated_at = now()
                        returning id::text as id
                        """
                    ),
                    {
                        "course_id": course_id,
                        "hole_number": hole["number"],
                        "par": par,
                        "handicap": hole.get("handicap"),
                    },
                )
            ).mappings().first()
            hole_id = hole_row["id"]

            # Yardages
            for tee_name, yards in yardages.items():
                tee_set_id = tee_set_id_by_name.get(tee_name)
                if not tee_set_id or not yards:
                    continue
                await db.execute(
                    text(
                        """
                        insert into public.hole_yardages (hole_id, tee_set_id, yards)
                        values (:hole_id, :tee_set_id, :yards)
                        on conflict (hole_id, tee_set_id) do update set yards = excluded.yards, updated_at = now()
                        """
                    ),
                    {"hole_id": hole_id, "tee_set_id": tee_set_id, "yards": yards},
                )

            # Replace features for this hole
            await db.execute(
                text("delete from public.hole_features where hole_id = :hole_id"),
                {"hole_id": hole_id},
            )
            for feature in features:
                props = feature.get("properties") or {}
                feature_type = props.get("featureType") or "green"
                tee_set_id = tee_set_id_by_name.get(props["teeSet"]) if props.get("teeSet") else None
                await db.execute(
                    text(
                        """
                        insert into public.hole_features (hole_id, feature_type, tee_set_id, geom, properties)
                        values (
                            :hole_id, :feature_type, :tee_set_id,
                            ST_SetSRID(ST_GeomFromGeoJSON(:geom), 4326), CAST(:props AS jsonb)
                        )
                        """
                    ),
                    {
                        "hole_id": hole_id,
                        "feature_type": feature_type,
                        "tee_set_id": tee_set_id,
                        "geom": json.dumps(feature.get("geometry")),
                        "props": json.dumps(props),
                    },
                )

        await db.commit()

    return await get_course(course_id)


def _valid_hole_number(value: Any) -> bool:
    """True when `value` is a real hole number (1..36), the ONE gate a
    write-back key must clear before it reaches SQL. bool is an int
    subclass — reject it explicitly (mirrors course_intel's idiom)."""
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 1 <= value <= _MAX_HOLE_NUMBER
    )


# ── Targeted per-feature update (static per-hole elevation persistence) ────────
async def update_green_feature_properties(
    course_id: str,
    hole_number: int,
    patch: dict,
) -> bool:
    """Merge `patch` into the green feature's JSONB `properties` for one hole.

    Non-destructive single-feature JSONB `||` merge — the OPPOSITE of
    `upsert_course` (which deletes+reinserts every feature). Safe on hot/read
    paths and concurrent with reads. No-op-safe: returns False when the hole
    or its green feature is absent (no row updated), True otherwise. Never
    raises on a missing target; only genuine DB/driver errors propagate to
    the caller's try/except.
    """
    if not _valid_hole_number(hole_number):
        log.debug(
            "update_green_feature_properties: invalid hole_number %r (course %s)",
            hole_number, course_id,
        )
        return False
    if not patch:
        return False
    async with async_session() as db:
        result = await db.execute(
            text(
                """
                update public.hole_features hf
                set properties = coalesce(hf.properties, '{}'::jsonb) || cast(:patch as jsonb)
                from public.holes h
                where hf.hole_id = h.id
                  and h.course_id = :course_id
                  and h.hole_number = :hole_number
                  and hf.feature_type = 'green'
                """
            ),
            {
                "course_id": course_id,
                "hole_number": hole_number,
                "patch": json.dumps(patch),
            },
        )
        await db.commit()
    return (result.rowcount or 0) > 0


def _elevation_patch(profile: dict) -> dict:
    """Map a `compute_hole_elevation_profile`-shaped dict to the persisted
    patch shape, applying the `net_change_ft -> delta_ft` alias and the
    omit-green_slope-when-None rule. Exact mirror of
    `osm_ingest.embed_elevation_in_green_features`'s field mapping — kept in
    ONE place so the request write-back and the precompute job never drift.
    """
    patch = {
        "tee_elevation_ft":   profile["tee_elevation_ft"],
        "green_elevation_ft": profile["green_elevation_ft"],
        "delta_ft":           profile["net_change_ft"],
        "plays_like_yards":   profile.get("plays_like_yards", 0.0),
    }
    if profile.get("green_slope") is not None:
        patch["green_slope"] = profile["green_slope"]
    return patch


# ── Delete ──────────────────────────────────────────────────────────────────────
async def delete_course(course_id: str) -> None:
    async with async_session() as db:
        await db.execute(
            text("delete from public.courses where id = :id"), {"id": course_id}
        )
        await db.commit()


# ── Write-through (local-first course-search index) ───────────────────────────
async def write_through_courses(rows: list[dict]) -> None:
    """Persist external search hits into ``public.courses`` so repeat searches
    hit the local trigram index instead of re-calling OSM/Places/Mapbox.

    ``rows`` are the pure ``course_finder.external_course_rows`` output — each
    has a DETERMINISTIC id (same source hit always maps to the same row), so
    ``ON CONFLICT (id) DO NOTHING`` is safe and idempotent: a name/address
    correction from a fuller ingest elsewhere is never clobbered by a shallow
    search-hit write-through. Geometry (tee_sets/holes) is intentionally left
    empty — this only seeds identity + location for ranking; the course editor
    /ingest pipeline fills in the rest.
    """
    if not rows:
        return
    async with async_session() as db:
        for row in rows:
            await db.execute(
                text(
                    """
                    insert into public.courses (id, name, address, location)
                    values (
                        :id, :name, :address,
                        ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
                    )
                    on conflict (id) do nothing
                    """
                ),
                row,
            )
        await db.commit()
