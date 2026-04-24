"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import { initializeStorage, getRounds } from "@/lib/storage";

type Recent = { id: string; date: string; course: string; score: number; par: number; net: string; hole: number; note: string; tag: string | null };

const SAMPLE_RECENT: Recent[] = [
  { id: "r1", date: "Oct 13", course: "Spanish Bay", score: 82, par: 72, net: "+4", hole: 18, note: "Closed out Sunday Cup VII", tag: "T1" },
  { id: "r2", date: "Oct 12", course: "Spyglass Hill", score: 84, par: 72, net: "+6", hole: 18, note: "Hole-out from 148 on 14", tag: null },
  { id: "r3", date: "Oct 11", course: "Pebble Beach", score: 77, par: 72, net: "+1", hole: 18, note: "Best round in three years", tag: "★" },
  { id: "r4", date: "Sep 28", course: "Presidio", score: 41, par: 36, net: "+5", hole: 9, note: "Quick 9 w/ Jack", tag: null },
  { id: "r5", date: "Sep 14", course: "Harding Park", score: 86, par: 72, net: "+14", hole: 18, note: "Windy; snowman on 7", tag: null },
];

const STATS = { handicap: 8.2, trend: -0.6, scoring: 82.3, fairways: 62, gir: 48, putts: 31.2 };
const HDCP = [10.1, 10.0, 9.8, 9.6, 9.8, 9.4, 9.2, 9.0, 8.8, 9.0, 8.6, 8.2];

const FEED = [
  { who: "Jack", what: "shot 74 at Olympic Club", when: "2h" },
  { who: "Sam", what: "broke 80 for the first time", when: "yesterday" },
  { who: "Justin", what: "booked Bandon for February", when: "2d" },
];

export default function HomePage() {
  const accent = DEFAULT_ACCENT;
  const router = useRouter();
  const [mostRecentLiveId, setMostRecentLiveId] = useState<string | null>(null);

  useEffect(() => {
    initializeStorage();
    const rs = getRounds();
    const live = rs.find((r) => r.status === "active");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (live) setMostRecentLiveId(live.id);
  }, []);

  const now = new Date();
  const hr = now.getHours();
  const timeOfDay = hr < 11 ? "Morning" : hr < 17 ? "Afternoon" : "Evening";

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
        {/* ── MASTHEAD ─────────────────────────────── */}
        <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 14px", position: "relative" }}>
          {/* Profile № card */}
          <Link
            href="/profile"
            aria-label="Open your profile"
            style={{
              position: "absolute",
              top: 14,
              right: 22,
              width: 44,
              height: 56,
              padding: 0,
              background: T.paperDeep,
              border: `1.5px solid ${T.ink}`,
              borderRadius: 2,
              cursor: "pointer",
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 1px 0 rgba(0,0,0,0.04)",
              textDecoration: "none",
            }}
          >
            <span style={{ position: "absolute", top: 2, left: 2, right: 2, height: 1, background: accent }} />
            <span style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 24, color: T.ink, letterSpacing: -1, lineHeight: 1 }}>77</span>
            <span
              style={{
                position: "absolute",
                bottom: 2,
                left: 0,
                right: 0,
                textAlign: "center",
                fontFamily: T.mono,
                fontSize: 5,
                letterSpacing: 1.3,
                color: T.pencil,
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              My card
            </span>
          </Link>

          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.6,
              color: T.pencil,
              textTransform: "uppercase",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: 99, background: accent }} />
            <span>San Francisco</span>
          </div>
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 36,
              letterSpacing: -0.8,
              color: T.ink,
              lineHeight: 1,
              marginTop: 8,
            }}
          >
            {timeOfDay}.
          </div>
          <div
            style={{
              fontFamily: T.serif,
              fontSize: 17,
              letterSpacing: -0.2,
              color: T.pencil,
              marginTop: 4,
              lineHeight: 1.3,
            }}
          >
            66°F, wind WNW 8. Presidio tee times open from 10:40.
          </div>
        </div>

        {/* ── PRIMARY CTA BLOCK ───────────────────── */}
        <div style={{ padding: "10px 22px 18px" }}>
          <button
            onClick={() => router.push("/round/new")}
            style={{
              width: "100%",
              padding: "18px 18px",
              borderRadius: 16,
              border: "none",
              background: T.ink,
              color: T.paper,
              textAlign: "left",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div style={{ position: "relative", flexShrink: 0 }}>
              <motion.span
                animate={{ scale: [1, 1.3, 1], opacity: [0.4, 0.1, 0.4] }}
                transition={{ duration: 2, repeat: Infinity }}
                style={{ position: "absolute", inset: -5, borderRadius: 99, background: accent }}
              />
              <div
                style={{
                  position: "relative",
                  width: 42,
                  height: 42,
                  borderRadius: 99,
                  background: accent,
                  color: T.paper,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0" />
                  <path d="M12 18v3" />
                </svg>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: "rgba(244,241,234,0.5)", textTransform: "uppercase" }}>
                Hey caddy
              </div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.paper, letterSpacing: -0.4, lineHeight: 1.1, marginTop: 2 }}>
                Start a round, call a shot
              </div>
            </div>
            <svg width="12" height="12" viewBox="0 0 12 12" style={{ color: "rgba(244,241,234,0.4)" }}>
              <path d="M3 2 L8 6 L3 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* Secondary row */}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <QuickAction icon="round" label="New round" sub="Solo or with friends" onClick={() => router.push("/round/new")} />
            <QuickAction
              icon="tournament"
              label="Tournament"
              sub="Multi-round"
              accent={accent}
              onClick={() => router.push("/tournament/sunday-cup-2024")}
            />
          </div>

          {/* Dispatch looper */}
          <button
            onClick={() => router.push("/tee-time")}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "12px 14px",
              borderRadius: 12,
              border: `1.5px solid ${T.ink}`,
              background: T.paper,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              textAlign: "left",
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 99,
                background: T.ink,
                color: T.paper,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 18,
                letterSpacing: -0.3,
                flexShrink: 0,
              }}
            >
              L
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
                Dispatch looper
              </div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 16, color: T.ink, letterSpacing: -0.2, lineHeight: 1.1, marginTop: 2 }}>
                Find me a tee time this weekend
              </div>
            </div>
            <svg width="10" height="10" viewBox="0 0 12 12" style={{ color: T.pencil, flexShrink: 0 }}>
              <path d="M3 2 L8 6 L3 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {mostRecentLiveId && (
            <Link
              href={`/round/${mostRecentLiveId}`}
              style={{
                marginTop: 8,
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 14px",
                borderRadius: 12,
                border: `1px dashed ${accent}`,
                background: `${accent}11`,
                color: T.ink,
                textDecoration: "none",
              }}
            >
              <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: accent, textTransform: "uppercase" }}>Resume</span>
              <span style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15, color: T.ink, letterSpacing: -0.2 }}>your round in progress</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: T.mono, fontSize: 9, color: T.pencil }}>→</span>
            </Link>
          )}
        </div>

        {/* ── STATS AT A GLANCE ───────────────────── */}
        <div
          style={{
            padding: "12px 22px 16px",
            borderTop: `1px solid ${T.hairline}`,
            borderBottom: `1px solid ${T.hairline}`,
            background: T.paperDeep,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase" }}>Your card</div>
            <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft }}>last 12 rounds</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "flex-end" }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>Handicap index</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <div style={{ fontFamily: T.serif, fontSize: 44, letterSpacing: -1.2, color: T.ink, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{STATS.handicap}</div>
                <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.1, color: accent }}>↓ {Math.abs(STATS.trend).toFixed(1)}</div>
              </div>
              <Sparkline data={HDCP} accent={accent} />
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>Scoring avg</div>
              <div style={{ fontFamily: T.serif, fontSize: 44, letterSpacing: -1.2, color: T.ink, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{STATS.scoring}</div>
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, marginTop: 2 }}>+10.3 to par</div>
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              padding: "10px 0 2px",
              borderTop: `1px dashed ${T.hairline}`,
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 8,
            }}
          >
            <StatBit label="Fairways" value={`${STATS.fairways}%`} />
            <StatBit label="Greens" value={`${STATS.gir}%`} />
            <StatBit label="Putts / rd" value={String(STATS.putts)} />
          </div>
        </div>

        {/* ── RECENT ROUNDS ──────────────────────── */}
        <div style={{ padding: "20px 22px 10px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase" }}>Recent rounds</div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.4, lineHeight: 1, marginTop: 2 }}>
                The pages behind you
              </div>
            </div>
            <button
              style={{
                padding: "5px 10px",
                borderRadius: 99,
                border: `1px solid ${T.hairline}`,
                background: "transparent",
                cursor: "pointer",
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.2,
                color: T.ink,
                textTransform: "uppercase",
              }}
            >
              All
            </button>
          </div>

          <div>
            {SAMPLE_RECENT.map((r, i) => (
              <button
                key={r.id}
                style={{
                  width: "100%",
                  display: "grid",
                  gridTemplateColumns: "48px 1fr auto",
                  gap: 12,
                  padding: "12px 0",
                  alignItems: "center",
                  textAlign: "left",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                }}
              >
                <div>
                  <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>
                    {r.date.split(" ")[0]}
                  </div>
                  <div style={{ fontFamily: T.serif, fontSize: 22, color: T.ink, lineHeight: 1, letterSpacing: -0.4, fontVariantNumeric: "tabular-nums" }}>
                    {r.date.split(" ")[1]}
                  </div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ fontFamily: T.serif, fontSize: 16, letterSpacing: -0.2, color: T.ink }}>{r.course}</div>
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
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 13,
                      color: T.pencil,
                      letterSpacing: -0.1,
                      marginTop: 1,
                      lineHeight: 1.25,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {r.note}{" "}
                    <span style={{ color: T.pencilSoft, fontStyle: "normal", fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.1 }}>· {r.hole}H</span>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: T.serif, fontSize: 26, color: T.ink, lineHeight: 1, letterSpacing: -0.6, fontVariantNumeric: "tabular-nums" }}>
                    {r.score}
                  </div>
                  <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.1, color: T.pencilSoft, marginTop: 1 }}>{r.net}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── TROPHY CASE TEASE ───────────────────── */}
        <div
          onClick={() => router.push("/tournament/sunday-cup-2024")}
          style={{
            margin: "14px 22px",
            padding: "14px 16px",
            background: T.ink,
            color: T.paper,
            borderRadius: 14,
            position: "relative",
            overflow: "hidden",
            cursor: "pointer",
          }}
        >
          <div
            style={{
              position: "absolute",
              right: -10,
              top: -20,
              bottom: -10,
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 120,
              lineHeight: 1,
              color: "rgba(244,241,234,0.04)",
              letterSpacing: -6,
              pointerEvents: "none",
              userSelect: "none",
            }}
          >
            VII
          </div>
          <div style={{ position: "relative" }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: "rgba(244,241,234,0.55)", textTransform: "uppercase" }}>Trophy case</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 18, letterSpacing: -0.3, lineHeight: 1.2, marginTop: 2 }}>
              3× Sunday Cup champion — defending this October.
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              {["22", "23", "24"].map((y) => (
                <div
                  key={y}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 99,
                    border: `1px solid rgba(244,241,234,0.25)`,
                    background: "rgba(244,241,234,0.06)",
                    fontFamily: T.mono,
                    fontSize: 8.5,
                    letterSpacing: 1.2,
                    color: T.paper,
                    textTransform: "uppercase",
                  }}
                >
                  &rsquo;{y} · won
                </div>
              ))}
              <div
                style={{
                  padding: "3px 8px",
                  borderRadius: 99,
                  border: `1px dashed ${accent}`,
                  background: `${accent}22`,
                  color: accent,
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1.2,
                  textTransform: "uppercase",
                }}
              >
                Vol VIII · Oct
              </div>
            </div>
          </div>
        </div>

        {/* ── FROM THE GROUP ──────────────────────── */}
        <div style={{ padding: "16px 22px 28px" }}>
          <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase" }}>From the group</div>
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 20, color: T.ink, letterSpacing: -0.4, lineHeight: 1.1, marginTop: 2 }}>
            Elsewhere, this week
          </div>
          <div style={{ marginTop: 10 }}>
            {FEED.map((f, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  borderTop: i === 0 ? `1px solid ${T.hairline}` : `1px dashed ${T.hairline}`,
                }}
              >
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 99,
                    background: T.ink,
                    color: T.paper,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 12,
                  }}
                >
                  {f.who[0]}
                </div>
                <div style={{ flex: 1, fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1, lineHeight: 1.3 }}>
                  <span style={{ fontWeight: 500, fontFamily: T.sans, fontSize: 13 }}>{f.who}</span>{" "}
                  <span style={{ color: T.pencil }}>{f.what}</span>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>{f.when}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickAction({ icon, label, sub, accent, onClick }: { icon: "round" | "tournament"; label: string; sub: string; accent?: string; onClick?: () => void }) {
  const isTournament = icon === "tournament";
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "12px 12px",
        borderRadius: 12,
        cursor: "pointer",
        textAlign: "left",
        border: `1px solid ${T.hairline}`,
        background: T.paper,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            background: isTournament ? accent : "transparent",
            color: isTournament ? T.paper : T.ink,
            border: isTournament ? "none" : `1px solid ${T.hairline}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {isTournament ? (
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M3 2h6v3a3 3 0 0 1-6 0V2zM4 8h4v2H4z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="6" cy="6" r="4" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
            </svg>
          )}
        </div>
        <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, letterSpacing: -0.1, color: T.ink }}>{label}</div>
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.1, color: T.pencilSoft, textTransform: "uppercase" }}>{sub}</div>
    </button>
  );
}

function StatBit({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: T.serif, fontSize: 18, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1, letterSpacing: -0.2, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Sparkline({ data, accent }: { data: number[]; accent: string }) {
  const w = 120;
  const h = 26;
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
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ marginTop: 4 }}>
      <polyline points={pts} fill="none" stroke={accent} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w} cy={lastY} r="2.5" fill={accent} />
    </svg>
  );
}
