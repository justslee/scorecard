"""Player statistics engine - analyzes round history for tendencies."""

from typing import Optional
from app.caddie.types import (
    PlayerStatistics,
    StrokesGained,
    ScoringDistribution,
    ParAverages,
    PlayerTendencies,
    HolePlayerHistory,
)


def analyze_player_stats(
    rounds: list[dict],
    handicap: Optional[float] = None,
    course_id: Optional[str] = None,
) -> PlayerStatistics:
    """Analyze a player's round history to extract scoring patterns.

    Args:
        rounds: List of round objects from frontend storage
        handicap: Player handicap (from GolferProfile)
        course_id: If provided, also extract course-specific stats

    Returns:
        PlayerStatistics with scoring distribution, tendencies, etc.
    """
    if not rounds:
        return _default_stats(handicap)

    all_scores: list[dict] = []  # {holeNumber, strokes, par}
    rounds_analyzed = 0

    for rnd in rounds:
        holes_by_num = {h["number"]: h for h in rnd.get("holes", [])}
        scores = rnd.get("scores", [])
        # We analyze the first player's scores (owner) or all scores
        # In practice, the frontend should send only the user's rounds
        player_scores = scores
        if not player_scores:
            continue

        rounds_analyzed += 1
        for s in player_scores:
            hole_num = s.get("holeNumber")
            strokes = s.get("strokes")
            if strokes is None or hole_num is None:
                continue
            hole = holes_by_num.get(hole_num, {})
            par = hole.get("par", 4)
            all_scores.append({
                "holeNumber": hole_num,
                "strokes": strokes,
                "par": par,
                "courseId": rnd.get("courseId"),
            })

    if not all_scores:
        return _default_stats(handicap)

    # Scoring distribution
    total_holes = len(all_scores)
    eagles = sum(1 for s in all_scores if s["strokes"] <= s["par"] - 2) / total_holes * 100
    birdies = sum(1 for s in all_scores if s["strokes"] == s["par"] - 1) / total_holes * 100
    pars = sum(1 for s in all_scores if s["strokes"] == s["par"]) / total_holes * 100
    bogeys = sum(1 for s in all_scores if s["strokes"] == s["par"] + 1) / total_holes * 100
    doubles = sum(1 for s in all_scores if s["strokes"] == s["par"] + 2) / total_holes * 100
    triples = sum(1 for s in all_scores if s["strokes"] >= s["par"] + 3) / total_holes * 100

    # Par averages
    par3_scores = [s["strokes"] for s in all_scores if s["par"] == 3]
    par4_scores = [s["strokes"] for s in all_scores if s["par"] == 4]
    par5_scores = [s["strokes"] for s in all_scores if s["par"] == 5]

    par_avg = ParAverages(
        par3=sum(par3_scores) / len(par3_scores) if par3_scores else 3.5,
        par4=sum(par4_scores) / len(par4_scores) if par4_scores else 4.8,
        par5=sum(par5_scores) / len(par5_scores) if par5_scores else 5.5,
    )

    # Tendencies
    doubles_total = sum(1 for s in all_scores if s["strokes"] >= s["par"] + 2)
    doubles_per_round = doubles_total / max(rounds_analyzed, 1)

    par5_bogey = sum(1 for s in all_scores if s["par"] == 5 and s["strokes"] >= 6)
    par5_total = len(par5_scores)
    par5_bogey_rate = (par5_bogey / par5_total * 100) if par5_total > 0 else 20.0

    # Miss direction heuristic: handicap-based assumption
    # Without shot tracking, we estimate from scoring patterns
    # Higher handicap players tend to have a dominant miss direction
    miss_direction = "balanced"
    if handicap is not None:
        if handicap > 20:
            miss_direction = "right"  # Most high-handicap slicers
        elif handicap > 10:
            miss_direction = "right"  # Still predominantly

    tendencies = PlayerTendencies(
        miss_direction=miss_direction,
        miss_short_pct=58.0 if (handicap or 15) > 10 else 52.0,
        miss_long_pct=42.0 if (handicap or 15) > 10 else 48.0,
        three_putts_per_round=max(0.5, min(5.0, (handicap or 15) * 0.15)),
        doubles_per_round=round(doubles_per_round, 1),
        par5_bogey_rate=round(par5_bogey_rate, 1),
        scoring_zone_bogey_rate=25.0,  # Need shot tracking for real data
    )

    return PlayerStatistics(
        handicap=handicap,
        rounds_analyzed=rounds_analyzed,
        scoring_distribution=ScoringDistribution(
            eagles=round(eagles, 1),
            birdies=round(birdies, 1),
            pars=round(pars, 1),
            bogeys=round(bogeys, 1),
            doubles=round(doubles, 1),
            triples_plus=round(triples, 1),
        ),
        par_averages=par_avg,
        tendencies=tendencies,
    )


def get_hole_history(
    rounds: list[dict],
    course_id: str,
    hole_number: int,
) -> Optional[HolePlayerHistory]:
    """Get player's scoring history on a specific hole."""
    scores_on_hole: list[int] = []
    par_on_hole = 4

    for rnd in rounds:
        if rnd.get("courseId") != course_id:
            continue
        holes_by_num = {h["number"]: h for h in rnd.get("holes", [])}
        hole = holes_by_num.get(hole_number, {})
        par_on_hole = hole.get("par", 4)

        for s in rnd.get("scores", []):
            if s.get("holeNumber") == hole_number and s.get("strokes") is not None:
                scores_on_hole.append(s["strokes"])

    if not scores_on_hole:
        return None

    avg = sum(scores_on_hole) / len(scores_on_hole)
    birdies = sum(1 for s in scores_on_hole if s < par_on_hole)
    bogeys = sum(1 for s in scores_on_hole if s > par_on_hole)

    return HolePlayerHistory(
        times_played=len(scores_on_hole),
        avg_score=round(avg, 2),
        best_score=min(scores_on_hole),
        worst_score=max(scores_on_hole),
        birdie_rate=round(birdies / len(scores_on_hole) * 100, 1),
        bogey_rate=round(bogeys / len(scores_on_hole) * 100, 1),
    )


def _default_stats(handicap: Optional[float]) -> PlayerStatistics:
    """Return default stats based on handicap when no round data available."""
    hcp = handicap or 15.0

    # Estimate scoring distribution from handicap
    if hcp <= 5:
        dist = ScoringDistribution(
            eagles=1.0, birdies=15.0, pars=50.0, bogeys=25.0, doubles=7.0, triples_plus=2.0
        )
        par_avg = ParAverages(par3=3.1, par4=4.2, par5=4.9)
    elif hcp <= 15:
        dist = ScoringDistribution(
            eagles=0.5, birdies=8.0, pars=35.0, bogeys=35.0, doubles=15.0, triples_plus=6.5
        )
        par_avg = ParAverages(par3=3.5, par4=4.8, par5=5.3)
    elif hcp <= 25:
        dist = ScoringDistribution(
            eagles=0.2, birdies=3.0, pars=20.0, bogeys=35.0, doubles=25.0, triples_plus=16.8
        )
        par_avg = ParAverages(par3=4.0, par4=5.3, par5=6.0)
    else:
        dist = ScoringDistribution(
            eagles=0.0, birdies=1.0, pars=10.0, bogeys=25.0, doubles=30.0, triples_plus=34.0
        )
        par_avg = ParAverages(par3=4.5, par4=5.8, par5=6.8)

    return PlayerStatistics(
        handicap=handicap,
        rounds_analyzed=0,
        scoring_distribution=dist,
        par_averages=par_avg,
        tendencies=PlayerTendencies(
            miss_direction="right" if hcp > 10 else "balanced",
            miss_short_pct=58.0 if hcp > 10 else 52.0,
            miss_long_pct=42.0 if hcp > 10 else 48.0,
            three_putts_per_round=max(0.5, hcp * 0.15),
            doubles_per_round=max(0.5, hcp * 0.15),
        ),
    )
