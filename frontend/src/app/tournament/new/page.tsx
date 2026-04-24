"use client";

import { useEffect, useState, DragEvent } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT, CADDIES } from "@/components/yardage/tokens";

type RoundId = "r1" | "r2" | "r3";
type Groupings = Record<RoundId, Record<string, string>>;

const PARSED = {
  name: "The Sunday Cup · Vol VII",
  dates: "Fri Oct 11 — Sun Oct 13",
  rounds: 3,
  format: "Stableford · Net",
  stakes: "$50 buy-in",
  courses: [
    { id: "r1" as RoundId, short: "Pebble", name: "Pebble Beach", day: "Fri" },
    { id: "r2" as RoundId, short: "Spyglass", name: "Spyglass Hill", day: "Sat" },
    { id: "r3" as RoundId, short: "Spanish", name: "Spanish Bay", day: "Sun" },
  ],
  players: [
    { name: "You", hcp: 8 },
    { name: "Justin", hcp: 12 },
    { name: "Jack", hcp: 4 },
    { name: "Mike", hcp: 18 },
    { name: "Sam", hcp: 6 },
    { name: "Riley", hcp: 14 },
  ],
};

const CARTS = [
  { id: "c1", time: "9:10 AM" },
  { id: "c2", time: "9:20 AM" },
  { id: "c3", time: "9:30 AM" },
];

const FULL_UTTERANCE =
  "Three day tournament at Pebble, Spyglass and Spanish Bay. Me, Justin, Jack, Mike, Sam and Riley. Jack's a four, I'm an eight, Sam six, Justin twelve, Riley fourteen, Mike eighteen. Stableford net, fifty buy-in.";

function autoGroup(mode: "random" | "balanced", players: { name: string }[]): Record<string, string> {
  const names = players.map((p) => p.name);
  let order = [...names];
  if (mode === "random") {
    order = order.sort(() => Math.random() - 0.5);
  } else {
    // balanced: snake seed (low + high together)
    const sorted = [...players].sort((a, b) => (a as typeof players[0] & { hcp: number }).hcp - (b as typeof players[0] & { hcp: number }).hcp).map((p) => p.name);
    order = [];
    for (let i = 0; i < sorted.length / 2; i++) {
      order.push(sorted[i]);
      order.push(sorted[sorted.length - 1 - i]);
    }
  }
  const out: Record<string, string> = {};
  order.forEach((name, i) => {
    out[name] = CARTS[Math.floor(i / 2)].id;
  });
  return out;
}

function chipStyle(ghost: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 99,
    border: `1px solid ${ghost ? "rgba(244,241,234,0.2)" : "rgba(244,241,234,0.35)"}`,
    background: "transparent",
    color: ghost ? "rgba(244,241,234,0.55)" : T.paper,
    fontFamily: T.mono,
    fontSize: 9,
    letterSpacing: 1.3,
    textTransform: "uppercase",
    cursor: "pointer",
  };
}

export default function TournamentSetupPage() {
  const router = useRouter();
  const accent = DEFAULT_ACCENT;
  const caddy = CADDIES.find((c) => c.id === "steve") ?? CADDIES[0];

  const [phase, setPhase] = useState<"listening" | "ready">("listening");
  const [transcript, setTranscript] = useState("");
  const [groupings, setGroupings] = useState<Groupings>({ r1: {}, r2: {}, r3: {} });
  const [activeRound, setActiveRound] = useState<RoundId>("r1");
  const [skipped, setSkipped] = useState<Record<RoundId, boolean>>({ r1: false, r2: false, r3: false });

  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let i = 0;
    const iv = setInterval(() => {
      i += 2;
      setTranscript(FULL_UTTERANCE.slice(0, i));
      if (i >= FULL_UTTERANCE.length) {
        clearInterval(iv);
        setPhase("ready");
      }
    }, 18);
    return () => clearInterval(iv);
  }, []);

  const currentAssign = groupings[activeRound] ?? {};
  const isRoundSkipped = skipped[activeRound];
  const assignedCount = Object.keys(currentAssign).length;

  const onDragStart = (pid: string) => (e: DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", pid);
    setDragging(pid);
  };
  const onDragEnd = () => {
    setDragging(null);
    setDragOver(null);
  };
  const onDragOver = (target: string) => (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOver !== target) setDragOver(target);
  };
  const onDrop = (target: string) => (e: DragEvent) => {
    e.preventDefault();
    const pid = e.dataTransfer.getData("text/plain") || dragging;
    if (!pid) return;
    const next = { ...currentAssign };
    if (target === "pool") {
      delete next[pid];
    } else {
      const memberCount = Object.values(next).filter((c) => c === target).length;
      const alreadyThere = next[pid] === target;
      if (memberCount >= 2 && !alreadyThere) return;
      next[pid] = target;
    }
    setGroupings({ ...groupings, [activeRound]: next });
    setDragging(null);
    setDragOver(null);
    setSelected(null);
  };

  const tapAssign = (target: string) => {
    if (!selected) return;
    const next = { ...currentAssign };
    if (target === "pool") delete next[selected];
    else {
      const memberCount = Object.values(next).filter((c) => c === target).length;
      const alreadyThere = next[selected] === target;
      if (memberCount >= 2 && !alreadyThere) return;
      next[selected] = target;
    }
    setGroupings({ ...groupings, [activeRound]: next });
    setSelected(null);
  };

  const handleStart = () => router.push("/tournament/sunday-cup-2024");

  return (
    <div
      style={{
        position: "relative",
        minHeight: "100vh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        fontFamily: T.sans,
        color: T.ink,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ maxWidth: 420, margin: "0 auto", flex: 1, display: "flex", flexDirection: "column", width: "100%" }}>
        <div style={{ flex: 1 }}>
          {/* Header */}
          <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 14px" }}>
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
              <span style={{ fontSize: 11 }}>{"\u2190"}</span> Home
            </button>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                marginBottom: 2,
              }}
            >
              New · Tournament
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 30,
                letterSpacing: -0.6,
                color: T.ink,
                lineHeight: 1.05,
              }}
            >
              Tell the caddy what you&rsquo;re playing.
            </div>
          </div>

          {/* Live transcript + caddy */}
          <div style={{ padding: "0 22px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ position: "relative" }}>
                <motion.span
                  animate={{ scale: [1, 1.25, 1], opacity: [0.3, 0.08, 0.3] }}
                  transition={{ duration: 2, repeat: Infinity }}
                  style={{ position: "absolute", inset: -4, borderRadius: 99, background: accent }}
                />
                <div
                  style={{
                    position: "relative",
                    width: 32,
                    height: 32,
                    borderRadius: 99,
                    background: T.ink,
                    color: T.paper,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 15,
                  }}
                >
                  {caddy.initial}
                </div>
              </div>
              <div style={{ flex: 1, lineHeight: 1 }}>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>
                  {caddy.name} &mdash; {phase === "listening" ? "listening" : "ready"}
                </div>
                <div style={{ marginTop: 4, display: "flex", gap: 2.5, alignItems: "center", height: 10 }}>
                  {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                    <motion.span
                      key={i}
                      animate={phase === "listening" ? { height: [3, 8 + (i % 3) * 3, 5, 9, 3] } : { height: 3 }}
                      transition={{ duration: 0.9, repeat: phase === "listening" ? Infinity : 0, delay: i * 0.05 }}
                      style={{ display: "block", width: 2, borderRadius: 2, background: accent }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 19,
                lineHeight: 1.3,
                letterSpacing: -0.2,
                color: T.ink,
                minHeight: 74,
                paddingBottom: 14,
                borderBottom: `1px solid ${T.hairline}`,
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

          {/* Parsed fields */}
          <div style={{ padding: "14px 22px 20px" }}>
            <ParsedField label="Tournament" value={PARSED.name} progress={transcript.length > 30 ? 1 : 0} />
            <ParsedField label="Format" value={PARSED.format} sub={PARSED.stakes} progress={transcript.includes("Stableford") ? 1 : 0} />

            {/* Rounds + courses */}
            <div style={{ marginTop: 12, border: `1px solid ${T.hairline}`, borderRadius: 14, padding: 12, background: T.paperDeep }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase" }}>
                  3 Rounds · 3 Courses
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft }}>{PARSED.dates.toUpperCase()}</div>
              </div>
              {PARSED.courses.map((c, i) => {
                const show = transcript.toLowerCase().includes(c.name.split(" ")[0].toLowerCase());
                return (
                  <AnimatePresence key={c.id}>
                    {show && (
                      <motion.div
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.25 }}
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
                            width: 24,
                            height: 24,
                            borderRadius: 99,
                            border: `1px solid ${accent}`,
                            color: accent,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontFamily: T.mono,
                            fontSize: 10,
                            fontWeight: 500,
                          }}
                        >
                          {i + 1}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontFamily: T.serif, fontSize: 16, color: T.ink, letterSpacing: -0.2 }}>{c.name}</div>
                        </div>
                        <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase" }}>{c.day}</div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                );
              })}
            </div>

            {/* Players w/ handicaps */}
            <div style={{ marginTop: 12, border: `1px solid ${T.hairline}`, borderRadius: 14, padding: 12, background: T.paper }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase" }}>
                  Field · {PARSED.players.filter((p) => transcript.toLowerCase().includes(p.name.toLowerCase())).length}/6
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>Hcp</div>
              </div>
              {PARSED.players.map((p, i) => {
                const heard = transcript.toLowerCase().includes(p.name.toLowerCase());
                const hcpHeard = heard && transcript.length > 120;
                return (
                  <AnimatePresence key={p.name}>
                    {heard && (
                      <motion.div
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
                            background: T.ink,
                            color: T.paper,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontFamily: T.serif,
                            fontStyle: "italic",
                            fontSize: 13,
                          }}
                        >
                          {p.name[0]}
                        </div>
                        <div style={{ flex: 1, fontFamily: T.sans, fontSize: 14, color: T.ink, fontWeight: 500 }}>{p.name}</div>
                        <div
                          style={{
                            fontFamily: T.serif,
                            fontSize: 18,
                            color: hcpHeard ? T.ink : T.pencilSoft,
                            fontVariantNumeric: "tabular-nums",
                            minWidth: 22,
                            textAlign: "right",
                          }}
                        >
                          {hcpHeard ? p.hcp : "\u2013"}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                );
              })}
            </div>

            {/* Groupings — dark card with DnD */}
            {phase === "ready" && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                style={{ marginTop: 16, borderRadius: 14, background: T.ink, color: T.paper, overflow: "hidden" }}
              >
                <div style={{ padding: "14px 14px 10px", display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 99,
                      background: "rgba(244,241,234,0.1)",
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
                    {caddy.initial}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.3,
                        color: "rgba(244,241,234,0.5)",
                        textTransform: "uppercase",
                        marginBottom: 2,
                      }}
                    >
                      Groupings &mdash; one thing left
                    </div>
                    <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15, lineHeight: 1.3, letterSpacing: -0.1 }}>
                      Drag players into carts. Set each round, or set one and copy.
                    </div>
                  </div>
                </div>

                {/* Round tabs */}
                <div style={{ display: "flex", padding: "0 14px 8px", gap: 4, borderBottom: `1px solid rgba(244,241,234,0.08)` }}>
                  {PARSED.courses.map((c, i) => {
                    const active = activeRound === c.id;
                    const count = Object.keys(groupings[c.id] ?? {}).length;
                    const isSkip = skipped[c.id];
                    return (
                      <button
                        key={c.id}
                        onClick={() => setActiveRound(c.id)}
                        style={{
                          flex: 1,
                          padding: "8px 8px 9px",
                          borderRadius: 8,
                          border: `1px solid ${active ? "rgba(244,241,234,0.3)" : "transparent"}`,
                          background: active ? "rgba(244,241,234,0.06)" : "transparent",
                          color: T.paper,
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <div
                          style={{
                            fontFamily: T.mono,
                            fontSize: 8.5,
                            letterSpacing: 1.2,
                            color: "rgba(244,241,234,0.5)",
                            textTransform: "uppercase",
                          }}
                        >
                          R{i + 1} · {c.day}
                        </div>
                        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 1 }}>
                          <div style={{ fontFamily: T.serif, fontSize: 14, letterSpacing: -0.2 }}>{c.short}</div>
                          <div
                            style={{
                              fontFamily: T.mono,
                              fontSize: 8.5,
                              letterSpacing: 1.1,
                              color: isSkip
                                ? "rgba(244,241,234,0.35)"
                                : count === 6
                                ? accent
                                : count > 0
                                ? "rgba(244,241,234,0.7)"
                                : "rgba(244,241,234,0.35)",
                            }}
                          >
                            {isSkip ? "later" : count === 6 ? "set" : `${count}/6`}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {!isRoundSkipped && (
                  <>
                    <div style={{ padding: "10px 14px 8px", display: "flex", gap: 5, flexWrap: "wrap" }}>
                      <button
                        onClick={() => setGroupings({ ...groupings, [activeRound]: autoGroup("random", PARSED.players) })}
                        style={chipStyle(false)}
                      >
                        Random
                      </button>
                      <button
                        onClick={() => setGroupings({ ...groupings, [activeRound]: autoGroup("balanced", PARSED.players) })}
                        style={chipStyle(false)}
                      >
                        Balance hcp
                      </button>
                      {PARSED.courses
                        .filter((c) => c.id !== activeRound && Object.keys(groupings[c.id] ?? {}).length > 0)
                        .map((c) => (
                          <button
                            key={c.id}
                            onClick={() => setGroupings({ ...groupings, [activeRound]: { ...groupings[c.id] } })}
                            style={chipStyle(false)}
                          >
                            Copy from {c.short}
                          </button>
                        ))}
                      {assignedCount > 0 && (
                        <button onClick={() => setGroupings({ ...groupings, [activeRound]: {} })} style={chipStyle(true)}>
                          Clear
                        </button>
                      )}
                      <button
                        onClick={() => setSkipped({ ...skipped, [activeRound]: true })}
                        style={{ ...chipStyle(true), marginLeft: "auto" }}
                      >
                        Set later ↗
                      </button>
                    </div>

                    {/* Unassigned pool */}
                    <div
                      onDragOver={onDragOver("pool")}
                      onDragLeave={() => setDragOver(null)}
                      onDrop={onDrop("pool")}
                      onClick={() => selected && tapAssign("pool")}
                      style={{
                        margin: "0 14px 10px",
                        padding: "8px 10px",
                        border: `1px dashed ${dragOver === "pool" ? accent : "rgba(244,241,234,0.18)"}`,
                        borderRadius: 10,
                        background: dragOver === "pool" ? `${accent}18` : "transparent",
                        minHeight: 44,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                        transition: "border-color 0.15s, background 0.15s",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8.5,
                          letterSpacing: 1.3,
                          color: "rgba(244,241,234,0.45)",
                          textTransform: "uppercase",
                          marginRight: 4,
                        }}
                      >
                        Unassigned
                      </div>
                      {PARSED.players
                        .filter((p) => !currentAssign[p.name])
                        .map((p) => (
                          <PlayerChip
                            key={p.name}
                            name={p.name}
                            selected={selected === p.name}
                            dragging={dragging === p.name}
                            onDragStart={onDragStart(p.name)}
                            onDragEnd={onDragEnd}
                            onTap={() => setSelected(selected === p.name ? null : p.name)}
                          />
                        ))}
                      {PARSED.players.every((p) => currentAssign[p.name]) && (
                        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 13, color: "rgba(244,241,234,0.5)" }}>
                          All six set for this round.
                        </div>
                      )}
                    </div>

                    {/* Carts */}
                    <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                      {CARTS.map((cart) => {
                        const members = PARSED.players.filter((p) => currentAssign[p.name] === cart.id);
                        const full = members.length >= 2;
                        const isHover = dragOver === cart.id;
                        const canTapDrop = Boolean(selected) && !full;
                        return (
                          <div
                            key={cart.id}
                            onDragOver={onDragOver(cart.id)}
                            onDragLeave={() => setDragOver(null)}
                            onDrop={onDrop(cart.id)}
                            onClick={() => canTapDrop && tapAssign(cart.id)}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "10px 12px",
                              borderRadius: 10,
                              border: `1px solid ${isHover ? accent : canTapDrop ? accent : "rgba(244,241,234,0.12)"}`,
                              background: isHover ? `${accent}22` : canTapDrop ? `${accent}10` : "rgba(244,241,234,0.04)",
                              cursor: canTapDrop ? "pointer" : "default",
                              transition: "background 0.15s, border-color 0.15s",
                            }}
                          >
                            <div
                              style={{
                                width: 22,
                                height: 22,
                                borderRadius: 5,
                                border: `1px solid rgba(244,241,234,0.3)`,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                color: "rgba(244,241,234,0.7)",
                              }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                <circle cx="6" cy="19" r="2" />
                                <circle cx="18" cy="19" r="2" />
                                <path d="M3 4h3l2 10h10l2-7H7" />
                              </svg>
                            </div>
                            <div
                              style={{
                                fontFamily: T.mono,
                                fontSize: 9,
                                letterSpacing: 1.3,
                                color: "rgba(244,241,234,0.5)",
                                textTransform: "uppercase",
                                minWidth: 60,
                              }}
                            >
                              {cart.time}
                            </div>
                            <div style={{ flex: 1, display: "flex", gap: 5, flexWrap: "wrap", minHeight: 26, alignItems: "center" }}>
                              {members.length === 0 && (
                                <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 13, color: "rgba(244,241,234,0.35)" }}>
                                  {isHover ? "Drop here" : selected ? "Tap to add" : "Drop or tap"}
                                </div>
                              )}
                              {members.map((p) => (
                                <PlayerChip
                                  key={p.name}
                                  name={p.name}
                                  dragging={dragging === p.name}
                                  onDragStart={onDragStart(p.name)}
                                  onDragEnd={onDragEnd}
                                  removable
                                  onTap={(e) => {
                                    e.stopPropagation();
                                    const next = { ...currentAssign };
                                    delete next[p.name];
                                    setGroupings({ ...groupings, [activeRound]: next });
                                  }}
                                />
                              ))}
                            </div>
                            <div
                              style={{
                                fontFamily: T.mono,
                                fontSize: 9,
                                letterSpacing: 1.2,
                                color: full ? accent : "rgba(244,241,234,0.35)",
                              }}
                            >
                              {members.length}/2
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {isRoundSkipped && (
                  <div style={{ padding: "14px", display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 9,
                          letterSpacing: 1.3,
                          color: "rgba(244,241,234,0.5)",
                          textTransform: "uppercase",
                        }}
                      >
                        Skipped for now
                      </div>
                      <div
                        style={{
                          fontFamily: T.serif,
                          fontStyle: "italic",
                          fontSize: 13,
                          lineHeight: 1.3,
                          letterSpacing: -0.1,
                          marginTop: 2,
                          color: "rgba(244,241,234,0.75)",
                        }}
                      >
                        You&rsquo;ll get a prompt on the tee. The round can start without it.
                      </div>
                    </div>
                    <button
                      onClick={() => setSkipped({ ...skipped, [activeRound]: false })}
                      style={{
                        padding: "7px 10px",
                        borderRadius: 99,
                        border: `1px solid rgba(244,241,234,0.3)`,
                        background: "transparent",
                        color: T.paper,
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.2,
                        textTransform: "uppercase",
                        cursor: "pointer",
                      }}
                    >
                      Set now
                    </button>
                  </div>
                )}
              </motion.div>
            )}

            <div style={{ height: 80 }} />
          </div>
        </div>

        {/* Sticky bottom CTA */}
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
            style={{
              flexShrink: 0,
              width: 44,
              height: 44,
              borderRadius: 99,
              border: `1px solid ${T.hairline}`,
              background: T.paper,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: T.ink,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
            </svg>
          </button>
          <button
            onClick={handleStart}
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
            <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Open tournament</span>
            <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, opacity: 0.7 }}>{"\u2192"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayerChip({
  name,
  selected,
  dragging,
  onDragStart,
  onDragEnd,
  onTap,
  removable,
}: {
  name: string;
  selected?: boolean;
  dragging?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  onTap?: (e: React.MouseEvent) => void;
  removable?: boolean;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onTap}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "5px 9px",
        borderRadius: 99,
        background: selected ? `${DEFAULT_ACCENT}30` : "rgba(244,241,234,0.1)",
        border: `1px solid ${selected ? DEFAULT_ACCENT : "rgba(244,241,234,0.22)"}`,
        color: T.paper,
        opacity: dragging ? 0.5 : 1,
        cursor: "grab",
        fontFamily: T.sans,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <span>{name}</span>
      {removable && <span style={{ opacity: 0.5, fontSize: 11 }}>×</span>}
    </div>
  );
}

function ParsedField({ label, value, sub, progress }: { label: string; value: string; sub?: string; progress: number }) {
  return (
    <div
      style={{
        padding: "10px 0",
        borderBottom: `1px dashed ${T.hairline}`,
        opacity: progress ? 1 : 0.35,
        transition: "opacity 0.3s",
      }}
    >
      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: T.serif, fontSize: 17, color: T.ink, letterSpacing: -0.2, marginTop: 2, lineHeight: 1.2 }}>
        {value}
      </div>
      {sub && <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencilSoft, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
