/**
 * Shot analytics helpers — per-club distance & dispersion.
 *
 * Thin API client + pure display helpers (sortable, formattable). All pure
 * helpers are exported and tested in shot-stats.test.ts. The fetch function
 * is the only impure piece (calls /api/shots/stats).
 *
 * Data source: GET /api/shots/stats (shots.py) — aggregates the user's logged
 * shots server-side; no migration needed, queries the existing shots table.
 */

import { fetchAPI } from './api';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Per-club aggregate returned by GET /api/shots/stats.
 * Mirrors the Python ClubStat Pydantic model in backend/app/routes/shots.py.
 */
export interface ClubStat {
  /** Club name as stored in the shots table (voice-parsed, e.g. "driver", "7 iron") */
  club: string;
  /** Number of shots with a valid distance for this club */
  n: number;
  /** Mean carry distance in yards, rounded to 1 decimal place */
  avg_distance: number;
  /** Median carry distance in yards, rounded to 1 decimal place */
  median_distance: number;
  /** 1-sigma distance spread in yards (null when n < 2) */
  stdev_distance: number | null;
  /** Most frequent end_lie for this club (null when no lie data) */
  most_common_lie: string | null;
}

// ── API client ────────────────────────────────────────────────────────────────

/**
 * Fetch per-club distance stats for the authenticated user.
 * Returns [] when the user has no logged shots with distance data.
 * Throws on network/auth errors (caller should catch and show empty state).
 */
export async function fetchShotStats(): Promise<ClubStat[]> {
  return fetchAPI<ClubStat[]>('/api/shots/stats');
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Sort ClubStat[] longest → shortest by avg_distance.
 * The server already sorts this way, but sort client-side too for safety
 * (defensive against future changes or mock data in tests).
 */
export function sortClubStats(stats: ClubStat[]): ClubStat[] {
  return [...stats].sort((a, b) => b.avg_distance - a.avg_distance);
}

/**
 * Dispersion indicator string for display.
 * Returns "±N yd" (stdev rounded to nearest yard) or "—" when unavailable.
 *
 * We show stdev (1-sigma) rather than range because it's robust to outliers
 * and matches how dispersion is described in strokes-gained analysis.
 */
export function dispersionLabel(stat: ClubStat): string {
  if (stat.stdev_distance === null || stat.n < 2) return '—';
  return `±${Math.round(stat.stdev_distance)} yd`;
}

/**
 * Title-case a club name for display (preserves existing casing patterns from
 * voice parsing; just uppercases the first letter if the string is all-lower).
 * Examples: "driver" → "Driver", "7 iron" → "7 iron" (no change), "pw" → "Pw".
 */
export function formatClubName(name: string): string {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
