"""PostGIS-backed lie classifier.

Given a (lat, lng) and a hole_id, look up `hole_features` polygons (fairway,
green, bunker, water, ob, tee) and return the lie the point falls inside.

Falls back to `rough` when no polygon contains the point but the hole has at
least one feature mapped (we know the hole has data, so anywhere outside the
mapped surfaces is rough). Returns None when the hole has no mapped features.
"""

from typing import Optional
from sqlalchemy import text

from app.db.engine import async_session


# Order matters: more specific surfaces first. Greens inside fringe, bunkers
# trump fairway, etc.
_LIE_PRIORITY = ["green", "bunker", "water", "ob", "fairway", "tee"]


async def classify_lie(hole_id: str, lat: float, lng: float) -> Optional[str]:
    """Return the lie ('green'|'bunker'|'water'|'ob'|'fairway'|'tee'|'rough')
    or None when the hole has no mapped polygons."""
    async with async_session() as db:
        rows = await db.execute(
            text("""
                select feature_type
                from public.hole_features
                where hole_id = :hole_id
                  and feature_type = any(:types)
                  and ST_Contains(geom, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326))
                """),
            {"hole_id": hole_id, "lat": lat, "lng": lng, "types": _LIE_PRIORITY},
        )
        hits = {r[0] for r in rows.all()}

    if not hits:
        # No polygon contains the point — confirm hole has any features mapped.
        async with async_session() as db:
            count = await db.execute(
                text("select count(*) from public.hole_features where hole_id = :hole_id"),
                {"hole_id": hole_id},
            )
            mapped = count.scalar_one()
        return "rough" if mapped and mapped > 0 else None

    for lie in _LIE_PRIORITY:
        if lie in hits:
            return lie
    return None
