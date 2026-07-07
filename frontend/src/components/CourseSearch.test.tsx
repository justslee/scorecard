// @vitest-environment jsdom
//
// CourseSearch — full-screen structural fix regression (owner escalation:
// the old bottom sheet resized as results streamed in / the iOS keyboard
// opened). This test locks in the core requirement: the outer surface is a
// fixed `position: fixed; inset: 0` frame at `100dvh` that is NEVER bound to
// content or result count — only the inner scroll region grows.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { CourseSearchResult } from "@/lib/golf-api";

// ── Mocks — keep this test hermetic (no network, no GPS, no localStorage) ──
vi.mock("@/lib/golf-api", () => ({
  searchNearby: vi.fn().mockResolvedValue([]),
  getRecentCourses: vi.fn(() => []),
}));
vi.mock("@/lib/course-favorites", () => ({
  listFavorites: vi.fn(() => []),
  addFavorite: vi.fn(() => []),
  removeFavorite: vi.fn(() => []),
}));
vi.mock("@/lib/gps", () => ({
  GPSWatcher: {
    getCurrentPosition: vi.fn().mockRejectedValue(new Error("denied")),
  },
}));

// Capture the callbacks CourseSearch registers with the session so the test
// can drive `onResults` directly with an arbitrary row count, independent of
// the real debounce/search-session timing.
let capturedCallbacks: {
  onResults: (rows: CourseSearchResult[]) => void;
  onError: (msg: string) => void;
  onSettled: () => void;
} | null = null;

vi.mock("@/lib/course-search-session", () => ({
  createCourseSearchSession: (callbacks: typeof capturedCallbacks) => {
    capturedCallbacks = callbacks;
    return {
      noteQuery: vi.fn(),
      search: vi.fn(),
      cancel: vi.fn(),
    };
  },
}));

import CourseSearch from "./CourseSearch";

function makeResult(i: number): CourseSearchResult {
  return { id: `r-${i}`, name: `Course ${i}`, source: "osm" };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  capturedCallbacks = null;
});

describe("CourseSearch — fixed full-screen surface (no resize jank)", () => {
  it("outer surface is position:fixed, full inset, 100dvh — independent of idle state", () => {
    render(<CourseSearch onSelectCourse={vi.fn()} onClose={vi.fn()} />);
    const surface = screen.getByTestId("course-search-surface");
    expect(surface.style.position).toBe("fixed");
    expect(surface.style.top).toBe("0px");
    expect(surface.style.left).toBe("0px");
    expect(surface.style.right).toBe("0px");
    expect(surface.style.bottom).toBe("0px");
    expect(surface.style.height).toBe("100dvh");
    // The outer frame itself never scrolls or grows — only the inner region does.
    expect(surface.style.overflow).toBe("hidden");
  });

  it("outer surface geometry is UNCHANGED after many typed results stream in", () => {
    render(<CourseSearch onSelectCourse={vi.fn()} onClose={vi.fn()} />);
    const surface = screen.getByTestId("course-search-surface");
    const before = {
      position: surface.style.position,
      top: surface.style.top,
      left: surface.style.left,
      right: surface.style.right,
      bottom: surface.style.bottom,
      height: surface.style.height,
      overflow: surface.style.overflow,
    };

    // Type a query (>=2 chars) so the component leaves idle state and renders
    // the typed-results list, then push a large append-only batch straight
    // through the captured session callback — simulating many rows settling.
    const input = screen.getByPlaceholderText("Course name or location…");
    fireEvent.change(input, { target: { value: "bethpage" } });

    const manyRows = Array.from({ length: 40 }, (_, i) => makeResult(i));
    expect(capturedCallbacks).not.toBeNull();
    act(() => {
      capturedCallbacks!.onResults(manyRows);
    });

    // Sanity: the rows actually rendered (proves this is a real stress case,
    // not a no-op).
    expect(screen.getAllByText(/^Course \d+$/).length).toBe(40);

    const after = {
      position: surface.style.position,
      top: surface.style.top,
      left: surface.style.left,
      right: surface.style.right,
      bottom: surface.style.bottom,
      height: surface.style.height,
      overflow: surface.style.overflow,
    };
    expect(after).toEqual(before);
  });

  it("only the inner scroll region scrolls — the outer frame is not a scroll container", () => {
    render(<CourseSearch onSelectCourse={vi.fn()} onClose={vi.fn()} />);
    const surface = screen.getByTestId("course-search-surface");
    const scrollRegion = screen.getByTestId("course-search-scroll-region");
    expect(surface.style.overflow).toBe("hidden");
    expect(scrollRegion.style.overflowY).toBe("auto");
  });

  it("back chevron closes and mic is hidden when onVoiceSearch is not passed", () => {
    const onClose = vi.fn();
    render(<CourseSearch onSelectCourse={vi.fn()} onClose={onClose} />);
    expect(screen.queryByLabelText("Voice search")).toBeNull();
    fireEvent.click(screen.getByLabelText("Back"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("mic affordance appears and fires onVoiceSearch when provided", () => {
    const onVoiceSearch = vi.fn();
    render(<CourseSearch onSelectCourse={vi.fn()} onClose={vi.fn()} onVoiceSearch={onVoiceSearch} />);
    fireEvent.click(screen.getByLabelText("Voice search"));
    expect(onVoiceSearch).toHaveBeenCalledTimes(1);
  });
});
