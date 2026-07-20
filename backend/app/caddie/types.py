"""Caddie system Pydantic models."""

from pydantic import BaseModel, Field
from typing import Literal, Optional


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
    # Personal expected-strokes table from logged shots; replaces PGA fallback when populated.
    # Shape: {"fairway": {"100": {"mean_strokes": 2.65, "samples": 12}, ...}, ...}
    personal_sg: dict = {}


# ── Hazard ──


class Hazard(BaseModel):
    type: str  # water | bunker | ob | trees | slope
    side: str  # left | right | front | back | center
    distance_from_green: float = 0.0  # yards
    penalty_severity: str = "moderate"  # mild | moderate | severe | death
    lat: Optional[float] = None
    lng: Optional[float] = None
    # Tee→green line math (app/caddie/hazards.py) — additive, defaulted so
    # older cached HoleIntelligence JSONB still validates.
    carry_yards: int = 0  # yards from the tee along the tee→green line
    line_side: str = "center"  # left | right | center, relative to tee→green travel


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


class LoreItem(BaseModel):
    """One researched, attributed piece of local knowledge about a hole
    (specs/caddie-guide-local-lore-plan.md). Content-only — it doubles as the
    lore writer's structured-output item schema (like guide_writer._WriterOutput,
    provenance is stamped at the GUIDE level by research_hole_lore, never asked
    of the model). ALL fields defaulted so an older cached strategy_guide JSONB
    blob (no lore) and a partial item both still validate; validate_lore is the
    gate that decides what survives, per-item ([[no-fake-data-fallbacks]]).

    Incident (2026-07-20 backfill halt): `category` was a bare `str` — the
    writer prompt described the four buckets in prose but never stated their
    exact tokens, so the model emitted prose categories (e.g. "Green
    Character") that rule-2 of `validate_lore` correctly, but wastefully,
    dropped (10/18 items on the first course). `Literal` makes an invalid
    category IMPOSSIBLE to emit under structured output (`messages.parse`
    enforces the JSON-schema enum at generation time) instead of merely
    detectable after the fact."""

    text: str = ""          # ONE plain sentence, register-matched (calm, on-paper)
    category: Literal["green_character", "feature", "history", "architect_intent"] = "feature"
    source: str = ""        # short spoken attribution ("USGA championship notes") — NEVER a URL;
                            # empty = unattributed -> validate_lore drops the item
    # high | medium | low | unknown (self-reported). validate_lore's rule 5 keeps
    # "high" always and "medium" iff the item cleared rule 4's mandatory-source
    # gate (every surviving item already is, by construction) — see
    # guide_writer._LORE_CONFIDENCE_KEEP. "low"/"unknown" always drop.
    confidence: str = "unknown"


class HoleStrategyGuide(BaseModel):
    """Compact per-hole strategy guide, researched offline (see guide_writer.py)
    and cached FOREVER in the green feature's JSONB `properties.strategy_guide`
    (specs/caddie-hole-strategy-guides-plan.md §5). ALL fields defaulted so an
    older/partial cached blob still validates — a missing guide is simply None
    ([[no-fake-data-fallbacks]]: never a placeholder)."""

    play_line: str = ""  # 1 sentence: where to aim / start the tee shot or approach
    miss_side: str = ""  # 1 sentence: best miss + where NOT to miss
    green_notes: str = ""  # 1 sentence: green shape / break / pin-zone tendency
    common_mistakes: list[str] = Field(default_factory=list)  # 0-3 short items
    sources: list[str] = Field(default_factory=list)  # web URLs used (provenance; may be empty)
    generated_at: str = ""  # ISO 8601 timestamp of the write
    model: str = ""  # model id that wrote it (e.g. "claude-sonnet-5")
    schema_version: int = 1  # bump on shape change -> staleness re-research trigger
    # Researched LOCAL-LORE layer (specs/caddie-guide-local-lore-plan.md) —
    # additive + defaulted so every pre-lore cached JSONB blob still validates.
    # [] = no lore researched/surviving yet (honest omission, never a placeholder).
    local_lore: list[LoreItem] = Field(default_factory=list)
    # Guide-level lore provenance (ONE research call produces the whole batch —
    # per-item stamps would only bloat the JSONB and the prompt; the per-item
    # `source` field is the user-facing attribution, these are ops provenance).
    lore_generated_at: str = ""   # ISO 8601, stamped by research_hole_lore
    lore_model: str = ""          # model id that wrote the lore batch
    lore_sources: list[str] = Field(default_factory=list)  # audit URLs actually used — NEVER rendered into any prompt


class HoleBend(BaseModel):
    """Where/how far the fairway bends (the dogleg), measured from the tee
    along the hole's mapped centerline (app/caddie/hazards.py::extract_hole_bend).
    Additive on HoleIntelligence, defaulted, so cached session hole_intel
    JSONB predating this field still validates."""

    straight: bool = False
    direction: Optional[str] = None        # "left" | "right"; None when straight
    distance_yards: Optional[int] = None   # tee-anchored along-path, rounded to 5
    deviation_yards: int = 0               # max |perpendicular deviation| off the chord
    double_dogleg: bool = False


class CorridorSample(BaseModel):
    """One perpendicular cross-section of the playing corridor, sampled along
    the hole's mapped centerline (hazards.extract_corridor_profile). Additive
    on HoleIntelligence, defaulted, so cached session hole_intel JSONB
    predating this field still validates. None-valued sides/widths are honest
    unknowns — the consumer must never reject a club on an unknown width."""

    distance_yards: int                      # tee-anchored along-path (multiple of 10)
    left_yards: Optional[int] = None         # centerline -> nearest LEFT danger edge (trees/water)
    right_yards: Optional[int] = None
    width_yards: Optional[int] = None        # left+right; None unless BOTH sides known
    left_fairway_yards: Optional[int] = None  # fairway-edge cross-section (color, never the fit constraint)
    right_fairway_yards: Optional[int] = None
    left_source: Optional[str] = None        # "trees" | "water" (winning evidence)
    right_source: Optional[str] = None


class HoleIntelligence(BaseModel):
    hole_number: int
    par: int
    yards: Optional[int] = None
    handicap_rating: int = 9
    elevation_change_ft: float = 0.0
    effective_yards: Optional[int] = None  # adjusted for elevation; None = yardage unknown
    green_slope: Optional[GreenSlope] = None
    green_depth_yards: Optional[float] = None
    green_width_yards: Optional[float] = None
    hazards: list[Hazard] = []
    pin_traffic_light: str = "green"  # green | yellow | red
    player_history: Optional[HolePlayerHistory] = None
    # Elevations (ft) sampled at equal intervals along the shot path, from
    # start (index 0) to target (index -1).  Populated lazily by the route
    # handler via sample_shot_line(); None = no along-line profile available.
    shot_line_profile_ft: Optional[list[float]] = None
    # Persisted per-hole strategy guide (green feature JSONB, read-through via
    # build_hole_intelligence's `persisted_guide`); additive + defaulted so
    # cached session hole_intel JSONB predating this field still validates.
    # None = no guide cached yet (honest omission, never a placeholder).
    strategy_guide: Optional[HoleStrategyGuide] = None
    # Tee->green compass bearing (0=N, 90=E, clockwise) computed by
    # app.caddie.green_geometry.approach_bearing_deg when both tee and green
    # coords are known — the frame get_green_read rotates the stored green
    # slope into. Additive + defaulted so cached session hole_intel JSONB
    # predating this field still validates. None = no tee coords (unmapped
    # course, or a hole with no stored tee) — the caddie degrades honestly
    # rather than guessing a bearing.
    approach_bearing_deg: Optional[float] = None
    # Where/how far the fairway bends, from app.caddie.hazards.extract_hole_bend.
    # Additive + defaulted so cached session hole_intel JSONB predating this
    # field still validates. None = centerline unmapped (honest unknown,
    # distinct from a measured-straight hole — see HoleBend.straight).
    bend: Optional[HoleBend] = None
    # Per-hole corridor-width profile (danger-to-danger cross-sections every
    # 10y), from app.caddie.hazards.extract_corridor_profile. Additive +
    # defaulted so cached session hole_intel JSONB predating this field still
    # validates. None = unmapped/uncomputable (v1 behavior — the corridor-
    # width club-selection block in aim_point.py never runs).
    corridor: Optional[list[CorridorSample]] = None


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


# ── Tee-shot numbers (specs/caddie-numbers-coherence-plan.md §2.2) ──


class TeeShotNumbers(BaseModel):
    """ONE authoritative numbers block for a positioning/tee-shot turn.

    Owner incident (2026-07, Bethpage Black hole 1, 466y par 4): the caddie
    spoke a leave (125) solved from an unrelated wrong-input distance, a raw
    bag driver number (300), and a physics carry/total (280/266) — three
    truthful-in-isolation numbers from three sources that never had to agree.
    This block is computed ONCE (``compute_tee_shot_numbers``,
    app/caddie/aim_point.py) and is the only thing either mouth may speak for
    a tee shot.

    Invariant (tested): to_green_yards - drive_total_yards == leave_exact_yards,
    EXACTLY, for every instance this engine produces.
    """

    hole_number: int
    to_green_yards: int  # the raw distance the engine solved (466) — rec.raw_yards
    yardage_basis: Optional[str] = None  # 'gps' | 'tee-card' | 'tee-geom' | 'card' | None (provenance label)
    plays_like_yards: int  # rec.target_yards (physics plays-like of to_green_yards)
    club: str  # selected club key ("driver")
    club_stored_yards: int  # the bag number (300) — still-air stored distance
    drive_carry_yards: Optional[int] = None  # physics carry under today's conditions (266); None in competition_legal
    drive_total_yards: int  # physics total under today's conditions (276); == stored in competition_legal
    leave_exact_yards: int  # to_green_yards - drive_total_yards, SIGNED (may be <= 0) — closes EXACTLY
    leave_yards: int  # round-to-5 of max(0, leave_exact) (the calm, floored spoken number)
    leave_plays_like_yards: Optional[int] = None  # what that approach plays like (labeled extra, never the primary leave)
    # Corridor-width club selection (specs/corridor-width-club-selection-plan.md
    # §5) — additive, populated ONLY on profile-present turns where the width
    # rule fired or grounded the chosen club. All None on a v1 (corridor-
    # absent) turn, which is what keeps the no-regression test well-defined.
    corridor_pinch_width_yards: Optional[int] = None    # danger width at the pinch that rejected the longest club
    corridor_pinch_distance_yards: Optional[int] = None  # along-path distance of that pinch (== rejected club's total's sample)
    corridor_capped_from_club: Optional[str] = None     # rejected longest club key ("driver")
    corridor_capped_from_window_yards: Optional[int] = None  # its ±1.5σ window (rounded)
    corridor_club_window_yards: Optional[int] = None    # CHOSEN club's ±1.5σ window
    corridor_width_yards: Optional[int] = None          # danger width at the CHOSEN club's landing distance, when known
    # Expected-strokes club selection (specs/caddie-tee-club-expected-strokes-
    # plan.md §4) — REPLACES the hard fit-wall the fields above narrated.
    # Additive, populated ONLY on corridor-present turns where the E-model
    # actually ran. All None on a v1 (corridor-absent) turn, same convention
    # as the fields above.
    corridor_trouble_pct: Optional[int] = None      # CHOSEN club's total trouble probability (left+right), rounded %
    corridor_alt_club: Optional[str] = None         # best-rejected LONGER club considered ("driver"); None when no swap
    corridor_alt_trouble_pct: Optional[int] = None   # that alt club's own trouble probability, rounded %
    corridor_alt_leave_yards: Optional[int] = None   # that alt club's leave, for the tradeoff note
    # Deviation from the plan's literal field list (builder note): the plan's
    # swap-note template ("...lays back short of the water pinch at Z...")
    # names Z (the alt club's own landing distance — where the pinch actually
    # is) but the plan text never listed a payload field for it. Every OTHER
    # number the note speaks must be payload-grounded (plan §6's "note
    # numbers == payload numbers" gate), so this one additive field closes
    # that gap rather than silently dropping the "at Z" clause or citing an
    # ungrounded number.
    corridor_alt_total_yards: Optional[int] = None   # that alt club's own conditions total — the pinch's location


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
    competition_legal: bool = False  # True = USGA-conforming mode; all distance adjustments zeroed
    # Reachability classification (specs/caddie-shot-context-reachability-plan.md).
    # "approach" = today's flag-relative aim path (unchanged). "positioning" = the
    # green is out of reach on this swing; aim_point speaks landing-zone advice
    # instead of a pin-relative one. Defaulted so cached session.last_recommendation
    # JSONB from older rounds still validates (additive-field convention).
    shot_kind: str = "approach"  # "approach" | "positioning"
    leave_yards: Optional[int] = None  # positioning only: approach distance the drive leaves
    # ONE authoritative numbers block for a positioning/tee shot (see
    # TeeShotNumbers above) — None on reachable/approach turns and on any
    # cached recommendation from before this field existed (additive).
    tee_shot_numbers: Optional[TeeShotNumbers] = None


# ── Caddie Personality ──


class VoiceStyle(BaseModel):
    pitch: float = 1.0
    rate: float = 1.0
    voice_preference: Optional[str] = None


# Valid Realtime `audio.output.voice` enum values ONLY (confirmed against the
# GA Realtime session schema) — "fable", "onyx", and "nova" are legacy OpenAI
# TTS (v1/audio/speech) voices that the Realtime API REJECTS with an enum
# error at mint time. Single production source of truth: also used by
# `clamp_realtime_voice` (backend/app/services/realtime_relay.py) to coerce
# any invalid stored voice_id (e.g. a DB-sourced persona still carrying
# 'fable') before it reaches the mint. See
# backend/tests/eval/test_realtime_session_config.py, which holds an
# independent literal copy of this set as drift-alarm teeth.
VALID_REALTIME_VOICES: frozenset[str] = frozenset(
    {"alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"}
)


class CaddiePersonality(BaseModel):
    id: str
    name: str
    description: str
    avatar: str  # emoji
    system_prompt: str
    voice_style: VoiceStyle = VoiceStyle()
    response_style: str = "conversational"  # brief | detailed | conversational
    traits: list[str] = []
    # OpenAI Realtime tuning. Valid Realtime `audio.output.voice` enum values
    # ONLY — see VALID_REALTIME_VOICES above.
    voice_id: Optional[str] = None  # alloy | ash | ballad | coral | echo | sage | shimmer | verse | marin | cedar
    realtime_instructions: Optional[str] = None  # Spoken-style instructions; falls back to system_prompt


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
    shot_bearing: Optional[float] = None  # degrees from north toward target — feeds wind math
    hole_coordinates: Optional[dict] = None  # {green, tee, front, back}
    weather: Optional[WeatherConditions] = None
    hole_intelligence: Optional[HoleIntelligence] = None
    club_distances: dict[str, int] = {}
    handicap: Optional[float] = None
    player_stats: Optional[PlayerStatistics] = None
    par: int = 4
    # Optional + honest error (specs/corridor-width-club-selection-plan.md
    # §8): NOT required — a required field would 422 legitimate callers that
    # send only distance_yards. No fake fallback: `get_recommendation` raises
    # a 400 when no distance signal is present at all, never a fabricated 400y.
    yards: Optional[int] = None
    competition_legal: bool = False  # True = USGA-conforming mode; zeroes all environmental distance adjustments


class VoiceCaddieRequest(BaseModel):
    transcript: str
    personality_id: str = "classic"
    # None = OFF-COURSE general chat (the Looper orb outside a round) — the
    # handler omits the hole-context line entirely rather than inventing one.
    hole_number: Optional[int] = 1
    par: int = 4
    # No-fake-data (specs/caddie-yardage-gps-selected-tee-plan.md): honest
    # None when the caller doesn't know the yardage yet — NEVER a fabricated
    # 400 default. `_build_voice_prompt` labels provenance via `yardage_basis`
    # and omits the yardage line entirely when this is None.
    yards: Optional[int] = None
    distance_yards: Optional[int] = None
    # Live GPS distance to the middle of the green, from where the player
    # stands NOW (already on-hole gated by the caller) — outranks `yards`.
    distance_to_green_yards: Optional[int] = None
    # Provenance of `yards`: 'gps' | 'tee-card' | 'tee-geom' | 'card' | None —
    # see frontend lib/caddie/hole-yardage.ts. Drives the "from the {tee}
    # tees" / "on the card" wording so the caddie never claims a source it
    # doesn't have.
    yardage_basis: Optional[str] = None
    tee_name: Optional[str] = None
    wind_speed_mph: float = 0.0
    wind_direction: int = 0
    club_distances: dict[str, int] = {}
    handicap: Optional[float] = None
    current_recommendation: Optional[dict] = None
    conversation_history: list[dict] = []
    # Real, pre-serialized player stats (handicap/trend/par-type/clubs — see
    # frontend lib/stats-grounding.ts) for a registered converse context (My
    # Card). Optional/defaulted — /session/voice never sends it.
    stats_context: Optional[str] = None


class VoiceCaddieResponse(BaseModel):
    response: str
    updated_recommendation: Optional[dict] = None
    follow_up: Optional[str] = None


class PlayerStatsRequest(BaseModel):
    rounds: list[dict]  # round objects from frontend
    handicap: Optional[float] = None
    course_id: Optional[str] = None  # for course-specific history
