import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bboxToCells,
  bboxFullyCovered,
  createScoutCoordinator,
  SCOUT_DEBOUNCE_MS,
  type ScoutCoordinatorDeps,
} from "./scout-viewport";
import type { BBox, InBoundsCourse, InBoundsResponse } from "@/lib/golf-api";

function course(id: string, lat = 40.7, lng = -73.5): InBoundsCourse {
  return { id, name: `Course ${id}`, center: { lat, lng }, source: "local" };
}

function resolved(courses: InBoundsCourse[], extra?: Partial<InBoundsResponse>): InBoundsResponse {
  return { courses, degraded: false, zoomIn: false, ...extra };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bboxToCells", () => {
  it("known bbox → exact expected ilat:ilng keys (floor of value/0.05)", () => {
    const bbox: BBox = { swLat: 40.70, swLng: -73.50, neLat: 40.78, neLng: -73.42 };
    // ilat range: floor(40.70/0.05)=814 .. floor(40.78/0.05)=815
    // ilng range: floor(-73.50/0.05)=-1470 .. floor(-73.42/0.05)=-1469 (careful w/ negative flooring)
    const cells = bboxToCells(bbox);
    const ilatMin = Math.floor(40.70 / 0.05);
    const ilatMax = Math.floor(40.78 / 0.05);
    const ilngMin = Math.floor(-73.50 / 0.05);
    const ilngMax = Math.floor(-73.42 / 0.05);
    const expected: string[] = [];
    for (let ilat = ilatMin; ilat <= ilatMax; ilat++) {
      for (let ilng = ilngMin; ilng <= ilngMax; ilng++) {
        expected.push(`${ilat}:${ilng}`);
      }
    }
    expect(cells.sort()).toEqual(expected.sort());
  });

  it("negative-coordinate flooring: -0.01 floors to cell -1, not 0", () => {
    const bbox: BBox = { swLat: -0.01, swLng: -0.01, neLat: -0.01, neLng: -0.01 };
    expect(bboxToCells(bbox)).toEqual(["-1:-1"]);
  });

  it("single-cell bbox → exactly 1 key", () => {
    const bbox: BBox = { swLat: 40.71, swLng: -73.49, neLat: 40.72, neLng: -73.48 };
    expect(bboxToCells(bbox).length).toBe(1);
  });
});

describe("bboxFullyCovered", () => {
  it("true only when every cell is in the covered set", () => {
    const bbox: BBox = { swLat: 40.71, swLng: -73.49, neLat: 40.72, neLng: -73.48 };
    const cells = bboxToCells(bbox);
    expect(bboxFullyCovered(bbox, new Set(cells))).toBe(true);
    expect(bboxFullyCovered(bbox, new Set())).toBe(false);
  });
});

function makeCoordinator(overrides: Partial<ScoutCoordinatorDeps> = {}) {
  const fetchInBounds = vi.fn<ScoutCoordinatorDeps["fetchInBounds"]>();
  const onResult = vi.fn();
  const onError = vi.fn();
  const onLoading = vi.fn();
  const coordinator = createScoutCoordinator({
    fetchInBounds,
    onResult,
    onError,
    onLoading,
    ...overrides,
  });
  return { coordinator, fetchInBounds, onResult, onError, onLoading };
}

const BBOX_A: BBox = { swLat: 40.70, swLng: -73.52, neLat: 40.75, neLng: -73.47 };
// Extends well past a full extra 0.05° cell row (verified: floor(40.75/0.05)=815,
// floor(41.00/0.05)=820 — a small +0.05 nudge can floating-point-alias onto the
// SAME cell as 40.75 here, so this jumps by 5 cells to avoid that trap).
const BBOX_A_EXTENDED: BBox = { swLat: 40.70, swLng: -73.52, neLat: 41.00, neLng: -73.47 };

describe("createScoutCoordinator", () => {
  it("debounce coalescing: 3 onCameraIdle calls within 600ms → exactly ONE fetch with the LAST bbox", () => {
    const { coordinator, fetchInBounds } = makeCoordinator();
    fetchInBounds.mockResolvedValue(resolved([]));

    const bboxB: BBox = { ...BBOX_A, neLat: 40.76 };
    const bboxC: BBox = { ...BBOX_A, neLat: 40.77 };

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(200);
    coordinator.onCameraIdle(bboxB);
    vi.advanceTimersByTime(200);
    coordinator.onCameraIdle(bboxC);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);

    expect(fetchInBounds).toHaveBeenCalledTimes(1);
    expect(fetchInBounds.mock.calls[0][0]).toEqual(bboxC);
  });

  it("covered-cell skip: same bbox idle again after a clean fetch → NO second fetch; extending bbox DOES fetch", async () => {
    const { coordinator, fetchInBounds } = makeCoordinator();
    fetchInBounds.mockResolvedValue(resolved([course("c1")]));

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(fetchInBounds).toHaveBeenCalledTimes(1);

    // Same bbox again — fully covered, no fetch.
    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(fetchInBounds).toHaveBeenCalledTimes(1);

    // Overlapping-but-extending bbox — some cells uncovered, fetch fires.
    coordinator.onCameraIdle(BBOX_A_EXTENDED);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(fetchInBounds).toHaveBeenCalledTimes(2);
  });

  it("degraded doesn't cover: same bbox again after a degraded result fetches again", async () => {
    const { coordinator, fetchInBounds } = makeCoordinator();
    fetchInBounds.mockResolvedValue(resolved([], { degraded: true }));

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(fetchInBounds).toHaveBeenCalledTimes(1);

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(fetchInBounds).toHaveBeenCalledTimes(2);
  });

  it("zoomIn: onResult sees zoomIn true, no cells covered, no pins", async () => {
    const { coordinator, fetchInBounds, onResult } = makeCoordinator();
    fetchInBounds.mockResolvedValue(resolved([], { zoomIn: true }));

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();

    expect(onResult).toHaveBeenCalledWith({ newPins: [], zoomIn: true, degraded: false });

    // No cells covered — same bbox idle again still fetches.
    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(fetchInBounds).toHaveBeenCalledTimes(2);
  });

  it("abort-cancels-stale: a new idle aborts the in-flight fetch's controller; the stale resolve never reaches onResult", async () => {
    const { coordinator, fetchInBounds, onResult } = makeCoordinator();

    let resolveFirst: ((v: InBoundsResponse) => void) | null = null;
    fetchInBounds.mockImplementationOnce((_bbox) => {
      return new Promise((res) => { resolveFirst = res; });
    });
    const secondResponse = resolved([course("c-second")]);
    fetchInBounds.mockImplementationOnce(() => Promise.resolve(secondResponse));

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    // First fetch now in flight (pending, unresolved).
    expect(fetchInBounds).toHaveBeenCalledTimes(1);
    const firstSignal = fetchInBounds.mock.calls[0][1];
    expect(firstSignal.aborted).toBe(false);

    // New idle for a different (uncovered) viewport — its debounce fires a
    // second fetch, which must abort the first's controller.
    coordinator.onCameraIdle(BBOX_A_EXTENDED);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();

    expect(firstSignal.aborted).toBe(true);
    expect(fetchInBounds).toHaveBeenCalledTimes(2);

    // Second fetch's result already landed via onResult.
    expect(onResult).toHaveBeenCalledWith({ newPins: [course("c-second")], zoomIn: false, degraded: false });
    onResult.mockClear();

    // Now resolve the FIRST (stale) promise — its result must never reach onResult.
    resolveFirst!(resolved([course("c-first-stale")]));
    await vi.runAllTimersAsync();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("pin dedupe: an id delivered once is excluded from a later fetch's newPins", async () => {
    const { coordinator, fetchInBounds, onResult } = makeCoordinator();
    fetchInBounds.mockResolvedValueOnce(resolved([course("dupe"), course("only-first")]));
    fetchInBounds.mockResolvedValueOnce(resolved([course("dupe"), course("only-second")]));

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(onResult).toHaveBeenLastCalledWith({
      newPins: [course("dupe"), course("only-first")],
      zoomIn: false,
      degraded: false,
    });

    coordinator.onCameraIdle(BBOX_A_EXTENDED);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(onResult).toHaveBeenLastCalledWith({
      newPins: [course("only-second")],
      zoomIn: false,
      degraded: false,
    });
  });

  it("error honesty: a rejecting (non-abort) fetch fires onError, never onResult, and covers no cells", async () => {
    const { coordinator, fetchInBounds, onResult, onError } = makeCoordinator();
    fetchInBounds.mockRejectedValueOnce(new Error("network down"));

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();

    // Cells not covered — same bbox fetches again.
    fetchInBounds.mockResolvedValueOnce(resolved([]));
    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(fetchInBounds).toHaveBeenCalledTimes(2);
  });

  it("error honesty: AbortError fires neither onError nor onResult", async () => {
    const { coordinator, fetchInBounds, onResult, onError } = makeCoordinator();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchInBounds.mockRejectedValueOnce(abortErr);

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    await vi.runAllTimersAsync();

    expect(onError).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("cancel(): clears the pending timer, aborts in-flight, and a late resolve is dead", async () => {
    const { coordinator, fetchInBounds, onResult } = makeCoordinator();
    let resolveFirst: ((v: InBoundsResponse) => void) | null = null;
    fetchInBounds.mockImplementationOnce((_bbox) => {
      return new Promise((res) => { resolveFirst = res; });
    });

    coordinator.onCameraIdle(BBOX_A);
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    expect(fetchInBounds).toHaveBeenCalledTimes(1);
    const firstSignal = fetchInBounds.mock.calls[0][1];

    coordinator.cancel();
    expect(firstSignal.aborted).toBe(true);

    resolveFirst!(resolved([course("late")]));
    await vi.runAllTimersAsync();
    expect(onResult).not.toHaveBeenCalled();

    // A pending (never-fired) timer is also cleared by cancel().
    const { coordinator: c2, fetchInBounds: fetch2 } = makeCoordinator();
    c2.onCameraIdle(BBOX_A);
    c2.cancel();
    vi.advanceTimersByTime(SCOUT_DEBOUNCE_MS);
    expect(fetch2).not.toHaveBeenCalled();
  });
});
