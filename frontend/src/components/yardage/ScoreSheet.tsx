"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { T } from "./tokens";
import type { SeedPlayer } from "./Scorecard";

function DigitWheel({ value, onChange, par, accent }: { value: number | null; onChange: (v: number | null) => void; par: number; accent: string }) {
  const opts: (number | null)[] = [null, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const idx = opts.indexOf(value);
  const rowH = 56;

  return (
    <div
      style={{
        position: "relative",
        width: 92,
        height: rowH * 3,
        overflow: "hidden",
        maskImage: "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)",
      }}
    >
      <motion.div
        animate={{ y: -idx * rowH + rowH }}
        transition={T.spring}
        style={{ position: "absolute", left: 0, right: 0, top: 0 }}
      >
        {opts.map((o, i) => {
          const diff = o == null ? null : o - par;
          const color =
            o == null
              ? T.pencilSoft
              : diff! <= -2
              ? T.eagle
              : diff === -1
              ? T.birdie
              : diff === 0
              ? T.par
              : diff === 1
              ? T.bogey
              : T.double;
          const isActive = i === idx;
          return (
            <div
              key={i}
              onClick={() => onChange(o)}
              style={{
                height: rowH,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: T.serif,
                fontSize: isActive ? 54 : 38,
                color,
                opacity: isActive ? 1 : 0.35,
                fontVariantNumeric: "tabular-nums",
                transition: "font-size 0.18s, opacity 0.18s",
                cursor: "pointer",
              }}
            >
              {o ?? "—"}
            </div>
          );
        })}
      </motion.div>
      {/* Selection brackets */}
      <div style={{ position: "absolute", left: 0, right: 0, top: rowH, height: rowH, pointerEvents: "none" }}>
        <div style={{ position: "absolute", top: 6, left: 8, width: 10, height: 1.5, background: accent }} />
        <div style={{ position: "absolute", top: 6, left: 8, width: 1.5, height: 8, background: accent }} />
        <div style={{ position: "absolute", top: 6, right: 8, width: 10, height: 1.5, background: accent }} />
        <div style={{ position: "absolute", top: 6, right: 8, width: 1.5, height: 8, background: accent }} />
        <div style={{ position: "absolute", bottom: 6, left: 8, width: 10, height: 1.5, background: accent }} />
        <div style={{ position: "absolute", bottom: 6, left: 8, width: 1.5, height: 8, background: accent }} />
        <div style={{ position: "absolute", bottom: 6, right: 8, width: 10, height: 1.5, background: accent }} />
        <div style={{ position: "absolute", bottom: 6, right: 8, width: 1.5, height: 8, background: accent }} />
      </div>
    </div>
  );
}

export default function ScoreSheet({
  open,
  onClose,
  hole,
  players,
  scores,
  onSetScore,
  accent,
}: {
  open: boolean;
  onClose: () => void;
  hole: { number: number; par: number };
  players: SeedPlayer[];
  scores: Record<string, (number | null)[]>;
  onSetScore: (pid: string, idx: number, val: number | null) => void;
  accent: string;
}) {
  const [activePid, setActivePid] = useState(players[0]?.id ?? "");

  useEffect(() => {
    if (open) setActivePid(players[0]?.id ?? "");
  }, [open, players]);

  const labelFor = (v: number, par: number) => {
    const diff = v - par;
    if (diff === -2) return "Eagle";
    if (diff === -1) return "Birdie";
    if (diff === 0) return "Par";
    if (diff === 1) return "Bogey";
    if (diff === 2) return "Double";
    return `+${diff}`;
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="sbackdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          style={{ position: "fixed", inset: 0, background: "rgba(26,42,26,0.3)", zIndex: 40 }}
        />
      )}
      {open && (
        <motion.div
          key="ssheet"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={T.springSoft}
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 50,
            background: T.paper,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            boxShadow: "0 -20px 50px rgba(26,42,26,0.25)",
            padding: "14px 20px 34px",
            maxWidth: 420,
            margin: "0 auto",
          }}
        >
          <div style={{ width: 40, height: 4, borderRadius: 99, background: T.hairline, margin: "0 auto 14px" }} />

          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>
                Hole {hole.number} · Par {hole.par}
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 22, fontStyle: "italic", color: T.ink, letterSpacing: -0.4, marginTop: 2 }}>Enter your score</div>
            </div>
            <button
              onClick={onClose}
              style={{
                width: 30,
                height: 30,
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

          <div style={{ display: "flex", gap: 6, marginBottom: 18, overflowX: "auto" }}>
            {players.map((p) => {
              const v = scores[p.id]?.[hole.number - 1] ?? null;
              const isActive = activePid === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setActivePid(p.id)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 99,
                    border: `1px solid ${isActive ? T.ink : T.hairline}`,
                    background: isActive ? T.ink : "transparent",
                    color: isActive ? T.paper : T.ink,
                    fontFamily: T.sans,
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.name}
                  {v != null && (
                    <span style={{ marginLeft: 6, opacity: 0.6, fontFamily: T.mono, fontSize: 11 }}>{v}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <DigitWheel
              value={scores[activePid]?.[hole.number - 1] ?? null}
              onChange={(v) => onSetScore(activePid, hole.number - 1, v)}
              par={hole.par}
              accent={accent}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase", marginBottom: 8 }}>
                Quick pick
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                {[hole.par - 2, hole.par - 1, hole.par, hole.par + 1, hole.par + 2, hole.par + 3]
                  .filter((v) => v >= 1 && v <= 9)
                  .map((v) => {
                    const isSel = scores[activePid]?.[hole.number - 1] === v;
                    return (
                      <button
                        key={v}
                        onClick={() => onSetScore(activePid, hole.number - 1, v)}
                        style={{
                          padding: "8px 4px",
                          borderRadius: 10,
                          border: `1px solid ${isSel ? accent : T.hairline}`,
                          background: isSel ? accent : "transparent",
                          color: isSel ? "#fff" : T.ink,
                          fontFamily: T.sans,
                          fontSize: 11,
                          fontWeight: 500,
                          cursor: "pointer",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 2,
                        }}
                      >
                        <span style={{ fontFamily: T.serif, fontSize: 18, fontWeight: 400 }}>{v}</span>
                        <span style={{ fontSize: 9, letterSpacing: 0.3, opacity: 0.8 }}>{labelFor(v, hole.par)}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: 16,
              padding: "10px 14px",
              borderRadius: 14,
              border: `1px dashed ${T.hairline}`,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 99,
                background: T.ink,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: 99, background: accent }} />
            </div>
            <div style={{ flex: 1, fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.pencil }}>
              Or say <span style={{ color: T.ink }}>&ldquo;I had a four, Jordan had a five&rdquo;</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
