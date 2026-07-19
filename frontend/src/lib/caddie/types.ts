// Caddie system TypeScript types (mirrors Python backend models)

export interface ShotAdjustment {
  type: 'wind' | 'elevation' | 'temperature' | 'altitude' | 'conditions';
  yards: number;
  description: string;
}

export interface MissSide {
  preferred: string; // left | right | short | long
  description: string;
  avoid: string;
}

export interface AimPoint {
  description: string;
  lat?: number;
  lng?: number;
  bearing?: number;
}

export interface CaddieRecommendation {
  club: string;
  target_yards: number;
  raw_yards: number;
  aim_point: AimPoint;
  reasoning: string[];
  miss_side: MissSide;
  adjustments: ShotAdjustment[];
  confidence: number;
  aggressiveness: 'conservative' | 'moderate' | 'aggressive';
  expected_score?: number;
  personality_advice?: string;
  /** True when the backend produced a USGA-conforming recommendation
   *  (no environmental distance adjustments; target_yards == raw_yards). */
  competition_legal?: boolean;
  /** "positioning" = the green is out of reach on this swing; aim_point
   *  speaks landing-zone advice instead of a pin-relative one. Defaulted
   *  server-side to "approach" (today's flag-relative path) — optional here
   *  so older cached recommendations still validate. */
  shot_kind?: 'approach' | 'positioning';
  /** positioning only: the approach distance the drive leaves. */
  leave_yards?: number | null;
  /** ONE authoritative numbers block for a positioning/tee shot — mirrors
   *  `backend/app/caddie/types.py::TeeShotNumbers` exactly
   *  (specs/caddie-numbers-coherence-plan.md §2.2). `null`/absent on
   *  reachable/approach turns and on any cached recommendation from before
   *  this field existed. No UI change required for this cycle — CaddiePanel
   *  keeps rendering `aim_point.description` as today. */
  tee_shot_numbers?: {
    hole_number: number;
    to_green_yards: number;
    yardage_basis?: string | null;
    plays_like_yards: number;
    club: string;
    club_stored_yards: number;
    drive_carry_yards?: number | null;
    drive_total_yards: number;
    leave_exact_yards: number;
    leave_yards: number;
    leave_plays_like_yards?: number | null;
    /** Corridor-width club selection (specs/corridor-width-club-selection-
     *  plan.md §5) — additive, populated ONLY on profile-present turns where
     *  the width rule fired or grounded the chosen club. */
    corridor_pinch_width_yards?: number | null;
    corridor_pinch_distance_yards?: number | null;
    corridor_capped_from_club?: string | null;
    corridor_capped_from_window_yards?: number | null;
    corridor_club_window_yards?: number | null;
    corridor_width_yards?: number | null;
  } | null;
}

export interface WeatherConditions {
  temperature_f: number;
  humidity: number;
  wind_speed_mph: number;
  wind_direction: number;
  wind_gusts_mph: number;
  pressure_hpa: number;
  altitude_ft: number;
  air_density_factor: number;
  conditions: 'soft' | 'medium' | 'firm';
}

export interface GreenSlope {
  direction: number;
  severity: 'flat' | 'mild' | 'moderate' | 'severe';
  percent_grade: number;
  description: string;
}

export interface Hazard {
  type: 'water' | 'bunker' | 'ob' | 'trees' | 'slope';
  side: 'left' | 'right' | 'front' | 'back' | 'center';
  distance_from_green: number;
  penalty_severity: 'mild' | 'moderate' | 'severe' | 'death';
  lat?: number;
  lng?: number;
}

// One researched, attributed piece of local knowledge about a hole — mirrors
// `backend/app/caddie/types.py::LoreItem` exactly
// (specs/caddie-guide-local-lore-plan.md).
export interface LoreItem {
  text: string;
  category: 'green_character' | 'feature' | 'history' | 'architect_intent';
  source: string;
  confidence: string;
}

// Compact per-hole strategy guide, researched offline and cached in the green
// feature's JSONB `properties.strategy_guide` — mirrors
// `backend/app/caddie/types.py::HoleStrategyGuide` exactly. Optional-safe:
// absent (no writer has run yet, or the course predates this feature) simply
// omits the field, never a placeholder.
export interface HoleStrategyGuide {
  play_line: string;
  miss_side: string;
  green_notes: string;
  common_mistakes: string[];
  sources: string[];
  generated_at: string;
  model: string;
  schema_version: number;
  // Researched LOCAL-LORE layer (specs/caddie-guide-local-lore-plan.md) —
  // optional so pre-lore cached payloads still type-check.
  local_lore?: LoreItem[];
  lore_generated_at?: string;
  lore_model?: string;
  lore_sources?: string[];
}

// Where/how far the fairway bends (the dogleg), measured from the tee along
// the hole's mapped centerline — mirrors
// `backend/app/caddie/types.py::HoleBend` exactly.
export interface HoleBend {
  straight: boolean;
  direction: 'left' | 'right' | null;
  distance_yards: number | null;
  deviation_yards: number;
  double_dogleg: boolean;
}

export interface HoleIntelligence {
  hole_number: number;
  par: number;
  yards: number | null;
  handicap_rating: number;
  elevation_change_ft: number;
  effective_yards: number | null;
  green_slope?: GreenSlope;
  hazards: Hazard[];
  pin_traffic_light: 'green' | 'yellow' | 'red';
  player_history?: {
    times_played: number;
    avg_score: number;
    best_score: number;
    worst_score: number;
    birdie_rate: number;
    bogey_rate: number;
  };
  strategy_guide?: HoleStrategyGuide;
  /** None = centerline unmapped (honest unknown), distinct from a
   *  measured-straight hole (bend.straight === true). */
  bend?: HoleBend | null;
  /** Per-hole corridor-width profile (danger-to-danger cross-sections every
   *  10y) — mirrors `backend/app/caddie/types.py::CorridorSample` exactly
   *  (specs/corridor-width-club-selection-plan.md §5). None = unmapped/
   *  uncomputable. CaddiePanel round-trips intel back into `/caddie/recommend`,
   *  so this shape must be declared even though no UI renders it this cycle. */
  corridor?: Array<{
    distance_yards: number;
    left_yards?: number | null;
    right_yards?: number | null;
    width_yards?: number | null;
    left_fairway_yards?: number | null;
    right_fairway_yards?: number | null;
    left_source?: string | null;
    right_source?: string | null;
  }> | null;
}

export interface CaddiePersonalityInfo {
  id: string;
  name: string;
  description: string;
  avatar: string;
  response_style: string;
  traits: string[];
  voice_id?: string | null;
  is_builtin?: boolean;
  author_user_id?: string | null;
}

export interface VoiceCaddieMessage {
  role: 'user' | 'assistant';
  content: string;
}
