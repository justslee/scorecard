"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
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
import CaddieSheet from "@/components/CaddieSheet";
import ScanSheet from "@/components/ScanSheet";
import RoundRecap from "@/components/RoundRecap";
import type { VoiceCaddieMessage } from "@/lib/caddie/types";
import {
  getRound as apiGetRound,
  addScore as apiAddScore,
  completeRound as apiCompleteRound,
} from "@/lib/api";
import { hapticCelebration } from "@/lib/haptics";
import { shotPointForPath } from "@/lib/hole-shot-point";
import { resolveCourseKey } from "@/lib/course-review-key";
import { getRecentCourses } from "@/lib/golf-api";
import { resolveMappedCourse } from "@/lib/map-bridge";
import type { MappedCourseListItem } from "@/lib/map-bridge";
import { roundCourseAnchor } from "@/lib/round-anchor";
import { haptic } from "@/lib/haptics";
import InlineHoleDiagram from "@/components/course/InlineHoleDiagram";
import GoogleSatelliteMap from "@/components/GoogleSatelliteMap";
import { useHoleCoordinates } from "@/lib/map/use-hole-coordinates";
import { fetchAPI } from "@/lib/api";

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
 * Seed pendingRef from a local-cache round.
 *
 * Called whenever we render from localStorage because the server snapshot is unavailable
 * (either 404/offline → LOCAL mode, or non-404 transient error → staying ONLINE).  This
 * ensures that when a subsequent successful save arrives, buildLocalRound/mergeWithPending
 * include prior-session unsynced scores — they won't be erased by the server snapshot.
 *
 * In LOCAL mode (isLocalRound=true) the pending overlay isn't consulted for writes (the
 * LOCAL write path goes straight to localStorage), but seeding is still harmless and
 * guards against any future mode-switch.
 */
function seedPendingFromLocal(local: Round, pending: Map<string, Score>): void {
  for (const s of local.scores) {
    if (s.strokes !== null) {
      pending.set(`${s.playerId}:${s.holeNumber}`, s);
    }
  }
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
    // Exact pattern emitted by fetchAPI for empty-body 404s (not substring — avoids
    // matching "API error: 404 Something else returned by a gateway").
    if (m === "API error: 404") return true;
    // FastAPI JSON body: '{"detail":"Round not found"}' — match only the parsed .detail
    // field, never arbitrary body text.  A 5xx body containing "not found" in prose must
    // not be misclassified as LOCAL mode.
    try {
      const parsed = JSON.parse(m) as { detail?: unknown };
      const detail = typeof parsed?.detail === "string" ? parsed.detail.toLowerCase() : "";
      return detail.includes("not found");
    } catch {
      // Not a JSON message — don't fall back to substring match (too broad).
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RoundPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  // The round id is carried in the query (/round/view?id=…) so navigation stays
  // client-side in the static export; fall back to the path param for any legacy
  // /round/<id> deep link. See lib/round-url.ts.
  const roundId = searchParams.get("id") ?? (params.id as string);
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
  /**
   * loadFailed: true only when the INITIAL LOAD threw a non-404 error and we fell back
   * to localStorage.  Distinct from apiError (which is also used for score saves) so we
   * can show a "Retry" affordance only for load failures, not score-save failures.
   * Cleared on: successful load, successful score save, user tapping Retry or ×.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * Incrementing retryCount re-runs the load useEffect (Retry button path).
   * Does NOT reset to a loading spinner — round data stays visible during silent re-fetch.
   */
  const [retryCount, setRetryCount] = useState(0);

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
  // Fullscreen ("blow it up") satellite map overlay.
  const [mapZoom, setMapZoom] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [lbOpen, setLbOpen] = useState(false);
  const [caddieOpen, setCaddieOpen] = useState(false);
  // Grid modal for jumping between holes (replaces the old top chip strip).
  const [holePickerOpen, setHolePickerOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [recapOpen, setRecapOpen] = useState(false);
  /** Conversation history — lifted here so close→score-entry→reopen retains the thread. */
  const [caddieHistory, setCaddieHistory] = useState<VoiceCaddieMessage[]>([]);
  const [slideDir, setSlideDir] = useState(0);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [turnIdx, setTurnIdx] = useState(0);
  const draggedRef = useRef(false);

  /**
   * Resolved mapped course for the active round's courseName.
   * null  = not yet resolved (loading) or no mapped course found.
   * Set once when round.courseName becomes available.
   */
  const [mappedCourse, setMappedCourse] = useState<MappedCourseListItem | null>(null);
  // Shared per-hole coordinates for the fullscreen blow-up map (the inline map
  // fetches its own; this feeds the big overlay framed on the current hole).
  const { allCoords: mapCoords, courseCenter: mapCenter } = useHoleCoordinates(mappedCourse?.id ?? null);

  // ---------------------------------------------------------------------------
  // Load round: try API → fall back to localStorage on 404 / network error.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const id = roundId;
    // Cancellation guard: set true in cleanup so a stale in-flight load() (triggered by
    // a previous retryCount value) skips setState after a newer effect has started.
    // Prevents a long-running load from clobbering a just-confirmed score-save snapshot.
    let cancelled = false;

    /**
     * Background retry for scores that failed to reach the server in a previous session.
     *
     * Intentionally does NOT call setRound/setScores after each confirm.  Applying the
     * server snapshot here would race the foreground save seq guard (addScoreSeqRef /
     * lastAppliedSeqRef) — a retry response and a concurrent foreground save can arrive in
     * any order.  Instead: confirm pending removal only; the UI remains correct via the
     * pending overlay already set at load time; localStorage will be updated by the next
     * successful foreground save.
     */
    async function retrySyncPending(roundId: string) {
      const snapshot = [...pendingRef.current.entries()];
      for (const [key, score] of snapshot) {
        if (!pendingRef.current.has(key)) continue; // handled by user re-entry meanwhile
        try {
          await apiAddScore(roundId, score);
          // Only confirm removal — no UI state apply, no localStorage write here.
          const cur = pendingRef.current.get(key);
          if (cur && cur.strokes === score.strokes) {
            pendingRef.current.delete(key);
          }
        } catch (retryErr) {
          // Silently log — score stays in pending, will retry on next load or user edit.
          console.warn("[round] background sync pending failed:", retryErr);
        }
      }
    }

    async function load() {
      try {
        const r = await apiGetRound(id);
        // Skip setState if a newer effect (from retryCount change or params.id change)
        // has already started — prevents stale snapshots clobbering fresher UI state.
        if (cancelled) return;
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
        // Clear any prior load error — if we reached here the server is reachable again.
        setLoadFailed(false);
        setApiError(null);

        // Kick off background retry for any re-discovered pending scores.
        if (pendingRef.current.size > 0) {
          retrySyncPending(id);
        }
      } catch (e) {
        if (cancelled) return; // stale error from a superseded request — ignore
        if (isNotFoundOrNetworkError(e)) {
          // 404 (orphan/offline round) or network down → LOCAL mode.
          console.warn(`[round/${id}] falling back to local cache (404 or offline):`, e);
          const local = localGetRound(id);
          if (local) {
            const holeCount = local.holes.length || 18;
            // Seed pendingRef from the local cache so that if the mode ever transitions
            // back to ONLINE, a successful save won't erase prior-session scores that
            // never reached the server.  Use mergeWithPending for display consistency.
            seedPendingFromLocal(local, pendingRef.current);
            setRound(local);
            setPlayers(buildSeedPlayers(local));
            setScores(
              mergeWithPending(
                local.players.map((p) => p.id),
                local.scores,
                pendingRef.current,
                holeCount
              )
            );
            setIsLocalRound(true);
          }
          // If no local copy either, round stays null → not-found render.
        } else {
          // Non-404 HTTP error (500, auth, timeout): the round IS on the server but we
          // temporarily can't reach it.  Stay ONLINE (isLocalRound stays false) so later
          // writes still target the server; show warning banner; render from localStorage.
          setLoadFailed(true);
          setApiError("Showing saved data — couldn't reach server.");
          console.error(`[round/${id}] load failed (non-404, staying ONLINE):`, e);
          const local = localGetRound(id);
          if (local) {
            const holeCount = local.holes.length || 18;
            // BLOCKER FIX: seed pendingRef from the local cache.  Without this, prior-
            // session unsynced scores are invisible to buildLocalRound/mergeWithPending —
            // the next successful foreground save overwrites localStorage with the server
            // snapshot (which lacks those scores) and they are permanently lost.
            seedPendingFromLocal(local, pendingRef.current);
            setRound(local);
            setPlayers(buildSeedPlayers(local));
            setScores(
              mergeWithPending(
                local.players.map((p) => p.id),
                local.scores,
                pendingRef.current,
                holeCount
              )
            );
            // isLocalRound stays false — round is on the server, saves should target it.
          }
        }
      } finally {
        // Only update loading state if this effect is still the active one.
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => { cancelled = true; };
  // retryCount is incremented by the Retry button to re-run load() without showing
  // a loading spinner — round data stays visible during the silent re-fetch.
  }, [roundId, retryCount]);

  // Derived: actual hole count for this round (fall back to 18 if round not yet loaded).
  const holeCount = round?.holes.length || 18;

  // Resolve the course key for the B2 review affordance once (when courseName changes).
  // getRecentCourses() reads localStorage; returns [] on SSR (typeof window guard inside).
  const reviewCourseKey = useMemo(() => {
    if (!round) return null;
    return resolveCourseKey(round, getRecentCourses());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.courseName, round?.id]);

  // Resolve mapped course. Preferred path: the round's stored anchor
  // (mappedCourseId, captured at creation) — direct, no name lookup. Legacy
  // fallback: query GET /api/courses/mapped?search=<courseName> and take a
  // confident name match. Silently hides on any error.
  useEffect(() => {
    const anchorId = round?.mappedCourseId;
    const courseName = round?.courseName?.trim();
    if (anchorId) {
      setMappedCourse({ id: anchorId, name: courseName ?? "" });
      return;
    }
    if (!courseName) return;

    let cancelled = false;
    (async () => {
      try {
        const data = await fetchAPI<{ courses: MappedCourseListItem[] }>(
          `/api/courses/mapped?search=${encodeURIComponent(courseName)}`
        );
        if (cancelled) return;
        const match = resolveMappedCourse(courseName, data.courses ?? []);
        setMappedCourse(match);
      } catch {
        // Silent — no mapped course shown on error (keeps the UI calm).
        if (!cancelled) setMappedCourse(null);
      }
    })();

    return () => { cancelled = true; };
  }, [round?.courseName, round?.mappedCourseId]);

  // Course anchor centre stored on the round at creation — drives the satellite
  // map even when no mapped geometry exists (never drop to the paper mock).
  const roundAnchor = roundCourseAnchor(round);

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
    const id = roundId;

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
      // A successful score save confirms the server is reachable — clear any prior
      // load error and its Retry affordance.
      setApiError(null);
      setLoadFailed(false);
    } catch (e) {
      // Score is safe: pendingRef keeps it and localStorage was already written above.
      // Clear loadFailed so the Retry button isn't shown for score-save errors (the
      // retry is automatic via pendingRef — no manual reload needed).
      setLoadFailed(false);
      setApiError("Score saved locally — couldn't sync, will retry.");
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
    const id = roundId;

    if (isLocalRound) {
      const updated: Round = {
        ...round,
        status: "completed",
        updatedAt: new Date().toISOString(),
      };
      setRound(updated);
      localSaveRound(updated);
      // Show recap before returning home — local round path.
      setRecapOpen(true);
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
      // Show recap; the recap's Done button routes home.
      setRecapOpen(true);
    }
  };

  // ---------------------------------------------------------------------------
  // Derived render values
  // ---------------------------------------------------------------------------

  const distance = Math.max(80, hole.yards - Math.round(hole.yards * 0.6));
  // Shot marker = midpoint of the hole's last segment (par-3-safe; see helper).
  const shotPoint = shotPointForPath(hole.path);

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
              {/* Inline hole map replaces the former "View hole map" link.
                  Shown below in the scroll body when mappedCourse is resolved. */}
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
            // Start exactly at the header's bottom. The header is top:0 with
            // paddingTop max(14px, safe-area-inset-top), so a fixed 72 let the
            // content slide UNDER the header on notched devices (overlap bug).
            // Mirror the header's top inset here so they never overlap.
            // 58px = header content row (~48px) + paddingBottom (10px); if the
            // header row ever grows, bump this to match.
            top: "calc(58px + max(14px, env(safe-area-inset-top)))",
            left: 0,
            right: 0,
            bottom: 0,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "0 14px 110px",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* Sync / load warning banner — calm amber annotation, never a red alarm.
               loadFailed=true  → initial load error, showing saved data → Retry affordance.
               loadFailed=false → score-save error, auto-retrying via pendingRef → no Retry. */}
          {apiError && (
            <div
              style={{
                margin: "0 0 10px",
                padding: "9px 12px",
                borderRadius: 10,
                background: T.warningWash,
                border: `1px solid ${T.warningInk}33`,
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 12.5,
                color: T.warningInk,
                lineHeight: 1.4,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>{apiError}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                {/* Retry: only for load failures — score saves auto-retry via pendingRef */}
                {loadFailed && (
                  <button
                    onClick={() => {
                      setApiError(null);
                      setLoadFailed(false);
                      setRetryCount((c) => c + 1);
                    }}
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
                )}
                {/* 44-pt dismiss — usable on-course in sunlight */}
                <button
                  onClick={() => { setApiError(null); setLoadFailed(false); }}
                  style={{
                    background: "none",
                    border: "none",
                    color: T.warningInk,
                    cursor: "pointer",
                    fontSize: 15,
                    padding: 0,
                    lineHeight: 1,
                    width: 44,
                    height: 44,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          )}

          {/* LOCAL/pending notice */}
          {isLocalRound && (
            <div
              style={{
                margin: "0 0 10px",
                padding: "9px 12px",
                borderRadius: 10,
                background: T.warningWash,
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

          {/* Hole picker — the chip strip moved into a grid modal (owner request
              2026-07-01): a quiet pill shows the position; tap for the full grid.
              Swiping the hole card still steps prev/next. */}
          <div style={{ display: "flex", marginBottom: 12 }}>
            <button
              onClick={() => setHolePickerOpen(true)}
              aria-label="Switch hole"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "8px 14px",
                borderRadius: 99,
                border: `1px solid ${T.hairline}`,
                background: "transparent",
                color: T.ink,
                fontFamily: T.mono,
                fontSize: 11,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                cursor: "pointer",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
              Hole {currentHole} / {holeCount}
            </button>
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
                  if (draggedRef.current) return;
                  // With real course data the card's map expands to the
                  // fullscreen interactive satellite; the mock falls back to
                  // the old in-card expand.
                  if (mappedCourse || roundAnchor) setMapZoom(true);
                  else setExpanded(true);
                }}
                accent={accent}
                density={density}
                shotPoint={shotPoint}
                // Real satellite hole map fills the card's map space (the
                // abstract HoleIllustration mock renders only when the round
                // has no course data at all).
                mapSlot={
                  mappedCourse || roundAnchor ? (
                    <InlineHoleDiagram
                      courseId={mappedCourse?.id}
                      fallbackCenter={roundAnchor ?? undefined}
                      currentHole={currentHole}
                      height={300}
                    />
                  ) : undefined
                }
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
            {/* Scorecard section header — includes a quiet "scan card" affordance */}
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
                Scorecard
              </div>
              <div style={{ flex: 1, height: 1, background: T.hairline }} />
              <button
                onClick={() => setScanOpen(true)}
                title="Scan scorecard photo"
                aria-label="Scan scorecard"
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.2,
                  color: T.pencil,
                  textTransform: "uppercase",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: "4px 8px",
                  borderRadius: 6,
                  minHeight: 40,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                {/* Camera icon — 44pt-friendly, matches CameraCapture's icon shape */}
                <svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M1 6a2 2 0 0 1 2-2h1.2l1.3-2h6l1.3 2H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V6Z" />
                  <circle cx="9" cy="10" r="2.8" />
                </svg>
                Scan card
              </button>
            </div>
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

        {/* Bottom action row — caddie + score entry */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            // #6 — safe-area aware; was bottom:28 with no safe-area
            padding: "0 20px max(28px, calc(env(safe-area-inset-bottom) + 12px))",
            paddingTop: 0,
            pointerEvents: scoreOpen || voiceOpen || caddieOpen || scanOpen ? "none" : "auto",
          }}
        >
          {/* Ask Caddie — ghost pill (#11: flexShrink:1 so it compresses on 320px) */}
          <motion.button
            onClick={() => setCaddieOpen(true)}
            whileTap={{ scale: 0.97 }}
            style={{
              padding: "14px 18px",
              borderRadius: 99,
              border: `1px solid ${T.hairline}`,
              background: T.paper,
              color: T.ink,
              cursor: "pointer",
              boxShadow: "0 8px 24px rgba(26,42,26,0.12)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontFamily: T.sans,
              fontSize: 14,
              fontWeight: 500,
              flexShrink: 1, // #11 — compresses before the primary pill on narrow viewports
              minWidth: 0,
            }}
          >
            {/* Caddie initial medallion (#5: T.paper not "#fff") */}
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 10,
                color: T.paper, // #5
                flexShrink: 0,
              }}
            >
              {caddy.initial}
            </span>
            <span style={{ fontFamily: T.serif, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Ask caddie</span>
          </motion.button>

          {/* Enter Score — solid pill */}
          <motion.button
            onClick={() => setScoreOpen(true)}
            whileTap={{ scale: 0.97 }}
            style={{
              padding: "14px 22px",
              borderRadius: 99,
              border: "none",
              background: T.ink,
              color: T.paper,
              cursor: "pointer",
              boxShadow: "0 12px 30px rgba(26,42,26,0.3)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontFamily: T.sans,
              fontSize: 14,
              fontWeight: 500,
              flexShrink: 0,
            }}
          >
            <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Enter score</span>
            <span style={{ width: 1, height: 14, background: "rgba(244,241,234,0.3)" }} />
            <span
              style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, color: accent }}
            >
              {currentHole}
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

      <CaddieSheet
        open={caddieOpen}
        onClose={() => setCaddieOpen(false)}
        caddy={caddy}
        accent={accent}
        holeNumber={currentHole}
        holePar={holePar}
        holeYards={round.holes[currentHole - 1]?.yards ?? hole.yards}
        convHistory={caddieHistory}
        onUpdateConvHistory={setCaddieHistory}
      />

      {/* key forces a fresh unmount+remount on each open, resetting all state */}
      <ScanSheet
        key={scanOpen ? "scan-open" : "scan-closed"}
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        round={round}
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
        round={round}
      />

      {/* Round recap — shown after handleFinish persists completion, before home. */}
      <RoundRecap
        open={recapOpen}
        round={round}
        onDone={() => router.push("/")}
        courseKey={reviewCourseKey}
        courseName={round.courseName}
      />

      {/* Hole picker modal — grid of holes, replaces the old top chip strip. */}
      <AnimatePresence>
        {holePickerOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setHolePickerOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 60,
              background: "rgba(26,42,26,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.2, ease: T.ease }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 360,
                borderRadius: 18,
                border: `1px solid ${T.hairline}`,
                background: T.paper,
                padding: "18px 18px 16px",
                boxShadow: "0 18px 48px rgba(26,42,26,0.28)",
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  letterSpacing: 1.4,
                  color: T.pencil,
                  textTransform: "uppercase",
                  marginBottom: 12,
                }}
              >
                Go to hole
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(6, 1fr)",
                  gap: 6,
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
                      onClick={() => {
                        haptic("light");
                        goHole(h);
                        setHolePickerOpen(false);
                      }}
                      style={{
                        height: 44,
                        borderRadius: 12,
                        border: `1px solid ${isCur ? accent : T.hairline}`,
                        background: isCur ? accent : played ? T.paperDeep : "transparent",
                        color: isCur ? "#fff" : T.ink,
                        fontFamily: T.mono,
                        cursor: "pointer",
                        fontVariantNumeric: "tabular-nums",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fullscreen "blow it up" satellite map — full-screen interactive overlay,
          framed on the current hole. Hole changes sync back to the round. Renders
          from mapped geometry when available, else the round's anchor centre. */}
      {mapZoom && (mappedCourse || roundAnchor) && (
        <GoogleSatelliteMap
          courseId={mappedCourse?.id ?? ""}
          courseName={round.courseName}
          holeCoordinates={mapCoords}
          currentHole={currentHole}
          onHoleChange={goHole}
          onClose={() => setMapZoom(false)}
          autoDetectHole={false}
          centerOnly={mapCoords.length === 0}
          fallbackCenter={mapCenter ?? roundAnchor ?? undefined}
        />
      )}
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
