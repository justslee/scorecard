"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT, CADDIES, Caddy } from "@/components/yardage/tokens";
import { HOLES } from "@/components/yardage/HoleIllustration";
import HoleCard from "@/components/yardage/HoleCard";
import { VoiceOrb, VoiceSheet, VoiceState, VoiceTurn } from "@/components/yardage/Voice";
import { PlayerPanel, StakesTicker, SeedPlayer } from "@/components/yardage/Scorecard";
import ScoreSheet from "@/components/yardage/ScoreSheet";
import LeaderboardSheet from "@/components/yardage/LeaderboardSheet";
import { Round, Score } from "@/lib/types";
import { getRound as localGetRound, saveRound as localSaveRound } from "@/lib/storage";
import {
  getRound as apiGetRound,
  addScore as apiAddScore,
  completeRound as apiCompleteRound,
} from "@/lib/api";
import { hapticCelebration } from "@/lib/haptics";

// Player accent colors (yardage-book palette — warm ink tones)
const PLAYER_COLORS = ["#1a2a1a", "#6b3a1a", "#3a3a6a", "#6a3a3a", "#2a5a3a", "#5a2a5a"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Build a per-player score array: { [playerId]: (number|null)[] } indexed hole 0…holeCount-1. */
function buildScoreMap(
  playerIds: string[],
  roundScores: Score[],
  holeCount: number = 18
): Record<string, (number | null)[]> {
  const map: Record<string, (number | null)[]> = {};
  for (const pid of playerIds) {
    map[pid] = Array(holeCount).fill(null);
  }
  for (const s of roundScores) {
    const arr = map[s.playerId];
    const idx = s.holeNumber - 1;
    if (arr && idx >= 0 && idx < holeCount) arr[idx] = s.strokes;
  }
  return map;
}

/**
 * Build display scores: server snapshot with pending (entered-but-not-confirmed) scores
 * overlaid on top.  This ensures a transient API failure never wipes a just-entered score
 * from the UI, and an out-of-order server response can't clobber a newer local edit.
 */
function mergeWithPending(
  playerIds: string[],
  serverScores: Score[],
  pending: Map<string, Score>,
  holeCount: number = 18
): Record<string, (number | null)[]> {
  const map = buildScoreMap(playerIds, serverScores, holeCount);
  for (const s of pending.values()) {
    const arr = map[s.playerId];
    const idx = s.holeNumber - 1;
    if (arr && idx >= 0 && idx < holeCount) arr[idx] = s.strokes;
  }
  return map;
}

/**
 * Build the round for localStorage: server round with pending scores merged in so a page
 * reload re-discovers them even when they haven't reached the server yet.
 */
function buildLocalRound(serverRound: Round, pending: Map<string, Score>): Round {
  if (pending.size === 0) return serverRound;
  const serverKeySet = new Set(serverRound.scores.map((s) => `${s.playerId}:${s.holeNumber}`));
  const mergedScores: Score[] = [
    // Server scores, replaced where pending has a newer value.
    ...serverRound.scores.map((s) => {
      const p = pending.get(`${s.playerId}:${s.holeNumber}`);
      return p !== undefined ? p : s;
    }),
    // Pending scores not yet present in the server snapshot.
    ...[...pending.values()].filter(
      (s) => !serverKeySet.has(`${s.playerId}:${s.holeNumber}`) && s.strokes !== null
    ),
  ].filter((s) => s.strokes !== null); // drop explicit-null deletions
  return { ...serverRound, scores: mergedScores };
}

/** Convert Round.players → SeedPlayer[] for yardage components. */
function buildSeedPlayers(round: Round): SeedPlayer[] {
  return round.players.map((p, i) => ({
    id: p.id,
    name: p.name,
    hcp: p.handicap ?? 0,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
  }));
}

/**
 * Return true when the thrown error indicates the round doesn't exist on the server (404)
 * or the network itself is unavailable (TypeError).  Both → LOCAL mode.
 * Other HTTP errors (500, 401, …) return false — saves should still target the server.
 */
function isNotFoundOrNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true; // fetch itself failed (DNS/offline/CORS)
  if (e instanceof Error) {
    const m = e.message;
    if (m.includes("API error: 404")) return true;
    // FastAPI 404 with JSON body: '{"detail":"Round not found"}'
    try {
      const parsed = JSON.parse(m) as { detail?: string };
      return (parsed?.detail ?? "").toLowerCase().includes("not found");
    } catch {
      return m.toLowerCase().includes("not found");
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RoundPage() {
  const params = useParams();
  const router = useRouter();
  const accent = DEFAULT_ACCENT;
  const density: "dense" | "spacious" = "dense";
  const caddy: Caddy = CADDIES.find((c) => c.id === "steve") ?? CADDIES[0];

  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * isLocalRound: true when the round came from localStorage only — a 404 (orphan created
   * by wire-round-new offline fallback) or a network TypeError.  In this mode writes go to
   * localStorage only; the server never sees them.
   *
   * Note: non-404 HTTP errors (500, auth) leave isLocalRound=false so later writes still
   * target the server (the round IS on the server; we just temporarily can't reach it).
   */
  const [isLocalRound, setIsLocalRound] = useState(false);
  /** Surfaces per-stroke or load errors without silent swallow; null = no active error. */
  const [apiError, setApiError] = useState<string | null>(null);

  const [players, setPlayers] = useState<SeedPlayer[]>([]);
  const [scores, setScores] = useState<Record<string, (number | null)[]>>({});

  /**
   * Scores entered locally but not yet confirmed by the server.
   * Key = "{playerId}:{holeNumber}".  Overlaid on every server snapshot so a transient
   * API failure never causes a score to vanish from the UI.
   * A score is removed from pending ONLY once the server confirms that exact
   * (playerId, holeNumber, strokes) triple.
   */
  const pendingRef = useRef<Map<string, Score>>(new Map());

  /**
   * Monotonically increasing sequence number per addScore call.
   * Used to ignore stale out-of-order responses: a response with mySeq ≤ lastApplied is
   * skipped so a stale server snapshot can't overwrite state already set by a newer one.
   */
  const addScoreSeqRef = useRef(0);
  const lastAppliedSeqRef = useRef(0);

  const [currentHole, setCurrentHole] = useState(1);
  const [expanded, setExpanded] = useState(true);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [lbOpen, setLbOpen] = useState(false);
  const [slideDir, setSlideDir] = useState(0);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [turnIdx, setTurnIdx] = useState(0);
  const draggedRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Load round: try API → fall back to localStorage on 404 / network error.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const id = params.id as string;

    /**
     * After loading from the server, check localStorage for scores that are present locally
     * but missing from the server response — these are scores whose addScore call failed in a
     * previous session.  Re-add them to pendingRef and retry them in the background.
     */
    async function retrySyncPending(roundId: string, holeCount: number) {
      const snapshot = [...pendingRef.current.entries()];
      for (const [key, score] of snapshot) {
        if (!pendingRef.current.has(key)) continue; // handled by user re-entry meanwhile
        try {
          const updated = await apiAddScore(roundId, score);
          const cur = pendingRef.current.get(key);
          if (cur && cur.strokes === score.strokes) {
            pendingRef.current.delete(key);
          }
          setRound(updated);
          setScores(
            mergeWithPending(
              updated.players.map((p) => p.id),
              updated.scores,
              pendingRef.current,
              holeCount
            )
          );
          localSaveRound(buildLocalRound(updated, pendingRef.current));
        } catch (retryErr) {
          // Silently log — score stays in pending, will retry on next load or user edit.
          console.warn("[round] background sync pending failed:", retryErr);
        }
      }
    }

    async function load() {
      try {
        const r = await apiGetRound(id);
        const holeCount = r.holes.length || 18;

        // Re-discover scores from previous session that never reached the server.
        // They live in localStorage but are absent from the server snapshot.
        const localCopy = localGetRound(id);
        if (localCopy) {
          const serverKeys = new Set(r.scores.map((s) => `${s.playerId}:${s.holeNumber}`));
          for (const ls of localCopy.scores) {
            if (ls.strokes !== null && !serverKeys.has(`${ls.playerId}:${ls.holeNumber}`)) {
              pendingRef.current.set(`${ls.playerId}:${ls.holeNumber}`, ls);
            }
          }
        }

        setRound(r);
        setPlayers(buildSeedPlayers(r));
        setScores(
          mergeWithPending(r.players.map((p) => p.id), r.scores, pendingRef.current, holeCount)
        );
        setIsLocalRound(false);

        // Kick off background retry for any re-discovered pending scores.
        if (pendingRef.current.size > 0) {
          retrySyncPending(id, holeCount);
        }
      } catch (e) {
        if (isNotFoundOrNetworkError(e)) {
          // 404 (orphan/offline round) or network down → LOCAL mode.
          console.warn(`[round/${id}] falling back to local cache (404 or offline):`, e);
          const local = localGetRound(id);
          if (local) {
            const holeCount = local.holes.length || 18;
            setRound(local);
            setPlayers(buildSeedPlayers(local));
            setScores(buildScoreMap(local.players.map((p) => p.id), local.scores, holeCount));
            setIsLocalRound(true);
          }
          // If no local copy either, round stays null → not-found render.
        } else {
          // Non-404 HTTP error (500, auth, timeout): the round IS on the server but we
          // temporarily can't reach it.  Stay ONLINE (isLocalRound stays false) so later
          // writes still target the server; show error banner; render from localStorage.
          const msg = e instanceof Error ? e.message : "Failed to load round.";
          setApiError(
            msg.startsWith("{") || msg.length > 100
              ? "Failed to load round — check connection."
              : msg
          );
          console.error(`[round/${id}] load failed (non-404, staying ONLINE):`, e);
          const local = localGetRound(id);
          if (local) {
            const holeCount = local.holes.length || 18;
            setRound(local);
            setPlayers(buildSeedPlayers(local));
            setScores(buildScoreMap(local.players.map((p) => p.id), local.scores, holeCount));
            // isLocalRound stays false — round is on the server, saves should target it.
          }
        }
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [params.id]);

  // Derived: actual hole count for this round (fall back to 18 if round not yet loaded).
  const holeCount = round?.holes.length || 18;

  const hole = HOLES[currentHole - 1] ?? HOLES[0];
  // Prefer round's par data (authoritative); fall back to illustration constant.
  const holePar = round?.holes[currentHole - 1]?.par ?? hole.par;

  // Scripted conversation beats — identical to the prototype
  const script = useMemo(
    () => [
      {
        user: "What should I hit from here?",
        caddy: `155 to the pin, 6 off the right. I'd trust an easy ${hole.par === 3 ? "7-iron" : "8-iron"}. Stay below the flag — above the hole is a two-putt minimum.`,
      },
      {
        user: "How about a smooth 9?",
        caddy: `You'd need to flush it. Your stock 9 is 148 — with the crosswind you'd come up short and right. Stick with the 8, commit to it.`,
      },
      {
        user: "Alright. Mark me down for a four on eight when we finish.",
        caddy: `Got it — four for you on eight, saved. Nice swing, let's go.`,
      },
    ],
    [hole.par]
  );

  useEffect(() => {
    if (!voiceOpen) {
      setTurns([]);
      setTurnIdx(0);
      setVoiceState("idle");
      return;
    }
    let cancelled = false;
    const runBeat = (idx: number) => {
      if (cancelled || idx >= script.length) {
        setVoiceState("idle");
        return;
      }
      const beat = script[idx];
      setVoiceState("listening");
      setTurns((prev) => [...prev, { role: "user", text: "" }]);

      let i = 0;
      const typer = setInterval(() => {
        if (cancelled) {
          clearInterval(typer);
          return;
        }
        i += 1;
        setTurns((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "user", text: beat.user.slice(0, i) };
          return next;
        });
        if (i >= beat.user.length) {
          clearInterval(typer);
          setVoiceState("thinking");
          setTimeout(() => {
            if (cancelled) return;
            setTurns((prev) => [...prev, { role: "caddy", text: beat.caddy }]);
            setVoiceState("speaking");
            const speakMs = Math.max(2200, beat.caddy.length * 32);
            setTimeout(() => {
              if (cancelled) return;
              setTurnIdx(idx + 1);
              setTimeout(() => runBeat(idx + 1), 500);
            }, speakMs);
          }, 750);
        }
      }, 45);
    };
    runBeat(0);
    return () => {
      cancelled = true;
    };
  }, [voiceOpen, script]);

  const handleMicTap = () => {
    if (voiceState === "speaking" || voiceState === "listening") {
      setVoiceState("idle");
      return;
    }
    if (turnIdx < script.length) {
      // Re-enter the effect flow: the useEffect re-runs on voiceOpen change
    }
  };

  const goHole = (n: number) => {
    if (n < 1 || n > holeCount) return;
    setSlideDir(n > currentHole ? 1 : -1);
    setCurrentHole(n);
  };

  // ---------------------------------------------------------------------------
  // Per-stroke persist
  // ---------------------------------------------------------------------------

  /**
   * Persist a score edit.
   *
   * ONLINE rounds (isLocalRound=false):
   *   1. Add to pendingRef so it overlays all subsequent server snapshots.
   *   2. Optimistic UI update via setScores functional updater.
   *   3. POST /api/rounds/{id}/scores (per-stroke upsert).
   *   4. Success: remove from pending only if confirmed strokes === sent strokes (rapid
   *      re-entry guard); apply server snapshot + pending overlay; write through to
   *      localStorage with pending merged in (so a reload re-discovers unsynced scores).
   *   5. Failure: keep in pending, surface error banner, persist to localStorage via
   *      functional setRound(prev→…) — avoids stale-closure data loss on rapid edits.
   *   Out-of-order guard: each call gets a seq number; a response with mySeq ≤ lastApplied
   *   is skipped so a stale server snapshot can't clobber newer UI state.
   *
   * LOCAL/orphan rounds (isLocalRound=true):
   *   - Persist via functional setRound(prev→…) and localSaveRound only; no API calls.
   *
   * Deferred: re-creating an orphan round on the backend (full sync engine — out of scope).
   */
  const handleSetScore = async (pid: string, idx: number, val: number | null) => {
    const holeNumber = idx + 1;
    const pendingKey = `${pid}:${holeNumber}`;
    const scorePayload: Score = { playerId: pid, holeNumber, strokes: val };
    const id = params.id as string;

    // 1. Optimistic UI update (functional updater → safe even on rapid concurrent taps)
    setScores((prev) => {
      const next = { ...prev };
      const arr = [...(next[pid] ?? Array(holeCount).fill(null))];
      arr[idx] = val;
      next[pid] = arr;
      return next;
    });

    if (isLocalRound) {
      // LOCAL path: functional update avoids stale-closure data loss when two edits
      // land in the same tick (both reads use `prev`, not the closed-over `round`).
      setRound((prev) => {
        if (!prev) return prev;
        const updatedScores = [
          ...prev.scores.filter(
            (s) => !(s.playerId === pid && s.holeNumber === holeNumber)
          ),
          ...(val !== null ? [scorePayload] : []),
        ];
        const next: Round = {
          ...prev,
          scores: updatedScores,
          updatedAt: new Date().toISOString(),
        };
        localSaveRound(next);
        return next;
      });
      return;
    }

    // ONLINE path: add to pending, call API, handle response.
    pendingRef.current.set(pendingKey, scorePayload);
    const mySeq = ++addScoreSeqRef.current;

    try {
      const updated = await apiAddScore(id, scorePayload);

      // Out-of-order guard: skip if a newer response already applied a later state.
      if (mySeq <= lastAppliedSeqRef.current) {
        // The pending entry stays until a newer confirmed response clears it.
        return;
      }
      lastAppliedSeqRef.current = mySeq;

      // Remove from pending ONLY if we're confirming exactly what's still pending.
      // (If user re-entered the same hole while we were waiting, pending holds the newer
      // strokes → don't remove so the overlay keeps showing the latest edit.)
      const cur = pendingRef.current.get(pendingKey);
      if (cur && cur.strokes === val) {
        pendingRef.current.delete(pendingKey);
      }

      const serverHoleCount = updated.holes.length || holeCount;
      const merged = mergeWithPending(
        updated.players.map((p) => p.id),
        updated.scores,
        pendingRef.current,
        serverHoleCount
      );
      setRound(updated);
      setScores(merged);
      // Write through: include remaining pending so a reload doesn't lose them.
      localSaveRound(buildLocalRound(updated, pendingRef.current));
      setApiError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save score.";
      setApiError(
        msg.startsWith("{") || msg.length > 100
          ? "Score save failed — check connection."
          : msg
      );
      console.error(`[round/${id}] addScore failed (score stays in pending):`, e);

      // Persist to localStorage via functional update to avoid stale-closure data loss
      // when two edits land in the same tick.
      setRound((prev) => {
        if (!prev) return prev;
        const updatedScores = [
          ...prev.scores.filter(
            (s) => !(s.playerId === pid && s.holeNumber === holeNumber)
          ),
          ...(val !== null ? [scorePayload] : []),
        ];
        const next: Round = {
          ...prev,
          scores: updatedScores,
          updatedAt: new Date().toISOString(),
        };
        // Merge remaining pending into localStorage so a reload sees everything.
        localSaveRound(buildLocalRound(next, pendingRef.current));
        return next;
      });
      // Score stays in pendingRef — will overlay on the next successful server response.
    }
  };

  // ---------------------------------------------------------------------------
  // Finish round
  // ---------------------------------------------------------------------------

  const handleFinish = async () => {
    if (!round) {
      router.push("/");
      return;
    }

    hapticCelebration();
    const id = params.id as string;

    if (isLocalRound) {
      const updated: Round = {
        ...round,
        status: "completed",
        updatedAt: new Date().toISOString(),
      };
      setRound(updated);
      localSaveRound(updated);
      router.push("/");
      return;
    }

    try {
      const updated = await apiCompleteRound(id);
      setRound(updated);
      localSaveRound(updated);
    } catch (e) {
      console.error(`[round/${id}] completeRound failed — saving locally:`, e);
      const updated: Round = {
        ...round,
        status: "completed",
        updatedAt: new Date().toISOString(),
      };
      setRound(updated);
      localSaveRound(updated);
    } finally {
      router.push("/");
    }
  };

  // ---------------------------------------------------------------------------
  // Derived render values
  // ---------------------------------------------------------------------------

  const distance = Math.max(80, hole.yards - Math.round(hole.yards * 0.6));
  const pathPts = hole.path;
  const midIdx = Math.max(1, pathPts.length - 2);
  const shotPoint: [number, number] | null = pathPts[midIdx]
    ? [
        (pathPts[midIdx][0] + pathPts[midIdx + 1][0]) / 2,
        (pathPts[midIdx][1] + pathPts[midIdx + 1][1]) / 2 + 0.05,
      ]
    : null;

  // ---------------------------------------------------------------------------
  // Loading / not-found states
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          fontFamily: T.sans,
          color: T.ink,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 1.4,
            color: T.pencil,
            textTransform: "uppercase",
          }}
        >
          Loading…
        </div>
      </div>
    );
  }

  if (!round) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          fontFamily: T.sans,
          color: T.ink,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 12,
          padding: 24,
        }}
      >
        <div
          style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 20, color: T.ink }}
        >
          Round not found
        </div>
        <div
          style={{
            fontFamily: T.sans,
            fontSize: 13,
            color: T.pencil,
            textAlign: "center",
          }}
        >
          This round may have been deleted or is not available.
        </div>
        <button
          onClick={() => router.push("/")}
          style={{
            marginTop: 8,
            padding: "10px 20px",
            borderRadius: 99,
            border: `1px solid ${T.hairline}`,
            background: "transparent",
            color: T.ink,
            fontFamily: T.sans,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Back to home
        </button>
      </div>
    );
  }

  // First player ID — used for "has this hole been played" chip indicator.
  const firstPlayerId = players[0]?.id ?? "";

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  return (
    <div
      style={{
        position: "relative",
        minHeight: "100vh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        overflow: "hidden",
        fontFamily: T.sans,
        color: T.ink,
      }}
    >
      <div
        style={{ maxWidth: 420, margin: "0 auto", position: "relative", minHeight: "100vh" }}
      >
        {/* ── Top chrome ── */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 30,
            padding: "14px 18px 10px",
            paddingTop: "max(14px, env(safe-area-inset-top))",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <button
            onClick={() => router.push("/")}
            title="Back"
            style={{
              width: 32,
              height: 32,
              borderRadius: 99,
              border: `1px solid ${T.hairline}`,
              background: "transparent",
              color: T.ink,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              fontFamily: T.mono,
              fontSize: 13,
            }}
          >
            {"←"}
          </button>

          {/* Header info: flex:1 + minWidth:0 so course name truncates instead of overflowing */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flex: 1,
              minWidth: 0,
            }}
          >
            <VoiceOrb state={voiceState} accent={accent} onTap={() => setVoiceOpen(true)} />
            <div style={{ lineHeight: 1.1, minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.4,
                  color: T.pencil,
                  textTransform: "uppercase",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  overflow: "hidden",
                }}
              >
                {/* Course + datetime — truncate on long real course names */}
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {round.courseName} ·{" "}
                  {new Date().toLocaleDateString("en-US", { weekday: "short" })}{" "}
                  {new Date().toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                {/* LOCAL badge — fontSize 9 for sunlight readability */}
                {isLocalRound && (
                  <span
                    style={{
                      fontSize: 9,
                      letterSpacing: 1,
                      color: T.warningInk,
                      border: `1px solid ${T.warningInk}55`,
                      borderRadius: 3,
                      padding: "1px 4px",
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    LOCAL
                  </span>
                )}
              </div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 19,
                  fontStyle: "italic",
                  color: T.ink,
                  letterSpacing: -0.3,
                }}
              >
                Round in progress
              </div>
            </div>
          </div>

          <button
            onClick={() => setLbOpen(true)}
            title="Leaderboard"
            style={{
              width: 32,
              height: 32,
              borderRadius: 99,
              border: `1px solid ${T.hairline}`,
              background: "transparent",
              color: T.ink,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M3 2h8v3.5a4 4 0 0 1-8 0V2Z"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
              <path
                d="M3 3H1.5a1.5 1.5 0 0 0 1.5 3M11 3h1.5a1.5 1.5 0 0 1-1.5 3"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
              />
              <path
                d="M5 10.5h4M6 9v1.5M8 9v1.5M4.5 12.5h5"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
              />
            </svg>
          </button>

          <button
            onClick={handleFinish}
            title="Finish round"
            style={{
              width: 32,
              height: 32,
              borderRadius: 99,
              border: `1px solid ${accent}`,
              background: accent,
              color: "#fff",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path
                d="M3 1.5V12"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
              <path d="M3 2.2L10 4 3 5.5V2.2Z" fill="currentColor" />
            </svg>
          </button>
        </div>

        {/* ── Scroll body ── */}
        <div
          style={{
            position: "absolute",
            top: 72,
            left: 0,
            right: 0,
            bottom: 0,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "0 14px 110px",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* API error banner — surfaced, never silently swallowed */}
          {apiError && (
            <div
              style={{
                margin: "0 0 10px",
                padding: "9px 12px",
                borderRadius: 10,
                background: `rgba(184,74,58,0.13)`,
                border: `1px solid ${T.errorInk}33`,
                fontFamily: T.serif,
                fontSize: 12.5,
                color: T.errorInk,
                lineHeight: 1.4,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>{apiError}</span>
              {/* 28×28 tap target — usable on-course in sunlight */}
              <button
                onClick={() => setApiError(null)}
                style={{
                  background: "none",
                  border: "none",
                  color: T.errorInk,
                  cursor: "pointer",
                  fontSize: 15,
                  padding: 0,
                  lineHeight: 1,
                  width: 28,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          )}

          {/* LOCAL/pending notice */}
          {isLocalRound && (
            <div
              style={{
                margin: "0 0 10px",
                padding: "9px 12px",
                borderRadius: 10,
                background: `rgba(184,118,58,0.13)`,
                border: `1px solid ${T.warningInk}33`,
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 12.5,
                color: T.warningInk,
                lineHeight: 1.4,
              }}
            >
              Saved locally — will sync when connection is restored.
            </div>
          )}

          {/* Hole nav chips — rendered for the round's actual hole count, not hardcoded 18 */}
          <div
            style={{
              display: "flex",
              gap: 5,
              marginBottom: 12,
              overflowX: "auto",
              paddingBottom: 4,
              scrollSnapType: "x proximity",
            }}
          >
            {Array.from({ length: holeCount }, (_, i) => i + 1).map((h) => {
              const isCur = h === currentHole;
              const played = firstPlayerId
                ? scores[firstPlayerId]?.[h - 1] != null
                : false;
              return (
                <button
                  key={h}
                  onClick={() => goHole(h)}
                  style={{
                    flexShrink: 0,
                    minWidth: 44,
                    height: 44,
                    borderRadius: 12,
                    padding: "4px 8px",
                    border: `1px solid ${isCur ? accent : T.hairline}`,
                    background: isCur ? accent : played ? T.paperDeep : "transparent",
                    color: isCur ? "#fff" : T.ink,
                    fontFamily: T.mono,
                    cursor: "pointer",
                    fontVariantNumeric: "tabular-nums",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    scrollSnapAlign: "center",
                    fontSize: 15,
                    fontWeight: 600,
                    lineHeight: 1,
                  }}
                >
                  {h}
                </button>
              );
            })}
          </div>

          {/* Hero hole card — swipe L/R */}
          <AnimatePresence mode="wait" custom={slideDir}>
            <motion.div
              key={currentHole}
              custom={slideDir}
              variants={{
                enter: (d: number) => ({ opacity: 0, x: d > 0 ? 30 : -30 }),
                center: { opacity: 1, x: 0 },
                exit: (d: number) => ({ opacity: 0, x: d > 0 ? -30 : 30 }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: T.ease }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.25}
              onDragStart={() => {
                draggedRef.current = true;
              }}
              onDragEnd={(_e, info) => {
                if (info.offset.x < -60 && info.velocity.x < 0) goHole(currentHole + 1);
                else if (info.offset.x > 60 && info.velocity.x > 0) goHole(currentHole - 1);
                setTimeout(() => {
                  draggedRef.current = false;
                }, 350);
              }}
              style={{ marginBottom: 14, touchAction: "pan-y" }}
            >
              <HoleCard
                holeNumber={currentHole}
                hole={hole}
                distance={distance}
                windMph={6}
                windDir="R→L"
                expanded={expanded}
                onExpand={() => {
                  if (!draggedRef.current) setExpanded(true);
                }}
                onCollapse={() => setExpanded(false)}
                onZoom={() => {
                  if (!draggedRef.current) setExpanded(true);
                }}
                onAskCaddy={() => setVoiceOpen(true)}
                caddy={caddy}
                accent={accent}
                club={hole.par === 3 ? "7i" : hole.yards > 450 ? "5w" : "8i"}
                density={density}
                shotPoint={shotPoint}
              />
            </motion.div>
          </AnimatePresence>

          {/* Stakes ticker */}
          <div style={{ marginBottom: 14 }}>
            <SectionLabel>The stakes</SectionLabel>
            <StakesTicker accent={accent} />
          </div>

          {/* Paneled scorecard */}
          <div>
            <SectionLabel>Scorecard</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {players.map((p) => (
                <PlayerPanel
                  key={p.id}
                  player={p}
                  scores={scores[p.id] ?? Array(holeCount).fill(null)}
                  pars={
                    round.holes.length > 0
                      ? round.holes.map((h) => h.par)
                      : HOLES.map((h) => h.par)
                  }
                  currentHole={currentHole}
                  onSelectHole={goHole}
                  accent={accent}
                  density={density}
                />
              ))}
            </div>
          </div>

          <div
            style={{
              marginTop: 20,
              textAlign: "center",
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 14,
              color: T.pencilSoft,
              letterSpacing: -0.1,
            }}
          >
            {round.courseName} · {holeCount} holes
            {round.teeName ? ` · ${round.teeName} tees` : ""}
          </div>
        </div>

        {/* Bottom score-entry pill */}
        <div
          style={{
            position: "absolute",
            bottom: 28,
            left: 0,
            right: 0,
            zIndex: 20,
            display: "flex",
            justifyContent: "center",
            padding: "0 20px",
            pointerEvents: scoreOpen || voiceOpen ? "none" : "auto",
          }}
        >
          <motion.button
            onClick={() => setScoreOpen(true)}
            whileTap={{ scale: 0.97 }}
            style={{
              padding: "14px 24px",
              borderRadius: 99,
              border: "none",
              background: T.ink,
              color: T.paper,
              cursor: "pointer",
              boxShadow: "0 12px 30px rgba(26,42,26,0.3)",
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontFamily: T.sans,
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Enter score</span>
            <span style={{ width: 1, height: 14, background: "rgba(244,241,234,0.3)" }} />
            <span
              style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, color: accent }}
            >
              HOLE {currentHole}
            </span>
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 99,
                background: accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                color: "#fff",
              }}
            >
              ↑
            </span>
          </motion.button>
        </div>
      </div>

      <VoiceSheet
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        accent={accent}
        caddy={caddy}
        voiceState={voiceState}
        turns={turns}
        onMicTap={handleMicTap}
      />

      <ScoreSheet
        open={scoreOpen}
        onClose={() => setScoreOpen(false)}
        hole={{ number: currentHole, par: holePar }}
        players={players}
        scores={scores}
        onSetScore={handleSetScore}
        accent={accent}
      />

      <LeaderboardSheet
        open={lbOpen}
        onClose={() => setLbOpen(false)}
        players={players}
        scores={scores}
        pars={
          round.holes.length > 0
            ? round.holes.map((h) => h.par)
            : HOLES.map((h) => h.par)
        }
        accent={accent}
      />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 9.5,
          letterSpacing: 1.4,
          color: T.pencil,
          textTransform: "uppercase",
        }}
      >
        {children}
      </div>
      <div style={{ flex: 1, height: 1, background: T.hairline }} />
    </div>
  );
}
