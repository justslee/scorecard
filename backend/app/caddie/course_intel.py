"""Course intelligence engine - builds per-hole analysis from data sources."""

import logging
import math
from typing import Optional
from app.caddie.types import (
    HoleIntelligence,
    Hazard,
    GreenSlope,
    WeatherConditions,
)
from app.services.elevation import (
    fetch_elevation_cached,
    compute_green_slope,
    compute_hole_elevation_profile,
)
from app.services.weather import (
    fetch_weather,
    compute_air_density_factor,
    estimate_conditions,
)
from app.services import courses_mapped

log = logging.getLogger("looper.course_intel")



async def build_hole_intelligence(
    hole_coords: dict,
    par: Optional[int] = 4,
    yards: Optional[int] = 400,
    handicap_rating: Optional[int] = 9,
    osm_features: Optional[dict] = None,
    persisted_elevation: Optional[dict] = None,
    course_id: Optional[str] = None,
) -> HoleIntelligence:
    """Build intelligence for a single hole from coordinates + data sources.

    Args:
        hole_coords: {holeNumber, green: {lat, lng}, tee?: {lat, lng}, front?, back?}
        par: Hole par
        yards: Hole yardage
        handicap_rating: Hole handicap index
        osm_features: Nearby OSM features (bunkers, water, etc.)
        persisted_elevation: The stored green feature's `properties` dict, when
            available — carries `tee_elevation_ft`/`green_elevation_ft`/
            `delta_ft`/`green_slope` persisted by a prior compute (this
            function's own write-back, ingest, or precompute). When both
            elevations are present, this is used and NO USGS/3DEP calls are
            made.
        course_id: When set (and `persisted_elevation` misses), a genuine live
            compute with real tee AND green elevations is written back into
            the stored green feature via a targeted JSONB merge — best-effort,
            never sinks the response.

    Returns:
        HoleIntelligence with elevation, hazards, green slope, etc.
    """
    hole_number = hole_coords.get("holeNumber", 1)
    # `.get(..., 1)` only defaults an ABSENT key — an explicit `holeNumber:
    # null` still comes through as None here, which `HoleIntelligence.hole_number`
    # (a required `int` field) cannot accept and would drop the whole hole's
    # intel. Coalesce that one case so display is never dropped; every other
    # malformed shape (str/float/bool/huge int) is already int-coercible by
    # pydantic and passes through unchanged (write-back gating is separate,
    # below, and unaffected by this).
    if hole_number is None:
        hole_number = 1
    # RAW candidate for the write-back key — NO default. A defaulted "1" must
    # never become the write-back destination for a request that genuinely
    # omitted holeNumber (that would silently persist elevation onto stored
    # hole 1). `hole_number` above stays display-only.
    raw_hole_number = hole_coords.get("holeNumber")
    green = hole_coords.get("green", {})
    tee = hole_coords.get("tee")

    # The route passes raw request values, which may be null (stored round
    # with no yardage). Coalesce display-only ints to defaults; keep yards
    # HONEST — unknown yardage must not become a fabricated 400 (owner: no
    # fake-data fallbacks). bool excluded (bool is an int subclass).
    par = par if isinstance(par, int) and not isinstance(par, bool) else 4
    handicap_rating = (
        handicap_rating
        if isinstance(handicap_rating, int) and not isinstance(handicap_rating, bool)
        else 9
    )
    yards = (
        int(round(yards))
        if isinstance(yards, (int, float)) and not isinstance(yards, bool)
        else None
    )

    # Elevation + green slope — read persisted static data first (ZERO
    # USGS/3DEP calls on a cache hit); otherwise compute live (unchanged
    # behavior) and best-effort write the result back for next time.
    elevation_change = 0.0
    green_slope_data = None

    persisted_hit = (
        persisted_elevation is not None
        and persisted_elevation.get("tee_elevation_ft") is not None
        and persisted_elevation.get("green_elevation_ft") is not None
    )

    if persisted_hit:
        # READ PATH — zero USGS/3DEP. Prefer stored delta_ft; fall back to
        # (green - tee) if delta_ft somehow absent.
        delta = persisted_elevation.get("delta_ft")
        if delta is None:
            delta = persisted_elevation["green_elevation_ft"] - persisted_elevation["tee_elevation_ft"]
        elevation_change = float(delta)
        gs = persisted_elevation.get("green_slope")
        if gs:
            green_slope_data = GreenSlope(
                direction=gs["direction"],
                severity=gs["severity"],
                percent_grade=gs["percent_grade"],
                description=gs["description"],
            )
    else:
        # LIVE COMPUTE — unchanged behavior, plus write-back.
        tee_elev = green_elev = None
        if tee and green:
            tee_elev = await fetch_elevation_cached(tee["lat"], tee["lng"])
            green_elev = await fetch_elevation_cached(green["lat"], green["lng"])
            if tee_elev is not None and green_elev is not None:
                elevation_change = green_elev - tee_elev  # positive = uphill

        slope_result = await compute_green_slope(green) if green else None
        if slope_result:
            green_slope_data = GreenSlope(
                direction=slope_result["direction"],
                severity=slope_result["severity"],
                percent_grade=slope_result["percent_grade"],
                description=slope_result["description"],
            )

        # WRITE-BACK — only on a genuine compute with BOTH real elevations AND
        # a validated write-back key (never the defaulted `hole_number` — a
        # request with no/garbage holeNumber must not silently mis-write).
        # Never synthesize 0/None to fill a gap (the "+0ft" lesson): if either
        # endpoint is None, persist nothing (absent stays absent).
        if course_id and tee_elev is not None and green_elev is not None:
            if courses_mapped._valid_hole_number(raw_hole_number):
                profile = compute_hole_elevation_profile(
                    tee_elev, green_elev, slope_result  # slope_result is the raw dict|None
                )
                try:
                    await courses_mapped.update_green_feature_properties(
                        course_id, raw_hole_number, courses_mapped._elevation_patch(profile)
                    )
                except Exception:  # noqa: BLE001 — persistence is best-effort; never sink intel
                    log.warning(
                        "elevation write-back failed for hole %s", raw_hole_number, exc_info=True
                    )
            else:
                log.debug(
                    "skip elevation write-back: invalid holeNumber %r (course %s)",
                    raw_hole_number, course_id,
                )

    # Effective distance adjusted for elevation
    effective_yards = None if yards is None else yards + round(elevation_change / 3)

    # Classify hazards from OSM features. DEFENSIVE: a single malformed OSM
    # feature must never destroy the whole hole's intel — the computed
    # elevation/effective yards above are more valuable than the hazard list
    # (owner's 2026-07-07 round: a hazard-block exception per hole surfaced
    # as elevation '0ft' on every tile because the route's per-hole catch
    # discarded everything).
    hazards: list[Hazard] = []
    try:
        hazards = _classify_osm_hazards(osm_features, green, tee)
    except Exception:  # noqa: BLE001 — hazards are best-effort by design
        log.warning("hazard classification failed; continuing without", exc_info=True)
        hazards = []
    return HoleIntelligence(
        hole_number=hole_number,
        par=par,
        yards=yards,
        handicap_rating=handicap_rating,
        elevation_change_ft=round(elevation_change, 1),
        effective_yards=effective_yards,
        green_slope=green_slope_data,
        hazards=hazards,
    )


def _classify_osm_hazards(osm_features, green, tee) -> list[Hazard]:
    """Bunker/water hazards from raw OSM features, classified vs the green.
    Callers wrap this — one malformed feature must never sink a hole's intel."""
    hazards: list[Hazard] = []
    if not osm_features or not green:
        return hazards

    def _valid(pt) -> bool:
        # Malformed OSM centers must be SKIPPED, not classified: missing keys
        # once produced a 'bunker at 9,429,088 yards' via .get() defaults.
        return (
            isinstance(pt, dict)
            and isinstance(pt.get("lat"), (int, float))
            and isinstance(pt.get("lng"), (int, float))
        )

    # Process bunkers
    for bunker in osm_features.get("bunkers", []):
        center = bunker.get("center", {})
        if not _valid(center):
            continue
        dist = _distance_yards(center, green)
        side = _classify_side(center, green, tee)
        severity = "moderate" if dist < 10 else "mild"
        hazards.append(Hazard(
            type="bunker",
            side=side,
            distance_from_green=round(dist),
            penalty_severity=severity,
            lat=center.get("lat"),
            lng=center.get("lng"),
        ))
    # Process water
    for water in osm_features.get("water", []):
        center = water.get("center", {})
        if not _valid(center):
            continue
        dist = _distance_yards(center, green)
        if dist > 100:
            continue  # too far to be relevant
        side = _classify_side(center, green, tee)
        hazards.append(Hazard(
            type="water",
            side=side,
            distance_from_green=round(dist),
            penalty_severity="death",
            lat=center.get("lat"),
            lng=center.get("lng"),
        ))
    return hazards


async def build_weather_conditions(
    lat: float,
    lng: float,
) -> WeatherConditions:
    """Fetch and build weather conditions for a course location."""
    try:
        weather_data = await fetch_weather(lat, lng)
    except Exception:
        return WeatherConditions()

    # Get course elevation
    altitude = await fetch_elevation_cached(lat, lng)
    altitude_ft = altitude if altitude is not None else 0.0

    # Air density
    density = compute_air_density_factor(
        weather_data["temperature_f"],
        weather_data["humidity"],
        weather_data["pressure_hpa"],
        altitude_ft,
    )

    # Conditions estimate
    conditions = estimate_conditions(
        weather_data["temperature_f"],
        weather_data["humidity"],
        weather_data["precipitation_mm"],
    )

    return WeatherConditions(
        temperature_f=weather_data["temperature_f"],
        humidity=weather_data["humidity"],
        wind_speed_mph=weather_data["wind_speed_mph"],
        wind_direction=int(weather_data["wind_direction"]),
        wind_gusts_mph=weather_data["wind_gusts_mph"],
        pressure_hpa=weather_data["pressure_hpa"],
        altitude_ft=altitude_ft,
        air_density_factor=round(density, 4),
        conditions=conditions,
    )


def _distance_yards(p1: dict, p2: dict) -> float:
    """Approximate distance between two lat/lng points in yards."""
    lat1, lng1 = math.radians(p1.get("lat", 0)), math.radians(p1.get("lng", 0))
    lat2, lng2 = math.radians(p2.get("lat", 0)), math.radians(p2.get("lng", 0))

    dlat = lat2 - lat1
    dlng = lng2 - lng1

    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    meters = 6371000 * c
    return meters * 1.09361  # meters to yards


def _classify_side(
    feature: dict,
    green: dict,
    tee: Optional[dict],
) -> str:
    """Classify which side of the green a feature is on (left/right/front/back)."""
    if not tee:
        return "center"

    # Vector from tee to green (the "hole direction")
    hole_bearing = math.atan2(
        green.get("lng", 0) - tee.get("lng", 0),
        green.get("lat", 0) - tee.get("lat", 0),
    )

    # Vector from green to feature
    feature_bearing = math.atan2(
        feature.get("lng", 0) - green.get("lng", 0),
        feature.get("lat", 0) - green.get("lat", 0),
    )

    # Angle difference
    angle_diff = math.degrees(feature_bearing - hole_bearing) % 360

    # Classify
    if angle_diff < 45 or angle_diff > 315:
        return "back"
    elif 45 <= angle_diff < 135:
        return "right"
    elif 135 <= angle_diff < 225:
        return "front"
    else:
        return "left"
