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
import { useSheetTTS } from "@/hooks/useSheetTTS";
import { buildKeyterms } from "@/lib/voice/keyterms";
import { talkToCaddie } from "@/lib/caddie/api";
import { onLooperOpen } from "@/lib/looper-bus";
import { useBodyScrollLock } from "@/lib/sheet";
import { haptic } from "@/lib/haptics";
import { getSheetTtsEnabled, setSheetTtsEnabled } from "@/lib/voice/tts-pref";

export type LooperTurn = { role: "user" | "looper"; text: string };
export type LooperPhase = "idle" | "listening" | "thinking";

/** Quiet speaker glyph — mirrors CaddieSheet's SpeakerIcon (no shared export;
 *  small enough to duplicate rather than couple the two sheet surfaces). */
function SpeakerIcon({ muted, size = 13 }: { muted: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5.5h2.3L8 2.7v9.6L4.3 9.5H2z" fill="currentColor" fillOpacity={0.18} />
      {muted ? (
        <path d="M10 5l3.2 5M13.2 5L10 10" />
      ) : (
        <>
          <path d="M10.3 5.2a3 3 0 0 1 0 4.6" />
          <path d="M12 3.7a5.4 5.4 0 0 1 0 7.6" />
        </>
      )}
    </svg>
  );
}

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

  // Spoken caddie replies (specs/voice-tts-sheet-replies-plan.md) — self-
  // contained here so every context that reuses this shell (general Looper,
  // tee-time) inherits both the control and the playback without each host
  // wiring its own tts call. Default off (opt-in), quiet by design.
  const tts = useSheetTTS();
  const [ttsEnabled, setTtsEnabled] = useState(false);
  useEffect(() => {
    setTtsEnabled(getSheetTtsEnabled());
  }, []);

  // Speak only a NEWLY completed "looper" turn added while the sheet is open
  // — never replay existing history on reopen. wasOpenRef re-baselines the
  // watermark each time the sheet transitions closed → open.
  const lastSpokenIndexRef = useRef(-1);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      lastSpokenIndexRef.current = turns.length - 1;
      return;
    }
    const lastIdx = turns.length - 1;
    if (lastIdx <= lastSpokenIndexRef.current) return;
    lastSpokenIndexRef.current = lastIdx;
    const last = turns[lastIdx];
    if (last && last.role === "looper" && last.text) {
      tts.speak(last.text, "classic");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, turns]);

  // Sheet close mid-playback (§7 edge case).
  useEffect(() => {
    if (!open) tts.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
                  {/* Spoken replies toggle — quiet, minor control (§3). Idle
                      tap flips the mute pref; a tap while speaking silences it. */}
                  <button
                    onClick={() => {
                      tts.unlock(); // also a user gesture — blesses playback for the next reply
                      if (tts.isSpeaking) {
                        tts.stop();
                      } else {
                        const next = !ttsEnabled;
                        setTtsEnabled(next);
                        setSheetTtsEnabled(next);
                      }
                    }}
                    aria-label={
                      tts.isSpeaking
                        ? "Silence Looper's voice"
                        : ttsEnabled
                        ? "Turn off spoken replies"
                        : "Turn on spoken replies"
                    }
                    aria-pressed={ttsEnabled}
                    style={{
                      // 44×44 hit area for on-course glove use (the app's own
                      // ≥44pt standard); negative margin keeps the 20px visual
                      // footprint so the header row layout is unchanged.
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 44,
                      height: 44,
                      margin: -12,
                      border: "none",
                      background: "transparent",
                      padding: 0,
                      cursor: "pointer",
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        border: `1px solid ${T.hairline}`,
                        background: tts.isSpeaking ? `${T.ink}14` : "transparent",
                        color: tts.isSpeaking ? T.ink : ttsEnabled ? T.pencil : T.pencilSoft,
                      }}
                    >
                      <SpeakerIcon muted={!ttsEnabled && !tts.isSpeaking} size={10} />
                    </span>
                  </button>
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
                  // Bless the <audio> element in the SAME gesture as dictation
                  // start — must run synchronously (§3 iOS unlock wiring).
                  tts.unlock();
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
  // Auto-send: Deepgram's end-of-speech triggers the same path as tapping
  // the mic to send (ref indirection — the handler is defined below).
  const micTapRef = useRef<() => void>(() => {});
  const dictation = useLooperDictation({
    surface: "looper-general",
    getKeyterms: () => buildKeyterms(),
    onUtteranceEnd: () => micTapRef.current(),
  });
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

  micTapRef.current = () => void handleMicTap();

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
