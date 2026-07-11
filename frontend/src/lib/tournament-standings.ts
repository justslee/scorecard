// tournament-standings.ts — pure leaderboard math for the tournament page
// (specs/tournament-net-handicap-leaderboard-plan.md). Extracted from
// TournamentPageClient.tsx so vitest can import these helpers without
// pulling in framer-motion / the rest of the client component tree.
//
// Net handicap convention: reuses the SAME full-handicap-subtraction rule as
// games.ts chicago (`quotaBase - Math.round(handicap)`) — no new formula, no
// hole-by-hole stroke-index allocation (the app has none). Per-player
// handicap comes ONLY from `round.players[].handicap` (the manually-set
// course handicap copied onto each round's player record); we never use
// estimateHandicapFromRounds (owner-only, single-player WHS estimate).
//
// Honest missing-handicap rule (decided): a player with no handicap on any
// round-player record gets `totalNet = null` — NOT 0. Treating "no handicap"
// as scratch (0) would fabricate an advantage/disadvantage relative to
// players who do have one, so they're unranked in Net mode instead.

import { calculateTotals } from "@/lib/types";
import type { Round } from "@/lib/types";

export type LbMode = "gross" | "toPar" | "net";

export const PLAYER_COLORS = [
  "#1a2a1a", "#3a4a8a", "#6b3a1a", "#3a6a4a",
  "#6a3a3a", "#6a6a3a", "#3a6a6a", "#5a3a6a",
];

export type PlayerStanding = {
  playerId: string;
  name: string;
  initial: string;
  color: string;
  /** Total strokes per member round (null = player has no scores in that round). */
  roundTotals: (number | null)[];
  /** Score-to-par per member round (null = no scores). */
  roundToPar: (number | null)[];
  /** Per-round net (gross − rounded handicap); null if no score that round OR no handicap. */
  roundNet: (number | null)[];
  /** Sum of strokes across all rounds with scores (null if none). */
  totalStrokes: number | null;
  /** Sum of to-par across all rounds with scores (null if none). */
  totalToPar: number | null;
  /** Resolved rounded course handicap (null = player has no handicap on any round record). */
  handicap: number | null;
  /** totalStrokes − handicap × (#rounds with a score); null if no handicap or no scores. */
  totalNet: number | null;
};

export function playerInitial(name: string): string {
  return (name.trim().charAt(0) || "?").toUpperCase();
}

export function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return isoString.slice(0, 10);
  }
}

/**
 * Compute per-player standings across member rounds.
 *
 * Player name resolution priority:
 *  1. playerNamesById (from backend — reflects the players table)
 *  2. round.players (authoritative per-round copy; covers guests not in the players table)
 *  3. playerId as last resort
 *
 * Per-player handicap resolution: `playerHandicaps[pid]` (built by the caller
 * the same way as playerNames — first defined `handicap` found on a
 * round-player record for that id). Missing from the map = no handicap =
 * `handicap: null` for that player, and `totalNet`/`roundNet` are null too
 * (honest — never fabricated as 0).
 *
 * If tournament.playerIds is empty (pre-player-tracking data), union from round players.
 */
export function computeStandings(
  playerIds: string[],
  playerNames: Record<string, string>,
  playerHandicaps: Record<string, number>,
  rounds: Round[]
): PlayerStanding[] {
  return playerIds.map((pid, idx) => {
    const name = playerNames[pid] ?? pid;
    const rawHandicap = playerHandicaps[pid];
    // `== null` catches both a missing key AND an explicit null (the backend
    // serialises an unset handicap as null) — a missing handicap must stay
    // null ("no hcp"), never Math.round(null) === 0 (a fabricated scratch).
    const handicap =
      rawHandicap == null ? null : Math.round(rawHandicap);

    const roundTotals: (number | null)[] = [];
    const roundToPar: (number | null)[] = [];
    const roundNet: (number | null)[] = [];
    let totalStrokes = 0;
    let totalToPar = 0;
    let totalNetStrokes = 0;
    let roundsWithScore = 0;
    let hasSomeScore = false;

    for (const r of rounds) {
      const t = calculateTotals(r.scores, r.holes, pid);
      if (t.playedHoles > 0) {
        roundTotals.push(t.total);
        roundToPar.push(t.toPar);
        totalStrokes += t.total;
        totalToPar += t.toPar;
        hasSomeScore = true;
        roundsWithScore += 1;

        if (handicap === null) {
          roundNet.push(null);
        } else {
          const net = t.total - handicap;
          roundNet.push(net);
          totalNetStrokes += net;
        }
      } else {
        roundTotals.push(null);
        roundToPar.push(null);
        roundNet.push(null);
      }
    }

    const totalNet =
      handicap === null || !hasSomeScore
        ? null
        : totalStrokes - handicap * roundsWithScore;
    // totalNet equals the sum of per-round net values (totalNetStrokes) —
    // both derivations agree by construction; totalStrokes - handicap*n is
    // the plan's stated formula, kept as the source of truth here.
    void totalNetStrokes;

    return {
      playerId: pid,
      name,
      initial: playerInitial(name),
      color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
      roundTotals,
      roundToPar,
      roundNet,
      totalStrokes: hasSomeScore ? totalStrokes : null,
      totalToPar: hasSomeScore ? totalToPar : null,
      handicap,
      totalNet,
    };
  });
}

export function formatToPar(v: number | null): string {
  if (v === null) return "—";
  if (v > 0) return `+${v}`;
  if (v === 0) return "E";
  return `${v}`;
}

/**
 * Tie-aware rank label for position idx in a sorted standings list.
 *
 * Returns "T1"/"T2" when multiple players share the same total;
 * plain "1"/"2" when the position is unique; "—" when the player has no scores.
 */
export function tieRankLabel(
  sorted: PlayerStanding[],
  idx: number,
  mode: LbMode
): string {
  const s = sorted[idx];
  const myTotal =
    mode === "gross"
      ? s.totalStrokes
      : mode === "toPar"
      ? s.totalToPar
      : s.totalNet;
  if (myTotal === null) return "—";

  const valueFor = (other: PlayerStanding) =>
    mode === "gross"
      ? other.totalStrokes
      : mode === "toPar"
      ? other.totalToPar
      : other.totalNet;

  // Count players with a strictly better (lower) total
  const betterCount = sorted.filter((other) => {
    const ot = valueFor(other);
    return ot !== null && ot < myTotal;
  }).length;

  // Count players tied at the same total (including self)
  const sameCount = sorted.filter((other) => valueFor(other) === myTotal).length;

  const rank = betterCount + 1;
  return sameCount > 1 ? `T${rank}` : `${rank}`;
}

export function suffix(n: number): string {
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}

/**
 * True if any pair of players in `ids` has swapped relative order vs
 * `prevRank` — i.e. one player crossed another (an "overtake"), not just
 * a player entering/leaving the ranked set.
 */
export function hasCrossing(ids: string[], prevRank: Map<string, number>): boolean {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const aOld = prevRank.get(ids[i]);
      const bOld = prevRank.get(ids[j]);
      if (aOld !== undefined && bOld !== undefined && aOld > bOld) return true;
    }
  }
  return false;
}

/** Sort standings: nulls last, then ascending by the selected mode's total. */
export function sortStandings(
  standings: PlayerStanding[],
  mode: LbMode
): PlayerStanding[] {
  return [...standings].sort((a, b) => {
    const av =
      mode === "gross" ? a.totalStrokes : mode === "toPar" ? a.totalToPar : a.totalNet;
    const bv =
      mode === "gross" ? b.totalStrokes : mode === "toPar" ? b.totalToPar : b.totalNet;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv;
  });
}
