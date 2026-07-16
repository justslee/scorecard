"use client";

// The Looper sheet shell (specs/looper-orb-plan.md,
// specs/orb-s2-context-contract-teetime-plan.md §5).
//
// `LooperSheetShell` is the shared surface — header, conversation, live
// dictation line, thinking pulse, tap-to-talk mic — used by every Looper
// context. The brain that used to live here as this file's default export
// (the GENERAL context: Home/Partners/Profile, stateless /caddie/voice with
// hole_number null) now lives in `CaddieOrbSheet`, the single generic sheet
// host mounted in app/layout.tsx — it subsumes the general lane AND every
// registered page task/converse context. The round-page `CaddieSheet`
// remains a separate surface (on-hole session brain, not this shell).

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { PulseDot } from "@/components/yardage/Voice";
import { Transcript, ConversationTurn } from "@/components/yardage/Transcript";
import { useSheetTTS } from "@/hooks/useSheetTTS";
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
  streamingTurn,
  personaId = "classic",
  speakerLabel = "Looper",
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
  /**
   * A caddie reply currently streaming in (specs/voice-streaming-replies-plan.md)
   * — rendered as a live, still-growing "looper" turn right after `turns`.
   * Optional and additive: callers that don't stream (tee-time's own shell
   * instance, wired to its own intent parser) simply omit it — undefined
   * renders nothing extra, so nothing changes for them.
   */
  streamingTurn?: string | null;
  /**
   * The golfer's selected caddie persona id — selects the SPOKEN voice only
   * (TTS), display-inert (no visible chrome changes here). Optional, default
   * "classic" so any consumer that omits it is behavior-identical to before
   * this prop existed.
   */
  personaId?: string;
  /**
   * Who's talking, for the reply caption / streaming caption / thinking
   * pulse — speaker attribution, NOT the app wordmark (the kicker stays
   * literal "Looper" regardless). Optional, default "Looper" so any consumer
   * that omits it is behavior-identical to before this prop existed.
   * Presentational only — no persona logic lives in this shell.
   */
  speakerLabel?: string;
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
      tts.speak(last.text, personaId);
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
            data-no-backswipe
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(26,42,26,0.28)" }}
          />
          <motion.div
            data-no-backswipe
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
              <Transcript
                turns={turns.map((t, i) => ({
                  key: String(i),
                  speaker: t.role === "user" ? "user" : "caddie",
                  text: t.text,
                }))}
                speakerLabel={speakerLabel}
              />
              {streamingTurn != null && (
                <ConversationTurn
                  turn={{ key: "streaming", speaker: "caddie", text: streamingTurn, streaming: true }}
                  speakerLabel={speakerLabel}
                />
              )}
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
                    {`${speakerLabel} is thinking…`}
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

