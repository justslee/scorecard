// GPS and Distance Calculation Utilities
import * as turf from "@turf/turf";

export interface Position {
  lat: number;
  lng: number;
  accuracy?: number;
  altitude?: number;
  heading?: number;
  speed?: number;
  timestamp?: number;
}

export interface DistanceResult {
  yards: number;
  meters: number;
  feet: number;
}

// Calculate distance between two points in yards (golf standard)
export function calculateDistance(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): DistanceResult {
  const fromPoint = turf.point([from.lng, from.lat]);
  const toPoint = turf.point([to.lng, to.lat]);
  
  const meters = turf.distance(fromPoint, toPoint, { units: "meters" });
  const yards = meters * 1.09361;
  const feet = meters * 3.28084;
  
  return {
    yards: Math.round(yards),
    meters: Math.round(meters),
    feet: Math.round(feet),
  };
}

// Calculate bearing from one point to another (for compass display)
export function calculateBearing(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): number {
  const fromPoint = turf.point([from.lng, from.lat]);
  const toPoint = turf.point([to.lng, to.lat]);
  
  return turf.bearing(fromPoint, toPoint);
}

// High-accuracy GPS watcher
export class GPSWatcher {
  private watchId: number | null = null;
  private onPositionUpdate: (position: Position) => void;
  private onError: (error: GeolocationPositionError) => void;
  
  constructor(
    onPositionUpdate: (position: Position) => void,
    onError: (error: GeolocationPositionError) => void
  ) {
    this.onPositionUpdate = onPositionUpdate;
    this.onError = onError;
  }
  
  // Start watching position with high accuracy
  start(): boolean {
    if (!navigator.geolocation) {
      console.error("Geolocation not supported");
      return false;
    }
    
    if (this.watchId !== null) {
      this.stop();
    }
    
    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        this.onPositionUpdate({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          altitude: position.coords.altitude ?? undefined,
          heading: position.coords.heading ?? undefined,
          speed: position.coords.speed ?? undefined,
          timestamp: position.timestamp,
        });
      },
      this.onError,
      {
        enableHighAccuracy: true, // Use GPS for best accuracy
        maximumAge: 1000, // Accept cached position up to 1 second old
        timeout: 10000, // Wait up to 10 seconds for position
      }
    );
    
    return true;
  }
  
  // Get single position reading
  static async getCurrentPosition(): Promise<Position> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation not supported"));
        return;
      }
      
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            altitude: position.coords.altitude ?? undefined,
            heading: position.coords.heading ?? undefined,
            speed: position.coords.speed ?? undefined,
            timestamp: position.timestamp,
          });
        },
        reject,
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 15000,
        }
      );
    });
  }
  
  // Stop watching
  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
  
  // Check if currently watching
  isWatching(): boolean {
    return this.watchId !== null;
  }
}

// Format distance for display
export function formatDistance(yards: number): string {
  if (yards < 10) {
    return `${yards} yds`;
  }
  return `${yards} yds`;
}

// Get accuracy description
export function getAccuracyDescription(meters: number): string {
  if (meters <= 3) return "Excellent";
  if (meters <= 5) return "Very Good";
  if (meters <= 10) return "Good";
  if (meters <= 20) return "Fair";
  return "Low";
}

// Check if position is on the golf course (basic bounds check)
export function isOnCourse(
  position: Position,
  courseBounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }
): boolean {
  return (
    position.lat >= courseBounds.south &&
    position.lat <= courseBounds.north &&
    position.lng >= courseBounds.west &&
    position.lng <= courseBounds.east
  );
}
