"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { roundHref } from "@/lib/round-url";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import { getTournamentAsync, getRoundsAsync } from "@/lib/storage-api";
import type { Tournament, Round, Game } from "@/lib/types";
import { computeTournamentSettlement, hasMoneyGames, SETTLEABLE_FORMATS } from "@/lib/settlement";
import { haptic } from "@/lib/haptics";
import {
  shouldRefreshLeaderboard,
  isPlausibleRefresh,
} from "@/lib/leaderboard-refresh";
import {
  computeStandings,
  sortStandings,
  tieRankLabel,
  formatToPar,
  formatDate,
  playerInitial,
  suffix,
  hasCrossing,
  type LbMode,
  type PlayerStanding,
} from "@/lib/tournament-standings";

type Tab = "leaderboard" | "rounds" | "games";

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

// ── Settlement reveal stagger (motion variants) ─────────────────────────────
const settlementContainerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};
const settlementItemVariants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: T.ease } },
};

// ── Page ────────────────────────────────────────────────────────────────────
// Pure standings/rank helpers (PlayerStanding, computeStandings, tieRankLabel,
// formatToPar, formatDate, playerInitial, suffix, hasCrossing) live in
// src/lib/tournament-standings.ts so vitest can import them without pulling
// in framer-motion — see the import block above.

export default function TournamentPageClient() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  // id from the query (/tournament/view?id=…) so navigation stays client-side in
  // the static export; fall back to the path param for any legacy deep link.
  const id = searchParams.get("id") ?? params?.id ?? "";
  const accent = DEFAULT_ACCENT;

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [memberRounds, setMemberRounds] = useState<Round[]>([]);
  const [standings, setStandings] = useState<PlayerStanding[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>("leaderboard");
  const [lbMode, setLbMode] = useState<LbMode>("gross");

  // Motion/haptics: NORTHSTAR-calm — subtle, purposeful, disabled visually
  // under prefers-reduced-motion. Presentation only, never touches the
  // standings/settlement math below.
  const reduce = useReducedMotion();

  // ── Live leaderboard refresh (specs/tournament-live-leaderboard-plan.md) ──
  // `fetchAndApply({initial})` is the single fetch+compute body shared by the
  // first load and the silent foreground refresh below it. `initial: true`
  // preserves the prior `load()` behavior byte-for-byte in outcome
  // (setLoading/setNotFound). `initial: false` NEVER touches loading/
  // notFound, never blanks the list, and keeps the last good state on any
  // degraded/failed fetch.
  const refreshInFlightRef = useRef(false);
  // Bumped per invocation and on every `[id]`-effect cleanup — the "capture
  // requestId + id at call time, compare before every set*" pattern makes a
  // stale (superseded by a newer id/refresh) commit inert, including after
  // unmount.
  const reqIdRef = useRef(0);
  // Client receipt time of the last successful fetch (initial or silent) —
  // throttles rapid foreground toggling; see leaderboard-refresh.ts.
  const lastRefreshAtRef = useRef<number | null>(null);
  // Mirrors latest loading/tournament/memberRounds so the visibilitychange
  // listener (a DOM listener that must never close over a stale render) reads
  // current values — same pattern as RoundPageClient's `weatherLatestRef`.
  const latestRef = useRef({ loading, tournament, memberRounds });
  useEffect(() => {
    latestRef.current = { loading, tournament, memberRounds };
  }, [loading, tournament, memberRounds]);

  const fetchAndApply = useCallback(
    async (opts: { initial: boolean }) => {
      const { initial } = opts;
      if (!initial) {
        if (refreshInFlightRef.current) return;
        refreshInFlightRef.current = true;
      }
      const requestId = ++reqIdRef.current;
      const requestTournamentId = id;
      const isCurrent = () =>
        requestId === reqIdRef.current && requestTournamentId === id;

      if (initial) setLoading(true);
      try {
        const t = await getTournamentAsync(requestTournamentId);
        if (!isCurrent()) return;

        if (!t) {
          if (initial) {
            setNotFound(true);
          }
          // Silent path: keep last good tournament/standings — `notFound` is
          // initial-load-only, never set it from a foreground refresh.
          lastRefreshAtRef.current = Date.now();
          return;
        }

        if (t.roundIds.length === 0) {
          setTournament(t);
          if (!initial) {
            // Genuinely no rounds — initial path already lands on the []
            // defaults (skips the whole rounds block, same as before); on
            // refresh, explicitly clear so a tournament emptied of rounds
            // since the last load doesn't leave stale standings.
            setMemberRounds([]);
            setStandings([]);
          }
          lastRefreshAtRef.current = Date.now();
          return;
        }

        // One GET /api/rounds then filter — avoids N round fetches.
        const allRounds = await getRoundsAsync();
        if (!isCurrent()) return;
        const roundIdSet = new Set(t.roundIds);
        // Belt-and-suspenders: also accept rounds whose tournamentId matches.
        const members = allRounds
          .filter((r) => roundIdSet.has(r.id) || r.tournamentId === requestTournamentId)
          .sort(
            (a, b) =>
              new Date(a.createdAt).getTime() -
              new Date(b.createdAt).getTime()
          );

        if (!initial) {
          const previousMemberCount = latestRef.current.memberRounds.length;
          if (!isPlausibleRefresh(t.roundIds.length, members.length, previousMemberCount)) {
            // Degraded fetch — almost certainly storage-api's local-cache
            // fallback after an API failure, not a real mass deletion. Keep
            // last good standings.
            console.warn(
              "[TournamentPageClient] silent refresh looked degraded — skipping commit"
            );
            lastRefreshAtRef.current = Date.now();
            return;
          }
        }

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

        // Resolve per-player handicap the same way as names: first defined
        // `handicap` found on a round-player record for that id. Only
        // round.players[].handicap is used (see tournament-standings.ts
        // header) — never estimateHandicapFromRounds (owner-only).
        // NOTE: the backend serialises an unset handicap as `null` (not
        // omitted), so we filter with `!= null` — a null must be treated as
        // "no handicap" (honest "—"), never stored as a value (which would
        // later Math.round(null) === 0 and fabricate a scratch golfer).
        const playerHandicaps: Record<string, number> = {};
        for (const r of members) {
          for (const p of r.players) {
            if (playerHandicaps[p.id] === undefined && p.handicap != null) {
              playerHandicaps[p.id] = p.handicap;
            }
          }
        }

        // If tournament has no explicit playerIds, union from member rounds.
        const effectivePlayerIds =
          t.playerIds.length > 0
            ? t.playerIds
            : Array.from(
                new Set(members.flatMap((r) => r.players.map((p) => p.id)))
              );

        const newStandings = computeStandings(
          effectivePlayerIds,
          resolvedNames,
          playerHandicaps,
          members
        );

        if (!isCurrent()) return;
        // Commit order: tournament, then member rounds, then the derived
        // standings that depend on both.
        setTournament(t);
        setMemberRounds(members);
        setStandings(newStandings);
        lastRefreshAtRef.current = Date.now();
      } catch (e) {
        console.error(
          `[TournamentPageClient] ${initial ? "load" : "silent refresh"} failed:`,
          e
        );
        // Silent path: console.warn-equivalent (console.error above) only —
        // keep last good state, never setNotFound.
        if (initial) setNotFound(true);
      } finally {
        if (initial) setLoading(false);
        if (!initial) refreshInFlightRef.current = false;
      }
    },
    [id]
  );

  useEffect(() => {
    // Skip the static prerender placeholder — real id arrives on the client
    if (!id || id === "placeholder") return;
    void fetchAndApply({ initial: true });
    return () => {
      // Bump so any in-flight fetch for this id (initial or a silent refresh
      // that started before id changed/unmount) commits nothing further.
      // Intentionally reads the LIVE ref value at cleanup time (not a
      // snapshot) — this is a plain mutable counter, not a DOM node handle.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      reqIdRef.current++;
    };
  }, [id, fetchAndApply]);

  // Background/foreground catch-up: silently refetch + recompute standings
  // so scores entered elsewhere (another device, another tab) appear on
  // return to this page. No polling — visibilitychange only, matching
  // RoundPageClient's weather foreground catch-up. Never touches loading/
  // notFound; a no-op refresh is invisible (orderSignature unchanged →
  // haptics effect below early-returns, FLIP has nothing to move).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const { loading: isLoading, tournament: currentTournament } = latestRef.current;
      if (isLoading || currentTournament == null) return;
      if (!shouldRefreshLeaderboard(lastRefreshAtRef.current, Date.now())) return;
      void fetchAndApply({ initial: false });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchAndApply]);

  // Sort standings: nulls last, then ascending by selected mode.
  // Hoisted above the loading/not-found early returns so the haptics effects
  // below (which depend on it) can be declared unconditionally per hook rules.
  const sortedStandings = sortStandings(standings, lbMode);
  const leader = sortedStandings[0] ?? null;
  const orderSignature = sortedStandings.map((s) => s.playerId).join(",");
  const leaderId = leader?.playerId ?? null;

  // Tournament-level settlement — hoisted for the same reason (the
  // settle-up-appeared haptic effect below needs it before any early return).
  const tournamentSettlement = computeTournamentSettlement(memberRounds);

  // ── Leaderboard re-sort haptics — fire ONLY on real order/leader changes ──
  // Never on tab switch, mode toggle, or any re-render with the same order:
  // deps are the derived signature strings, and we early-return when unchanged.
  // The gross↔toPar toggle re-sorts the SAME data and legitimately changes
  // orderSignature (e.g. tie-breaks differ) — that's a view change, not a
  // standings transition, so it must never buzz. We track `mode` in the ref;
  // on a mode change we rebase the baseline silently (no haptic) so the next
  // REAL change is measured against the correct pre-toggle order.
  const prevOrderRef = useRef<{
    signature: string;
    leaderId: string | null;
    mode: LbMode;
  } | null>(null);
  useEffect(() => {
    const prev = prevOrderRef.current;
    if (prev === null) {
      // First mount / first real standings — just record, fire nothing.
      prevOrderRef.current = { signature: orderSignature, leaderId, mode: lbMode };
      return;
    }
    if (prev.mode !== lbMode) {
      // Pure view toggle (gross ↔ toPar) — rebase silently, no haptic.
      prevOrderRef.current = { signature: orderSignature, leaderId, mode: lbMode };
      return;
    }
    if (prev.signature === orderSignature) {
      // No change — do nothing.
      return;
    }

    const prevIds = prev.signature ? prev.signature.split(",") : [];
    const newIds = orderSignature ? orderSignature.split(",") : [];
    const prevRank = new Map(prevIds.map((pid, i) => [pid, i]));

    const newLeaderEmerged =
      prev.leaderId !== null && leaderId !== null && leaderId !== prev.leaderId;

    let anyMovedUp = false;
    for (const pid of newIds) {
      const oldIdx = prevRank.get(pid);
      const newIdx = newIds.indexOf(pid);
      if (oldIdx !== undefined && newIdx < oldIdx) {
        anyMovedUp = true;
        break;
      }
    }
    const overtakeDetected = anyMovedUp && hasCrossing(newIds, prevRank);

    // At most one haptic per recompute — never spam.
    if (newLeaderEmerged) {
      haptic("success");
    } else if (overtakeDetected) {
      haptic("medium");
    } else if (anyMovedUp) {
      haptic("light");
    }

    prevOrderRef.current = { signature: orderSignature, leaderId, mode: lbMode };
  }, [orderSignature, leaderId, lbMode]);

  // ── Settle-up-appeared haptic — fires once per appearance, not per render ─
  const settlementShownRef = useRef(false);
  const settlementVisible =
    !tournamentSettlement.isEmpty && tournamentSettlement.transfers.length > 0;
  useEffect(() => {
    if (settlementVisible && !settlementShownRef.current) {
      haptic("light");
      settlementShownRef.current = true;
    } else if (!settlementVisible) {
      settlementShownRef.current = false;
    }
  }, [settlementVisible]);

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
  const hasMoneyGame = hasMoneyGames(memberRounds);
  // Per-round games (specs/tournament-per-round-format-plan.md §4) — each
  // tournament round can carry its own format; "settlement" is a synthetic
  // persisted-settlement game row, not a real game, so it's excluded here.
  const roundGames = memberRounds.flatMap((r) =>
    (r.games ?? []).filter((g) => g.format !== "settlement")
  );
  // sortedStandings / leader / tournamentSettlement are hoisted above (before
  // the early returns) so the order/settlement haptics effects can see them.

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
        {/* Gate on the ACTIVE mode's total: in Net mode, when no player has a
            handicap the leader has a null net and nobody is ranked — don't
            fabricate a "Leading … NET —" callout for an unranked field. */}
        {hasScores &&
          leader &&
          (lbMode === "net"
            ? leader.totalNet !== null
            : leader.totalStrokes !== null) && (
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
            {reduce ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <LeaderAvatar leader={leader} />
                <LeaderName leader={leader} />
              </div>
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={leader.playerId}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.35, ease: T.ease }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  <LeaderAvatar leader={leader} />
                  <LeaderName leader={leader} />
                </motion.div>
              </AnimatePresence>
            )}
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.paperMid,
                }}
              >
                {lbMode === "gross"
                  ? "STROKES"
                  : lbMode === "toPar"
                  ? "TO PAR"
                  : "NET"}
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
                  : lbMode === "toPar"
                  ? formatToPar(leader.totalToPar)
                  : leader.totalNet ?? "—"}
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
              onClick={() => {
                if (t !== tab) haptic("light");
                setTab(t);
              }}
              style={{
                position: "relative",
                overflow: "hidden",
                flex: 1,
                padding: "12px 10px",
                borderRadius: 10,
                cursor: "pointer",
                border: `1px solid ${tab === t ? T.ink : T.hairline}`,
                background: "transparent",
                color: tab === t ? T.paper : T.pencil,
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.3,
                textTransform: "uppercase",
                minHeight: 44,
              }}
            >
              {tab === t && (
                <motion.div
                  layoutId="tourney-tab-pill"
                  transition={reduce ? { duration: 0 } : T.springSoft}
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: T.ink,
                    borderRadius: 9,
                  }}
                />
              )}
              <span style={{ position: "relative" }}>{t}</span>
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
                  { k: "net" as LbMode, l: "Net" },
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
                    {lbMode === "net" ? "Net" : "Total"}
                  </div>
                </div>

                {/* Body rows */}
                {sortedStandings.map((s, idx) => {
                  const perRound =
                    lbMode === "gross"
                      ? s.roundTotals
                      : lbMode === "toPar"
                      ? s.roundToPar
                      : s.roundNet;
                  const total =
                    lbMode === "gross"
                      ? s.totalStrokes
                      : lbMode === "toPar"
                      ? s.totalToPar
                      : s.totalNet;
                  // Ranked status per the active mode — net mode is unranked
                  // (rank label "—") for a player with no handicap, even if
                  // they have gross/toPar scores.
                  const ranked = total !== null;
                  // Fix #5: tie-aware rank label ("T1"/"T2" for ties)
                  const rankLabel = tieRankLabel(sortedStandings, idx, lbMode);

                  return (
                    <motion.div
                      key={s.playerId}
                      layout={reduce ? false : "position"}
                      transition={T.springSoft}
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
                        <div style={{ flex: 1, minWidth: 0 }}>
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
                          {lbMode === "net" && (
                            // Subtle HCP indicator — only in Net mode, so a
                            // "—" total reads as "no handicap" rather than
                            // "no score". Calm/minimal per the yardage-book
                            // feel: tiny mono caption, no chip/badge chrome.
                            <div
                              style={{
                                fontFamily: T.mono,
                                fontSize: 8,
                                letterSpacing: 0.8,
                                color: T.pencilSoft,
                                marginTop: 1,
                                textTransform: "uppercase",
                              }}
                            >
                              {s.handicap !== null
                                ? `Hcp ${s.handicap}`
                                : "No hcp"}
                            </div>
                          )}
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
                    </motion.div>
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
            {!hasGames && roundGames.length === 0 ? (
              <EmptyState text="No games set up yet." />
            ) : (
              <>
                {tournamentGames.map((g: Game) => (
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
                    {g.settings?.pointValue != null && SETTLEABLE_FORMATS.has(g.format) && (
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
                ))}

                {/* Per-round games (specs/tournament-per-round-format-plan.md §4) —
                    each tournament round can carry its own format; the settlement
                    engine already reads these, this just surfaces them. */}
                {roundGames.map((g: Game) => {
                  const round = memberRounds.find((r) =>
                    (r.games ?? []).some((rg) => rg.id === g.id)
                  );
                  const roundIndex = round ? memberRounds.indexOf(round) + 1 : undefined;
                  return (
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
                          {FORMAT_LABELS[g.format] ?? g.format}
                        </div>
                      </div>
                      {g.settings?.pointValue != null && SETTLEABLE_FORMATS.has(g.format) && (
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
                      {/* Sub-line naming the round this format belongs to. */}
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8.5,
                          letterSpacing: 1,
                          color: T.pencilSoft,
                          marginTop: 4,
                          textTransform: "uppercase",
                        }}
                      >
                        {round?.courseName ?? "Round"}
                        {roundIndex ? ` · Round ${roundIndex}` : ""}
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {(hasGames || roundGames.length > 0) && (
              <div style={{ marginTop: 28 }}>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.4,
                    color: T.pencil,
                    textTransform: "uppercase",
                    marginBottom: 10,
                  }}
                >
                  Settle up
                </div>

                {tournamentSettlement.isEmpty ? (
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 14,
                      color: T.pencilSoft,
                      padding: "8px 0",
                    }}
                  >
                    {!hasMoneyGame
                      ? "No money games in this tournament."
                      : !hasScores
                      ? "Settle-up appears once rounds are scored."
                      : "All square — nothing to settle."}
                  </div>
                ) : (
                  <motion.div
                    variants={reduce ? undefined : settlementContainerVariants}
                    initial={reduce ? false : "hidden"}
                    animate={reduce ? false : "show"}
                  >
                    {tournamentSettlement.transfers.map((t, i) => {
                      const fromName =
                        standings.find((s) => s.playerId === t.fromPlayerId)?.name ??
                        tournament.playerNamesById?.[t.fromPlayerId] ??
                        t.fromPlayerId;
                      const toName =
                        standings.find((s) => s.playerId === t.toPlayerId)?.name ??
                        tournament.playerNamesById?.[t.toPlayerId] ??
                        t.toPlayerId;
                      return (
                        <motion.div
                          key={`${t.fromPlayerId}-${t.toPlayerId}-${i}`}
                          variants={reduce ? undefined : settlementItemVariants}
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            justifyContent: "space-between",
                            padding: "10px 0",
                            borderBottom:
                              i < tournamentSettlement.transfers.length - 1
                                ? `1px dashed ${T.hairline}`
                                : "none",
                          }}
                        >
                          <div
                            style={{
                              fontFamily: T.serif,
                              fontStyle: "italic",
                              fontSize: 15,
                              color: T.ink,
                            }}
                          >
                            {fromName} pays {toName}
                          </div>
                          <div
                            style={{
                              fontFamily: T.mono,
                              fontSize: 13,
                              letterSpacing: 0.4,
                              color: T.pencil,
                              flexShrink: 0,
                              marginLeft: 12,
                            }}
                          >
                            ${t.amount.toFixed(2)}
                          </div>
                        </motion.div>
                      );
                    })}
                  </motion.div>
                )}
              </div>
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

function LeaderAvatar({ leader }: { leader: PlayerStanding }) {
  return (
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
  );
}

function LeaderName({ leader }: { leader: PlayerStanding }) {
  return (
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
