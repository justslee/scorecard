"use client";

import { useState, useEffect } from "react";
import { roundHref } from "@/lib/round-url";
import { useRouter, useParams } from "next/navigation";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import { getTournamentAsync, getRoundsAsync } from "@/lib/storage-api";
import { calculateTotals } from "@/lib/types";
import type { Tournament, Round, Game } from "@/lib/types";

type Tab = "leaderboard" | "rounds" | "games";
type LbMode = "gross" | "toPar";

// Yardage-book palette — warm ink tones, same as RoundPageClient
const PLAYER_COLORS = [
  "#1a2a1a", "#3a4a8a", "#6b3a1a", "#3a6a4a",
  "#6a3a3a", "#6a6a3a", "#3a6a6a", "#5a3a6a",
];

// ── Leaderboard column layout (px) ─────────────────────────────────────────
// Chosen so that 3 rounds fit without horizontal scrolling on a 390px iPhone
// (390px viewport - 44px container padding = 346px content →
//  28+146+40×3+52 = 346). For 4+ rounds the table scrolls; rank and player
// columns stay sticky via position:sticky so names remain readable at any N.
const LB_RANK_W = 28;   // accommodates "T10" at serif 13px
const LB_PLAYER_W = 146; // 28px avatar + 6px gap + ~112px name text (ellipsis)
const LB_ROUND_W = 40;  // per-round column
const LB_TOTAL_W = 52;  // total column (sticky-right)
const LB_HEADER_H = 34; // fixed header row height
const LB_ROW_H = 52;    // fixed data row height — keeps both panels in sync

// ── Game format display labels ──────────────────────────────────────────────
const FORMAT_LABELS: Record<string, string> = {
  skins: "Skins",
  nassau: "Nassau",
  bestBall: "Best Ball",
  scramble: "Scramble",
  wolf: "Wolf",
  threePoint: "Three Point",
  stableford: "Stableford",
  modifiedStableford: "Modified Stableford",
  matchPlay: "Match Play",
  bingoBangoBongo: "Bingo Bango Bongo",
  vegas: "Vegas",
  hammer: "Hammer",
  rabbit: "Rabbit",
  trash: "Trash",
  chicago: "Chicago",
  defender: "Defender",
};

// ── Player standing shape ───────────────────────────────────────────────────
type PlayerStanding = {
  playerId: string;
  name: string;
  initial: string;
  color: string;
  /** Total strokes per member round (null = player has no scores in that round). */
  roundTotals: (number | null)[];
  /** Score-to-par per member round (null = no scores). */
  roundToPar: (number | null)[];
  /** Sum of strokes across all rounds with scores (null if none). */
  totalStrokes: number | null;
  /** Sum of to-par across all rounds with scores (null if none). */
  totalToPar: number | null;
};

// ── Pure helpers ────────────────────────────────────────────────────────────

function playerInitial(name: string): string {
  return (name.trim().charAt(0) || "?").toUpperCase();
}

function formatDate(isoString: string): string {
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
 * If tournament.playerIds is empty (pre-player-tracking data), union from round players.
 */
function computeStandings(
  playerIds: string[],
  playerNames: Record<string, string>,
  rounds: Round[]
): PlayerStanding[] {
  return playerIds.map((pid, idx) => {
    const name = playerNames[pid] ?? pid;
    const roundTotals: (number | null)[] = [];
    const roundToPar: (number | null)[] = [];
    let totalStrokes = 0;
    let totalToPar = 0;
    let hasSomeScore = false;

    for (const r of rounds) {
      const t = calculateTotals(r.scores, r.holes, pid);
      if (t.playedHoles > 0) {
        roundTotals.push(t.total);
        roundToPar.push(t.toPar);
        totalStrokes += t.total;
        totalToPar += t.toPar;
        hasSomeScore = true;
      } else {
        roundTotals.push(null);
        roundToPar.push(null);
      }
    }

    return {
      playerId: pid,
      name,
      initial: playerInitial(name),
      color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
      roundTotals,
      roundToPar,
      totalStrokes: hasSomeScore ? totalStrokes : null,
      totalToPar: hasSomeScore ? totalToPar : null,
    };
  });
}

function formatToPar(v: number | null): string {
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
function tieRankLabel(
  sorted: PlayerStanding[],
  idx: number,
  mode: LbMode
): string {
  const s = sorted[idx];
  const myTotal = mode === "gross" ? s.totalStrokes : s.totalToPar;
  if (myTotal === null) return "—";

  // Count players with a strictly better (lower) total
  const betterCount = sorted.filter((other) => {
    const ot = mode === "gross" ? other.totalStrokes : other.totalToPar;
    return ot !== null && ot < myTotal;
  }).length;

  // Count players tied at the same total (including self)
  const sameCount = sorted.filter((other) => {
    const ot = mode === "gross" ? other.totalStrokes : other.totalToPar;
    return ot === myTotal;
  }).length;

  const rank = betterCount + 1;
  return sameCount > 1 ? `T${rank}` : `${rank}`;
}

function suffix(n: number): string {
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function TournamentPageClient() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const accent = DEFAULT_ACCENT;

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [memberRounds, setMemberRounds] = useState<Round[]>([]);
  const [standings, setStandings] = useState<PlayerStanding[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>("leaderboard");
  const [lbMode, setLbMode] = useState<LbMode>("gross");

  useEffect(() => {
    // Skip the static prerender placeholder — real id arrives on the client
    if (!id || id === "placeholder") return;

    async function load() {
      setLoading(true);
      try {
        const t = await getTournamentAsync(id);
        if (!t) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        setTournament(t);

        if (t.roundIds.length > 0) {
          // One GET /api/rounds then filter — avoids N round fetches.
          const allRounds = await getRoundsAsync();
          const roundIdSet = new Set(t.roundIds);
          // Belt-and-suspenders: also accept rounds whose tournamentId matches.
          const members = allRounds
            .filter((r) => roundIdSet.has(r.id) || r.tournamentId === id)
            .sort(
              (a, b) =>
                new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime()
            );
          setMemberRounds(members);

          // Resolve names: backend playerNamesById first, round players as fallback.
          const namesFromRounds: Record<string, string> = {};
          for (const r of members) {
            for (const p of r.players) {
              if (!namesFromRounds[p.id]) namesFromRounds[p.id] = p.name;
            }
          }
          const resolvedNames: Record<string, string> = {
            ...namesFromRounds,
            ...(t.playerNamesById ?? {}),
          };

          // If tournament has no explicit playerIds, union from member rounds.
          const effectivePlayerIds =
            t.playerIds.length > 0
              ? t.playerIds
              : Array.from(
                  new Set(members.flatMap((r) => r.players.map((p) => p.id)))
                );

          setStandings(
            computeStandings(effectivePlayerIds, resolvedNames, members)
          );
        }
      } catch (e) {
        console.error("[TournamentPageClient] load failed:", e);
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [id]);

  // ── Not found ─────────────────────────────────────────────────────────────
  if (!loading && notFound) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          fontFamily: T.sans,
          color: T.ink,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
        }}
      >
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 22,
            color: T.pencil,
            textAlign: "center",
          }}
        >
          Tournament not found.
        </div>
        <button
          onClick={() => router.push("/")}
          style={{
            marginTop: 20,
            background: "transparent",
            border: "none",
            padding: "10px 0",
            cursor: "pointer",
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.4,
            color: T.pencil,
            textTransform: "uppercase",
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span style={{ fontSize: 11 }}>←</span> Home
        </button>
      </div>
    );
  }

  // ── Loading skeleton ───────────────────────────────────────────────────────
  // Fix #3: calm pulsing masthead skeleton so an LTE fetch doesn't look like a crash.
  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          fontFamily: T.sans,
          color: T.ink,
        }}
      >
        {/* Pulse keyframe — scoped to this component render, no external dep */}
        <style>{`
          @keyframes lb-skel-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.45; }
          }
          .lb-skel { animation: lb-skel-pulse 1.5s ease-in-out infinite; }
        `}</style>
        <div style={{ maxWidth: 420, margin: "0 auto" }}>
          <div
            style={{
              padding: "max(14px, env(safe-area-inset-top)) 22px 20px",
            }}
          >
            <div
              className="lb-skel"
              style={{
                width: 56,
                height: 10,
                background: T.paperDeep,
                borderRadius: 4,
                marginBottom: 22,
              }}
            />
            <div
              className="lb-skel"
              style={{
                width: 110,
                height: 9,
                background: T.paperDeep,
                borderRadius: 3,
                marginBottom: 10,
              }}
            />
            <div
              className="lb-skel"
              style={{
                width: 220,
                height: 34,
                background: T.paperDeep,
                borderRadius: 6,
                marginBottom: 20,
              }}
            />
            <div style={{ display: "flex", gap: 18 }}>
              {[70, 56, 56].map((w, i) => (
                <div
                  key={i}
                  className="lb-skel"
                  style={{
                    width: w,
                    height: 38,
                    background: T.paperDeep,
                    borderRadius: 4,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!tournament) return null;

  const hasRounds = memberRounds.length > 0;
  const hasScores = standings.some((s) => s.totalStrokes !== null);
  const tournamentGames: Game[] = tournament.games ?? [];
  const hasGames = tournamentGames.length > 0;

  // Sort standings: nulls last, then ascending by selected mode
  const sortedStandings = [...standings].sort((a, b) => {
    if (lbMode === "gross") {
      if (a.totalStrokes === null && b.totalStrokes === null) return 0;
      if (a.totalStrokes === null) return 1;
      if (b.totalStrokes === null) return -1;
      return a.totalStrokes - b.totalStrokes;
    }
    if (a.totalToPar === null && b.totalToPar === null) return 0;
    if (a.totalToPar === null) return 1;
    if (b.totalToPar === null) return -1;
    return a.totalToPar - b.totalToPar;
  });

  const leader = sortedStandings[0] ?? null;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        fontFamily: T.sans,
        color: T.ink,
      }}
    >
      <div style={{ maxWidth: 420, margin: "0 auto", position: "relative" }}>
        {/* ── Masthead ──────────────────────────────────────────────────── */}
        <div
          style={{
            position: "relative",
            padding: "max(14px, env(safe-area-inset-top)) 22px 20px",
            overflow: "hidden",
          }}
        >
          <button
            onClick={() => router.push("/")}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.4,
              color: T.pencil,
              textTransform: "uppercase",
              display: "flex",
              alignItems: "center",
              gap: 4,
              marginBottom: 10,
              minHeight: 44,
              position: "relative",
              zIndex: 2,
            }}
          >
            <span style={{ fontSize: 11 }}>←</span> Home
          </button>

          <div style={{ position: "relative" }}>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
              }}
            >
              {formatDate(tournament.createdAt).toUpperCase()}
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 36,
                letterSpacing: -0.8,
                color: T.ink,
                lineHeight: 1,
                marginTop: 6,
              }}
            >
              {tournament.name}
            </div>

            <div style={{ display: "flex", gap: 18, marginTop: 18 }}>
              <Meta
                k="Rounds"
                v={`${memberRounds.length}${tournament.numRounds ? `/${tournament.numRounds}` : ""}`}
                sub={hasRounds ? "played" : "planned"}
              />
              <Meta
                k="Field"
                v={standings.length || tournament.playerIds.length}
                sub="players"
              />
              {hasGames && (
                <Meta k="Games" v={tournamentGames.length} sub="active" />
              )}
            </div>
          </div>
        </div>

        {/* ── Round progress strip ───────────────────────────────────────── */}
        {hasRounds && (
          <div style={{ padding: "0 22px 14px" }}>
            <div style={{ display: "flex", gap: 6 }}>
              {memberRounds.map((r, i) => {
                const done = r.status === "completed";
                const live = r.status === "active";
                return (
                  <button
                    key={r.id}
                    onClick={() => router.push(roundHref(r.id))}
                    style={{
                      flex: 1,
                      borderRadius: 12,
                      padding: "10px 12px",
                      border: `1px solid ${live ? accent : T.hairline}`,
                      background: live
                        ? `${accent}0d`
                        : done
                        ? T.paperDeep
                        : "transparent",
                      position: "relative",
                      overflow: "hidden",
                      textAlign: "left",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      minHeight: 44,
                    }}
                  >
                    {done && (
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          right: 0,
                          height: 3,
                          background: T.ink,
                        }}
                      />
                    )}
                    {live && (
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          right: 0,
                          height: 3,
                          background: accent,
                        }}
                      />
                    )}
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 8.5,
                        letterSpacing: 1.3,
                        color: T.pencil,
                        textTransform: "uppercase",
                        marginBottom: 2,
                      }}
                    >
                      Day {i + 1}
                      {live ? " · live" : done ? " · final" : ""}
                    </div>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontSize: 14,
                        letterSpacing: -0.2,
                        color: T.ink,
                        lineHeight: 1.1,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {/* Fix #6: course name fallback for upcoming/unset rounds */}
                      {r.courseName || "Course TBD"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Leader callout (when scores exist) ────────────────────────── */}
        {/* Fix #7: T.paperFaint / T.paperMid replace raw rgba strings */}
        {hasScores && leader && leader.totalStrokes !== null && (
          <div
            style={{
              margin: "0 22px 14px",
              padding: "14px 16px",
              borderRadius: 16,
              background: T.ink,
              color: T.paper,
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 99,
                background: leader.color,
                border: `1.5px solid ${T.paperFaint}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 18,
                color: T.paper,
                flexShrink: 0,
              }}
            >
              {leader.initial}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.4,
                  color: T.paperMid,
                  textTransform: "uppercase",
                }}
              >
                Leading
              </div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 16,
                  letterSpacing: -0.2,
                  lineHeight: 1.3,
                  color: T.paper,
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {leader.name}
              </div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.paperMid,
                }}
              >
                {lbMode === "gross" ? "STROKES" : "TO PAR"}
              </div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 24,
                  color: T.paper,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {lbMode === "gross"
                  ? leader.totalStrokes
                  : formatToPar(leader.totalToPar)}
              </div>
            </div>
          </div>
        )}

        {/* ── Tab bar ───────────────────────────────────────────────────── */}
        <div
          style={{
            padding: "0 22px",
            display: "flex",
            gap: 4,
            marginBottom: 10,
          }}
        >
          {(["leaderboard", "rounds", "games"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: "12px 10px",
                borderRadius: 10,
                cursor: "pointer",
                border: `1px solid ${tab === t ? T.ink : T.hairline}`,
                background: tab === t ? T.ink : "transparent",
                color: tab === t ? T.paper : T.pencil,
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.3,
                textTransform: "uppercase",
                minHeight: 44,
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* ── Leaderboard tab ───────────────────────────────────────────── */}
        {tab === "leaderboard" && (
          <div style={{ padding: "0 22px 40px" }}>
            {/* Fix #2: mode toggle minHeight 44 (was 32) */}
            <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
              {(
                [
                  { k: "gross" as LbMode, l: "Gross" },
                  { k: "toPar" as LbMode, l: "To Par" },
                ] as { k: LbMode; l: string }[]
              ).map((m) => (
                <button
                  key={m.k}
                  onClick={() => setLbMode(m.k)}
                  style={{
                    padding: "4px 12px",
                    borderRadius: 99,
                    border: `1px solid ${lbMode === m.k ? accent : T.hairline}`,
                    background:
                      lbMode === m.k ? `${accent}0d` : "transparent",
                    color: lbMode === m.k ? accent : T.pencil,
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.2,
                    textTransform: "uppercase",
                    cursor: "pointer",
                    minHeight: 44,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  {m.l}
                </button>
              ))}
            </div>

            {standings.length === 0 ? (
              <EmptyState text="No players in this tournament yet." />
            ) : !hasRounds || !hasScores ? (
              <EmptyState
                text={
                  hasRounds
                    ? "Scores will appear here as you play."
                    : "No rounds played yet."
                }
              />
            ) : (
              // Fix #1: scrollable leaderboard.
              //
              // The outer div is overflow-x:auto — the scroll container.
              // Each row (header + body) is a flex container.
              // Rank (left:0) and Player (left:LB_RANK_W) cells use
              // position:sticky so they stay pinned as round columns scroll.
              // Total uses sticky right:0 for the same reason.
              // Fixed LB_HEADER_H / LB_ROW_H guarantee pixel-perfect alignment.
              // At 3 rounds on a 390px device: 28+146+40×3+52 = 346px = no scroll.
              // At 4+ rounds: table overflows and scrolls; names stay visible.
              <div
                style={{
                  overflowX: "auto",
                  WebkitOverflowScrolling: "touch",
                }}
              >
                {/* Column header */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    height: LB_HEADER_H,
                    borderBottom: `1px solid ${T.hairline}`,
                    fontFamily: T.mono,
                    fontSize: 8.5,
                    letterSpacing: 1.3,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                    minWidth:
                      LB_RANK_W +
                      LB_PLAYER_W +
                      memberRounds.length * LB_ROUND_W +
                      LB_TOTAL_W,
                  }}
                >
                  <div
                    style={{
                      width: LB_RANK_W,
                      flexShrink: 0,
                      position: "sticky",
                      left: 0,
                      zIndex: 2,
                      background: T.paper,
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    #
                  </div>
                  <div
                    style={{
                      width: LB_PLAYER_W,
                      flexShrink: 0,
                      position: "sticky",
                      left: LB_RANK_W,
                      zIndex: 2,
                      background: T.paper,
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    Player
                  </div>
                  {memberRounds.map((_, i) => (
                    <div
                      key={i}
                      style={{
                        width: LB_ROUND_W,
                        flexShrink: 0,
                        textAlign: "right",
                      }}
                    >
                      R{i + 1}
                    </div>
                  ))}
                  <div
                    style={{
                      width: LB_TOTAL_W,
                      flexShrink: 0,
                      textAlign: "right",
                      position: "sticky",
                      right: 0,
                      zIndex: 2,
                      background: T.paper,
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-end",
                    }}
                  >
                    Total
                  </div>
                </div>

                {/* Body rows */}
                {sortedStandings.map((s, idx) => {
                  const perRound =
                    lbMode === "gross" ? s.roundTotals : s.roundToPar;
                  const total =
                    lbMode === "gross" ? s.totalStrokes : s.totalToPar;
                  const ranked = s.totalStrokes !== null;
                  // Fix #5: tie-aware rank label ("T1"/"T2" for ties)
                  const rankLabel = tieRankLabel(sortedStandings, idx, lbMode);

                  return (
                    <div
                      key={s.playerId}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        height: LB_ROW_H,
                        borderBottom: `1px dashed ${T.hairline}`,
                        minWidth:
                          LB_RANK_W +
                          LB_PLAYER_W +
                          memberRounds.length * LB_ROUND_W +
                          LB_TOTAL_W,
                      }}
                    >
                      {/* Rank — sticky left-0 */}
                      <div
                        style={{
                          width: LB_RANK_W,
                          flexShrink: 0,
                          position: "sticky",
                          left: 0,
                          zIndex: 1,
                          background: T.paper,
                          height: "100%",
                          display: "flex",
                          alignItems: "center",
                          fontFamily: T.serif,
                          fontSize: 13,
                          color: idx < 3 && ranked ? T.ink : T.pencil,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {rankLabel}
                      </div>

                      {/* Player — sticky left-LB_RANK_W */}
                      <div
                        style={{
                          width: LB_PLAYER_W,
                          flexShrink: 0,
                          position: "sticky",
                          left: LB_RANK_W,
                          zIndex: 1,
                          background: T.paper,
                          height: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          paddingRight: 4,
                        }}
                      >
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 99,
                            background: s.color,
                            color: T.paper,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontFamily: T.serif,
                            fontStyle: "italic",
                            fontSize: 12,
                            flexShrink: 0,
                          }}
                        >
                          {s.initial}
                        </div>
                        <div
                          style={{
                            fontFamily: T.sans,
                            fontSize: 13,
                            fontWeight: 500,
                            color: T.ink,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {s.name}
                        </div>
                      </div>

                      {/* Per-round scores */}
                      {perRound.map((v, ri) => (
                        <div
                          key={ri}
                          style={{
                            width: LB_ROUND_W,
                            flexShrink: 0,
                            textAlign: "right",
                            fontFamily: T.serif,
                            fontSize: 15,
                            color: v !== null ? T.ink : T.pencilSoft,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {v === null
                            ? "—"
                            : lbMode === "toPar"
                            ? formatToPar(v)
                            : v}
                        </div>
                      ))}

                      {/* Total — sticky right-0 */}
                      <div
                        style={{
                          width: LB_TOTAL_W,
                          flexShrink: 0,
                          textAlign: "right",
                          position: "sticky",
                          right: 0,
                          zIndex: 1,
                          background: T.paper,
                          height: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "flex-end",
                          fontFamily: T.serif,
                          fontSize: 22,
                          letterSpacing: -0.3,
                          lineHeight: 1,
                          color: idx === 0 && ranked ? accent : T.ink,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {total === null
                          ? "—"
                          : lbMode === "toPar"
                          ? formatToPar(total)
                          : total}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Rounds tab ───────────────────────────────────────────────── */}
        {tab === "rounds" && (
          <div style={{ padding: "0 22px 40px" }}>
            {!hasRounds ? (
              <EmptyState text="No rounds played yet." />
            ) : (
              memberRounds.map((r, i) => {
                const done = r.status === "completed";
                const live = r.status === "active";

                // Top 3 scorers in this round by gross strokes
                const roundSorted = [...standings]
                  .filter((s) => s.roundTotals[i] !== null)
                  .sort((a, b) => {
                    const av = a.roundTotals[i] ?? Infinity;
                    const bv = b.roundTotals[i] ?? Infinity;
                    return av - bv;
                  })
                  .slice(0, 3);

                return (
                  <div
                    key={r.id}
                    style={{
                      padding: "16px 16px",
                      borderRadius: 16,
                      border: `1px solid ${live ? accent : T.hairline}`,
                      background: live ? `${accent}08` : T.paper,
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        justifyContent: "space-between",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                        <div
                          style={{
                            fontFamily: T.mono,
                            fontSize: 9,
                            letterSpacing: 1.3,
                            color: T.pencil,
                            textTransform: "uppercase",
                          }}
                        >
                          Day {i + 1} ·{" "}
                          {done ? "Final" : live ? "In progress" : "Upcoming"}
                        </div>
                        <div
                          style={{
                            fontFamily: T.serif,
                            fontStyle: "italic",
                            fontSize: 22,
                            letterSpacing: -0.3,
                            color: T.ink,
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {/* Fix #6: course name fallback */}
                          {r.courseName || "Course TBD"}
                        </div>
                      </div>
                      {live && (
                        <div
                          style={{
                            fontFamily: T.mono,
                            fontSize: 9,
                            letterSpacing: 1.3,
                            color: accent,
                            textTransform: "uppercase",
                            flexShrink: 0,
                          }}
                        >
                          Live
                        </div>
                      )}
                    </div>

                    {/* Groups — shown for upcoming / live rounds */}
                    {r.groups && r.groups.length > 0 && !done && (
                      <div
                        style={{
                          marginTop: 12,
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        {r.groups.map((g) => {
                          const groupPlayers = g.playerIds.map((pid) => {
                            const st = standings.find(
                              (st) => st.playerId === pid
                            );
                            if (st)
                              return {
                                name: st.name,
                                initial: st.initial,
                                color: st.color,
                              };
                            const fallback =
                              tournament.playerNamesById?.[pid] ?? pid;
                            return {
                              name: fallback,
                              initial: playerInitial(fallback),
                              color: T.pencil,
                            };
                          });
                          return (
                            <div
                              key={g.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              {g.teeTime && (
                                <div
                                  style={{
                                    fontFamily: T.mono,
                                    fontSize: 9,
                                    letterSpacing: 1.2,
                                    color: T.pencilSoft,
                                    width: 54,
                                    flexShrink: 0,
                                  }}
                                >
                                  {g.teeTime}
                                </div>
                              )}
                              <div style={{ display: "flex" }}>
                                {groupPlayers.map((p, pi) => (
                                  <div
                                    key={pi}
                                    style={{
                                      width: 26,
                                      height: 26,
                                      borderRadius: 99,
                                      background: p.color,
                                      color: T.paper,
                                      border: `1.5px solid ${T.paper}`,
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      fontFamily: T.serif,
                                      fontStyle: "italic",
                                      fontSize: 12,
                                      marginLeft: pi === 0 ? 0 : -8,
                                    }}
                                  >
                                    {p.initial}
                                  </div>
                                ))}
                              </div>
                              <div
                                style={{
                                  flex: 1,
                                  fontFamily: T.serif,
                                  fontSize: 14,
                                  color: T.ink,
                                  letterSpacing: -0.1,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {groupPlayers.map((p) => p.name).join(" · ")}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Top 3 for completed rounds */}
                    {done && roundSorted.length > 0 && (
                      <div
                        style={{
                          marginTop: 10,
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr 1fr",
                          gap: 6,
                        }}
                      >
                        {roundSorted.map((s, si) => (
                          <div
                            key={s.playerId}
                            style={{
                              padding: "6px 8px",
                              borderRadius: 8,
                              background: T.paperDeep,
                            }}
                          >
                            <div
                              style={{
                                fontFamily: T.mono,
                                fontSize: 8,
                                letterSpacing: 1.2,
                                color: T.pencilSoft,
                                textTransform: "uppercase",
                              }}
                            >
                              {si + 1}
                              {suffix(si + 1)}
                            </div>
                            <div
                              style={{
                                fontFamily: T.sans,
                                fontSize: 12,
                                fontWeight: 500,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {s.name}
                            </div>
                            <div
                              style={{
                                fontFamily: T.serif,
                                fontSize: 16,
                                color: T.ink,
                              }}
                            >
                              {s.roundTotals[i]}{" "}
                              <span
                                style={{ fontSize: 10, color: T.pencilSoft }}
                              >
                                gross
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <button
                      onClick={() => router.push(roundHref(r.id))}
                      style={{
                        marginTop: 10,
                        width: "100%",
                        padding: "0 12px",
                        borderRadius: 10,
                        border: `1px solid ${T.hairline}`,
                        background: "transparent",
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.3,
                        color: T.pencil,
                        textTransform: "uppercase",
                        cursor: "pointer",
                        textAlign: "left",
                        minHeight: 44,
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      {live ? "Continue round →" : "View scorecard →"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ── Games tab ─────────────────────────────────────────────────── */}
        {tab === "games" && (
          <div style={{ padding: "0 22px 40px" }}>
            {!hasGames ? (
              <EmptyState text="No games set up yet." />
            ) : (
              tournamentGames.map((g: Game) => (
                <div
                  key={g.id}
                  style={{
                    padding: "14px 0",
                    borderBottom: `1px dashed ${T.hairline}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      marginBottom: 4,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 22,
                        letterSpacing: -0.3,
                        color: T.ink,
                      }}
                    >
                      {g.name}
                    </div>
                    {/* Fix #4: human-readable format label instead of raw camelCase */}
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.2,
                        color: T.pencil,
                        textTransform: "uppercase",
                      }}
                    >
                      {FORMAT_LABELS[g.format] ?? g.format}
                    </div>
                  </div>
                  {g.settings?.pointValue != null && (
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.2,
                        color: T.pencilSoft,
                        textTransform: "uppercase",
                      }}
                    >
                      ${g.settings.pointValue} / pt
                    </div>
                  )}
                  {g.playerIds.length > 0 && (
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 13,
                        color: T.pencil,
                        marginTop: 4,
                      }}
                    >
                      {g.playerIds
                        .map(
                          (pid) =>
                            standings.find((s) => s.playerId === pid)?.name ??
                            tournament.playerNamesById?.[pid] ??
                            pid
                        )
                        .join(", ")}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Bottom safe-area */}
        <div
          style={{ height: "max(40px, env(safe-area-inset-bottom, 40px))" }}
        />
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function Meta({
  k,
  v,
  sub,
}: {
  k: string;
  v: string | number;
  sub?: string;
}) {
  return (
    <div style={{ lineHeight: 1 }}>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1.3,
          color: T.pencil,
          textTransform: "uppercase",
        }}
      >
        {k}
      </div>
      <div
        style={{
          fontFamily: T.serif,
          fontSize: 22,
          color: T.ink,
          marginTop: 3,
          letterSpacing: -0.3,
        }}
      >
        {v}
      </div>
      {sub && (
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.2,
            color: T.pencilSoft,
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "40px 0",
        textAlign: "center",
        fontFamily: T.serif,
        fontStyle: "italic",
        fontSize: 16,
        color: T.pencil,
      }}
    >
      {text}
    </div>
  );
}
