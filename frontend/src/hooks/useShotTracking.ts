'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchShotsForRound,
  recordTrackedShot,
  deleteTrackedShot,
  type TrackedShot,
} from '@/lib/caddie/api';
import type { Position } from '@/lib/gps';

export type ShotTrackingPhase = 'idle' | 'awaiting_end' | 'saving';

export interface UseShotTrackingOptions {
  roundId: string;
  holeNumber: number;
  /** Optional Postgres hole_id for PostGIS lie detection. */
  holeId?: string | null;
  /** Function returning the player's current GPS position. */
  getPosition: () => Position | null;
}

export interface UseShotTrackingResult {
  phase: ShotTrackingPhase;
  shots: TrackedShot[];
  pendingStart: Position | null;
  error: string | null;
  /** Mark the player's current GPS position as the start of a shot. */
  markStart: () => void;
  /** Mark the player's current position as the end; saves the shot. */
  markEnd: (opts?: { club?: string; result?: string }) => Promise<TrackedShot | null>;
  /** Cancel an in-progress shot without saving. */
  cancel: () => void;
  /** Delete a previously saved shot. */
  remove: (shotId: number) => Promise<void>;
  /** Re-fetch shots for the current round. */
  refresh: () => Promise<void>;
}

export function useShotTracking(opts: UseShotTrackingOptions): UseShotTrackingResult {
  const { roundId, holeNumber, holeId, getPosition } = opts;
  const [phase, setPhase] = useState<ShotTrackingPhase>('idle');
  const [shots, setShots] = useState<TrackedShot[]>([]);
  const [pendingStart, setPendingStart] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchShotsForRound(roundId);
      if (!cancelledRef.current) setShots(list);
    } catch (e) {
      if (!cancelledRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to load shots');
      }
    }
  }, [roundId]);

  // Initial fetch on mount / round change. Uses .then() so the setState happens
  // after a real async tick (avoids the cascading-render lint rule).
  useEffect(() => {
    cancelledRef.current = false;
    fetchShotsForRound(roundId)
      .then(list => { if (!cancelledRef.current) setShots(list); })
      .catch(e => {
        if (!cancelledRef.current) {
          setError(e instanceof Error ? e.message : 'Failed to load shots');
        }
      });
    return () => { cancelledRef.current = true; };
  }, [roundId]);

  const markStart = useCallback(() => {
    setError(null);
    const pos = getPosition();
    if (!pos) {
      setError('No GPS fix yet — wait a moment and try again.');
      return;
    }
    setPendingStart(pos);
    setPhase('awaiting_end');
  }, [getPosition]);

  const cancel = useCallback(() => {
    setPendingStart(null);
    setPhase('idle');
    setError(null);
  }, []);

  const markEnd = useCallback(async (extra?: { club?: string; result?: string }) => {
    if (!pendingStart) {
      setError('No shot in progress.');
      return null;
    }
    const endPos = getPosition();
    if (!endPos) {
      setError('No GPS fix for the end of the shot.');
      return null;
    }
    setPhase('saving');
    setError(null);
    try {
      const created = await recordTrackedShot({
        round_id: roundId,
        hole_number: holeNumber,
        hole_id: holeId ?? undefined,
        start_lat: pendingStart.lat,
        start_lng: pendingStart.lng,
        end_lat: endPos.lat,
        end_lng: endPos.lng,
        club: extra?.club,
        result: extra?.result,
      });
      setShots(prev => [...prev, created]);
      setPendingStart(null);
      setPhase('idle');
      return created;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save shot');
      setPhase('awaiting_end');
      return null;
    }
  }, [pendingStart, getPosition, roundId, holeNumber, holeId]);

  const remove = useCallback(async (shotId: number) => {
    try {
      await deleteTrackedShot(shotId);
      setShots(prev => prev.filter(s => s.id !== shotId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete shot');
    }
  }, []);

  return { phase, shots, pendingStart, error, markStart, markEnd, cancel, remove, refresh };
}
