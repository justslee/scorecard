"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import { TOURNAMENT, TPLAYERS, TSTANDINGS, TFEED, TGAMES, TGROUPS, suffix } from "@/components/yardage/tournamentData";

type Tab = "leaderboard" | "rounds" | "games";
type LbMode = "net" | "gross" | "pts";

export default function TournamentHomePage() {
  const router = useRouter();
  const accent = DEFAULT_ACCENT;
  const [tab, setTab] = useState<Tab>("leaderboard");
  const [lbMode, setLbMode] = useState<LbMode>("net");

  const playerById = Object.fromEntries(TPLAYERS.map((p) => [p.id, p]));

  const sorted = [...TSTANDINGS].sort((a, b) => {
    if (lbMode === "gross") return a.r1Gross + a.r2Gross - (b.r1Gross + b.r2Gross);
    if (lbMode === "pts") return b.r1Pts + b.r2Pts - (a.r1Pts + a.r2Pts);
    return a.r1Net - b.r1Net;
  });

  const leader = sorted[0];
  const you = TSTANDINGS.find((s) => s.pid === "you")!;
  const yourRank = sorted.findIndex((s) => s.pid === "you") + 1;

  const startRound = (roundNum: number) => {
    router.push(`/round/tournament-r${roundNum}`);
  };

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
        {/* Masthead */}
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
              position: "relative",
              zIndex: 2,
            }}
          >
            <span style={{ fontSize: 11 }}>{"\u2190"}</span> Home
          </button>

          <div
            style={{
              position: "absolute",
              right: -20,
              top: 20,
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 160,
              lineHeight: 0.9,
              color: T.paperEdge,
              letterSpacing: -6,
              userSelect: "none",
              pointerEvents: "none",
              opacity: 0.55,
            }}
          >
            VII
          </div>

          <div style={{ position: "relative" }}>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase" }}>
              {TOURNAMENT.dates.toUpperCase()}
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 36, letterSpacing: -0.8, color: T.ink, lineHeight: 1, marginTop: 6 }}>
              {TOURNAMENT.name}
            </div>
            <div style={{ fontFamily: T.serif, fontSize: 14, color: T.pencil, letterSpacing: -0.1, marginTop: 2 }}>
              {TOURNAMENT.subtitle}
            </div>

            <div style={{ display: "flex", gap: 18, marginTop: 18 }}>
              <Meta k="Round" v={`${TOURNAMENT.currentRound}/${TOURNAMENT.totalRounds}`} sub="in progress" />
              <Meta k="Field" v={TPLAYERS.length} sub="players" />
              <Meta k="Format" v="Stableford" sub="Net · $50" />
            </div>
          </div>
        </div>

        {/* Course progress strip */}
        <div style={{ padding: "0 22px 14px" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {TOURNAMENT.courses.map((c, i) => (
              <button
                key={c.id}
                onClick={() => startRound(c.round)}
                style={{
                  flex: 1,
                  borderRadius: 12,
                  padding: "10px 12px",
                  border: `1px solid ${c.live ? accent : T.hairline}`,
                  background: c.live ? `${accent}0d` : c.done ? T.paperDeep : "transparent",
                  position: "relative",
                  overflow: "hidden",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {c.done && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: T.ink }} />}
                {c.live && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: accent }} />}
                <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase", marginBottom: 2 }}>
                  Day {i + 1}
                  {c.live ? " · live" : c.done ? " · final" : ""}
                </div>
                <div style={{ fontFamily: T.serif, fontSize: 14, letterSpacing: -0.2, color: T.ink, lineHeight: 1.1 }}>{c.short}</div>
                {c.live && (
                  <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                    <motion.span
                      animate={{ opacity: [0.3, 1, 0.3] }}
                      transition={{ duration: 1.6, repeat: Infinity }}
                      style={{ width: 5, height: 5, borderRadius: 99, background: accent }}
                    />
                    <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: accent, textTransform: "uppercase" }}>Thru 9</span>
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Your position callout */}
        <div
          onClick={() => startRound(TOURNAMENT.currentRound)}
          style={{
            margin: "0 22px 14px",
            padding: "14px 16px",
            borderRadius: 16,
            background: T.ink,
            color: T.paper,
            display: "flex",
            alignItems: "center",
            gap: 14,
            cursor: "pointer",
          }}
        >
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 40,
              lineHeight: 0.9,
              letterSpacing: -1.5,
              color: T.paper,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {yourRank}
            <span style={{ fontSize: 14, color: "rgba(244,241,234,0.55)", marginLeft: 2, verticalAlign: "top" }}>{suffix(yourRank)}</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: "rgba(244,241,234,0.5)", textTransform: "uppercase" }}>Your position</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 16, letterSpacing: -0.2, lineHeight: 1.3, color: T.paper, marginTop: 2 }}>
              {yourRank === 1
                ? "Holding the lead. Keep it boring."
                : yourRank === 2
                ? `Down ${Math.abs(you.r1Pts + you.r2Pts - (leader.r1Pts + leader.r2Pts))} to Jack with 9 to play.`
                : "Work to do on the back."}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: "rgba(244,241,234,0.5)" }}>NET PTS</div>
            <div style={{ fontFamily: T.serif, fontSize: 24, color: T.paper, fontVariantNumeric: "tabular-nums" }}>{you.r1Pts + you.r2Pts}</div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ padding: "0 22px", display: "flex", gap: 4, marginBottom: 10 }}>
          {(["leaderboard", "rounds", "games"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: 10,
                cursor: "pointer",
                border: `1px solid ${tab === t ? T.ink : T.hairline}`,
                background: tab === t ? T.ink : "transparent",
                color: tab === t ? T.paper : T.pencil,
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.3,
                textTransform: "uppercase",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "leaderboard" && (
          <div style={{ padding: "0 22px 40px" }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {([
                { k: "net", l: "Net pts" },
                { k: "gross", l: "Gross" },
                { k: "pts", l: "Stableford" },
              ] as { k: LbMode; l: string }[]).map((m) => (
                <button
                  key={m.k}
                  onClick={() => setLbMode(m.k)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 99,
                    border: `1px solid ${lbMode === m.k ? accent : T.hairline}`,
                    background: lbMode === m.k ? `${accent}0d` : "transparent",
                    color: lbMode === m.k ? accent : T.pencil,
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.2,
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {m.l}
                </button>
              ))}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "22px 1fr 36px 36px 48px",
                gap: 10,
                padding: "6px 0",
                borderBottom: `1px solid ${T.hairline}`,
                fontFamily: T.mono,
                fontSize: 8.5,
                letterSpacing: 1.3,
                color: T.pencilSoft,
                textTransform: "uppercase",
              }}
            >
              <div>#</div>
              <div>Player</div>
              <div style={{ textAlign: "right" }}>R1</div>
              <div style={{ textAlign: "right" }}>R2</div>
              <div style={{ textAlign: "right" }}>Total</div>
            </div>

            {sorted.map((s, idx) => {
              const p = playerById[s.pid];
              const total = s.r1Pts + s.r2Pts;
              const isYou = s.pid === "you";
              const projected = s.r2Thru < 18;
              return (
                <div
                  key={s.pid}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "22px 1fr 36px 36px 48px",
                    gap: 10,
                    alignItems: "center",
                    padding: "10px 0",
                    borderBottom: `1px dashed ${T.hairline}`,
                    background: isYou ? `${accent}08` : "transparent",
                    marginLeft: isYou ? -10 : 0,
                    marginRight: isYou ? -10 : 0,
                    paddingLeft: isYou ? 10 : 0,
                    paddingRight: isYou ? 10 : 0,
                    borderRadius: isYou ? 10 : 0,
                  }}
                >
                  <div style={{ fontFamily: T.serif, fontSize: 16, color: idx < 3 ? T.ink : T.pencil, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                    {idx + 1}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
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
                        flexShrink: 0,
                      }}
                    >
                      {p.initial}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: T.sans, fontSize: 13.5, fontWeight: 500, color: T.ink, lineHeight: 1.1 }}>
                        {p.name}
                        {p.titles.length > 0 && (
                          <span
                            title={`Winner: ${p.titles.join(", ")}`}
                            style={{ marginLeft: 5, fontFamily: T.mono, fontSize: 8, color: accent, letterSpacing: 1 }}
                          >
                            ★{p.titles.length > 1 ? p.titles.length : ""}
                          </span>
                        )}
                      </div>
                      <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>
                        Hcp {p.hcp} · {p.tag}
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontFamily: T.serif, fontSize: 16, color: T.ink, fontVariantNumeric: "tabular-nums" }}>
                    {lbMode === "gross" ? s.r1Gross : lbMode === "pts" ? s.r1Pts : s.r1Net}
                  </div>
                  <div style={{ textAlign: "right", fontFamily: T.serif, fontSize: 16, color: T.pencil, fontVariantNumeric: "tabular-nums" }}>
                    {lbMode === "gross" ? s.r2Gross : s.r2Pts}
                    <span style={{ fontFamily: T.mono, fontSize: 7.5, color: T.pencilSoft, marginLeft: 2 }}>·{s.r2Thru}</span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontSize: 22,
                        letterSpacing: -0.3,
                        lineHeight: 1,
                        color: idx === 0 ? accent : T.ink,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {lbMode === "gross" ? s.r1Gross + s.r2Gross : total}
                    </div>
                    {projected && (
                      <div style={{ fontFamily: T.mono, fontSize: 7.5, color: T.pencilSoft, letterSpacing: 1, textTransform: "uppercase" }}>Proj</div>
                    )}
                  </div>
                </div>
              );
            })}

            <div style={{ marginTop: 22 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>From the field</div>
                <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft }}>live</div>
              </div>
              {TFEED.slice(0, 4).map((f, i) => {
                const p = playerById[f.who];
                const color = f.what === "birdie" ? accent : f.what === "double" ? T.pencil : T.ink;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: `1px dashed ${T.hairline}` }}>
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 99,
                        background: p.color,
                        color: T.paper,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 11,
                        flexShrink: 0,
                      }}
                    >
                      {p.initial}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.3, color: T.ink, letterSpacing: -0.1 }}>
                        <b style={{ fontWeight: 500 }}>{p.name}</b>{" "}
                        <span style={{ color, fontStyle: "italic" }}>{f.what}</span>
                        {" \u2014 "}
                        <span style={{ color: T.pencil, fontStyle: "italic" }}>{f.note}</span>
                      </div>
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8.5,
                          letterSpacing: 1.2,
                          color: T.pencilSoft,
                          textTransform: "uppercase",
                          marginTop: 1,
                        }}
                      >
                        Hole {f.hole} · {f.t}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "games" && (
          <div style={{ padding: "0 22px 40px" }}>
            {TGAMES.map((g) => (
              <div key={g.id} style={{ padding: "14px 0", borderBottom: `1px dashed ${T.hairline}` }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, letterSpacing: -0.3, color: T.ink }}>{g.name}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencil, textTransform: "uppercase" }}>{g.stake}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>Leader</div>
                  <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}>{g.leader}</div>
                  <div style={{ fontFamily: T.serif, fontSize: 18, color: accent, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{g.leaderPts}</div>
                </div>
                <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 13, color: T.pencil, letterSpacing: -0.1, marginTop: 2 }}>{g.note}</div>
              </div>
            ))}
            <button
              style={{
                marginTop: 14,
                width: "100%",
                padding: "12px",
                borderRadius: 12,
                border: `1px dashed ${T.hairline}`,
                background: "transparent",
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: 1.4,
                color: T.pencil,
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              ＋ Add side game
            </button>
          </div>
        )}

        {tab === "rounds" && (
          <div style={{ padding: "0 22px 40px" }}>
            {TOURNAMENT.courses.map((c, i) => {
              const done = c.done;
              const live = c.live;
              return (
                <div
                  key={c.id}
                  style={{
                    padding: "16px 16px",
                    borderRadius: 16,
                    border: `1px solid ${live ? accent : T.hairline}`,
                    background: live ? `${accent}08` : T.paper,
                    marginBottom: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase" }}>
                        Day {i + 1} · {done ? "Final" : live ? "In progress" : "Upcoming"}
                      </div>
                      <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, letterSpacing: -0.3, color: T.ink, marginTop: 2 }}>{c.full}</div>
                    </div>
                    {done && <div style={{ fontFamily: T.serif, fontSize: 14, fontStyle: "italic", color: T.pencil }}>Jack won</div>}
                    {live && <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: accent, textTransform: "uppercase" }}>Thru 9</div>}
                  </div>

                  {!done && (
                    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                      {TGROUPS.map((g) => (
                        <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencilSoft, width: 54 }}>{g.time}</div>
                          <div style={{ display: "flex" }}>
                            {g.players.map((pid, pi) => {
                              const p = playerById[pid];
                              return (
                                <div
                                  key={pid}
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
                              );
                            })}
                          </div>
                          <div style={{ flex: 1, fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1 }}>
                            {g.players.map((pid) => playerById[pid].name).join(" · ")}
                          </div>
                          {live && <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencil }}>thru {g.thru}</div>}
                        </div>
                      ))}
                    </div>
                  )}

                  {done && (
                    <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                      {sorted.slice(0, 3).map((s, si) => {
                        const p = playerById[s.pid];
                        return (
                          <div key={s.pid} style={{ padding: "6px 8px", borderRadius: 8, background: T.paperDeep }}>
                            <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>
                              {si + 1}
                              {suffix(si + 1)}
                            </div>
                            <div style={{ fontFamily: T.sans, fontSize: 12, fontWeight: 500 }}>{p.name}</div>
                            <div style={{ fontFamily: T.serif, fontSize: 16, color: T.ink }}>
                              {s.r1Net} <span style={{ fontSize: 10, color: T.pencilSoft }}>net</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ k, v, sub }: { k: string; v: string | number; sub?: string }) {
  return (
    <div style={{ lineHeight: 1 }}>
      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase" }}>{k}</div>
      <div style={{ fontFamily: T.serif, fontSize: 22, color: T.ink, marginTop: 3, letterSpacing: -0.3 }}>{v}</div>
      {sub && <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencilSoft, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
