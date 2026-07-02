/**
 * Course-search session — owns the AbortController and stale-query guard for
 * the CourseSearch sheet. Pure TS (no React) so the race behavior is
 * unit-testable without a DOM.
 *
 * Guarantees:
 * - Starting a new search ABORTS the in-flight one (the signal reaches every
 *   source leg's fetch via searchAllCourses).
 * - Results/errors from a superseded query are NEVER delivered — each request
 *   captures its query and only applies while it still equals the live query
 *   (belt for browsers where the abort loses the race). Call noteQuery() on
 *   every keystroke so an in-flight search goes stale immediately, before the
 *   debounce even fires.
 * - Each search starts from a clean slate (an immediate `onResults([])`), then
 *   receives append-only cumulative batches as legs settle — rendered rows are
 *   never removed or reordered for the same query.
 */

import { searchAllCourses, type CourseSearchResult } from "./golf-api";

export interface CourseSearchSessionCallbacks {
  /** Cumulative append-only results for the live query ([] = clean slate). */
  onResults: (results: CourseSearchResult[]) => void;
  /** Non-abort failure for the live query. */
  onError: (message: string) => void;
  /** All legs of the live query settled — safe to stop the spinner. */
  onSettled: () => void;
}

/** Injectable search function (searchAllCourses in production; fake in tests). */
export type SearchAllFn = (
  query: string,
  options: {
    signal: AbortSignal;
    onResults: (results: CourseSearchResult[]) => void;
  }
) => Promise<CourseSearchResult[]>;

export interface CourseSearchSession {
  /** Mark q as the live query (call on EVERY keystroke, pre-debounce). */
  noteQuery(q: string): void;
  /** Start a search for q, aborting any in-flight one. */
  search(q: string): void;
  /** Abort in-flight work (short query / unmount). */
  cancel(): void;
}

export function createCourseSearchSession(
  callbacks: CourseSearchSessionCallbacks,
  searchFn: SearchAllFn = searchAllCourses
): CourseSearchSession {
  let liveQuery = "";
  let controller: AbortController | null = null;

  return {
    noteQuery(q: string) {
      liveQuery = q;
    },

    cancel() {
      controller?.abort();
      controller = null;
    },

    search(q: string) {
      controller?.abort();
      liveQuery = q;
      const c = new AbortController();
      controller = c;

      // Stale guard: this request only speaks while its query is still live
      // AND it hasn't been aborted.
      const isLive = () => liveQuery === q && !c.signal.aborted;

      callbacks.onResults([]); // new query → clean slate

      searchFn(q, {
        signal: c.signal,
        onResults: (rows) => {
          if (isLive()) callbacks.onResults(rows);
        },
      })
        .then((rows) => {
          // Final merged list — idempotent with the last progressive batch.
          if (isLive()) callbacks.onResults(rows);
        })
        .catch((err: unknown) => {
          if ((err as Error)?.name !== "AbortError" && isLive()) {
            callbacks.onError("Search failed — check your connection.");
          }
        })
        .finally(() => {
          if (isLive()) callbacks.onSettled();
        });
    },
  };
}
