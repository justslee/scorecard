"""Personal strokes-gained aggregator.

Reads a user's logged shots and computes a personal expected-strokes table
per (lie, distance bucket). Stored on `player_profiles.personal_sg`. Used by
`expected_strokes(...)` so recommendations cite the player's actual gapping
once they've logged enough shots.

We don't need a separate distance-to-pin column on `shots` — for each hole's
sequence of shots we sum the forward distances to estimate how far the
player was from the cup at the start of each shot.

Triggered post-round from /session/end. Idempotent — safe to re-run.
"""

import math
from collections import defaultdict
from typing import Optional
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.engine import async_session
from app.db.models import Shot, PlayerProfile


# Distance buckets (yards) — bin edges. A shot at 142 yards lands in the "125" bucket.
_DIST_BUCKETS = [0, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300]
_MIN_SAMPLES_PER_BIN = 3
_MIN_SHOTS_FOR_AGGREGATE = 30  # don't write personal_sg until the player has logged this many


def _bucket_for(distance_yards: float) -> Optional[int]:
    """Return the bucket lower-bound key, or None if out of range."""
    if distance_yards is None or distance_yards < 0:
        return None
    last = _DIST_BUCKETS[0]
    for edge in _DIST_BUCKETS[1:]:
        if distance_yards < edge:
            return last
        last = edge
    return _DIST_BUCKETS[-1]  # >= 300y → top bucket


def _normalize_lie(lie: Optional[str]) -> Optional[str]:
    """Map shot lies to the strokes_gained lookup table lies."""
    if not lie:
        return None
    aliases = {
        "tee": "tee",
        "fairway": "fairway",
        "rough": "rough",
        "bunker": "sand",
        "sand": "sand",
        "green": "green",
    }
    return aliases.get(lie.lower())


async def recompute_player_aggregates(user_id: str) -> dict:
    """Recompute player_profiles.personal_sg + tendency aggregates from logged shots.

    Returns the upserted profile snapshot (raw dict). No-op when fewer than
    _MIN_SHOTS_FOR_AGGREGATE shots are logged.
    """
    if not user_id:
        return {}

    async with async_session() as db:
        result = await db.execute(
            select(Shot)
            .where(Shot.user_id == user_id)
            .order_by(Shot.round_id, Shot.hole_number, Shot.shot_number)
        )
        shots = list(result.scalars().all())

    if len(shots) < _MIN_SHOTS_FOR_AGGREGATE:
        return {"rounds_analyzed": 0, "shots_analyzed": len(shots), "skipped": "too_few_shots"}

    # Group by hole within round
    by_hole: dict[tuple[str, int], list[Shot]] = defaultdict(list)
    for s in shots:
        by_hole[(s.round_id, s.hole_number)].append(s)

    # Bin: (normalized_lie, bucket) → list of strokes-to-hole values
    bins: dict[tuple[str, int], list[int]] = defaultdict(list)
    miss_directions: list[str] = []  # collected from shot.notes / result if available later
    short_misses = 0
    long_misses = 0

    for (_, _), hole_shots in by_hole.items():
        hole_shots.sort(key=lambda s: s.shot_number)
        # Estimate distance-to-hole at the start of each shot by summing forward shot distances.
        forward = sum(float(s.distance_yards) for s in hole_shots if s.distance_yards is not None)
        running = forward
        total_strokes = len(hole_shots)
        for i, s in enumerate(hole_shots):
            strokes_to_hole = total_strokes - i
            distance_to_hole_at_start = running
            running -= float(s.distance_yards or 0)

            normalized = _normalize_lie(s.start_lie)
            bucket = _bucket_for(distance_to_hole_at_start)
            if normalized is None or bucket is None:
                continue
            bins[(normalized, bucket)].append(strokes_to_hole)

            # Cheap miss-side hints — only when player annotated end_lie + intended target
            if s.result == "short":
                short_misses += 1
            elif s.result == "long":
                long_misses += 1

    # Build personal_sg JSONB
    personal_sg: dict[str, dict[str, dict]] = {}
    for (lie, bucket), strokes in bins.items():
        if len(strokes) < _MIN_SAMPLES_PER_BIN:
            continue
        mean = sum(strokes) / len(strokes)
        personal_sg.setdefault(lie, {})[str(bucket)] = {
            "mean_strokes": round(mean, 3),
            "samples": len(strokes),
        }

    rounds_analyzed = len({rid for rid, _ in by_hole.keys()})
    miss_short_pct: Optional[float] = None
    if short_misses + long_misses > 0:
        miss_short_pct = round(100.0 * short_misses / (short_misses + long_misses), 1)

    # Upsert profile
    values: dict = {
        "user_id": user_id,
        "personal_sg": personal_sg,
        "rounds_analyzed": rounds_analyzed,
    }
    if miss_short_pct is not None:
        values["miss_short_pct"] = miss_short_pct

    update_set = {k: v for k, v in values.items() if k != "user_id"}

    async with async_session() as db:
        stmt = pg_insert(PlayerProfile).values(**values).on_conflict_do_update(
            index_elements=["user_id"],
            set_=update_set,
        )
        await db.execute(stmt)
        await db.commit()

    return {
        "user_id": user_id,
        "rounds_analyzed": rounds_analyzed,
        "shots_analyzed": len(shots),
        "bins_filled": sum(len(v) for v in personal_sg.values()),
        "miss_short_pct": miss_short_pct,
    }
