"use client";

import Link from "next/link";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";

const PP_PLAYER = {
  name: "Justin Lee",
  home: "Presidio GC · San Francisco",
  memberSince: 2019,
  caddyNo: 77,
  ghin: "8834-7729",
};

const HANDICAP = {
  index: 8.2,
  trend90: -0.6,
  history: [10.1, 10.0, 9.8, 9.6, 9.8, 9.4, 9.2, 9.0, 8.8, 9.0, 8.6, 8.2],
};

const SG = [
  { cat: "Off the tee", you: +0.4, label: "Driver length helps; fairway % hurts" },
  { cat: "Approach", you: -0.8, label: "Losing shots inside 150" },
  { cat: "Around green", you: +0.2, label: "Up-and-down rate: 42%" },
  { cat: "Putting", you: -0.3, label: "3-putt rate: 11% · one per round" },
];

const BAG = [
  { club: "Driver", carry: 252, total: 271 },
  { club: "3-wood", carry: 228, total: 245 },
  { club: "3-hybrid", carry: 210, total: 224 },
  { club: "4-iron", carry: 196, total: 206 },
  { club: "5-iron", carry: 184, total: 192 },
  { club: "6-iron", carry: 172, total: 179 },
  { club: "7-iron", carry: 161, total: 167 },
  { club: "8-iron", carry: 148, total: 153 },
  { club: "9-iron", carry: 135, total: 139 },
  { club: "PW", carry: 121, total: 124 },
  { club: "GW (52°)", carry: 102, total: 104 },
  { club: "SW (56°)", carry: 84, total: 86 },
  { club: "LW (60°)", carry: 64, total: 66 },
];

const RECENT = [
  { id: "r1", date: "Oct 13", course: "Spanish Bay", score: 82, diff: "+5.2", tag: "T1" },
  { id: "r2", date: "Oct 12", course: "Spyglass Hill", score: 84, diff: "+6.4", tag: null },
  { id: "r3", date: "Oct 11", course: "Pebble Beach", score: 77, diff: "+1.8", tag: "PR" },
  { id: "r4", date: "Sep 28", course: "Presidio", score: 82, diff: "+4.6", tag: null },
  { id: "r5", date: "Sep 14", course: "Harding Park", score: 86, diff: "+8.1", tag: null },
];

export default function ProfilePage() {
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
        {/* Masthead */}
        <div style={{ padding: "46px 22px 18px", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Link
              href="/"
              style={{
                textDecoration: "none",
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
                <path
                  d="M8 2 L3 6 L8 10"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Home
            </Link>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                fontWeight: 500,
              }}
            >
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

            {/* Stamp card */}
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
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 36,
                  color: T.ink,
                  letterSpacing: -1.5,
                  lineHeight: 1,
                }}
              >
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

        {/* Handicap hero */}
        <PPSection kicker="Handicap index" title="Trending down, quietly.">
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 72,
                letterSpacing: -2.4,
                color: T.ink,
                lineHeight: 0.9,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {HANDICAP.index}
            </div>
            <div style={{ flex: 1, paddingBottom: 8 }}>
              <BigSpark data={HANDICAP.history} accent={accent} />
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: accent,
                  textTransform: "uppercase",
                  fontWeight: 500,
                  marginTop: 4,
                }}
              >
                ↓ {Math.abs(HANDICAP.trend90).toFixed(1)} · last 90 days
              </div>
            </div>
          </div>
        </PPSection>

        {/* Strokes gained */}
        <PPSection kicker="Strokes gained" title="Where the shots live.">
          <div>
            {SG.map((s, i) => {
              const pos = s.you >= 0;
              return (
                <div
                  key={s.cat}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 12,
                    padding: "10px 0",
                    borderTop: i === 0 ? `1px solid ${T.hairline}` : `1px dashed ${T.hairline}`,
                  }}
                >
                  <div>
                    <div style={{ fontFamily: T.serif, fontSize: 16, color: T.ink, letterSpacing: -0.2 }}>{s.cat}</div>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 12.5,
                        color: T.pencil,
                        letterSpacing: -0.1,
                        marginTop: 1,
                      }}
                    >
                      {s.label}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontSize: 22,
                        color: pos ? accent : T.pencil,
                        fontVariantNumeric: "tabular-nums",
                        lineHeight: 1,
                      }}
                    >
                      {pos ? "+" : ""}
                      {s.you.toFixed(1)}
                    </div>
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 8,
                        letterSpacing: 1.1,
                        color: T.pencilSoft,
                        textTransform: "uppercase",
                        marginTop: 2,
                      }}
                    >
                      vs 10 hcp
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </PPSection>

        {/* The bag */}
        <PPSection kicker="The bag" title="Club distances, honest.">
          <div>
            {BAG.map((c, i) => {
              const pct = (c.carry / 280) * 100;
              return (
                <div
                  key={c.club}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "72px 1fr 60px",
                    gap: 10,
                    padding: "8px 0",
                    alignItems: "center",
                    borderTop: i === 0 ? `1px solid ${T.hairline}` : `1px dashed ${T.hairline}`,
                  }}
                >
                  <div style={{ fontFamily: T.serif, fontSize: 15, color: T.ink, letterSpacing: -0.2 }}>{c.club}</div>
                  <div style={{ position: "relative", height: 6, background: T.paperDeep, borderRadius: 99, overflow: "hidden" }}>
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${pct}%`,
                        background: accent,
                        borderRadius: 99,
                      }}
                    />
                  </div>
                  <div
                    style={{
                      textAlign: "right",
                      fontFamily: T.serif,
                      fontSize: 15,
                      color: T.ink,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {c.carry}
                    <span style={{ fontFamily: T.mono, fontSize: 9, color: T.pencilSoft, letterSpacing: 1, marginLeft: 3 }}>Y</span>
                  </div>
                </div>
              );
            })}
          </div>
        </PPSection>

        {/* Recent rounds */}
        <PPSection kicker="Recent rounds" title="The pages behind you.">
          <div>
            {RECENT.map((r, i) => (
              <div
                key={r.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "48px 1fr auto",
                  gap: 12,
                  padding: "10px 0",
                  alignItems: "center",
                  borderTop: i === 0 ? `1px solid ${T.hairline}` : `1px dashed ${T.hairline}`,
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 8,
                      letterSpacing: 1.2,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                    }}
                  >
                    {r.date.split(" ")[0]}
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 22,
                      color: T.ink,
                      lineHeight: 1,
                      letterSpacing: -0.4,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {r.date.split(" ")[1]}
                  </div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ fontFamily: T.serif, fontSize: 16, color: T.ink, letterSpacing: -0.2 }}>{r.course}</div>
                    {r.tag && (
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8,
                          letterSpacing: 1,
                          color: accent,
                          textTransform: "uppercase",
                          border: `1px solid ${accent}`,
                          padding: "1px 4px",
                          borderRadius: 3,
                        }}
                      >
                        {r.tag}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 9,
                      letterSpacing: 1.2,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                      marginTop: 2,
                    }}
                  >
                    {r.diff} to par
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 26,
                      color: T.ink,
                      lineHeight: 1,
                      letterSpacing: -0.6,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {r.score}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </PPSection>

        <div style={{ padding: "24px 22px 36px", textAlign: "center" }}>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 8.5,
              letterSpacing: 1.8,
              color: T.pencilSoft,
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            Stored locally · on this device
          </div>
        </div>
      </div>
    </div>
  );
}

function PPSection({ kicker, title, children }: { kicker: string; title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: "22px 22px 18px", borderTop: `1px solid ${T.hairline}`, position: "relative" }}>
      <div style={{ marginBottom: 12 }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.6,
            color: T.pencil,
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          {kicker}
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 22,
            color: T.ink,
            letterSpacing: -0.4,
            lineHeight: 1,
            marginTop: 3,
          }}
        >
          {title}
        </div>
      </div>
      {children}
    </section>
  );
}

function BigSpark({ data, accent }: { data: number[]; accent: string }) {
  const w = 220;
  const h = 48;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / (max - min || 1)) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const lastY = h - ((data[data.length - 1] - min) / (max - min || 1)) * h;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      <polyline
        points={pts}
        fill="none"
        stroke={accent}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={w} cy={lastY} r="3" fill={accent} />
      <circle cx={w} cy={lastY} r="6" fill="none" stroke={accent} strokeWidth="0.6" opacity="0.5" />
    </svg>
  );
}
