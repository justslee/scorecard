"use client";

import { useEffect, useState, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";

type Phase = "prefs" | "searching" | "confirmed";

type Window = { id: string; label: string; sub: string; start: string; end: string; selected: boolean };
type Course = { id: string; name: string; muni: string; distance: number; favorite: boolean; selected: boolean };
type LogState = "ok" | "pending" | "miss" | "win";
type LogLine = { t: string; text: string; state: LogState; course: string };

const TT_WINDOWS_INIT: Window[] = [
  { id: "sat-am", label: "Saturday", sub: "early", start: "06:30", end: "09:30", selected: true },
  { id: "sat-pm", label: "Saturday", sub: "midday", start: "11:00", end: "14:00", selected: false },
  { id: "sun-am", label: "Sunday", sub: "early", start: "07:00", end: "10:00", selected: true },
];

const TT_COURSES_INIT: Course[] = [
  { id: "presidio", name: "Presidio", muni: "SF", distance: 4.1, favorite: true, selected: true },
  { id: "harding", name: "Harding Park", muni: "SF", distance: 6.8, favorite: true, selected: true },
  { id: "lincoln", name: "Lincoln Park", muni: "SF", distance: 5.2, favorite: true, selected: true },
  { id: "sharp", name: "Sharp Park", muni: "Pacifica", distance: 12.4, favorite: false, selected: false },
  { id: "crystal", name: "Crystal Springs", muni: "San Bruno", distance: 16.7, favorite: false, selected: false },
  { id: "poplar", name: "Poplar Creek", muni: "San Mateo", distance: 19.2, favorite: false, selected: false },
];

const TT_GROUP = [
  { id: "jack", name: "Jack H.", hdcp: 11.4, init: "JH", confirmed: true, self: false },
  { id: "sonja", name: "Sonja L.", hdcp: 14.8, init: "SL", confirmed: true, self: false },
  { id: "me", name: "You", hdcp: 8.2, init: "JL", confirmed: true, self: true },
];

const TT_LOG: LogLine[] = [
  { t: "06:02", text: "Checking Presidio 7:10 \u2026 three open.", state: "ok", course: "Presidio" },
  { t: "06:02", text: "Held \u2014 awaiting window.", state: "pending", course: "Presidio" },
  { t: "06:03", text: "Harding 7:40 released. Two slots. Passed (need 3).", state: "miss", course: "Harding Park" },
  { t: "06:04", text: "Lincoln 8:18 \u2014 three-ball open. Comparing.", state: "ok", course: "Lincoln Park" },
  { t: "06:04", text: "Presidio confirmed \u2014 three at 7:10 Saturday.", state: "win", course: "Presidio" },
];

const TT_CONFIRMED = {
  course: "Presidio Golf Course",
  muni: "San Francisco, CA",
  date: "Saturday, Oct 18",
  time: "7:10 AM",
  tee: "Regular · 6,180 yd",
  group: 3,
  price: "$86 · walking",
  conf: "PGF-7R41-0A",
  weather: { temp: 58, wind: "WNW 6", cond: "Fog burning off by 9" },
  eta: "24 min",
};

export default function TeeTimePage() {
  const router = useRouter();
  const accent = DEFAULT_ACCENT;
  const [phase, setPhase] = useState<Phase>("prefs");

  if (phase === "prefs") return <Prefs accent={accent} onBack={() => router.push("/")} onDispatch={() => setPhase("searching")} />;
  if (phase === "searching") return <Searching accent={accent} onBack={() => setPhase("prefs")} onFound={() => setPhase("confirmed")} />;
  return <Confirmed accent={accent} onBack={() => router.push("/")} onStart={() => router.push("/")} />;
}

/* ─────────────────────────────────────────────
   PREFS
   ───────────────────────────────────────────── */

function Prefs({ accent, onBack, onDispatch }: { accent: string; onBack: () => void; onDispatch: () => void }) {
  const [windows, setWindows] = useState(TT_WINDOWS_INIT);
  const [courses, setCourses] = useState(TT_COURSES_INIT);
  const [maxMiles, setMaxMiles] = useState(15);

  const toggleWin = (id: string) => setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, selected: !w.selected } : w)));
  const toggleCourse = (id: string) => setCourses((cs) => cs.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)));

  const selectedCount = courses.filter((c) => c.selected).length;
  const winCount = windows.filter((w) => w.selected).length;

  return (
    <PaperShell>
      <TTMasthead accent={accent} onBack={onBack} kicker="Dispatch" title="Find me a tee time" />

      <div style={{ padding: "0 22px 16px" }}>
        <Transcript accent={accent} lines={[{ who: "looper", text: "What do you have in mind for this weekend? I'll rustle one up." }]} />
        <button
          style={{
            marginTop: 10,
            width: "100%",
            padding: "12px 14px",
            borderRadius: 12,
            border: `1.5px solid ${T.ink}`,
            background: T.paper,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 1.4,
            color: T.ink,
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <path d="M12 18v3" />
          </svg>
          Hold to talk
          <span style={{ flex: 1 }} />
          <span style={{ color: T.pencilSoft }}>or fill it in below</span>
        </button>
      </div>

      <Section kicker="When" title="Windows" aside={<Kicker>{winCount} selected</Kicker>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {windows.map((w) => (
            <WindowChip key={w.id} win={w} accent={accent} onToggle={() => toggleWin(w.id)} />
          ))}
          <button
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px dashed ${T.hairline}`,
              background: "transparent",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.3,
              color: T.pencilSoft,
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            + Add another window
          </button>
        </div>
      </Section>

      <Section kicker="Who" title="The group" aside={<Kicker>{TT_GROUP.length} playing</Kicker>}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {TT_GROUP.map((p) => (
            <GroupChip key={p.id} p={p} accent={accent} />
          ))}
          <button
            style={{
              padding: "6px 12px",
              borderRadius: 99,
              border: `1px dashed ${T.hairline}`,
              background: "transparent",
              cursor: "pointer",
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.3,
              color: T.pencil,
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            + Invite
          </button>
        </div>
      </Section>

      <Section kicker="Where" title="Courses" aside={<Kicker>{selectedCount} of {courses.length}</Kicker>}>
        {/* Radius slider */}
        <div style={{ padding: "6px 2px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
              Max drive
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15, color: T.ink, letterSpacing: -0.2, fontVariantNumeric: "tabular-nums" }}>
              {maxMiles} <span style={{ fontSize: 10, color: T.pencil }}>mi</span>
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={30}
            value={maxMiles}
            onChange={(e) => setMaxMiles(parseInt(e.target.value))}
            style={{ width: "100%", accentColor: T.ink }}
          />
        </div>

        <div>
          <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500, marginBottom: 4 }}>
            Your favorites
          </div>
          {courses.filter((c) => c.favorite).map((c, i) => (
            <CourseRow key={c.id} c={c} accent={accent} onToggle={() => toggleCourse(c.id)} first={i === 0} />
          ))}

          <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500, marginTop: 14, marginBottom: 4 }}>
            Open to
          </div>
          {courses.filter((c) => !c.favorite).map((c, i) => (
            <CourseRow key={c.id} c={c} accent={accent} onToggle={() => toggleCourse(c.id)} first={i === 0} />
          ))}
        </div>
      </Section>

      <div style={{ padding: "20px 22px 28px" }}>
        <button
          onClick={onDispatch}
          style={{
            width: "100%",
            padding: "16px 18px",
            borderRadius: 16,
            border: "none",
            background: T.ink,
            color: T.paper,
            cursor: "pointer",
            textAlign: "left",
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 99,
              background: accent,
              color: T.paper,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 20,
              letterSpacing: -0.5,
            }}
          >
            L
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: "rgba(244,241,234,0.5)", textTransform: "uppercase" }}>
              Dispatch looper
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 20, color: T.paper, letterSpacing: -0.3, lineHeight: 1.1, marginTop: 2 }}>
              Go find us one
            </div>
          </div>
          <svg width="12" height="12" viewBox="0 0 12 12" style={{ color: "rgba(244,241,234,0.4)" }}>
            <path d="M3 2 L8 6 L3 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div
          style={{
            marginTop: 10,
            fontFamily: T.serif,
            fontSize: 13,
            color: T.pencil,
            fontStyle: "italic",
            textAlign: "center",
            letterSpacing: -0.1,
          }}
        >
          Takes a minute or two. I&rsquo;ll ping you the moment I&rsquo;ve got one.
        </div>
      </div>
    </PaperShell>
  );
}

/* ─────────────────────────────────────────────
   SEARCHING
   ───────────────────────────────────────────── */

function Searching({ accent, onBack, onFound }: { accent: string; onBack: () => void; onFound: () => void }) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [logIdx, setLogIdx] = useState(2);

  useEffect(() => {
    const iv = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const iv = setInterval(() => setLogIdx((i) => Math.min(TT_LOG.length, i + 1)), 2800);
    return () => clearInterval(iv);
  }, []);

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  const shownLog = TT_LOG.slice(0, logIdx);

  return (
    <PaperShell>
      <TTMasthead accent={accent} onBack={onBack} kicker="In flight" title="Looper is working" />

      <div style={{ padding: "0 22px 16px" }}>
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            background: T.ink,
            color: T.paper,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ position: "relative" }}>
            <motion.span
              animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
              transition={{ duration: 1.6, repeat: Infinity }}
              style={{ position: "absolute", inset: -4, borderRadius: 99, background: accent }}
            />
            <span style={{ position: "relative", display: "block", width: 10, height: 10, borderRadius: 99, background: accent }} />
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 8.5,
                letterSpacing: 1.4,
                color: "rgba(244,241,234,0.55)",
                textTransform: "uppercase",
                fontWeight: 500,
              }}
            >
              Dispatched · Saturday
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 17, color: T.paper, letterSpacing: -0.2, lineHeight: 1.1, marginTop: 2 }}>
              3 courses · window 6:30–9:30
            </div>
          </div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 14,
              letterSpacing: 1.2,
              color: T.paper,
              fontVariantNumeric: "tabular-nums",
              fontWeight: 500,
            }}
          >
            {mm}:{ss}
          </div>
        </div>
      </div>

      <div style={{ padding: "4px 22px 10px" }}>
        <Radar accent={accent} />
      </div>

      <Section kicker="Live log" title="Dispatches" aside={<Kicker>· auto</Kicker>}>
        <div>
          {shownLog.map((l, i) => (
            <LogRow key={i} line={l} accent={accent} first={i === 0} />
          ))}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "40px 14px 1fr",
              gap: 10,
              padding: "8px 0",
              alignItems: "center",
              borderTop: `1px dashed ${T.hairlineSoft}`,
            }}
          >
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase" }}>
              — —
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  animate={{ opacity: [0.2, 1, 0.2] }}
                  transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15 }}
                  style={{ width: 2, height: 2, borderRadius: 99, background: T.pencil, display: "inline-block" }}
                />
              ))}
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.pencil, letterSpacing: -0.1 }}>
              Still working&hellip;
            </div>
          </div>
        </div>
      </Section>

      <Section kicker="Brief" title="What I told the looper">
        <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 8, rowGap: 10 }}>
          {[
            ["When", "Sat 6:30–9:30, Sun 7:00–10:00"],
            ["Who", "3 · you, Jack, Sonja"],
            ["Where", "Presidio · Harding · Lincoln"],
            ["Radius", "Under 15 miles"],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.4,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                  fontWeight: 500,
                  paddingTop: 2,
                }}
              >
                {k}
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1, lineHeight: 1.3 }}>{v}</div>
            </div>
          ))}
        </div>
      </Section>

      <div style={{ padding: "18px 22px 30px" }}>
        <button
          onClick={onFound}
          style={{
            width: "100%",
            padding: "12px 14px",
            borderRadius: 12,
            border: `1.5px solid ${T.ink}`,
            background: "transparent",
            cursor: "pointer",
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 1.5,
            color: T.ink,
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Preview: found one {"\u2192"}
        </button>
        <div style={{ marginTop: 10, textAlign: "center", fontFamily: T.serif, fontSize: 13, fontStyle: "italic", color: T.pencil, letterSpacing: -0.1 }}>
          Keep walking. I&rsquo;ll buzz you.
        </div>
      </div>
    </PaperShell>
  );
}

/* ─────────────────────────────────────────────
   CONFIRMED
   ───────────────────────────────────────────── */

function Confirmed({ accent, onBack, onStart }: { accent: string; onBack: () => void; onStart: () => void }) {
  const c = TT_CONFIRMED;
  return (
    <PaperShell>
      <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 12px", position: "relative" }}>
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
          <Kicker>Looper · confirmed</Kicker>
        </div>

        {/* Stamp */}
        <motion.div
          initial={{ rotate: -4, scale: 0.9, opacity: 0 }}
          animate={{ rotate: -3, scale: 1, opacity: 0.96 }}
          transition={{ duration: 0.6, ease: T.ease, delay: 0.2 }}
          style={{
            position: "absolute",
            top: 34,
            right: 22,
            width: 90,
            height: 90,
            borderRadius: 99,
            border: `2.5px solid ${accent}`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            color: accent,
            pointerEvents: "none",
          }}
        >
          <div style={{ fontFamily: T.mono, fontSize: 7.5, letterSpacing: 1.8, textTransform: "uppercase", fontWeight: 700 }}>Dispatched</div>
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, letterSpacing: -0.4, lineHeight: 1, marginTop: 2 }}>Booked</div>
          <div style={{ fontFamily: T.mono, fontSize: 7, letterSpacing: 1.3, textTransform: "uppercase", marginTop: 2, opacity: 0.8 }}>
            {c.conf}
          </div>
        </motion.div>

        <div style={{ marginTop: 22 }}>
          <Kicker>{c.date}</Kicker>
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 42, color: T.ink, letterSpacing: -1.2, lineHeight: 1, marginTop: 4 }}>
            {c.course}
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 14, color: T.pencil, fontStyle: "italic", marginTop: 6, letterSpacing: -0.1 }}>
            {c.muni} · {c.tee}
          </div>
        </div>
      </div>

      <div style={{ padding: "8px 22px 16px" }}>
        <div style={{ padding: "18px 20px", borderRadius: 14, background: T.ink, color: T.paper, position: "relative", overflow: "hidden" }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 6,
              background: `repeating-linear-gradient(to bottom, ${accent} 0, ${accent} 3px, transparent 3px, transparent 7px)`,
            }}
          />
          <div style={{ paddingLeft: 10 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: "rgba(244,241,234,0.55)", textTransform: "uppercase", fontWeight: 500 }}>
              Tee off
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 68,
                letterSpacing: -2.2,
                color: T.paper,
                lineHeight: 0.95,
                marginTop: 4,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {c.time}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 4,
                marginTop: 14,
                paddingTop: 12,
                borderTop: `1px dashed rgba(244,241,234,0.2)`,
              }}
            >
              {[["ETA", c.eta], ["Group", `${c.group} players`], ["Price", c.price.split(" · ")[0]]].map(([k, v], i) => (
                <div key={k} style={{ paddingLeft: i === 0 ? 0 : 10, borderLeft: i === 0 ? "none" : `1px dashed rgba(244,241,234,0.18)` }}>
                  <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: "rgba(244,241,234,0.5)", textTransform: "uppercase", fontWeight: 500 }}>
                    {k}
                  </div>
                  <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 17, color: T.paper, letterSpacing: -0.3, marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: "0 22px 14px" }}>
        <Transcript accent={accent} lines={[{ who: "looper", text: "Got one. 7:10 at Presidio, three of you walking. Fog should burn off by the 2nd tee." }]} />
      </div>

      <Section kicker="Conditions" title="Saturday forecast" aside={<Kicker>7:10 AM</Kicker>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", borderTop: `1px dashed ${T.hairline}`, borderBottom: `1px dashed ${T.hairline}` }}>
          {[["Temp", `${c.weather.temp}°`], ["Wind", c.weather.wind], ["Sky", "Fog→Sun"]].map(([k, v], i) => (
            <div key={k} style={{ padding: "10px 12px", borderLeft: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}` }}>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>{k}</div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 19,
                  color: T.ink,
                  letterSpacing: -0.3,
                  lineHeight: 1.1,
                  marginTop: 2,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, fontFamily: T.serif, fontSize: 13, color: T.pencil, fontStyle: "italic", letterSpacing: -0.05 }}>{c.weather.cond}.</div>
      </Section>

      <Section kicker="The group" title="Three balls">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {TT_GROUP.map((p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "32px 1fr auto", gap: 12, alignItems: "center", padding: "8px 0" }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 99,
                  background: p.self ? accent : T.paperDeep,
                  color: p.self ? T.paper : T.ink,
                  border: p.self ? "none" : `1px solid ${T.hairline}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: T.mono,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                }}
              >
                {p.init}
              </div>
              <div>
                <div style={{ fontFamily: T.serif, fontStyle: p.self ? "italic" : "normal", fontSize: 15, color: T.ink, letterSpacing: -0.15, lineHeight: 1.1 }}>
                  {p.name}
                </div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 8,
                    letterSpacing: 1.1,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                    fontWeight: 500,
                    marginTop: 2,
                  }}
                >
                  Confirmed · hdcp {p.hdcp}
                </div>
              </div>
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M2 5 L4 7 L8 3" stroke={accent} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          ))}
        </div>
      </Section>

      <div style={{ padding: "20px 22px 36px" }}>
        <button
          onClick={onStart}
          style={{
            width: "100%",
            padding: "14px 18px",
            borderRadius: 14,
            border: "none",
            background: accent,
            color: T.paper,
            cursor: "pointer",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 18,
            letterSpacing: -0.3,
          }}
        >
          Add to card · Set reminder
        </button>
      </div>
    </PaperShell>
  );
}

/* ─────────────────────────────────────────────
   Primitives
   ───────────────────────────────────────────── */

function PaperShell({ children }: { children: ReactNode }) {
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
      <div style={{ maxWidth: 420, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

function Kicker({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
      {children}
    </div>
  );
}

function Section({ kicker, title, aside, children }: { kicker: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ padding: "20px 22px 16px", borderTop: `1px solid ${T.hairline}`, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div>
          <Kicker>{kicker}</Kicker>
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.4, lineHeight: 1, marginTop: 3 }}>{title}</div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TTMasthead({ accent, onBack, kicker, title }: { accent: string; onBack: () => void; kicker: string; title: string }) {
  return (
    <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 14px", position: "relative" }}>
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
        <Kicker>Looper · dispatch</Kicker>
      </div>
      <div style={{ marginTop: 18 }}>
        <Kicker>{kicker}</Kicker>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 38, color: T.ink, letterSpacing: -1, lineHeight: 1, marginTop: 4 }}>{title}</div>
      </div>
    </div>
  );
}

function Transcript({ accent, lines }: { accent: string; lines: Array<{ who: "looper" | "you"; text: string }> }) {
  return (
    <div
      style={{
        padding: "14px 16px",
        borderRadius: 12,
        background: T.paperDeep,
        border: `1px solid ${T.hairline}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {lines.map((l, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "46px 1fr", gap: 10, alignItems: "baseline" }}>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 8,
              letterSpacing: 1.3,
              color: l.who === "looper" ? accent : T.pencilSoft,
              textTransform: "uppercase",
              fontWeight: 600,
              paddingTop: 2,
            }}
          >
            {l.who === "looper" ? "Looper" : "You"}
          </div>
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: l.who === "looper" ? "italic" : "normal",
              fontSize: 14.5,
              color: T.ink,
              letterSpacing: -0.1,
              lineHeight: 1.35,
            }}
          >
            {l.text}
          </div>
        </div>
      ))}
    </div>
  );
}

function WindowChip({ win, accent, onToggle }: { win: Window; accent: string; onToggle: () => void }) {
  const start = parseInt(win.start.slice(0, 2));
  const end = parseInt(win.end.slice(0, 2));
  return (
    <button
      onClick={onToggle}
      style={{
        textAlign: "left",
        padding: "10px 12px",
        borderRadius: 10,
        background: win.selected ? T.ink : T.paper,
        color: win.selected ? T.paper : T.ink,
        border: `1px solid ${win.selected ? T.ink : T.hairline}`,
        cursor: "pointer",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 16, letterSpacing: -0.2 }}>{win.label}</div>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 8.5,
            letterSpacing: 1.2,
            color: win.selected ? "rgba(244,241,234,0.6)" : T.pencilSoft,
            textTransform: "uppercase",
          }}
        >
          {win.sub}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 0.5, fontVariantNumeric: "tabular-nums", color: win.selected ? T.paper : T.ink }}>
          {win.start} → {win.end}
        </div>
      </div>
      <div style={{ position: "relative", height: 14, marginTop: 6 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 6, height: 1, background: win.selected ? "rgba(244,241,234,0.25)" : T.hairline }} />
        {[6, 9, 12, 15, 18, 21].map((h) => {
          const pct = ((h - 6) / 15) * 100;
          return (
            <div
              key={h}
              style={{
                position: "absolute",
                left: `${pct}%`,
                top: 2,
                width: 1,
                height: 9,
                background: win.selected ? "rgba(244,241,234,0.28)" : T.hairline,
              }}
            />
          );
        })}
        <div
          style={{
            position: "absolute",
            left: `${((start - 6) / 15) * 100}%`,
            width: `${((end - start) / 15) * 100}%`,
            top: 4,
            height: 5,
            borderRadius: 1,
            background: win.selected ? accent : T.ink,
          }}
        />
      </div>
    </button>
  );
}

function GroupChip({ p, accent }: { p: { id: string; name: string; hdcp: number; init: string; self: boolean }; accent: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px 6px 6px",
        borderRadius: 99,
        background: p.self ? `${accent}14` : T.paperDeep,
        border: `1px solid ${p.self ? accent : T.hairline}`,
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 99,
          background: p.self ? accent : T.paper,
          color: p.self ? T.paper : T.ink,
          border: p.self ? "none" : `1px solid ${T.hairline}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 0.3,
          fontWeight: 600,
        }}
      >
        {p.init}
      </div>
      <div>
        <div style={{ fontFamily: T.serif, fontStyle: p.self ? "italic" : "normal", fontSize: 13, color: T.ink, letterSpacing: -0.1, lineHeight: 1 }}>
          {p.name}
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 7.5, letterSpacing: 0.8, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500, marginTop: 1 }}>
          hdcp {p.hdcp}
        </div>
      </div>
    </div>
  );
}

function CourseRow({ c, accent, onToggle, first }: { c: Course; accent: string; onToggle: () => void; first: boolean }) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: "grid",
        gridTemplateColumns: "22px 1fr auto",
        gap: 10,
        alignItems: "center",
        padding: "10px 0",
        width: "100%",
        border: "none",
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
        borderTop: first ? "none" : `1px dashed ${T.hairlineSoft}`,
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: 3,
          border: `1.5px solid ${c.selected ? T.ink : T.hairline}`,
          background: c.selected ? T.ink : T.paper,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {c.selected && (
          <svg width="9" height="9" viewBox="0 0 10 10">
            <path d="M2 5 L4 7 L8 3" stroke={T.paper} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <div style={{ fontFamily: T.serif, fontStyle: c.favorite ? "italic" : "normal", fontSize: 15, color: T.ink, letterSpacing: -0.15, lineHeight: 1.1 }}>
          {c.name}
        </div>
        {c.favorite && (
          <svg width="9" height="9" viewBox="0 0 10 10" style={{ flexShrink: 0 }}>
            <path d="M5 1 L6.2 3.8 L9 4 L6.8 6 L7.5 9 L5 7.5 L2.5 9 L3.2 6 L1 4 L3.8 3.8 Z" fill={accent} />
          </svg>
        )}
      </div>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 8.5,
          letterSpacing: 1,
          color: T.pencilSoft,
          textTransform: "uppercase",
          fontVariantNumeric: "tabular-nums",
          fontWeight: 500,
        }}
      >
        {c.distance}mi · {c.muni}
      </div>
    </button>
  );
}

function Radar({ accent }: { accent: string }) {
  return (
    <div style={{ position: "relative", width: 200, height: 200, margin: "0 auto" }}>
      <svg width="200" height="200" viewBox="0 0 200 200">
        {[30, 55, 80].map((r) => (
          <circle key={r} cx="100" cy="100" r={r} fill="none" stroke={T.hairline} strokeWidth="0.7" strokeDasharray="2 3" />
        ))}
        <line x1="20" y1="100" x2="180" y2="100" stroke={T.hairline} strokeWidth="0.5" />
        <line x1="100" y1="20" x2="100" y2="180" stroke={T.hairline} strokeWidth="0.5" />

        <g>
          <circle cx="70" cy="72" r="3" fill={accent} />
          <text x="78" y="75" fontFamily={T.mono} fontSize="7" fill={T.pencil} letterSpacing="1">PRESIDIO</text>
        </g>
        <g>
          <circle cx="132" cy="60" r="3" fill={T.ink} />
          <text x="140" y="63" fontFamily={T.mono} fontSize="7" fill={T.pencil} letterSpacing="1">HARDING</text>
        </g>
        <g>
          <circle cx="58" cy="130" r="3" fill={T.ink} />
          <text x="8" y="133" fontFamily={T.mono} fontSize="7" fill={T.pencil} letterSpacing="1">LINCOLN</text>
        </g>

        <circle cx="100" cy="100" r="4" fill={T.ink} />
        <circle cx="100" cy="100" r="7" fill="none" stroke={T.ink} strokeWidth="0.6" />

        <defs>
          <linearGradient id="tt-sweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={accent} stopOpacity="0" />
            <stop offset="100%" stopColor={accent} stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <motion.g
          animate={{ rotate: 360 }}
          transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
          style={{ transformOrigin: "100px 100px" }}
        >
          <path d="M100,100 L100,20 A80,80 0 0,1 175,80 Z" fill="url(#tt-sweep)" />
        </motion.g>
      </svg>
    </div>
  );
}

function LogRow({ line, accent, first }: { line: LogLine; accent: string; first: boolean }) {
  const dotColor =
    line.state === "win" ? accent : line.state === "miss" ? T.pencilSoft : line.state === "pending" ? T.pencil : T.ink;
  const glyph = line.state === "win" ? "\u2713" : line.state === "miss" ? "\u00b7" : "\u203a";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "40px 14px 1fr",
        gap: 10,
        padding: "8px 0",
        alignItems: "baseline",
        borderTop: first ? "none" : `1px dashed ${T.hairlineSoft}`,
      }}
    >
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1,
          color: T.pencilSoft,
          textTransform: "uppercase",
          fontWeight: 500,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {line.t}
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 13, color: dotColor, textAlign: "center", lineHeight: 1, fontWeight: 600 }}>{glyph}</div>
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: line.state === "win" ? "italic" : "normal",
          fontSize: 14,
          color: line.state === "win" ? accent : T.ink,
          letterSpacing: -0.1,
          lineHeight: 1.35,
        }}
      >
        {line.text}
      </div>
    </div>
  );
}
