"use client";

import { motion, AnimatePresence } from "framer-motion";
import { T, Caddy } from "./tokens";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";
export type VoiceTurn = { role: "user" | "caddy"; text: string };

export function VoiceOrb({ state = "idle", accent, onTap }: { state?: VoiceState; accent: string; onTap?: () => void }) {
  const bars = state === "listening" || state === "speaking";
  return (
    <button
      onClick={onTap}
      style={{
        position: "relative",
        width: 36,
        height: 36,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {bars ? (
        <div style={{ display: "flex", gap: 3, alignItems: "center", height: 16 }}>
          {[0, 1, 2, 3].map((i) => (
            <motion.span
              key={i}
              animate={{ height: [5, 14, 7, 12, 5] }}
              transition={{ duration: 1.1 + i * 0.1, repeat: Infinity, ease: "easeInOut", delay: i * 0.08 }}
              style={{ display: "block", width: 2.5, borderRadius: 2, background: accent }}
            />
          ))}
        </div>
      ) : (
        <>
          <motion.span
            animate={{ scale: state === "thinking" ? [1, 1.4, 1] : [1, 1.15, 1], opacity: [0.2, 0.35, 0.2] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            style={{ position: "absolute", width: 22, height: 22, borderRadius: 99, background: accent }}
          />
          <span style={{ position: "relative", width: 8, height: 8, borderRadius: 99, background: accent }} />
        </>
      )}
    </button>
  );
}

export function Waveform({ bars = 28, accent, playing = true, height = 22 }: { bars?: number; accent: string; playing?: boolean; height?: number }) {
  return (
    <div style={{ display: "flex", gap: 2.5, alignItems: "center", height }}>
      {Array.from({ length: bars }).map((_, i) => (
        <motion.span
          key={i}
          animate={playing ? { height: [4, 6 + ((i * 37) % 14), 10, 4 + ((i * 13) % 16), 5] } : { height: 4 }}
          transition={playing ? { duration: 0.9 + ((i * 17) % 8) / 10, repeat: Infinity, ease: "easeInOut", delay: i * 0.03 } : { duration: 0.2 }}
          style={{ display: "block", width: 2, borderRadius: 2, background: accent, opacity: 0.6 + (i % 3) * 0.15 }}
        />
      ))}
    </div>
  );
}

function Turn({ role, text, accent, caddy, state }: { role: "user" | "caddy"; text: string; accent: string; caddy?: Caddy; state: VoiceState | null }) {
  const isUser = role === "user";
  const isCaddy = role === "caddy";
  const speaking = isCaddy && state === "speaking";

  if (isUser) {
    return (
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.4, color: T.pencilSoft, textTransform: "uppercase", marginBottom: 6 }}>You</div>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 24, lineHeight: 1.22, letterSpacing: -0.4, color: T.ink }}>
          <span style={{ color: T.pencil, fontSize: 20, verticalAlign: "15%" }}>&ldquo;</span>
          {text}
          {state === "listening" && (
            <motion.span
              animate={{ opacity: [0, 1, 0] }}
              transition={{ duration: 0.9, repeat: Infinity }}
              style={{ display: "inline-block", width: 2, height: 20, background: accent, marginLeft: 2, verticalAlign: "-3px" }}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "flex-start" }}>
      <div
        style={{
          flexShrink: 0,
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
          marginTop: 2,
        }}
      >
        {caddy?.initial || "C"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>{caddy?.name || "Caddy"}</span>
          {speaking && <Waveform accent={accent} playing height={14} bars={18} />}
          {!speaking && <span style={{ fontFamily: T.mono, fontSize: 9, color: T.pencilSoft, letterSpacing: 1.2 }}>SAID</span>}
        </div>
        <div style={{ fontFamily: T.serif, fontSize: 18, lineHeight: 1.32, letterSpacing: -0.2, color: T.ink }}>{text}</div>
      </div>
    </div>
  );
}

export function VoiceSheet({
  open,
  onClose,
  accent,
  caddy,
  voiceState,
  turns = [],
  onMicTap,
}: {
  open: boolean;
  onClose: () => void;
  accent: string;
  caddy: Caddy;
  voiceState: VoiceState;
  turns?: VoiceTurn[];
  onMicTap: () => void;
}) {
  const hasTurns = turns.length > 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="vbackdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          style={{ position: "fixed", inset: 0, background: "rgba(26,42,26,0.35)", backdropFilter: "blur(6px)", zIndex: 40 }}
        />
      )}
      {open && (
        <motion.div
          key="vsheet"
          initial={{ y: "-100%" }}
          animate={{ y: 0 }}
          exit={{ y: "-100%" }}
          transition={T.springSoft}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 72,
            zIndex: 50,
            background: T.paper,
            borderBottomLeftRadius: 28,
            borderBottomRightRadius: 28,
            boxShadow: "0 20px 50px rgba(26,42,26,0.25)",
            padding: "54px 20px 0",
            display: "flex",
            flexDirection: "column",
            maxWidth: 420,
            margin: "0 auto",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>
                Live with {caddy.name}
              </div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15, color: T.pencilSoft, letterSpacing: -0.2 }}>
                {voiceState === "listening" && "Listening…"}
                {voiceState === "thinking" && "Thinking…"}
                {voiceState === "speaking" && "Speaking to you"}
                {voiceState === "idle" && "Ready"}
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
                color: T.pencil,
                cursor: "pointer",
                fontFamily: T.sans,
                fontSize: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ×
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", paddingBottom: 8 }}>
            {hasTurns ? (
              turns.map((t, i) => <Turn key={i} role={t.role} text={t.text} accent={accent} caddy={caddy} state={i === turns.length - 1 ? voiceState : null} />)
            ) : (
              <div style={{ minHeight: 80 }}>
                <div style={{ fontFamily: T.serif, fontSize: 26, lineHeight: 1.2, letterSpacing: -0.5, color: T.ink, fontStyle: "italic" }}>
                  <span style={{ color: T.pencilSoft }}>Tap the mic and ask anything&hellip;</span>
                </div>
                <div style={{ marginTop: 18 }}>
                  <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.4, color: T.pencilSoft, textTransform: "uppercase", marginBottom: 8 }}>
                    Try saying
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {["What should I hit from here?", "Jordan made a four, I had a five", "Press the back nine for fifty"].map((s, i) => (
                      <div key={i} style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 16, color: T.pencil, letterSpacing: -0.2 }}>
                        &mdash; {s}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {open && (
        <motion.div
          key="vmic"
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={T.springSoft}
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 51,
            padding: "14px 20px 30px",
            background: `linear-gradient(to top, ${T.paper} 70%, rgba(0,0,0,0))`,
            display: "flex",
            alignItems: "center",
            gap: 12,
            maxWidth: 420,
            margin: "0 auto",
          }}
        >
          <div style={{ flex: 1, fontFamily: T.mono, fontSize: 10, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" }}>
            {voiceState === "listening" && "Hold and talk · release to send"}
            {voiceState === "thinking" && "One sec…"}
            {voiceState === "speaking" && "Tap to interrupt"}
            {voiceState === "idle" && "Tap to talk"}
          </div>
          <motion.button
            onClick={onMicTap}
            animate={voiceState === "listening" ? { scale: [1, 1.06, 1] } : { scale: 1 }}
            transition={{ duration: 1.3, repeat: voiceState === "listening" ? Infinity : 0 }}
            style={{
              width: 64,
              height: 64,
              borderRadius: 99,
              border: "none",
              background: voiceState === "listening" ? accent : T.ink,
              color: T.paper,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: voiceState === "listening" ? `0 0 0 8px ${accent}22, 0 10px 24px rgba(26,42,26,0.3)` : "0 10px 24px rgba(26,42,26,0.3)",
            }}
          >
            {voiceState === "listening" ? (
              <Waveform accent={T.paper} playing bars={5} height={22} />
            ) : voiceState === "speaking" ? (
              <span style={{ width: 14, height: 14, background: T.paper, borderRadius: 3, display: "block" }} />
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="9" y="3" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <path d="M12 18v3" />
              </svg>
            )}
          </motion.button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
