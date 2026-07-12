// @vitest-environment jsdom
//
// CourseSearch — full-screen structural fix regression (owner escalation:
// the old bottom sheet resized as results streamed in / the iOS keyboard
// opened). This test locks in the core requirement: the outer surface is a
// fixed `position: fixed; inset: 0` frame at `100dvh` that is NEVER bound to
// content or result count — only the inner scroll region grows.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { CourseSearchResult, InBoundsCourse } from "@/lib/golf-api";
import { listFavorites } from "@/lib/course-favorites";
import type { CourseScoutMapProps } from "@/components/CourseScoutMap";

// ── Mocks — keep this test hermetic (no network, no GPS, no localStorage) ──
// normalizeSource/sourceLabelFor are kept REAL (spread from actual) — the B2
// pin-payload identity path (pinToSearchResult → resultToPayload) depends on
// them, and the map-mode tests below exercise that path end-to-end.
vi.mock("@/lib/golf-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/golf-api")>();
  return {
    ...actual,
    searchNearby: vi.fn().mockResolvedValue([]),
    getRecentCourses: vi.fn(() => []),
  };
});
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

// CourseScoutMap pulls in the native @capacitor/google-maps plugin — mocked
// to a stub so no plugin import ever runs in jsdom. Captures the latest
// props (re-set on every render) so tests can drive onAddPin/panTarget and
// assert on what CourseSearch passed down.
let capturedScoutMapProps: CourseScoutMapProps | null = null;
vi.mock("@/components/CourseScoutMap", () => ({
  default: (props: CourseScoutMapProps) => {
    capturedScoutMapProps = props;
    return <div data-testid="course-scout-map" />;
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
  capturedScoutMapProps = null;
  vi.mocked(listFavorites).mockReturnValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

// ---------------------------------------------------------------------------
// B2 — Map⇄List mode toggle (specs/course-selection-b2-plan.md §5)
//
// `hasMapsKey` is read at module scope, so each case that needs a different
// key state stubs the env then re-imports a FRESH copy of the module via
// vi.resetModules() — the established pattern for env-gated modules.
// ---------------------------------------------------------------------------

describe("CourseSearch — Map⇄List mode (B2)", () => {
  it("no Maps key → mode toggle NOT rendered; list renders as before", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", "");
    vi.resetModules();
    const { default: FreshCourseSearch } = await import("./CourseSearch");

    render(<FreshCourseSearch onSelectCourse={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId("course-search-mode-toggle")).toBeNull();
    expect(screen.getByTestId("course-search-scroll-region")).toBeTruthy();
  });

  it("Maps key set → toggle renders; initial mode is list (scroll region present, scout map absent)", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", "AIzaFakeKeyForTest");
    vi.resetModules();
    const { default: FreshCourseSearch } = await import("./CourseSearch");

    render(<FreshCourseSearch onSelectCourse={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("course-search-mode-toggle")).toBeTruthy();
    expect(screen.getByTestId("course-search-scroll-region")).toBeTruthy();
    expect(screen.queryByTestId("course-scout-map")).toBeNull();
  });

  it("click toggle → scout map mounts, scroll region gone; click again → list restored (seeded favorite survives the round-trip)", async () => {
    vi.mocked(listFavorites).mockReturnValue([
      {
        id: "fav-1",
        name: "Favorite Club",
        source: "local",
        favoritedAt: new Date().toISOString(),
      },
    ]);
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", "AIzaFakeKeyForTest");
    vi.resetModules();
    const { default: FreshCourseSearch } = await import("./CourseSearch");

    render(<FreshCourseSearch onSelectCourse={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Favorite Club")).toBeTruthy();

    fireEvent.click(screen.getByTestId("course-search-mode-toggle"));
    expect(screen.queryByTestId("course-search-scroll-region")).toBeNull();
    expect(screen.getByTestId("course-scout-map")).toBeTruthy();

    fireEvent.click(screen.getByTestId("course-search-mode-toggle"));
    expect(screen.getByTestId("course-search-scroll-region")).toBeTruthy();
    expect(screen.queryByTestId("course-scout-map")).toBeNull();
    // Preserved state, not a refetch/reshuffle — the same favorite row is back.
    expect(screen.getByText("Favorite Club")).toBeTruthy();
  });

  it("stub's onAddPin invoked with a pin → onSelectCourse called with the exact parity payload", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", "AIzaFakeKeyForTest");
    vi.resetModules();
    const { default: FreshCourseSearch } = await import("./CourseSearch");
    const onSelectCourse = vi.fn();

    render(<FreshCourseSearch onSelectCourse={onSelectCourse} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("course-search-mode-toggle"));
    expect(capturedScoutMapProps).not.toBeNull();

    const pin: InBoundsCourse = {
      id: "pin-1",
      name: "Pin Course",
      address: "Somewhere, NY",
      center: { lat: 1, lng: 2 },
      source: "osm",
    };
    act(() => {
      capturedScoutMapProps!.onAddPin(pin);
    });

    expect(onSelectCourse).toHaveBeenCalledWith({
      id: "pin-1",
      name: "Pin Course",
      clubName: "Pin Course",
      clubId: "pin-1",
      location: "Somewhere, NY",
      source: "osm",
      center: { lat: 1, lng: 2 },
    });
  });

  it("panTarget follows the top typed-hit center; a hit without a center leaves panTarget null (no throw)", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", "AIzaFakeKeyForTest");
    vi.resetModules();
    const { default: FreshCourseSearch } = await import("./CourseSearch");

    render(<FreshCourseSearch onSelectCourse={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("course-search-mode-toggle"));
    expect(capturedScoutMapProps?.panTarget).toBeNull();

    const input = screen.getByPlaceholderText("Course name or location…");
    fireEvent.change(input, { target: { value: "bethpage" } });
    expect(capturedCallbacks).not.toBeNull();

    act(() => {
      capturedCallbacks!.onResults([
        { id: "top-1", name: "Bethpage Black", source: "osm", center: { lat: 40.74, lng: -73.46 } },
      ]);
    });
    expect(capturedScoutMapProps?.panTarget).toEqual({ id: "top-1", center: { lat: 40.74, lng: -73.46 } });

    // A top hit WITHOUT a center → panTarget stays null, nothing throws.
    expect(() => {
      act(() => {
        capturedCallbacks!.onResults([{ id: "top-2", name: "No Center Course", source: "osm" }]);
      });
    }).not.toThrow();
    expect(capturedScoutMapProps?.panTarget).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full-screen overlay registration (specs/caddie-orb-map-mode-ghost-plan.md §4.3)
// ---------------------------------------------------------------------------

describe("CourseSearch — full-screen overlay registration", () => {
  afterEach(() => {
    // Belt-and-suspenders: ensure any component rendered in this block is
    // unmounted (running its registration effect's cleanup) even if an
    // assertion above throws before the test's own unmount() call.
    cleanup();
  });

  it("registers on mount, stays registered across list⇄map mode toggle (mount-scoped, not mode-scoped), unregisters on unmount", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_KEY", "AIzaFakeKeyForTest");
    vi.resetModules();
    const { default: FreshCourseSearch } = await import("./CourseSearch");
    const { isFullscreenOverlayActive } = await import("@/lib/fullscreen-overlay");

    const { unmount } = render(<FreshCourseSearch onSelectCourse={vi.fn()} onClose={vi.fn()} />);
    expect(isFullscreenOverlayActive()).toBe(true);

    fireEvent.click(screen.getByTestId("course-search-mode-toggle"));
    expect(screen.getByTestId("course-scout-map")).toBeTruthy();
    expect(isFullscreenOverlayActive()).toBe(true); // still registered in map mode

    fireEvent.click(screen.getByTestId("course-search-mode-toggle"));
    expect(screen.getByTestId("course-search-scroll-region")).toBeTruthy();
    expect(isFullscreenOverlayActive()).toBe(true); // still registered back in list mode

    unmount();
    expect(isFullscreenOverlayActive()).toBe(false);
  });
});
