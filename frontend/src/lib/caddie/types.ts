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

export interface HoleIntelligence {
  hole_number: number;
  par: number;
  yards: number;
  handicap_rating: number;
  elevation_change_ft: number;
  effective_yards: number;
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
}

export interface CaddiePersonalityInfo {
  id: string;
  name: string;
  description: string;
  avatar: string;
  response_style: string;
  traits: string[];
}

export interface VoiceCaddieMessage {
  role: 'user' | 'assistant';
  content: string;
}
