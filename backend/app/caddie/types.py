"""Caddie system Pydantic models."""

from pydantic import BaseModel
from typing import Optional


# ── Player Statistics (derived from round history) ──


class StrokesGained(BaseModel):
    off_the_tee: float = 0.0
    approach: float = 0.0
    short_game: float = 0.0
    putting: float = 0.0
    total: float = 0.0


class ScoringDistribution(BaseModel):
    eagles: float = 0.0
    birdies: float = 0.0
    pars: float = 0.0
    bogeys: float = 0.0
    doubles: float = 0.0
    triples_plus: float = 0.0


class ParAverages(BaseModel):
    par3: float = 3.5
    par4: float = 4.8
    par5: float = 5.5


class PlayerTendencies(BaseModel):
    miss_direction: str = "balanced"  # left | right | balanced
    miss_short_pct: float = 55.0  # % of misses short
    miss_long_pct: float = 45.0
    three_putts_per_round: float = 2.0
    doubles_per_round: float = 2.0
    par5_bogey_rate: float = 20.0
    scoring_zone_bogey_rate: float = 25.0  # bogey from <150 yards


class PlayerStatistics(BaseModel):
    handicap: Optional[float] = None
    rounds_analyzed: int = 0
    strokes_gained: StrokesGained = StrokesGained()
    scoring_distribution: ScoringDistribution = ScoringDistribution()
    par_averages: ParAverages = ParAverages()
    tendencies: PlayerTendencies = PlayerTendencies()


# ── Hazard ──


class Hazard(BaseModel):
    type: str  # water | bunker | ob | trees | slope
    side: str  # left | right | front | back | center
    distance_from_green: float = 0.0  # yards
    penalty_severity: str = "moderate"  # mild | moderate | severe | death
    lat: Optional[float] = None
    lng: Optional[float] = None


# ── Green Slope ──


class GreenSlope(BaseModel):
    direction: float = 0.0  # degrees
    severity: str = "flat"  # flat | mild | moderate | severe
    percent_grade: float = 0.0
    description: str = "No data"


# ── Hole Intelligence ──


class HolePlayerHistory(BaseModel):
    times_played: int = 0
    avg_score: float = 0.0
    best_score: int = 0
    worst_score: int = 0
    birdie_rate: float = 0.0
    bogey_rate: float = 0.0


class HoleIntelligence(BaseModel):
    hole_number: int
    par: int
    yards: int
    handicap_rating: int = 9
    elevation_change_ft: float = 0.0
    effective_yards: int = 0  # adjusted for elevation
    green_slope: Optional[GreenSlope] = None
    green_depth_yards: Optional[float] = None
    green_width_yards: Optional[float] = None
    hazards: list[Hazard] = []
    pin_traffic_light: str = "green"  # green | yellow | red
    player_history: Optional[HolePlayerHistory] = None


# ── Weather ──


class WeatherConditions(BaseModel):
    temperature_f: float = 70.0
    humidity: float = 50.0
    wind_speed_mph: float = 0.0
    wind_direction: int = 0
    wind_gusts_mph: float = 0.0
    pressure_hpa: float = 1013.25
    altitude_ft: float = 0.0
    air_density_factor: float = 1.0
    conditions: str = "medium"  # soft | medium | firm


# ── Adjustments ──


class ShotAdjustment(BaseModel):
    type: str  # wind | elevation | temperature | altitude | conditions
    yards: int = 0
    description: str = ""


# ── Miss Side ──


class MissSide(BaseModel):
    preferred: str  # left | right | short | long
    description: str = ""
    avoid: str = ""


# ── Aim Point ──


class AimPoint(BaseModel):
    description: str = "Center of green"
    lat: Optional[float] = None
    lng: Optional[float] = None
    bearing: Optional[float] = None


# ── The Big Recommendation ──


class CaddieRecommendation(BaseModel):
    club: str = ""
    target_yards: int = 0  # adjusted distance
    raw_yards: int = 0  # actual distance
    aim_point: AimPoint = AimPoint()
    reasoning: list[str] = []
    miss_side: MissSide = MissSide(preferred="center")
    adjustments: list[ShotAdjustment] = []
    confidence: float = 0.5
    aggressiveness: str = "moderate"  # conservative | moderate | aggressive
    expected_score: Optional[float] = None
    personality_advice: Optional[str] = None


# ── Caddie Personality ──


class VoiceStyle(BaseModel):
    pitch: float = 1.0
    rate: float = 1.0
    voice_preference: Optional[str] = None


class CaddiePersonality(BaseModel):
    id: str
    name: str
    description: str
    avatar: str  # emoji
    system_prompt: str
    voice_style: VoiceStyle = VoiceStyle()
    response_style: str = "conversational"  # brief | detailed | conversational
    traits: list[str] = []


# ── API Request/Response ──


class CourseIntelRequest(BaseModel):
    hole_coordinates: list[dict]  # [{holeNumber, green: {lat, lng}, tee?, front?, back?}]
    course_lat: Optional[float] = None
    course_lng: Optional[float] = None


class RecommendationRequest(BaseModel):
    hole_number: int
    distance_yards: Optional[int] = None
    player_lat: Optional[float] = None
    player_lng: Optional[float] = None
    hole_coordinates: Optional[dict] = None  # {green, tee, front, back}
    weather: Optional[WeatherConditions] = None
    hole_intelligence: Optional[HoleIntelligence] = None
    club_distances: dict[str, int] = {}
    handicap: Optional[float] = None
    player_stats: Optional[PlayerStatistics] = None
    par: int = 4
    yards: int = 400


class VoiceCaddieRequest(BaseModel):
    transcript: str
    personality_id: str = "classic"
    hole_number: int = 1
    par: int = 4
    yards: int = 400
    distance_yards: Optional[int] = None
    wind_speed_mph: float = 0.0
    wind_direction: int = 0
    club_distances: dict[str, int] = {}
    handicap: Optional[float] = None
    current_recommendation: Optional[dict] = None
    conversation_history: list[dict] = []


class VoiceCaddieResponse(BaseModel):
    response: str
    updated_recommendation: Optional[dict] = None
    follow_up: Optional[str] = None


class PlayerStatsRequest(BaseModel):
    rounds: list[dict]  # round objects from frontend
    handicap: Optional[float] = None
    course_id: Optional[str] = None  # for course-specific history
