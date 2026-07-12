"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import { HOLES } from "@/components/yardage/HoleIllustration";
import HoleCard from "@/components/yardage/HoleCard";
import DistancesCard from "@/components/yardage/DistancesCard";
import { VoiceOrb, VoiceSheet } from "@/components/yardage/Voice";
import { PlayerPanel, StakesTicker, SeedPlayer } from "@/components/yardage/Scorecard";
import ScoreSheet from "@/components/yardage/ScoreSheet";
import LeaderboardSheet from "@/components/yardage/LeaderboardSheet";
import { Round, Score } from "@/lib/types";
import {
  getRound as localGetRound,
  saveRound as localSaveRound,
  getGolferProfile,
} from "@/lib/storage";
import CaddieSheet from "@/components/CaddieSheet";
import { useCaddiePersona } from "@/lib/caddie/persona";
import { buildClubMap } from "@/lib/caddie/clubs";
import {
  startSession as startCaddieSession,
  endSession as endCaddieSession,
  fetchCourseIntel,
  fetchWeather,
} from "@/lib/caddie/api";
import { useVoiceCaddie } from "@/hooks/useVoiceCaddie";
import OfflineCaddieCard from "@/components/OfflineCaddieCard";
import {
  saveHoleIntelBundle,
  loadHoleIntelBundle,
  type HoleIntelBundle,
} from "@/lib/caddie/hole-intel-cache";
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
import type { WeatherConditions } from "@/lib/caddie/types";
import { bearingDeg, relativeWind, compassFrom } from "@/lib/map/wind";
import { shouldRefreshOnDemand, WeatherRefreshScheduler } from "@/lib/map/weather-freshness";
import { computeFCBDistances } from "@/lib/course/course-coordinates";
import { buildFcbTiles, effectiveFcbSource } from "@/lib/course/fcb-tiles";
import { fcbSourceCaption } from "@/lib/caddie/fcb-labels";
import { usePhysicsPlaysLike } from "@/lib/caddie/use-physics-plays-like";
import { playsTileDisplay, ELEV_DEADBAND_FT } from "@/lib/caddie/plays-tile";
import { playsBasis } from "@/lib/caddie/plays-basis";
import { yardsDistance } from "@/lib/course/hole-projection";
import { applyTeeAnchors, resolveFcbSource, namesMatch } from "@/lib/course/tee-anchor";
import { resolveHoleYardage, yardageCaption } from "@/lib/caddie/hole-yardage";
import type { HoleData } from "@/lib/courses/types";
import { haptic } from "@/lib/haptics";
import InlineHoleDiagram from "@/components/course/InlineHoleDiagram";
import GoogleSatelliteMap from "@/components/GoogleSatelliteMap";
import { useHoleCoordinates } from "@/lib/map/use-hole-coordinates";
import { fetchAPI } from "@/lib/api";
import { GPSWatcher, type Position } from "@/lib/gps";
import { resolveOpeningShotDistance } from "@/lib/caddie/opening-shot";
import { setCaddieLiveMode } from "@/lib/voice/live-mode-pref";
// SPIKE (specs/passive-shot-tracking-spike.md) — dev-flag-gated, off by
// default everywhere. See the mounted usage below for the flag check.
import { PassiveShotDraftBanner } from "@/components/spike/PassiveShotDraftBanner";

// Player accent colors (yardage-book palette — warm ink tones)
const PLAYER_COLORS = ["#1a2a1a", "#6b3a1a", "#3a3a6a", "#6a3a3a", "#2a5a3a", "#5a2a5a"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Races `promise` against a timer that resolves `null` after `ms` — used to
 * cap the one-shot GPS fix for the caddie's auto opening shot recommendation
 * (specs/caddie-auto-shot-reco-plan.md) so a hanging fix falls back fast
 * (GPSWatcher.getCurrentPosition's own 15s timeout is too long for an
 * on-open experience).
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * The mapped course's real per-tee card yardage for one hole, matched
 * against the round's selected teeName (spec: caddie-yardage-gps-selected-
 * tee-plan.md §2.2) — the same tolerant `namesMatch` tee-anchor.ts uses for
 * OSM tag matching. Honestly undefined when the course isn't mapped, has no
 * recorded per-tee card for this hole, or no tee is selected — never a
 * fabricated number.
 */
function selectedTeeCardYardsFor(
  courseHoles: HoleData[],
  teeName: string | null | undefined,
  holeNumber: number
): number | undefined {
  if (!teeName) return undefined;
  const holeData = courseHoles.find((h) => h.number === holeNumber);
  if (!holeData) return undefined;
  for (const [key, y] of Object.entries(holeData.yardages)) {
    if (namesMatch(key, teeName)) return y;
  }
  return undefined;
}

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

  /**
   * One-shot `?liveMode=1` / `?liveMode=0` → persists the caddie live-mode
   * (Realtime transport) pref to localStorage (specs/caddie-realtime-slice-c1-plan.md
   * §2). No shipped UI toggle in stage 1 — the owner opens
   * `…/round/<id>?liveMode=1` once on-device to turn it on; the pref then
   * sticks for every later open via `getCaddieLiveMode()` in CaddieSheet.
   * Reads the param once on mount only — never re-fires on a later
   * navigation within the same mounted page.
   */
  useEffect(() => {
    const v = searchParams.get("liveMode");
    if (v === "1" || v === "0") setCaddieLiveMode(v === "1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const density: "dense" | "spacious" = "dense";
  // Real backend persona (classic/strategist/hype/professor/custom) — replaces
  // the cosmetic CADDIES list whose ids didn't exist server-side and silently
  // fell back to 'classic' in every caddie prompt.
  const { caddy, personaId, personas, selectPersona } = useCaddiePersona();

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
  // Map-first layout: the inline satellite map fills ~60% of the viewport
  // (owner request 2026-07-02); clamped so small phones keep the score UI
  // reachable and tablets don't get a wall of map.
  const [mapHeight, setMapHeight] = useState(430);
  // Flick-on-map hole swipe tracking (single-touch start point + time).
  const mapSwipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  useEffect(() => {
    const size = () =>
      setMapHeight(Math.max(380, Math.min(640, Math.round(window.innerHeight * 0.58))));
    size();
    window.addEventListener("resize", size);
    return () => window.removeEventListener("resize", size);
  }, []);
  const [scanOpen, setScanOpen] = useState(false);
  const [recapOpen, setRecapOpen] = useState(false);
  /** Conversation history — lifted here so close→score-entry→reopen retains the thread. */
  const [caddieHistory, setCaddieHistory] = useState<VoiceCaddieMessage[]>([]);
  const [slideDir, setSlideDir] = useState(0);
  // Tier-3 (offline) caddie surface: static card from the IndexedDB bundle.
  const [offlineCardOpen, setOfflineCardOpen] = useState(false);
  const [offlineBundle, setOfflineBundle] = useState<HoleIntelBundle | null>(null);
  const draggedRef = useRef(false);

  /**
   * Resolved mapped course for the active round's courseName.
   * null  = not yet resolved (loading) or no mapped course found.
   * Set once when round.courseName becomes available.
   */
  const [mappedCourse, setMappedCourse] = useState<MappedCourseListItem | null>(null);
  // Shared per-hole coordinates for the fullscreen blow-up map (the inline map
  // fetches its own; this feeds the big overlay framed on the current hole).
  const {
    allCoords: mapCoords,
    courseCenter: mapCenter,
    loaded: mapCoordsLoaded,
    courseHoles,
  } = useHoleCoordinates(mappedCourse?.id ?? null);

  // Anchor "from the tee" geometry to the PLAYER'S selected tee, not an
  // arbitrary stored tee box (spec: multi-tee-anchor-reconciliation — third
  // geometry-anchor incident after hazards + doglegs). Pure + memoized;
  // `round` loads before `mappedCourse` is set, so teeName/holes are already
  // present by the time mapCoords resolves. Every mapCoords consumer below
  // is replaced with anchoredCoords so tiles, plays-like, wind bearing,
  // opening shot, course-intel, and both maps' tee markers all agree.
  const { coords: anchoredCoords, anchorByHole } = useMemo(
    () =>
      applyTeeAnchors(mapCoords, {
        teeName: round?.teeName ?? null,
        holes: round?.holes ?? [],
      }),
    [mapCoords, round?.teeName, round?.holes]
  );
  // Per-hole tee overrides for InlineHoleDiagram, which self-fetches its own
  // coords and can't compute the anchor itself (no access to round data).
  const teeOverrideByHole = useMemo(() => {
    const m = new Map<number, { lat: number; lng: number } | null>();
    for (const [holeNumber, anchor] of anchorByHole) m.set(holeNumber, anchor.tee);
    return m;
  }, [anchorByHole]);

  /**
   * Caddie session — the durable round brain (Postgres). Started once per
   * mount for ONLINE rounds; the sheet then uses the rich /session endpoints.
   * Legacy/local/offline rounds (or a failed start) leave this false and the
   * sheet stays on its stateless fallback path.
   */
  const [caddieSessionActive, setCaddieSessionActive] = useState(false);
  const caddieSessionStartedRef = useRef(false);
  // Course intel is fired once per mount, after the session exists.
  const courseIntelSentRef = useRef(false);

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

  // Real weather for the wind tiles (owner 2026-07-07: they were hardcoded).
  // One fetch per round mount; null = honest "no data" tiles, never fake.
  const [weather, setWeather] = useState<WeatherConditions | null>(null);
  // Client receipt time of the current `weather` reading — when it was
  // actually fetched, not when the round started (owner 2026-07-07: one
  // reading was persisting stale for a whole 4+ hour round). Client-side
  // only: the backend always fetches fresh on /weather (no server timestamp
  // to trust more than our own receipt time — see specs/wind-periodic-refresh-plan.md §4).
  const [weatherFetchedAt, setWeatherFetchedAt] = useState<number | null>(null);
  // ALL weather writes route through this — the single writer guarantees
  // `weatherFetchedAt` can never drift out of sync with `weather`.
  const applyWeather = useCallback((w: WeatherConditions) => {
    setWeather(w);
    setWeatherFetchedAt(Date.now());
  }, []);
  // Real per-hole elevation deltas + elevation-adjusted yards (USGS, computed
  // server-side in course-intel — the owner wants the Elev tile back, honest).
  const [intelByHole, setIntelByHole] = useState<Map<number, { elevFt: number; effectiveYards: number }>>(
    () => new Map()
  );
  // Legacy rounds have no stored anchor — fall back to the first available
  // hole tee coordinate so the wind tiles aren't permanently "no data".
  const fallbackTee = anchoredCoords.find((c) => c.tee)?.tee ?? null;
  const weatherAnchor = roundAnchor ?? fallbackTee;
  const weatherLat = weatherAnchor?.lat;
  const weatherLng = weatherAnchor?.lng;
  useEffect(() => {
    if (weatherLat == null || weatherLng == null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Retry with backoff: the first attempt can race Clerk auth on a cold
    // app start (401 → owner saw permanent "no data" tiles on v1.0.739).
    const DELAYS = [0, 3_000, 10_000, 30_000];
    const attempt = (i: number) => {
      fetchWeather(weatherLat, weatherLng)
        .then((w) => { if (!cancelled) applyWeather(w); })
        .catch(() => {
          if (cancelled || i + 1 >= DELAYS.length) return; // tiles stay honest "—"
          timer = setTimeout(() => attempt(i + 1), DELAYS[i + 1]);
        });
    };
    attempt(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [weatherLat, weatherLng, applyWeather]);

  // Periodic + on-demand weather refresh (owner 2026-07-07: one reading was
  // persisting stale for a whole round). Only ever replaces the single
  // shared grid-cell reading + its receipt time — per-hole wind DIRECTION
  // math (relativeWind, above) is unchanged; no per-hole speed is ever
  // synthesized. A failed refresh is a silent no-op: the prior good reading
  // (or the honest "—" if none was ever acquired) survives untouched.
  const refreshInFlightRef = useRef(false);
  const refreshWeather = useCallback(async () => {
    if (weatherLat == null || weatherLng == null) return;
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const w = await fetchWeather(weatherLat, weatherLng, roundId);
      applyWeather(w);
    } catch {
      // Keep the prior good reading (or honest "—") — never clobber.
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [weatherLat, weatherLng, roundId, applyWeather]);

  // Round is "active" (being played) — not finished, not still loading. The
  // periodic scheduler below is torn down when this goes false; the on-demand
  // triggers (hole change / foreground) live for the page's whole lifetime, so
  // they read this flag from the mirror ref to stay off for a completed round.
  const roundActive = round != null && round.status !== "completed";

  // Mirrors the latest weather/weatherFetchedAt (+ active flag) so the
  // on-demand effects below (keyed only on `currentHole` / a DOM listener)
  // read current values instead of a stale mount-time closure.
  const weatherLatestRef = useRef({ weather, weatherFetchedAt, roundActive });
  useEffect(() => {
    weatherLatestRef.current = { weather, weatherFetchedAt, roundActive };
  }, [weather, weatherFetchedAt, roundActive]);

  // ~25-min periodic refresh, only while the round is active — no polling
  // for a finished or not-yet-loaded round. Keyed on `round?.status` (not
  // `round` itself) so unrelated round updates (e.g. new scores) don't tear
  // down and rebuild the interval.
  useEffect(() => {
    if (weatherLat == null || weatherLng == null) return;
    if (!round || round.status === "completed") return;
    const sched = new WeatherRefreshScheduler(() => { void refreshWeather(); });
    sched.start();
    return () => sched.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weatherLat, weatherLng, roundId, round?.status, refreshWeather]);

  // Hole-change refresh, gated on staleness (>20 min) — fires only on an
  // actual hole change, never on mount (prevHoleRef starts at currentHole).
  const prevHoleRef = useRef(currentHole);
  useEffect(() => {
    if (prevHoleRef.current === currentHole) return;
    prevHoleRef.current = currentHole;
    const { weather: w, weatherFetchedAt: fetchedAt, roundActive: active } = weatherLatestRef.current;
    if (shouldRefreshOnDemand(active, w, fetchedAt, Date.now())) {
      void refreshWeather();
    }
  }, [currentHole, refreshWeather]);

  // Background/foreground catch-up: native (Capacitor/iOS) suspends JS
  // interval timers while backgrounded, so a round resumed mid-play after a
  // while would otherwise show a stale reading until the next interval tick.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const { weather: w, weatherFetchedAt: fetchedAt, roundActive: active } = weatherLatestRef.current;
      if (shouldRefreshOnDemand(active, w, fetchedAt, Date.now())) {
        void refreshWeather();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshWeather]);

  // Tee-marker color source for the map(s) below. "" (not null) when the round
  // exists but has no stored tee name — that still draws a marker (neutral
  // ink/graphite, an honest "we don't know the color") on hd.tee. null is
  // reserved for genuinely no-round contexts (see GoogleSatelliteMapProps.teeMarker).
  const teeMarker = round?.teeName ?? "";

  // ---------------------------------------------------------------------------
  // Caddie session lifecycle (agentic caddie P1)
  // ---------------------------------------------------------------------------

  // Start the round's caddie session once for ONLINE, in-progress rounds.
  // Hydrates the server session with the player's clubs + handicap so
  // /session/recommend + /session/voice have personal context from turn one.
  useEffect(() => {
    if (!round || isLocalRound || round.status === "completed") return;
    if (caddieSessionStartedRef.current) return;
    caddieSessionStartedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const clubMap = buildClubMap();
        await startCaddieSession({
          round_id: roundId,
          course_id: round.mappedCourseId ?? round.courseId,
          course_name: round.courseName || undefined, // legacy slug-id rescue
          club_distances: Object.keys(clubMap).length > 0 ? clubMap : undefined,
          handicap: getGolferProfile()?.handicap ?? undefined,
        });
        if (!cancelled) setCaddieSessionActive(true);
      } catch {
        // Silent — the caddie sheet falls back to its stateless path.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [round, isLocalRound, roundId]);

  // Fire-and-forget course intelligence once the session exists. Uses the
  // round's stored anchor (mappedCourseId hole coords + courseLat/courseLng)
  // when present; anchor-only rounds still get session weather. The sheet
  // works before (and without) any of this landing — it only adds context.
  useEffect(() => {
    if (!caddieSessionActive || courseIntelSentRef.current || !round) return;
    // With a mapped course, wait for its hole coordinates to resolve; rounds
    // without one go straight to the weather-only path.
    if (mappedCourse && !mapCoordsLoaded) return;
    courseIntelSentRef.current = true;
    const anchor = roundCourseAnchor(round);
    (async () => {
      // Tier-3 floor: cache the round's own yardages so the offline card works
      // even if the intel fetch below never lands (dead cell from the car).
      const baseHoles = round.holes.map((h, i) => ({
        holeNumber: i + 1,
        par: h.par,
        yards: h.yards ?? 0,
        hazards: [] as { type: string; side: string; distance_from_green: number }[],
      }));
      saveHoleIntelBundle({
        roundId,
        courseName: round.courseName,
        savedAt: Date.now(),
        holes: baseHoles,
        lastRecommendation: null,
      }).catch(() => {});

      try {
        if (anchoredCoords.length > 0) {
          const intel = await fetchCourseIntel(
            anchoredCoords.map((c) => ({
              holeNumber: c.holeNumber,
              green: c.green,
              tee: c.tee,
              front: c.front,
              back: c.back,
              par: round.holes[c.holeNumber - 1]?.par,
              // Selected-tee card snapshot beats the bare round.holes yards
              // (spec §2.4 "course-intel yards input") — keeps hole_intel's
              // elevation/effective-yards math coherent with the resolved
              // yardage every other surface reads.
              yards:
                selectedTeeCardYardsFor(courseHoles, round.teeName, c.holeNumber) ??
                round.holes[c.holeNumber - 1]?.yards,
              handicap: round.holes[c.holeNumber - 1]?.handicap,
            })),
            anchor?.lat,
            anchor?.lng,
            roundId,
          );
          if (intel.weather) applyWeather(intel.weather);
          setIntelByHole(
            new Map(
              (intel.holes ?? [])
                .filter((h) => h && typeof h.hole_number === "number")
                .map((h) => [
                  h.hole_number,
                  { elevFt: h.elevation_change_ft ?? 0, effectiveYards: h.effective_yards ?? 0 },
                ])
            )
          );
          // Enrich the offline bundle with hazards + plays-like yardages.
          const byHole = new Map(
            (intel.holes ?? [])
              .filter((h) => h && typeof h.hole_number === "number")
              .map((h) => [h.hole_number, h]),
          );
          saveHoleIntelBundle({
            roundId,
            courseName: round.courseName,
            savedAt: Date.now(),
            holes: baseHoles.map((b) => {
              const hi = byHole.get(b.holeNumber);
              if (!hi) return b;
              return {
                ...b,
                effectiveYards: hi.effective_yards || undefined,
                hazards: (hi.hazards ?? []).map((hz) => ({
                  type: hz.type,
                  side: hz.side,
                  distance_from_green: hz.distance_from_green,
                })),
              };
            }),
            lastRecommendation: null,
          }).catch(() => {});
        } else if (anchor) {
          const w = await fetchWeather(anchor.lat, anchor.lng, roundId);
          applyWeather(w);
        }
      } catch {
        // Silent — recommendations degrade gracefully without intel.
      }
    })();
  }, [caddieSessionActive, mapCoordsLoaded, anchoredCoords, mappedCourse, round, roundId, applyWeather, courseHoles]);

  const hole = HOLES[currentHole - 1] ?? HOLES[0];
  // Prefer round's par data (authoritative); fall back to illustration constant.
  const holePar = round?.holes[currentHole - 1]?.par ?? hole.par;

  // -------------------------------------------------------------------------
  // Live voice caddie (agentic caddie P2) — hold-to-talk realtime burst.
  // Replaces the scripted prototype demo. The transport ladder degrades
  // silently: realtime voice → CaddieSheet (text) → offline card.
  // -------------------------------------------------------------------------
  const voice = useVoiceCaddie({
    roundId,
    personaId,
    enabled: caddieSessionActive && !isLocalRound,
    currentHole,
    onDegradeToText: () => {
      setVoiceOpen(false);
      setCaddieOpen(true);
    },
    onOffline: () => {
      setVoiceOpen(false);
      setOfflineCardOpen(true);
    },
  });

  // Preload the caddie's Realtime session as soon as it's available — by the
  // time the golfer actually presses the orb, the connection is usually
  // already warm (the mic stays withheld until that real press). Fires once,
  // on the transition to available; useVoiceCaddie.warm() is itself
  // idempotent so re-firing this effect is harmless. See lib/voice/warm-session.ts.
  const { warm: warmVoice } = voice;
  useEffect(() => {
    if (caddieSessionActive && !isLocalRound) warmVoice();
  }, [caddieSessionActive, isLocalRound, warmVoice]);

  /** Orb / mic press: hold-to-talk. Opens whichever surface the ladder picks. */
  const handleVoicePress = () => {
    const surface = voice.press();
    if (surface === "voice") setVoiceOpen(true);
  };
  const handleVoiceRelease = () => voice.release();

  // Load the cached bundle when the offline card opens (round data is the floor).
  useEffect(() => {
    if (!offlineCardOpen) return;
    let cancelled = false;
    loadHoleIntelBundle(roundId).then((b) => {
      if (!cancelled) setOfflineBundle(b);
    });
    return () => {
      cancelled = true;
    };
  }, [offlineCardOpen, roundId]);

  // ── Page-turn hole transition (owner 2026-07-07): the persistent map killed
  // the per-hole reload, but a bare camera move read as "the map shifted", not
  // "a new hole". A paper panel now wipes across the card in the swipe
  // direction; the hole (and an instant camera CUT beneath it) changes while
  // covered; the panel sweeps off revealing the new hole — a page of the book.
  const [pageTurn, setPageTurn] = useState<{ dir: 1 | -1; hole: number; id: number } | null>(null);
  const pageTurnSeqRef = useRef(0);
  const pageTurnHoleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pageTurnHoleTimerRef.current) clearTimeout(pageTurnHoleTimerRef.current);
  }, []);
  // Full cover is reached at times[1] of the wipe keyframes (30% of 600ms);
  // the hole cut fires just after, safely under the paper.
  const PAGE_TURN_COVER_MS = 200;

  const goHole = (n: number) => {
    if (n < 1 || n > holeCount) return;
    const dir: 1 | -1 = n > currentHole ? 1 : -1;
    setSlideDir(dir);
    if (mappedCourse || roundAnchor) {
      // Map card: wipe first, change the hole under the cover.
      if (pageTurnHoleTimerRef.current) clearTimeout(pageTurnHoleTimerRef.current);
      setPageTurn({ dir, hole: n, id: ++pageTurnSeqRef.current });
      pageTurnHoleTimerRef.current = setTimeout(() => {
        pageTurnHoleTimerRef.current = null;
        setCurrentHole(n);
      }, PAGE_TURN_COVER_MS);
    } else {
      // Paper fallback keeps its keyed slide — change immediately.
      setCurrentHole(n);
    }
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
      // Round is over — drop any live voice burst immediately (cost control).
      voice.stop();
      // End the caddie session — triggers cross-round memory summarization +
      // learning aggregation server-side. Fire-and-forget; never blocks recap.
      if (caddieSessionActive) {
        endCaddieSession(id).catch(() => {});
        setCaddieSessionActive(false);
      }
      // Show recap; the recap's Done button routes home.
      setRecapOpen(true);
    }
  };

  // ---------------------------------------------------------------------------
  // Derived render values
  // ---------------------------------------------------------------------------

  const distance = Math.max(80, hole.yards - Math.round(hole.yards * 0.6));

  // F/C/B for the tiles under the map: real from-tee distances when the course
  // has verified coords for this hole; the illustration-derived estimate otherwise.
  const holeCoordsForTiles = anchoredCoords.find((c) => c.holeNumber === currentHole) ?? null;

  // Auto opening shot recommendation (specs/caddie-auto-shot-reco-plan.md):
  // resolves the golfer's live GPS distance-to-pin for the Ask Caddie
  // sheet's opening turn. Returns null (honest, never fabricated) on any
  // missing green coords / GPS fix / implausible distance — the sheet then
  // opens idle exactly as today.
  const greenForHole = holeCoordsForTiles?.green ?? null; // {lat,lng} | null
  const teeForHole = holeCoordsForTiles?.tee ?? null; // {lat,lng} | null
  const resolveOpeningShot = useCallback(async () => {
    if (!greenForHole) return null; // no green coords → honest null; skip the GPS wait entirely
    let pos: { lat: number; lng: number } | null = null;
    try {
      pos = await withTimeout(GPSWatcher.getCurrentPosition(), 6000);
    } catch {
      pos = null; // denied / timeout / throw → null, helper attempts tee fallback
    }
    return resolveOpeningShotDistance(pos, teeForHole, greenForHole);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [greenForHole?.lat, greenForHole?.lng, teeForHole?.lat, teeForHole?.lng]);

  // ── Live rangefinder (owner ask): while the round is active, watch GPS and
  // show front/center/back from WHERE THE GOLFER STANDS, updating as they
  // walk. From-tee numbers are the honest fallback (no fix / off-hole).
  const [playerPos, setPlayerPos] = useState<{ lat: number; lng: number } | null>(null);
  const playerPosRef = useRef(playerPos);
  playerPosRef.current = playerPos;
  // SPIKE (specs/passive-shot-tracking-spike.md) — dev-flag-gated draft
  // classifier feed. Rides the SAME watcher above (zero marginal battery
  // cost, no new permission); when the flag is off this setState is never
  // called, so it's a structural no-op. Kept separate from playerPos so the
  // existing rangefinder's ~3yd jitter filter is untouched — the classifier
  // wants every fix, unfiltered, including accuracy/speed.
  const [spikeDriftPos, setSpikeDriftPos] = useState<Position | null>(null);
  useEffect(() => {
    if (!roundActive || !mappedCourse) return;
    const watcher = new GPSWatcher(
      (pos) => {
        const prev = playerPosRef.current;
        // Re-render only on meaningful movement (~3yd) — GPS jitter isn't a walk.
        if (!prev || yardsDistance(prev, pos) >= 3) {
          setPlayerPos({ lat: pos.lat, lng: pos.lng });
        }
        if (process.env.NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS === "1") {
          setSpikeDriftPos(pos);
        }
      },
      () => setPlayerPos(null), // denied/unavailable → honest from-tee tiles
    );
    watcher.start();
    return () => watcher.stop();
  }, [roundActive, mappedCourse]);

  const fcbFromTee = holeCoordsForTiles?.tee
    ? computeFCBDistances(holeCoordsForTiles.tee, holeCoordsForTiles)
    : null;
  // Plausibility: on/near this hole = within 800y of the green and not on top
  // of it. Anything else (home testing, wrong hole selected) reads from tee.
  const posOnHole =
    playerPos && holeCoordsForTiles?.green
      ? (() => {
          const d = yardsDistance(playerPos, holeCoordsForTiles.green);
          return d >= 5 && d <= 800;
        })()
      : false;
  const fcbLive = posOnHole && playerPos ? computeFCBDistances(playerPos, holeCoordsForTiles!) : null;
  // Which stored tee box (if any) resolveTeeAnchor picked for this hole —
  // drives the honest card-only fallback below (spec:
  // multi-tee-anchor-reconciliation §fix.5). null on legacy/unmapped rounds.
  const teeAnchor = anchorByHole.get(currentHole) ?? null;
  const cardYards = round?.holes[currentHole - 1]?.yards ?? null;
  // GPS override is untouched and still wins over the anchor (spec §fix.4) —
  // resolveFcbSource returns "you" whenever fcbLive is present, regardless
  // of the anchor's source; see lib/course/tee-anchor.test.ts for the
  // explicit precedence assertions.
  const fcbSource = resolveFcbSource(teeAnchor?.source ?? null, fcbLive != null);
  const fcb = fcbLive ?? fcbFromTee;
  // Widened card-only decision (cycle 62 no-fake-data): the SAME condition the
  // F/C/B tiles collapse on — fcb == null || fcbSource === 'card'. The old
  // narrow `showCardOnly = fcbSource === 'card'` left the plays/physics basis
  // keyed off a narrower flag than the tiles, so in the anchor-only unmapped
  // state (fcb null, source 'tee', fcbFromTee null) the tiles read honest "—"
  // while the plays basis fell to the `distance` placeholder. Both now key off
  // this one flag, so the plays tile stays coherent with the tiles.
  const effectiveCardOnly = effectiveFcbSource(fcbSource, fcb) === "card";
  // Caption honesty: when there is no real F/C/B geometry (fcb == null) the
  // tiles fall back to card-only (see buildFcbTiles) — so the caption must read
  // "from the card", never "from the tee" over honest "—" tiles. Derive it from
  // the SAME cardOnly condition as the tile values (fcbSource === 'card' || fcb
  // == null); the three working paths keep fcb non-null, so this is unchanged
  // for them.
  const fcbCaption = fcbSourceCaption(effectiveFcbSource(fcbSource, fcb));
  // TODO(fcb §4.5): line-vs-card hint held pending designer sign-off on the
  // card-yardage source (`distance` here is a derived display value, not the
  // literal scorecard yardage — see specs/fcb-caption-visibility-plan.md §4.5).
  // Tile VALUES via the pure helper — collapses every "no real F/C/B geometry"
  // state to the honest card-only tiles instead of the old fabricated
  // `distance ± offset` numbers (no-fake-data; see lib/course/fcb-tiles.ts).
  // The plays/physics/caption inputs below key off `effectiveCardOnly` (the
  // SAME widened condition as the tiles), so the PLAYS tile can no longer show
  // the `distance` placeholder while the tiles read honest "—".
  const fcbTileValues = buildFcbTiles({ fcb, fcbSource, cardYards });
  const fcbTiles: { k: string; v: number | string; color: string }[] = [
    { k: "Front", v: fcbTileValues.front, color: "#a8553f" },
    { k: "Center", v: fcbTileValues.center, color: T.ink },
    { k: "Back", v: fcbTileValues.back, color: "#5d7285" },
  ];
  // Selected-tee geometry yards — the resolved (named/card/ordinal) tee box's
  // straight-line distance to the green, from the SAME anchor the F/C/B tiles
  // use (fcbFromTee).
  const selectedTeeGeomYards = fcbFromTee?.center ?? null;
  // Selected-tee CARD yards — the mapped course's real per-tee scorecard
  // yardage (CourseData.holes[].yardages, keyed by tee name), matched against
  // the round's teeName the same tolerant way tee-anchor matches OSM tags
  // (spec §2.2). This is what resolves Bethpage hole 3 to 231 for "Black" —
  // independent of `round.holes[i].yards`, which the standard round/new flow
  // never populates. Honestly null when the course isn't mapped, has no
  // recorded per-tee card, or the round has no selected tee.
  const selectedTeeCardYards =
    selectedTeeCardYardsFor(courseHoles, round?.teeName, currentHole) ?? null;
  // ONE shared resolver (spec §2.1) — GPS-to-green (live, gated on-hole) beats
  // the selected tee's card yards, beats its mapped geometry, beats a bare
  // scorecard snapshot, beats honest null. Every caddie/grounding surface
  // (sheet header, offline card, voice requests) reads THIS value — never the
  // mock illustration constant (`hole.yards`), which is banned from every
  // surface except the true paper-only fallback below.
  const resolvedYardage = resolveHoleYardage({
    fcbLive,
    selectedTeeCardYards,
    selectedTeeGeomYards,
    cardYards,
    par: holePar,
  });
  const yardsCaption = yardageCaption(resolvedYardage, round?.teeName ?? null, holePar);
  // The mock illustration number is the LAST resort, and only on the true
  // paper fallback (no mapped course / round anchor at all) — a mapped-course
  // round must never fall back to the mock number (that's exactly this
  // incident: a phantom 178/232 disagreement from two different sources).
  const headerYards = resolvedYardage.yards ?? (mappedCourse || roundAnchor ? null : hole.yards);
  // Per-hole relative wind: same weather, different bearing per hole.
  const holeBearing = holeCoordsForTiles?.tee && holeCoordsForTiles?.green
    ? bearingDeg(holeCoordsForTiles.tee, holeCoordsForTiles.green)
    : null;
  const holeWind = weather && holeBearing != null
    ? relativeWind(weather.wind_direction, holeBearing, weather.wind_speed_mph)
    : null;
  const windTile = weather
    ? {
        v: `${Math.round(weather.wind_speed_mph)}mph`,
        // With no hole bearing (no coords) the honest label is the compass
        // source, not a made-up relative direction.
        sub: holeWind ? holeWind.label : `from ${compassFrom(weather.wind_direction)}`,
      }
    : { v: "—", sub: "no data" };
  // Elev tile — REAL per-hole USGS delta from course-intel (owner wants it
  // back; never the old hardcoded '+3ft'). "—" until intel lands.
  const holeIntel = intelByHole.get(currentHole) ?? null;
  const elevTile = holeIntel
    ? {
        v: `${holeIntel.elevFt >= 0 ? "+" : ""}${Math.round(holeIntel.elevFt)}ft`,
        sub:
          Math.abs(holeIntel.elevFt) < ELEV_DEADBAND_FT
            ? "level"
            : holeIntel.elevFt > 0
              ? "uphill"
              : "downhill",
      }
    : { v: "—", sub: "elev" };
  // Plays-like: physics-tiles-coherence (specs/physics-tiles-coherence-plan.md)
  // — the PLAYS tile shows the SAME plays_like_yards the backend physics engine
  // gives the caddie, via usePhysicsPlaysLike below, instead of the deprecated
  // frontend wind heuristic. The basis selection is the pure `playsBasis`
  // helper (lib/caddie/plays-basis.ts): it keys off `effectiveCardOnly` (not
  // the old narrow flag) and NEVER receives the `distance` placeholder, so the
  // fabricated-fallback leak is gone. `playsBase` is the honest fallback while
  // no physics response has landed (§5's offline/error row) — elevation-
  // composed intel yards when known, never combined with wind locally;
  // `physicsBasisYards` is the RAW basis (never effectiveYards — the engine
  // applies elevation itself; a pre-adjusted basis would double-count it,
  // plan §4.2). Both are null only when there is no honest basis at all
  // (card-only with no scorecard yardage) → the tile shows "—".
  const { playsBase, physicsBasisYards } = playsBasis({
    fcbLive,
    effectiveCardOnly,
    cardYards,
    holeIntel,
    fcbFromTee,
  });
  const physicsPlaysLike = usePhysicsPlaysLike({
    roundId,
    enabled: caddieSessionActive && !isLocalRound,
    currentHole,
    basisYards: physicsBasisYards,
    weatherFetchedAt,
  });
  const playsTile =
    playsBase == null
      ? // No honest basis (card-only with no scorecard yardage): show "—",
        // coherent with the "—" F/C/B center — never a fabricated number.
        { v: "—", sub: "no data" }
      : playsTileDisplay({
          physics: physicsPlaysLike,
          basisYards: physicsBasisYards ?? playsBase,
          fallbackYards: playsBase,
          isLive: fcbLive != null,
          fromCard: effectiveCardOnly,
          hasLocalIntel: holeIntel != null && !effectiveCardOnly,
        });
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
            <VoiceOrb
              state={voice.voiceState}
              accent={accent}
              onPressStart={handleVoicePress}
              onPressEnd={handleVoiceRelease}
            />
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

          {/* Hole picker pill — overlaid on the map when the round has course
              data (owner request 2026-07-02: maximize map space); standalone
              row only for the mock fallback. */}
          {!(mappedCourse || roundAnchor) && (
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
          )}

          {/* Hero hole card — swipe L/R.
              Map branch (mappedCourse || roundAnchor): a PERSISTENT, un-keyed
              container mounted ONCE per round — the native Google map is
              created once and hole changes pan its camera (GoogleSatelliteMap
              already does this internally). Previously this branch lived
              INSIDE the keyed `motion.div key={currentHole}` below, so every
              hole swipe destroyed + recreated the native map, showing
              "Loading map…" on every hole (owner 2026-07-06). The paper
              fallback (mock round, no course data) keeps its keyed slide
              transition — it's a cheap SVG, remounting is fine. */}
          {mappedCourse || roundAnchor ? (
            /* Map-first hole view: the satellite map IS the card, with the
               hole picker + hole stats as static overlays (owner request
               2026-07-02). Map touches pan the map — but a fast, clearly
               horizontal flick flips to the prev/next hole (the camera
               re-frames on the new hole, so any incidental pan resets).
               Overlay chrome below re-reads currentHole on every render —
               no keyed transition needed since this container never remounts. */
            <div
              style={{
                position: "relative",
                borderRadius: 20,
                overflow: "hidden",
                border: `1px solid ${T.hairline}`,
                boxShadow: "0 8px 24px rgba(26,42,26,0.06)",
                marginBottom: 14,
                touchAction: "pan-y",
              }}
              onPointerDownCapture={(e) => {
                // Keep the framer drag wrapper off map touches (it would
                // rubber-band the card while the native map pans); overlay
                // chips remain wrapper swipe surface.
                const el = e.target as HTMLElement;
                if (!el.closest("[data-overlay]")) e.stopPropagation();
              }}
              onTouchStart={(e) => {
                mapSwipeRef.current =
                  e.touches.length === 1
                    ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }
                    : null; // pinch → never a hole swipe
              }}
              onTouchEnd={(e) => {
                const s = mapSwipeRef.current;
                mapSwipeRef.current = null;
                if (!s || e.changedTouches.length !== 1) return;
                const dx = e.changedTouches[0].clientX - s.x;
                const dy = e.changedTouches[0].clientY - s.y;
                // Fast + far + decisively horizontal = hole swipe.
                if (Date.now() - s.t < 600 && Math.abs(dx) > 70 && Math.abs(dx) > 1.8 * Math.abs(dy)) {
                  haptic("light");
                  goHole(dx < 0 ? currentHole + 1 : currentHole - 1);
                }
              }}
            >
              <InlineHoleDiagram
                courseId={mappedCourse?.id}
                fallbackCenter={roundAnchor ?? undefined}
                currentHole={currentHole}
                height={mapHeight}
                teeMarker={teeMarker}
                cameraTransition="cut"
                teeOverrideByHole={teeOverrideByHole}
              />

              {/* Page-turn wipe — sweeps across in the swipe direction, the
                  hole cuts underneath (goHole's timer), then reveals. Enters
                  from the side you're heading toward, like pulling a page. */}
              <AnimatePresence>
                {pageTurn && (
                  <motion.div
                    key={pageTurn.id}
                    initial={{ x: pageTurn.dir > 0 ? "104%" : "-104%" }}
                    animate={{
                      x: [
                        pageTurn.dir > 0 ? "104%" : "-104%",
                        "0%",
                        "0%",
                        pageTurn.dir > 0 ? "-104%" : "104%",
                      ],
                    }}
                    transition={{ duration: 0.6, times: [0, 0.3, 0.55, 1], ease: "easeInOut" }}
                    onAnimationComplete={() => {
                      // Only clear if a newer turn hasn't replaced this one.
                      setPageTurn((pt) => (pt && pt.id === pageTurn.id ? null : pt));
                    }}
                    style={{
                      position: "absolute",
                      inset: 0,
                      zIndex: 7,
                      pointerEvents: "none",
                      background: `${PAPER_NOISE}, ${T.paper}`,
                      backgroundBlendMode: "multiply",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 2,
                      boxShadow: "0 0 22px rgba(26,42,26,0.18)",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.8,
                        color: T.pencilSoft,
                        textTransform: "uppercase",
                      }}
                    >
                      Hole
                    </div>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 56,
                        lineHeight: 1,
                        color: T.ink,
                        opacity: 0.85,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {pageTurn.hole}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Hole picker — static overlay, top-left */}
                  <button
                    data-overlay
                    onClick={() => setHolePickerOpen(true)}
                    aria-label="Switch hole"
                    style={{
                      position: "absolute",
                      top: 10,
                      left: 10,
                      zIndex: 6,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "7px 12px",
                      borderRadius: 99,
                      border: `1px solid ${T.hairline}`,
                      background: `${T.paper}f0`,
                      backdropFilter: "blur(6px)",
                      color: T.ink,
                      fontFamily: T.mono,
                      fontSize: 10.5,
                      letterSpacing: 1.2,
                      textTransform: "uppercase",
                      cursor: "pointer",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <rect x="3" y="3" width="7" height="7" rx="1.5" />
                      <rect x="14" y="3" width="7" height="7" rx="1.5" />
                      <rect x="3" y="14" width="7" height="7" rx="1.5" />
                      <rect x="14" y="14" width="7" height="7" rx="1.5" />
                    </svg>
                    {currentHole} / {holeCount}
                  </button>

                  {/* Hole stats — static overlay, top-right, small mono */}
                  <div
                    data-overlay
                    style={{
                      position: "absolute",
                      top: 10,
                      right: 10,
                      zIndex: 6,
                      padding: "7px 12px",
                      borderRadius: 99,
                      border: `1px solid ${T.hairline}`,
                      background: `${T.paper}f0`,
                      backdropFilter: "blur(6px)",
                      color: T.ink,
                      fontFamily: T.mono,
                      fontSize: 10.5,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      fontVariantNumeric: "tabular-nums",
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                    }}
                  >
                    <span style={{ fontFamily: T.serif, fontSize: 15, letterSpacing: -0.3, textTransform: "none" }}>
                      {String(currentHole).padStart(2, "0")}
                    </span>
                    <span>Par {holePar}</span>
                    <span>{headerYards != null ? `${headerYards}y` : "—"}</span>
                    <span style={{ color: T.pencil }}>Hcp {hole.hcp}</span>
                  </div>

                  {/* Zoom — bottom-right corner of the MAP portion (the card
                      continues below with the stats section, so anchor by the
                      map's height rather than the card bottom). */}
                  <button
                    data-overlay
                    onClick={() => {
                      if (!draggedRef.current) setMapZoom(true);
                    }}
                    aria-label="Expand map"
                    style={{
                      position: "absolute",
                      top: mapHeight - 40,
                      right: 10,
                      zIndex: 6,
                      padding: "6px 10px",
                      borderRadius: 99,
                      background: "rgba(26,42,26,0.85)",
                      color: T.paper,
                      fontFamily: T.mono,
                      fontSize: 9,
                      letterSpacing: 1.2,
                      textTransform: "uppercase",
                      border: "none",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      backdropFilter: "blur(4px)",
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                      <path d="M1 4V1h3M9 4V1H6M1 6v3h3M9 6v3H6" />
                    </svg>
                    Zoom
                  </button>

                  <DistancesCard
                    fcbCaption={fcbCaption}
                    fcbTiles={fcbTiles}
                    windTile={windTile}
                    elevTile={elevTile}
                    playsTile={playsTile}
                  />
                </div>
          ) : (
            /* Mock/no-course fallback: cheap SVG-ish card, keeps its keyed
               slide transition — remounting this on every hole is fine. */
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
                  windMph={weather ? Math.round(weather.wind_speed_mph) : 0}
                  windDir={holeWind ? holeWind.label : weather ? `from ${compassFrom(weather.wind_direction)}` : "—"}
                  expanded={expanded}
                  onExpand={() => {
                    if (!draggedRef.current) setExpanded(true);
                  }}
                  onCollapse={() => setExpanded(false)}
                  onZoom={() => {
                    if (!draggedRef.current) setExpanded(true);
                  }}
                  accent={accent}
                  density={density}
                  shotPoint={shotPoint}
                />
              </motion.div>
            </AnimatePresence>
          )}

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
          {/* Ask Caddie — ghost pill (#11: flexShrink:1 so it compresses on 320px)
              Pill/orb interplay (specs/omnipresent-caddie-orb-plan.md §1): this
              pill IS the caddie invocation on the round page —
              shouldShowCaddieOrb('/round/[id]') is false, so the omnipresent
              CaddieOrb hides here on purpose. One mic, never two. */}
          <motion.button
            aria-label="Ask caddie"
            onClick={() => {
              // One mic at a time: stop any live/warm orb session before the
              // sheet's dictation path opens its own stream (the degrade path
              // already does this; the manual open must too).
              voice.stop();
              setCaddieOpen(true);
            }}
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
            {/* Looper ink-orb medallion — matches LooperOrb identity (FloatingTabBar.tsx) at pill scale */}
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: T.ink,
                border: `1px solid ${T.hairline}`,
                boxShadow: "0 1px 4px rgba(26,42,26,0.20), 0 1px 0 rgba(255,255,255,0.25) inset",
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
              L
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
        onClose={() => {
          // Mic off on close; the connection stays warm for a follow-up and
          // the 90s idle timer disconnects it if none comes.
          voice.release();
          setVoiceOpen(false);
        }}
        accent={accent}
        caddy={caddy}
        voiceState={voice.voiceState}
        turns={voice.turns}
        onMicDown={handleVoicePress}
        onMicUp={handleVoiceRelease}
      />

      {/* Tier-3 offline caddie: static card from the cached HoleIntelBundle. */}
      <OfflineCaddieCard
        open={offlineCardOpen}
        onClose={() => setOfflineCardOpen(false)}
        holeNumber={currentHole}
        par={holePar}
        yards={resolvedYardage.yards}
        yardsCaption={yardsCaption}
        intel={offlineBundle?.holes.find((h) => h.holeNumber === currentHole) ?? null}
        lastRecommendation={offlineBundle?.lastRecommendation ?? null}
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

      {/* SPIKE (specs/passive-shot-tracking-spike.md) — dev flag, off by
          default everywhere. Draft-only: never writes a shot. Confirming
          hands into the EXISTING "Ask caddie" pill below (setCaddieOpen),
          not a new voice/write path. */}
      {process.env.NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS === "1" && (
        <PassiveShotDraftBanner
          position={spikeDriftPos}
          onOpenCaddie={() => setCaddieOpen(true)}
        />
      )}

      <CaddieSheet
        open={caddieOpen}
        onClose={() => setCaddieOpen(false)}
        caddy={caddy}
        accent={accent}
        holeNumber={currentHole}
        holePar={holePar}
        holeYards={resolvedYardage.yards}
        yardsCaption={yardsCaption}
        yardageBasis={resolvedYardage.basis}
        teeName={round?.teeName ?? null}
        convHistory={caddieHistory}
        onUpdateConvHistory={setCaddieHistory}
        roundId={roundId}
        sessionActive={caddieSessionActive && !isLocalRound}
        personaId={personaId}
        personas={personas}
        onSelectPersona={selectPersona}
        resolveOpeningShot={caddieSessionActive && !isLocalRound ? resolveOpeningShot : undefined}
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
          holeCoordinates={anchoredCoords}
          currentHole={currentHole}
          onHoleChange={goHole}
          onClose={() => setMapZoom(false)}
          autoDetectHole={false}
          centerOnly={anchoredCoords.length === 0}
          fallbackCenter={mapCenter ?? roundAnchor ?? undefined}
          teeMarker={teeMarker}
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
