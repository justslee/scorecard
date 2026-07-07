"use client";

// The Looper sheet (specs/looper-orb-plan.md).
//
// `LooperSheetShell` is the shared surface — header, conversation, live
// dictation line, thinking pulse, tap-to-talk mic — used by every Looper
// context. The default export is the GENERAL context (Home/Partners/Profile):
// brain = the stateless /caddie/voice endpoint with hole_number null
// (off-course chat — the caddie never pretends to be on a hole). Tee-time
// hosts its own shell instance wired to the tee-time intent parser.

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { PulseDot } from "@/components/yardage/Voice";
import { useLooperDictation } from "@/hooks/useLooperDictation";
import { talkToCaddie } from "@/lib/caddie/api";
import { onLooperOpen } from "@/lib/looper-bus";
import { useBodyScrollLock } from "@/lib/sheet";
import { haptic } from "@/lib/haptics";

export type LooperTurn = { role: "user" | "looper"; text: string };
export type LooperPhase = "idle" | "listening" | "thinking";

// ── The shared sheet surface ─────────────────────────────────────────────────

export function LooperSheetShell({
  open,
  onClose,
  title,
  emptyHint,
  turns,
  phase,
  interim,
  error,
  onMicTap,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  emptyHint: string;
  turns: LooperTurn[];
  phase: LooperPhase;
  interim: string;
  error: string | null;
  onMicTap: () => void;
}) {
  useBodyScrollLock(open);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(26,42,26,0.28)" }}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={T.springSoft}
            style={{
              position: "fixed",
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 61,
              maxHeight: "78dvh",
              display: "flex",
              flexDirection: "column",
              borderRadius: "20px 20px 0 0",
              border: `1px solid ${T.hairline}`,
              borderBottom: "none",
              background: `${PAPER_NOISE}, ${T.paper}`,
              backgroundBlendMode: "multiply",
              boxShadow: "0 -12px 40px rgba(26,42,26,0.18)",
            }}
          >
            {/* Header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px 10px",
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.8,
                    color: T.pencil,
                    textTransform: "uppercase",
                  }}
                >
                  Looper
                </div>
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 22,
                    letterSpacing: -0.4,
                    color: T.ink,
                    marginTop: 2,
                  }}
                >
                  {title}
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close Looper"
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 99,
                  border: `1px solid ${T.hairline}`,
                  background: "transparent",
                  color: T.ink,
                  cursor: "pointer",
                  fontSize: 16,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>

            {/* Conversation */}
            <div style={{ flex: 1, overflowY: "auto", padding: "4px 20px 8px" }}>
              {turns.length === 0 && phase === "idle" && !error && (
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 14,
                    color: T.pencilSoft,
                    padding: "6px 0 10px",
                  }}
                >
                  {emptyHint}
                </div>
              )}
              {turns.map((t, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 8.5,
                      letterSpacing: 1.4,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                      marginBottom: 3,
                    }}
                  >
                    {t.role === "user" ? "You" : "Looper"}
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 15.5,
                      fontStyle: t.role === "looper" ? "italic" : "normal",
                      color: T.ink,
                      lineHeight: 1.45,
                      letterSpacing: -0.1,
                    }}
                  >
                    {t.text}
                  </div>
                </div>
              ))}
              {phase === "listening" && (
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 15,
                    color: T.inkSoft,
                    lineHeight: 1.4,
                    padding: "4px 0",
                  }}
                >
                  {interim ? `“${interim}”` : "Hearing…"}
                </div>
              )}
              {phase === "thinking" && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
                  <PulseDot accent={T.ink} />
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 9.5,
                      letterSpacing: 1.4,
                      color: T.pencil,
                      textTransform: "uppercase",
                    }}
                  >
                    Looper is thinking…
                  </span>
                </div>
              )}
              {error && (
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 14,
                    color: T.pencil,
                    padding: "4px 0",
                  }}
                >
                  {error}
                </div>
              )}
            </div>

            {/* Mic */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "8px 20px calc(18px + env(safe-area-inset-bottom))",
                borderTop: `1px solid ${T.hairline}`,
              }}
            >
              <button
                onClick={() => {
                  haptic("light");
                  onMicTap();
                }}
                aria-label={phase === "listening" ? "Stop and send" : "Start talking"}
                disabled={phase === "thinking"}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 99,
                  border: `1.5px solid ${phase === "listening" ? T.ink : T.hairline}`,
                  background: phase === "listening" ? T.ink : T.paper,
                  color: phase === "listening" ? T.paper : T.ink,
                  cursor: phase === "thinking" ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0" />
                  <path d="M12 18v3" />
                </svg>
              </button>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1.4,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                }}
              >
                {phase === "listening" ? "Tap to send" : phase === "thinking" ? "One sec…" : "Tap to talk"}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ── The general context (default export, mounted in the root layout) ────────

export default function LooperSheet() {
  const [open, setOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [turns, setTurns] = useState<LooperTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const dictation = useLooperDictation();
  const openGenRef = useRef(0);
  const turnsRef = useRef<LooperTurn[]>([]);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  // Keep a stable ref to dictation.start for the summon effect.
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  useEffect(() => {
    return onLooperOpen((detail) => {
      if (detail.context !== "general") return;
      setOpen((wasOpen) => {
        if (!wasOpen) {
          openGenRef.current++;
          setTurns([]);
          setThinking(false);
          setError(null);
        }
        return true;
      });
      if (detail.listening) {
        setTimeout(() => void dictationRef.current.start(), 60);
      }
    });
  }, []);

  const close = useCallback(() => {
    openGenRef.current++;
    dictation.cancel();
    setOpen(false);
    setThinking(false);
    setError(null);
  }, [dictation]);

  const handleMicTap = useCallback(async () => {
    setError(null);
    if (!dictation.listening) {
      await dictation.start();
      return;
    }
    const gen = openGenRef.current;
    setThinking(true);
    const finalText = await dictation.stopAndResolve();
    if (openGenRef.current !== gen) return;
    if (!finalText) {
      setThinking(false);
      setError("No speech detected. Tap the mic to try again.");
      return;
    }
    setTurns((t) => [...t, { role: "user", text: finalText }]);
    try {
      const history = turnsRef.current.map((t) => ({
        role: t.role === "looper" ? ("assistant" as const) : ("user" as const),
        content: t.text,
      }));
      const res = await talkToCaddie({
        transcript: finalText,
        personality_id: "classic",
        hole_number: null, // off-course — never pretend to be on a hole
        conversation_history: history,
      });
      if (openGenRef.current !== gen) return;
      setTurns((t) => [...t, { role: "looper", text: res.response }]);
    } catch {
      if (openGenRef.current === gen) setError("Looper couldn't answer that one. Try again.");
    } finally {
      if (openGenRef.current === gen) setThinking(false);
    }
  }, [dictation]);

  const phase: LooperPhase = dictation.listening ? "listening" : thinking ? "thinking" : "idle";

  return (
    <LooperSheetShell
      open={open}
      onClose={close}
      title="What can I do for you?"
      emptyHint="Tee times, courses, your game — ask me anything."
      turns={turns}
      phase={phase}
      interim={dictation.interim}
      error={error ?? dictation.micError}
      onMicTap={() => void handleMicTap()}
    />
  );
}
