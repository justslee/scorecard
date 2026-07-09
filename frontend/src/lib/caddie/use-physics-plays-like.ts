"use client";

/**
 * usePhysicsPlaysLike — fetches the backend physics engine's plays-like
 * number for the round page's PLAYS tile (specs/physics-tiles-coherence-plan.md
 * §4.1), so the tile shows the SAME number the caddie cites instead of the
 * deprecated frontend wind heuristic (lib/map/wind.ts `playsLikeYards`).
 *
 * - Cache: a `{ [hole:basis:weatherFetchedAt]: response | null }` component
 *   state record — hole revisits and re-renders are free; a weather refresh
 *   (which re-caches into the session server-side, so the server number
 *   actually changes) naturally invalidates via the key. A separate `Set`
 *   ref (read only inside the effect, never during render) tracks which
 *   keys have already been dispatched so a key that resolves late for an
 *   old key can never overwrite — or get overwritten by — a different key's
 *   entry; the stale-guard falls out of the keyed-cache shape for free (an
 *   in-flight response for key A only ever writes `cache[A]`; the render
 *   always reads `cache[currentKey]`).
 * - Debounce: 400ms trailing debounce on key change, plus a 2s min-interval
 *   floor so a fast walk (live-GPS basis changing every render) emits ≤1
 *   request per 2s.
 * - Failure: any error / 404 (no session yet) → cache `null` for the key; no
 *   retry loop — only the next key change (a genuinely new key) retries.
 */

import { useEffect, useRef, useState } from "react";
import { getSessionShotDistance, type SessionShotDistance } from "@/lib/caddie/api";

const DEBOUNCE_MS = 400;
const MIN_INTERVAL_MS = 2000;

export interface UsePhysicsPlaysLikeParams {
  roundId: string;
  /** caddieSessionActive && !isLocalRound — the route 404s without an owned
   *  session, so there's nothing to fetch until this is true. */
  enabled: boolean;
  currentHole: number;
  /** The RAW selected-tee (or live/card) basis yardage — NEVER
   *  holeIntel.effectiveYards (double-counts elevation; see plan §4.2). */
  basisYards: number | null;
  weatherFetchedAt: number | null;
}

/** null while no physics response has landed for the current key (pending,
 *  disabled, or a cached failure) — the caller renders the honest fallback
 *  (plays-tile.ts) and quietly re-renders once a response arrives. */
export function usePhysicsPlaysLike({
  roundId,
  enabled,
  currentHole,
  basisYards,
  weatherFetchedAt,
}: UsePhysicsPlaysLikeParams): SessionShotDistance | null {
  const [cache, setCache] = useState<Record<string, SessionShotDistance | null>>({});
  const seenRef = useRef(new Set<string>());
  const lastFetchStartRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const basis = enabled && basisYards != null && Number.isFinite(basisYards)
    ? Math.round(basisYards)
    : null;
  const key = basis != null ? `${currentHole}:${basis}:${weatherFetchedAt ?? 0}` : null;

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!key || basis == null || seenRef.current.has(key)) return;

    const run = () => {
      seenRef.current.add(key);
      lastFetchStartRef.current = Date.now();
      getSessionShotDistance({ round_id: roundId, hole_number: currentHole, target_yards: basis })
        .then((res) => {
          setCache((prev) => ({ ...prev, [key]: res }));
        })
        .catch(() => {
          setCache((prev) => ({ ...prev, [key]: null }));
        });
    };

    const sinceLastFetch = Date.now() - lastFetchStartRef.current;
    const floorDelay = Math.max(0, MIN_INTERVAL_MS - sinceLastFetch);
    const delay = Math.max(DEBOUNCE_MS, floorDelay);
    timerRef.current = setTimeout(run, delay);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [key, basis, roundId, currentHole]);

  if (key && key in cache) return cache[key];
  return null;
}
