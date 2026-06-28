// GPS and Distance Calculation Utilities
//
// Platform routing:
//   - Native iOS (Capacitor.isNativePlatform() === true):
//       uses @capacitor/geolocation for proper iOS permission handling and
//       CLLocationManager accuracy.  Falls back to navigator.geolocation on
//       any plugin error so the web/dev path is never silently broken.
//   - Web / dev server:
//       uses navigator.geolocation as before.
//
// Public API is unchanged — callers (CaddiePanel, GPSMapView, etc.) are not
// touched.  The only new export is `normalizeCapacitorPosition`, extracted so
// the position-shape mapping can be unit-tested without a device.

import * as turf from "@turf/turf";
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import type { Position as CapacitorPosition } from "@capacitor/geolocation";

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

// ─── Position normalisation ───────────────────────────────────────────────────
// Maps a Capacitor Position into the app's Position shape.
// Pure function — exported for unit testing.

export function normalizeCapacitorPosition(cap: CapacitorPosition): Position {
  return {
    lat: cap.coords.latitude,
    lng: cap.coords.longitude,
    // Capacitor accuracy is always number (non-optional)
    accuracy: cap.coords.accuracy,
    // Optional fields arrive as null from the plugin — convert to undefined so
    // the app's optional shape is preserved.
    altitude: cap.coords.altitude ?? undefined,
    heading: cap.coords.heading ?? undefined,
    speed: cap.coords.speed ?? undefined,
    timestamp: cap.timestamp,
  };
}

// Synthesize a GeolocationPositionError-compatible object for errors that
// originate from the Capacitor plugin so callers that switch on
// error.PERMISSION_DENIED / .POSITION_UNAVAILABLE / .TIMEOUT keep working
// unchanged when running on native.
function makeGeoError(code: 1 | 2 | 3, message: string): GeolocationPositionError {
  return {
    code,
    message,
    PERMISSION_DENIED: 1 as const,
    POSITION_UNAVAILABLE: 2 as const,
    TIMEOUT: 3 as const,
  };
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
  // On web: number (browser watchPosition ID).
  // On native: string (Capacitor CallbackID).
  private watchId: number | string | null = null;
  private onPositionUpdate: (position: Position) => void;
  private onError: (error: GeolocationPositionError) => void;

  constructor(
    onPositionUpdate: (position: Position) => void,
    onError: (error: GeolocationPositionError) => void
  ) {
    this.onPositionUpdate = onPositionUpdate;
    this.onError = onError;
  }

  // Start watching position with high accuracy.
  // Returns true synchronously; on native the permission prompt + watch setup
  // happen asynchronously in the background.
  start(): boolean {
    if (this.watchId !== null) {
      this.stop();
    }

    if (Capacitor.isNativePlatform()) {
      // Fire-and-forget: sets this.watchId when the promise resolves
      void this._startNative();
      return true;
    }

    return this._startWeb();
  }

  private _startWeb(): boolean {
    if (!navigator.geolocation) {
      console.error("Geolocation not supported");
      return false;
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
        maximumAge: 1000,         // Accept cached position up to 1 second old
        timeout: 10000,           // Wait up to 10 seconds for position
      }
    );

    return true;
  }

  private async _startNative(): Promise<void> {
    try {
      // Request location permission before starting the watch
      const perm = await Geolocation.requestPermissions();
      if (perm.location === "denied") {
        this.onError(makeGeoError(1, "Location permission denied."));
        return;
      }

      const callbackId = await Geolocation.watchPosition(
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
        (position, err) => {
          if (err) {
            // Capacitor watch errors are opaque — surface as POSITION_UNAVAILABLE
            this.onError(makeGeoError(2, String(err)));
            return;
          }
          if (position) {
            this.onPositionUpdate(normalizeCapacitorPosition(position));
          }
        }
      );

      this.watchId = callbackId;
    } catch (err) {
      // Plugin call failed (e.g. location services disabled) — fall back to web
      console.warn(
        "Capacitor Geolocation.watchPosition failed, falling back to web:",
        err
      );
      this._startWeb();
    }
  }

  // Get single position reading
  static async getCurrentPosition(): Promise<Position> {
    if (Capacitor.isNativePlatform()) {
      try {
        const perm = await Geolocation.requestPermissions();
        if (perm.location === "denied") {
          throw makeGeoError(1, "Location permission denied.");
        }
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 15000,
        });
        return normalizeCapacitorPosition(pos);
      } catch (err) {
        // Fall through to web path on any plugin failure
        console.warn(
          "Capacitor Geolocation.getCurrentPosition failed, falling back to web:",
          err
        );
      }
    }

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
    if (this.watchId === null) return;

    if (Capacitor.isNativePlatform() && typeof this.watchId === "string") {
      // Native: clear via Capacitor (async; fire-and-forget)
      Geolocation.clearWatch({ id: this.watchId as string }).catch((err) =>
        console.warn("Geolocation.clearWatch failed:", err)
      );
    } else if (typeof this.watchId === "number") {
      // Web: clear via browser API
      navigator.geolocation.clearWatch(this.watchId);
    }

    this.watchId = null;
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
