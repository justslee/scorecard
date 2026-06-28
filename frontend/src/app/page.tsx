"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import { getRoundsAsync, getTournamentsAsync, getGolferProfileAsync, deleteRoundAsync } from "@/lib/storage-api";
import { calculateTotals } from "@/lib/types";
import type { Round, Tournament, GolferProfile } from "@/lib/types";
import SwipeableRow from "@/components/SwipeableRow";

// ── Derived-data helpers ──────────────────────────────────────────────────────

/**
 * One row in the "Recent rounds" list, shaped from a real Round.
 */
type RecentRow = {
  id: string;
  dateMonth: string; // "Oct"
  dateDay: string;   // "13"
  course: string;
  score: number | null;  // total strokes (null when no scores yet)
  net: string | null;    // "+4" / "-1" / "E" (null when no scores yet)
  holesPlayed: number;
  tag: string | null;    // "T" for tournament rounds
  isActive: boolean;
};

function deriveRecentRows(rounds: Round[]): RecentRow[] {
  return rounds.slice(0, 5).map((r) => {
    const d = new Date(r.date);
    const dateMonth = d.toLocaleString("en-US", { month: "short" });
    const dateDay = String(d.getDate());

    let score: number | null = null;
    let net: string | null = null;
    let holesPlayed = r.holes.length || 18;

    if (r.players.length > 0 && r.scores.length > 0) {
      // players[0] is the owner in the single-owner beta; revisit when user-identity lands.
      const totals = calculateTotals(r.scores, r.holes, r.players[0].id);
      if (totals.playedHoles > 0) {
        score = totals.total;
        if (totals.toPar === 0) net = "E";
        else net = totals.toPar > 0 ? `+${totals.toPar}` : `${totals.toPar}`;
        holesPlayed = totals.playedHoles;
      }
    }

    return {
      id: r.id,
      dateMonth,
      dateDay,
      course: r.courseName,
      score,
      net,
      holesPlayed,
      tag: r.tournamentId ? "T" : null,
      isActive: r.status === "active",
    };
  });
}

/**
 * Scoring stats over the most recent completed rounds (≥ 9 holes played).
 * Returns both the stroke average and the average score relative to par,
 * derived from the SAME eligible rounds so the two numbers are consistent.
 * Returns null when there is not enough data.
 */
function deriveScoringStats(rounds: Round[]): { avg: number; toParAvg: number } | null {
  const eligible = rounds
    .filter((r) => r.status === "completed" && r.players.length > 0)
    .slice(0, 20);
  if (eligible.length === 0) return null;
  // players[0] is the owner in the single-owner beta; revisit when user-identity lands.
  const totals = eligible
    .map((r) => calculateTotals(r.scores, r.holes, r.players[0].id))
    .filter((t) => t.playedHoles >= 9);
  if (totals.length === 0) return null;
  const avg = totals.reduce((s, t) => s + t.total, 0) / totals.length;
  const toParAvg = totals.reduce((s, t) => s + t.toPar, 0) / totals.length;
  return {
    avg: Math.round(avg * 10) / 10,
    toParAvg: Math.round(toParAvg * 10) / 10,
  };
}

// ── Page component ────────────────────────────────────────────────────────────

export default function HomePage() {
  const accent = DEFAULT_ACCENT;
  const router = useRouter();

  const [rounds, setRounds] = useState<Round[]>([]);
  const [recentTournament, setRecentTournament] = useState<Tournament | null>(null);
  const [profile, setProfile] = useState<GolferProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveRoundId, setLiveRoundId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** loadError: true when the data-fetch threw unexpectedly (e.g. corrupt
   *  localStorage, race condition in processing code).  storage-api handles
   *  normal API failures internally (falls back to cache) so this is a safety
   *  net that prevents the screen from staying stuck on the loading state. */
  const [loadError, setLoadError] = useState(false);
  /** Incrementing this triggers the useEffect to re-run load() (Retry path). */
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    async function load() {
      // storage-api functions are API-first + localStorage fallback; they handle
      // their own errors internally and never throw for normal API failures.
      // The outer try/catch is a safety net for unexpected runtime errors (e.g.
      // corrupt localStorage schema causing JSON parse failures, sort throwing on
      // malformed dates) so setLoading(false) always fires and we never show a
      // blank/stuck loading state.
      try {
        const [rs, ts, p] = await Promise.all([
          getRoundsAsync(),
          getTournamentsAsync(),
          getGolferProfileAsync(),
        ]);

        // Most-recent first so the list and live-round search are in correct order.
        const sorted = [...rs].sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        );

        setRounds(sorted);
        setProfile(p);

        if (ts.length > 0) {
          const sortedT = [...ts].sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
          setRecentTournament(sortedT[0]);
        }

        // Surface the active round "resume" banner if one exists.
        const live = sorted.find((r) => r.status === "active");
        if (live) setLiveRoundId(live.id);

        setLoadError(false); // clear any prior error on success
      } catch (e) {
        console.error("[home] load failed:", e);
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    }

    load();
  // loadKey is incremented by the Retry button to re-trigger this effect.
  }, [loadKey]);

  // ── Delete round — optimistic remove; logs error on API failure ──────────
  // deleteRoundAsync removes from local cache first, then fires the API call
  // (which it handles internally — it never throws). So the remove is
  // effectively permanent from this page's perspective; the rollback path
  // guards against unexpected runtime errors only.
  async function handleDeleteRound(id: string) {
    const removed = rounds.find((r) => r.id === id);
    setRounds((rs) => rs.filter((r) => r.id !== id));
    if (liveRoundId === id) setLiveRoundId(null);
    setDeleteError(null);
    try {
      await deleteRoundAsync(id);
    } catch (e) {
      // Rollback: restore the round (most-recent-first order is already sorted).
      if (removed) {
        setRounds((rs) => {
          const without = rs.filter((r) => r.id !== id);
          // Re-insert in date order (descending).
          const idx = without.findIndex(
            (r) => new Date(r.date).getTime() < new Date(removed.date).getTime()
          );
          if (idx === -1) return [...without, removed];
          const next = [...without];
          next.splice(idx, 0, removed);
          return next;
        });
      }
      if (removed?.status === "active") setLiveRoundId(id);
      setDeleteError(
        e instanceof Error ? e.message : "Could not remove round. Try again."
      );
    }
  }

  const now = new Date();
  const hr = now.getHours();
  const timeOfDay = hr < 11 ? "Morning" : hr < 17 ? "Afternoon" : "Evening";

  const recentRows = deriveRecentRows(rounds);
  const scoringStats = deriveScoringStats(rounds);
  const scoringAvg = scoringStats?.avg ?? null;
  const toParAvg = scoringStats?.toParAvg ?? null;
  const handicap = profile?.handicap ?? null;

  // Tournament quick-action destination: most recent tournament, or the create page.
  function handleTournamentTap() {
    if (recentTournament) {
      router.push(`/tournament/${recentTournament.id}`);
    } else {
      router.push("/tournament/new");
    }
  }

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
      <div style={{ maxWidth: 420, margin: "0 auto", position: "relative", paddingBottom: "env(safe-area-inset-bottom, 16px)" }}>
        {/* ── MASTHEAD ─────────────────────────────── */}
        <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 14px", position: "relative" }}>
          {/* Profile № card */}
          <Link
            href="/profile"
            aria-label="Open your profile"
            style={{
              position: "absolute",
              top: "max(14px, env(safe-area-inset-top))",
              right: 22,
              width: 44,
              height: 56,
              padding: 0,
              background: T.paperDeep,
              border: `1.5px solid ${T.ink}`,
              borderRadius: 2,
              cursor: "pointer",
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
              textDecoration: "none",
            }}
          >
            <span style={{ position: "absolute", top: 2, left: 2, right: 2, height: 1, background: accent }} />
            <span style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 24, color: T.ink, letterSpacing: -1, lineHeight: 1 }}>
              {handicap !== null ? handicap : "—"}
            </span>
            <span
              style={{
                position: "absolute",
                bottom: 2,
                left: 0,
                right: 0,
                textAlign: "center",
                fontFamily: T.mono,
                fontSize: 5,
                letterSpacing: 1.3,
                color: T.pencil,
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              My card
            </span>
          </Link>

          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 36,
              letterSpacing: -0.8,
              color: T.ink,
              lineHeight: 1,
              marginTop: 8,
            }}
          >
            {timeOfDay}.
          </div>
        </div>

        {/* ── PRIMARY CTA BLOCK ───────────────────── */}
        <div style={{ padding: "10px 22px 18px" }}>
          <button
            onClick={() => router.push("/round/new")}
            style={{
              width: "100%",
              padding: "18px 18px",
              borderRadius: 16,
              border: "none",
              background: T.ink,
              color: T.paper,
              textAlign: "left",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div style={{ position: "relative", flexShrink: 0 }}>
              <motion.span
                animate={{ scale: [1, 1.3, 1], opacity: [0.4, 0.1, 0.4] }}
                transition={{ duration: 2, repeat: Infinity }}
                style={{ position: "absolute", inset: -5, borderRadius: 99, background: accent }}
              />
              <div
                style={{
                  position: "relative",
                  width: 42,
                  height: 42,
                  borderRadius: 99,
                  background: accent,
                  color: T.paper,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0" />
                  <path d="M12 18v3" />
                </svg>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: "rgba(244,241,234,0.5)", textTransform: "uppercase" }}>
                Hey caddy
              </div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.paper, letterSpacing: -0.4, lineHeight: 1.1, marginTop: 2 }}>
                Start a round, call a shot
              </div>
            </div>
            <svg width="12" height="12" viewBox="0 0 12 12" style={{ color: "rgba(244,241,234,0.4)" }}>
              <path d="M3 2 L8 6 L3 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* Secondary row */}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <QuickAction icon="round" label="New round" sub="Solo or with friends" onClick={() => router.push("/round/new")} />
            <QuickAction
              icon="tournament"
              label="Tournament"
              sub={recentTournament ? recentTournament.name : "Multi-round"}
              accent={accent}
              onClick={handleTournamentTap}
            />
          </div>

          {/* Dispatch looper */}
          <button
            onClick={() => router.push("/tee-time")}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "12px 14px",
              borderRadius: 12,
              border: `1.5px solid ${T.ink}`,
              background: T.paper,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              textAlign: "left",
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 99,
                background: T.ink,
                color: T.paper,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 18,
                letterSpacing: -0.3,
                flexShrink: 0,
              }}
            >
              L
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
                Dispatch looper
              </div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 16, color: T.ink, letterSpacing: -0.2, lineHeight: 1.1, marginTop: 2 }}>
                Find me a tee time this weekend
              </div>
            </div>
            <svg width="10" height="10" viewBox="0 0 12 12" style={{ color: T.pencil, flexShrink: 0 }}>
              <path d="M3 2 L8 6 L3 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {liveRoundId && (
            <Link
              href={`/round/${liveRoundId}`}
              style={{
                marginTop: 8,
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 14px",
                borderRadius: 12,
                border: `1px dashed ${accent}`,
                background: `${accent}11`,
                color: T.ink,
                textDecoration: "none",
              }}
            >
              <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: accent, textTransform: "uppercase" }}>Resume</span>
              <span style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15, color: T.ink, letterSpacing: -0.2 }}>your round in progress</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: T.mono, fontSize: 9, color: T.pencil }}>→</span>
            </Link>
          )}
        </div>

        {/* ── STATS AT A GLANCE ───────────────────── */}
        <button
          onClick={() => router.push("/profile")}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "12px 22px 16px",
            borderTop: `1px solid ${T.hairline}`,
            borderBottom: `1px solid ${T.hairline}`,
            borderLeft: "none",
            borderRight: "none",
            background: T.paperDeep,
            cursor: "pointer",
            fontFamily: "inherit",
            color: "inherit",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase" }}>Your card</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft }}>
                {rounds.filter((r) => r.status === "completed").length > 0
                  ? `last ${Math.min(rounds.filter((r) => r.status === "completed").length, 20)} rounds`
                  : "no rounds yet"}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 9px",
                  borderRadius: 99,
                  border: `1px solid ${T.ink}`,
                  background: T.paper,
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.ink,
                  textTransform: "uppercase",
                  fontWeight: 500,
                }}
              >
                Open my book {"→"}
              </span>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "flex-end" }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>Handicap index</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <div style={{ fontFamily: T.serif, fontSize: 44, letterSpacing: -1.2, color: T.ink, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                  {loading ? "—" : handicap !== null ? handicap : "—"}
                </div>
              </div>
              {/* Sparkline hidden until we have historical handicap data */}
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>Scoring avg</div>
              <div style={{ fontFamily: T.serif, fontSize: 44, letterSpacing: -1.2, color: T.ink, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                {loading ? "—" : scoringAvg !== null ? scoringAvg : "—"}
              </div>
              {toParAvg !== null && (
                <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, marginTop: 2 }}>
                  {toParAvg >= 0 ? `+${toParAvg.toFixed(1)}` : toParAvg.toFixed(1)} to par avg
                </div>
              )}
              {!loading && scoringAvg === null && (
                <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, marginTop: 2 }}>
                  No rounds yet
                </div>
              )}
            </div>
          </div>

          {/* Fairways / GIR / Putts omitted until per-shot tracking is available. */}
        </button>

        {/* ── RECENT ROUNDS ──────────────────────── */}
        <div style={{ padding: "20px 22px 10px" }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase" }}>Recent rounds</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.4, lineHeight: 1, marginTop: 2 }}>
              The pages behind you
            </div>
          </div>

          {/* Delete error banner */}
          {deleteError && (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                marginBottom: 16,
                borderRadius: 12,
                background: T.errorWash,
                border: `1px solid ${T.errorInk}30`,
                color: T.errorInk,
                fontSize: 13,
              }}
            >
              {deleteError}
            </div>
          )}

          {/* Loading skeleton — calm paper-toned placeholders while data fetches */}
          {loading && (
            <div aria-label="Loading rounds">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "48px 1fr auto",
                    gap: 12,
                    padding: "12px 0",
                    borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                    opacity: 1 - i * 0.28,
                  }}
                >
                  <div>
                    <div style={{ width: 22, height: 10, background: T.hairlineSoft, borderRadius: 2 }} />
                    <div style={{ width: 28, height: 20, background: T.hairlineSoft, borderRadius: 2, marginTop: 4 }} />
                  </div>
                  <div>
                    <div style={{ width: 112, height: 13, background: T.hairlineSoft, borderRadius: 2 }} />
                    <div style={{ width: 34, height: 9, background: T.hairlineSoft, borderRadius: 2, marginTop: 6 }} />
                  </div>
                  <div style={{ width: 28, height: 26, background: T.hairlineSoft, borderRadius: 2 }} />
                </div>
              ))}
            </div>
          )}

          {/* Load error — fetch failed AND no cached data to show */}
          {!loading && loadError && recentRows.length === 0 && (
            <div
              style={{
                padding: "28px 0 24px",
                textAlign: "center",
                borderTop: `1px dashed ${T.hairline}`,
              }}
            >
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 18, color: T.pencil, letterSpacing: -0.2, lineHeight: 1.4 }}>
                Couldn&rsquo;t load rounds.
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", marginTop: 6 }}>
                Check connection and try again.
              </div>
              <button
                onClick={() => { setLoading(true); setLoadKey((k) => k + 1); }}
                style={{
                  marginTop: 16,
                  padding: "11px 22px",
                  borderRadius: 99,
                  border: `1px solid ${T.hairline}`,
                  background: "transparent",
                  color: T.ink,
                  fontFamily: T.mono,
                  fontSize: 10,
                  letterSpacing: 1.3,
                  cursor: "pointer",
                  textTransform: "uppercase",
                  minHeight: 44,
                }}
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty state — no rounds yet (no error, just none created) */}
          {!loading && !loadError && recentRows.length === 0 && (
            <div
              style={{
                padding: "28px 0 24px",
                textAlign: "center",
                borderTop: `1px dashed ${T.hairline}`,
              }}
            >
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 18, color: T.pencil, letterSpacing: -0.2, lineHeight: 1.4 }}>
                No rounds yet.
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", marginTop: 6 }}>
                Tap &ldquo;Start a round&rdquo; above to begin.
              </div>
            </div>
          )}

          {/* Offline note — fetch errored but cached data is showing; quiet pencil annotation */}
          {!loading && loadError && recentRows.length > 0 && (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "7px 12px",
                marginBottom: 10,
                borderRadius: 8,
                background: T.warningWash,
                border: `1px solid ${T.warningInk}22`,
              }}
            >
              <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.warningInk, textTransform: "uppercase" }}>
                Offline — showing saved data
              </span>
              <button
                onClick={() => setLoadKey((k) => k + 1)}
                style={{
                  background: "none",
                  border: `1px solid ${T.warningInk}55`,
                  color: T.warningInk,
                  cursor: "pointer",
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.2,
                  textTransform: "uppercase",
                  padding: "4px 10px",
                  borderRadius: 99,
                  lineHeight: 1,
                  minHeight: 44,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                Retry
              </button>
            </div>
          )}

          {/* Round rows — swipe-to-delete wired via SwipeableRow */}
          <div>
            {recentRows.map((r, i) => (
              // Separator lives on the outer wrapper so SwipeableRow's
              // overflow:hidden doesn't clip it during the swipe animation.
              <div
                key={r.id}
                style={{ borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}` }}
              >
                <SwipeableRow
                  onDelete={() => handleDeleteRound(r.id)}
                  confirmMessage={
                    r.isActive
                      ? `${r.course} is in progress — remove this round and all its scores?`
                      : `Remove your round at ${r.course} on ${r.dateMonth} ${r.dateDay}?`
                  }
                >
                  <motion.button
                    whileTap={{ scale: 0.985 }}
                    onClick={() => router.push(`/round/${r.id}`)}
                    style={{
                      width: "100%",
                      display: "grid",
                      gridTemplateColumns: "48px 1fr auto",
                      gap: 12,
                      padding: "12px 0",
                      minHeight: 44,
                      alignItems: "center",
                      textAlign: "left",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                    }}
                  >
                    <div>
                      <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>
                        {r.dateMonth}
                      </div>
                      <div style={{ fontFamily: T.serif, fontSize: 22, color: T.ink, lineHeight: 1, letterSpacing: -0.4, fontVariantNumeric: "tabular-nums" }}>
                        {r.dateDay}
                      </div>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ fontFamily: T.serif, fontSize: 16, letterSpacing: -0.2, color: T.ink }}>{r.course}</div>
                        {r.tag && (
                          <div
                            style={{
                              fontFamily: T.mono,
                              fontSize: 8,
                              letterSpacing: 1,
                              color: accent,
                              textTransform: "uppercase",
                              border: `1px solid ${accent}`,
                              padding: "1px 4px",
                              borderRadius: 3,
                            }}
                          >
                            {r.tag}
                          </div>
                        )}
                        {r.isActive && (
                          <div
                            style={{
                              fontFamily: T.mono,
                              fontSize: 8,
                              letterSpacing: 1,
                              color: T.warningInk,
                              textTransform: "uppercase",
                              border: `1px solid ${T.warningInk}`,
                              padding: "1px 4px",
                              borderRadius: 3,
                            }}
                          >
                            Live
                          </div>
                        )}
                      </div>
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8.5,
                          color: T.pencilSoft,
                          letterSpacing: 0.8,
                          marginTop: 2,
                          lineHeight: 1.25,
                        }}
                      >
                        {r.holesPlayed}H
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontFamily: T.serif, fontSize: 26, color: T.ink, lineHeight: 1, letterSpacing: -0.6, fontVariantNumeric: "tabular-nums" }}>
                        {r.score !== null ? r.score : "—"}
                      </div>
                      {r.net && (
                        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.1, color: T.pencilSoft, marginTop: 1 }}>{r.net}</div>
                      )}
                    </div>
                  </motion.button>
                </SwipeableRow>
              </div>
            ))}
          </div>
        </div>

        {/* ── TROPHY CASE ─────────────────────────── */}
        {recentTournament ? (
          <div
            onClick={handleTournamentTap}
            style={{
              margin: "14px 22px",
              padding: "14px 16px",
              background: T.ink,
              color: T.paper,
              borderRadius: 14,
              position: "relative",
              overflow: "hidden",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                position: "absolute",
                right: -10,
                top: -20,
                bottom: -10,
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 120,
                lineHeight: 1,
                color: "rgba(244,241,234,0.04)",
                letterSpacing: -6,
                pointerEvents: "none",
                userSelect: "none",
              }}
            >
              {recentTournament.roundIds.length > 0 ? recentTournament.roundIds.length : ""}
            </div>
            <div style={{ position: "relative" }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: "rgba(244,241,234,0.55)", textTransform: "uppercase" }}>
                Trophy case
              </div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 18, letterSpacing: -0.3, lineHeight: 1.2, marginTop: 2 }}>
                {recentTournament.name}
              </div>
              <div
                style={{
                  marginTop: 10,
                  padding: "3px 8px",
                  borderRadius: 99,
                  border: `1px dashed ${accent}`,
                  background: `${accent}22`,
                  color: accent,
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1.2,
                  textTransform: "uppercase",
                  display: "inline-block",
                }}
              >
                {recentTournament.roundIds.length} round{recentTournament.roundIds.length !== 1 ? "s" : ""} · Open
              </div>
            </div>
          </div>
        ) : (
          !loading && (
            <div
              onClick={() => router.push("/tournament/new")}
              style={{
                margin: "14px 22px",
                padding: "14px 16px",
                background: T.paperDeep,
                color: T.ink,
                borderRadius: 14,
                border: `1px dashed ${T.hairline}`,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>
                  Trophy case
                </div>
                <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 16, color: T.pencil, letterSpacing: -0.2, marginTop: 2 }}>
                  No tournaments yet.
                </div>
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencilSoft }}>
                Start one →
              </div>
            </div>
          )
        )}

        {/*
          ── "From the group" feed ──────────────────
          Removed: no real social data source exists yet.
          The FEED constant showed fabricated entries (Jack, Sam, Justin).
          A genuine social feed requires a multi-user backend — not available.
          Decision logged for owner / designer: remove rather than show fakes.
          Re-introduce when a real activity stream is backed by the API.
        */}
      </div>
    </div>
  );
}

function QuickAction({ icon, label, sub, accent, onClick }: { icon: "round" | "tournament"; label: string; sub: string; accent?: string; onClick?: () => void }) {
  const isTournament = icon === "tournament";
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "12px 12px",
        borderRadius: 12,
        cursor: "pointer",
        textAlign: "left",
        border: `1px solid ${T.hairline}`,
        background: T.paper,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            background: isTournament ? accent : "transparent",
            color: isTournament ? T.paper : T.ink,
            border: isTournament ? "none" : `1px solid ${T.hairline}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {isTournament ? (
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M3 2h6v3a3 3 0 0 1-6 0V2zM4 8h4v2H4z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="6" cy="6" r="4" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
            </svg>
          )}
        </div>
        <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, letterSpacing: -0.1, color: T.ink }}>{label}</div>
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.1, color: T.pencilSoft, textTransform: "uppercase",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
    </button>
  );
}

