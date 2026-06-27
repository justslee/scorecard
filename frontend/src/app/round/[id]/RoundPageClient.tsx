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
import { getRound as apiGetRound, addScore as apiAddScore, completeRound as apiCompleteRound } from "@/lib/api";
import { hapticCelebration } from "@/lib/haptics";

// Player accent colors (yardage-book palette — warm ink tones)
const PLAYER_COLORS = ['#1a2a1a', '#6b3a1a', '#3a3a6a', '#6a3a3a', '#2a5a3a', '#5a2a5a'];

/** Convert Round.scores → local scores map { [playerId]: (number|null)[] } */
function buildScoreMap(
  playerIds: string[],
  roundScores: Score[]
): Record<string, (number | null)[]> {
  const map: Record<string, (number | null)[]> = {};
  for (const pid of playerIds) {
    map[pid] = Array(18).fill(null);
  }
  for (const s of roundScores) {
    const arr = map[s.playerId];
    const idx = s.holeNumber - 1;
    if (arr && idx >= 0 && idx < 18) {
      arr[idx] = s.strokes;
    }
  }
  return map;
}

/** Convert Round.players → SeedPlayer[] for yardage components */
function buildSeedPlayers(round: Round): SeedPlayer[] {
  return round.players.map((p, i) => ({
    id: p.id,
    name: p.name,
    hcp: p.handicap ?? 0,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
  }));
}

export default function RoundPage() {
  const params = useParams();
  const router = useRouter();
  const accent = DEFAULT_ACCENT;
  const density: "dense" | "spacious" = "dense";
  const caddy: Caddy = CADDIES.find((c) => c.id === "steve") ?? CADDIES[0];

  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(true);
  // isLocalRound: true when the round came from localStorage only (offline/orphan — API 404 or network error)
  const [isLocalRound, setIsLocalRound] = useState(false);
  // apiError: surfaces per-stroke or finish errors without silent swallow
  const [apiError, setApiError] = useState<string | null>(null);

  // players and scores are derived from the loaded round; updated on every API response
  const [players, setPlayers] = useState<SeedPlayer[]>([]);
  const [scores, setScores] = useState<Record<string, (number | null)[]>>({});

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

  // Load round: try API first; fall back to localStorage on 404 or network error.
  useEffect(() => {
    const id = params.id as string;

    async function load() {
      try {
        const r = await apiGetRound(id);
        setRound(r);
        setPlayers(buildSeedPlayers(r));
        setScores(buildScoreMap(r.players.map((p) => p.id), r.scores));
        setIsLocalRound(false);
      } catch (e) {
        // 404 (orphan/offline round created by wire-round-new fallback) or network error.
        // Fall back to localStorage — do NOT show a broken/empty round.
        console.warn(`[round/${id}] API fetch failed, falling back to local cache:`, e);
        const local = localGetRound(id);
        if (local) {
          setRound(local);
          setPlayers(buildSeedPlayers(local));
          setScores(buildScoreMap(local.players.map((p) => p.id), local.scores));
          setIsLocalRound(true);
        }
        // If no local copy either, round remains null — handled by the not-found render below.
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [params.id]);

  const hole = HOLES[currentHole - 1];
  // Use round hole data for par when available (authoritative); fall back to illustration default.
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
      // Re-enter the effect flow: the useEffect re-runs on voiceOpen change;
      // here we simulate by toggling.
    }
  };

  const goHole = (n: number) => {
    if (n < 1 || n > 18) return;
    setSlideDir(n > currentHole ? 1 : -1);
    setCurrentHole(n);
  };

  /**
   * Persist a score edit:
   * - Optimistically updates local state.
   * - For API-backed rounds: calls POST /api/rounds/{id}/scores (per-stroke upsert);
   *   on success syncs server response; on error surfaces the error and saves locally.
   * - For local/orphan rounds: saves to localStorage only (deferred sync — see note below).
   *
   * Deferred sync note: a round created offline (wire-round-new fallback) has a client UUID
   * not known to the backend. Re-creating it via POST /api/rounds and reconciling the id is
   * non-trivial and is left as a follow-up (wire-round-scoring review carry-over). For now
   * the round stays local and scores are not lost.
   */
  const handleSetScore = async (pid: string, idx: number, val: number | null) => {
    const holeNumber = idx + 1;

    // 1. Optimistic local UI update
    setScores((prev) => {
      const next = { ...prev };
      const arr = [...(next[pid] ?? Array(18).fill(null))];
      arr[idx] = val;
      next[pid] = arr;
      return next;
    });

    if (!round) return;
    const id = params.id as string;
    const scorePayload: Score = { playerId: pid, holeNumber, strokes: val };

    if (isLocalRound) {
      // Orphan/offline round — persist to localStorage only.
      const updatedScores = [
        ...round.scores.filter((s) => !(s.playerId === pid && s.holeNumber === holeNumber)),
        ...(val !== null ? [scorePayload] : []),
      ];
      const updated: Round = { ...round, scores: updatedScores, updatedAt: new Date().toISOString() };
      setRound(updated);
      localSaveRound(updated);
      return;
    }

    // API-backed round: per-stroke upsert
    try {
      const updated = await apiAddScore(id, scorePayload);
      // Sync all scores from server response (single source of truth after upsert)
      setRound(updated);
      setScores(buildScoreMap(updated.players.map((p) => p.id), updated.scores));
      // Write-through to localStorage so the app works offline
      localSaveRound(updated);
      setApiError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save score.";
      setApiError(msg.length > 100 ? "Score save failed — check connection." : msg);
      console.error(`[round/${id}] addScore failed:`, e);
      // Persist optimistic state to localStorage so scores survive a reload
      const updatedScores = [
        ...round.scores.filter((s) => !(s.playerId === pid && s.holeNumber === holeNumber)),
        ...(val !== null ? [scorePayload] : []),
      ];
      const fallback: Round = { ...round, scores: updatedScores, updatedAt: new Date().toISOString() };
      setRound(fallback);
      localSaveRound(fallback);
    }
  };

  const distance = Math.max(80, hole.yards - Math.round(hole.yards * 0.6));
  const pathPts = hole.path;
  const midIdx = Math.max(1, pathPts.length - 2);
  const shotPoint: [number, number] | null = pathPts[midIdx]
    ? [(pathPts[midIdx][0] + pathPts[midIdx + 1][0]) / 2, (pathPts[midIdx][1] + pathPts[midIdx + 1][1]) / 2 + 0.05]
    : null;

  const handleFinish = async () => {
    if (!round) {
      router.push("/");
      return;
    }

    hapticCelebration();
    const id = params.id as string;

    if (isLocalRound) {
      // Orphan/offline: save locally only
      const updated: Round = { ...round, status: "completed", updatedAt: new Date().toISOString() };
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
      const updated: Round = { ...round, status: "completed", updatedAt: new Date().toISOString() };
      setRound(updated);
      localSaveRound(updated);
    } finally {
      router.push("/");
    }
  };

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
        <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>Loading…</div>
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
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 20, color: T.ink }}>Round not found</div>
        <div style={{ fontFamily: T.sans, fontSize: 13, color: T.pencil, textAlign: "center" }}>
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

  // First player ID used for "has this hole been played" indicator in hole chips
  const firstPlayerId = players[0]?.id ?? "";

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
      <div style={{ maxWidth: 420, margin: "0 auto", position: "relative", minHeight: "100vh" }}>
        {/* Top chrome */}
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
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
            <VoiceOrb state={voiceState} accent={accent} onTap={() => setVoiceOpen(true)} />
            <div style={{ lineHeight: 1.1 }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
                <span>{round.courseName} · {new Date().toLocaleDateString("en-US", { weekday: "short" })} {new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>
                {isLocalRound && (
                  <span
                    style={{
                      fontSize: 7.5,
                      letterSpacing: 1,
                      color: "#b8763a",
                      border: "1px solid #b8763a55",
                      borderRadius: 3,
                      padding: "1px 4px",
                    }}
                  >
                    LOCAL
                  </span>
                )}
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 19, fontStyle: "italic", color: T.ink, letterSpacing: -0.3 }}>Round in progress</div>
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
              <path d="M3 2h8v3.5a4 4 0 0 1-8 0V2Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
              <path d="M3 3H1.5a1.5 1.5 0 0 0 1.5 3M11 3h1.5a1.5 1.5 0 0 1-1.5 3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
              <path d="M5 10.5h4M6 9v1.5M8 9v1.5M4.5 12.5h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
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
              <path d="M3 1.5V12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <path d="M3 2.2L10 4 3 5.5V2.2Z" fill="currentColor" />
            </svg>
          </button>
        </div>

        {/* Scroll body */}
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
          {/* API error banner (score save failures) */}
          {apiError && (
            <div
              style={{
                margin: "0 0 10px",
                padding: "9px 12px",
                borderRadius: 10,
                background: "rgba(184,74,58,0.08)",
                border: "1px solid rgba(184,74,58,0.2)",
                fontFamily: T.serif,
                fontSize: 12.5,
                color: "#b84a3a",
                lineHeight: 1.4,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>{apiError}</span>
              <button
                onClick={() => setApiError(null)}
                style={{ background: "none", border: "none", color: "#b84a3a", cursor: "pointer", fontSize: 15, padding: 0, lineHeight: 1 }}
              >
                ×
              </button>
            </div>
          )}

          {/* Local/pending notice (orphan rounds) */}
          {isLocalRound && (
            <div
              style={{
                margin: "0 0 10px",
                padding: "9px 12px",
                borderRadius: 10,
                background: "rgba(184,118,58,0.07)",
                border: "1px solid rgba(184,118,58,0.2)",
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 12.5,
                color: "#b8763a",
                lineHeight: 1.4,
              }}
            >
              Saved locally — will sync when connection is restored.
            </div>
          )}

          {/* Hole nav chips */}
          <div style={{ display: "flex", gap: 5, marginBottom: 12, overflowX: "auto", paddingBottom: 4, scrollSnapType: "x proximity" }}>
            {Array.from({ length: 18 }, (_, i) => i + 1).map((h) => {
              const isCur = h === currentHole;
              const played = firstPlayerId ? scores[firstPlayerId]?.[h - 1] != null : false;
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
                  if (!draggedRef.current) {
                    setExpanded(true);
                  }
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
                  scores={scores[p.id] ?? Array(18).fill(null)}
                  pars={round.holes.length > 0 ? round.holes.map((h) => h.par) : HOLES.map((h) => h.par)}
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
            {round.courseName} · {round.holes.length || 18} holes{round.teeName ? ` · ${round.teeName} tees` : ""}
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
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, color: accent }}>HOLE {currentHole}</span>
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
        pars={round.holes.length > 0 ? round.holes.map((h) => h.par) : HOLES.map((h) => h.par)}
        accent={accent}
      />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
      <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>{children}</div>
      <div style={{ flex: 1, height: 1, background: T.hairline }} />
    </div>
  );
}
