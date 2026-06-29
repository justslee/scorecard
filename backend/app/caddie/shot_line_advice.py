"""Tactical advice for the terrain shape along the shot path.

This module is DISTINCT from the two existing elevation-aware advisors:

1. ``compute_adjustments`` (``club_selection.py``) — adjusts the *numeric*
   target distance for net tee→green elevation change (roughly ±1 yd per 3 ft).
   This module does NOT duplicate that.

2. ``slope_advice.py`` — advises on *green-surface* slope and which side of the
   cup to leave the ball.  This module does NOT duplicate that either.

What this module adds
---------------------
It reads the *profile* — a short sequence of elevations sampled at roughly
equal spacing from the shot start (index 0) to the target (index -1) — and
returns ONE concise string of **explanatory tactical color** about terrain
*shape*:

- **Elevated green**: the approach still rises through its final half →
  commit to a full, clean strike so the ball carries the face cleanly.
- **Downhill landing zone**: target is well below the start → extra release;
  plan the carry short of the flag.
- **Ridge across the path**: a mid-line peak stands clearly above both
  endpoints → balls on the downslope release; land short of the crest.
- **Swale across the path**: a mid-line valley dips below both endpoints →
  low landings kick forward; carry past the low point.
- **Flat / sub-threshold terrain** → ``None`` (no noise).

None of these translate to a numeric yardage change — that is handled
elsewhere.  This is purely explanatory color: the *why* behind the shot feel.

Sampling helper
---------------
``sample_shot_line`` is the async helper that samples real elevations from the
USGS 3DEP endpoint; it uses a lazy import of ``fetch_3dep_samples`` so
importing this module does NOT trigger the DB engine at load time.  Tests
call ``shot_line_advice`` directly with fixture data and never reach the
network.
"""

from __future__ import annotations

from typing import Optional

# ── Thresholds (feet) ──────────────────────────────────────────────────────────
# Documented here so tests can import them directly without magic numbers.

#: Minimum net elevation change (start → end) for elevated-green or downhill
#: advice.  Terrain changes under 10 ft are well-covered by the numeric
#: distance adjustment; adding verbal color below this threshold adds noise.
NET_CHANGE_THRESHOLD_FT: float = 10.0

#: The second half of the profile must still be rising by at least this much
#: for the "elevated green" shape to be confirmed — i.e. the approach itself
#: is climbing toward the green, not just an early hill followed by a flat finish.
END_RISE_THRESHOLD_FT: float = 5.0

#: A mid-line peak or valley must stand this far above/below BOTH the start
#: AND end elevations to register as a meaningful ridge or swale.  Below this
#: the terrain variation is too gentle to alter shot strategy.
MID_FEATURE_THRESHOLD_FT: float = 8.0


def shot_line_advice(
    profile_ft: list[float],
    shot_distance_yds: int,
) -> Optional[str]:
    """Return concise terrain-shape advice, or ``None`` for flat/sub-threshold.

    This is a **pure function** — no I/O, no network, no database.  Pass
    fixture elevations in tests; pass live-sampled profiles in production.

    Args:
        profile_ft: Elevation samples in feet, ordered from shot start (index 0)
            to the target (index -1).  Minimum 2 points; fewer returns
            ``None`` silently.  Samples should be spaced at roughly equal
            intervals but exact spacing is not required — only the order and
            relative magnitudes matter.
        shot_distance_yds: Full shot distance in yards.  Currently unused in
            the threshold logic but included in the signature so the API is
            stable when distance-scaled thresholds are added in a future pass.

    Returns:
        A single tactical sentence (str), or ``None`` when the terrain is
        flat or no feature clears the significance threshold.

    Classification (in priority order):
        1. Mid-line ridge  (peak clears BOTH endpoints by ≥ MID_FEATURE_THRESHOLD_FT)
        2. Mid-line valley (valley drops below BOTH endpoints by ≥ MID_FEATURE_THRESHOLD_FT)
        3. Elevated green  (net ≥ NET_CHANGE_THRESHOLD_FT AND end-half rise ≥ END_RISE_THRESHOLD_FT)
        4. Downhill zone   (net ≤ −NET_CHANGE_THRESHOLD_FT)
        5. None            (everything else)
    """
    if len(profile_ft) < 2:
        return None

    start_ft = profile_ft[0]
    end_ft = profile_ft[-1]
    net_change = end_ft - start_ft
    n = len(profile_ft)

    # Points between the endpoints (may be empty for a 2-point profile).
    mid_section = profile_ft[1:-1]

    # ── 1. Mid-line ridge ─────────────────────────────────────────────────────
    # A peak in the middle that rises CLEARLY above both endpoints signals a
    # terrain rise crossing the shot path.  Balls landing on the downslope past
    # the crest will release; landing on the upslope will check.
    if mid_section:
        peak = max(mid_section)
        both_ends_high = max(start_ft, end_ft)
        if peak - both_ends_high >= MID_FEATURE_THRESHOLD_FT:
            return (
                "A rise crosses the shot line — balls landing on the downslope "
                "will release; favor landing short of the crest for control"
            )

    # ── 2. Mid-line valley / swale ────────────────────────────────────────────
    # A valley that dips well below both endpoints: a low landing will kick
    # forward past the low point; carry it past the dip for a cleaner stop.
    if mid_section:
        valley = min(mid_section)
        both_ends_low = min(start_ft, end_ft)
        if both_ends_low - valley >= MID_FEATURE_THRESHOLD_FT:
            return (
                "The shot carries over a swale — a low landing will kick "
                "forward; carry past the low point for a predictable stop"
            )

    # ── 3. Elevated green (net uphill + still climbing in the second half) ────
    # The numeric distance adjustment already adds yards for the net rise; this
    # advice adds color: the ball must carry the face cleanly so no thin miss
    # loses the carry height.
    #
    # ``mid_idx`` is the reference point for the "second half" rise check:
    #   n=2 → min(0, 1) = 0  (end_rise = net_change; for 2-pt profiles the
    #                          whole profile is the "second half")
    #   n=3 → min(1, 1) = 1  (rise from midpoint to end)
    #   n=5 → min(3, 2) = 2  (rise from midpoint to end)
    if net_change >= NET_CHANGE_THRESHOLD_FT:
        mid_idx = min(n - 2, n // 2)  # always in range [0, n-2]
        end_rise = end_ft - profile_ft[mid_idx]
        if end_rise >= END_RISE_THRESHOLD_FT:
            return (
                "Approach to an elevated green — the ball must carry to the face; "
                "commit to a full, clean strike with the chosen club"
            )

    # ── 4. Downhill landing zone ──────────────────────────────────────────────
    # Target is well below the start: the ball releases further than on flat
    # ground.  Land it short so it runs to the flag rather than bounding past.
    if net_change <= -NET_CHANGE_THRESHOLD_FT:
        return (
            "Downhill landing zone — expect the ball to release further than "
            "normal; land it short of the flag and let it run to the hole"
        )

    return None


# ── Async sampling helper ──────────────────────────────────────────────────────


async def sample_shot_line(
    tee_lat: float,
    tee_lng: float,
    target_lat: float,
    target_lng: float,
    n_intermediate: int = 3,
) -> Optional[list[float]]:
    """Sample elevations at equal intervals along the shot line.

    Uses ``fetch_3dep_samples`` (a single HTTP round-trip to the USGS 3DEP
    ArcGIS ImageServer).  The import is **lazy** so importing this module does
    NOT initialise the DB engine — tests can use ``shot_line_advice`` directly
    without any DB stubs.

    Args:
        tee_lat, tee_lng:       WGS-84 start coordinates (tee or player position).
        target_lat, target_lng: WGS-84 target coordinates (pin or landing zone).
        n_intermediate:         Number of intermediate sample points (default 3,
                                giving 5 total: start + 3 + end).

    Returns:
        List of ``n_intermediate + 2`` elevations in feet (start … end), with
        ``None`` intermediates filled by linear interpolation.  Returns ``None``
        when either endpoint elevation is unavailable.
    """
    # Lazy import keeps the DB engine out of the module-level init chain.
    from app.services.elevation import fetch_3dep_samples

    n_total = n_intermediate + 2
    # Build equally-spaced points from tee (t=0) to target (t=1).
    points = [
        (
            tee_lat + (target_lat - tee_lat) * i / (n_total - 1),
            tee_lng + (target_lng - tee_lng) * i / (n_total - 1),
        )
        for i in range(n_total)
    ]

    raw = await fetch_3dep_samples(points)

    # Endpoints must be valid — without them the profile is meaningless.
    if raw[0] is None or raw[-1] is None:
        return None

    # Fill in any None intermediates with linear interpolation between their
    # nearest non-None neighbours (rare for US courses within 3DEP coverage).
    filled: list[float] = []
    for i, val in enumerate(raw):
        if val is not None:
            filled.append(val)
            continue
        # Search outward for bracketing known values.
        lo_i = next((j for j in range(i - 1, -1, -1) if raw[j] is not None), 0)
        hi_i = next((j for j in range(i + 1, n_total) if raw[j] is not None), n_total - 1)
        lo_v: float = raw[lo_i] if raw[lo_i] is not None else raw[0]  # type: ignore[assignment]
        hi_v: float = raw[hi_i] if raw[hi_i] is not None else raw[-1]  # type: ignore[assignment]
        t = (i - lo_i) / (hi_i - lo_i) if hi_i != lo_i else 0.0
        filled.append(lo_v + t * (hi_v - lo_v))

    return filled
