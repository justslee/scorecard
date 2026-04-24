"use client";

import { ReactNode, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";

// ──────────────────────────────────────────────────────────────────────
// Mock data — ported from the prototype's PlayerProfile
// ──────────────────────────────────────────────────────────────────────

const PP_PLAYER = {
  name: "Justin Lee",
  ghin: "8834-7729",
  home: "Presidio GC · San Francisco",
  memberSince: 2019,
  caddyNo: 77,
};

const PP_HANDICAP = {
  index: 8.2,
  trend90: -0.6,
  history: [10.1, 10.0, 9.8, 9.6, 9.8, 9.4, 9.2, 9.0, 8.8, 9.0, 8.6, 8.2],
  low: { value: 8.2, date: "Today" },
  high: { value: 12.4, date: "Mar 2024" },
};

const PP_SCORING = [
  { tee: "Championship", yards: 7040, avg: 88.4, par: 72, rounds: 4 },
  { tee: "Back", yards: 6620, avg: 84.1, par: 72, rounds: 18 },
  { tee: "Regular", yards: 6180, avg: 81.0, par: 72, rounds: 31 },
  { tee: "Forward", yards: 5640, avg: 77.2, par: 72, rounds: 3 },
];

const PP_SG = [
  { cat: "Off the tee", you: +0.4, label: "Driver length helps; fairway % hurts" },
  { cat: "Approach", you: -0.8, label: "Losing shots inside 150" },
  { cat: "Around green", you: +0.2, label: "Up-and-down rate: 42%" },
  { cat: "Putting", you: -0.3, label: "3-putt rate: 11% · one per round" },
];

const PP_FWY = { left: 18, middle: 62, right: 20 };

type BagClub = { club: string; carry: number; total: number; last: number; disp: number; hits: number };

const PP_BAG: BagClub[] = [
  { club: "Driver", carry: 252, total: 271, last: 274, disp: 24, hits: 312 },
  { club: "3-wood", carry: 228, total: 245, last: 239, disp: 22, hits: 84 },
  { club: "3-hybrid", carry: 210, total: 224, last: 218, disp: 20, hits: 141 },
  { club: "4-iron", carry: 196, total: 206, last: 202, disp: 18, hits: 92 },
  { club: "5-iron", carry: 184, total: 192, last: 188, disp: 17, hits: 168 },
  { club: "6-iron", carry: 172, total: 179, last: 176, disp: 15, hits: 204 },
  { club: "7-iron", carry: 161, total: 167, last: 164, disp: 14, hits: 256 },
  { club: "8-iron", carry: 148, total: 153, last: 149, disp: 12, hits: 221 },
  { club: "9-iron", carry: 135, total: 139, last: 136, disp: 11, hits: 198 },
  { club: "PW", carry: 121, total: 124, last: 119, disp: 10, hits: 176 },
  { club: "GW (52°)", carry: 102, total: 104, last: 101, disp: 9, hits: 124 },
  { club: "SW (56°)", carry: 84, total: 86, last: 82, disp: 8, hits: 112 },
  { club: "LW (60°)", carry: 64, total: 66, last: 63, disp: 6, hits: 88 },
];

type Recent = { id: string; date: string; course: string; tee: string; score: number; par: number; diff: number; tag: string | null };

const PP_RECENT: Recent[] = [
  { id: "r1", date: "Oct 13", course: "Spanish Bay", tee: "Back", score: 82, par: 72, diff: 5.2, tag: "T1" },
  { id: "r2", date: "Oct 12", course: "Spyglass Hill", tee: "Back", score: 84, par: 72, diff: 6.4, tag: null },
  { id: "r3", date: "Oct 11", course: "Pebble Beach", tee: "Back", score: 77, par: 72, diff: 1.8, tag: "PR" },
  { id: "r4", date: "Sep 28", course: "Presidio", tee: "Regular", score: 82, par: 72, diff: 4.6, tag: null },
  { id: "r5", date: "Sep 14", course: "Harding Park", tee: "Back", score: 86, par: 72, diff: 8.1, tag: null },
];

function buildYear(seed = 7) {
  const weeks = 52;
  const cells: Array<{ w: number; d: number; v: 0 | 1 | 2 | 3 }> = [];
  let r = seed;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      r = (r * 9301 + 49297) % 233280;
      const rand = r / 233280;
      const weekendBoost = d === 0 || d === 6 ? 2.2 : 1;
      const monthIdx = Math.floor(w / 4.33);
      const summerBoost = monthIdx >= 4 && monthIdx <= 9 ? 1.3 : 0.7;
      const p = rand * weekendBoost * summerBoost;
      let v: 0 | 1 | 2 | 3 = 0;
      if (p > 1.8) v = 3;
      else if (p > 1.2) v = 2;
      else if (p > 0.9) v = 1;
      cells.push({ w, d, v });
    }
  }
  return cells;
}

// ──────────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const router = useRouter();
  const accent = DEFAULT_ACCENT;

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
      <div style={{ maxWidth: 420, margin: "0 auto" }}>
        <Masthead accent={accent} onBack={() => router.push("/")} />
        <HandicapModule accent={accent} />
        <StrokesGained accent={accent} />
        <FairwayFan accent={accent} />
        <Bag accent={accent} />
        <ScoringByTee accent={accent} />
        <YearLog accent={accent} />
        <Recent accent={accent} />
        <Footer />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Section shell
// ──────────────────────────────────────────────────────────────────────

function Section({
  kicker,
  title,
  aside,
  children,
  tight,
}: {
  kicker: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <section style={{ padding: tight ? "18px 22px 14px" : "22px 22px 18px", borderTop: `1px solid ${T.hairline}`, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase", fontWeight: 500 }}>{kicker}</div>
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.4, lineHeight: 1, marginTop: 3 }}>{title}</div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Masthead
// ──────────────────────────────────────────────────────────────────────

function Masthead({ accent, onBack }: { accent: string; onBack: () => void }) {
  return (
    <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 18px", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button
          onClick={onBack}
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 1.6,
            color: T.pencil,
            textTransform: "uppercase",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12">
            <path d="M8 2 L3 6 L8 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Home
        </button>
        <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase", fontWeight: 500 }}>
          The Player&rsquo;s Book
        </div>
      </div>

      <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "1fr auto", gap: 14, alignItems: "flex-end" }}>
        <div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.6,
              color: accent,
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            №&nbsp;{PP_PLAYER.caddyNo} · Member since {PP_PLAYER.memberSince}
          </div>
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 38,
              color: T.ink,
              letterSpacing: -1,
              lineHeight: 1,
              marginTop: 4,
            }}
          >
            {PP_PLAYER.name}
          </div>
          <div
            style={{
              fontFamily: T.serif,
              fontSize: 14,
              color: T.pencil,
              letterSpacing: -0.1,
              marginTop: 6,
              fontStyle: "italic",
            }}
          >
            {PP_PLAYER.home}
          </div>
        </div>
        <div
          style={{
            width: 62,
            height: 78,
            position: "relative",
            background: T.paperDeep,
            border: `1.5px solid ${T.ink}`,
            borderRadius: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 1px 0 rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ position: "absolute", top: 3, left: 3, right: 3, height: 1, background: accent }} />
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 36, color: T.ink, letterSpacing: -1.5, lineHeight: 1 }}>
            {PP_PLAYER.caddyNo}
          </div>
          <div
            style={{
              position: "absolute",
              bottom: 4,
              left: 0,
              right: 0,
              textAlign: "center",
              fontFamily: T.mono,
              fontSize: 5.5,
              letterSpacing: 1.8,
              color: T.pencil,
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            GHIN {PP_PLAYER.ghin}
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Handicap — big italic index + sparkline with dots + high/low bar
// ──────────────────────────────────────────────────────────────────────

function HandicapSpark({ data, accent, width = 316, height = 84 }: { data: number[]; accent: string; width?: number; height?: number }) {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const padX = 6;
  const padY = 10;
  const w = width - padX * 2;
  const h = height - padY * 2;
  const pts = data.map((v, i) => [padX + (i / (data.length - 1)) * w, padY + h - ((v - min) / (max - min || 1)) * h] as [number, number]);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${path} L${pts[pts.length - 1][0].toFixed(1)},${height - padY} L${pts[0][0].toFixed(1)},${height - padY} Z`;
  const last = pts[pts.length - 1];
  const first = pts[0];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      {[0, 0.5, 1].map((p) => (
        <line key={p} x1={padX} x2={width - padX} y1={padY + h * p} y2={padY + h * p} stroke={T.hairline} strokeWidth="0.5" strokeDasharray="2 3" />
      ))}
      <path d={area} fill={accent} opacity="0.08" />
      <path d={path} fill="none" stroke={accent} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />

      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p[0]}
          cy={p[1]}
          r={i === pts.length - 1 ? 3.2 : 1.4}
          fill={i === pts.length - 1 ? accent : T.paper}
          stroke={i === pts.length - 1 ? accent : T.pencil}
          strokeWidth="0.8"
        />
      ))}

      <text x={first[0] - 2} y={first[1] - 6} fontFamily={T.mono} fontSize="7.5" fill={T.pencil} letterSpacing="0.5" textAnchor="start">
        {data[0].toFixed(1)}
      </text>
      <text x={last[0] + 5} y={last[1] + 3} fontFamily={T.mono} fontSize="8.5" fill={accent} letterSpacing="0.5" fontWeight="600">
        {data[data.length - 1].toFixed(1)}
      </text>
    </svg>
  );
}

function HandicapModule({ accent }: { accent: string }) {
  return (
    <Section
      kicker="Index"
      title="Handicap"
      aside={
        <button
          style={{
            border: `1px solid ${T.ink}`,
            borderRadius: 99,
            padding: "5px 10px",
            background: "transparent",
            cursor: "pointer",
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.ink,
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          + Post score
        </button>
      }
    >
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 18, padding: "6px 0 4px" }}>
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
            Current · GHIN
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 76, letterSpacing: -2.6, color: T.ink, lineHeight: 0.9, fontVariantNumeric: "tabular-nums" }}>
              {PP_HANDICAP.index}
            </div>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.2,
                color: accent,
                textTransform: "uppercase",
                fontWeight: 600,
                border: `1px solid ${accent}`,
                borderRadius: 99,
                padding: "2px 7px",
              }}
            >
              ↓ {Math.abs(PP_HANDICAP.trend90).toFixed(1)} · 90d
            </div>
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 13, color: T.pencil, fontStyle: "italic", marginTop: 4 }}>Lowest since 2019.</div>
        </div>
      </div>

      <div style={{ marginTop: 14, padding: "10px 0 4px", borderTop: `1px dashed ${T.hairline}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
            Last 12 scoring rounds
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase" }}>Jul → Today</div>
        </div>
        <HandicapSpark data={PP_HANDICAP.history} accent={accent} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", borderTop: `1px dashed ${T.hairline}`, paddingTop: 10, marginTop: 4 }}>
        {[
          { l: "Low", v: String(PP_HANDICAP.low.value), sub: PP_HANDICAP.low.date },
          { l: "High", v: String(PP_HANDICAP.high.value), sub: PP_HANDICAP.high.date },
          { l: "Differential", v: "+10.2", sub: "Last round" },
        ].map((b, i) => (
          <div key={b.l} style={{ padding: "0 8px", borderLeft: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}` }}>
            <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>{b.l}</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 20, color: T.ink, letterSpacing: -0.4, lineHeight: 1.1, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
              {b.v}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", marginTop: 2 }}>{b.sub}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Strokes gained
// ──────────────────────────────────────────────────────────────────────

function StrokesGained({ accent }: { accent: string }) {
  const max = Math.max(...PP_SG.map((s) => Math.abs(s.you))) + 0.2;
  return (
    <Section
      kicker="Shot quality"
      title="Strokes gained"
      aside={
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
          vs 10-hdcp
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {PP_SG.map((s, i) => {
          const pct = s.you / max;
          const pos = pct >= 0;
          const width = Math.abs(pct) * 50;
          return (
            <div key={s.cat}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 3 }}>
                <div style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1, fontStyle: "italic" }}>{s.cat}</div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 11,
                    letterSpacing: 0.5,
                    color: pos ? accent : T.pencil,
                    fontVariantNumeric: "tabular-nums",
                    fontWeight: 600,
                  }}
                >
                  {pos ? "+" : ""}
                  {s.you.toFixed(1)}
                </div>
              </div>
              <div style={{ position: "relative", height: 14, background: T.paperDeep, borderRadius: 2 }}>
                <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: T.ink, opacity: 0.3 }} />
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${width}%` }}
                  transition={{ delay: 0.1 + i * 0.08, duration: 0.6, ease: T.ease }}
                  style={{
                    position: "absolute",
                    top: 2,
                    bottom: 2,
                    left: pos ? "50%" : undefined,
                    right: pos ? undefined : "50%",
                    background: pos ? accent : T.pencil,
                    borderRadius: 1,
                  }}
                />
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 11.5, color: T.pencilSoft, marginTop: 3, fontStyle: "italic", letterSpacing: -0.05 }}>{s.label}</div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Fairway fan
// ──────────────────────────────────────────────────────────────────────

function FairwayFan({ accent }: { accent: string }) {
  const { left, middle, right } = PP_FWY;
  return (
    <Section
      kicker="Tendencies"
      title="Off the tee"
      aside={
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
          Last 30 rounds
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 14, alignItems: "center" }}>
        <div style={{ position: "relative" }}>
          <svg width="160" height="120" viewBox="0 0 160 120">
            <circle cx="80" cy="110" r="2.5" fill={T.ink} />
            <text x="80" y="118" textAnchor="middle" fontFamily={T.mono} fontSize="7" fill={T.pencilSoft} letterSpacing="1">TEE</text>

            <path d="M80,110 L10,40 A85,85 0 0,1 55,18 Z" fill={`${T.pencil}25`} stroke={T.hairline} strokeWidth="0.6" />
            <path d="M80,110 L55,18 A85,85 0 0,1 105,18 Z" fill={`${accent}20`} stroke={accent} strokeWidth="0.6" />
            <path d="M80,110 L105,18 A85,85 0 0,1 150,40 Z" fill={`${T.pencil}25`} stroke={T.hairline} strokeWidth="0.6" />

            <text x="30" y="58" textAnchor="middle" fontFamily={T.serif} fontStyle="italic" fontSize="14" fill={T.ink} letterSpacing="-0.2">{left}%</text>
            <text x="30" y="68" textAnchor="middle" fontFamily={T.mono} fontSize="6.5" fill={T.pencil} letterSpacing="1">LEFT</text>
            <text x="80" y="50" textAnchor="middle" fontFamily={T.serif} fontStyle="italic" fontSize="20" fill={T.ink} letterSpacing="-0.4">{middle}%</text>
            <text x="80" y="62" textAnchor="middle" fontFamily={T.mono} fontSize="6.5" fill={accent} letterSpacing="1" fontWeight="600">FAIRWAY</text>
            <text x="130" y="58" textAnchor="middle" fontFamily={T.serif} fontStyle="italic" fontSize="14" fill={T.ink} letterSpacing="-0.2">{right}%</text>
            <text x="130" y="68" textAnchor="middle" fontFamily={T.mono} fontSize="6.5" fill={T.pencil} letterSpacing="1">RIGHT</text>

            {Array.from({ length: 18 }).map((_, i) => {
              const seed = (i * 7919) % 100;
              const angle = -Math.PI / 2 + ((seed - 50) / 50) * 0.55;
              const dist = 50 + (seed % 40);
              const x = 80 + Math.cos(angle) * dist;
              const y = 110 + Math.sin(angle) * dist;
              return <circle key={i} cx={x} cy={y} r="1.6" fill={T.ink} opacity="0.45" />;
            })}
          </svg>
        </div>

        <div>
          <div style={{ fontFamily: T.serif, fontSize: 13, color: T.ink, fontStyle: "italic", letterSpacing: -0.1, lineHeight: 1.35 }}>
            You miss{" "}
            <span style={{ color: accent, fontWeight: 500, fontStyle: "normal", fontFamily: T.sans }}>slightly right</span>, and rarely left of center.
          </div>
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>Drive dist</div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 20,
                  color: T.ink,
                  letterSpacing: -0.4,
                  lineHeight: 1,
                  marginTop: 2,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                268<span style={{ fontSize: 11, color: T.pencil, marginLeft: 2 }}>yd</span>
              </div>
            </div>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>Dispersion</div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 20,
                  color: T.ink,
                  letterSpacing: -0.4,
                  lineHeight: 1,
                  marginTop: 2,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                ±28<span style={{ fontSize: 11, color: T.pencil, marginLeft: 2 }}>yd</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// The bag
// ──────────────────────────────────────────────────────────────────────

function Bag({ accent }: { accent: string }) {
  const [sel, setSel] = useState("7-iron");
  const [editMode, setEditMode] = useState(false);
  const selected = PP_BAG.find((c) => c.club === sel);
  const maxTotal = Math.max(...PP_BAG.map((c) => c.total));

  return (
    <Section
      kicker="The bag"
      title="Club distances"
      aside={
        <button
          onClick={() => setEditMode((e) => !e)}
          style={{
            border: `1px solid ${editMode ? accent : T.ink}`,
            borderRadius: 99,
            padding: "5px 10px",
            background: editMode ? accent : "transparent",
            cursor: "pointer",
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: editMode ? T.paper : T.ink,
            textTransform: "uppercase",
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          {editMode ? "Done" : "✎ Edit"}
        </button>
      }
    >
      {selected && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            padding: "12px 14px",
            borderRadius: 10,
            border: `1px solid ${T.hairline}`,
            background: T.paperDeep,
            marginBottom: 10,
          }}
        >
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>Selected</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 24, color: T.ink, letterSpacing: -0.5, lineHeight: 1, marginTop: 2 }}>
              {selected.club}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", marginTop: 4 }}>
              {selected.hits} shots tracked
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", justifyContent: "flex-end" }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>Carry</div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.3, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                {selected.carry}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: accent, textTransform: "uppercase", fontWeight: 600 }}>Total</div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 22,
                  color: accent,
                  letterSpacing: -0.3,
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {selected.total}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column" }}>
        {PP_BAG.map((c, i) => {
          const active = c.club === sel;
          const widthCarry = (c.carry / maxTotal) * 100;
          const widthTotal = (c.total / maxTotal) * 100;
          const lastPct = (c.last / maxTotal) * 100;
          const dispWidth = (c.disp / maxTotal) * 100;
          const dispLeft = widthCarry - dispWidth / 2;
          return (
            <button
              key={c.club}
              onClick={() => setSel(c.club)}
              style={{
                display: "grid",
                gridTemplateColumns: "64px 1fr 54px",
                gap: 10,
                alignItems: "center",
                padding: "8px 0",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                borderTop: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}`,
                textAlign: "left",
              }}
            >
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: active ? "italic" : "normal",
                  fontSize: 14,
                  color: active ? accent : T.ink,
                  letterSpacing: -0.1,
                  fontWeight: active ? 500 : 400,
                }}
              >
                {c.club}
              </div>
              <div style={{ position: "relative", height: 10, background: T.paperDeep, borderRadius: 1 }}>
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${widthTotal}%`,
                    background: active ? `${accent}30` : `${T.pencil}30`,
                    borderRadius: 1,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${widthCarry}%`,
                    background: active ? accent : T.ink,
                    borderRadius: 1,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: `calc(${lastPct}% - 1px)`,
                    top: -2,
                    bottom: -2,
                    width: 2,
                    background: T.paper,
                    border: `0.5px solid ${T.ink}`,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: `${dispLeft}%`,
                    width: `${dispWidth}%`,
                    top: -3,
                    height: 2,
                    border: `1px solid ${T.ink}`,
                    borderBottom: "none",
                    borderRadius: "1px 1px 0 0",
                    opacity: 0.35,
                  }}
                />
              </div>
              <div
                style={{
                  textAlign: "right",
                  fontFamily: T.mono,
                  fontSize: 12,
                  color: active ? accent : T.ink,
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: 0.5,
                  fontWeight: active ? 600 : 500,
                }}
              >
                {c.total}
                <span style={{ fontSize: 8, color: T.pencilSoft, marginLeft: 2, letterSpacing: 1 }}>yd</span>
              </div>
            </button>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 10,
          padding: "8px 0 0",
          borderTop: `1px dashed ${T.hairline}`,
          display: "flex",
          gap: 16,
          fontFamily: T.mono,
          fontSize: 8,
          letterSpacing: 1.1,
          color: T.pencilSoft,
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 6, background: T.ink, borderRadius: 1 }} /> Carry
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 6, background: `${T.pencil}30`, borderRadius: 1 }} /> Roll
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 2, height: 8, background: T.ink }} /> Last hit
        </span>
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Scoring by tee
// ──────────────────────────────────────────────────────────────────────

function ScoringByTee({ accent }: { accent: string }) {
  const maxAvg = Math.max(...PP_SCORING.map((s) => s.avg));
  return (
    <Section
      kicker="Course"
      title="Scoring by tee"
      aside={
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
          Lifetime
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {PP_SCORING.map((s) => {
          const over = s.avg - s.par;
          const width = (s.avg / (maxAvg * 1.05)) * 100;
          const parWidth = width * (s.par / s.avg);
          return (
            <div key={s.tee}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 3 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1, fontStyle: "italic" }}>{s.tee}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
                    {s.yards.toLocaleString()} yd · {s.rounds} rounds
                  </span>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 0.5, color: T.ink, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                  {s.avg.toFixed(1)}
                  <span style={{ color: accent, marginLeft: 4 }}>+{over.toFixed(1)}</span>
                </div>
              </div>
              <div style={{ position: "relative", height: 10, background: T.paperDeep, borderRadius: 1 }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${parWidth}%`, background: T.ink, borderRadius: 1 }} />
                <div
                  style={{
                    position: "absolute",
                    left: `${parWidth}%`,
                    top: 0,
                    bottom: 0,
                    width: `${width - parWidth}%`,
                    background: accent,
                    opacity: 0.8,
                    borderRadius: 1,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 10,
          padding: "8px 0 0",
          borderTop: `1px dashed ${T.hairline}`,
          display: "flex",
          gap: 16,
          fontFamily: T.mono,
          fontSize: 8,
          letterSpacing: 1.1,
          color: T.pencilSoft,
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 6, background: T.ink }} /> At par
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 6, background: accent, opacity: 0.8 }} /> Over
        </span>
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Year heatmap
// ──────────────────────────────────────────────────────────────────────

function YearLog({ accent }: { accent: string }) {
  const cells = useMemo(() => buildYear(7), []);
  const rounds = cells.filter((c) => c.v > 0).length;
  const nines = cells.filter((c) => c.v === 1).length;
  const r18 = cells.filter((c) => c.v === 2).length;
  const tourn = cells.filter((c) => c.v === 3).length;

  const cellSize = 7;
  const gap = 2;
  const w = 52 * (cellSize + gap);
  const h = 7 * (cellSize + gap);

  const color = (v: 0 | 1 | 2 | 3) => {
    if (v === 0) return T.paperDeep;
    if (v === 1) return `${T.pencil}80`;
    if (v === 2) return T.ink;
    if (v === 3) return accent;
    return T.paperDeep;
  };

  return (
    <Section
      kicker="Log"
      title="This season"
      aside={
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
          52 weeks
        </div>
      }
    >
      <div
        style={{
          padding: "12px 12px",
          borderRadius: 8,
          background: T.paperDeep,
          border: `1px solid ${T.hairlineSoft}`,
          overflowX: "auto",
        }}
      >
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          {cells.map((c, i) => (
            <rect
              key={i}
              x={c.w * (cellSize + gap)}
              y={c.d * (cellSize + gap)}
              width={cellSize}
              height={cellSize}
              rx="1"
              fill={color(c.v)}
              opacity={c.v === 0 ? 0.5 : 1}
            />
          ))}
        </svg>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 6,
            fontFamily: T.mono,
            fontSize: 7.5,
            letterSpacing: 1,
            color: T.pencilSoft,
            textTransform: "uppercase",
          }}
        >
          {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", paddingTop: 8, borderTop: `1px dashed ${T.hairline}` }}>
        {[
          { l: "Rounds", v: rounds, accent: false },
          { l: "9 holes", v: nines, accent: false },
          { l: "18 holes", v: r18, accent: false },
          { l: "Tourneys", v: tourn, accent: true },
        ].map((b, i) => (
          <div key={b.l} style={{ borderLeft: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}`, paddingLeft: i === 0 ? 0 : 10 }}>
            <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>{b.l}</div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 20,
                color: b.accent ? accent : T.ink,
                letterSpacing: -0.4,
                lineHeight: 1.1,
                marginTop: 2,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {b.v}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Recent
// ──────────────────────────────────────────────────────────────────────

function Recent({ accent }: { accent: string }) {
  return (
    <Section
      kicker="Ledger"
      title="Recent rounds"
      aside={
        <button
          style={{
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.ink,
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          All {"\u2192"}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        {PP_RECENT.map((r, i) => (
          <button
            key={r.id}
            style={{
              display: "grid",
              gridTemplateColumns: "44px 1fr auto auto",
              gap: 10,
              alignItems: "center",
              padding: "10px 0",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              textAlign: "left",
              borderTop: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}`,
            }}
          >
            <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>{r.date}</div>
            <div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.ink, letterSpacing: -0.2, lineHeight: 1.1 }}>{r.course}</div>
              <div style={{ fontFamily: T.mono, fontSize: 7.5, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", marginTop: 2, fontWeight: 500 }}>
                {r.tee} · {r.par} par
              </div>
            </div>
            {r.tag ? (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 8,
                  letterSpacing: 1,
                  color: accent,
                  fontWeight: 600,
                  border: `1px solid ${accent}`,
                  padding: "1px 4px",
                  borderRadius: 2,
                  textTransform: "uppercase",
                }}
              >
                {r.tag}
              </span>
            ) : (
              <span />
            )}
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 18,
                  color: T.ink,
                  letterSpacing: -0.3,
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {r.score}
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 0.5, color: T.pencilSoft, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                {r.diff > 0 ? "+" : ""}
                {r.diff}
              </div>
            </div>
          </button>
        ))}
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Footer
// ──────────────────────────────────────────────────────────────────────

function Footer() {
  const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <div style={{ padding: "24px 22px 36px", textAlign: "center", borderTop: `1px solid ${T.hairline}` }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontFamily: T.mono,
          fontSize: 8.5,
          letterSpacing: 1.6,
          color: T.pencil,
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        <div style={{ width: 18, height: 1, background: T.hairline }} />
        <svg width="8" height="10" viewBox="0 0 8 10">
          <line x1="1.5" y1="1" x2="1.5" y2="9" stroke={T.ink} strokeWidth="0.8" />
          <path d="M1.5,2 L7,3.5 L1.5,5 Z" fill={T.flag} />
        </svg>
        <span>GHIN · verified · {dateStr}</span>
        <div style={{ width: 18, height: 1, background: T.hairline }} />
      </div>
    </div>
  );
}
