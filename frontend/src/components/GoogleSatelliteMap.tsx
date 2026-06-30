"use client";

/**
 * GoogleSatelliteMap — Google Maps satellite hole diagram.
 *
 * Replaces the Mapbox GPSMapView for the hole-map screens.  Renders native
 * Google Maps satellite imagery via @capacitor/google-maps (native UIKit on
 * iOS; Maps JS API on web).
 *
 * Architecture:
 *   • The map div is a transparent placeholder; the native map (iOS) renders
 *     behind the WKWebView which is set to transparent over that region.
 *   • Header, distance panel, and controls are React siblings of the map div
 *     and therefore appear ON TOP of the native map layer — standard Capacitor
 *     layering pattern.
 *   • All map overlays (markers, circles, polylines) go through the plugin API.
 *
 * Off-hole guard (v1.0.598 fix preserved):
 *   • `isGpsOnHole` is checked before using GPS for distances or the GPS dot.
 *   • Camera is always fitted to tee→green bounds (never to a far-away GPS fix).
 *
 * Fallback:
 *   • When NEXT_PUBLIC_GOOGLE_MAPS_KEY is absent the parent (page.tsx /
 *     InlineHoleDiagram.tsx) renders the on-paper HoleDiagram instead —
 *     this component is not mounted.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
// @capacitor/google-maps references HTMLElement at module evaluation time,
// so it must NOT be imported at the top level (would crash SSR / static build).
// We dynamic-import it inside the useEffect (client-only) instead.
import type { GoogleMap, Marker, Circle, Polyline } from "@capacitor/google-maps";
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
import { motion, AnimatePresence } from "framer-motion";
import {
  GPSWatcher,
  calculateDistance,
  calculateBearing,
  getAccuracyDescription,
  type Position,
} from "@/lib/gps";
import type { CourseCoordinates } from "@/lib/golf-api";
import { isGpsOnHole } from "@/lib/map/satellite-helpers";
import {
  yardsToMeters,
  CENTER_ONLY_ZOOM,
  LAYUP_RING_YARDS,
  LAYUP_RING_COLORS,
  FCB_RING_COLORS,
  tapMeasureLabelGoogle,
  fcbMarkerSnippet,
  cameraForHole,
} from "@/lib/map/google-map-helpers";
import { T } from "@/components/yardage/tokens";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface GoogleSatelliteMapProps {
  /** Course identifier (unused internally; kept for API parity with GPSMapView). */
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
   * When true, the map fills its parent container (relative positioning) instead
   * of a fixed full-screen overlay.  Used by InlineHoleDiagram inside the round
   * view.  Header and heavy chrome are suppressed.
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
  /**
   * Called when Google Maps fails to initialize (JS-catchable error).
   * The parent should switch back to the HoleDiagram renderer.
   *
   * Note: a native iOS NSException crash cannot be caught in JS — the
   * default-to-HoleDiagram pattern (not auto-loading Google on open) is the
   * primary safeguard against that.  This callback catches JS-level failures
   * such as a bad API key, an unsized container, or a plugin rejection.
   */
  onFallback?: () => void;
  /**
   * When provided, renders a calm "Paper" toggle in the fullscreen header so
   * the user can switch back to HoleDiagram without closing the map.
   * Has no effect in inline mode (parent manages the toggle there).
   */
  onSwitchToPaper?: () => void;
}

// ── FCB types ─────────────────────────────────────────────────────────────────

type FcbType = "front" | "center" | "back";

// ── Unique map ID helper ──────────────────────────────────────────────────────

let _mapCounter = 0;
function nextMapId(): string {
  _mapCounter += 1;
  return `gsat-map-${_mapCounter}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GoogleSatelliteMap({
  courseId: _courseId,
  courseName,
  holeCoordinates,
  currentHole,
  onHoleChange,
  onClose,
  autoDetectHole = true,
  inline = false,
  fallbackCenter,
  centerOnly = false,
  onFallback,
  onSwitchToPaper,
}: GoogleSatelliteMapProps) {
  const mapContainerRef = useRef<HTMLElement | null>(null);
  const googleMapRef    = useRef<GoogleMap | null>(null);
  const mapReadyRef     = useRef(false);
  const mapIdRef        = useRef<string>(nextMapId());
  // Re-entry guard: prevents StrictMode double-invoke and any other case where
  // the init effect fires while a previous create is still in-flight.
  const createInProgressRef = useRef(false);

  // Overlay ID tracking — needed to remove markers/circles/lines before re-adding.
  const holeMarkerIdsRef    = useRef<string[]>([]);
  const holeCircleIdsRef    = useRef<string[]>([]);
  const holePolylineIdsRef  = useRef<string[]>([]);
  const gpsMarkerIdRef      = useRef<string | null>(null);
  const tapMarkerIdRef      = useRef<string | null>(null);

  // Keep currentHoleData in a ref so the click handler reads the latest value
  // without being re-registered on every hole change.
  const currentHoleRef = useRef(
    holeCoordinates.find((h) => h.holeNumber === currentHole)
  );

  const [position,  setPosition]  = useState<Position | null>(null);
  const [gpsError,  setGpsError]  = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const gpsWatcherRef = useRef<GPSWatcher | null>(null);

  // ── Derived data ───────────────────────────────────────────────────────────

  const currentHoleData = useMemo(
    () => holeCoordinates.find((h) => h.holeNumber === currentHole),
    [holeCoordinates, currentHole]
  );

  /** True when the GPS fix is near enough to this hole to be meaningful. */
  const isOnHole = useMemo(
    () => (position && currentHoleData ? isGpsOnHole(position, currentHoleData) : false),
    [position, currentHoleData]
  );

  /**
   * Per-hole distances (F / C / B / pin) — same guard logic as GPSMapView:
   * GPS distances only when the player is actually on the hole; tee-based
   * distances otherwise.  Prevents absurd "49 000 yd" readouts.
   */
  const distances = useMemo(() => {
    if (!currentHoleData) {
      return { front: null as number | null, center: null as number | null, back: null as number | null, pin: null as number | null };
    }
    const onHole = position ? isGpsOnHole(position, currentHoleData) : false;
    const origin = (onHole && position) ? position : currentHoleData.tee;
    if (!origin) {
      return { front: null as number | null, center: null as number | null, back: null as number | null, pin: null as number | null };
    }
    const center = calculateDistance(origin, currentHoleData.green);
    const front  = currentHoleData.front ? calculateDistance(origin, currentHoleData.front) : null;
    const back   = currentHoleData.back  ? calculateDistance(origin, currentHoleData.back)  : null;
    const pin    = (onHole && position && currentHoleData.pin)
      ? calculateDistance(position, currentHoleData.pin)
      : null;
    return {
      front:  front?.yards  ?? null,
      center: center.yards,
      back:   back?.yards   ?? null,
      pin:    pin?.yards    ?? null,
    };
  }, [position, currentHoleData]);

  // ── Overlay helpers ────────────────────────────────────────────────────────

  /**
   * Remove all current hole overlays (markers, circles, polylines).
   * Called before re-adding on hole change.
   */
  const clearHoleOverlays = useCallback(async () => {
    const m = googleMapRef.current;
    if (!m) return;
    const markerIds   = holeMarkerIdsRef.current;
    const circleIds   = holeCircleIdsRef.current;
    const polylineIds = holePolylineIdsRef.current;
    if (markerIds.length   > 0) await m.removeMarkers(markerIds).catch(() => {});
    if (circleIds.length   > 0) await m.removeCircles(circleIds).catch(() => {});
    if (polylineIds.length > 0) await m.removePolylines(polylineIds).catch(() => {});
    holeMarkerIdsRef.current   = [];
    holeCircleIdsRef.current   = [];
    holePolylineIdsRef.current = [];
  }, []);

  /**
   * Remove the tap-to-measure marker (if any).
   */
  const clearTapMarker = useCallback(async () => {
    const m  = googleMapRef.current;
    const id = tapMarkerIdRef.current;
    if (m && id) {
      await m.removeMarker(id).catch(() => {});
      tapMarkerIdRef.current = null;
    }
  }, []);

  /**
   * Remove the GPS "you" dot (if any).
   */
  const clearGpsMarker = useCallback(async () => {
    const m  = googleMapRef.current;
    const id = gpsMarkerIdRef.current;
    if (m && id) {
      await m.removeMarker(id).catch(() => {});
      gpsMarkerIdRef.current = null;
    }
  }, []);

  /**
   * Add all overlays for the current hole:
   *   • Green (G), tee (T), front (F), back (B), pin (P) markers
   *   • Layup rings (100 / 150 / 200 yd from green)
   *   • F/C/B approach rings + tee→green guide line
   */
  const addHoleOverlays = useCallback(async (hd: CourseCoordinates, gpsOnHole: boolean, pos: Position | null) => {
    const m = googleMapRef.current;
    if (!m || !mapReadyRef.current) return;

    const newMarkerIds:   string[] = [];
    const newCircleIds:   string[] = [];
    const newPolylineIds: string[] = [];

    // ── Point markers ─────────────────────────────────────────────────────

    const markers: Marker[] = [
      // Green center
      { coordinate: { lat: hd.green.lat, lng: hd.green.lng }, title: "G", snippet: "Green center" },
    ];
    if (hd.tee)   markers.push({ coordinate: { lat: hd.tee.lat,   lng: hd.tee.lng   }, title: "T", snippet: "Tee" });
    if (hd.front) markers.push({ coordinate: { lat: hd.front.lat, lng: hd.front.lng }, title: "F", snippet: fcbMarkerSnippet("front",  calculateDistance(hd.tee ?? hd.green, hd.front).yards) });
    if (hd.back)  markers.push({ coordinate: { lat: hd.back.lat,  lng: hd.back.lng  }, title: "B", snippet: fcbMarkerSnippet("back",   calculateDistance(hd.tee ?? hd.green, hd.back).yards)  });
    if (hd.pin)   markers.push({ coordinate: { lat: hd.pin.lat,   lng: hd.pin.lng   }, title: "P", snippet: "Pin" });

    const addedMarkerIds = await m.addMarkers(markers).catch(() => [] as string[]);
    newMarkerIds.push(...addedMarkerIds);

    // ── Layup rings (100 / 150 / 200 yd centered on green) ───────────────

    const layupCircles: Circle[] = LAYUP_RING_YARDS.map((yd) => ({
      center:        { lat: hd.green.lat, lng: hd.green.lng },
      radius:        yardsToMeters(yd),
      strokeColor:   LAYUP_RING_COLORS[yd],
      strokeWeight:  2,
      fillOpacity:   0,
      clickable:     false,
      tag:           `layup-${yd}`,
    }));
    const addedCircleIds = await m.addCircles(layupCircles).catch(() => [] as string[]);
    newCircleIds.push(...addedCircleIds);

    // ── F/C/B approach rings ─────────────────────────────────────────────
    // Origin: GPS when on-hole; tee otherwise (same guard as GPSMapView).

    if (hd.front || hd.back) {
      const ringOrigin = (gpsOnHole && pos) ? pos : hd.tee;
      if (ringOrigin) {
        const fcbDefs: Array<{ type: FcbType; coord: { lat: number; lng: number } | undefined }> = [
          { type: "front",  coord: hd.front },
          { type: "center", coord: hd.green },
          { type: "back",   coord: hd.back  },
        ];
        const fcbCircles: Circle[] = [];
        for (const { type, coord } of fcbDefs) {
          if (!coord) continue;
          const yds = calculateDistance(ringOrigin, coord).yards;
          fcbCircles.push({
            center:       { lat: ringOrigin.lat, lng: ringOrigin.lng },
            radius:       yardsToMeters(yds),
            strokeColor:  FCB_RING_COLORS[type],
            strokeWeight: type === "center" ? 2.5 : 1.5,
            fillOpacity:  0,
            clickable:    false,
            tag:          `fcb-${type}`,
          });
        }
        if (fcbCircles.length > 0) {
          const fcbIds = await m.addCircles(fcbCircles).catch(() => [] as string[]);
          newCircleIds.push(...fcbIds);
        }
      }
    }

    // ── Tee-to-green guide line ──────────────────────────────────────────

    if (hd.tee) {
      const guideLine: Polyline = {
        path: [
          { lat: hd.tee.lat,   lng: hd.tee.lng   },
          { lat: hd.green.lat, lng: hd.green.lng  },
        ],
        strokeColor:   "rgba(255,255,255,0.45)",
        strokeOpacity: 0.45,
        strokeWeight:  1.5,
        geodesic:      true,
        clickable:     false,
      };
      const lineIds = await m.addPolylines([guideLine]).catch(() => [] as string[]);
      newPolylineIds.push(...lineIds);
    }

    // ── GPS → green distance line (on-hole only) ─────────────────────────

    if (gpsOnHole && pos) {
      const distLine: Polyline = {
        path: [
          { lat: pos.lat,       lng: pos.lng       },
          { lat: hd.green.lat,  lng: hd.green.lng  },
        ],
        strokeColor:   T.accent,
        strokeOpacity: 0.85,
        strokeWeight:  2.5,
        geodesic:      true,
        clickable:     false,
      };
      const distIds = await m.addPolylines([distLine]).catch(() => [] as string[]);
      newPolylineIds.push(...distIds);
    }

    holeMarkerIdsRef.current   = newMarkerIds;
    holeCircleIdsRef.current   = newCircleIds;
    holePolylineIdsRef.current = newPolylineIds;
  }, []);

  /**
   * Frame the camera on the current hole's tee→green corridor.
   * Never includes GPS position (off-hole guard — v1.0.598 fix).
   *
   * Uses `setCamera` + the pure `cameraForHole` helper instead of the plugin's
   * `fitBounds()`.  `fitBounds` crashes on iOS with a native NSException when
   * the GMSMapView is nil (v9.4.0 race condition — Swift force-unwrap at
   * Map.swift:566 / CapacitorGoogleMapsPlugin.swift:942).  JS try/catch cannot
   * intercept a native SIGTRAP, so replacement is the only fix.
   */
  const fitCameraToHole = useCallback(async (hd: CourseCoordinates) => {
    const m = googleMapRef.current;
    if (!m || !mapReadyRef.current) return;
    const { coordinate, zoom } = cameraForHole(hd);
    await m.setCamera({ coordinate, zoom, animate: true, animationDuration: 600 }).catch(() => {});
  }, []);

  // ── Map initialisation ─────────────────────────────────────────────────────

  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;

    // ── Defensive guard: non-empty API key ───────────────────────────────────
    // Trim so whitespace-only values are treated as absent.
    const apiKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "").trim();
    if (!apiKey) {
      // Key absent — caller should have shown HoleDiagram instead; bail gracefully.
      onFallback?.();
      setGpsError("Google Maps API key not configured");
      setIsLoading(false);
      return;
    }

    // ── Defensive guard: re-entry / StrictMode double-invoke ─────────────────
    // React StrictMode mounts → unmounts → mounts in dev.  The cleanup below
    // resets this ref so the second mount proceeds normally after cleanup.
    if (createInProgressRef.current) return;
    createInProgressRef.current = true;

    const currentHd = holeCoordinates.find((h) => h.holeNumber === currentHole);
    const initCenter = currentHd
      ? { lat: currentHd.tee?.lat ?? currentHd.green.lat, lng: currentHd.tee?.lng ?? currentHd.green.lng }
      : (fallbackCenter ?? { lat: 40.7128, lng: -74.006 }); // NYC as last-resort placeholder

    let destroyed = false;
    let gMap: GoogleMap | null = null;

    (async () => {
      // ── Defensive guard: container must have non-zero dimensions ──────────
      // The native plugin will crash / silently fail on an unsized element.
      // getBoundingClientRect is available inside useEffect (client-only).
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        if (!destroyed) {
          onFallback?.();
          setGpsError("Map container not yet sized — try the Paper map");
          setIsLoading(false);
        }
        return;
      }

      try {
        // Dynamic import — module evaluates HTMLElement at load time, which is
        // not defined during Next.js SSR / static prerender. Must stay here, NOT
        // at the top of the file. The JS engine caches the module after first use.
        const { GoogleMap, MapType } = await import("@capacitor/google-maps");

        gMap = await GoogleMap.create({
          id:          mapIdRef.current,
          element:     el as HTMLElement,
          apiKey,
          config: {
            center:         initCenter,
            zoom:           centerOnly ? CENTER_ONLY_ZOOM : 16,
            mapTypeId:      MapType.Satellite,
            disableDefaultUI: true,
          },
          forceCreate: true,
        });

        if (destroyed) { await gMap.destroy(); return; }

        googleMapRef.current = gMap;
        mapReadyRef.current  = true;

        // ── Initial camera framing ───────────────────────────────────────
        if (currentHd && !centerOnly) {
          await fitCameraToHole(currentHd);
        }

        // ── Initial overlays ─────────────────────────────────────────────
        if (currentHd && !centerOnly) {
          const gpsOnHole = false; // no GPS yet on mount
          await addHoleOverlays(currentHd, gpsOnHole, null);
        }

        // ── Click/tap-to-measure handler ─────────────────────────────────
        await gMap.setOnMapClickListener(async (ev) => {
          if (!googleMapRef.current || !mapReadyRef.current) return;
          const hd = currentHoleRef.current;
          const tapPos = { lat: ev.latitude, lng: ev.longitude };

          if (!hd) return; // center-only mode — no reference point

          const pinPos    = hd.pin ?? hd.green;
          const toPin     = calculateDistance(tapPos, pinPos).yards;
          const fromTee   = hd.tee ? calculateDistance(tapPos, hd.tee).yards : null;
          const label     = tapMeasureLabelGoogle(fromTee, toPin);

          // Remove old tap marker
          await clearTapMarker();

          // Add new tap marker at the tapped location
          const tapId = await googleMapRef.current!
            .addMarker({ coordinate: tapPos, title: label })
            .catch(() => null);
          if (tapId) tapMarkerIdRef.current = tapId;
        });

        setIsLoading(false);
      } catch (err) {
        if (!destroyed) {
          // JS-catchable init failure (bad key, plugin error, etc.).
          // Call onFallback so the parent can swap to HoleDiagram.
          // Note: a true native NSException on iOS cannot be caught here —
          // the default-to-HoleDiagram pattern (never auto-loading Google) is
          // the primary defence against that class of crash.
          onFallback?.();
          setGpsError(err instanceof Error ? err.message : "Map failed to load");
          setIsLoading(false);
        }
      }
    })();

    return () => {
      destroyed = true;
      mapReadyRef.current = false;
      googleMapRef.current = null;
      // Reset re-entry guard so a subsequent mount (HMR / StrictMode second pass)
      // can proceed cleanly.
      createInProgressRef.current = false;
      // Destroy asynchronously — don't block the cleanup.
      if (gMap) gMap.destroy().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hole change → re-frame camera + re-draw overlays ──────────────────────

  useEffect(() => {
    currentHoleRef.current = currentHoleData;
    // Clear the tap marker when navigating holes.
    clearTapMarker();

    if (!googleMapRef.current || !mapReadyRef.current || !currentHoleData || centerOnly) return;

    const hd = currentHoleData;
    const gpsOnHole = position ? isGpsOnHole(position, hd) : false;

    (async () => {
      await clearHoleOverlays();
      await fitCameraToHole(hd);
      await addHoleOverlays(hd, gpsOnHole, position);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHoleData]);

  // ── GPS position change → update GPS dot + re-draw overlays ───────────────

  const handlePositionUpdate = useCallback(
    async (pos: Position) => {
      setPosition(pos);
      setGpsError(null);

      const m  = googleMapRef.current;
      const hd = currentHoleRef.current;
      if (!m || !mapReadyRef.current) return;

      const onHole = hd ? isGpsOnHole(pos, hd) : false;

      // ── GPS "you" dot ──────────────────────────────────────────────────
      if (onHole) {
        if (gpsMarkerIdRef.current) {
          // Update existing marker by removing and re-adding (plugin has no update API).
          await clearGpsMarker();
        }
        const gpsId = await m
          .addMarker({ coordinate: { lat: pos.lat, lng: pos.lng }, title: "You" })
          .catch(() => null);
        if (gpsId) gpsMarkerIdRef.current = gpsId;
      } else {
        await clearGpsMarker();
      }

      // ── Refresh hole overlays so FCB/distance rings reflect new GPS ────
      if (hd && !centerOnly) {
        await clearHoleOverlays();
        await addHoleOverlays(hd, onHole, pos);
      }

      // ── Auto-detect hole ───────────────────────────────────────────────
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [autoDetectHole, holeCoordinates, currentHole, onHoleChange, centerOnly]
  );

  const handleGpsError = useCallback((error: GeolocationPositionError) => {
    switch (error.code) {
      case error.PERMISSION_DENIED:
        setGpsError("Location permission denied.");
        break;
      case error.POSITION_UNAVAILABLE:
        setGpsError("Location unavailable.");
        break;
      case error.TIMEOUT:
        setGpsError("Location request timed out.");
        break;
      default:
        setGpsError("Unable to get location.");
    }
  }, []);

  useEffect(() => {
    gpsWatcherRef.current = new GPSWatcher(handlePositionUpdate, handleGpsError);
    gpsWatcherRef.current.start();
    return () => { gpsWatcherRef.current?.stop(); };
  }, [handlePositionUpdate, handleGpsError]);

  // ── Map control helpers ────────────────────────────────────────────────────

  const centerOnUser = useCallback(async () => {
    if (!googleMapRef.current || !position || !mapReadyRef.current) return;
    await googleMapRef.current.setCamera({ coordinate: { lat: position.lat, lng: position.lng }, zoom: 18, animate: true });
  }, [position]);

  const centerOnGreen = useCallback(async () => {
    if (!googleMapRef.current || !currentHoleData || !mapReadyRef.current) return;
    await googleMapRef.current.setCamera({ coordinate: { lat: currentHoleData.green.lat, lng: currentHoleData.green.lng }, zoom: 17, animate: true });
  }, [currentHoleData]);

  const fitHole = useCallback(async () => {
    if (!currentHoleData) return;
    await fitCameraToHole(currentHoleData);
  }, [currentHoleData, fitCameraToHole]);

  const prevHole = useCallback(() => { if (currentHole > 1) onHoleChange(currentHole - 1); }, [currentHole, onHoleChange]);
  const nextHole = useCallback(() => { if (currentHole < 18) onHoleChange(currentHole + 1); }, [currentHole, onHoleChange]);

  // ── Bearing label (for reference; not displayed) ──────────────────────────
  // Used to derive a user-meaningful compass direction for the GPS status strip.
  const gpsBearing = useMemo(() => {
    if (!position || !currentHoleData) return null;
    return calculateBearing(position, currentHoleData.green);
  }, [position, currentHoleData]);
  void gpsBearing; // suppress unused warning

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={inline ? "relative w-full h-full bg-zinc-900" : "fixed inset-0 z-50 bg-zinc-900"}>

      {/* Header — fullscreen only */}
      {!inline && (
        <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-zinc-950/80 to-transparent p-4 pb-8 pointer-events-none">
          <div className="flex items-center justify-between pointer-events-auto">
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
            {/* Paper toggle — shown when parent provides the callback; otherwise a spacer */}
            {onSwitchToPaper ? (
              <button
                onClick={onSwitchToPaper}
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  letterSpacing: 0.8,
                  color: "rgba(255,255,255,0.80)",
                  background: "rgba(0,0,0,0.35)",
                  border: "1px solid rgba(255,255,255,0.20)",
                  borderRadius: 6,
                  padding: "5px 10px",
                  cursor: "pointer",
                  backdropFilter: "blur(4px)",
                }}
              >
                Paper
              </button>
            ) : (
              /* spacer to centre-balance the back button */
              <div className="w-16" />
            )}
          </div>
        </div>
      )}

      {/* Map canvas — the native Google Maps view attaches to this element */}
      {/* Must use style (not className) for dimensions — required by the plugin */}
      <div
        ref={(el) => { mapContainerRef.current = el; }}
        style={{ width: "100%", height: "100%", background: "transparent" }}
      />

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
              <Loader2 className="w-10 h-10 animate-spin mx-auto mb-3" style={{ color: T.inkSoft }} />
              <p style={{ color: T.pencil, fontFamily: T.sans, fontSize: 13 }}>Loading map…</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* GPS error banner */}
      <AnimatePresence>
        {gpsError && !isLoading && (
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

      {/* Distance panel (bottom) — fullscreen mode */}
      {!centerOnly && !inline && (
        <div className="absolute bottom-0 left-0 right-0 z-10">
          {/* Hole nav */}
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

          {/* Detail panel */}
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

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Signal size={16} className={!position ? "text-zinc-500" : isOnHole ? "text-emerald-500" : "text-amber-500"} />
                <span className="text-zinc-400 text-sm">
                  {!position
                    ? "Acquiring GPS…"
                    : isOnHole
                    ? `GPS: ${getAccuracyDescription(position.accuracy || 0)} (±${Math.round(position.accuracy || 0)}m)`
                    : "GPS · Not on this hole · Tee distances shown"}
                </span>
              </div>
              <div className="flex gap-2">
                <button onClick={fitHole} className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center" title="Fit hole">
                  <Target className="text-yellow-400" size={20} />
                </button>
                <button onClick={centerOnUser} disabled={!position} className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center disabled:opacity-30">
                  <Navigation className="text-blue-400" size={20} />
                </button>
                <button onClick={centerOnGreen} className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center">
                  <MapPin className="text-emerald-400" size={20} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compact inline strip */}
      {!centerOnly && inline && (
        <div className="absolute bottom-0 left-0 right-0 z-10">
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
              <Signal size={12} className={!position ? "text-zinc-600" : isOnHole ? "text-emerald-500" : "text-amber-500"} />
              <span className="text-zinc-500 text-[10px]">
                {!position ? "GPS…" : isOnHole ? `±${Math.round(position.accuracy || 0)}m` : "off hole"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Center-only GPS panel */}
      {centerOnly && (
        <div className="absolute bottom-0 left-0 right-0 z-10">
          <div className="bg-zinc-900/90 backdrop-blur-sm px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Signal size={14} className={position ? "text-emerald-500" : "text-zinc-600"} />
              <span className="text-zinc-400 text-xs">
                {position ? `±${Math.round(position.accuracy || 0)}m` : "Acquiring GPS…"}
              </span>
            </div>
            <button onClick={centerOnUser} disabled={!position} className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center disabled:opacity-30">
              <Navigation className="text-blue-400" size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Google Maps attribution is automatically rendered by the SDK */}
    </div>
  );
}
