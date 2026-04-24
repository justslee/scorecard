"use client";

import { motion, AnimatePresence } from "framer-motion";
import { T, Caddy } from "./tokens";
import HoleIllustration from "./HoleIllustration";
import type { HoleSpec } from "./HoleIllustration";

export default function HoleCard({
  holeNumber,
  hole,
  distance,
  windMph,
  windDir,
  shotPoint,
  expanded,
  onExpand,
  onCollapse,
  onZoom,
  onAskCaddy,
  accent,
  club,
  density,
  caddy,
}: {
  holeNumber: number;
  hole: HoleSpec;
  distance: number;
  windMph: number;
  windDir: string;
  shotPoint?: [number, number] | null;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onZoom: () => void;
  onAskCaddy: () => void;
  accent: string;
  club: string;
  density: "spacious" | "dense";
  caddy: Caddy;
}) {
  const pad = density === "dense" ? 14 : 18;
  return (
    <motion.div
      layout
      transition={T.springSoft}
      style={{
        position: "relative",
        borderRadius: 20,
        overflow: "hidden",
        background: T.paper,
        border: `1px solid ${T.hairline}`,
        boxShadow: expanded ? "0 30px 60px rgba(26,42,26,0.15)" : "0 8px 24px rgba(26,42,26,0.06)",
      }}
    >
      {/* top meta strip */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${pad - 4}px ${pad + 2}px 2px` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase" }}>Hole</div>
          <motion.div
            key={holeNumber}
            initial={{ y: 4, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.25, ease: T.ease }}
            style={{ fontFamily: T.serif, fontSize: 26, fontWeight: 400, color: T.ink, letterSpacing: -0.8, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}
          >
            {String(holeNumber).padStart(2, "0")}
          </motion.div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <Meta k="Par" v={hole.par} />
          <Meta k="Yards" v={hole.yards} />
          <Meta k="HCP" v={hole.hcp} />
        </div>
      </div>

      {/* Illustration */}
      <div style={{ position: "relative", padding: `6px ${pad}px 0`, display: "flex", justifyContent: "center" }}>
        <motion.div
          layout
          style={{ width: expanded ? 340 : 190, height: expanded ? 340 : 190, position: "relative" }}
          onClick={expanded ? onZoom : onExpand}
        >
          <HoleIllustration holeNumber={holeNumber} size={expanded ? 340 : 190} shotPoint={shotPoint} showDetail={expanded} accent={accent} />
          {expanded && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={(e) => {
                e.stopPropagation();
                onZoom();
              }}
              style={{
                position: "absolute",
                bottom: 8,
                right: 8,
                padding: "6px 10px",
                borderRadius: 99,
                background: "rgba(26,42,26,0.85)",
                color: T.paper,
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 5,
                backdropFilter: "blur(4px)",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                <path d="M1 4V1h3M9 4V1H6M1 6v3h3M9 6v3H6" />
              </svg>
              Zoom
            </motion.button>
          )}
          {distance != null && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                padding: "4px 8px",
                borderRadius: 99,
                background: T.ink,
                color: T.paper,
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: 1.2,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: 99, background: accent }} />
              {distance}Y
            </motion.div>
          )}
        </motion.div>
      </div>

      {/* Expanded: caddy strip */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: T.ease }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: `14px ${pad}px 16px` }}>
              {/* Wind + elevation */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 0,
                  padding: "10px 0",
                  borderTop: `1px solid ${T.hairline}`,
                  borderBottom: `1px solid ${T.hairline}`,
                  marginBottom: 14,
                }}
              >
                <Stat k="Wind" v={`${windMph}mph`} sub={windDir} />
                <Stat k="Elev" v="+3ft" sub="uphill" />
                <Stat k="Plays" v={`${Math.round(distance * 1.04)}Y`} sub="adjusted" />
              </div>

              {/* Caddy voice panel */}
              <div
                style={{
                  position: "relative",
                  border: `1px solid ${T.hairline}`,
                  borderRadius: 16,
                  background: `linear-gradient(180deg, ${T.paperDeep} 0%, ${T.paper} 100%)`,
                  padding: 14,
                }}
              >
                {/* Club badge */}
                <div
                  style={{
                    position: "absolute",
                    top: 12,
                    right: 12,
                    width: 56,
                    height: 56,
                    borderRadius: 14,
                    border: `1.5px solid ${T.ink}`,
                    background: T.paper,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    lineHeight: 1,
                  }}
                >
                  <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencil, textTransform: "uppercase", marginBottom: 2 }}>CLUB</div>
                  <div style={{ fontFamily: T.serif, fontSize: 20, color: T.ink, fontWeight: 500 }}>{club}</div>
                </div>

                <div style={{ display: "flex", gap: 12, alignItems: "flex-start", paddingRight: 60 }}>
                  <div style={{ position: "relative", flexShrink: 0 }}>
                    <motion.div
                      animate={{ scale: [1, 1.12, 1], opacity: [0.35, 0.1, 0.35] }}
                      transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                      style={{ position: "absolute", inset: -4, borderRadius: 99, background: accent }}
                    />
                    <div
                      style={{
                        position: "relative",
                        width: 44,
                        height: 44,
                        borderRadius: 99,
                        background: T.ink,
                        color: T.paper,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 20,
                      }}
                    >
                      {caddy.initial}
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>{caddy.name}</span>
                      <div style={{ display: "flex", gap: 2, alignItems: "center", height: 10 }}>
                        {[5, 9, 6, 11, 7, 4, 8, 5].map((h, i) => (
                          <span key={i} style={{ display: "block", width: 1.5, height: h, borderRadius: 1, background: accent, opacity: 0.55 + (i % 3) * 0.15 }} />
                        ))}
                      </div>
                      <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencilSoft, marginLeft: "auto" }}>0:06</span>
                    </div>
                    <div style={{ fontFamily: T.serif, fontSize: 17, fontStyle: "italic", color: T.ink, lineHeight: 1.28, letterSpacing: -0.2 }}>
                      Smooth {club.toLowerCase()} &mdash; the breeze is off your right. Favor the left side of the green.
                    </div>
                  </div>
                </div>

                {/* Ask-back row */}
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${T.hairline}`, display: "flex", alignItems: "center", gap: 10 }}>
                  <motion.button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAskCaddy();
                    }}
                    whileTap={{ scale: 0.96 }}
                    style={{
                      flexShrink: 0,
                      width: 40,
                      height: 40,
                      borderRadius: 99,
                      border: "none",
                      background: accent,
                      color: T.paper,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: `0 0 0 4px ${accent}22, 0 6px 14px rgba(26,42,26,0.2)`,
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <rect x="9" y="3" width="6" height="12" rx="3" />
                      <path d="M5 11a7 7 0 0 0 14 0" />
                      <path d="M12 18v3" />
                    </svg>
                  </motion.button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>Hold to talk</div>
                    <div style={{ fontFamily: T.serif, fontSize: 14, fontStyle: "italic", color: T.pencil, letterSpacing: -0.1 }}>
                      &ldquo;Should I lay up?&rdquo; · &ldquo;Give me the 9 instead&rdquo; · &ldquo;Log my score&rdquo;
                    </div>
                  </div>
                </div>
              </div>

              {/* Flag distance markers */}
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                {[
                  { k: "Front", v: distance - 12, color: "#a8553f" },
                  { k: "Center", v: distance, color: T.ink },
                  { k: "Back", v: distance + 14, color: "#5d7285" },
                ].map((d) => (
                  <div
                    key={d.k}
                    style={{
                      flex: 1,
                      padding: "10px 10px 8px",
                      borderRadius: 10,
                      border: `1px solid ${T.hairline}`,
                      textAlign: "center",
                      position: "relative",
                      overflow: "hidden",
                    }}
                  >
                    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: d.color }} />
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.2,
                        color: T.pencil,
                        textTransform: "uppercase",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 99,
                          background: d.color,
                          border: d.k === "Center" ? `1px solid ${T.pencilSoft}` : "none",
                        }}
                      />
                      {d.k}
                    </div>
                    <div style={{ fontFamily: T.serif, fontSize: 22, color: T.ink, fontVariantNumeric: "tabular-nums" }}>{d.v}</div>
                  </div>
                ))}
              </div>

              <button
                onClick={onCollapse}
                style={{
                  marginTop: 14,
                  width: "100%",
                  padding: "10px",
                  background: "transparent",
                  border: `1px solid ${T.hairline}`,
                  borderRadius: 99,
                  fontFamily: T.mono,
                  fontSize: 10,
                  letterSpacing: 1.4,
                  color: T.pencil,
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                Collapse hole
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!expanded && (
        <div
          style={{
            textAlign: "center",
            padding: `6px 0 ${pad - 2}px`,
            fontFamily: T.mono,
            fontSize: 9.5,
            letterSpacing: 1.4,
            color: T.pencilSoft,
          }}
        >
          TAP FOR CADDY
        </div>
      )}
    </motion.div>
  );
}

function Meta({ k, v }: { k: string; v: number | string }) {
  return (
    <div style={{ textAlign: "right", lineHeight: 1 }}>
      <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.1, color: T.pencilSoft, textTransform: "uppercase" }}>{k}</div>
      <div style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{v}</div>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>{k}</div>
      <div style={{ fontFamily: T.serif, fontSize: 20, color: T.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{v}</div>
      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 0.8, color: T.pencil }}>{sub}</div>
    </div>
  );
}
