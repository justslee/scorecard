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
  Crosshair,
} from "lucide-react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import {
  GPSWatcher,
  calculateDistance,
  calculateBearing,
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

// Layup ring distances in yards
const LAYUP_RINGS = [100, 150, 200];

function createCircleGeoJSON(
  center: { lat: number; lng: number },
  radiusYards: number
): GeoJSON.Feature<GeoJSON.Polygon> {
  const radiusKm = radiusYards * 0.0009144;
  return turf.circle([center.lng, center.lat], radiusKm, {
    steps: 64,
    units: "kilometers",
  }) as GeoJSON.Feature<GeoJSON.Polygon>;
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
  const teeMarker = useRef<mapboxgl.Marker | null>(null);
  const pinMarker = useRef<mapboxgl.Marker | null>(null);
  const hazardMarkers = useRef<mapboxgl.Marker[]>([]);
  const distanceLabelMarker = useRef<mapboxgl.Marker | null>(null);
  const mapLoaded = useRef(false);

  const [position, setPosition] = useState<Position | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showOverlays, setShowOverlays] = useState(true);

  const gpsWatcher = useRef<GPSWatcher | null>(null);

  const currentHoleData = holeCoordinates.find(
    (h) => h.holeNumber === currentHole
  );

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
    if (!position || !currentHoleData?.hazards?.length)
      return [] as Array<{ type: string; yards: number }>;
    return currentHoleData.hazards
      .map((h) => ({
        type: h.type,
        yards: calculateDistance(position, { lat: h.lat, lng: h.lng }).yards,
      }))
      .sort((a, b) => a.yards - b.yards)
      .slice(0, 4);
  }, [position, currentHoleData]);

  // Add/update overlay layers (distance line, layup rings, tee-to-green)
  const updateOverlays = useCallback(() => {
    if (!map.current || !mapLoaded.current || !currentHoleData) return;

    const m = map.current;

    // --- Distance line from user to green ---
    if (position && showOverlays) {
      const distLineData: GeoJSON.Feature<GeoJSON.LineString> = {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [position.lng, position.lat],
            [currentHoleData.green.lng, currentHoleData.green.lat],
          ],
        },
      };

      const src = m.getSource("distance-line") as mapboxgl.GeoJSONSource;
      if (src) {
        src.setData(distLineData);
      } else {
        m.addSource("distance-line", {
          type: "geojson",
          data: distLineData,
        });
        m.addLayer({
          id: "distance-line-layer",
          type: "line",
          source: "distance-line",
          paint: {
            "line-color": "#60a5fa",
            "line-width": 3,
            "line-dasharray": [3, 2],
            "line-opacity": 0.8,
          },
        });
      }

      // Distance label at midpoint
      const midLng = (position.lng + currentHoleData.green.lng) / 2;
      const midLat = (position.lat + currentHoleData.green.lat) / 2;
      const yds = distances.center;

      if (yds !== null) {
        if (!distanceLabelMarker.current) {
          const el = document.createElement("div");
          el.className = "distance-label-marker";
          el.innerHTML = `<div class="px-2 py-1 rounded-lg bg-blue-500/90 text-white text-xs font-bold shadow-lg whitespace-nowrap">${yds}y</div>`;
          distanceLabelMarker.current = new mapboxgl.Marker({
            element: el,
            anchor: "center",
          })
            .setLngLat([midLng, midLat])
            .addTo(m);
        } else {
          distanceLabelMarker.current.setLngLat([midLng, midLat]);
          const el = distanceLabelMarker.current.getElement();
          const inner = el.querySelector("div");
          if (inner) inner.textContent = `${yds}y`;
        }
      }
    } else {
      // Remove distance line if no position
      if (m.getLayer("distance-line-layer")) m.removeLayer("distance-line-layer");
      if (m.getSource("distance-line")) m.removeSource("distance-line");
      distanceLabelMarker.current?.remove();
      distanceLabelMarker.current = null;
    }

    // --- Tee-to-green line ---
    if (currentHoleData.tee && showOverlays) {
      const teeGreenData: GeoJSON.Feature<GeoJSON.LineString> = {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [currentHoleData.tee.lng, currentHoleData.tee.lat],
            [currentHoleData.green.lng, currentHoleData.green.lat],
          ],
        },
      };

      const src = m.getSource("tee-green-line") as mapboxgl.GeoJSONSource;
      if (src) {
        src.setData(teeGreenData);
      } else {
        m.addSource("tee-green-line", {
          type: "geojson",
          data: teeGreenData,
        });
        m.addLayer({
          id: "tee-green-line-layer",
          type: "line",
          source: "tee-green-line",
          paint: {
            "line-color": "#a3e635",
            "line-width": 2,
            "line-opacity": 0.4,
          },
        });
      }
    } else {
      if (m.getLayer("tee-green-line-layer"))
        m.removeLayer("tee-green-line-layer");
      if (m.getSource("tee-green-line")) m.removeSource("tee-green-line");
    }

    // --- Layup distance rings around green ---
    if (showOverlays) {
      for (const ringYards of LAYUP_RINGS) {
        const sourceId = `layup-ring-${ringYards}`;
        const layerId = `layup-ring-layer-${ringYards}`;
        const labelLayerId = `layup-ring-label-${ringYards}`;

        const circle = createCircleGeoJSON(currentHoleData.green, ringYards);

        const src = m.getSource(sourceId) as mapboxgl.GeoJSONSource;
        if (src) {
          src.setData(circle);
        } else {
          m.addSource(sourceId, {
            type: "geojson",
            data: circle,
          });
          m.addLayer({
            id: layerId,
            type: "line",
            source: sourceId,
            paint: {
              "line-color":
                ringYards === 100
                  ? "#facc15"
                  : ringYards === 150
                    ? "#fb923c"
                    : "#ef4444",
              "line-width": 1.5,
              "line-opacity": 0.5,
              "line-dasharray": [4, 3],
            },
          });
        }

        // Ring label
        const labelSourceId = `${sourceId}-label`;
        // Place label at the point closest to the user, or north if no user
        const labelAngle = position
          ? calculateBearing(currentHoleData.green, position)
          : 0;
        const labelPoint = turf.destination(
          [currentHoleData.green.lng, currentHoleData.green.lat],
          ringYards * 0.0009144,
          labelAngle,
          { units: "kilometers" }
        );
        const labelData: GeoJSON.Feature<GeoJSON.Point> = {
          type: "Feature",
          properties: { label: `${ringYards}y` },
          geometry: {
            type: "Point",
            coordinates: labelPoint.geometry.coordinates,
          },
        };

        const labelSrc = m.getSource(
          labelSourceId
        ) as mapboxgl.GeoJSONSource;
        if (labelSrc) {
          labelSrc.setData(labelData);
        } else {
          m.addSource(labelSourceId, { type: "geojson", data: labelData });
          m.addLayer({
            id: labelLayerId,
            type: "symbol",
            source: labelSourceId,
            layout: {
              "text-field": ["get", "label"],
              "text-size": 11,
              "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
              "text-allow-overlap": true,
            },
            paint: {
              "text-color": "#ffffff",
              "text-halo-color": "#000000",
              "text-halo-width": 1.5,
            },
          });
        }
      }
    } else {
      // Remove layup rings
      for (const ringYards of LAYUP_RINGS) {
        const sourceId = `layup-ring-${ringYards}`;
        const layerId = `layup-ring-layer-${ringYards}`;
        const labelSourceId = `${sourceId}-label`;
        const labelLayerId = `layup-ring-label-${ringYards}`;
        if (m.getLayer(layerId)) m.removeLayer(layerId);
        if (m.getSource(sourceId)) m.removeSource(sourceId);
        if (m.getLayer(labelLayerId)) m.removeLayer(labelLayerId);
        if (m.getSource(labelSourceId)) m.removeSource(labelSourceId);
      }
    }
  }, [currentHoleData, position, showOverlays, distances.center]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || !currentHoleData) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
    if (!mapboxgl.accessToken) {
      setGpsError("Mapbox token not configured");
      setIsLoading(false);
      return;
    }

    // Calculate initial bearing from tee to green
    const initialBearing = currentHoleData.tee
      ? calculateBearing(currentHoleData.tee, currentHoleData.green)
      : 0;

    // Calculate center between tee and green for better initial view
    const initialCenter = currentHoleData.tee
      ? [
          (currentHoleData.tee.lng + currentHoleData.green.lng) / 2,
          (currentHoleData.tee.lat + currentHoleData.green.lat) / 2,
        ]
      : [currentHoleData.green.lng, currentHoleData.green.lat];

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: initialCenter as [number, number],
      zoom: 17,
      pitch: 50,
      bearing: initialBearing,
    });

    map.current.on("load", () => {
      mapLoaded.current = true;
      setIsLoading(false);

      // Green marker
      const greenEl = document.createElement("div");
      greenEl.className = "green-marker";
      greenEl.innerHTML = `
        <div style="width:32px;height:32px;border-radius:50%;background:rgba(16,185,129,0.9);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
          <span style="color:white;font-size:12px;font-weight:bold;">G</span>
        </div>
      `;

      greenMarker.current = new mapboxgl.Marker({ element: greenEl })
        .setLngLat([currentHoleData.green.lng, currentHoleData.green.lat])
        .addTo(map.current!);

      // Tee marker
      if (currentHoleData.tee) {
        const teeEl = document.createElement("div");
        teeEl.className = "tee-marker";
        teeEl.innerHTML = `
          <div style="width:28px;height:28px;border-radius:50%;background:rgba(168,85,247,0.9);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
            <span style="color:white;font-size:10px;font-weight:bold;">T</span>
          </div>
        `;
        teeMarker.current = new mapboxgl.Marker({ element: teeEl })
          .setLngLat([currentHoleData.tee.lng, currentHoleData.tee.lat])
          .addTo(map.current!);
      }

      // Pin marker
      if (currentHoleData.pin) {
        const pinEl = document.createElement("div");
        pinEl.className = "pin-marker";
        pinEl.innerHTML = `
          <div style="width:28px;height:28px;border-radius:50%;background:rgba(239,68,68,0.9);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
            <span style="color:white;font-size:14px;">&#9873;</span>
          </div>
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
        const color =
          h.type === "water"
            ? "rgba(59,130,246,0.9)"
            : h.type === "bunker"
              ? "rgba(234,179,8,0.9)"
              : "rgba(249,115,22,0.9)";
        const label =
          h.type === "water" ? "W" : h.type === "bunker" ? "B" : "H";
        el.innerHTML = `
          <div style="width:24px;height:24px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
            <span style="color:white;font-size:9px;font-weight:bold;">${label}</span>
          </div>
        `;
        const m = new mapboxgl.Marker({ element: el })
          .setLngLat([h.lng, h.lat])
          .addTo(map.current!);
        hazardMarkers.current.push(m);
      });

      // Add initial overlays
      updateOverlays();
    });

    return () => {
      mapLoaded.current = false;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update markers and overlays on hole change
  useEffect(() => {
    if (!map.current || !currentHoleData || !mapLoaded.current) return;

    greenMarker.current?.setLngLat([
      currentHoleData.green.lng,
      currentHoleData.green.lat,
    ]);

    // Tee marker
    if (currentHoleData.tee) {
      if (!teeMarker.current) {
        const teeEl = document.createElement("div");
        teeEl.className = "tee-marker";
        teeEl.innerHTML = `
          <div style="width:28px;height:28px;border-radius:50%;background:rgba(168,85,247,0.9);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
            <span style="color:white;font-size:10px;font-weight:bold;">T</span>
          </div>
        `;
        teeMarker.current = new mapboxgl.Marker({ element: teeEl })
          .setLngLat([currentHoleData.tee.lng, currentHoleData.tee.lat])
          .addTo(map.current);
      } else {
        teeMarker.current.setLngLat([
          currentHoleData.tee.lng,
          currentHoleData.tee.lat,
        ]);
      }
    } else {
      teeMarker.current?.remove();
      teeMarker.current = null;
    }

    // Pin marker
    if (currentHoleData.pin) {
      if (!pinMarker.current) {
        const pinEl = document.createElement("div");
        pinEl.className = "pin-marker";
        pinEl.innerHTML = `
          <div style="width:28px;height:28px;border-radius:50%;background:rgba(239,68,68,0.9);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
            <span style="color:white;font-size:14px;">&#9873;</span>
          </div>
        `;
        pinMarker.current = new mapboxgl.Marker({ element: pinEl })
          .setLngLat([currentHoleData.pin.lng, currentHoleData.pin.lat])
          .addTo(map.current);
      } else {
        pinMarker.current.setLngLat([
          currentHoleData.pin.lng,
          currentHoleData.pin.lat,
        ]);
      }
    } else {
      pinMarker.current?.remove();
      pinMarker.current = null;
    }

    // Hazard markers
    hazardMarkers.current.forEach((m) => m.remove());
    hazardMarkers.current = [];
    (currentHoleData.hazards || []).forEach((h) => {
      const el = document.createElement("div");
      el.className = "hazard-marker";
      const color =
        h.type === "water"
          ? "rgba(59,130,246,0.9)"
          : h.type === "bunker"
            ? "rgba(234,179,8,0.9)"
            : "rgba(249,115,22,0.9)";
      const label =
        h.type === "water" ? "W" : h.type === "bunker" ? "B" : "H";
      el.innerHTML = `
        <div style="width:24px;height:24px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
          <span style="color:white;font-size:9px;font-weight:bold;">${label}</span>
        </div>
      `;
      const m = new mapboxgl.Marker({ element: el })
        .setLngLat([h.lng, h.lat])
        .addTo(map.current!);
      hazardMarkers.current.push(m);
    });

    // Fly to hole with proper bearing
    const bearing = currentHoleData.tee
      ? calculateBearing(currentHoleData.tee, currentHoleData.green)
      : 0;

    const flyCenter = currentHoleData.tee
      ? [
          (currentHoleData.tee.lng + currentHoleData.green.lng) / 2,
          (currentHoleData.tee.lat + currentHoleData.green.lat) / 2,
        ]
      : [currentHoleData.green.lng, currentHoleData.green.lat];

    map.current.flyTo({
      center: flyCenter as [number, number],
      zoom: 17,
      bearing,
      pitch: 50,
      duration: 900,
    });

    // Remove old overlays and redraw
    updateOverlays();
  }, [currentHoleData, updateOverlays]);

  // Update overlays when position changes
  useEffect(() => {
    updateOverlays();
  }, [position, showOverlays, updateOverlays]);

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
          <div style="position:relative;">
            <div style="width:24px;height:24px;border-radius:50%;background:#3b82f6;border:3px solid white;box-shadow:0 2px 12px rgba(59,130,246,0.6);"></div>
            <div style="position:absolute;inset:0;width:24px;height:24px;border-radius:50%;background:#3b82f6;animation:ping 1.5s cubic-bezier(0,0,0.2,1) infinite;opacity:0.4;"></div>
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
          if (!best || d < best.yards)
            best = { hole: h.holeNumber, yards: d };
        }
        if (best && best.yards < 250 && best.hole !== currentHole) {
          onHoleChange(best.hole);
        }
      }
    },
    [autoDetectHole, holeCoordinates, currentHole, onHoleChange]
  );

  const handleGpsError = useCallback(
    (error: GeolocationPositionError) => {
      switch (error.code) {
        case error.PERMISSION_DENIED:
          setGpsError(
            "Location permission denied. Please enable location access."
          );
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
    },
    []
  );

  useEffect(() => {
    gpsWatcher.current = new GPSWatcher(handlePositionUpdate, handleGpsError);
    gpsWatcher.current.start();

    return () => {
      gpsWatcher.current?.stop();
    };
  }, [handlePositionUpdate, handleGpsError]);

  const centerOnUser = () => {
    if (!map.current || !position) return;
    map.current.flyTo({
      center: [position.lng, position.lat],
      zoom: 18,
      duration: 500,
    });
  };

  const centerOnGreen = () => {
    if (!map.current || !currentHoleData) return;
    map.current.flyTo({
      center: [currentHoleData.green.lng, currentHoleData.green.lat],
      zoom: 17,
      duration: 500,
    });
  };

  const fitHole = () => {
    if (!map.current || !currentHoleData) return;

    const points: [number, number][] = [
      [currentHoleData.green.lng, currentHoleData.green.lat],
    ];
    if (currentHoleData.tee)
      points.push([currentHoleData.tee.lng, currentHoleData.tee.lat]);
    if (position) points.push([position.lng, position.lat]);

    if (points.length < 2) {
      centerOnGreen();
      return;
    }

    const bounds = new mapboxgl.LngLatBounds();
    points.forEach((p) => bounds.extend(p));
    map.current.fitBounds(bounds, {
      padding: { top: 120, bottom: 300, left: 40, right: 40 },
      duration: 800,
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
          <button
            onClick={onClose}
            className="flex items-center gap-2 text-white/80 hover:text-white"
          >
            <ChevronLeft size={24} />
            <span>Back</span>
          </button>

          <div className="text-center">
            <h1 className="text-white font-semibold">{courseName}</h1>
            <p className="text-zinc-400 text-sm">Hole {currentHole}</p>
          </div>

          <button
            onClick={() => setShowOverlays(!showOverlays)}
            className={`w-10 h-10 rounded-full flex items-center justify-center ${
              showOverlays
                ? "bg-emerald-500/30 text-emerald-400"
                : "bg-zinc-800/80 text-zinc-500"
            }`}
            title="Toggle overlays"
          >
            <Crosshair size={20} />
          </button>
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
            <span className="text-white font-bold text-lg">
              Hole {currentHole}
            </span>
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
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">
                Front
              </p>
              <p className="text-white text-2xl font-bold">
                {distances.front ?? "\u2014"}
              </p>
              <p className="text-zinc-500 text-xs">yds</p>
            </div>

            <div className="text-center">
              <div className="bg-emerald-500/20 rounded-2xl p-3 -mt-2">
                <p className="text-emerald-400 text-xs uppercase tracking-wider mb-1">
                  Center
                </p>
                <p className="text-emerald-400 text-4xl font-bold">
                  {distances.center ?? "\u2014"}
                </p>
                <p className="text-emerald-400/60 text-xs">yds</p>
              </div>
            </div>

            <div className="text-center">
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">
                Back
              </p>
              <p className="text-white text-2xl font-bold">
                {distances.back ?? "\u2014"}
              </p>
              <p className="text-zinc-500 text-xs">yds</p>
            </div>
          </div>

          {/* Pin distance */}
          {currentHoleData?.pin ? (
            <div className="flex items-center justify-center gap-2 mb-4 text-sm text-zinc-200">
              <Flag className="w-4 h-4 text-red-400" />
              <span className="text-zinc-400">Pin:</span>
              <span className="font-semibold">
                {distances.pin ?? "\u2014"} yds
              </span>
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
                    <span className="text-white font-semibold">
                      {Math.round(h.yards)}y
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Signal
                size={16}
                className={position ? "text-emerald-500" : "text-zinc-500"}
              />
              <span className="text-zinc-400 text-sm">
                {position
                  ? `GPS: ${getAccuracyDescription(position.accuracy || 0)} (\u00b1${Math.round(
                      position.accuracy || 0
                    )}m)`
                  : "Acquiring GPS..."}
              </span>
            </div>

            <div className="flex gap-2">
              <button
                onClick={fitHole}
                className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center"
                title="Fit hole"
              >
                <Target className="text-yellow-400" size={20} />
              </button>

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
        .tee-marker,
        .hazard-marker,
        .distance-label-marker {
          cursor: pointer;
        }
        .mapboxgl-ctrl-logo,
        .mapboxgl-ctrl-attrib {
          display: none !important;
        }
        @keyframes ping {
          75%,
          100% {
            transform: scale(2);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}
