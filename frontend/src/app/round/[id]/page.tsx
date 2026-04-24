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
import { Round } from "@/lib/types";
import { getRound, saveRound } from "@/lib/storage";
import { hapticCelebration } from "@/lib/haptics";

const SEED_SCORES: Record<string, (number | null)[]> = {
  p1: [4, 5, 3, 6, 4, 4, 3, null, null, null, null, null, null, null, null, null, null, null],
  p2: [5, 5, 4, 5, 4, 5, 3, null, null, null, null, null, null, null, null, null, null, null],
  p3: [4, 4, 3, 5, 4, 4, 3, null, null, null, null, null, null, null, null, null, null, null],
  p4: [6, 5, 4, 6, 5, 5, 4, null, null, null, null, null, null, null, null, null, null, null],
};

const SEED_PLAYERS: SeedPlayer[] = [
  { id: "p1", name: "You", hcp: 8, color: "#1a2a1a" },
  { id: "p2", name: "Jordan", hcp: 12, color: "#6b3a1a" },
  { id: "p3", name: "Sam", hcp: 4, color: "#3a3a6a" },
  { id: "p4", name: "Riley", hcp: 18, color: "#6a3a3a" },
];

export default function RoundPage() {
  const params = useParams();
  const router = useRouter();
  const accent = DEFAULT_ACCENT;
  const density: "dense" | "spacious" = "dense";
  const caddy: Caddy = CADDIES.find((c) => c.id === "steve") ?? CADDIES[0];

  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(true);

  const [currentHole, setCurrentHole] = useState(8);
  const [expanded, setExpanded] = useState(true);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [slideDir, setSlideDir] = useState(0);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [turnIdx, setTurnIdx] = useState(0);
  const [scores, setScores] = useState(SEED_SCORES);
  const draggedRef = useRef(false);

  useEffect(() => {
    const id = params.id as string;
    const r = getRound(id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (r) setRound(r);
    setLoading(false);
  }, [params.id]);

  const hole = HOLES[currentHole - 1];

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

  const handleSetScore = (pid: string, idx: number, val: number | null) => {
    setScores((prev) => {
      const next = { ...prev };
      const arr = [...(next[pid] ?? [])];
      arr[idx] = val;
      next[pid] = arr;
      return next;
    });
  };

  const distance = Math.max(80, hole.yards - Math.round(hole.yards * 0.6));
  const pathPts = hole.path;
  const midIdx = Math.max(1, pathPts.length - 2);
  const shotPoint: [number, number] | null = pathPts[midIdx]
    ? [(pathPts[midIdx][0] + pathPts[midIdx + 1][0]) / 2, (pathPts[midIdx][1] + pathPts[midIdx + 1][1]) / 2 + 0.05]
    : null;

  const handleFinish = () => {
    if (round) {
      const updated: Round = { ...round, status: "completed", updatedAt: new Date().toISOString() };
      setRound(updated);
      saveRound(updated);
      hapticCelebration();
    }
    router.push("/");
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
            padding: "54px 18px 10px",
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
            {"\u2190"}
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
            <VoiceOrb state={voiceState} accent={accent} onTap={() => setVoiceOpen(true)} />
            <div style={{ lineHeight: 1.1 }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>
                {round?.courseName ?? "Pebble Beach"} · {new Date().toLocaleDateString("en-US", { weekday: "short" })} {new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 19, fontStyle: "italic", color: T.ink, letterSpacing: -0.3 }}>Round in progress</div>
            </div>
          </div>
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

        {/* pull-down hint */}
        <motion.div
          animate={{ opacity: voiceOpen ? 0 : [0.3, 0.65, 0.3] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          style={{
            position: "absolute",
            top: 44,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 25,
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.4,
            color: T.pencilSoft,
            textTransform: "uppercase",
            pointerEvents: "none",
          }}
        >
          ▼ pull · hey caddy
        </motion.div>

        {/* Scroll body */}
        <div
          style={{
            position: "absolute",
            top: 96,
            left: 0,
            right: 0,
            bottom: 0,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "0 14px 110px",
            WebkitOverflowScrolling: "touch",
          }}
        >
          {/* Hole nav chips */}
          <div style={{ display: "flex", gap: 5, marginBottom: 12, overflowX: "auto", paddingBottom: 4, scrollSnapType: "x proximity" }}>
            {Array.from({ length: 18 }, (_, i) => i + 1).map((h) => {
              const isCur = h === currentHole;
              const played = scores.p1[h - 1] != null;
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
                    // Zoom overlay is an enhancement — for now we just keep expanded
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
              {SEED_PLAYERS.map((p) => (
                <PlayerPanel
                  key={p.id}
                  player={p}
                  scores={scores[p.id]}
                  pars={HOLES.map((h) => h.par)}
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
            {round?.courseName ?? "Pebble Beach Golf Links"} · 6,828 yds · Par 72
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
        hole={{ number: currentHole, par: hole.par }}
        players={SEED_PLAYERS}
        scores={scores}
        onSetScore={handleSetScore}
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
