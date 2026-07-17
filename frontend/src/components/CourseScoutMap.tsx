"use client";

/**
 * CourseScoutMap — the native map mode for CourseSearch (course-selection
 * B2, specs/course-selection-b2-plan.md §2.5).
 *
 * Quiet ink golf-flag pins for real courses in the current viewport. Tap a
 * pin → one-row yardage-book card → "Add" fires `onAddPin`; the identity
 * mapping to `onSelectCourse` stays in CourseSearch.tsx (this component
 * never imports from there, avoiding a cycle).
 *
 * BUDGET INVARIANT: this component's only data call is `fetchCoursesInBounds`
 * (→ backend GET /api/courses/in-bounds, OSM+DB only). No Google Places,
 * GolfAPI, or Mapbox call is reachable from this file — verify with
 * `grep -n "fetchAPI\|searchAll\|searchNearby" CourseScoutMap.tsx` → nothing.
 *
 * Native-map discipline copied literally from GoogleSatelliteMap.tsx: dynamic
 * plugin import inside the mount effect (SSR-unsafe at module scope),
 * `<capacitor-google-map>` custom element + customElements.whenDefined,
 * onMapReady promise-gate before ANY native call (the plugin force-unwraps a
 * nil GMSMapView in every method — uncatchable SIGTRAP otherwise), 13s ready
 * timeout → honest error (never a forced proceed), StrictMode re-entry guard
 * + destroyed flag, unique map id per mount + forceCreate, destroy-on-unmount.
 * Camera moves ONLY via `setCamera` — `fitBounds` is banned (nil-unwrap crash).
 */

import { useEffect, useRef, useState, useCallback, type CSSProperties } from "react";
// @capacitor/google-maps references HTMLElement at module evaluation time, so
// it must NOT be imported at the top level (would crash SSR / static build).
// Type-only imports are erased at compile time — safe here.
import type { GoogleMap, Marker } from "@capacitor/google-maps";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { T } from "@/components/yardage/tokens";
import { fetchCoursesInBounds, type InBoundsCourse } from "@/lib/golf-api";
import { createScoutCoordinator, type ScoutCoordinator } from "@/lib/course/scout-viewport";
import {
  deriveHighlightAction,
  highlightMarkerFor,
  boundsToBBox,
  QUIET_PIN_ICON,
  SCOUT_MAP_STYLES,
} from "@/lib/course/scout-map-config";
import { createCameraQueue, type CameraQueue } from "@/lib/map/google-map-helpers";
import { getCourseIntel } from "@/lib/api";
import type { CourseIntel } from "@/lib/types";
import { stashCourseForRound, type CourseHandoff } from "@/lib/course-handoff";
import { courseDetailHref } from "@/lib/course-url";
import CourseIntelSheet from "@/components/course/CourseIntelSheet";

// See GoogleSatelliteMap.tsx for why the custom element (not a div) is
// required — its connectedCallback builds the iOS scroll-view structure the
// native side binds to. Redeclare here; TS merges JSX augmentations.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- JSX augmentation requires a namespace
  namespace JSX {
    interface IntrinsicElements {
      "capacitor-google-map": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

/** Typed/voice query top hit that drives both the camera pan and the search
 *  highlight marker (name/source feed the synthesized InBoundsCourse in
 *  markerIndexRef so the tap-card/Add flow works — markers carry no title). */
export interface PanTarget {
  id: string;
  name: string;
  source: string;
  center: { lat: number; lng: number };
}

export interface CourseScoutMapProps {
  /** Fires with the tapped pin when the golfer hits "Add" on the card. */
  onAddPin: (pin: InBoundsCourse) => void;
  /** Initial camera center (GPS fix, else a sensible fallback). */
  initialCenter: { lat: number; lng: number };
  /** Typed/voice query top hit — camera pans here when it changes. Never reshuffles anything. */
  panTarget: PanTarget | null;
}

let _scoutMapCounter = 0;
function nextScoutMapId(): string {
  _scoutMapCounter += 1;
  return `scout-map-${_scoutMapCounter}`;
}

function pinToMarker(pin: InBoundsCourse): Marker {
  return { coordinate: pin.center, ...QUIET_PIN_ICON };
}

const STATUS_PILL: CSSProperties = {
  fontFamily: T.mono,
  fontSize: 8.5,
  letterSpacing: 1.1,
  textTransform: "uppercase",
  color: T.pencil,
  background: `${T.paper}e8`,
  border: `1px solid ${T.hairline}`,
  borderRadius: 99,
  padding: "7px 14px",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

export default function CourseScoutMap({ onAddPin, initialCenter, panTarget }: CourseScoutMapProps) {
  const router = useRouter();
  const mapContainerRef = useRef<HTMLElement | null>(null);
  const googleMapRef = useRef<GoogleMap | null>(null);
  const mapReadyRef = useRef(false);
  const createInProgressRef = useRef(false);
  const mapIdRef = useRef<string>(nextScoutMapId());

  const markerIndexRef = useRef<Map<string, InBoundsCourse>>(new Map());
  const pendingPinsRef = useRef<InBoundsCourse[]>([]);
  const coordinatorRef = useRef<ScoutCoordinator | null>(null);
  const lastPanIdRef = useRef<string | null>(null);
  const highlightRef = useRef<{ markerId: string; courseId: string } | null>(null);
  // Stale-guard for the /intel fetch keyed on the selected pin — a second
  // pin tap while a fetch is in flight must never let the FIRST fetch's
  // result land after the SECOND pin is already selected (no stale flash).
  const intelRequestIdRef = useRef<string | null>(null);

  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [scouting, setScouting] = useState(false);
  const [zoomIn, setZoomIn] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [emptyHonest, setEmptyHonest] = useState(false);
  const [selectedPin, setSelectedPin] = useState<InBoundsCourse | null>(null);
  const [intel, setIntel] = useState<CourseIntel | null>(null);

  // Serialized marker application — a coalescing queue instantiated over
  // "apply the pending pin batch" (google-map-helpers.createCameraQueue is a
  // generic async serializer, not camera-specific). The batch itself
  // accumulates in `pendingPinsRef` (drained inside `run`) rather than being
  // passed as the queue's target, so a fetch landing while a previous
  // addMarkers call is still in flight is never dropped — pins stay
  // append-only with zero loss even under back-to-back results.
  const pinQueueRef = useRef<CameraQueue<void>>(
    createCameraQueue<void>(async () => {
      const m = googleMapRef.current;
      if (!m || !mapReadyRef.current) return;
      const batch = pendingPinsRef.current;
      pendingPinsRef.current = [];
      if (batch.length === 0) return;
      const ids = await m.addMarkers(batch.map(pinToMarker)).catch(() => [] as string[]);
      ids.forEach((id, i) => {
        if (id && batch[i]) markerIndexRef.current.set(id, batch[i]);
      });
    })
  );

  // Serialized highlight-marker application — a dedicated coalescing queue
  // (separate from pinQueueRef, which batches the quiet in-bounds pins) so
  // rapid re-pans ("Mar" → "Marine" → "Maria…") serialize remove→add with
  // exactly one surviving highlight: no dupes, no leaked marker ids.
  // `setSelectedPin` uses the functional-update form so this ref, created
  // once at mount, never reads a stale `selectedPin` closure.
  const highlightQueueRef = useRef<CameraQueue<PanTarget | null>>(
    createCameraQueue<PanTarget | null>(async (target) => {
      const m = googleMapRef.current;
      if (!m || !mapReadyRef.current) return;

      const action = deriveHighlightAction(highlightRef.current?.courseId ?? null, target?.id ?? null);

      if (action === "remove" || action === "replace") {
        const prev = highlightRef.current;
        if (prev) {
          markerIndexRef.current.delete(prev.markerId);
          setSelectedPin((cur) => (cur?.id === prev.courseId ? null : cur));
          await m.removeMarker(prev.markerId).catch(() => {});
          highlightRef.current = null;
        }
      }

      if ((action === "add" || action === "replace") && target) {
        const id = await m.addMarker(highlightMarkerFor(target)).catch(() => null);
        if (id) {
          highlightRef.current = { markerId: id, courseId: target.id };
          markerIndexRef.current.set(id, {
            id: target.id,
            name: target.name,
            center: target.center,
            source: target.source,
          });
        }
      }
    })
  );

  // Pin-toward-top camera nudge (designer): on pin select, move the camera
  // so the pin sits in the upper third of the screen, above the tap-sheet —
  // via `setCamera` through this dedicated CameraQueue, NEVER `fitBounds`
  // (banned per the file header — the native nil-unwrap crash). Best-effort:
  // a failure here never blocks the sheet, which already renders from
  // `selectedPin` alone.
  const pinCameraQueueRef = useRef<CameraQueue<InBoundsCourse>>(
    createCameraQueue<InBoundsCourse>(async (pin) => {
      const m = googleMapRef.current;
      if (!m || !mapReadyRef.current) return;
      try {
        const bounds = await m.getMapBounds();
        const latSpan = bounds.northeast.lat - bounds.southwest.lat;
        await m.setCamera({
          coordinate: { lat: pin.center.lat - latSpan * 0.35, lng: pin.center.lng },
          animate: true,
          animationDuration: 280,
        });
      } catch {
        // Best-effort nudge only — the sheet still opens regardless.
      }
    })
  );

  // ── Coordinator (created once) — the ONLY network call this component makes. ──
  if (coordinatorRef.current === null) {
    coordinatorRef.current = createScoutCoordinator({
      fetchInBounds: fetchCoursesInBounds,
      onResult: ({ newPins, zoomIn: zi, degraded: deg }) => {
        setFetchError(false);
        setZoomIn(zi);
        setDegraded(deg);
        setEmptyHonest(!zi && !deg && newPins.length === 0 && markerIndexRef.current.size === 0);
        if (newPins.length > 0) {
          pendingPinsRef.current.push(...newPins);
          pinQueueRef.current.request();
        }
      },
      onError: () => setFetchError(true),
      onLoading: setScouting,
    });
  }

  // ── Map initialisation ──────────────────────────────────────────────────
  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;

    const apiKey = (process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "").trim();
    if (!apiKey) {
      setMapError("Map couldn't load");
      return;
    }

    // StrictMode double-invoke guard.
    if (createInProgressRef.current) return;
    createInProgressRef.current = true;

    let destroyed = false;
    let gMap: GoogleMap | null = null;

    (async () => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        if (!destroyed) setMapError("Map couldn't load");
        return;
      }

      try {
        const { GoogleMap, MapType } = await import("@capacitor/google-maps");

        if (typeof customElements !== "undefined") {
          await customElements.whenDefined("capacitor-google-map");
        }

        // Readiness gate (THE crash fix) — see file header + GoogleSatelliteMap.
        let signalReady: () => void = () => {};
        const mapReadyPromise = new Promise<void>((res) => { signalReady = res; });

        gMap = await GoogleMap.create(
          {
            id: mapIdRef.current,
            element: el as HTMLElement,
            apiKey,
            config: {
              center: initialCenter,
              zoom: 12,
              mapTypeId: MapType.Normal,
              disableDefaultUI: true,
              styles: SCOUT_MAP_STYLES,
            },
            forceCreate: true,
          },
          () => { signalReady(); },
        );

        if (destroyed) { await gMap.destroy().catch(() => {}); return; }
        googleMapRef.current = gMap;

        const becameReady = await Promise.race([
          mapReadyPromise.then(() => true),
          new Promise<boolean>((res) => setTimeout(() => res(false), 13000)),
        ]);

        if (destroyed) { await gMap.destroy().catch(() => {}); return; }

        if (!becameReady) {
          setMapError("Map couldn't load");
          await gMap.destroy().catch(() => {});
          googleMapRef.current = null;
          return;
        }

        mapReadyRef.current = true;

        await gMap.setOnCameraIdleListener((ev) => {
          if (!mapReadyRef.current) return;
          coordinatorRef.current?.onCameraIdle({
            swLat: ev.bounds.southwest.lat,
            swLng: ev.bounds.southwest.lng,
            neLat: ev.bounds.northeast.lat,
            neLng: ev.bounds.northeast.lng,
          });
        });

        // The initial-settle idle fires before this listener attaches (iOS
        // GMSMapViewDelegate idleAt) — prime the coordinator with the
        // starting viewport once, through the same debounce/coverage path
        // as a real pan, so pins render on cold open without waiting for
        // the first user pan.
        try {
          const b = await gMap.getMapBounds();
          if (!destroyed && mapReadyRef.current) {
            coordinatorRef.current?.onCameraIdle(boundsToBBox(b));
          }
        } catch {
          // first user pan covers it
        }

        await gMap.setOnMarkerClickListener(({ markerId }) => {
          const pin = markerIndexRef.current.get(markerId) ?? null;
          setSelectedPin(pin);
          if (pin) pinCameraQueueRef.current.request(pin);
        });

        await gMap.setOnMapClickListener(() => {
          setSelectedPin(null);
        });

        // Standard subdued my-location dot. Permission denied / unavailable →
        // no dot, no crash, no error surfaced (the one-shot GPS fix in
        // CourseSearch usually means permission is already granted).
        await gMap.enableCurrentLocation(true).catch(() => {});

        if (!destroyed) setReady(true);
      } catch (err) {
        if (!destroyed) {
          setMapError(err instanceof Error ? err.message : "Map couldn't load");
        }
      }
    })();

    return () => {
      destroyed = true;
      mapReadyRef.current = false;
      googleMapRef.current = null;
      createInProgressRef.current = false;
      coordinatorRef.current?.cancel();
      if (gMap) gMap.destroy().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── panTarget effect: pan + request the search highlight ────────────────
  useEffect(() => {
    if (!ready) return;
    if (!panTarget) {
      if (lastPanIdRef.current !== null) {
        lastPanIdRef.current = null; // clear → retype same course re-pans
        highlightQueueRef.current.request(null); // remove highlight, DO NOT move camera
      }
      return;
    }
    if (lastPanIdRef.current === panTarget.id) return;
    lastPanIdRef.current = panTarget.id;
    const m = googleMapRef.current;
    if (!m || !mapReadyRef.current) return;
    m.setCamera({ coordinate: panTarget.center, zoom: 13, animate: true, animationDuration: 600 }).catch(() => {});
    highlightQueueRef.current.request(panTarget);
  }, [ready, panTarget]);

  // ── /intel fetch, keyed on the selected pin — stale-guarded so a second
  // pin tap while a fetch is in flight can never let the first pin's
  // result land after the second pin is already selected. A failed fetch
  // degrades to name-only + Add (never blocks the existing Add flow).
  useEffect(() => {
    const id = selectedPin?.id ?? null;
    intelRequestIdRef.current = id;
    if (!id) {
      setIntel(null);
      return;
    }
    setIntel(null);
    getCourseIntel(id)
      .then((data) => {
        if (intelRequestIdRef.current === id) setIntel(data);
      })
      .catch(() => {
        // Degrades to name-only + Add — Add must keep working even when
        // /intel 500s (selectedPin alone is enough for the sheet + Add).
      });
  }, [selectedPin]);

  const handleAdd = useCallback(() => {
    if (selectedPin) onAddPin(selectedPin);
  }, [selectedPin, onAddPin]);

  // "Start a round" — reuses the SAME existing start-round entry point the
  // detail page uses (CourseDetailClient.tsx's handleStartRound): stash a
  // CourseHandoff, then land on /round/new. No new round-start flow here.
  const handleStartRound = useCallback(() => {
    if (!selectedPin) return;
    const handoff: CourseHandoff = {
      id: selectedPin.id,
      name: selectedPin.name,
      location: selectedPin.address ?? undefined,
      holes: intel?.stats.holesMapped ?? undefined,
      par: intel?.stats.parTotal ?? undefined,
      source: selectedPin.source,
      center: selectedPin.center,
    };
    stashCourseForRound(handoff);
    router.push("/round/new");
  }, [selectedPin, intel, router]);

  // "View course" — the SAME unified detail-page landing every other course
  // selection uses (lib/course-url.ts), so an unmapped OSM pin still lands
  // honestly on /courses/view with its display data carried in the query.
  const handleViewCourse = useCallback(() => {
    if (!selectedPin) return;
    router.push(
      courseDetailHref({
        id: selectedPin.id,
        source: selectedPin.source,
        name: selectedPin.name,
        location: selectedPin.address ?? undefined,
        center: selectedPin.center,
      })
    );
  }, [selectedPin, router]);

  const handleCloseSheet = useCallback(() => {
    setSelectedPin(null);
  }, []);

  // Priority: zoomIn > degraded > error > empty. Only one line at a time.
  const statusLine = mapError
    ? mapError
    : zoomIn
    ? "Zoom in to see courses"
    : degraded
    ? "Some courses may be missing here"
    : fetchError
    ? "Couldn't check this area"
    : emptyHonest
    ? "No courses in this view."
    : null;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <capacitor-google-map
        ref={(el: HTMLElement | null) => { mapContainerRef.current = el; }}
        style={{ display: "block", width: "100%", height: "100%", background: "transparent" }}
      />

      {/* Status one-liner + scouting indicator — hidden entirely while a pin
          is selected (the tap-sheet is tall; calmer than chasing its height). */}
      {(statusLine || scouting) && !selectedPin && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 20,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          <div style={STATUS_PILL}>
            {scouting && (
              <motion.div
                animate={{ opacity: [0.3, 0.8, 0.3] }}
                transition={{ duration: 1.2, repeat: Infinity }}
                style={{ width: 6, height: 6, borderRadius: 99, background: T.pencilSoft }}
              />
            )}
            {statusLine}
          </div>
        </div>
      )}

      {/* Tap-sheet — floating inset slide-up (course-discovery-intel Build 3) */}
      <AnimatePresence>
        {selectedPin && (
          <CourseIntelSheet
            pin={selectedPin}
            intel={intel}
            onAdd={handleAdd}
            onStartRound={handleStartRound}
            onViewCourse={handleViewCourse}
            onClose={handleCloseSheet}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
