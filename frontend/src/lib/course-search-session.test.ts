/**
 * Unit tests for createCourseSearchSession() — the stale-guard belt that sits
 * in front of searchAllCourses in CourseSearch.tsx (course-search-fix-plan.md,
 * work item 2). Uses an injected fake searchFn so ordering/timing can be
 * controlled deterministically without real network or timers.
 */

import { describe, it, expect, vi } from "vitest";
import { createCourseSearchSession, type SearchAllFn } from "./course-search-session";
import type { CourseSearchResult } from "./golf-api";

const row = (name: string, id = name): CourseSearchResult => ({
  id,
  name,
  source: "mapped",
});

describe("createCourseSearchSession — stale guard under out-of-order resolution", () => {
  it("drops an OLDER query's results when it resolves AFTER a NEWER query", async () => {
    // deferred resolvers keyed by query so the test controls resolution order
    const resolvers = new Map<string, (rows: CourseSearchResult[]) => void>();
    const fakeSearch: SearchAllFn = (query) =>
      new Promise((resolve) => {
        resolvers.set(query, resolve);
      });

    const delivered: CourseSearchResult[][] = [];
    const session = createCourseSearchSession(
      {
        onResults: (rows) => delivered.push(rows),
        onError: () => {},
        onSettled: () => {},
      },
      fakeSearch
    );

    session.search("beth");
    session.search("bethpage"); // newer query — supersedes "beth"

    // Older query resolves AFTER the newer one (out-of-order network response).
    resolvers.get("bethpage")!([row("Bethpage Black")]);
    await Promise.resolve();
    resolvers.get("beth")!([row("Bethel Island")]);
    await Promise.resolve();
    await Promise.resolve();

    const names = delivered.flat().map((r) => r.name);
    expect(names).not.toContain("Bethel Island");
    expect(names).toContain("Bethpage Black");
  });

  it("noteQuery() marks an in-flight request stale before the debounce/search even starts", async () => {
    const resolvers = new Map<string, (rows: CourseSearchResult[]) => void>();
    const fakeSearch: SearchAllFn = (query) =>
      new Promise((resolve) => {
        resolvers.set(query, resolve);
      });

    const delivered: CourseSearchResult[][] = [];
    const session = createCourseSearchSession(
      { onResults: (rows) => delivered.push(rows), onError: () => {}, onSettled: () => {} },
      fakeSearch
    );

    session.search("beth");
    // Simulates a keystroke landing before "beth" resolves — the live query
    // changes even though search() for "bethp" hasn't been called yet.
    session.noteQuery("bethp");

    resolvers.get("beth")!([row("Bethel Island")]);
    await Promise.resolve();
    await Promise.resolve();

    const names = delivered.flat().map((r) => r.name);
    expect(names).not.toContain("Bethel Island");
  });

  it("delivers results for the CURRENT query normally", async () => {
    const fakeSearch: SearchAllFn = (query) => Promise.resolve([row(`${query}-result`)]);

    const delivered: CourseSearchResult[][] = [];
    const session = createCourseSearchSession(
      { onResults: (rows) => delivered.push(rows), onError: () => {}, onSettled: () => {} },
      fakeSearch
    );

    session.search("bethpage");
    await Promise.resolve();
    await Promise.resolve();

    const names = delivered.flat().map((r) => r.name);
    expect(names).toContain("bethpage-result");
  });

  it("new query starts with a clean-slate onResults([]) call", () => {
    const fakeSearch: SearchAllFn = () => new Promise(() => {}); // never resolves

    const delivered: CourseSearchResult[][] = [];
    const session = createCourseSearchSession(
      { onResults: (rows) => delivered.push(rows), onError: () => {}, onSettled: () => {} },
      fakeSearch
    );

    session.search("bethpage");
    expect(delivered[0]).toEqual([]);
  });

  it("aborts the previous request's signal when a new search starts", () => {
    const signals: AbortSignal[] = [];
    const fakeSearch: SearchAllFn = (_q, opts) => {
      signals.push(opts.signal);
      return new Promise(() => {});
    };

    const session = createCourseSearchSession(
      { onResults: () => {}, onError: () => {}, onSettled: () => {} },
      fakeSearch
    );

    session.search("beth");
    session.search("bethpage");

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("calls onSettled only for the live query, not a superseded one", async () => {
    const resolvers = new Map<string, () => void>();
    const fakeSearch: SearchAllFn = (query) =>
      new Promise((resolve) => {
        resolvers.set(query, () => resolve([]));
      });

    const settledCalls: number[] = [];
    let call = 0;
    const session = createCourseSearchSession(
      {
        onResults: () => {},
        onError: () => {},
        onSettled: () => settledCalls.push(call++),
      },
      fakeSearch
    );

    session.search("beth");
    session.search("bethpage");

    resolvers.get("beth")!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settledCalls).toHaveLength(0); // superseded query never settles

    resolvers.get("bethpage")!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settledCalls).toHaveLength(1);
  });

  it("swallows AbortError without calling onError", async () => {
    const fakeSearch: SearchAllFn = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    };

    const onError = vi.fn();
    const session = createCourseSearchSession(
      { onResults: () => {}, onError, onSettled: () => {} },
      fakeSearch
    );

    session.search("bethpage");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a real (non-abort) failure via onError for the live query", async () => {
    const fakeSearch: SearchAllFn = () => Promise.reject(new Error("network down"));

    const onError = vi.fn();
    const session = createCourseSearchSession(
      { onResults: () => {}, onError, onSettled: () => {} },
      fakeSearch
    );

    session.search("bethpage");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
