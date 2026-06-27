"use client";

// LeaderboardSheet — mid-round leaderboard across all active games.
// Tabs: Overall (always) + one tab per game in round.games.
// Game results are computed live from round.scores via lib/games.ts.
// Match-play Nassau (P21) is not yet implemented — the engine falls back to
// stroke totals and a note is shown on that tab.

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE } from "./tokens";
import type { SeedPlayer } from "./Scorecard";
import type { Round, Score, Game } from "@/lib/types";
import {
  computeGameResults,
  type SkinsResults,
  type NassauResults,
  type ThreePointResults,
  type GameResults,
} from "@/lib/games";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Convert display-scores map → Score[] so the game engine can consume them.
 *  This ensures pending (not-yet-server-confirmed) scores are included in
 *  game computations.
 */
function displayScoresToArr(
  scores: Record<string, (number | null)[]>
): Score[] {
  const result: Score[] = [];
  for (const [playerId, holes] of Object.entries(scores)) {
    holes.forEach((strokes, idx) => {
      if (strokes !== null) {
        result.push({ playerId, holeNumber: idx + 1, strokes });
      }
    });
  }
  return result;
}

/** Human-readable tab label for a game (includes bet if set). */
function gameTabLabel(game: Game): string {
  const names: Record<string, string> = {
    nassau: "Nassau",
    skins: "Skins",
    threePoint: "3-Point",
    bestBall: "Best Ball",
    stableford: "Stableford",
    modifiedStableford: "Modified Stab.",
    matchPlay: "Match Play",
    wolf: "Wolf",
    scramble: "Scramble",
    bingoBangoBongo: "Bingo Bango",
    vegas: "Vegas",
  };
  const base = names[game.format] ?? game.name;
  const val = game.settings?.pointValue;
  return val ? `${base} · $${val}` : base;
}

/** How many F9/B9 holes have at least one score entered. */
function computeThru(scores: Record<string, (number | null)[]>) {
  let thruFront = 0;
  let thruBack = 0;
  for (let h = 1; h <= 18; h++) {
    const any = Object.values(scores).some((sc) => sc[h - 1] != null);
    if (any) {
      if (h <= 9) thruFront++;
      else thruBack++;
    }
  }
  return { thruFront, thruBack };
}

/**
 * From SkinsResults, find holes currently "in the pot" (consecutive tied holes
 * since the last skin was won, among holes that have been played by 2+ players).
 */
function getPotState(
  holeWinners: SkinsResults["holeWinners"],
  scores: Record<string, (number | null)[]>
): { potCarrying: number; potHoles: number[] } {
  const playedHoles = new Set<number>();
  for (let h = 1; h <= 18; h++) {
    const count = Object.values(scores).filter((sc) => sc[h - 1] != null).length;
    if (count >= 2) playedHoles.add(h);
  }
  let potHoles: number[] = [];
  for (const hw of holeWinners) {
    if (!playedHoles.has(hw.holeNumber)) continue;
    if (hw.winnerPlayerId !== null) {
      potHoles = [];
    } else {
      potHoles.push(hw.holeNumber);
    }
  }
  return { potCarrying: potHoles.length, potHoles };
}

// ------------------------------------------------------------------
// Sub-components: shared chrome
// ------------------------------------------------------------------

function Tab({
  children,
  active,
  onClick,
  accent,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        position: "relative",
        padding: "8px 14px",
        border: "none",
        background: "transparent",
        fontFamily: T.sans,
        fontSize: 12.5,
        fontWeight: active ? 600 : 400,
        color: active ? T.ink : T.pencil,
        cursor: "pointer",
        letterSpacing: -0.1,
        flexShrink: 0,
      }}
    >
      {children}
      {active && (
        <motion.div
          layoutId="lb-tab-underline"
          style={{
            position: "absolute",
            left: 10,
            right: 10,
            bottom: 2,
            height: 2,
            background: accent,
            borderRadius: 99,
          }}
        />
      )}
    </button>
  );
}

function DotStrip({
  scores,
  pars,
  start = 0,
  accent,
}: {
  scores: (number | null)[];
  pars: number[];
  start?: number;
  accent: string;
}) {
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {Array.from({ length: 9 }, (_, i) => {
        const s = scores[start + i];
        const p = pars[start + i];
        if (s == null) {
          return (
            <div
              key={i}
              style={{ width: 6, height: 6, borderRadius: 99, background: T.hairlineSoft }}
            />
          );
        }
        const diff = s - p;
        let bg = T.pencilSoft;
        if (diff <= -2) bg = "oklch(0.48 0.14 280)";
        else if (diff === -1) bg = accent;
        else if (diff === 0) bg = T.ink;
        else if (diff === 1) bg = T.pencil;
        else bg = T.pencilSoft;
        return (
          <div
            key={i}
            style={{
              width: 6,
              height: 6,
              borderRadius: diff <= -1 ? 99 : 1.5,
              background: bg,
            }}
          />
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------
// Overall tab (unchanged — computed from display scores, no engine needed)
// ------------------------------------------------------------------

function Overall({
  players,
  scores,
  pars,
  accent,
}: {
  players: SeedPlayer[];
  scores: Record<string, (number | null)[]>;
  pars: number[];
  accent: string;
}) {
  const withTotals = players
    .map((p) => {
      const sc = scores[p.id] ?? [];
      const played = sc.filter((s) => s != null);
      const thru = played.length;
      const total = sc.reduce<number>((a, b) => a + (b ?? 0), 0);
      const relPar = sc.reduce<number>(
        (a, s, i) => a + (s != null ? s - pars[i] : 0),
        0
      );
      return { ...p, total, relPar, thru, scores: sc };
    })
    .sort((a, b) => {
      if (a.thru === 0) return 1;
      if (b.thru === 0) return -1;
      return a.relPar - b.relPar;
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "0 2px",
        }}
      >
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.4,
            color: T.pencil,
            textTransform: "uppercase",
          }}
        >
          Stroke play · Thru {withTotals[0]?.thru ?? 0}
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 13,
            color: T.pencil,
          }}
        >
          {withTotals[0]?.thru ? `${withTotals[0].name} leads` : "—"}
        </div>
      </div>

      {withTotals.map((p, i) => {
        const isLeader = i === 0 && p.thru > 0;
        const posLabel =
          i === 0 ? "1st" : i === 1 ? "2nd" : i === 2 ? "3rd" : `${i + 1}th`;
        return (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05, ease: T.ease }}
            style={{
              display: "grid",
              gridTemplateColumns: "28px 1fr auto",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              background: isLeader ? "rgba(26,42,26,0.03)" : "transparent",
              border: `1px solid ${isLeader ? T.hairline : T.hairlineSoft}`,
              borderRadius: 14,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 99,
                border: `1.5px solid ${isLeader ? accent : T.hairline}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 13,
                color: isLeader ? accent : T.pencil,
              }}
            >
              {i + 1}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <div
                  style={{
                    fontFamily: T.sans,
                    fontSize: 14,
                    fontWeight: 500,
                    color: T.ink,
                    letterSpacing: -0.2,
                  }}
                >
                  {p.name}
                </div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.2,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                  }}
                >
                  {posLabel} · HCP {p.hcp}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  marginTop: 6,
                  alignItems: "center",
                }}
              >
                <DotStrip scores={p.scores} pars={pars} start={0} accent={accent} />
                <div style={{ width: 1, height: 10, background: T.hairline }} />
                <DotStrip scores={p.scores} pars={pars} start={9} accent={accent} />
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 26,
                  color: T.ink,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                }}
              >
                {p.thru > 0 ? p.total : "—"}
              </div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  letterSpacing: 1.2,
                  color: p.relPar < 0 ? accent : T.pencil,
                  marginTop: 2,
                }}
              >
                {p.thru === 0
                  ? "—"
                  : p.relPar === 0
                  ? "E"
                  : p.relPar > 0
                  ? `+${p.relPar}`
                  : p.relPar}
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------
// Nassau — real data
// ------------------------------------------------------------------

function Nassau({
  nassau,
  game,
  players,
  scores,
  accent,
}: {
  nassau: NassauResults;
  game: Game;
  players: SeedPlayer[];
  scores: Record<string, (number | null)[]>;
  accent: string;
}) {
  /** Resolve a competitor ID → display name.
   *  For individual scope, it's a player ID.
   *  For team scope, it's a team ID. */
  const nameFor = (id: string | null): string => {
    if (!id) return "—";
    if (nassau.scope === "team") {
      return game.teams?.find((t) => t.id === id)?.name ?? id;
    }
    return players.find((p) => p.id === id)?.name ?? id;
  };

  const { thruFront, thruBack } = computeThru(scores);

  const segs = [
    {
      k: "Front 9",
      winner: nassau.front9WinnerId,
      note: thruFront > 0 ? `Thru ${thruFront}` : "Not started",
      inProgress: thruFront > 0 && thruFront < 9,
    },
    {
      k: "Back 9",
      winner: nassau.back9WinnerId,
      note: thruBack > 0 ? `Thru ${thruBack}` : "Not started",
      inProgress: thruBack > 0 && thruBack < 9,
    },
    {
      k: "Overall",
      winner: nassau.overallWinnerId,
      note:
        thruFront === 9 && thruBack === 9
          ? "Final"
          : thruFront > 0
          ? "Running"
          : "—",
      inProgress: thruFront > 0,
    },
  ];

  // Rows sorted by overall total (ascending = best score)
  const competitorIds = Object.keys(nassau.overallTotals);
  const rows = competitorIds
    .map((id) => ({ id, total: nassau.overallTotals[id] }))
    .sort((a, b) => a.total - b.total);

  const bet = game.settings?.pointValue ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Match-play mode note — engine falls back to stroke totals (P21) */}
      {nassau.mode === "match" && (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: `1px solid ${T.hairlineSoft}`,
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 12,
            color: T.pencilSoft,
          }}
        >
          Match-play Nassau scoring is coming soon — showing stroke totals for now.
        </div>
      )}

      {/* F9 / B9 / Overall winner grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 0,
          border: `1px solid ${T.hairline}`,
          borderRadius: 14,
          overflow: "hidden",
          background: T.paper,
        }}
      >
        {segs.map((s, i) => (
          <div
            key={s.k}
            style={{
              padding: "14px 10px",
              borderLeft: i > 0 ? `1px solid ${T.hairline}` : "none",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 8.5,
                letterSpacing: 1.2,
                color: T.pencil,
                textTransform: "uppercase",
                marginBottom: 4,
              }}
            >
              {s.k}
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 16,
                color: s.winner ? T.ink : T.pencilSoft,
                letterSpacing: -0.3,
              }}
            >
              {nameFor(s.winner)}
            </div>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1,
                color: s.inProgress ? accent : T.pencilSoft,
                marginTop: 3,
                textTransform: "uppercase",
              }}
            >
              {s.note}
            </div>
          </div>
        ))}
      </div>

      {/* Stakes row */}
      {bet > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            background: "rgba(26,42,26,0.03)",
            borderRadius: 10,
          }}
        >
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.2,
              color: T.pencil,
              textTransform: "uppercase",
            }}
          >
            Stakes
          </div>
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 14,
              color: T.ink,
            }}
          >
            ${bet} / bet · 3 segments · ${bet * 3} max
          </div>
        </div>
      )}

      {/* Running totals table */}
      {rows.length > 0 && (
        <div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.4,
              color: T.pencil,
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            Running totals
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 40px 40px 44px",
              gap: 2,
              fontFamily: T.mono,
              fontSize: 9,
              color: T.pencilSoft,
              textTransform: "uppercase",
              letterSpacing: 1,
              padding: "0 12px 6px",
            }}
          >
            <div>Player</div>
            <div style={{ textAlign: "right" }}>F9</div>
            <div style={{ textAlign: "right" }}>B9</div>
            <div style={{ textAlign: "right" }}>Tot</div>
          </div>
          <div
            style={{
              border: `1px solid ${T.hairline}`,
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {rows.map(({ id, total }, i) => {
              const f9 = nassau.front9Totals[id] ?? 0;
              const b9 = nassau.back9Totals[id] ?? 0;
              const isOverallLeader = id === nassau.overallWinnerId;
              return (
                <div
                  key={id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 40px 40px 44px",
                    gap: 2,
                    alignItems: "center",
                    padding: "10px 12px",
                    borderTop: i > 0 ? `1px solid ${T.hairlineSoft}` : "none",
                    background: isOverallLeader
                      ? "rgba(26,42,26,0.025)"
                      : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span
                      style={{
                        fontFamily: T.sans,
                        fontSize: 13,
                        fontWeight: 500,
                        color: T.ink,
                      }}
                    >
                      {nameFor(id)}
                    </span>
                    {isOverallLeader && (
                      <span
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8.5,
                          letterSpacing: 1,
                          color: accent,
                          textTransform: "uppercase",
                        }}
                      >
                        lead
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 14,
                      color: f9 > 0 ? T.ink : T.pencilSoft,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {f9 > 0 ? f9 : "—"}
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 14,
                      color: b9 > 0 ? T.ink : T.pencilSoft,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {b9 > 0 ? b9 : "—"}
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 18,
                      color: total > 0 ? T.ink : T.pencilSoft,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {total > 0 ? total : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state: no scores yet */}
      {rows.length === 0 && (
        <div
          style={{
            padding: "24px 16px",
            textAlign: "center",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
          }}
        >
          Scores will appear here as you play.
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Skins — real data
// ------------------------------------------------------------------

function Skins({
  skins,
  game,
  players,
  scores,
  accent,
}: {
  skins: SkinsResults;
  game: Game;
  players: SeedPlayer[];
  scores: Record<string, (number | null)[]>;
  accent: string;
}) {
  const nameFor = (pid: string) =>
    players.find((p) => p.id === pid)?.name ?? pid;
  const bet = game.settings?.pointValue ?? 0;

  const { potCarrying, potHoles } = getPotState(skins.holeWinners, scores);

  // Sort by skins descending
  const sorted = [...skins.byPlayer].sort((a, b) => b.skins - a.skins);
  const maxSkins = Math.max(...sorted.map((s) => s.skins), 1);

  // Next hole where pot will be contested (hole after last pot hole)
  const nextPotHole = potHoles.length > 0 ? potHoles[potHoles.length - 1] + 1 : null;

  const anyScores = sorted.some((s) => s.skins > 0) || potCarrying > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Carrying pot callout */}
      {potCarrying > 0 && nextPotHole && nextPotHole <= 18 && (
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          style={{
            padding: "14px 16px",
            border: `1px dashed ${accent}`,
            borderRadius: 14,
            background: "rgba(26,42,26,0.02)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.4,
                color: accent,
                textTransform: "uppercase",
              }}
            >
              Pot carrying
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 15,
                color: T.ink,
                marginTop: 2,
              }}
            >
              {potCarrying} skin{potCarrying !== 1 ? "s" : ""} carrying to hole{" "}
              {nextPotHole}
            </div>
          </div>
          {bet > 0 && (
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 26,
                  color: T.ink,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                }}
              >
                ${bet * (potCarrying + 1)}
              </div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1,
                  color: T.pencil,
                  textTransform: "uppercase",
                }}
              >
                up for grabs
              </div>
            </div>
          )}
        </motion.div>
      )}

      {/* Per-player skins */}
      {anyScores ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sorted.map((s) => {
            const winnings = s.skins * bet;
            // Deduplicate holesWon display (engine pushes holeNumber once per skin value)
            const uniqueHoles = [...new Set(s.holesWon)];
            return (
              <div
                key={s.playerId}
                style={{
                  padding: "12px 14px",
                  border: `1px solid ${T.hairlineSoft}`,
                  borderRadius: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: s.skins > 0 ? 8 : 0,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span
                      style={{
                        fontFamily: T.sans,
                        fontSize: 14,
                        fontWeight: 500,
                        color: T.ink,
                      }}
                    >
                      {nameFor(s.playerId)}
                    </span>
                    {uniqueHoles.length > 0 && (
                      <span
                        style={{
                          fontFamily: T.mono,
                          fontSize: 9,
                          letterSpacing: 1,
                          color: T.pencilSoft,
                          textTransform: "uppercase",
                        }}
                      >
                        Hole{uniqueHoles.length !== 1 ? "s" : ""}{" "}
                        {uniqueHoles.join(", ")}
                      </span>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span
                      style={{
                        fontFamily: T.serif,
                        fontSize: 22,
                        color: s.skins > 0 ? T.ink : T.pencilSoft,
                        fontVariantNumeric: "tabular-nums",
                        marginRight: 6,
                      }}
                    >
                      {s.skins}
                    </span>
                    {bet > 0 && (
                      <span
                        style={{
                          fontFamily: T.mono,
                          fontSize: 9.5,
                          letterSpacing: 1,
                          color: winnings > 0 ? accent : T.pencilSoft,
                          textTransform: "uppercase",
                        }}
                      >
                        +${winnings}
                      </span>
                    )}
                  </div>
                </div>
                {s.skins > 0 && (
                  <div style={{ display: "flex", gap: 3 }}>
                    {Array.from({ length: maxSkins }, (_, j) => (
                      <div
                        key={j}
                        style={{
                          flex: 1,
                          height: 6,
                          borderRadius: 1.5,
                          background: j < s.skins ? accent : T.hairlineSoft,
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div
          style={{
            padding: "24px 16px",
            textAlign: "center",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
          }}
        >
          No skins won yet. First outright low score takes the skin.
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Three-Point — real data
// ------------------------------------------------------------------

function ThreePoint({
  threePoint,
  game,
  accent,
}: {
  threePoint: ThreePointResults;
  game: Game;
  accent: string;
}) {
  const teamName = (id: string) =>
    game.teams?.find((t) => t.id === id)?.name ?? id;

  const pointsA = threePoint.totals[threePoint.teamAId] ?? 0;
  const pointsB = threePoint.totals[threePoint.teamBId] ?? 0;
  const lead = pointsA > pointsB ? "A" : pointsB > pointsA ? "B" : null;
  const diff = Math.abs(pointsA - pointsB);
  const bet = game.settings?.pointValue ?? 0;

  const noScores = pointsA === 0 && pointsB === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {noScores ? (
        <div
          style={{
            padding: "24px 16px",
            textAlign: "center",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
          }}
        >
          Points will appear here as you play.
        </div>
      ) : (
        <div
          style={{
            padding: "24px 18px",
            border: `1px solid ${T.hairline}`,
            borderRadius: 18,
            background: T.paper,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto 1fr",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 48,
                  color: lead === "A" ? T.ink : T.pencilSoft,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                  letterSpacing: -1,
                }}
              >
                {pointsA}
              </div>
              <div
                style={{
                  fontFamily: T.sans,
                  fontSize: 13,
                  fontWeight: 500,
                  color: T.ink,
                  marginTop: 6,
                  letterSpacing: -0.2,
                }}
              >
                {teamName(threePoint.teamAId)}
              </div>
              {lead === "A" && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.4,
                    color: accent,
                    textTransform: "uppercase",
                    marginTop: 3,
                  }}
                >
                  Up {diff}
                  {bet > 0 ? ` · +$${diff * bet}` : ""}
                </div>
              )}
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 3,
              }}
            >
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 18,
                  color: T.pencilSoft,
                }}
              >
                vs
              </div>
              <div style={{ width: 1, height: 40, background: T.hairline }} />
            </div>

            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 48,
                  color: lead === "B" ? T.ink : T.pencilSoft,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                  letterSpacing: -1,
                }}
              >
                {pointsB}
              </div>
              <div
                style={{
                  fontFamily: T.sans,
                  fontSize: 13,
                  fontWeight: 500,
                  color: T.ink,
                  marginTop: 6,
                  letterSpacing: -0.2,
                }}
              >
                {teamName(threePoint.teamBId)}
              </div>
              {lead === "B" && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.4,
                    color: accent,
                    textTransform: "uppercase",
                    marginTop: 3,
                  }}
                >
                  Up {diff}
                  {bet > 0 ? ` · +$${diff * bet}` : ""}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Scoring guide */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {[
          { k: "Low ball", v: "Best of team" },
          { k: "Low total", v: "Both combined" },
          { k: "Low pair", v: "Both count" },
        ].map((pt) => (
          <div
            key={pt.k}
            style={{
              padding: "10px 12px",
              border: `1px solid ${T.hairlineSoft}`,
              borderRadius: 10,
            }}
          >
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 8.5,
                letterSpacing: 1.2,
                color: T.pencil,
                textTransform: "uppercase",
              }}
            >
              {pt.k}
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 12,
                color: T.inkSoft,
                marginTop: 2,
              }}
            >
              {pt.v}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Generic game panel (best ball, stableford, match play, wolf, etc.)
// Renders whatever the engine returns in a calm, minimal layout.
// ------------------------------------------------------------------

function GenericGame({
  results,
  game,
  players,
  accent,
}: {
  results: GameResults;
  game: Game;
  players: SeedPlayer[];
  accent: string;
}) {
  const nameFor = (pid: string) =>
    players.find((p) => p.id === pid)?.name ?? pid;

  // Stableford
  if (results.stableford) {
    const sf = results.stableford;
    const sorted = [...sf.pointsByPlayer].sort((a, b) => b.total - a.total);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.4,
            color: T.pencil,
            textTransform: "uppercase",
            marginBottom: 2,
          }}
        >
          Points (higher is better)
        </div>
        {sorted.map((p, i) => (
          <div
            key={p.playerId}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              border: `1px solid ${i === 0 && p.holesPlayed > 0 ? T.hairline : T.hairlineSoft}`,
              borderRadius: 12,
              background:
                i === 0 && p.holesPlayed > 0
                  ? "rgba(26,42,26,0.03)"
                  : "transparent",
            }}
          >
            <div
              style={{
                fontFamily: T.sans,
                fontSize: 14,
                fontWeight: 500,
                color: T.ink,
              }}
            >
              {nameFor(p.playerId)}
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontSize: 22,
                color: p.holesPlayed > 0 ? T.ink : T.pencilSoft,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {p.holesPlayed > 0 ? p.total : "—"}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Match Play
  if (results.matchPlay) {
    const mp = results.matchPlay;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          style={{
            padding: "18px 16px",
            border: `1px solid ${T.hairline}`,
            borderRadius: 14,
            background: T.paper,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.4,
              color: T.pencil,
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            {nameFor(mp.player1Id)} vs {nameFor(mp.player2Id)}
          </div>
          <div
            style={{
              fontFamily: T.serif,
              fontSize: 32,
              fontStyle: "italic",
              color: T.ink,
              letterSpacing: -0.5,
            }}
          >
            {mp.currentStatus}
          </div>
          {mp.winnerPlayerId && (
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.2,
                color: accent,
                textTransform: "uppercase",
                marginTop: 4,
              }}
            >
              {nameFor(mp.winnerPlayerId)} wins
            </div>
          )}
        </div>
      </div>
    );
  }

  // Best Ball
  if (results.bestBall) {
    const bb = results.bestBall;
    const sorted = [...bb.totals].sort((a, b) => a.total - b.total);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted.map((t, i) => {
          const teamName = game.teams?.find((tm) => tm.id === t.teamId)?.name ?? t.teamId;
          return (
            <div
              key={t.teamId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                border: `1px solid ${i === 0 && t.holesPlayed > 0 ? T.hairline : T.hairlineSoft}`,
                borderRadius: 12,
              }}
            >
              <div
                style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}
              >
                {teamName}
              </div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 22,
                  color: t.holesPlayed > 0 ? T.ink : T.pencilSoft,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {t.holesPlayed > 0 ? t.total : "—"}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Wolf
  if (results.wolf) {
    const wf = results.wolf;
    const sorted = Object.entries(wf.totals).sort((a, b) => b[1] - a[1]);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.4,
            color: T.pencil,
            textTransform: "uppercase",
            marginBottom: 2,
          }}
        >
          Wolf points
        </div>
        {sorted.map(([pid, pts], i) => (
          <div
            key={pid}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              border: `1px solid ${i === 0 ? T.hairline : T.hairlineSoft}`,
              borderRadius: 12,
            }}
          >
            <div
              style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}
            >
              {nameFor(pid)}
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontSize: 22,
                color: pts !== 0 ? T.ink : T.pencilSoft,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {pts}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Fallback: game format with no renderer yet
  return (
    <div
      style={{
        padding: "24px 16px",
        textAlign: "center",
        fontFamily: T.serif,
        fontStyle: "italic",
        fontSize: 14,
        color: T.pencilSoft,
      }}
    >
      {game.name} — results coming soon.
    </div>
  );
}

// ------------------------------------------------------------------
// No-games empty state (shown when round has no games configured)
// ------------------------------------------------------------------

function NoGames() {
  return (
    <div
      style={{
        padding: "32px 20px",
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "center",
      }}
    >
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 18,
          color: T.ink,
          letterSpacing: -0.3,
        }}
      >
        No games yet
      </div>
      <div
        style={{
          fontFamily: T.sans,
          fontSize: 13,
          color: T.pencil,
          maxWidth: 240,
          lineHeight: 1.5,
        }}
      >
        Add a game when setting up a round — skins, Nassau, 3-point, and more.
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Main LeaderboardSheet
// ------------------------------------------------------------------

export default function LeaderboardSheet({
  open,
  onClose,
  players,
  scores,
  pars,
  accent,
  round,
}: {
  open: boolean;
  onClose: () => void;
  players: SeedPlayer[];
  scores: Record<string, (number | null)[]>;
  pars: number[];
  accent: string;
  /** Full round object — used to read round.games and compute results via lib/games.ts. */
  round: Round | null;
}) {
  const games = round?.games ?? [];

  // Build dynamic tab list: Overall always first, then one per game.
  const tabs = useMemo(
    () => [
      { id: "overall", label: "Overall" },
      ...games.map((g) => ({ id: g.id, label: gameTabLabel(g) })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [games.map((g) => g.id).join(","), games.map((g) => g.name).join(",")]
  );

  const [tab, setTab] = useState<string>("overall");

  useEffect(() => {
    if (open) setTab("overall");
  }, [open]);

  // Reset tab to "overall" if the current tab is no longer in the list
  // (e.g., games changed while sheet was open — rare but safe).
  useEffect(() => {
    if (!tabs.find((t) => t.id === tab)) {
      setTab("overall");
    }
  }, [tabs, tab]);

  // Pre-compute all game results when round or display scores change.
  // Uses display scores (includes pending) so in-flight entries show live results.
  const gameResults = useMemo<Record<string, GameResults>>(() => {
    if (!round || !games.length) return {};
    const engineRound: Round = {
      ...round,
      scores: displayScoresToArr(scores),
    };
    const out: Record<string, GameResults> = {};
    for (const g of games) {
      try {
        out[g.id] = computeGameResults(engineRound, g);
      } catch {
        out[g.id] = {};
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, scores]);

  const thru = Math.max(
    0,
    ...players.map((p) => (scores[p.id] ?? []).filter((s) => s != null).length)
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="lb-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(26,42,26,0.4)",
            zIndex: 60,
          }}
        />
      )}
      {open && (
        <motion.div
          key="lb-sheet"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={T.springSoft}
          style={{
            position: "fixed",
            top: 36,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 70,
            background: `${PAPER_NOISE}, ${T.paper}`,
            backgroundBlendMode: "multiply",
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            boxShadow: "0 -20px 50px rgba(26,42,26,0.3)",
            display: "flex",
            flexDirection: "column",
            maxWidth: 420,
            margin: "0 auto",
          }}
        >
          {/* Drag handle */}
          <div
            style={{
              width: 40,
              height: 4,
              borderRadius: 99,
              background: T.hairline,
              margin: "14px auto 10px",
            }}
          />

          {/* Header */}
          <div
            style={{
              padding: "0 20px 10px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9.5,
                  letterSpacing: 1.4,
                  color: T.pencil,
                  textTransform: "uppercase",
                }}
              >
                Leaderboards · Live
              </div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 26,
                  fontStyle: "italic",
                  color: T.ink,
                  letterSpacing: -0.6,
                  marginTop: 2,
                }}
              >
                Through hole {thru}
              </div>
            </div>
            <button
              onClick={onClose}
              style={{
                width: 32,
                height: 32,
                borderRadius: 99,
                border: `1px solid ${T.hairline}`,
                background: "transparent",
                color: T.ink,
                fontSize: 16,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ×
            </button>
          </div>

          {/* Tabs */}
          <div
            style={{
              display: "flex",
              gap: 2,
              padding: "0 14px",
              borderBottom: `1px solid ${T.hairlineSoft}`,
              overflowX: "auto",
            }}
          >
            {tabs.map((t) => (
              <Tab
                key={t.id}
                active={tab === t.id}
                onClick={() => setTab(t.id)}
                accent={accent}
              >
                {t.label}
              </Tab>
            ))}
          </div>

          {/* Content */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "18px 18px 40px",
              WebkitOverflowScrolling: "touch",
            }}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22, ease: T.ease }}
              >
                {tab === "overall" && (
                  <Overall
                    players={players}
                    scores={scores}
                    pars={pars}
                    accent={accent}
                  />
                )}

                {tab !== "overall" &&
                  (() => {
                    const game = games.find((g) => g.id === tab);
                    if (!game) return null;
                    const results = gameResults[game.id] ?? {};

                    if (game.format === "nassau" && results.nassau) {
                      return (
                        <Nassau
                          nassau={results.nassau}
                          game={game}
                          players={players}
                          scores={scores}
                          accent={accent}
                        />
                      );
                    }
                    if (game.format === "skins" && results.skins) {
                      return (
                        <Skins
                          skins={results.skins}
                          game={game}
                          players={players}
                          scores={scores}
                          accent={accent}
                        />
                      );
                    }
                    if (game.format === "threePoint" && results.threePoint) {
                      return (
                        <ThreePoint
                          threePoint={results.threePoint}
                          game={game}
                          accent={accent}
                        />
                      );
                    }
                    // All other formats (bestBall, stableford, matchPlay, wolf, etc.)
                    return (
                      <GenericGame
                        results={results}
                        game={game}
                        players={players}
                        accent={accent}
                      />
                    );
                  })()}

                {/* No-games placeholder: only "overall" tab exists and there are no games */}
                {tab === "overall" && games.length === 0 && (
                  <div style={{ marginTop: 20 }}>
                    <NoGames />
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
