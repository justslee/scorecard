"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Navigation,
  Target,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  MapPin,
  Signal,
  Flag,
} from "lucide-react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  GPSWatcher,
  calculateDistance,
  getAccuracyDescription,
  Position,
} from "@/lib/gps";
import { CourseCoordinates } from "@/lib/golf-api";

interface GPSMapViewProps {
  courseId: number;
  courseName: string;
  holeCoordinates: CourseCoordinates[];
  currentHole: number;
  onHoleChange: (hole: number) => void;
  onClose: () => void;
  /** Auto-detect hole based on nearest green. Defaults true. */
  autoDetectHole?: boolean;
}

export default function GPSMapView({
  courseId: _courseId,
  courseName,
  holeCoordinates,
  currentHole,
  onHoleChange,
  onClose,
  autoDetectHole = true,
}: GPSMapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker = useRef<mapboxgl.Marker | null>(null);
  const greenMarker = useRef<mapboxgl.Marker | null>(null);
  const pinMarker = useRef<mapboxgl.Marker | null>(null);
  const hazardMarkers = useRef<mapboxgl.Marker[]>([]);

  const [position, setPosition] = useState<Position | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const gpsWatcher = useRef<GPSWatcher | null>(null);

  const currentHoleData = holeCoordinates.find((h) => h.holeNumber === currentHole);

  const distances = useMemo(() => {
    if (!position || !currentHoleData) {
      return {
        front: null as number | null,
        center: null as number | null,
        back: null as number | null,
        pin: null as number | null,
      };
    }

    const center = calculateDistance(position, currentHoleData.green);
    const front = currentHoleData.front
      ? calculateDistance(position, currentHoleData.front)
      : null;
    const back = currentHoleData.back
      ? calculateDistance(position, currentHoleData.back)
      : null;
    const pin = currentHoleData.pin
      ? calculateDistance(position, currentHoleData.pin)
      : null;

    return {
      front: front?.yards ?? null,
      center: center.yards,
      back: back?.yards ?? null,
      pin: pin?.yards ?? null,
    };
  }, [position, currentHoleData]);

  const hazardDistances = useMemo(() => {
    if (!position || !currentHoleData?.hazards?.length) return [] as Array<{ type: string; yards: number }>;
    return currentHoleData.hazards
      .map((h) => ({
        type: h.type,
        yards: calculateDistance(position, { lat: h.lat, lng: h.lng }).yards,
      }))
      .sort((a, b) => a.yards - b.yards)
      .slice(0, 4);
  }, [position, currentHoleData]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || !currentHoleData) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
    if (!mapboxgl.accessToken) {
      setGpsError("Mapbox token not configured");
      setIsLoading(false);
      return;
    }

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [currentHoleData.green.lng, currentHoleData.green.lat],
      zoom: 17,
      pitch: 45,
      bearing: 0,
    });

    map.current.on("load", () => {
      setIsLoading(false);

      // Green marker
      const greenEl = document.createElement("div");
      greenEl.className = "green-marker";
      greenEl.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-emerald-500 border-2 border-white shadow-lg flex items-center justify-center"></div>
      `;

      greenMarker.current = new mapboxgl.Marker({ element: greenEl })
        .setLngLat([currentHoleData.green.lng, currentHoleData.green.lat])
        .addTo(map.current!);

      // Pin marker (if available)
      if (currentHoleData.pin) {
        const pinEl = document.createElement("div");
        pinEl.className = "pin-marker";
        pinEl.innerHTML = `
          <div class="w-7 h-7 rounded-full bg-red-500 border-2 border-white shadow-lg flex items-center justify-center"></div>
        `;
        pinMarker.current = new mapboxgl.Marker({ element: pinEl })
          .setLngLat([currentHoleData.pin.lng, currentHoleData.pin.lat])
          .addTo(map.current!);
      }

      // Hazard markers
      hazardMarkers.current.forEach((m) => m.remove());
      hazardMarkers.current = [];
      (currentHoleData.hazards || []).forEach((h) => {
        const el = document.createElement("div");
        el.className = "hazard-marker";
        el.innerHTML = `
          <div class="w-6 h-6 rounded-full bg-orange-500/90 border-2 border-white shadow-lg"></div>
        `;
        const m = new mapboxgl.Marker({ element: el })
          .setLngLat([h.lng, h.lat])
          .addTo(map.current!);
        hazardMarkers.current.push(m);
      });
    });

    return () => {
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update markers on hole change
  useEffect(() => {
    if (!map.current || !currentHoleData) return;

    greenMarker.current?.setLngLat([currentHoleData.green.lng, currentHoleData.green.lat]);

    if (currentHoleData.pin) {
      if (!pinMarker.current) {
        const pinEl = document.createElement("div");
        pinEl.className = "pin-marker";
        pinEl.innerHTML = `
          <div class="w-7 h-7 rounded-full bg-red-500 border-2 border-white shadow-lg"></div>
        `;
        pinMarker.current = new mapboxgl.Marker({ element: pinEl })
          .setLngLat([currentHoleData.pin.lng, currentHoleData.pin.lat])
          .addTo(map.current);
      } else {
        pinMarker.current.setLngLat([currentHoleData.pin.lng, currentHoleData.pin.lat]);
      }
    } else {
      pinMarker.current?.remove();
      pinMarker.current = null;
    }

    hazardMarkers.current.forEach((m) => m.remove());
    hazardMarkers.current = [];
    (currentHoleData.hazards || []).forEach((h) => {
      const el = document.createElement("div");
      el.className = "hazard-marker";
      el.innerHTML = `
        <div class="w-6 h-6 rounded-full bg-orange-500/90 border-2 border-white shadow-lg"></div>
      `;
      const m = new mapboxgl.Marker({ element: el })
        .setLngLat([h.lng, h.lat])
        .addTo(map.current!);
      hazardMarkers.current.push(m);
    });

    map.current.flyTo({
      center: [currentHoleData.green.lng, currentHoleData.green.lat],
      zoom: 17,
      duration: 900,
    });
  }, [currentHoleData]);

  const handlePositionUpdate = useCallback(
    (pos: Position) => {
      setPosition(pos);
      setGpsError(null);

      if (!map.current) return;

      // Update or create user marker
      if (!userMarker.current) {
        const userEl = document.createElement("div");
        userEl.className = "user-marker";
        userEl.innerHTML = `
          <div class="relative">
            <div class="w-6 h-6 rounded-full bg-blue-500 border-2 border-white shadow-lg animate-pulse"></div>
            <div class="absolute inset-0 w-6 h-6 rounded-full bg-blue-500 animate-ping opacity-75"></div>
          </div>
        `;

        userMarker.current = new mapboxgl.Marker({ element: userEl })
          .setLngLat([pos.lng, pos.lat])
          .addTo(map.current);
      } else {
        userMarker.current.setLngLat([pos.lng, pos.lat]);
      }

      // Auto-detect hole
      if (autoDetectHole && holeCoordinates.length > 0) {
        let best: { hole: number; yards: number } | null = null;
        for (const h of holeCoordinates) {
          const d = calculateDistance(pos, h.green).yards;
          if (!best || d < best.yards) best = { hole: h.holeNumber, yards: d };
        }
        // If within ~250 yards of a green, switch.
        if (best && best.yards < 250 && best.hole !== currentHole) {
          onHoleChange(best.hole);
        }
      }
    },
    [autoDetectHole, holeCoordinates, currentHole, onHoleChange]
  );

  const handleGpsError = useCallback((error: GeolocationPositionError) => {
    switch (error.code) {
      case error.PERMISSION_DENIED:
        setGpsError("Location permission denied. Please enable location access.");
        break;
      case error.POSITION_UNAVAILABLE:
        setGpsError("Location unavailable. Please check your GPS.");
        break;
      case error.TIMEOUT:
        setGpsError("Location request timed out. Retrying...");
        break;
      default:
        setGpsError("Unable to get location.");
    }
  }, []);

  useEffect(() => {
    gpsWatcher.current = new GPSWatcher(handlePositionUpdate, handleGpsError);
    gpsWatcher.current.start();

    return () => {
      gpsWatcher.current?.stop();
    };
  }, [handlePositionUpdate, handleGpsError]);

  const centerOnUser = () => {
    if (!map.current || !position) return;
    map.current.flyTo({ center: [position.lng, position.lat], zoom: 18, duration: 500 });
  };

  const centerOnGreen = () => {
    if (!map.current || !currentHoleData) return;
    map.current.flyTo({
      center: [currentHoleData.green.lng, currentHoleData.green.lat],
      zoom: 17,
      duration: 500,
    });
  };

  const prevHole = () => {
    if (currentHole > 1) onHoleChange(currentHole - 1);
  };

  const nextHole = () => {
    if (currentHole < 18) onHoleChange(currentHole + 1);
  };

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-zinc-950/90 to-transparent p-4 pb-8">
        <div className="flex items-center justify-between">
          <button onClick={onClose} className="flex items-center gap-2 text-white/80 hover:text-white">
            <ChevronLeft size={24} />
            <span>Back</span>
          </button>

          <div className="text-center">
            <h1 className="text-white font-semibold">{courseName}</h1>
            <p className="text-zinc-400 text-sm">Hole {currentHole}</p>
          </div>

          <div className="w-16" />
        </div>
      </div>

      <div ref={mapContainer} className="w-full h-full" />

      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-zinc-950 flex items-center justify-center z-20"
          >
            <div className="text-center">
              <Loader2 className="w-12 h-12 text-emerald-500 animate-spin mx-auto mb-4" />
              <p className="text-white">Loading map...</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {gpsError && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute top-20 left-4 right-4 z-20"
          >
            <div className="bg-red-500/90 backdrop-blur-sm rounded-xl p-4 flex items-center gap-3">
              <AlertCircle className="w-6 h-6 text-white flex-shrink-0" />
              <p className="text-white text-sm">{gpsError}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Distance Panel */}
      <div className="absolute bottom-0 left-0 right-0 z-10">
        <div className="flex items-center justify-center gap-4 pb-4">
          <button
            onClick={prevHole}
            disabled={currentHole <= 1}
            className="w-10 h-10 rounded-full bg-zinc-800/80 backdrop-blur-sm flex items-center justify-center disabled:opacity-30"
          >
            <ChevronLeft className="text-white" size={24} />
          </button>

          <div className="bg-zinc-800/80 backdrop-blur-sm rounded-full px-6 py-2">
            <span className="text-white font-bold text-lg">Hole {currentHole}</span>
          </div>

          <button
            onClick={nextHole}
            disabled={currentHole >= 18}
            className="w-10 h-10 rounded-full bg-zinc-800/80 backdrop-blur-sm flex items-center justify-center disabled:opacity-30"
          >
            <ChevronRight className="text-white" size={24} />
          </button>
        </div>

        <div className="bg-zinc-900/95 backdrop-blur-xl rounded-t-3xl p-6 pt-8">
          <div className="grid grid-cols-3 gap-4 mb-3">
            <div className="text-center">
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Front</p>
              <p className="text-white text-2xl font-bold">{distances.front ?? "—"}</p>
              <p className="text-zinc-500 text-xs">yds</p>
            </div>

            <div className="text-center">
              <div className="bg-emerald-500/20 rounded-2xl p-3 -mt-2">
                <p className="text-emerald-400 text-xs uppercase tracking-wider mb-1">Center</p>
                <p className="text-emerald-400 text-4xl font-bold">{distances.center ?? "—"}</p>
                <p className="text-emerald-400/60 text-xs">yds</p>
              </div>
            </div>

            <div className="text-center">
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Back</p>
              <p className="text-white text-2xl font-bold">{distances.back ?? "—"}</p>
              <p className="text-zinc-500 text-xs">yds</p>
            </div>
          </div>

          {/* Pin distance */}
          {currentHoleData?.pin ? (
            <div className="flex items-center justify-center gap-2 mb-4 text-sm text-zinc-200">
              <Flag className="w-4 h-4 text-red-400" />
              <span className="text-zinc-400">Pin:</span>
              <span className="font-semibold">{distances.pin ?? "—"} yds</span>
            </div>
          ) : null}

          {/* Hazards */}
          {hazardDistances.length > 0 ? (
            <div className="mb-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                <Target className="w-4 h-4 text-orange-400" />
                Targets / Hazards
              </div>
              <div className="grid grid-cols-2 gap-2">
                {hazardDistances.map((h, idx) => (
                  <div
                    key={`${h.type}-${idx}`}
                    className="rounded-xl bg-zinc-800/70 border border-zinc-700 px-3 py-2 text-sm flex items-center justify-between"
                  >
                    <span className="text-zinc-300 capitalize">{h.type}</span>
                    <span className="text-white font-semibold">{Math.round(h.yards)}y</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Signal size={16} className={position ? "text-emerald-500" : "text-zinc-500"} />
              <span className="text-zinc-400 text-sm">
                {position
                  ? `GPS: ${getAccuracyDescription(position.accuracy || 0)} (±${Math.round(
                      position.accuracy || 0
                    )}m)`
                  : "Acquiring GPS..."}
              </span>
            </div>

            <div className="flex gap-2">
              <button
                onClick={centerOnUser}
                disabled={!position}
                className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center disabled:opacity-30"
              >
                <Navigation className="text-blue-400" size={20} />
              </button>

              <button
                onClick={centerOnGreen}
                className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center"
              >
                <MapPin className="text-emerald-400" size={20} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        .green-marker,
        .user-marker,
        .pin-marker,
        .hazard-marker {
          cursor: pointer;
        }
        .mapboxgl-ctrl-logo,
        .mapboxgl-ctrl-attrib {
          display: none !important;
        }
      `}</style>
    </div>
  );
}
