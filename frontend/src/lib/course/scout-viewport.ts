/**
 * Scout coordinator — pure viewport-fetch logic for CourseScoutMap (B2 map
 * mode). Zero DOM/plugin/React imports so this is unit-testable in Node
 * exactly like google-map-helpers.ts.
 *
 * Owns:
 *  - trailing debounce of camera-idle bboxes (a pan burst coalesces to one fetch)
 *  - bbox → covered-cell bookkeeping (mirrors the backend's 0.05° floor-indexed
 *    cells, course_search.py `_cells_for_bbox`) so a re-pan into already-seen
 *    territory costs zero network
 *  - per-fetch AbortController + a monotonic generation counter, so a stale
 *    resolve (abort lost the race) can never deliver
 *  - pin dedupe by id — the map layer is append-only, a re-pan never re-adds
 *    or reshuffles a course already on the map
 *  - honest coverage marking: a degraded or zoomIn result never freezes a
 *    lie into the coverage set — the viewport retries on the next pan
 *
 * See specs/course-selection-b2-plan.md §2.2 for the full contract.
 */

import type { BBox, InBoundsCourse, InBoundsResponse } from "@/lib/golf-api";

/** MUST mirror backend IN_BOUNDS_CELL_DEG (course_search.py:88). */
export const SCOUT_CELL_DEG = 0.05;
/** Spec: 500–700ms trailing debounce on camera-idle. */
export const SCOUT_DEBOUNCE_MS = 600;

/**
 * Floor-indexed integer cell keys ("ilat:ilng") intersecting the bbox — same
 * flooring as the backend's `_cells_for_bbox` (course_search.py:110-131), so
 * client-side coverage tracking aligns with the server's cache cells.
 *
 * Pure function — no side effects, headless-testable.
 */
export function bboxToCells(bbox: BBox): string[] {
  const ilatMin = Math.floor(bbox.swLat / SCOUT_CELL_DEG);
  const ilatMax = Math.floor(bbox.neLat / SCOUT_CELL_DEG);
  const ilngMin = Math.floor(bbox.swLng / SCOUT_CELL_DEG);
  const ilngMax = Math.floor(bbox.neLng / SCOUT_CELL_DEG);

  const cells: string[] = [];
  for (let ilat = ilatMin; ilat <= ilatMax; ilat++) {
    for (let ilng = ilngMin; ilng <= ilngMax; ilng++) {
      cells.push(`${ilat}:${ilng}`);
    }
  }
  return cells;
}

/** True when every cell of the bbox is already in `covered`. Pure. */
export function bboxFullyCovered(bbox: BBox, covered: ReadonlySet<string>): boolean {
  return bboxToCells(bbox).every((c) => covered.has(c));
}

export interface ScoutFetchResult {
  /** Deduped: only pins whose id was never delivered before. */
  newPins: InBoundsCourse[];
  zoomIn: boolean;
  degraded: boolean;
}

export interface ScoutCoordinator {
  /** Feed every camera-idle bbox here. Debounced internally. */
  onCameraIdle(bbox: BBox): void;
  /** Cancel the pending timer + abort any in-flight fetch (mode-leave/unmount). */
  cancel(): void;
}

export interface ScoutCoordinatorDeps {
  /** Injected — testable without a real network call. */
  fetchInBounds: (bbox: BBox, signal: AbortSignal) => Promise<InBoundsResponse>;
  onResult: (r: ScoutFetchResult) => void;
  /** Non-abort failure (quiet note, never a fabricated empty). */
  onError?: () => void;
  onLoading?: (loading: boolean) => void;
  /** Default SCOUT_DEBOUNCE_MS. */
  debounceMs?: number;
}

export function createScoutCoordinator(deps: ScoutCoordinatorDeps): ScoutCoordinator {
  const { fetchInBounds, onResult, onError, onLoading } = deps;
  const debounceMs = deps.debounceMs ?? SCOUT_DEBOUNCE_MS;

  const covered = new Set<string>();
  const seenIds = new Set<string>();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingBbox: BBox | null = null;
  let controller: AbortController | null = null;
  // Bumped on cancel() and on every new fetch start — a resolution whose
  // generation no longer matches the latest never delivers (belt for abort
  // losing the race).
  let generation = 0;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function runFetch(bbox: BBox) {
    // Abort the previous in-flight fetch (if any) and start a fresh one.
    controller?.abort();
    const myGeneration = ++generation;
    const c = new AbortController();
    controller = c;

    onLoading?.(true);

    fetchInBounds(bbox, c.signal)
      .then((res) => {
        if (myGeneration !== generation) return; // stale — dead on arrival

        const newPins = res.courses.filter((p) => !seenIds.has(p.id));
        for (const p of newPins) seenIds.add(p.id);

        // Coverage marking: only on a clean success (never degraded/zoomIn) —
        // a lie about coverage would freeze a bad viewport forever.
        if (!res.degraded && !res.zoomIn) {
          for (const cell of bboxToCells(bbox)) covered.add(cell);
        }

        onResult({ newPins, zoomIn: res.zoomIn, degraded: res.degraded });
      })
      .catch((err: unknown) => {
        if (myGeneration !== generation) return; // stale — dead on arrival
        if ((err as { name?: string })?.name === "AbortError") return; // silent
        onError?.();
      })
      .finally(() => {
        if (myGeneration === generation) onLoading?.(false);
      });
  }

  return {
    onCameraIdle(bbox: BBox) {
      pendingBbox = bbox;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        const bb = pendingBbox;
        pendingBbox = null;
        if (!bb) return;
        if (bboxFullyCovered(bb, covered)) return; // already seen — no fetch, no churn
        runFetch(bb);
      }, debounceMs);
    },

    cancel() {
      clearTimer();
      pendingBbox = null;
      controller?.abort();
      controller = null;
      generation++; // any late resolve is now stale
    },
  };
}
