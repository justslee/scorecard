export type FeatureType =
  | 'tee'
  | 'fairway'
  | 'green'
  | 'bunker'
  | 'water'
  | 'ob'
  | 'target'
  | 'pin';

export interface TeeSet {
  name: string;
  color: string;
}

export interface HoleData {
  number: number;
  par: number;
  handicap: number;
  /** Tee name -> yardage */
  yardages: Record<string, number>;
  features: GeoJSON.FeatureCollection;
}

export interface CourseData {
  id: string;
  name: string;
  location: { lat: number; lng: number };
  address?: string;
  /** Optional course boundary for auto-detect flows (not currently persisted to Supabase). */
  boundary?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  teeSets: TeeSet[];
  holes: HoleData[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CourseListItem {
  id: string;
  name: string;
  location?: { lat: number; lng: number };
  address?: string;
  updatedAt?: string;
}
