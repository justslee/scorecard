"use client";

// LeaderboardSheet — mid-round leaderboard across all active games.
// Ported from LeaderboardSheet.jsx. Swipable segmented tabs:
// Overall / Nassau / Skins / 3-Pt. Pulls up from bottom like a sheet of paper.

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE } from "./tokens";
import type { SeedPlayer } from "./Scorecard";

type TabId = "overall" | "nassau" | "skins" | "3pt";

const TABS: { id: TabId; label: string }[] = [
  { id: "overall", label: "Overall" },
  { id: "nassau", label: "Nassau · $20" },
  { id: "skins", label: "Skins · $10" },
  { id: "3pt", label: "3-Point · $5" },
];

// Mock game data — realistic mid-round state (playing through hole 8)
const LB_MOCK = {
  nassau: {
    bet: 20,
    totalsF9: { p1: 32, p2: 34, p3: 30, p4: 36 } as Record<string, number>,
    totalsB9: { p1: 0, p2: 0, p3: 0, p4: 0 } as Record<string, number>,
    totalsAll: { p1: 32, p2: 34, p3: 30, p4: 36 } as Record<string, number>,
    f9Leader: "p3" as string | null,
    b9Leader: null as string | null,
    overallLeader: "p3" as string,
    thruFront: 7,
  },
  skins: {
    bet: 10,
    byPlayer: [
      { pid: "p1", skins: 2, holes: [3, 7] },
      { pid: "p2", skins: 0, holes: [] },
      { pid: "p3", skins: 2, holes: [1, 2] },
      { pid: "p4", skins: 0, holes: [] },
    ],
    potCarrying: 2,
    potHoles: [5, 6],
  },
  threePoint: {
    bet: 5,
    teamA: { id: "tA", name: "You & Sam", pids: ["p1", "p3"] },
    teamB: { id: "tB", name: "Jordan & Riley", pids: ["p2", "p4"] },
    pointsA: 8,
    pointsB: 4,
  },
};

function Tab({ children, active, onClick, accent }: { children: React.ReactNode; active: boolean; onClick: () => void; accent: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        position: "relative",
        padding: "8px 14px",
        border: "none",
        background: "transparent",
        fontFamily: T.sans,
        fontSize: 12.5,
        fontWeight: active ? 600 : 400,
        color: active ? T.ink : T.pencil,
        cursor: "pointer",
        letterSpacing: -0.1,
      }}
    >
      {children}
      {active && (
        <motion.div
          layoutId="lb-tab-underline"
          style={{ position: "absolute", left: 10, right: 10, bottom: 2, height: 2, background: accent, borderRadius: 99 }}
        />
      )}
    </button>
  );
}

function DotStrip({ scores, pars, start = 0, accent }: { scores: (number | null)[]; pars: number[]; start?: number; accent: string }) {
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {Array.from({ length: 9 }, (_, i) => {
        const s = scores[start + i];
        const p = pars[start + i];
        if (s == null) {
          return <div key={i} style={{ width: 6, height: 6, borderRadius: 99, background: T.hairlineSoft }} />;
        }
        const diff = s - p;
        let bg = T.pencilSoft;
        if (diff <= -2) bg = "oklch(0.48 0.14 280)";
        else if (diff === -1) bg = accent;
        else if (diff === 0) bg = T.ink;
        else if (diff === 1) bg = T.pencil;
        else bg = T.pencilSoft;
        return <div key={i} style={{ width: 6, height: 6, borderRadius: diff <= -1 ? 99 : 1.5, background: bg }} />;
      })}
    </div>
  );
}

// ── OVERALL ─────────────────────────────────────────────────────────────

function Overall({ players, scores, pars, accent }: { players: SeedPlayer[]; scores: Record<string, (number | null)[]>; pars: number[]; accent: string }) {
  const withTotals = players
    .map((p) => {
      const sc = scores[p.id] ?? [];
      const played = sc.filter((s) => s != null);
      const thru = played.length;
      const total = sc.reduce<number>((a, b) => a + (b ?? 0), 0);
      const relPar = sc.reduce<number>((a, s, i) => a + (s != null ? s - pars[i] : 0), 0);
      return { ...p, total, relPar, thru, scores: sc };
    })
    .sort((a, b) => {
      if (a.thru === 0) return 1;
      if (b.thru === 0) return -1;
      return a.relPar - b.relPar;
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "0 2px" }}>
        <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>
          Stroke play · Thru {withTotals[0]?.thru ?? 0}
        </div>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 13, color: T.pencil }}>{withTotals[0]?.name} leads</div>
      </div>

      {withTotals.map((p, i) => {
        const isLeader = i === 0;
        const posLabel = i === 0 ? "1st" : i === 1 ? "2nd" : i === 2 ? "3rd" : `${i + 1}th`;
        return (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05, ease: T.ease }}
            style={{
              display: "grid",
              gridTemplateColumns: "28px 1fr auto",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              background: isLeader ? "rgba(26,42,26,0.03)" : "transparent",
              border: `1px solid ${isLeader ? T.hairline : T.hairlineSoft}`,
              borderRadius: 14,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 99,
                border: `1.5px solid ${isLeader ? accent : T.hairline}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 13,
                color: isLeader ? accent : T.pencil,
              }}
            >
              {i + 1}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink, letterSpacing: -0.2 }}>{p.name}</div>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>
                  {posLabel} · HCP {p.hcp}
                </div>
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 6, alignItems: "center" }}>
                <DotStrip scores={p.scores} pars={pars} start={0} accent={accent} />
                <div style={{ width: 1, height: 10, background: T.hairline }} />
                <DotStrip scores={p.scores} pars={pars} start={9} accent={accent} />
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.serif, fontSize: 26, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                {p.thru > 0 ? p.total : "—"}
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, color: p.relPar < 0 ? accent : T.pencil, marginTop: 2 }}>
                {p.thru === 0 ? "—" : p.relPar === 0 ? "E" : p.relPar > 0 ? `+${p.relPar}` : p.relPar}
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ── NASSAU ──────────────────────────────────────────────────────────────

function Nassau({ players, accent }: { players: SeedPlayer[]; accent: string }) {
  const nameFor = (pid: string) => players.find((p) => p.id === pid)?.name ?? "—";
  const n = LB_MOCK.nassau;

  const segs = [
    { k: "Front 9", winner: n.f9Leader, note: `Thru ${n.thruFront}`, inProgress: true },
    { k: "Back 9", winner: n.b9Leader, note: "Not started", inProgress: false },
    { k: "Overall", winner: n.overallLeader, note: "Projected", inProgress: true },
  ];

  const rows = Object.entries(n.totalsAll).sort((a, b) => a[1] - b[1]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 0,
          border: `1px solid ${T.hairline}`,
          borderRadius: 14,
          overflow: "hidden",
          background: T.paper,
        }}
      >
        {segs.map((s, i) => (
          <div key={s.k} style={{ padding: "14px 10px", borderLeft: i > 0 ? `1px solid ${T.hairline}` : "none", textAlign: "center" }}>
            <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencil, textTransform: "uppercase", marginBottom: 4 }}>{s.k}</div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 16,
                color: s.winner ? T.ink : T.pencilSoft,
                letterSpacing: -0.3,
              }}
            >
              {s.winner ? nameFor(s.winner) : "—"}
            </div>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1,
                color: s.inProgress ? accent : T.pencilSoft,
                marginTop: 3,
                textTransform: "uppercase",
              }}
            >
              {s.note}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          background: "rgba(26,42,26,0.03)",
          borderRadius: 10,
        }}
      >
        <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencil, textTransform: "uppercase" }}>Stakes</div>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.ink }}>
          ${n.bet} / bet · 3 segments · ${n.bet * 3} max
        </div>
      </div>

      <div>
        <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase", marginBottom: 8 }}>Running totals</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 40px 40px 44px",
            gap: 2,
            fontFamily: T.mono,
            fontSize: 9,
            color: T.pencilSoft,
            textTransform: "uppercase",
            letterSpacing: 1,
            padding: "0 12px 6px",
          }}
        >
          <div>Player</div>
          <div style={{ textAlign: "right" }}>F9</div>
          <div style={{ textAlign: "right" }}>B9</div>
          <div style={{ textAlign: "right" }}>Tot</div>
        </div>
        <div style={{ border: `1px solid ${T.hairline}`, borderRadius: 12, overflow: "hidden" }}>
          {rows.map(([pid, tot], i) => (
            <div
              key={pid}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 40px 40px 44px",
                gap: 2,
                alignItems: "center",
                padding: "10px 12px",
                borderTop: i > 0 ? `1px solid ${T.hairlineSoft}` : "none",
                background: pid === n.overallLeader ? "rgba(26,42,26,0.025)" : "transparent",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink }}>{nameFor(pid)}</span>
                {pid === n.overallLeader && (
                  <span style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1, color: accent, textTransform: "uppercase" }}>lead</span>
                )}
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n.totalsF9[pid]}</div>
              <div style={{ fontFamily: T.serif, fontSize: 14, color: T.pencilSoft, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>—</div>
              <div style={{ fontFamily: T.serif, fontSize: 18, color: T.ink, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{tot}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── SKINS ───────────────────────────────────────────────────────────────

function Skins({ players, accent }: { players: SeedPlayer[]; accent: string }) {
  const nameFor = (pid: string) => players.find((p) => p.id === pid)?.name ?? "—";
  const sk = LB_MOCK.skins;
  const sorted = [...sk.byPlayer].sort((a, b) => b.skins - a.skins);
  const maxSkins = Math.max(...sorted.map((s) => s.skins), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {sk.potCarrying > 0 && (
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          style={{
            padding: "14px 16px",
            border: `1px dashed ${accent}`,
            borderRadius: 14,
            background: "rgba(26,42,26,0.02)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: accent, textTransform: "uppercase" }}>Pot carrying</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15, color: T.ink, marginTop: 2 }}>
              {sk.potCarrying} skins on hole {sk.potHoles.slice(-1)[0] + 1}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: T.serif, fontSize: 26, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
              ${sk.bet * (sk.potCarrying + 1)}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1, color: T.pencil, textTransform: "uppercase" }}>up for grabs</div>
          </div>
        </motion.div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted.map((s) => {
          const winnings = s.skins * sk.bet;
          return (
            <div key={s.pid} style={{ padding: "12px 14px", border: `1px solid ${T.hairlineSoft}`, borderRadius: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}>{nameFor(s.pid)}</span>
                  {s.holes.length > 0 && (
                    <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase" }}>
                      Holes {s.holes.join(", ")}
                    </span>
                  )}
                </div>
                <div style={{ textAlign: "right" }}>
                  <span
                    style={{
                      fontFamily: T.serif,
                      fontSize: 22,
                      color: s.skins > 0 ? T.ink : T.pencilSoft,
                      fontVariantNumeric: "tabular-nums",
                      marginRight: 6,
                    }}
                  >
                    {s.skins}
                  </span>
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 9.5,
                      letterSpacing: 1,
                      color: winnings > 0 ? accent : T.pencilSoft,
                      textTransform: "uppercase",
                    }}
                  >
                    +${winnings}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 3 }}>
                {Array.from({ length: maxSkins }, (_, j) => (
                  <div
                    key={j}
                    style={{
                      flex: 1,
                      height: 6,
                      borderRadius: 1.5,
                      background: j < s.skins ? accent : T.hairlineSoft,
                    }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 3-POINT ─────────────────────────────────────────────────────────────

function ThreePoint({ accent }: { accent: string }) {
  const tp = LB_MOCK.threePoint;
  const lead = tp.pointsA > tp.pointsB ? "A" : tp.pointsB > tp.pointsA ? "B" : null;
  const diff = Math.abs(tp.pointsA - tp.pointsB);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ padding: "24px 18px", border: `1px solid ${T.hairline}`, borderRadius: 18, background: T.paper }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 14 }}>
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontFamily: T.serif,
                fontSize: 48,
                color: lead === "A" ? T.ink : T.pencilSoft,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1,
                letterSpacing: -1,
              }}
            >
              {tp.pointsA}
            </div>
            <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink, marginTop: 6, letterSpacing: -0.2 }}>{tp.teamA.name}</div>
            {lead === "A" && (
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: accent, textTransform: "uppercase", marginTop: 3 }}>
                Up {diff} · +${diff * tp.bet}
              </div>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 18, color: T.pencilSoft }}>vs</div>
            <div style={{ width: 1, height: 40, background: T.hairline }} />
          </div>

          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontFamily: T.serif,
                fontSize: 48,
                color: lead === "B" ? T.ink : T.pencilSoft,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1,
                letterSpacing: -1,
              }}
            >
              {tp.pointsB}
            </div>
            <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink, marginTop: 6, letterSpacing: -0.2 }}>{tp.teamB.name}</div>
            {lead === "B" && (
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: accent, textTransform: "uppercase", marginTop: 3 }}>
                Up {diff} · +${diff * tp.bet}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {[
          { k: "Low ball", v: "Best of team" },
          { k: "Low total", v: "Both combined" },
          { k: "Low pair", v: "Both count" },
        ].map((pt) => (
          <div key={pt.k} style={{ padding: "10px 12px", border: `1px solid ${T.hairlineSoft}`, borderRadius: 10 }}>
            <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencil, textTransform: "uppercase" }}>{pt.k}</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 12, color: T.inkSoft, marginTop: 2 }}>{pt.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── MAIN SHEET ──────────────────────────────────────────────────────────

export default function LeaderboardSheet({
  open,
  onClose,
  players,
  scores,
  pars,
  accent,
}: {
  open: boolean;
  onClose: () => void;
  players: SeedPlayer[];
  scores: Record<string, (number | null)[]>;
  pars: number[];
  accent: string;
}) {
  const [tab, setTab] = useState<TabId>("overall");
  useEffect(() => {
    if (open) setTab("overall");
  }, [open]);

  const thru = Math.max(0, ...players.map((p) => (scores[p.id] ?? []).filter((s) => s != null).length));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="lb-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          style={{ position: "fixed", inset: 0, background: "rgba(26,42,26,0.4)", zIndex: 60 }}
        />
      )}
      {open && (
        <motion.div
          key="lb-sheet"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={T.springSoft}
          style={{
            position: "fixed",
            top: 36,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 70,
            background: `${PAPER_NOISE}, ${T.paper}`,
            backgroundBlendMode: "multiply",
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            boxShadow: "0 -20px 50px rgba(26,42,26,0.3)",
            display: "flex",
            flexDirection: "column",
            maxWidth: 420,
            margin: "0 auto",
          }}
        >
          <div style={{ width: 40, height: 4, borderRadius: 99, background: T.hairline, margin: "14px auto 10px" }} />

          <div style={{ padding: "0 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>Leaderboards · Live</div>
              <div style={{ fontFamily: T.serif, fontSize: 26, fontStyle: "italic", color: T.ink, letterSpacing: -0.6, marginTop: 2 }}>
                Through hole {thru}
              </div>
            </div>
            <button
              onClick={onClose}
              style={{
                width: 32,
                height: 32,
                borderRadius: 99,
                border: `1px solid ${T.hairline}`,
                background: "transparent",
                color: T.ink,
                fontSize: 16,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ×
            </button>
          </div>

          <div style={{ display: "flex", gap: 2, padding: "0 14px", borderBottom: `1px solid ${T.hairlineSoft}`, overflowX: "auto" }}>
            {TABS.map((t) => (
              <Tab key={t.id} active={tab === t.id} onClick={() => setTab(t.id)} accent={accent}>
                {t.label}
              </Tab>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "18px 18px 40px", WebkitOverflowScrolling: "touch" }}>
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22, ease: T.ease }}
              >
                {tab === "overall" && <Overall players={players} scores={scores} pars={pars} accent={accent} />}
                {tab === "nassau" && <Nassau players={players} accent={accent} />}
                {tab === "skins" && <Skins players={players} accent={accent} />}
                {tab === "3pt" && <ThreePoint accent={accent} />}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
