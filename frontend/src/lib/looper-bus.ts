// The Looper orb → sheet event bus (specs/looper-orb-plan.md).
//
// The orb lives in the floating tab bar (a layout-level component); the sheets
// it opens live in pages (tee-time, courses) or next to the bar (general).
// A window CustomEvent keeps them decoupled — no context provider threading
// through the app router, and pages that don't care never re-render.

export type LooperContext = "general" | "tee-time" | "courses";

export interface LooperOpenDetail {
  context: LooperContext;
  /** true = long-press: the sheet should open already listening. */
  listening: boolean;
  /**
   * "docked" = no sheet chrome — the host publishes orb state/caption and the
   * golfer talks straight into the orb; "full" = today's sheet. Optional;
   * omitted means "full" (back-compat with every pre-inversion summon site —
   * e.g. the courses list page's own "courses" summon, which reads only
   * `context`/`listening` and never sets this field).
   */
  presentation?: "docked" | "full";
}

const EVENT = "looper:open";

/** Which Looper context the current route belongs to. */
export function looperContextForPath(pathname: string): LooperContext {
  if (pathname.startsWith("/tee-time")) return "tee-time";
  // "courses" is scoped to the LIST page only (app/courses/page.tsx owns a
  // live `context: "courses"` bus listener that opens its own voice search).
  // Course DETAIL pages (`/courses/[id]`) are NOT registered for "courses" —
  // they fall through to "general" so the host's legacy-courses-floor guard
  // (CaddieOrbSheet.tsx, `if (!ctx && detail.context === "courses") return;`)
  // stays scoped to the list page. If a detail page summoned "courses" here,
  // that guard would swallow it — a dead mic. Mapping to "general" instead
  // opens the general converse sheet there.
  const p = pathname.replace(/\/+$/, "");
  if (p === "/courses") return "courses";
  return "general";
}

/** Summon Looper (called by the orb). SSR-safe no-op. */
export function openLooper(detail: LooperOpenDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<LooperOpenDetail>(EVENT, { detail }));
}

/** Subscribe to summons. Returns the unsubscribe. SSR-safe no-op. */
export function onLooperOpen(cb: (detail: LooperOpenDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<LooperOpenDetail>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

// ── Docked-gesture channel (orb → host, one-way) ────────────────────────────
// While the general orb is in `presentation: "docked"` (talking straight into
// the orb, no sheet chrome), the orb's OWN tap/hold gestures mean something
// different than they do idle ("send" / "cancel" instead of "open the
// sheet") — this is a second, narrower event so the docked host doesn't have
// to reinterpret `looper:open` payloads it never sent itself. Mirrors
// `openLooper`/`onLooperOpen` verbatim: SSR-safe no-ops, plain CustomEvent.

export type LooperDockedGesture = "send" | "cancel";

const DOCKED_GESTURE_EVENT = "looper:docked-gesture";

/** Fire a docked-presentation gesture (called by the orb). SSR-safe no-op. */
export function sendLooperDockedGesture(gesture: LooperDockedGesture): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<LooperDockedGesture>(DOCKED_GESTURE_EVENT, { detail: gesture }));
}

/** Subscribe to docked gestures. Returns the unsubscribe. SSR-safe no-op. */
export function onLooperDockedGesture(cb: (gesture: LooperDockedGesture) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<LooperDockedGesture>).detail);
  window.addEventListener(DOCKED_GESTURE_EVENT, handler);
  return () => window.removeEventListener(DOCKED_GESTURE_EVENT, handler);
}
