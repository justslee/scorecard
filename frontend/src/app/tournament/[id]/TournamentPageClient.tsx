"use client";

import { useState, useEffect } from "react";
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

// ── Player standing shape ─────────────────────────────────────────────────────

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

// ── Pure helpers ──────────────────────────────────────────────────────────────

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
 *  3. playerId as fallback
 *
 * playerIds may be empty for tournaments created before player-ids were tracked;
 * in that case we union the players from member rounds.
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

function suffix(n: number): string {
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}

// ── Page ──────────────────────────────────────────────────────────────────────

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
    // Skip for the static prerender placeholder
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
          // Fetch all owner rounds then filter to this tournament's members.
          // One GET /api/rounds is more efficient than N individual fetches.
          const allRounds = await getRoundsAsync();
          const roundIdSet = new Set(t.roundIds);
          // Also accept rounds where tournamentId matches (belt-and-suspenders)
          const members = allRounds
            .filter((r) => roundIdSet.has(r.id) || r.tournamentId === id)
            // Sort ascending by creation date so Day 1 = earliest round
            .sort(
              (a, b) =>
                new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime()
            );
          setMemberRounds(members);

          // Resolve player names: backend playerNamesById first, then round players
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

          // If the tournament has no explicit playerIds, union from rounds
          const effectivePlayerIds =
            t.playerIds.length > 0
              ? t.playerIds
              : Array.from(
                  new Set(members.flatMap((r) => r.players.map((p) => p.id)))
                );

          const computed = computeStandings(
            effectivePlayerIds,
            resolvedNames,
            members
          );
          setStandings(computed);
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

  // ── Not found ──────────────────────────────────────────────────────────────
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

  // ── Loading shell ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
        }}
      />
    );
  }

  if (!tournament) return null;

  const hasRounds = memberRounds.length > 0;
  const hasScores = standings.some((s) => s.totalStrokes !== null);
  const tournamentGames: Game[] = tournament.games ?? [];
  const hasGames = tournamentGames.length > 0;

  // Sort standings for leaderboard
  const sortedStandings = [...standings].sort((a, b) => {
    if (lbMode === "gross") {
      if (a.totalStrokes === null && b.totalStrokes === null) return 0;
      if (a.totalStrokes === null) return 1;
      if (b.totalStrokes === null) return -1;
      return a.totalStrokes - b.totalStrokes;
    }
    // toPar
    if (a.totalToPar === null && b.totalToPar === null) return 0;
    if (a.totalToPar === null) return 1;
    if (b.totalToPar === null) return -1;
    return a.totalToPar - b.totalToPar;
  });

  const leader = sortedStandings[0] ?? null;

  // Grid template for leaderboard rows: position | name | R1 … Rn | total
  const roundColW = memberRounds.length > 3 ? "34px" : "44px";
  const gridCols = `22px 1fr ${memberRounds.map(() => roundColW).join(" ")} 52px`;

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
        {/* ── Masthead ─────────────────────────────────────────────────────── */}
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

        {/* ── Round progress strip ─────────────────────────────────────────── */}
        {hasRounds && (
          <div style={{ padding: "0 22px 14px" }}>
            <div style={{ display: "flex", gap: 6 }}>
              {memberRounds.map((r, i) => {
                const done = r.status === "completed";
                const live = r.status === "active";
                return (
                  <button
                    key={r.id}
                    onClick={() => router.push(`/round/${r.id}`)}
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
                      {r.courseName}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Leader callout (when scores exist) ──────────────────────────── */}
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
                border: "1.5px solid rgba(244,241,234,0.2)",
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
                  color: "rgba(244,241,234,0.5)",
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
                  color: "rgba(244,241,234,0.5)",
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

        {/* ── Tab bar ──────────────────────────────────────────────────────── */}
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

        {/* ── Leaderboard tab ──────────────────────────────────────────────── */}
        {tab === "leaderboard" && (
          <div style={{ padding: "0 22px 40px" }}>
            {/* Mode toggle */}
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
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
                    padding: "4px 10px",
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
                    minHeight: 32,
                  }}
                >
                  {m.l}
                </button>
              ))}
            </div>

            {standings.length === 0 ? (
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
                No players in this tournament yet.
              </div>
            ) : !hasRounds || !hasScores ? (
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
                {hasRounds
                  ? "Scores will appear here as you play."
                  : "No rounds played yet."}
              </div>
            ) : (
              <>
                {/* Column header */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: gridCols,
                    gap: 8,
                    padding: "6px 0",
                    borderBottom: `1px solid ${T.hairline}`,
                    fontFamily: T.mono,
                    fontSize: 8.5,
                    letterSpacing: 1.3,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                  }}
                >
                  <div>#</div>
                  <div>Player</div>
                  {memberRounds.map((_, i) => (
                    <div key={i} style={{ textAlign: "right" }}>
                      R{i + 1}
                    </div>
                  ))}
                  <div style={{ textAlign: "right" }}>Total</div>
                </div>

                {/* Standing rows */}
                {sortedStandings.map((s, idx) => {
                  const perRound =
                    lbMode === "gross" ? s.roundTotals : s.roundToPar;
                  const total =
                    lbMode === "gross" ? s.totalStrokes : s.totalToPar;
                  const ranked = s.totalStrokes !== null;
                  return (
                    <div
                      key={s.playerId}
                      style={{
                        display: "grid",
                        gridTemplateColumns: gridCols,
                        gap: 8,
                        alignItems: "center",
                        padding: "10px 0",
                        borderBottom: `1px dashed ${T.hairline}`,
                      }}
                    >
                      {/* Rank */}
                      <div
                        style={{
                          fontFamily: T.serif,
                          fontSize: 16,
                          color: idx < 3 && ranked ? T.ink : T.pencil,
                          fontVariantNumeric: "tabular-nums",
                          lineHeight: 1,
                        }}
                      >
                        {ranked ? idx + 1 : "—"}
                      </div>

                      {/* Player */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          minWidth: 0,
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
                            fontSize: 13,
                            flexShrink: 0,
                          }}
                        >
                          {s.initial}
                        </div>
                        <div
                          style={{
                            fontFamily: T.sans,
                            fontSize: 13.5,
                            fontWeight: 500,
                            color: T.ink,
                            lineHeight: 1.1,
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

                      {/* Total */}
                      <div
                        style={{
                          textAlign: "right",
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
              </>
            )}
          </div>
        )}

        {/* ── Rounds tab ───────────────────────────────────────────────────── */}
        {tab === "rounds" && (
          <div style={{ padding: "0 22px 40px" }}>
            {!hasRounds ? (
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
                No rounds played yet.
              </div>
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
                          {r.courseName}
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

                    {/* Groups if available (shown for upcoming / live rounds) */}
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
                            if (st) {
                              return {
                                name: st.name,
                                initial: st.initial,
                                color: st.color,
                              };
                            }
                            const fallbackName =
                              tournament.playerNamesById?.[pid] ?? pid;
                            return {
                              name: fallbackName,
                              initial: playerInitial(fallbackName),
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

                    {/* Link to the round scorecard */}
                    <button
                      onClick={() => router.push(`/round/${r.id}`)}
                      style={{
                        marginTop: 10,
                        width: "100%",
                        padding: "8px 12px",
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

        {/* ── Games tab ────────────────────────────────────────────────────── */}
        {tab === "games" && (
          <div style={{ padding: "0 22px 40px" }}>
            {!hasGames ? (
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
                No games set up yet.
              </div>
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
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.2,
                        color: T.pencil,
                        textTransform: "uppercase",
                      }}
                    >
                      {g.format}
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
