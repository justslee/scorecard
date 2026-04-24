"use client";

import { useEffect, useState, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT, CADDIES } from "@/components/yardage/tokens";
import { saveRound, getCourses, saveCourse } from "@/lib/storage";
import { createDefaultCourse, Round } from "@/lib/types";

type GameId = "stroke" | "match" | "skins" | "nassau" | "stable" | "wolf" | "vegas" | "bbb" | "bb" | "scr" | "quota" | "none";
type TeeId = "black" | "blue" | "white" | "gold" | "red";
type SideId = "snake" | "presses" | "greenies" | "sandies";
type Picker = null | "game" | "tee" | "sides" | "holes";

const GAME_OPTIONS: { id: GameId; l: string; sub: string; tag: string | null }[] = [
  { id: "stroke", l: "Stroke play", sub: "Classic. Lowest total wins.", tag: "Solo OK" },
  { id: "match", l: "Match play", sub: "Hole by hole. First to close it out wins.", tag: "1v1" },
  { id: "skins", l: "Skins", sub: "Low score on a hole takes the pot.", tag: "$ per hole" },
  { id: "nassau", l: "Nassau", sub: "Three bets: front 9, back 9, overall.", tag: "$20·20·20" },
  { id: "stable", l: "Stableford", sub: "Points per hole. Aggressive rewarded.", tag: "Net" },
  { id: "wolf", l: "Wolf", sub: "Rotating lone wolf. Partners or go alone.", tag: "3\u20134 ply" },
  { id: "vegas", l: "Vegas", sub: "Team scores combined into two-digit numbers.", tag: "Pairs" },
  { id: "bbb", l: "Bingo Bango Bongo", sub: "First on green, closest, first to hole.", tag: "Any size" },
  { id: "bb", l: "Best ball", sub: "Two-player team, best net score wins.", tag: "Teams" },
  { id: "scr", l: "Scramble", sub: "Everyone tees off, team plays best ball.", tag: "Teams" },
  { id: "quota", l: "Quota", sub: "Beat your handicap points total.", tag: "Solo OK" },
  { id: "none", l: "No stakes", sub: "Just a round.", tag: null },
];

const TEE_OPTIONS: { id: TeeId; l: string; c: string; yds: number }[] = [
  { id: "black", l: "Black · Championship", c: "#1a1a1a", yds: 7244 },
  { id: "blue", l: "Blue · Back", c: "#3a4a8a", yds: 6845 },
  { id: "white", l: "White · Middle", c: "#eae5d6", yds: 6473 },
  { id: "gold", l: "Gold · Forward", c: "#b8763a", yds: 5984 },
  { id: "red", l: "Red", c: "#b84a3a", yds: 5412 },
];

const SIDES: { id: SideId; l: string; sub: string }[] = [
  { id: "snake", l: "Snake", sub: "$ for each 3-putt held" },
  { id: "presses", l: "Presses", sub: "Nassau rules — double down" },
  { id: "greenies", l: "Greenies", sub: "Closest-to-pin on par 3s" },
  { id: "sandies", l: "Sandies", sub: "Par after bunker shot" },
];

export default function RoundSetupPage() {
  const router = useRouter();
  const accent = DEFAULT_ACCENT;
  const caddy = CADDIES.find((c) => c.id === "steve") ?? CADDIES[0];

  const [phase, setPhase] = useState<"listening" | "parsed" | "ready">("listening");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [tee, setTee] = useState<TeeId>("white");
  const [holes, setHoles] = useState(18);
  const [walking, setWalking] = useState(true);
  const [game, setGame] = useState<GameId>("stroke");
  const [stake, setStake] = useState("$5");
  const [sides, setSides] = useState<SideId[]>(["snake"]);
  const [picker, setPicker] = useState<Picker>(null);
  const [voiceActive, setVoiceActive] = useState(false);

  const utter = "Harding Park, Jack and Sam, whites, walking, five bucks a skin";

  useEffect(() => {
    let i = 0;
    const iv = setInterval(() => {
      i += 1.4;
      setTranscript(utter.slice(0, Math.floor(i)));
      if (i >= utter.length) {
        clearInterval(iv);
        setPhase("parsed");
        setGame("skins");
        setStake("$5");
        setTimeout(() => {
          setReply("Got it \u2014 Harding whites, Jack and Sam, skins at $5. Anything else, or ready to tee off?");
          setPhase("ready");
        }, 650);
      }
    }, 30);
    return () => clearInterval(iv);
  }, []);

  const course = { name: "Harding Park", short: "TPC Harding", par: 72, rating: 73.5, slope: 131 };
  const players = [
    { name: "You", initial: "M", hcp: 8, color: "#1a2a1a" },
    { name: "Jack", initial: "J", hcp: 4, color: "#3a5a3a" },
    { name: "Sam", initial: "S", hcp: 6, color: "#8a5a2a" },
  ];
  const heardCourse = transcript.toLowerCase().includes("harding");
  const heardJack = transcript.toLowerCase().includes("jack");
  const heardSam = transcript.toLowerCase().includes("sam");

  const gameLabel = GAME_OPTIONS.find((g) => g.id === game)?.l ?? "Stroke play";
  const teeLabel = TEE_OPTIONS.find((t) => t.id === tee)?.l.split(" · ")[0] ?? "White";
  const teeColor = TEE_OPTIONS.find((t) => t.id === tee)?.c ?? "#eae5d6";

  const quickReplies =
    phase === "ready"
      ? ["Make it $10 a skin", "Add a Nassau", "Change to match play", "Actually, no stakes"]
      : phase === "parsed"
      ? ["Change game", "Different tees", "Add a player"]
      : [];

  const handleQuickReply = (phrase: string) => {
    setVoiceActive(true);
    setTimeout(() => {
      setTranscript((t) => t + ". " + phrase.toLowerCase());
      if (/\$10/.test(phrase)) setStake("$10");
      if (/nassau/i.test(phrase)) setGame("nassau");
      if (/match/i.test(phrase)) setGame("match");
      if (/no stakes/i.test(phrase)) setGame("none");
      setReply("Done. Anything else, or ready to tee off?");
      setVoiceActive(false);
    }, 400);
  };

  const handleTeeOff = () => {
    if (phase !== "ready") return;
    // create a round and push — reuse existing storage
    const all = getCourses();
    let c = all.find((x) => x.name.toLowerCase().includes("harding")) ?? null;
    if (!c) {
      c = createDefaultCourse(course.name);
      saveCourse(c);
    }
    const holeList = holes === 9 ? c.holes.slice(0, 9) : c.holes;
    const round: Round = {
      id: crypto.randomUUID(),
      courseId: c.id,
      courseName: c.name,
      teeId: c.tees?.[0]?.id,
      teeName: teeLabel,
      date: new Date().toISOString(),
      players: players.map((p) => ({ id: crypto.randomUUID(), name: p.name, handicap: p.hcp })),
      scores: [],
      holes: holeList,
      games: [],
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveRound(round);
    router.push(`/round/${round.id}`);
  };

  return (
    <div
      style={{
        position: "relative",
        minHeight: "100vh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        fontFamily: T.sans,
        color: T.ink,
      }}
    >
      <div style={{ maxWidth: 420, margin: "0 auto", position: "relative", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {/* Header */}
          <div style={{ padding: "46px 22px 10px" }}>
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
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 11 }}>{"\u2190"}</span> Back
            </button>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase" }}>New · Round</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 30, letterSpacing: -0.6, color: T.ink, lineHeight: 1.05, marginTop: 4 }}>
              Tell me what you&rsquo;re playing.
            </div>
            <div style={{ fontFamily: T.serif, fontSize: 14, color: T.pencil, letterSpacing: -0.1, marginTop: 3, lineHeight: 1.3 }}>
              Course, group, stakes &mdash; any order, one sentence, or pick below.
            </div>
          </div>

          {/* Conversation surface */}
          <div style={{ padding: "8px 22px 12px" }}>
            {/* YOU turn */}
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 14,
                background: T.paperDeep,
                border: `1px solid ${T.hairline}`,
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>
                  You · {phase === "listening" ? "speaking" : "said"}
                </div>
                {phase === "listening" && (
                  <div style={{ display: "flex", gap: 2.5, alignItems: "center", height: 10 }}>
                    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                      <motion.span
                        key={i}
                        animate={{ height: [3, 8 + (i % 3) * 3, 5, 9, 3] }}
                        transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.05 }}
                        style={{ display: "block", width: 2, borderRadius: 2, background: accent }}
                      />
                    ))}
                  </div>
                )}
              </div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 19,
                  lineHeight: 1.3,
                  letterSpacing: -0.2,
                  color: T.ink,
                  minHeight: 28,
                }}
              >
                <span style={{ color: T.pencil, fontSize: 17 }}>&ldquo;</span>
                {transcript}
                {phase === "listening" && (
                  <motion.span
                    animate={{ opacity: [0, 1, 0] }}
                    transition={{ duration: 0.9, repeat: Infinity }}
                    style={{ display: "inline-block", width: 2, height: 16, background: accent, marginLeft: 2, verticalAlign: "-2px" }}
                  />
                )}
              </div>
            </div>

            {/* CADDY turn */}
            <AnimatePresence>
              {reply && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  style={{
                    marginTop: 8,
                    padding: "12px 14px",
                    borderRadius: 14,
                    background: T.ink,
                    color: T.paper,
                    display: "flex",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 99,
                      background: "rgba(244,241,234,0.12)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 12,
                      flexShrink: 0,
                    }}
                  >
                    {caddy.initial}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 8.5,
                        letterSpacing: 1.4,
                        color: "rgba(244,241,234,0.5)",
                        textTransform: "uppercase",
                      }}
                    >
                      {caddy.name}
                    </div>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 15,
                        lineHeight: 1.35,
                        letterSpacing: -0.1,
                        marginTop: 1,
                      }}
                    >
                      {reply}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Quick reply chips */}
            {quickReplies.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 5 }}>
                {quickReplies.map((q) => (
                  <button
                    key={q}
                    onClick={() => handleQuickReply(q)}
                    style={{
                      padding: "7px 11px",
                      borderRadius: 99,
                      border: `1px solid ${accent}`,
                      background: "transparent",
                      color: accent,
                      fontFamily: T.sans,
                      fontSize: 12,
                      fontWeight: 500,
                      letterSpacing: -0.1,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                      <circle cx="4" cy="4" r="1.8" fill={accent} />
                    </svg>
                    {q}
                  </button>
                ))}
                <button
                  onClick={() => setVoiceActive(true)}
                  style={{
                    padding: "7px 11px",
                    borderRadius: 99,
                    border: `1px dashed ${T.hairline}`,
                    background: "transparent",
                    color: T.pencil,
                    fontFamily: T.sans,
                    fontSize: 12,
                    letterSpacing: -0.1,
                    cursor: "pointer",
                  }}
                >
                  Say something else&hellip;
                </button>
              </div>
            )}
          </div>

          {/* Course card */}
          <div style={{ padding: "10px 22px 6px" }}>
            <div
              style={{
                border: `1px solid ${T.hairline}`,
                borderRadius: 14,
                padding: 14,
                background: heardCourse ? T.paperDeep : T.paper,
                transition: "background 0.3s",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase" }}>Course</div>
                <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>Tap to change</div>
              </div>
              {heardCourse ? (
                <>
                  <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 26, letterSpacing: -0.5, color: T.ink, lineHeight: 1.05, marginTop: 4 }}>
                    {course.name}
                  </div>
                  <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
                    <MiniStat k="Par" v={course.par} />
                    <MiniStat k="Rating" v={course.rating} />
                    <MiniStat k="Slope" v={course.slope} />
                  </div>
                </>
              ) : (
                <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 19, color: T.pencilSoft, marginTop: 3 }}>listening&hellip;</div>
              )}
            </div>
          </div>

          {/* Players */}
          <div style={{ padding: "6px 22px 10px" }}>
            <div style={{ border: `1px solid ${T.hairline}`, borderRadius: 14, padding: 12, background: T.paper }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase" }}>
                  Group · {[true, heardJack, heardSam].filter(Boolean).length}
                </div>
                <button
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.2,
                    color: T.pencil,
                    textTransform: "uppercase",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  + Add
                </button>
              </div>
              {players.map((p, i) => {
                const show = i === 0 || (p.name === "Jack" && heardJack) || (p.name === "Sam" && heardSam);
                if (!show) return null;
                return (
                  <motion.div
                    key={p.name}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2 }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "6px 0",
                      borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 99,
                        background: p.color,
                        color: T.paper,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 13,
                      }}
                    >
                      {p.initial}
                    </div>
                    <div style={{ flex: 1, fontFamily: T.sans, fontSize: 14, color: T.ink, fontWeight: 500 }}>{p.name}</div>
                    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>
                      Hcp <span style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, marginLeft: 2 }}>{p.hcp}</span>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Options — pickable rows */}
          <div style={{ padding: "10px 22px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase" }}>Or set it manually</div>
              <div style={{ flex: 1, height: 1, background: T.hairline }} />
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 11, color: T.pencilSoft, letterSpacing: -0.1 }}>
                anything here is askable by voice
              </div>
            </div>

            <PickerRow label="Holes" value={`${holes}`} hint={`\u201cnine\u201d / \u201ceighteen\u201d`} onClick={() => setPicker("holes")} />
            <PickerRow
              label="Tees"
              value={
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 99,
                      background: teeColor,
                      marginRight: 6,
                      border: `1px solid ${T.hairline}`,
                      verticalAlign: "middle",
                    }}
                  />
                  {teeLabel}
                </span>
              }
              hint={`\u201cwhites\u201d / \u201cplay the blues\u201d`}
              onClick={() => setPicker("tee")}
            />
            <PickerRow
              label="Transport"
              value={walking ? "Walking" : "Cart"}
              hint={`\u201cwalking\u201d / \u201ctaking a cart\u201d`}
              onClick={() => setWalking((w) => !w)}
            />
            <PickerRow
              label="Game"
              value={game === "skins" ? `${gameLabel} · ${stake}` : gameLabel}
              hint={`\u201cskins at ten bucks\u201d, \u201cadd a nassau\u201d, \u201cmatch play\u201d`}
              accent={accent}
              onClick={() => setPicker("game")}
              emphasized
            />
            <PickerRow
              label="Side bets"
              value={sides.length ? sides.map((s) => SIDES.find((x) => x.id === s)?.l).filter(Boolean).join(" · ") : "None"}
              hint={`\u201cadd a snake\u201d, \u201cgreenies on par 3s\u201d`}
              onClick={() => setPicker("sides")}
            />
          </div>

          <div style={{ height: 90 }} />
        </div>

        {/* Sticky footer */}
        <div
          style={{
            padding: "10px 22px 26px",
            background: `linear-gradient(to top, ${T.paper} 65%, rgba(0,0,0,0))`,
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexShrink: 0,
            position: "sticky",
            bottom: 0,
          }}
        >
          <button
            onClick={() => setVoiceActive((v) => !v)}
            style={{
              flexShrink: 0,
              position: "relative",
              width: 52,
              height: 52,
              borderRadius: 99,
              border: "none",
              background: voiceActive ? accent : T.paper,
              color: voiceActive ? T.paper : T.ink,
              boxShadow: voiceActive ? `0 0 0 4px ${accent}22` : `inset 0 0 0 1px ${T.hairline}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            {voiceActive && (
              <motion.span
                animate={{ scale: [1, 1.35, 1], opacity: [0.45, 0, 0.45] }}
                transition={{ duration: 1.6, repeat: Infinity }}
                style={{ position: "absolute", inset: -4, borderRadius: 99, background: accent }}
              />
            )}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ position: "relative" }}>
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          </button>
          <button
            onClick={handleTeeOff}
            style={{
              flex: 1,
              padding: "14px",
              borderRadius: 99,
              border: "none",
              background: phase === "ready" ? T.ink : T.pencilSoft,
              color: T.paper,
              cursor: "pointer",
              fontFamily: T.sans,
              fontSize: 14,
              fontWeight: 500,
              letterSpacing: -0.1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              transition: "background 0.25s",
            }}
          >
            <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Tee off</span>
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, opacity: 0.7 }}>{"\u2192"}</span>
          </button>
        </div>
      </div>

      {/* Picker sheet */}
      <AnimatePresence>
        {picker && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setPicker(null)}
              style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 40 }}
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={T.springSoft}
              style={{
                position: "fixed",
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 41,
                background: T.paper,
                borderRadius: "20px 20px 0 0",
                padding: "12px 0 28px",
                maxHeight: "80vh",
                overflow: "hidden",
                boxShadow: "0 -20px 50px rgba(0,0,0,0.2)",
                display: "flex",
                flexDirection: "column",
                maxWidth: 420,
                margin: "0 auto",
              }}
            >
              <div style={{ width: 40, height: 4, borderRadius: 99, background: T.hairline, margin: "0 auto 10px" }} />

              {picker === "game" && (
                <GamePicker
                  accent={accent}
                  current={game}
                  stake={stake}
                  onPick={(id: GameId) => {
                    setGame(id);
                    setPicker(null);
                  }}
                  onStake={setStake}
                />
              )}
              {picker === "tee" && <TeePicker current={tee} onPick={(id: TeeId) => { setTee(id); setPicker(null); }} />}
              {picker === "sides" && (
                <SidesPicker
                  accent={accent}
                  current={sides}
                  onToggle={(id: SideId) => setSides((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
                  onDone={() => setPicker(null)}
                />
              )}
              {picker === "holes" && (
                <HolesPicker
                  current={holes}
                  onPick={(n: number) => {
                    setHoles(n);
                    setPicker(null);
                  }}
                />
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Voice overlay */}
      <AnimatePresence>
        {voiceActive && !picker && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setVoiceActive(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(26,42,26,0.55)",
              zIndex: 30,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "flex-end",
              padding: "0 28px 120px",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.5,
                color: "rgba(244,241,234,0.6)",
                textTransform: "uppercase",
                marginBottom: 10,
              }}
            >
              Listening &mdash; tap anywhere to stop
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 22,
                color: T.paper,
                textAlign: "center",
                lineHeight: 1.3,
                letterSpacing: -0.3,
              }}
            >
              Try: &ldquo;Change it to match play for ten bucks a hole&rdquo;
            </div>
            <div style={{ display: "flex", gap: 3.5, alignItems: "center", marginTop: 20, height: 28 }}>
              {Array.from({ length: 14 }).map((_, i) => (
                <motion.span
                  key={i}
                  animate={{ height: [6, 18 + (i % 4) * 4, 8, 22, 6] }}
                  transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.04 }}
                  style={{ display: "block", width: 3, borderRadius: 3, background: accent }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PickerRow({
  label,
  value,
  hint,
  onClick,
  accent,
  emphasized,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  onClick?: () => void;
  accent?: string;
  emphasized?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "12px 0",
        background: "transparent",
        border: "none",
        borderTop: `1px dashed ${T.hairline}`,
        cursor: "pointer",
        textAlign: "left",
        display: "grid",
        gridTemplateColumns: "82px 1fr auto",
        gap: 10,
        alignItems: "center",
      }}
    >
      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>{label}</div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: T.sans,
            fontSize: 14,
            fontWeight: 500,
            color: emphasized && accent ? accent : T.ink,
            letterSpacing: -0.1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {value}
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 11.5,
            color: T.pencilSoft,
            letterSpacing: -0.1,
            marginTop: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {hint}
        </div>
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 10, color: T.pencil }}>{"\u203a"}</div>
    </button>
  );
}

function MiniStat({ k, v }: { k: string; v: number | string }) {
  return (
    <div>
      <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>{k}</div>
      <div style={{ fontFamily: T.serif, fontSize: 18, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{v}</div>
    </div>
  );
}

function GamePicker({
  accent,
  current,
  stake,
  onPick,
  onStake,
}: {
  accent: string;
  current: GameId;
  stake: string;
  onPick: (g: GameId) => void;
  onStake: (s: string) => void;
}) {
  const stakes = ["$2", "$5", "$10", "$20"];
  return (
    <div style={{ overflow: "auto", padding: "0 0 10px" }}>
      <div style={{ padding: "0 22px 4px" }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.5, color: T.pencil, textTransform: "uppercase" }}>Pick a game</div>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.3 }}>The format</div>
        <div style={{ fontFamily: T.serif, fontSize: 12.5, color: T.pencil, letterSpacing: -0.1, marginTop: 2 }}>
          Or say: <span style={{ color: accent }}>&ldquo;skins at ten&rdquo;</span>, <span style={{ color: accent }}>&ldquo;wolf, no money&rdquo;</span>
        </div>
      </div>
      <div style={{ padding: "8px 14px 0" }}>
        {GAME_OPTIONS.map((g) => {
          const active = current === g.id;
          return (
            <button
              key={g.id}
              onClick={() => onPick(g.id)}
              style={{
                width: "100%",
                padding: "12px",
                marginBottom: 4,
                borderRadius: 12,
                border: `1px solid ${active ? T.ink : "transparent"}`,
                background: active ? T.paperDeep : "transparent",
                cursor: "pointer",
                textAlign: "left",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: T.serif, fontSize: 17, color: T.ink, letterSpacing: -0.2 }}>{g.l}</span>
                  {g.tag && (
                    <span
                      style={{
                        fontFamily: T.mono,
                        fontSize: 8,
                        letterSpacing: 1,
                        color: T.pencil,
                        border: `1px solid ${T.hairline}`,
                        padding: "1px 5px",
                        borderRadius: 3,
                        textTransform: "uppercase",
                      }}
                    >
                      {g.tag}
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 12.5, color: T.pencil, letterSpacing: -0.1, marginTop: 1 }}>{g.sub}</div>
              </div>
              {active && (
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 99,
                    background: accent,
                    color: T.paper,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontFamily: T.mono,
                  }}
                >
                  {"\u2713"}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {(current === "skins" || current === "nassau" || current === "match") && (
        <div style={{ padding: "8px 22px 0", borderTop: `1px solid ${T.hairline}`, marginTop: 6, paddingTop: 10 }}>
          <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase", marginBottom: 6 }}>Stake</div>
          <div style={{ display: "flex", gap: 5 }}>
            {stakes.map((s) => (
              <button
                key={s}
                onClick={() => onStake(s)}
                style={{
                  flex: 1,
                  padding: "8px",
                  borderRadius: 10,
                  border: `1px solid ${stake === s ? T.ink : T.hairline}`,
                  background: stake === s ? T.ink : "transparent",
                  color: stake === s ? T.paper : T.ink,
                  fontFamily: T.serif,
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TeePicker({ current, onPick }: { current: TeeId; onPick: (t: TeeId) => void }) {
  return (
    <div style={{ overflow: "auto", padding: "0 0 10px" }}>
      <div style={{ padding: "0 22px 4px" }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.5, color: T.pencil, textTransform: "uppercase" }}>Tees</div>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.3 }}>Which set today?</div>
      </div>
      <div style={{ padding: "8px 14px 0" }}>
        {TEE_OPTIONS.map((t) => {
          const active = current === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onPick(t.id)}
              style={{
                width: "100%",
                padding: "12px",
                marginBottom: 4,
                borderRadius: 12,
                border: `1px solid ${active ? T.ink : "transparent"}`,
                background: active ? T.paperDeep : "transparent",
                cursor: "pointer",
                textAlign: "left",
                display: "grid",
                gridTemplateColumns: "20px 1fr auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div style={{ width: 14, height: 14, borderRadius: 99, background: t.c, border: `1px solid ${T.hairline}` }} />
              <div style={{ fontFamily: T.serif, fontSize: 16, color: T.ink, letterSpacing: -0.2 }}>{t.l}</div>
              <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.1, color: T.pencilSoft }}>{t.yds} y</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SidesPicker({
  accent,
  current,
  onToggle,
  onDone,
}: {
  accent: string;
  current: SideId[];
  onToggle: (id: SideId) => void;
  onDone: () => void;
}) {
  return (
    <div style={{ overflow: "auto", padding: "0 0 10px" }}>
      <div style={{ padding: "0 22px 4px" }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.5, color: T.pencil, textTransform: "uppercase" }}>Side bets</div>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.3 }}>On top of the main game</div>
      </div>
      <div style={{ padding: "8px 14px 0" }}>
        {SIDES.map((s) => {
          const active = current.includes(s.id);
          return (
            <button
              key={s.id}
              onClick={() => onToggle(s.id)}
              style={{
                width: "100%",
                padding: "12px",
                marginBottom: 4,
                borderRadius: 12,
                border: `1px solid ${active ? T.ink : "transparent"}`,
                background: active ? T.paperDeep : "transparent",
                cursor: "pointer",
                textAlign: "left",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontFamily: T.serif, fontSize: 16, color: T.ink, letterSpacing: -0.2 }}>{s.l}</div>
                <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 12, color: T.pencil, letterSpacing: -0.1, marginTop: 1 }}>{s.sub}</div>
              </div>
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  border: `1.5px solid ${active ? accent : T.hairline}`,
                  background: active ? accent : "transparent",
                  color: T.paper,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                }}
              >
                {active ? "\u2713" : ""}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ padding: "10px 22px 0" }}>
        <button
          onClick={onDone}
          style={{
            width: "100%",
            padding: "12px",
            borderRadius: 99,
            border: "none",
            background: T.ink,
            color: T.paper,
            cursor: "pointer",
            fontFamily: T.sans,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function HolesPicker({ current, onPick }: { current: number; onPick: (n: number) => void }) {
  return (
    <div style={{ padding: "0 22px 10px" }}>
      <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.5, color: T.pencil, textTransform: "uppercase" }}>Holes</div>
      <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.3, marginBottom: 12 }}>How many today?</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {[9, 18].map((n) => (
          <button
            key={n}
            onClick={() => onPick(n)}
            style={{
              padding: "22px",
              borderRadius: 14,
              border: `1px solid ${current === n ? T.ink : T.hairline}`,
              background: current === n ? T.paperDeep : "transparent",
              cursor: "pointer",
              fontFamily: T.serif,
              fontSize: 40,
              color: T.ink,
              letterSpacing: -0.8,
            }}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
