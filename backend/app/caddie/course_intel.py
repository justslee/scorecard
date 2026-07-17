"""Course intelligence engine - builds per-hole analysis from data sources.

NOT `app.caddie.course_intel_writer` (course-discovery-intel) — that module
writes a course-level, precomputed Augusta-styled DESCRIPTION for course
DISCOVERY (the map tap-sheet + course detail page), a distinct, unrelated
system built later. See that module's docstring for the reciprocal note.
This module (the live per-hole caddie intelligence builder) is never
imported by `course_intel_writer.py`.
"""

import logging
from typing import Optional
from app.caddie.green_geometry import approach_bearing_deg as compute_approach_bearing_deg
from app.caddie.physics import elevation_only_plays_like
from app.caddie.types import (
    HoleIntelligence,
    Hazard,
    GreenSlope,
    HoleStrategyGuide,
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
    persisted_elevation: Optional[dict] = None,
    course_id: Optional[str] = None,
    persisted_guide: Optional[dict] = None,
) -> HoleIntelligence:
    """Build intelligence for a single hole from coordinates + data sources.

    Args:
        hole_coords: {holeNumber, green: {lat, lng}, tee?: {lat, lng}, front?, back?}
        par: Hole par
        yards: Hole yardage
        handicap_rating: Hole handicap index
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
        persisted_guide: The stored green feature's `properties.strategy_guide`
            dict, when present — written once by the offline research writer
            (`app.caddie.guide_writer.research_hole_guide` + `validate_guide`)
            and cached forever; a cold/never-researched hole simply has none.
            Best-effort parsed into a `HoleStrategyGuide`; a missing/malformed
            blob NEVER raises and simply yields `strategy_guide=None`
            ([[no-fake-data-fallbacks]]).

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

    # Tee->green approach bearing (green_geometry's rotation frame for
    # get_green_read) — pure, no I/O. No tee coords -> None (honest; the
    # tool degrades to "can't orient the slope to your line" rather than
    # guessing a travel direction).
    bearing: Optional[float] = None
    if tee and green:
        bearing = compute_approach_bearing_deg(
            tee["lat"], tee["lng"], green["lat"], green["lng"]
        )

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

    # Effective distance adjusted for elevation — physics-engine plays-like
    # (Δcarry ≈ Δh / tan(descent angle) for the club covering the distance),
    # replacing the club-independent 1yd/3ft rule (plan step 9). Semantics
    # unchanged: pin-relative, elevation-only, still air — live wind belongs
    # to the get_shot_distance tool, not this static per-hole number.
    effective_yards = (
        None if yards is None else elevation_only_plays_like(yards, elevation_change)
    )

    # Hazards: this function no longer classifies them at all. The OSM-derived
    # classifier that used to live here (`_classify_osm_hazards`/
    # `_classify_side`) computed side with no cos(lat) longitude scaling and
    # measured bearing FROM THE GREEN instead of the tee->green travel
    # direction — it silently mislabeled sides (hazard-side-flip incident,
    # 2026-07-08) and has been deleted rather than fixed, so there is exactly
    # ONE hazard-geometry path in the app: `hazards.extract_hole_hazards`,
    # which the caller (routes/caddie.py) applies on top of this function's
    # result when the round resolves to a curated, stored-geometry course.
    # An unmapped course now honestly reports no hazards — never a guessed
    # side — which triggers HAZARD_GROUNDING_RULE's generic-language
    # fallback in the caddie prompt ([[no-fake-data-fallbacks]]).
    hazards: list[Hazard] = []

    # Strategy guide — read-through of the offline-researched, grounding-
    # validated blob cached forever in the green feature's JSONB. Best-effort
    # parse: a missing/malformed blob must never sink the rest of the hole's
    # intel (same defensive style as persisted_elevation above).
    strategy_guide: Optional[HoleStrategyGuide] = None
    if persisted_guide is not None:
        try:
            strategy_guide = HoleStrategyGuide(**persisted_guide)
        except Exception:  # noqa: BLE001 — a malformed/partial blob -> honest None
            log.warning(
                "strategy_guide parse failed for hole %s; continuing without",
                hole_number, exc_info=True,
            )
            strategy_guide = None

    return HoleIntelligence(
        hole_number=hole_number,
        par=par,
        yards=yards,
        handicap_rating=handicap_rating,
        elevation_change_ft=round(elevation_change, 1),
        effective_yards=effective_yards,
        green_slope=green_slope_data,
        hazards=hazards,
        strategy_guide=strategy_guide,
        approach_bearing_deg=bearing,
    )


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
