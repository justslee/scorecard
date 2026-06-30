"""Per-club distance aggregation — pure function, no I/O.

Called from the /api/shots/stats endpoint (routes/shots.py) after the DB
query. Kept separate so tests can import it without triggering the DB engine
init (which requires DATABASE_URL to be set).

Data model: the function accepts a list of raw shot tuples
  (club: str | None, distance_yards: float | None, end_lie: str | None)
and returns ClubStat instances sorted longest→shortest.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from statistics import median as _stats_median, stdev as _stats_stdev
from typing import Optional

# A raw query row: (club, distance_yards, end_lie). Any field may be None.
ShotAggRow = tuple[Optional[str], Optional[float], Optional[str]]


@dataclass
class ClubStat:
    """Per-club aggregate; mirrors the Pydantic ClubStat in routes/shots.py."""

    club: str
    n: int                          # shots with a valid distance for this club
    avg_distance: float             # mean carry distance, yards (1 dp)
    median_distance: float          # median carry distance, yards (1 dp)
    stdev_distance: Optional[float] # 1-sigma spread; None when n < 2
    most_common_lie: Optional[str]  # most frequent end_lie, or None


def aggregate_by_club(rows: list[ShotAggRow]) -> list[ClubStat]:
    """Aggregate shot rows into per-club distance stats.

    Args:
        rows: Iterable of (club, distance_yards, end_lie) tuples.
              Rows where club or distance_yards is None are silently skipped.

    Returns:
        List of ClubStat, sorted longest → shortest by avg_distance.
        Ties in avg_distance are broken alphabetically by club name.
        Returns [] when no valid rows exist.
    """
    club_distances: dict[str, list[float]] = defaultdict(list)
    club_lies: dict[str, list[str]] = defaultdict(list)

    for club, dist, lie in rows:
        if club is None or dist is None:
            continue
        club_distances[club].append(float(dist))
        if lie is not None:
            club_lies[club].append(lie)

    stats: list[ClubStat] = []
    for club, dists in club_distances.items():
        n = len(dists)
        avg = round(sum(dists) / n, 1)
        med = round(_stats_median(dists), 1)
        sd = round(_stats_stdev(dists), 1) if n >= 2 else None

        lie_counter = Counter(club_lies[club])
        most_common = lie_counter.most_common(1)[0][0] if lie_counter else None

        stats.append(
            ClubStat(
                club=club,
                n=n,
                avg_distance=avg,
                median_distance=med,
                stdev_distance=sd,
                most_common_lie=most_common,
            )
        )

    # Longest → shortest; ties broken alphabetically by club name
    stats.sort(key=lambda s: (-s.avg_distance, s.club))
    return stats
