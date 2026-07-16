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

import { useEffect, useRef, useState, useCallback, useMemo, type CSSProperties } from "react";
// @capacitor/google-maps references HTMLElement at module evaluation time,
// so it must NOT be imported at the top level (would crash SSR / static build).
// We dynamic-import it inside the useEffect (client-only) instead.
import type { GoogleMap, Circle, Marker } from "@capacitor/google-maps";
import {
  Navigation,
  Target,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  MapPin,
  Signal,
  ArrowUp,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
// @capacitor/app is a plain plugin registration (no HTMLElement reference at
// module scope, unlike @capacitor/google-maps) — safe to import at the top
// level; its web fallback uses document.visibilitychange, so this also works
// in the plain browser dev server.
import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import {
  GPSWatcher,
  calculateDistance,
  calculateBearing,
  type Position,
} from "@/lib/gps";
import type { CourseCoordinates } from "@/lib/golf-api";
import { isGpsOnHole } from "@/lib/map/satellite-helpers";
import {
  CENTER_ONLY_ZOOM,
  cameraForHole,
  cameraFraming,
  movedBeyondYards,
  tapTargetDistances,
  createCameraQueue,
  teeColorFor,
  teeMarkerIconUrl,
  type CameraQueue,
  type TapTarget,
} from "@/lib/map/google-map-helpers";
import { buildBunkerMarkers } from "@/lib/map/marker-options";
import { fetchWeather } from "@/lib/caddie/api";
import { haptic } from "@/lib/haptics";
import type { WeatherConditions } from "@/lib/caddie/types";
import { T } from "@/components/yardage/tokens";
import {
  computeTeeShotOverlays,
  teeShotOverlaysVisible,
  type TeeShotOverlays,
  type BunkerCarry,
} from "@/lib/map/tee-shot-overlays";
import type { HoleData } from "@/lib/courses/types";

// The plugin registers a `<capacitor-google-map>` custom element (see the
// plugin's map.js). On iOS its connectedCallback sets `overflow: scroll` and
// appends a 200%-height child, which makes WebKit create the WKChildScrollView
// that the NATIVE side matches on to attach the map (Map.swift getTargetContainer
// requires contentSize.height == 2× the element height). A plain <div> never
// produces that scroll view, so the native map can't attach at all. Declare the
// element so JSX/TS accept it.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- JSX augmentation requires a namespace
  namespace JSX {
    interface IntrinsicElements {
      "capacitor-google-map": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

// ── Camera queue payload ────────────────────────────────────────────────────

/**
 * Discriminated request shape for `cameraQueueRef` (see its docstring below)
 * — 'hole' = hole-change/resume (full clear→frame→add + tee-shot overlays),
 * 'gps' = a GPS-tick overlay refresh (clear→add of the hole overlays only,
 * no camera move). Making BOTH request types flow through the same
 * serialized queue is the v1.1.9 Item 3 fix for the stray other-hole tee
 * marker (single writer of `holeMarkerIdsRef`).
 */
interface CameraQueueTarget {
  hd: CourseCoordinates;
  reason: 'hole' | 'gps';
  pos: Position | null;
}

// ── Tap-target arg-building (single seam) ──────────────────────────────────

/**
 * Build the TapTarget distances (carry from tee, remaining to green) for
 * `pos` given the current hole — the ONE arg-building call site shared by
 * `placeTarget` (tap-to-place + drag-END) AND the reticle's live-drag tick
 * (cheap numbers-only readout). v1.1.9 field-test fix, Item 4: a mid-drag
 * readout must always agree with what a tap/drag-end at the same point
 * would compute — no separate math path to drift out of sync.
 */
function tapTargetForPos(pos: { lat: number; lng: number }, hd: CourseCoordinates): TapTarget {
  return tapTargetDistances(
    pos,
    hd.green,
    hd.tee ?? null,
    false,
    (a, b) => calculateDistance(a, b).yards,
  );
}

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
  /**
   * The round's chosen tee-box name (e.g. "Black", "Gold/Combo"), used to
   * color the tee marker via `teeColorFor`. Tri-state, deliberately:
   *   • a non-empty string → colored marker for that tee.
   *   • "" (round exists, tee unset — legacy round) → neutral marker, honest.
   *   • null / omitted (no round context, e.g. /map/course) → NO marker at all.
   */
  teeMarker?: string | null;
  /**
   * How the camera moves on a hole change. "pan" (default) animates the
   * flight; "cut" repositions instantly — used by the inline round map whose
   * hole changes happen UNDER the page-turn wipe, so the golfer sees a new
   * hole appear rather than the map sliding.
   */
  cameraTransition?: "pan" | "cut";
  /**
   * Per-hole mapped geometry (par + GeoJSON features) — drives the tee-shot
   * yardage-book overlays (200/150/100 plates + fairway bunker carries,
   * specs/tee-shot-yardage-overlays-plan.md). Absent => the feature is
   * entirely inert (CourseSearch / CourseScoutMap / /map/course pass
   * nothing and are unaffected). Keyed by hole NUMBER, matching
   * `currentHole` / `CourseCoordinates.holeNumber`.
   */
  mappedHoles?: ReadonlyMap<number, Pick<HoleData, "par" | "features">>;
}

// ── Tee-shot overlay constants (design language: specs/tee-shot-yardage-
// overlays-plan.md §7 — reuse the existing tee palette, no new colors) ────────

const EMPTY_TEE_SHOT_OVERLAYS: TeeShotOverlays = { markers: [], bunkers: [] };

/** 200/150/100 plate fill colors — same palette as TEE_COLOR_RULES
 *  (google-map-helpers.ts): blue / white / red. */
const PLATE_FILL_BY_YARDS: Record<100 | 150 | 200, string> = {
  200: "#2e5aa8",
  150: "#f2efe6",
  100: "#b23a2e",
};

// ── Yardage-book distance stat (matches the app's paper/ink theme) ────────────

// Shared paper-pill control button (hole nav + map controls).
const MAP_PILL_BTN: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 999,
  background: `${T.paper}f2`,
  border: `1px solid ${T.hairline}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  backdropFilter: "blur(4px)",
  cursor: "pointer",
};

function YardageStat({ label, value, big = false }: { label: string; value: number | null; big?: boolean }) {
  return (
    <div style={{ textAlign: "center", flex: 1 }}>
      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", color: T.pencil, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontFamily: T.serif, fontSize: big ? 40 : 26, lineHeight: 0.95, color: big ? T.accent : T.ink }}>
        {value ?? "—"}
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 0.8, color: T.pencilSoft, marginTop: 2 }}>
        YDS
      </div>
    </div>
  );
}

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
  teeMarker = null,
  cameraTransition = "pan",
  mappedHoles,
}: GoogleSatelliteMapProps) {
  // Ref mirror so fitCameraToHole (stable identity, closed over by the camera
  // queue) reads the current value without re-creating.
  const cameraTransitionRef = useRef(cameraTransition);
  cameraTransitionRef.current = cameraTransition;
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
  // Polylines drawn from a tapped target point (tee→point + point→green).
  const tapLineIdsRef       = useRef<string[]>([]);
  // Last position the camera auto-followed to (null when off-hole) — so GPS
  // re-anchoring only fires on coming on-hole or after a meaningful move.
  const cameraFollowRef     = useRef<{ lat: number; lng: number } | null>(null);
  // Live GPS position mirror — the tap handler is registered once (stale closure)
  // so it reads the current position from this ref.
  const positionRef         = useRef<Position | null>(null);

  // Tee-shot overlay circles (plates + bunker near-edge dots) — a SEPARATE id
  // ref from holeCircleIdsRef so the per-GPS-tick clearHoleOverlays/
  // addHoleOverlays refresh (mid-hole distance rings) never touches/flickers
  // the plates, and mid-hole hiding of the plates never touches the tee dot.
  const teeShotCircleIdsRef = useRef<string[]>([]);
  // Bunker glyph markers (distinct PNG icon, not a native circle) — a
  // SEPARATE id-tracking path from teeShotCircleIdsRef/holeMarkerIdsRef;
  // same lifecycle as teeShotCircleIdsRef (added/removed together) but
  // markers and circles are different plugin APIs (addMarkers/removeMarkers
  // vs addCircles/removeCircles).
  const teeShotMarkerIdsRef = useRef<string[]>([]);
  // Last-drawn visibility boolean — native circles are only added/removed
  // when this FLIPS (compared on every GPS tick), so GPS jitter inside the
  // tee zone never causes redraw churn.
  const teeShotVisibleRef   = useRef(false);

  // Keep currentHoleData in a ref so the click handler reads the latest value
  // without being re-registered on every hole change.
  const currentHoleRef = useRef(
    holeCoordinates.find((h) => h.holeNumber === currentHole)
  );

  const [position,  setPosition]  = useState<Position | null>(null);
  const [gpsError,  setGpsError]  = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [weather,   setWeather]   = useState<WeatherConditions | null>(null);
  // Tap-to-target readout (carry + distance to green for a tapped point).
  const [tapTarget, setTapTarget] = useState<TapTarget | null>(null);
  // Bunker-carry DOM chips (§7) — mirrors teeShotVisibleRef into render state
  // so the chips fade in/out; the native plate/dot circles are driven off the
  // ref directly (no re-render needed for those).
  const [teeShotChips, setTeeShotChips] = useState<{ visible: boolean; bunkers: BunkerCarry[] }>({
    visible: false,
    bunkers: [],
  });

  const gpsWatcherRef = useRef<GPSWatcher | null>(null);

  // ── Wind: fetch course-area weather once per course (for the subtle wind
  // badge). Backend is owner-gated, so this is a no-op when unauthenticated. ──
  useEffect(() => {
    const loc = holeCoordinates[0]?.green ?? holeCoordinates[0]?.tee ?? fallbackCenter;
    if (!loc) return;
    let cancelled = false;
    fetchWeather(loc.lat, loc.lng)
      .then((w) => { if (!cancelled) setWeather(w); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holeCoordinates]);

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

  /**
   * Tee-shot yardage-book geometry for the current hole (§8.3) — the ONLY
   * place `computeTeeShotOverlays` is called. `mappedHoles` absent, or no
   * entry for this hole, or no `currentHoleData` (no tee/green anchor yet)
   * => EMPTY, so the feature is fully inert for callers that don't pass
   * `mappedHoles` (CourseSearch / CourseScoutMap / /map/course).
   */
  const teeShotData = useMemo<TeeShotOverlays>(() => {
    const h = mappedHoles?.get(currentHole);
    if (!h || !currentHoleData) return EMPTY_TEE_SHOT_OVERLAYS;
    return computeTeeShotOverlays({
      features: h.features?.features ?? null,
      tee: currentHoleData.tee ?? null,
      green: currentHoleData.green,
      par: h.par ?? null,
      // Inline (in-round) card is small — cap the chip stack at 2 so it
      // stays lighter than a book page; fullscreen keeps the full 4.
      maxBunkers: inline ? 2 : 4,
    });
  }, [mappedHoles, currentHole, currentHoleData, inline]);

  // Ref mirror so the camera-queue / GPS-tick closures (stable identities,
  // created once) always read the LATEST computed overlays without needing
  // to be re-created on every hole change.
  const teeShotDataRef = useRef(teeShotData);
  useEffect(() => {
    teeShotDataRef.current = teeShotData;
  }, [teeShotData]);

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
   * Remove the tap target marker + its two distance lines (if any).
   */
  const clearTapMarker = useCallback(async () => {
    const m  = googleMapRef.current;
    if (!m) return;
    const id = tapMarkerIdRef.current;
    if (id) {
      await m.removeMarker(id).catch(() => {});
      tapMarkerIdRef.current = null;
    }
    if (tapLineIdsRef.current.length > 0) {
      await m.removePolylines(tapLineIdsRef.current).catch(() => {});
      tapLineIdsRef.current = [];
    }
  }, []);

  /**
   * Place (or move) the aim reticle at `pos`: recompute the carry/to-green
   * readout, redraw the tee→point (white) and point→green (amber)
   * polylines, and place/replace the draggable reticle marker.
   *
   * THE shared seam for both the tap-to-place click handler AND the
   * reticle's drag-END — no separate math fork, so releasing a drag at a
   * point always settles to the exact same lines/numbers a tap at that
   * point would (v1.1.9 field-test fix, Item 4).
   */
  const placeTarget = useCallback(async (pos: { lat: number; lng: number }) => {
    const hd = currentHoleRef.current;
    if (!hd) return; // center-only mode — no reference point

    setTapTarget(tapTargetForPos(pos, hd));

    // Clear the previous target + its lines, then draw the new ones.
    await clearTapMarker();
    const m = googleMapRef.current;
    if (!m) return;
    const lineIds: string[] = [];

    // Leg 1 — tee → target (the carry): white.
    const tee = hd.tee ?? null;
    if (tee) {
      const ids = await m.addPolylines([{
        path: [{ lat: tee.lat, lng: tee.lng }, pos],
        strokeColor: "#FFFFFF", strokeOpacity: 0.9, strokeWeight: 3,
        geodesic: true, clickable: false,
      }]).catch(() => [] as string[]);
      lineIds.push(...ids);
    }
    // Leg 2 — target → green centre (what's left): amber, distinct from white.
    {
      const ids = await m.addPolylines([{
        path: [pos, { lat: hd.green.lat, lng: hd.green.lng }],
        strokeColor: "#F2C14E", strokeOpacity: 0.95, strokeWeight: 3,
        geodesic: true, clickable: false,
      }]).catch(() => [] as string[]);
      lineIds.push(...ids);
    }
    tapLineIdsRef.current = lineIds;

    // White target reticle at the point (yardage-book vibe, not a red pin).
    // draggable: true — see setOnMarkerDrag{,Start,End}Listener below, all
    // guarded to this marker's id.
    const tapId = await m.addMarker({
      coordinate: pos,
      iconUrl: "assets/tap-target.png",
      iconSize:   { width: 38, height: 38 },
      iconAnchor: { x: 19, y: 19 },
      draggable: true,
    }).catch(() => null);
    if (tapId) tapMarkerIdRef.current = tapId;
  }, [clearTapMarker]);

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
   * Remove the tee-shot plate circles + bunker-glyph markers (if any).
   * SEPARATE id refs from holeCircleIdsRef/holeMarkerIdsRef (§8.2) — never
   * touched by the per-GPS-tick clearHoleOverlays/addHoleOverlays refresh.
   */
  const clearTeeShotOverlays = useCallback(async () => {
    const m = googleMapRef.current;
    const circleIds = teeShotCircleIdsRef.current;
    const markerIds = teeShotMarkerIdsRef.current;
    if (m && circleIds.length > 0) await m.removeCircles(circleIds).catch(() => {});
    if (m && markerIds.length > 0) await m.removeMarkers(markerIds).catch(() => {});
    teeShotCircleIdsRef.current = [];
    teeShotMarkerIdsRef.current = [];
  }, []);

  /**
   * Per-hole overlays: the map stays clean satellite (no tee→green line, no
   * distance rings, no pins) EXCEPT for a single colored tee marker at the
   * round's chosen tee box (owner 2026-07-06). Distance lines are drawn only
   * when the golfer taps a target point (see the tap handler → tee→point +
   * point→green).
   */
  const addHoleOverlays = useCallback(async (hd: CourseCoordinates, _gpsOnHole: boolean, _pos: Position | null) => {
    const m = googleMapRef.current;
    const markerIds: string[] = [];

    // teeMarker === null means "no round context" (e.g. /map/course) → never
    // draw a marker there. A non-null teeMarker (even "" for a legacy round
    // with no stored tee name) means a round IS active — draw a marker, honest
    // neutral color when the tee name is unknown (see teeColorFor).
    if (m && mapReadyRef.current && teeMarker !== null && hd.tee) {
      const { slug } = teeColorFor(teeMarker);
      const id = await m
        .addMarker({
          coordinate: { lat: hd.tee.lat, lng: hd.tee.lng },
          iconUrl: teeMarkerIconUrl(slug),
          iconSize: { width: 30, height: 30 },
          iconAnchor: { x: 15, y: 15 }, // centered — a dot, not a pin
          // Billboard, not flat-to-ground — one honest convention with the
          // bunker badges (buildBunkerMarkers): only native circles lie flat.
          // Cosmetically a no-op (symmetric disc) but keeps the marker
          // orientation model uniform (v1.1.9 field-test fix, Item 1).
          isFlat: false,
          zIndex: 5,
        })
        .catch(() => null);
      if (id) markerIds.push(id);
    }

    holeMarkerIdsRef.current   = markerIds;
    holeCircleIdsRef.current   = [];
    holePolylineIdsRef.current = [];
  }, [teeMarker]);

  /**
   * Draw the tee-shot yardage-book overlays (200/150/100 plates + bunker
   * glyph markers) for the CURRENT hole — reads `teeShotDataRef` (not a
   * parameter) so callers created once (camera queue, GPS-tick handler)
   * always draw the latest geometry. Plates are native circles; bunkers are
   * a bundled PNG glyph (distinct shape from the round plates — a white
   * circle read as "just another plate", specs/tee-shot-overlays-center-
   * and-style-plan.md Part B) via the same bundled-icon idiom as the tee
   * marker (data-URL/canvas icons don't load on iOS) — a per-letter bundled
   * PNG (`bunker-marker-{a..f}.png`, keyed by `BunkerCarry.letter`) stamps an
   * ink coin badge on the bean so the marker and its legend chip share the
   * same key (specs/lettered-bunker-legend-plan.md). Dynamic carry TEXT
   * still renders as DOM chips (§0 platform constraint).
   */
  const addTeeShotOverlays = useCallback(async () => {
    const m = googleMapRef.current;
    if (!m || !mapReadyRef.current) return;
    const data = teeShotDataRef.current;

    const circles: Circle[] = [];
    for (const marker of data.markers) {
      circles.push({
        center: marker.position,
        radius: 4,
        fillColor: PLATE_FILL_BY_YARDS[marker.yards],
        fillOpacity: 0.92,
        strokeColor: "rgba(26,42,26,0.65)",
        strokeWeight: 1.5,
      });
    }

    // Pure seam (buildBunkerMarkers, marker-options.ts) so the marker option
    // shape — including isFlat: false (billboard, see its docstring) — is
    // unit-assertable without a native map.
    const markers: Marker[] = buildBunkerMarkers(data.bunkers);

    if (circles.length > 0) {
      const ids = await m.addCircles(circles).catch(() => [] as string[]);
      teeShotCircleIdsRef.current = ids;
    } else {
      teeShotCircleIdsRef.current = [];
    }

    if (markers.length > 0) {
      const ids = await m.addMarkers(markers).catch(() => [] as string[]);
      teeShotMarkerIdsRef.current = ids;
    } else {
      teeShotMarkerIdsRef.current = [];
    }
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
    const { coordinate, zoom, bearing } = cameraForHole(hd);
    // "cut" repositions instantly — the inline map's hole changes happen
    // UNDER the page-turn wipe, so a visible pan would break the
    // new-page-of-the-book illusion.
    const cut = cameraTransitionRef.current === "cut";
    await m
      .setCamera(
        cut
          ? { coordinate, zoom, bearing, animate: false }
          : { coordinate, zoom, bearing, animate: true, animationDuration: 600 }
      )
      .catch(() => {});
  }, []);

  // ── Camera queue — coalescing serializer for rapid hole swipes (A2) ────────
  // Mirror the latest overlay callbacks into a ref so the queue's `run` closure
  // (created once, below) always calls the current versions without needing to
  // be re-created when e.g. `addHoleOverlays` changes identity (teeMarker dep).
  const overlayFnsRef = useRef({
    clearHoleOverlays,
    fitCameraToHole,
    addHoleOverlays,
    clearTeeShotOverlays,
    addTeeShotOverlays,
  });
  useEffect(() => {
    overlayFnsRef.current = {
      clearHoleOverlays,
      fitCameraToHole,
      addHoleOverlays,
      clearTeeShotOverlays,
      addTeeShotOverlays,
    };
  });

  // Created once (useRef initial-value idiom, matches mapIdRef above) — `run`
  // only closes over refs, so re-evaluating the initializer on later renders
  // and discarding it is harmless.
  //
  // Discriminated payload (v1.1.9 field-test fix — Item 3, stray other-hole
  // tee markers on holes 8/11): `reason` distinguishes a hole-change/resume
  // request ('hole' — full clear→frame→add, including tee-shot overlays)
  // from a GPS-tick overlay refresh ('gps' — clear→add ONLY, no camera move,
  // no tee-shot churn). Previously the GPS tick ran its own un-serialized
  // clearHoleOverlays→addHoleOverlays chain in `handlePositionUpdate`,
  // racing the queue's own clear→add on `holeMarkerIdsRef`: interleaved
  // awaits could let a queue-chain marker resolve AFTER the GPS chain
  // overwrote the ref, orphaning it on-map with no future clear tracking it
  // — the stray tee marker seen on holes 8/11. Routing BOTH paths through
  // this single serialized queue makes `holeMarkerIdsRef` single-writer, so
  // no two chains can ever interleave a write.
  const cameraQueueRef = useRef<CameraQueue<CameraQueueTarget>>(
    createCameraQueue<CameraQueueTarget>(async ({ hd, reason, pos }) => {
      // Belt+braces readiness gate: the queue itself is DOM/plugin-agnostic and
      // doesn't know about map readiness. A request that lands before
      // onMapReady (or after the map is torn down) no-ops here rather than
      // risking the native SIGTRAP (nil GMSMapView force-unwrap). The
      // appStateChange listener below re-requests the current hole once the
      // app resumes to the foreground and the map IS ready.
      if (!googleMapRef.current || !mapReadyRef.current) return;
      const gpsOnHole = pos ? isGpsOnHole(pos, hd) : false;

      if (reason === 'gps') {
        // GPS-tick refresh: single-writer clear+add of the hole overlays
        // ONLY — no camera move (the GPS follow camera is a separate,
        // already-serial `setCamera` call in `handlePositionUpdate`; it
        // doesn't touch `holeMarkerIdsRef`) and no tee-shot polyline churn
        // (that's a separate visibility-flip branch, also unaffected by
        // this race — different id refs).
        await overlayFnsRef.current.clearHoleOverlays();
        await overlayFnsRef.current.addHoleOverlays(hd, gpsOnHole, pos);
        return;
      }

      await overlayFnsRef.current.clearHoleOverlays();
      await overlayFnsRef.current.clearTeeShotOverlays();
      await overlayFnsRef.current.fitCameraToHole(hd);
      await overlayFnsRef.current.addHoleOverlays(hd, gpsOnHole, pos);

      // Tee-shot overlays ride the SAME serialized queue so a rapid multi-hole
      // swipe never races two hole's plates onto the map at once.
      const visible = teeShotOverlaysVisible({
        position: pos ? { lat: pos.lat, lng: pos.lng } : null,
        gpsOnHole,
        tee: hd.tee ?? null,
      });
      teeShotVisibleRef.current = visible;
      setTeeShotChips({ visible, bunkers: teeShotDataRef.current.bunkers });
      if (visible) await overlayFnsRef.current.addTeeShotOverlays();
    },
    // Priority-aware coalescing (review fix): a GPS-tick refresh must never
    // evict an already-pending hole-change — the 'gps' branch above
    // deliberately skips fitCameraToHole/tee-shot overlays, so if it evicted
    // a pending 'hole' request the trailing run would drop the new hole's
    // camera reframe and tee-shot redraw entirely. A pending 'gps' can still
    // be replaced by a newer 'gps' or by a 'hole'.
    (pending, incoming) => !(pending.reason === 'hole' && incoming.reason === 'gps'))
  );

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

        // Importing the plugin registers the <capacitor-google-map> custom
        // element; wait for the definition so our element upgrades (runs its
        // connectedCallback → builds the iOS scroll-view structure the native
        // map binds to) BEFORE create reads the element bounds / attaches.
        if (typeof customElements !== "undefined") {
          await customElements.whenDefined("capacitor-google-map");
        }

        // Seed the create config with the hole-framed camera so the very first
        // paint is already centered/zoomed on tee→green (no post-create move
        // needed just to frame it).
        const initCamera = (currentHd && !centerOnly)
          ? cameraForHole(currentHd)
          : { coordinate: initCenter, zoom: centerOnly ? CENTER_ONLY_ZOOM : 16, bearing: 0 };

        // ── Readiness gate (THE crash fix) ───────────────────────────────────
        // The native plugin force-unwraps its `GMSMapView!` (Map.swift:13) in
        // EVERY camera/overlay method (setCamera, fitBounds, addMarkers, …).
        // That view is assigned only in the controller's viewDidLoad, which runs
        // asynchronously AFTER `create()` already resolves its JS promise — and
        // never at all if the plugin can't find a target container. Calling any
        // of those methods before the view exists nil-unwraps → uncatchable
        // native SIGTRAP. So we wait for the plugin's own `onMapReady` event
        // (fired once GMapView is live) before issuing ANY native call, and if
        // it never arrives we fall back to paper instead of crashing.
        let signalReady: () => void = () => {};
        const mapReadyPromise = new Promise<void>((res) => { signalReady = res; });

        gMap = await GoogleMap.create(
          {
            id:          mapIdRef.current,
            element:     el as HTMLElement,
            apiKey,
            config: {
              center:         initCamera.coordinate,
              zoom:           initCamera.zoom,
              // Rotate so the hole plays UP the screen (looking down the fairway
              // from the tee), not a north-up diagonal.
              heading:        initCamera.bearing,
              mapTypeId:      MapType.Satellite,
              disableDefaultUI: true,
            },
            forceCreate: true,
          },
          // onMapReady — native GMSMapView now exists; safe to draw.
          () => { signalReady(); },
        );

        if (destroyed) { await gMap.destroy(); return; }
        googleMapRef.current = gMap;

        // Wait for confirmed readiness, with a timeout that means "never became
        // ready" → graceful paper fallback (NOT a forced proceed, which would
        // re-introduce the nil-unwrap crash).
        // Timeout must exceed the native render() retry window (up to ~10s while
        // a location-permission dialog blocks WebView layout) so we don't fall
        // back on a map that's still legitimately attaching. onMapReady is now
        // reliable (listener registered before create — plugin patch), so in the
        // common case this resolves in well under a second.
        const becameReady = await Promise.race([
          mapReadyPromise.then(() => true),
          new Promise<boolean>((res) => setTimeout(() => res(false), 13000)),
        ]);

        if (destroyed) { await gMap.destroy(); return; }

        if (!becameReady) {
          // The map view never initialized (e.g. plugin couldn't bind the
          // container). Do NOT touch the map — fall back to the paper diagram.
          onFallback?.();
          setGpsError("Map could not initialize — showing the paper map");
          setIsLoading(false);
          await gMap.destroy().catch(() => {});
          googleMapRef.current = null;
          return;
        }

        mapReadyRef.current = true;

        // Reserve the bottom distance panel so the hole frames ABOVE it (owner:
        // the panel slightly covered the tee box). setPadding shifts the camera's
        // effective centre up; re-apply the framing so the hole sits in the band.
        if (!inline && !centerOnly && currentHd) {
          await gMap.setPadding({ top: 8, left: 0, right: 0, bottom: 150 }).catch(() => {});
          await fitCameraToHole(currentHd);
        }

        // ── Initial overlays ─────────────────────────────────────────────
        // (Camera is already framed via the create config above.)
        if (currentHd && !centerOnly) {
          const gpsOnHole = false; // no GPS yet on mount
          await addHoleOverlays(currentHd, gpsOnHole, null);

          const visible = teeShotOverlaysVisible({
            position: null,
            gpsOnHole: false,
            tee: currentHd.tee ?? null,
          });
          teeShotVisibleRef.current = visible;
          setTeeShotChips({ visible, bunkers: teeShotDataRef.current.bunkers });
          if (visible) await addTeeShotOverlays();
        }

        // ── Click/tap-to-measure handler ─────────────────────────────────
        // Same seam as drag-end below (`placeTarget`) — no separate math
        // path (v1.1.9 Item 4).
        await gMap.setOnMapClickListener(async (ev) => {
          if (!googleMapRef.current || !mapReadyRef.current) return;
          await placeTarget({ lat: ev.latitude, lng: ev.longitude });
        });

        // ── Drag listeners for the aim reticle (v1.1.9 Item 4) ────────────
        // All guarded to `markerId === tapMarkerIdRef.current` so a drag of
        // any other marker (none exist today, but future-proof) is ignored.
        await gMap.setOnMarkerDragStartListener((data) => {
          if (data.markerId !== tapMarkerIdRef.current) return;
          haptic('light'); // cheap, once per drag — not per tick
        });

        // Live tick: cheap path ONLY — recompute the carry/to-green numbers
        // via the SAME arg-building seam as `placeTarget` (`tapTargetForPos`).
        // Do NOT redraw polylines here (remove+add per tick is too heavy);
        // they settle to the final position on drag-end.
        await gMap.setOnMarkerDragListener((data) => {
          if (data.markerId !== tapMarkerIdRef.current) return;
          const hd = currentHoleRef.current;
          if (!hd) return;
          setTapTarget(tapTargetForPos({ lat: data.latitude, lng: data.longitude }, hd));
        });

        // Drag-end: the SAME seam as a tap — `placeTarget` redraws the
        // polylines/reticle at the final released point.
        await gMap.setOnMarkerDragEndListener(async (data) => {
          if (data.markerId !== tapMarkerIdRef.current) return;
          await placeTarget({ lat: data.latitude, lng: data.longitude });
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
  // Goes through the camera queue (A2) so a rapid multi-hole swipe coalesces
  // into a single trailing camera move instead of racing several un-serialized
  // clear→frame→overlay async chains.

  useEffect(() => {
    currentHoleRef.current = currentHoleData;
    // Clear the tap marker + target readout when navigating holes.
    clearTapMarker();
    setTapTarget(null);

    if (!currentHoleData || centerOnly) return;

    cameraQueueRef.current.request({ hd: currentHoleData, reason: 'hole', pos: positionRef.current });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHoleData]);

  // ── GPS position change → update GPS dot + re-draw overlays ───────────────

  const handlePositionUpdate = useCallback(
    async (pos: Position) => {
      setPosition(pos);
      positionRef.current = pos;
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

      // ── Camera follow ──────────────────────────────────────────────────
      // On the hole → re-anchor the view to the player, looking down toward the
      // green (GPS view "scales to where they are"). Only re-frame when they come
      // on-hole or move > 20 yd so the camera doesn't jitter on every GPS tick.
      if (onHole && hd && !centerOnly) {
        if (movedBeyondYards(cameraFollowRef.current, pos, 20)) {
          cameraFollowRef.current = { lat: pos.lat, lng: pos.lng };
          const cam = cameraFraming(pos, hd.green);
          await m.setCamera({ ...cam, animate: true, animationDuration: 600 }).catch(() => {});
        }
      } else {
        cameraFollowRef.current = null;
      }

      // ── Refresh hole overlays so FCB/distance rings reflect new GPS ────
      // Routed through the SAME serialized camera queue as the hole-change
      // path (v1.1.9 Item 3 fix) — a direct clear→add call here, racing the
      // queue's own clear→add on hole change, was a two-writer race on
      // `holeMarkerIdsRef` that orphaned a marker on-map with no tracked id
      // to clear it (the stray other-hole tee marker on holes 8/11). The
      // queue's 'gps' branch does the clear+add ONLY — no camera move (that
      // stays the separate `setCamera` call above) and no tee-shot churn
      // (handled by the visibility-flip block below, a different id ref).
      if (hd && !centerOnly) {
        cameraQueueRef.current.request({ hd, reason: 'gps', pos });
      }

      // ── Tee-shot overlays: touch native circles ONLY on a visibility FLIP
      // (§5/§11) — GPS jitter inside/outside the tee zone never redraws.
      if (hd && !centerOnly) {
        const visible = teeShotOverlaysVisible({
          position: { lat: pos.lat, lng: pos.lng },
          gpsOnHole: onHole,
          tee: hd.tee ?? null,
        });
        if (visible !== teeShotVisibleRef.current) {
          teeShotVisibleRef.current = visible;
          setTeeShotChips({ visible, bunkers: teeShotDataRef.current.bunkers });
          if (visible) {
            await addTeeShotOverlays();
          } else {
            await clearTeeShotOverlays();
          }
        }
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

  // ── Background / foreground → re-assert camera framing on resume ─────────
  // GMSMapView pauses rendering while backgrounded; iOS can also silently
  // reset its camera on some resumes. Rather than destroy/recreate the map
  // (which would reintroduce the "Loading map…" spinner on every app switch —
  // the exact regression this feature fixes for hole swipes), just re-request
  // the current hole's framing through the SAME serialized queue once the app
  // is active again and the map is confirmed ready.
  useEffect(() => {
    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    App.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) return; // backgrounding — never destroy/recreate here
      if (!mapReadyRef.current) return; // not ready yet — nothing to re-frame
      if (centerOnly) return; // no per-hole framing in center-only mode
      const hd = currentHoleRef.current;
      if (hd) cameraQueueRef.current.request({ hd, reason: 'hole', pos: positionRef.current });
    }).then((h) => {
      if (cancelled) { h.remove(); return; }
      handle = h;
    });
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [centerOnly]);

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

  // Bounds from the actual loaded hole count, NOT a hardcoded 18 — a 9-hole
  // course (or a partial hole set) must not offer a dead "next" past its
  // last hole.
  const lastHole = holeCoordinates.length;
  const prevHole = useCallback(() => { if (currentHole > 1) onHoleChange(currentHole - 1); }, [currentHole, onHoleChange]);
  const nextHole = useCallback(() => { if (currentHole < lastHole) onHoleChange(currentHole + 1); }, [currentHole, lastHole, onHoleChange]);

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

      {/* Header — fullscreen only. Pad the top by the safe-area inset so the
          Back button clears the status bar / Dynamic Island (owner: the header
          sat under the status bar and Back wasn't tappable). */}
      {!inline && (
        <div
          className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-zinc-950/80 to-transparent px-4 pb-8 pointer-events-none"
          style={{ paddingTop: "max(16px, calc(env(safe-area-inset-top) + 8px))" }}
        >
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

      {/* Subtle wind badge — top-right, below the header. Arrow points the way the
          wind is blowing (meteorological direction + 180°) on the north-up map. */}
      {!inline && weather != null && (weather.wind_speed_mph ?? 0) > 0 && (
        <div
          className="absolute right-4 z-10 pointer-events-none"
          style={{ top: "max(72px, calc(env(safe-area-inset-top) + 60px))" }}
        >
          <div className="flex items-center gap-1.5 rounded-full bg-zinc-900/60 backdrop-blur-sm px-3 py-1.5">
            <ArrowUp
              size={14}
              className="text-sky-300"
              style={{ transform: `rotate(${(weather.wind_direction ?? 0) + 180}deg)` }}
            />
            <span className="text-white text-xs font-semibold">{Math.round(weather.wind_speed_mph ?? 0)}</span>
            <span className="text-zinc-400 text-[10px] tracking-wide">mph</span>
          </div>
        </div>
      )}

      {/* Tap-to-target readout — a compact vertical pill anchored to the LEFT edge
          so it stays off the fairway/green (which run up the centre of the
          down-the-fairway view). From-tee carry above, distance-to-green below. */}
      {!centerOnly && tapTarget && (
        <div className="absolute left-3 z-20 pointer-events-none" style={{ top: "36%" }}>
          <div
            className="pointer-events-auto"
            style={{ position: "relative", background: T.paper, border: `1px solid ${T.hairline}`, borderRadius: 12, padding: "10px 12px 10px", boxShadow: "0 4px 14px rgba(0,0,0,0.22)", minWidth: 76 }}
          >
            <button
              onClick={() => { setTapTarget(null); clearTapMarker(); }}
              aria-label="Clear target"
              style={{ position: "absolute", top: 1, right: 3, width: 18, height: 18, border: "none", background: "transparent", color: T.pencil, cursor: "pointer", fontSize: 14, lineHeight: 1 }}
            >
              ×
            </button>
            <div style={{ textAlign: "center", marginTop: 4 }}>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencil, textTransform: "uppercase" }}>
                {tapTarget.fromGps ? "Carry" : "From tee"}
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 22, lineHeight: 1, color: T.ink }}>
                {tapTarget.carry ?? "—"}
              </div>
            </div>
            <div style={{ height: 1, background: T.hairline, margin: "7px 2px" }} />
            <div style={{ textAlign: "center" }}>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencil, textTransform: "uppercase" }}>
                To green
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 22, lineHeight: 1, color: T.accent }}>
                {tapTarget.toGreen}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tee-shot bunker-carry chips — DOM (native map labels can't render
          dynamic text on iOS, §0). Anchored to the RIGHT edge, opposite the
          tap-to-target pill — the fairway/green run up the centre of the
          down-the-fairway view, so both stay off the imagery. TEE-SHOT
          CONTEXT ONLY (specs/tee-shot-yardage-overlays-plan.md §5/§7): fades
          in/out as the golfer walks in/out of the tee zone. Read-only
          (pointer-events none) — calm, less than a printed book page. */}
      <AnimatePresence>
        {!centerOnly && teeShotChips.visible && teeShotChips.bunkers.length > 0 && (
          <motion.div
            key="tee-shot-chips"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="absolute right-3 z-20 pointer-events-none"
            style={{
              // Inline: 54px clears RoundPageClient's "Hole stats" pill
              // (top:10, ~34px tall) anchored top-right of the same card —
              // never paint the chip stack over Par/Yardage/Hcp.
              top: inline ? 54 : "max(120px, calc(env(safe-area-inset-top) + 108px))",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {teeShotChips.bunkers.map((b, i) => (
              <div
                key={b.letter || i}
                style={{
                  background: T.paper,
                  border: `1px solid ${T.hairline}`,
                  borderRadius: 10,
                  padding: "6px 10px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minWidth: 64,
                }}
              >
                {b.letter !== "" && (
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      background: T.ink,
                      color: T.paper,
                      fontFamily: T.sans,
                      fontSize: 11,
                      fontWeight: 700,
                      lineHeight: "18px",
                      textAlign: "center",
                      flexShrink: 0,
                    }}
                  >
                    {b.letter}
                  </span>
                )}
                <span style={{ fontFamily: T.serif, fontSize: 18, lineHeight: 1.15, color: T.ink }}>
                  {b.front === b.back ? `${b.front}` : `${b.front} / ${b.back}`}
                </span>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Map canvas — MUST be the plugin's <capacitor-google-map> custom element,
          NOT a plain <div>: on iOS its connectedCallback builds the scroll-view
          structure the native side binds to. A <div> leaves the map unattached
          (black screen / onMapReady never fires). Style (not className) for
          dimensions — required by the plugin; display:block so width/height apply
          (custom elements are display:inline by default). */}
      <capacitor-google-map
        ref={(el: HTMLElement | null) => { mapContainerRef.current = el; }}
        style={{ display: "block", width: "100%", height: "100%", background: "transparent" }}
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

      {/* Distance panel (bottom) — fullscreen mode. Yardage-book themed + compact. */}
      {!centerOnly && !inline && (
        <div className="absolute bottom-0 left-0 right-0 z-10">
          {/* Hole nav */}
          <div className="flex items-center justify-center gap-3 pb-2">
            <button
              onClick={prevHole}
              disabled={currentHole <= 1}
              aria-label="Previous hole"
              style={{ ...MAP_PILL_BTN, opacity: currentHole <= 1 ? 0.35 : 1 }}
            >
              <ChevronLeft size={18} style={{ color: T.ink }} />
            </button>
            <div style={{ background: `${T.paper}f2`, border: `1px solid ${T.hairline}`, borderRadius: 999, padding: "5px 16px", fontFamily: T.mono, fontSize: 11, letterSpacing: 1.2, color: T.ink, textTransform: "uppercase", backdropFilter: "blur(4px)" }}>
              Hole {currentHole}
            </div>
            <button
              onClick={nextHole}
              disabled={currentHole >= lastHole}
              aria-label="Next hole"
              style={{ ...MAP_PILL_BTN, opacity: currentHole >= lastHole ? 0.35 : 1 }}
            >
              <ChevronRight size={18} style={{ color: T.ink }} />
            </button>
          </div>

          {/* Detail panel — paper */}
          <div style={{ background: T.paper, borderTop: `1px solid ${T.hairline}`, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: "12px 20px calc(10px + env(safe-area-inset-bottom))", boxShadow: "0 -6px 20px rgba(0,0,0,0.18)" }}>
            <div className="flex items-end justify-between" style={{ gap: 8 }}>
              <YardageStat label="Front"  value={distances.front} />
              <YardageStat label="Center" value={distances.center} big />
              <YardageStat label="Back"   value={distances.back} />
            </div>

            <div className="flex items-center justify-between" style={{ marginTop: 10 }}>
              <div className="flex items-center gap-1.5">
                <Signal size={13} style={{ color: !position ? T.pencilSoft : isOnHole ? T.accent : "#9a7b16" }} />
                <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 0.4, color: T.pencil }}>
                  {!position
                    ? "Acquiring GPS…"
                    : isOnHole
                    ? `GPS ±${Math.round(position.accuracy || 0)}m`
                    : "Not on hole · tee distances"}
                </span>
              </div>
              <div className="flex" style={{ gap: 6 }}>
                <button onClick={fitHole} title="Fit hole" style={MAP_PILL_BTN}>
                  <Target size={15} style={{ color: T.ink }} />
                </button>
                <button onClick={centerOnUser} disabled={!position} aria-label="Center on me" style={{ ...MAP_PILL_BTN, opacity: position ? 1 : 0.35 }}>
                  <Navigation size={15} style={{ color: T.accent }} />
                </button>
                <button onClick={centerOnGreen} aria-label="Center on green" style={MAP_PILL_BTN}>
                  <MapPin size={15} style={{ color: T.ink }} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Inline mode intentionally has NO bottom strip — the round page renders
          its own F/C/B tiles under the map (owner 2026-07-02: strip was redundant). */}

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
