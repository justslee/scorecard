"use client";

import { useEffect, useRef } from "react";
import {
  registerCaddieContext,
  type CaddiePageContext,
  type CaddieTaskContext,
  type CaddieConverseContext,
  type CaddieSurfaceContext,
} from "@/lib/caddie-context";

/**
 * Register this page's caddie context for as long as the calling component is
 * mounted. Mount → register (last-writer-wins), unmount → unregister.
 * The ctx object may be rebuilt every render — a stable wrapper is registered
 * once and delegates through a ref, so the registry never sees render thrash.
 */
export function useCaddiePageContext(ctx: CaddiePageContext): void {
  const ref = useRef(ctx);
  // Mirror the latest ctx into the ref in an effect (never during render —
  // matches this codebase's other ref-mirror hooks, e.g. CaddieOrbSheet's
  // turnsRef/dictationRef, useSheetTTS's onPlaybackEndRef). No dep array:
  // ctx is rebuilt every render by design, so this runs every commit.
  useEffect(() => {
    ref.current = ctx;
  });
  const { id, kind } = ctx; // fixed for a mounted page component
  useEffect(() => {
    return registerCaddieContext(makeDelegate(kind, () => ref.current));
    // id/kind can't change without the page component remounting; if they
    // somehow do, re-register cleanly.
  }, [id, kind]);
}

function makeDelegate(
  kind: CaddiePageContext["kind"],
  get: () => CaddiePageContext,
): CaddiePageContext {
  if (kind === "task") {
    const t = () => get() as CaddieTaskContext;
    return {
      id: t().id,
      kind: "task",
      get copy() { return t().copy; },
      getKeyterms: () => t().getKeyterms?.() ?? [],
      parse: (transcript) => t().parse(transcript),
      apply: (p) => t().apply(p),
    };
  }
  if (kind === "surface") {
    const s = () => get() as CaddieSurfaceContext;
    return { id: s().id, kind: "surface", summon: (l) => s().summon(l) };
  }
  const c = () => get() as CaddieConverseContext;
  return {
    id: c().id,
    kind: "converse",
    get copy() { return c().copy; },
    getGrounding: () => c().getGrounding(),
  };
}
