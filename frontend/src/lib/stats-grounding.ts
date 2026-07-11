/**
 * Pure serializer: turns the golfer's REAL computed stats (rounds + club
 * data) into a compact plain-text grounding block for the caddie's
 * off-course "My Card" converse lane
 * (specs/orb-s4-mycard-coaching-plan.md).
 *
 * Reuses the SAME derivations the profile page already renders — never
 * recomputes them divergently (`estimateHandicapFromRounds`, `deriveTrend`,
 * `deriveParTypeAverages`, `deriveScoreDistribution`, `derivePersonalBests`).
 *
 * NEVER fabricates coaching sentences ("you should work on X") — this module
 * only serializes numbers the derivations already computed, and every stat
 * carries its own sample size, so the caddie can cite real data and is
 * honest about what it doesn't have. Composes defensively: every derivation
 * may legitimately return null/empty on thin data.
 *
 * No I/O, no React — fully unit-testable (stats-grounding.test.ts).
 */

import { estimateHandicapFromRounds } from "@/lib/handicap";
import {
  deriveTrend,
  deriveParTypeAverages,
  deriveScoreDistribution,
} from "@/lib/profile-stats";
import { derivePersonalBests } from "@/lib/personal-bests";
import { sortClubStats, formatClubName } from "@/lib/shot-stats";
import type { ClubStat } from "@/lib/shot-stats";
import type { Round, GolferProfile } from "@/lib/types";

// ── Formatting helpers ──────────────────────────────────────────────────────

/** "+0.6" / "-1" / "E" (even) — matches the yardage-book to-par convention
 *  used elsewhere in the app (e.g. RoundRecap's formatToPar). */
function fmtToPar(n: number): string {
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtPct(n: number): string {
  return `${Math.round(n)}%`;
}

function clubLine(c: ClubStat): string {
  const dispersion =
    c.stdev_distance !== null && c.n >= 2 ? `, ±${Math.round(c.stdev_distance)}y` : "";
  return `${formatClubName(c.club)}: ${c.avg_distance}y avg (n=${c.n}, median ${c.median_distance}${dispersion})`;
}

function thinSentinel(validRoundCount: number): string {
  const roundsPhrase =
    validRoundCount === 0 ? "none logged yet" : `only ${validRoundCount} logged`;
  return `Not enough rounds on your card yet to say much — ${roundsPhrase}. I can talk clubs if you've logged shots.`;
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Build the stats grounding block for the My Card converse context.
 *
 * - <2 valid completed rounds → an honest "thin" sentinel (still includes
 *   club lines when `clubStats` is non-empty).
 * - 0 valid rounds AND 0 clubStats → null (nothing real to ground on; the
 *   converse lane omits stats_context and the caddie answers generally).
 * - Otherwise → a multi-line block, one stat per line, each carrying its
 *   sample size.
 */
export function buildStatsGroundingBlock(
  rounds: Round[],
  clubStats: ClubStat[],
  profile: GolferProfile | null,
): string | null {
  const validRounds = rounds.filter((r) => r.status === "completed" && r.players.length > 0);
  const clubLines = sortClubStats(clubStats).map(clubLine);

  if (validRounds.length === 0 && clubStats.length === 0) return null;

  if (validRounds.length < 2) {
    return [thinSentinel(validRounds.length), ...clubLines].join("\n");
  }

  const lines: string[] = [];

  // ── Handicap: set beats estimated; estimated notes rounds used ──────────
  if (profile?.handicap != null) {
    lines.push(`Handicap: ${profile.handicap} (set)`);
  } else {
    const est = estimateHandicapFromRounds(rounds);
    if (est) {
      lines.push(`Handicap: ${est.index} (estimated from ${est.roundsUsed} rounds)`);
    }
  }

  // ── Recent trend ──────────────────────────────────────────────────────
  const trend = deriveTrend(rounds);
  if (trend) {
    const direction = trend.delta < 0 ? "improving" : trend.delta > 0 ? "worsening" : "flat";
    lines.push(
      `Recent trend: last ${trend.recentCount} rounds avg ${fmtToPar(trend.recentAvgToPar)} ` +
        `vs prior ${trend.priorCount} rounds avg ${fmtToPar(trend.priorAvgToPar)} — ${direction}`,
    );
  }

  // ── Par-type averages ─────────────────────────────────────────────────
  const parRows = deriveParTypeAverages(rounds);
  if (parRows.length > 0) {
    const parts = parRows.map(
      (r) => `Par-${r.par} ${fmtToPar(r.avgToPar)} over ${r.holeCount} holes`,
    );
    lines.push(`Par-type scoring: ${parts.join(" / ")}`);
  }

  // ── Score distribution ───────────────────────────────────────────────
  const distRows = deriveScoreDistribution(rounds);
  if (distRows.length > 0) {
    const totalHoles = distRows.reduce((s, r) => s + r.count, 0);
    const parts = distRows.map((r) => `${fmtPct(r.pct)} ${r.label.toLowerCase()}`);
    lines.push(`Scoring mix: ${parts.join(", ")} (over ${totalHoles} holes)`);
  }

  // ── Career best round ─────────────────────────────────────────────────
  const bests = derivePersonalBests(rounds);
  if (bests.bestRound) {
    lines.push(`Best round: ${fmtToPar(bests.bestRound.toPar)} at ${bests.bestRound.courseName}`);
  }

  // ── Clubs (independent of round data) ────────────────────────────────
  lines.push(...clubLines);

  return lines.join("\n");
}
