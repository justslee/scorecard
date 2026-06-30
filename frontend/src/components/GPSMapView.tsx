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
  Layers,
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
import {
  type MapBaseStyle,
  baseStyleUrl,
  osmFillColor,
  osmFillOpacity,
  osmOutlineColor,
  holeViewBounds,
} from "@/lib/map/satellite-helpers";
import { T } from "@/components/yardage/tokens";

interface GPSMapViewProps {
  /** Course identifier — currently unused internally (prefixed _). */
  courseId: string | number;
  courseName: string;
  holeCoordinates: CourseCoordinates[];
  currentHole: number;
  onHoleChange: (hole: number) => void;
  /**
   * Called when the user taps "Back".
   * Required in fullscreen mode; optional in inline mode.
   */
  onClose?: () => void;
  /** Auto-detect hole based on nearest green. Defaults true. */
  autoDetectHole?: boolean;
  /**
   * Full-polygon GeoJSON features from a homegrown mapped course (OSM ingest).
   * Each feature must have ``properties.hole`` (number) and
   * ``properties.featureType`` ("green" | "fairway" | "tee" | "bunker" | "water").
   * When provided, the current hole's polygon outlines are rendered as
   * fill layers over the base (paper or satellite).
   */
  osmFeatures?: GeoJSON.Feature[];
  /**
   * When true, the map fills its parent container (relative positioning) instead
   * of a fixed full-screen overlay.  Used by InlineHoleDiagram inside the round
   * view.  Header and heavy chrome are suppressed; a compact bottom strip is shown.
   */
  inline?: boolean;
  /**
   * Center the map on these coordinates when no hole geometry is available
   * (center-only mode for non-ingested courses).
   */
  fallbackCenter?: { lat: number; lng: number };
  /**
   * When true: satellite + GPS + tap-to-measure are active but no hole overlays
   * or per-hole nav are shown (non-ingested course with imagery only).
   */
  centerOnly?: boolean;
}

// Layup ring distances in yards (centered on green)
const LAYUP_RINGS = [100, 150, 200];

// FCB ring source/layer IDs
const FCB_TYPES = ["front", "center", "back"] as const;
type FcbType = typeof FCB_TYPES[number];

const FCB_RING_COLORS: Record<FcbType, string> = {
  front:  "#fcd34d",   // amber-300 — front of green
  center: "#6ee7b7",   // emerald-300 — center
  back:   "#fb923c",   // orange-400 — back of green
};

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

// ── OSM polygon layer IDs ─────────────────────────────────────────────────────

const _OSM_SOURCE_ID      = "osm-current-hole";
const _OSM_FILL_LAYER_ID  = "osm-polygons-fill";
const _OSM_OUTLINE_LAYER_ID = "osm-polygons-outline";

// The set of feature types we explicitly map (used to build match expressions).
const OSM_FEATURE_TYPES = ["green", "fairway", "bunker", "tee", "water", "rough"] as const;

/** Build a Mapbox match expression for fill-color or line-color from the pure helpers. */
function buildColorExpr(
  getter: (ft: string, mode: MapBaseStyle) => string,
  mode: MapBaseStyle,
  defaultFt = "__default__"
): mapboxgl.Expression {
  const pairs: (string | number)[] = [];
  for (const ft of OSM_FEATURE_TYPES) {
    pairs.push(ft, getter(ft, mode));
  }
  return ["match", ["get", "featureType"], ...pairs, getter(defaultFt, mode)];
}

/** Build a Mapbox match expression for fill-opacity from the pure helpers. */
function buildOpacityExpr(
  mode: MapBaseStyle
): mapboxgl.Expression {
  const pairs: (string | number)[] = [];
  for (const ft of OSM_FEATURE_TYPES) {
    pairs.push(ft, osmFillOpacity(ft, mode));
  }
  return ["match", ["get", "featureType"], ...pairs, osmFillOpacity("__default__", mode)];
}

// ── Background and satellite layer IDs ──────────────────────────────────────

const _PAPER_BG_LAYER_ID       = "paper-background";
const _SAT_SOURCE_ID           = "satellite-raster-source";
const _SAT_LAYER_ID            = "satellite-raster-layer";

export default function GPSMapView({
  courseId: _courseId,
  courseName,
  holeCoordinates,
  currentHole,
  onHoleChange,
  onClose,
  autoDetectHole = true,
  osmFeatures,
  inline = false,
  fallbackCenter,
  centerOnly = false,
}: GPSMapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker    = useRef<mapboxgl.Marker | null>(null);
  const greenMarker   = useRef<mapboxgl.Marker | null>(null);
  const teeMarker     = useRef<mapboxgl.Marker | null>(null);
  const pinMarker     = useRef<mapboxgl.Marker | null>(null);
  const frontGreenMarker = useRef<mapboxgl.Marker | null>(null);
  const backGreenMarker  = useRef<mapboxgl.Marker | null>(null);
  const hazardMarkers = useRef<mapboxgl.Marker[]>([]);
  const distanceLabelMarker = useRef<mapboxgl.Marker | null>(null);
  const tapMeasureMarker    = useRef<mapboxgl.Marker | null>(null);
  const mapLoaded     = useRef(false);

  // Keep a ref to currentHoleData so the Mapbox click handler reads the latest
  // value without being re-registered on every hole change.
  const currentHoleRef = useRef(
    holeCoordinates.find((h) => h.holeNumber === currentHole)
  );

  const [position,     setPosition]     = useState<Position | null>(null);
  const [gpsError,     setGpsError]     = useState<string | null>(null);
  const [isLoading,    setIsLoading]    = useState(true);
  const [showOverlays, setShowOverlays] = useState(true);
  // vector = yardage-book paper style; satellite = aerial imagery
  const [mapStyle,     setMapStyle]     = useState<MapBaseStyle>("vector");
  const mapStyleRef = useRef<MapBaseStyle>("vector");

  const gpsWatcher = useRef<GPSWatcher | null>(null);

  const currentHoleData = holeCoordinates.find(
    (h) => h.holeNumber === currentHole
  );

  // Keep click-handler ref in sync; clear stale tap marker on hole nav.
  useEffect(() => {
    currentHoleRef.current = currentHoleData;
    tapMeasureMarker.current?.remove();
    tapMeasureMarker.current = null;
  }, [currentHoleData]);

  const distances = useMemo(() => {
    if (!position || !currentHoleData) {
      return {
        front:  null as number | null,
        center: null as number | null,
        back:   null as number | null,
        pin:    null as number | null,
      };
    }

    const center = calculateDistance(position, currentHoleData.green);
    const front  = currentHoleData.front
      ? calculateDistance(position, currentHoleData.front) : null;
    const back   = currentHoleData.back
      ? calculateDistance(position, currentHoleData.back)  : null;
    const pin    = currentHoleData.pin
      ? calculateDistance(position, currentHoleData.pin)   : null;

    return {
      front:  front?.yards ?? null,
      center: center.yards,
      back:   back?.yards  ?? null,
      pin:    pin?.yards   ?? null,
    };
  }, [position, currentHoleData]);

  const hazardDistances = useMemo(() => {
    if (!position || !currentHoleData?.hazards?.length)
      return [] as Array<{ type: string; yards: number }>;
    return currentHoleData.hazards
      .map((h) => ({
        type:  h.type,
        yards: calculateDistance(position, { lat: h.lat, lng: h.lng }).yards,
      }))
      .sort((a, b) => a.yards - b.yards)
      .slice(0, 4);
  }, [position, currentHoleData]);

  // ── OSM polygon overlay ────────────────────────────────────────────────────

  const updateOsmPolygons = useCallback(() => {
    if (!map.current || !mapLoaded.current) return;
    const m   = map.current;
    const mode = mapStyleRef.current;

    const holeFeatures = (osmFeatures ?? []).filter(
      (f) => f.properties?.hole === currentHole
    );
    const fc: GeoJSON.FeatureCollection = {
      type:     "FeatureCollection",
      features: holeFeatures,
    };

    const src = m.getSource(_OSM_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;
    if (src) {
      src.setData(fc);
      // Update paint properties to match current mode
      if (m.getLayer(_OSM_FILL_LAYER_ID)) {
        m.setPaintProperty(_OSM_FILL_LAYER_ID, "fill-color",   buildColorExpr(osmFillColor,   mode));
        m.setPaintProperty(_OSM_FILL_LAYER_ID, "fill-opacity",  buildOpacityExpr(mode));
      }
      if (m.getLayer(_OSM_OUTLINE_LAYER_ID)) {
        m.setPaintProperty(_OSM_OUTLINE_LAYER_ID, "line-color", buildColorExpr(osmOutlineColor, mode));
      }
    } else {
      m.addSource(_OSM_SOURCE_ID, { type: "geojson", data: fc });

      // Fill layer — uses mode-appropriate colors and opacity
      m.addLayer({
        id:     _OSM_FILL_LAYER_ID,
        type:   "fill",
        source: _OSM_SOURCE_ID,
        paint: {
          "fill-color":   buildColorExpr(osmFillColor, mode),
          "fill-opacity": buildOpacityExpr(mode),
        },
      });

      // Outline layer
      m.addLayer({
        id:     _OSM_OUTLINE_LAYER_ID,
        type:   "line",
        source: _OSM_SOURCE_ID,
        paint: {
          "line-color":   buildColorExpr(osmOutlineColor, mode),
          "line-width":   mode === "vector" ? 2 : 1.5,
          "line-opacity": mode === "vector" ? 0.85 : 0.75,
        },
      });
    }
  }, [currentHole, osmFeatures]);

  // ── Overlays: distance line, tee-to-green, layup rings, F/C/B rings ─────────

  const updateOverlays = useCallback(() => {
    if (!map.current || !mapLoaded.current || (!currentHoleData && !centerOnly)) return;
    if (centerOnly) return; // no hole geometry in center-only mode

    const m = map.current;

    // --- Distance line from user to green ---
    if (position && showOverlays && currentHoleData) {
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
        m.addSource("distance-line", { type: "geojson", data: distLineData });
        m.addLayer({
          id:     "distance-line-layer",
          type:   "line",
          source: "distance-line",
          paint: {
            "line-color":  T.accent,
            "line-width":  2.5,
            "line-opacity": 0.85,
          },
        });
      }

      // Distance label at midpoint
      const midLng = (position.lng + currentHoleData.green.lng) / 2;
      const midLat = (position.lat + currentHoleData.green.lat) / 2;
      const yds    = distances.center;

      if (yds !== null) {
        if (!distanceLabelMarker.current) {
          const el = document.createElement("div");
          el.className = "distance-label-marker";
          el.innerHTML = `<div style="padding:3px 8px;border-radius:8px;background:${T.accent};color:${T.paper};font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.3);">${yds}y</div>`;
          distanceLabelMarker.current = new mapboxgl.Marker({ element: el, anchor: "center" })
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
      if (m.getLayer("distance-line-layer")) m.removeLayer("distance-line-layer");
      if (m.getSource("distance-line"))      m.removeSource("distance-line");
      distanceLabelMarker.current?.remove();
      distanceLabelMarker.current = null;
    }

    // --- Tee-to-green line ---
    if (currentHoleData?.tee && showOverlays) {
      const teeGreenData: GeoJSON.Feature<GeoJSON.LineString> = {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [currentHoleData.tee.lng,   currentHoleData.tee.lat],
            [currentHoleData.green.lng, currentHoleData.green.lat],
          ],
        },
      };

      const src = m.getSource("tee-green-line") as mapboxgl.GeoJSONSource;
      if (src) {
        src.setData(teeGreenData);
      } else {
        m.addSource("tee-green-line", { type: "geojson", data: teeGreenData });
        m.addLayer({
          id:     "tee-green-line-layer",
          type:   "line",
          source: "tee-green-line",
          paint: {
            "line-color":      T.inkSoft,
            "line-width":      1.5,
            "line-opacity":    0.35,
            "line-dasharray":  [6, 4],
          },
        });
      }
    } else {
      if (m.getLayer("tee-green-line-layer")) m.removeLayer("tee-green-line-layer");
      if (m.getSource("tee-green-line"))      m.removeSource("tee-green-line");
    }

    if (!currentHoleData) return;

    // --- Layup rings: fixed 100/150/200y centered on green ---
    if (showOverlays) {
      for (const ringYards of LAYUP_RINGS) {
        const sourceId     = `layup-ring-${ringYards}`;
        const layerId      = `layup-ring-layer-${ringYards}`;
        const labelLayerId = `layup-ring-label-${ringYards}`;

        const circle = createCircleGeoJSON(currentHoleData.green, ringYards);

        const src = m.getSource(sourceId) as mapboxgl.GeoJSONSource;
        if (src) {
          src.setData(circle);
        } else {
          m.addSource(sourceId, { type: "geojson", data: circle });
          m.addLayer({
            id:     layerId,
            type:   "line",
            source: sourceId,
            paint: {
              "line-color":
                ringYards === 100 ? "#facc15" :
                ringYards === 150 ? "#fb923c" :
                                    "#ef4444",
              "line-width":      1.5,
              "line-opacity":    0.55,
              "line-dasharray":  [4, 3],
            },
          });
        }

        // Ring label (nearest to user, or north if no user)
        const labelSourceId = `${sourceId}-label`;
        const labelAngle    = position
          ? calculateBearing(currentHoleData.green, position)
          : 0;
        const labelPoint = turf.destination(
          [currentHoleData.green.lng, currentHoleData.green.lat],
          ringYards * 0.0009144,
          labelAngle,
          { units: "kilometers" }
        );
        const labelData: GeoJSON.Feature<GeoJSON.Point> = {
          type:       "Feature",
          properties: { label: `${ringYards}y` },
          geometry:   labelPoint.geometry,
        };

        const labelSrc = m.getSource(labelSourceId) as mapboxgl.GeoJSONSource;
        if (labelSrc) {
          labelSrc.setData(labelData);
        } else {
          m.addSource(labelSourceId, { type: "geojson", data: labelData });
          m.addLayer({
            id:     labelLayerId,
            type:   "symbol",
            source: labelSourceId,
            layout: {
              "text-field":         ["get", "label"],
              "text-size":          11,
              "text-font":          ["DIN Pro Medium", "Arial Unicode MS Regular"],
              "text-allow-overlap": true,
            },
            paint: {
              "text-color":      "#ffffff",
              "text-halo-color": "#000000",
              "text-halo-width": 1.5,
            },
          });
        }
      }
    } else {
      for (const ringYards of LAYUP_RINGS) {
        const sourceId     = `layup-ring-${ringYards}`;
        const layerId      = `layup-ring-layer-${ringYards}`;
        const labelSourceId = `${sourceId}-label`;
        const labelLayerId  = `layup-ring-label-${ringYards}`;
        if (m.getLayer(layerId))      m.removeLayer(layerId);
        if (m.getSource(sourceId))    m.removeSource(sourceId);
        if (m.getLayer(labelLayerId)) m.removeLayer(labelLayerId);
        if (m.getSource(labelSourceId)) m.removeSource(labelSourceId);
      }
    }

    // --- F/C/B rings: from player/tee to front/center/back of green ---
    // Shows the player the approach distance bracket to each part of the green.
    // Origin = GPS position when available, tee otherwise (static planning view).
    if (showOverlays && (currentHoleData.front || currentHoleData.back)) {
      const ringOrigin = position ?? currentHoleData.tee;
      if (ringOrigin) {
        const fcbDefs: Array<{ type: FcbType; coord: { lat: number; lng: number } | undefined }> = [
          { type: "front",  coord: currentHoleData.front  },
          { type: "center", coord: currentHoleData.green  },
          { type: "back",   coord: currentHoleData.back   },
        ];

        for (const { type, coord } of fcbDefs) {
          if (!coord) continue;
          const yds       = calculateDistance(ringOrigin, coord).yards;
          const sourceId  = `fcb-ring-${type}`;
          const layerId   = `fcb-ring-layer-${type}`;
          const labelSrcId = `fcb-ring-label-src-${type}`;
          const labelLayId = `fcb-ring-label-${type}`;
          const color     = FCB_RING_COLORS[type];

          const circle = createCircleGeoJSON(ringOrigin, yds);
          const src = m.getSource(sourceId) as mapboxgl.GeoJSONSource;
          if (src) {
            src.setData(circle);
          } else {
            m.addSource(sourceId, { type: "geojson", data: circle });
            m.addLayer({
              id:     layerId,
              type:   "line",
              source: sourceId,
              paint: {
                "line-color":   color,
                "line-width":   type === "center" ? 2 : 1.5,
                "line-opacity": type === "center" ? 0.75 : 0.60,
              },
            });
          }

          // Label at the top of the ring (towards green from the origin)
          const bearingToGreen = calculateBearing(ringOrigin, currentHoleData.green);
          const labelPt = turf.destination(
            [ringOrigin.lng, ringOrigin.lat],
            yds * 0.0009144,
            bearingToGreen,
            { units: "kilometers" }
          );
          const prefix = type === "front" ? "F" : type === "center" ? "C" : "B";
          const labelData: GeoJSON.Feature<GeoJSON.Point> = {
            type:       "Feature",
            properties: { label: `${prefix} ${yds}y` },
            geometry:   labelPt.geometry,
          };
          const labelSrc = m.getSource(labelSrcId) as mapboxgl.GeoJSONSource;
          if (labelSrc) {
            labelSrc.setData(labelData);
          } else {
            m.addSource(labelSrcId, { type: "geojson", data: labelData });
            m.addLayer({
              id:     labelLayId,
              type:   "symbol",
              source: labelSrcId,
              layout: {
                "text-field":         ["get", "label"],
                "text-size":          10,
                "text-font":          ["DIN Pro Medium", "Arial Unicode MS Regular"],
                "text-allow-overlap": true,
              },
              paint: {
                "text-color":      color,
                "text-halo-color": mapStyleRef.current === "vector" ? T.paper : "#000000",
                "text-halo-width": 2,
              },
            });
          }
        }
      }
    } else if (!showOverlays) {
      // Clean up FCB rings when overlays disabled
      for (const type of FCB_TYPES) {
        const sourceId  = `fcb-ring-${type}`;
        const layerId   = `fcb-ring-layer-${type}`;
        const labelSrcId = `fcb-ring-label-src-${type}`;
        const labelLayId = `fcb-ring-label-${type}`;
        if (m.getLayer(layerId))   m.removeLayer(layerId);
        if (m.getSource(sourceId)) m.removeSource(sourceId);
        if (m.getLayer(labelLayId))   m.removeLayer(labelLayId);
        if (m.getSource(labelSrcId))  m.removeSource(labelSrcId);
      }
    }
  }, [currentHoleData, position, showOverlays, distances.center, centerOnly]);

  // ── Style toggle ──────────────────────────────────────────────────────────

  const toggleBaseStyle = useCallback(() => {
    if (!map.current || !mapLoaded.current) return;
    const m       = map.current;
    const newMode: MapBaseStyle = mapStyleRef.current === "vector" ? "satellite" : "vector";
    mapStyleRef.current = newMode;
    setMapStyle(newMode);

    // Show / hide satellite raster layer
    if (m.getLayer(_SAT_LAYER_ID)) {
      m.setLayoutProperty(_SAT_LAYER_ID, "visibility", newMode === "satellite" ? "visible" : "none");
    }
    // Show / hide paper background
    if (m.getLayer(_PAPER_BG_LAYER_ID)) {
      m.setLayoutProperty(_PAPER_BG_LAYER_ID, "visibility", newMode === "vector" ? "visible" : "none");
    }
    // Update OSM fill / outline paint for new mode
    updateOsmPolygons();
    // Refresh label halo color for F/C/B ring labels on next overlay update
    updateOverlays();
  }, [updateOsmPolygons, updateOverlays]);

  // ── Map initialization ─────────────────────────────────────────────────────

  useEffect(() => {
    // Need either hole data OR a fallback center to render anything.
    if (!mapContainer.current || (!currentHoleData && !fallbackCenter)) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
    if (!mapboxgl.accessToken) {
      setGpsError("Mapbox token not configured");
      setIsLoading(false);
      return;
    }

    const initialBearing = currentHoleData?.tee
      ? calculateBearing(currentHoleData.tee, currentHoleData.green) : 0;

    // Build map options — use fitBounds for ingested courses (frames the whole
    // hole tee-to-green like a yardage book page); plain center for center-only.
    const mapOpts: mapboxgl.MapboxOptions = {
      container: mapContainer.current,
      style:     baseStyleUrl("vector"), // always empty-v9; satellite is a custom layer
      pitch:     35,
      bearing:   initialBearing,
    };

    if (currentHoleData) {
      const bounds = holeViewBounds(currentHoleData);
      mapOpts.bounds = bounds as mapboxgl.LngLatBoundsLike;
      mapOpts.fitBoundsOptions = {
        padding:    { top: 120, bottom: 280, left: 40, right: 40 },
        bearing:    initialBearing,
        pitch:      35,
        maxZoom:    18,
      };
    } else {
      // Center-only mode: just center on the known location
      mapOpts.center = [fallbackCenter!.lng, fallbackCenter!.lat];
      mapOpts.zoom   = 15;
      mapOpts.pitch  = 0;
    }

    map.current = new mapboxgl.Map(mapOpts);

    map.current.on("load", () => {
      mapLoaded.current = true;
      const m = map.current!;

      // ── 1. Paper background layer (vector mode default) ──────────────────
      m.addLayer({
        id:   _PAPER_BG_LAYER_ID,
        type: "background",
        paint: { "background-color": T.paper },
      });

      // ── 2. Satellite raster (initially hidden; revealed on toggle) ────────
      m.addSource(_SAT_SOURCE_ID, {
        type:     "raster",
        url:      "mapbox://mapbox.satellite",
        tileSize: 256,
      });
      m.addLayer({
        id:     _SAT_LAYER_ID,
        type:   "raster",
        source: _SAT_SOURCE_ID,
        layout: { visibility: "none" }, // hidden in vector mode
        paint:  { "raster-opacity": 1 },
      });

      // ── 3. OSM polygon overlay (added above satellite) ────────────────────
      updateOsmPolygons();

      // ── 4. Distance overlays (above OSM) ─────────────────────────────────
      if (!centerOnly) {
        updateOverlays();
      }

      // ── 5. Point markers ─────────────────────────────────────────────────
      if (currentHoleData) {
        // Green marker (center)
        const greenEl = document.createElement("div");
        greenEl.innerHTML = `
          <div style="width:30px;height:30px;border-radius:50%;background:rgba(140,178,100,0.95);border:2px solid ${T.ink};box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;">
            <span style="color:${T.ink};font-size:11px;font-weight:700;">G</span>
          </div>`;
        greenMarker.current = new mapboxgl.Marker({ element: greenEl })
          .setLngLat([currentHoleData.green.lng, currentHoleData.green.lat])
          .addTo(m);

        // Front of green marker
        if (currentHoleData.front) {
          const fEl = document.createElement("div");
          fEl.innerHTML = `
            <div style="width:20px;height:20px;border-radius:50%;background:rgba(252,211,77,0.9);border:1.5px solid ${T.ink};box-shadow:0 1px 4px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
              <span style="color:${T.ink};font-size:9px;font-weight:700;">F</span>
            </div>`;
          frontGreenMarker.current = new mapboxgl.Marker({ element: fEl })
            .setLngLat([currentHoleData.front.lng, currentHoleData.front.lat])
            .addTo(m);
        }

        // Back of green marker
        if (currentHoleData.back) {
          const bEl = document.createElement("div");
          bEl.innerHTML = `
            <div style="width:20px;height:20px;border-radius:50%;background:rgba(251,146,60,0.9);border:1.5px solid ${T.ink};box-shadow:0 1px 4px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
              <span style="color:${T.ink};font-size:9px;font-weight:700;">B</span>
            </div>`;
          backGreenMarker.current = new mapboxgl.Marker({ element: bEl })
            .setLngLat([currentHoleData.back.lng, currentHoleData.back.lat])
            .addTo(m);
        }

        // Tee marker
        if (currentHoleData.tee) {
          const teeEl = document.createElement("div");
          teeEl.innerHTML = `
            <div style="width:26px;height:26px;border-radius:50%;background:rgba(168,85,247,0.9);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;">
              <span style="color:white;font-size:10px;font-weight:700;">T</span>
            </div>`;
          teeMarker.current = new mapboxgl.Marker({ element: teeEl })
            .setLngLat([currentHoleData.tee.lng, currentHoleData.tee.lat])
            .addTo(m);
        }

        // Pin marker
        if (currentHoleData.pin) {
          const pinEl = document.createElement("div");
          pinEl.innerHTML = `
            <div style="width:26px;height:26px;border-radius:50%;background:rgba(239,68,68,0.9);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;">
              <span style="color:white;font-size:13px;">&#9873;</span>
            </div>`;
          pinMarker.current = new mapboxgl.Marker({ element: pinEl })
            .setLngLat([currentHoleData.pin.lng, currentHoleData.pin.lat])
            .addTo(m);
        }

        // Hazard markers
        hazardMarkers.current.forEach((hm) => hm.remove());
        hazardMarkers.current = [];
        (currentHoleData.hazards || []).forEach((h) => {
          const el = document.createElement("div");
          const color =
            h.type === "water"  ? "rgba(59,130,246,0.9)" :
            h.type === "bunker" ? "rgba(234,179,8,0.9)"  :
                                  "rgba(249,115,22,0.9)";
          const label =
            h.type === "water" ? "W" : h.type === "bunker" ? "B" : "H";
          el.innerHTML = `
            <div style="width:22px;height:22px;border-radius:50%;background:${color};border:1.5px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;">
              <span style="color:white;font-size:9px;font-weight:700;">${label}</span>
            </div>`;
          const hm = new mapboxgl.Marker({ element: el })
            .setLngLat([h.lng, h.lat])
            .addTo(m);
          hazardMarkers.current.push(hm);
        });
      }

      setIsLoading(false);
    });

    // ── Tap-to-measure ─────────────────────────────────────────────────────
    map.current.on("click", (e) => {
      const hd = currentHoleRef.current;
      // In center-only mode, show a simple distance-from-tap to any tap point
      if (!hd) {
        // Center-only: no pin reference, just show coordinates
        return;
      }

      const tapPos  = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const pinPos  = hd.pin ?? hd.green;
      const toPin   = calculateDistance(tapPos, pinPos).yards;
      const fromTee = hd.tee ? calculateDistance(tapPos, hd.tee).yards : null;

      const label = fromTee !== null
        ? `Tee ${fromTee}y · Pin ${toPin}y`
        : `Pin ${toPin}y`;

      tapMeasureMarker.current?.remove();

      const el = document.createElement("div");
      el.innerHTML = `
        <div style="position:relative;display:inline-block;">
          <div style="background:rgba(0,0,0,0.78);color:white;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;white-space:nowrap;backdrop-filter:blur(6px);box-shadow:0 2px 10px rgba(0,0,0,0.5);display:flex;align-items:center;gap:6px;">
            <span>${label}</span>
            <span class="tap-dismiss-btn" style="cursor:pointer;opacity:0.65;font-size:14px;line-height:1;">×</span>
          </div>
          <div style="position:absolute;bottom:-5px;left:50%;transform:translateX(-50%);width:2px;height:6px;background:rgba(255,255,255,0.6);"></div>
        </div>`;

      const dismissBtn = el.querySelector(".tap-dismiss-btn");
      if (dismissBtn) {
        dismissBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          tapMeasureMarker.current?.remove();
          tapMeasureMarker.current = null;
        });
      }

      tapMeasureMarker.current = new mapboxgl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([e.lngLat.lng, e.lngLat.lat])
        .addTo(map.current!);
    });

    return () => {
      mapLoaded.current = false;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Update markers and overlays on hole change ─────────────────────────────

  useEffect(() => {
    if (!map.current || !currentHoleData || !mapLoaded.current) return;

    // Update green marker
    greenMarker.current?.setLngLat([currentHoleData.green.lng, currentHoleData.green.lat]);

    // Front/back green markers
    if (currentHoleData.front) {
      if (!frontGreenMarker.current) {
        const fEl = document.createElement("div");
        fEl.innerHTML = `<div style="width:20px;height:20px;border-radius:50%;background:rgba(252,211,77,0.9);border:1.5px solid ${T.ink};box-shadow:0 1px 4px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;"><span style="color:${T.ink};font-size:9px;font-weight:700;">F</span></div>`;
        frontGreenMarker.current = new mapboxgl.Marker({ element: fEl })
          .setLngLat([currentHoleData.front.lng, currentHoleData.front.lat])
          .addTo(map.current);
      } else {
        frontGreenMarker.current.setLngLat([currentHoleData.front.lng, currentHoleData.front.lat]);
      }
    } else {
      frontGreenMarker.current?.remove();
      frontGreenMarker.current = null;
    }

    if (currentHoleData.back) {
      if (!backGreenMarker.current) {
        const bEl = document.createElement("div");
        bEl.innerHTML = `<div style="width:20px;height:20px;border-radius:50%;background:rgba(251,146,60,0.9);border:1.5px solid ${T.ink};box-shadow:0 1px 4px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;"><span style="color:${T.ink};font-size:9px;font-weight:700;">B</span></div>`;
        backGreenMarker.current = new mapboxgl.Marker({ element: bEl })
          .setLngLat([currentHoleData.back.lng, currentHoleData.back.lat])
          .addTo(map.current);
      } else {
        backGreenMarker.current.setLngLat([currentHoleData.back.lng, currentHoleData.back.lat]);
      }
    } else {
      backGreenMarker.current?.remove();
      backGreenMarker.current = null;
    }

    // Tee marker
    if (currentHoleData.tee) {
      if (!teeMarker.current) {
        const teeEl = document.createElement("div");
        teeEl.innerHTML = `<div style="width:26px;height:26px;border-radius:50%;background:rgba(168,85,247,0.9);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;"><span style="color:white;font-size:10px;font-weight:700;">T</span></div>`;
        teeMarker.current = new mapboxgl.Marker({ element: teeEl })
          .setLngLat([currentHoleData.tee.lng, currentHoleData.tee.lat])
          .addTo(map.current);
      } else {
        teeMarker.current.setLngLat([currentHoleData.tee.lng, currentHoleData.tee.lat]);
      }
    } else {
      teeMarker.current?.remove();
      teeMarker.current = null;
    }

    // Pin marker
    if (currentHoleData.pin) {
      if (!pinMarker.current) {
        const pinEl = document.createElement("div");
        pinEl.innerHTML = `<div style="width:26px;height:26px;border-radius:50%;background:rgba(239,68,68,0.9);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;"><span style="color:white;font-size:13px;">&#9873;</span></div>`;
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

    // Hazard markers
    hazardMarkers.current.forEach((hm) => hm.remove());
    hazardMarkers.current = [];
    (currentHoleData.hazards || []).forEach((h) => {
      const el = document.createElement("div");
      const color =
        h.type === "water"  ? "rgba(59,130,246,0.9)" :
        h.type === "bunker" ? "rgba(234,179,8,0.9)"  :
                              "rgba(249,115,22,0.9)";
      const label = h.type === "water" ? "W" : h.type === "bunker" ? "B" : "H";
      el.innerHTML = `<div style="width:22px;height:22px;border-radius:50%;background:${color};border:1.5px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;"><span style="color:white;font-size:9px;font-weight:700;">${label}</span></div>`;
      const hm = new mapboxgl.Marker({ element: el })
        .setLngLat([h.lng, h.lat])
        .addTo(map.current!);
      hazardMarkers.current.push(hm);
    });

    // Fly to hole using fitBounds — frames the whole tee-to-green extent.
    // green is "up" via the bearing; pitch 35° gives a gentle perspective.
    const bearing = currentHoleData.tee
      ? calculateBearing(currentHoleData.tee, currentHoleData.green)
      : 0;

    const bounds = holeViewBounds(currentHoleData, position ?? undefined);
    map.current.fitBounds(bounds as mapboxgl.LngLatBoundsLike, {
      padding:  { top: 120, bottom: 280, left: 40, right: 40 },
      bearing,
      pitch:    35,
      maxZoom:  18,
      duration: 900,
    });

    updateOverlays();
    updateOsmPolygons();
  }, [currentHoleData, updateOverlays, updateOsmPolygons, position]);

  // Update overlays when position or showOverlays changes
  useEffect(() => {
    updateOverlays();
  }, [position, showOverlays, updateOverlays]);

  // Update OSM polygons when osmFeatures changes (e.g. async load).
  useEffect(() => {
    updateOsmPolygons();
  }, [updateOsmPolygons]);

  // ── GPS watcher ────────────────────────────────────────────────────────────

  const handlePositionUpdate = useCallback(
    (pos: Position) => {
      setPosition(pos);
      setGpsError(null);

      if (!map.current) return;

      if (!userMarker.current) {
        const userEl = document.createElement("div");
        userEl.innerHTML = `
          <div style="position:relative;">
            <div style="width:22px;height:22px;border-radius:50%;background:${T.accent};border:3px solid white;box-shadow:0 2px 12px rgba(58,74,138,0.6);"></div>
            <div style="position:absolute;inset:0;width:22px;height:22px;border-radius:50%;background:${T.accent};animation:ping 1.5s cubic-bezier(0,0,0.2,1) infinite;opacity:0.3;"></div>
          </div>`;
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
    },
    []
  );

  useEffect(() => {
    gpsWatcher.current = new GPSWatcher(handlePositionUpdate, handleGpsError);
    gpsWatcher.current.start();
    return () => { gpsWatcher.current?.stop(); };
  }, [handlePositionUpdate, handleGpsError]);

  // ── Map control helpers ────────────────────────────────────────────────────

  const centerOnUser = () => {
    if (!map.current || !position) return;
    map.current.flyTo({ center: [position.lng, position.lat], zoom: 18, duration: 500 });
  };

  const centerOnGreen = () => {
    if (!map.current || !currentHoleData) return;
    map.current.flyTo({ center: [currentHoleData.green.lng, currentHoleData.green.lat], zoom: 17, duration: 500 });
  };

  const fitHole = () => {
    if (!map.current || !currentHoleData) return;
    const bearing = currentHoleData.tee
      ? calculateBearing(currentHoleData.tee, currentHoleData.green) : 0;
    const bounds = holeViewBounds(currentHoleData, position ?? undefined);
    map.current.fitBounds(bounds as mapboxgl.LngLatBoundsLike, {
      padding:  { top: 120, bottom: 280, left: 40, right: 40 },
      bearing,
      pitch:    35,
      maxZoom:  18,
      duration: 800,
    });
  };

  const prevHole = () => { if (currentHole > 1) onHoleChange(currentHole - 1); };
  const nextHole = () => { if (currentHole < 18) onHoleChange(currentHole + 1); };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={inline ? "relative w-full h-full bg-zinc-100" : "fixed inset-0 z-50 bg-zinc-100"}>
      {/* Header — fullscreen mode only */}
      {!inline && (
        <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-zinc-950/80 to-transparent p-4 pb-8">
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
              {!centerOnly && (
                <p className="text-zinc-300 text-sm">Hole {currentHole}</p>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Satellite toggle */}
              <button
                onClick={toggleBaseStyle}
                className={`w-9 h-9 rounded-full flex items-center justify-center ${
                  mapStyle === "satellite"
                    ? "bg-sky-500/30 text-sky-300"
                    : "bg-zinc-800/80 text-zinc-400"
                }`}
                title={mapStyle === "satellite" ? "Switch to yardage-book view" : "Switch to satellite view"}
              >
                <Layers size={18} />
              </button>
              {/* Overlay toggle */}
              <button
                onClick={() => setShowOverlays(!showOverlays)}
                className={`w-9 h-9 rounded-full flex items-center justify-center ${
                  showOverlays
                    ? "bg-emerald-500/30 text-emerald-400"
                    : "bg-zinc-800/80 text-zinc-500"
                }`}
                title="Toggle overlays"
              >
                <Crosshair size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inline top-right controls */}
      {inline && (
        <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
          <button
            onClick={toggleBaseStyle}
            className={`w-7 h-7 rounded-full flex items-center justify-center ${
              mapStyle === "satellite"
                ? "bg-sky-500/30 text-sky-300"
                : "bg-zinc-800/70 text-zinc-400"
            }`}
            title={mapStyle === "satellite" ? "Yardage-book view" : "Satellite view"}
          >
            <Layers size={14} />
          </button>
          <button
            onClick={() => setShowOverlays(!showOverlays)}
            className={`w-7 h-7 rounded-full flex items-center justify-center ${
              showOverlays
                ? "bg-emerald-500/30 text-emerald-400"
                : "bg-zinc-800/70 text-zinc-500"
            }`}
            title="Toggle overlays"
          >
            <Crosshair size={14} />
          </button>
        </div>
      )}

      {/* Map canvas */}
      <div ref={mapContainer} className="w-full h-full" />

      {/* Center-only note */}
      {centerOnly && !isLoading && (
        <div className="absolute top-1/2 left-4 right-4 z-10 -translate-y-32 pointer-events-none">
          <div
            className="rounded-xl p-3 text-center"
            style={{
              background: `${T.paper}e8`,
              color: T.pencil,
              fontFamily: T.mono,
              fontSize: 11,
              letterSpacing: 0.8,
            }}
          >
            Satellite view · GPS + tap-to-measure active
            <br />
            <span style={{ color: T.pencilSoft }}>
              Detailed hole data not available for this course yet
            </span>
          </div>
        </div>
      )}

      {/* Loading overlay */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center z-20"
            style={{ background: T.paper }}
          >
            <div className="text-center">
              <Loader2
                className="w-10 h-10 animate-spin mx-auto mb-3"
                style={{ color: T.inkSoft }}
              />
              <p style={{ color: T.pencil, fontFamily: T.sans, fontSize: 13 }}>
                Loading map…
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* GPS error banner */}
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

      {/* Distance Panel (bottom) */}
      {!centerOnly && (
        <div className="absolute bottom-0 left-0 right-0 z-10">
          {/* Hole navigation — fullscreen only */}
          {!inline && (
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
          )}

          {/* Compact inline strip */}
          {inline ? (
            <div className="bg-zinc-900/90 backdrop-blur-sm px-4 py-2 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 text-xs">
                <span className="text-zinc-500">F</span>
                <span className="text-white font-semibold">{distances.front ?? "—"}</span>
                <span className="text-emerald-400 font-bold">{distances.center ?? "—"}</span>
                <span className="text-zinc-500">B</span>
                <span className="text-white font-semibold">{distances.back ?? "—"}</span>
                <span className="text-zinc-500 text-[10px]">yds</span>
              </div>
              <div className="flex items-center gap-1">
                <Signal size={12} className={position ? "text-emerald-500" : "text-zinc-600"} />
                <span className="text-zinc-500 text-[10px]">
                  {position ? `±${Math.round(position.accuracy || 0)}m` : "GPS…"}
                </span>
              </div>
            </div>
          ) : (
            /* Full detail panel */
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

              {currentHoleData?.pin && (
                <div className="flex items-center justify-center gap-2 mb-4 text-sm text-zinc-200">
                  <Flag className="w-4 h-4 text-red-400" />
                  <span className="text-zinc-400">Pin:</span>
                  <span className="font-semibold">{distances.pin ?? "—"} yds</span>
                </div>
              )}

              {hazardDistances.length > 0 && (
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
              )}

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Signal size={16} className={position ? "text-emerald-500" : "text-zinc-500"} />
                  <span className="text-zinc-400 text-sm">
                    {position
                      ? `GPS: ${getAccuracyDescription(position.accuracy || 0)} (±${Math.round(position.accuracy || 0)}m)`
                      : "Acquiring GPS…"}
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
          )}
        </div>
      )}

      {/* GPS panel for center-only mode */}
      {centerOnly && (
        <div className="absolute bottom-0 left-0 right-0 z-10">
          <div className="bg-zinc-900/90 backdrop-blur-sm px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Signal size={14} className={position ? "text-emerald-500" : "text-zinc-600"} />
              <span className="text-zinc-400 text-xs">
                {position ? `±${Math.round(position.accuracy || 0)}m` : "Acquiring GPS…"}
              </span>
            </div>
            <button
              onClick={centerOnUser}
              disabled={!position}
              className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center disabled:opacity-30"
            >
              <Navigation className="text-blue-400" size={16} />
            </button>
          </div>
        </div>
      )}

      <style jsx global>{`
        .mapboxgl-ctrl-logo,
        .mapboxgl-ctrl-attrib {
          display: none !important;
        }
        @keyframes ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
