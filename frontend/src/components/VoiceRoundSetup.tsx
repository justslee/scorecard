"use client";

/**
 * VoiceRoundSetup — yardage-book styled voice overlay for round setup.
 *
 * Rebuilt with T.* tokens (T.paper / T.ink / T.serif italic / T.mono kickers)
 * and inline SVGs — no Tailwind, no lucide-react, no zinc/emerald.
 * Mirrors the VoiceSheet aesthetic from components/yardage/Voice.tsx.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { T, DEFAULT_ACCENT, PAPER_NOISE } from "@/components/yardage/tokens";
import { Waveform } from "@/components/yardage/Voice";
import { VoiceRecorder, transcribeBlob } from "@/lib/voice/deepgram";
import { fetchAPI } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VoiceRoundSetupProps {
  onSetupRound: (config: {
    courseName: string;
    playerNames: string[];
    teeName?: string;
  }) => void;
  onClose: () => void;
}

interface ParsedRoundConfig {
  courseName: string;
  playerNames: string[];
  teeName?: string;
  gameFormat?: string;
}

// Visual phase derived from state
type Phase = "idle" | "listening" | "thinking" | "transcribed" | "result" | "error";

// ---------------------------------------------------------------------------
// Inline icon helpers (no lucide-react)
// ---------------------------------------------------------------------------

function MicIcon({ size = 22, stroke = "currentColor" }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 2l10 10M12 2L2 12" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VoiceRoundSetup({ onSetupRound, onClose }: VoiceRoundSetupProps) {
  const accent = DEFAULT_ACCENT;

  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParsedRoundConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);

  const recorderRef = useRef<VoiceRecorder | null>(null);

  useEffect(() => {
    if (!VoiceRecorder.isSupported()) {
      setIsSupported(false);
      setError("Voice recording not supported in this browser.");
    }
    return () => recorderRef.current?.cancel();
  }, []);

  // Derive visual phase from state
  const phase: Phase = parseResult
    ? "result"
    : isTranscribing || isParsing
    ? "thinking"
    : error
    ? "error"
    : transcript.trim()
    ? "transcribed"
    : isListening
    ? "listening"
    : "idle";

  const startListening = useCallback(async () => {
    setError(null);
    setTranscript("");
    setParseResult(null);
    try {
      const recorder = new VoiceRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setIsListening(true);
    } catch (err) {
      setError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone access denied. Please allow mic access and try again."
          : "Failed to start microphone."
      );
    }
  }, []);

  const stopListening = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setIsListening(false);
    setIsTranscribing(true);
    try {
      const blob = await recorder.stop();
      const result = await transcribeBlob(blob);
      setTranscript(result.transcript);
      if (!result.transcript.trim()) {
        setError("No speech detected. Try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      recorderRef.current = null;
      setIsTranscribing(false);
    }
  }, []);

  const handleParse = async () => {
    const fullTranscript = transcript.trim();
    if (!fullTranscript) { setError("No speech detected."); return; }
    setIsParsing(true);
    setError(null);
    try {
      const result = await fetchAPI<ParsedRoundConfig>("/api/voice/parse-round-setup", {
        method: "POST",
        body: JSON.stringify({ transcript: fullTranscript }),
      });
      setParseResult(result);
    } catch (err) {
      console.error("Voice round parse failed:", err);
      setError("Couldn't understand. Check your connection and try again.");
    } finally {
      setIsParsing(false);
    }
  };

  const handleConfirm = () => {
    if (!parseResult) return;
    onSetupRound({
      courseName: parseResult.courseName || "",
      playerNames: parseResult.playerNames,
      teeName: parseResult.teeName,
    });
  };

  const handleRetry = () => {
    setParseResult(null);
    setTranscript("");
    setError(null);
  };

  const handleMicTap = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AnimatePresence>
      {/* Backdrop */}
      <motion.div
        key="vrs-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(26,42,26,0.35)",
          backdropFilter: "blur(4px)",
          zIndex: 50,
        }}
      />

      {/* Sheet — slides up from bottom, full screen */}
      <motion.div
        key="vrs-sheet"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={T.springSoft}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 51,
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          display: "flex",
          flexDirection: "column",
          maxWidth: 420,
          margin: "0 auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "max(16px, env(safe-area-inset-top)) 22px 14px",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            borderBottom: `1px solid ${T.hairline}`,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                marginBottom: 3,
              }}
            >
              Voice &middot; Setup
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 22,
                letterSpacing: -0.4,
                color: T.ink,
                lineHeight: 1.1,
              }}
            >
              Tell me what you&rsquo;re playing.
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
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              marginTop: 2,
            }}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px 10px" }}>
          {!isSupported ? (
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 18,
                color: "#b84a3a",
                lineHeight: 1.4,
                letterSpacing: -0.2,
              }}
            >
              {error}
            </div>

          ) : phase === "result" && parseResult ? (
            /* Parsed result */
            <div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.5,
                  color: T.pencil,
                  textTransform: "uppercase",
                  marginBottom: 14,
                }}
              >
                Got it &mdash; confirm below
              </div>

              {parseResult.courseName && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: "12px 14px",
                    borderRadius: 12,
                    background: T.paperDeep,
                    border: `1px solid ${T.hairline}`,
                  }}
                >
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 8.5,
                      letterSpacing: 1.3,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                      marginBottom: 3,
                    }}
                  >
                    Course
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 20,
                      color: T.ink,
                      letterSpacing: -0.3,
                    }}
                  >
                    {parseResult.courseName}
                  </div>
                </div>
              )}

              {parseResult.playerNames.length > 0 && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: "12px 14px",
                    borderRadius: 12,
                    background: T.paperDeep,
                    border: `1px solid ${T.hairline}`,
                  }}
                >
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 8.5,
                      letterSpacing: 1.3,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                      marginBottom: 8,
                    }}
                  >
                    Players
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {parseResult.playerNames.map((name, i) => (
                      <span
                        key={i}
                        style={{
                          padding: "5px 10px",
                          borderRadius: 99,
                          border: `1px solid ${T.hairline}`,
                          background: T.paper,
                          fontFamily: T.sans,
                          fontSize: 13,
                          fontWeight: 500,
                          color: T.ink,
                          letterSpacing: -0.1,
                        }}
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {parseResult.teeName && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: "12px 14px",
                    borderRadius: 12,
                    background: T.paperDeep,
                    border: `1px solid ${T.hairline}`,
                  }}
                >
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 8.5,
                      letterSpacing: 1.3,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                      marginBottom: 3,
                    }}
                  >
                    Tees
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 17,
                      color: T.ink,
                      letterSpacing: -0.2,
                    }}
                  >
                    {parseResult.teeName}
                  </div>
                </div>
              )}

              {/* Transcript echo */}
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: `1px dashed ${T.hairline}`,
                }}
              >
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 8.5,
                    letterSpacing: 1.2,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                    marginBottom: 3,
                  }}
                >
                  You said
                </div>
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 14,
                    color: T.pencil,
                    lineHeight: 1.4,
                    letterSpacing: -0.1,
                  }}
                >
                  &ldquo;{transcript}&rdquo;
                </div>
              </div>
            </div>

          ) : phase === "transcribed" ? (
            /* Transcript ready — waiting for user to trigger parse */
            <div>
              <div
                style={{
                  padding: "14px",
                  borderRadius: 14,
                  background: T.paperDeep,
                  border: `1px solid ${T.hairline}`,
                }}
              >
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 8.5,
                    letterSpacing: 1.3,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                    marginBottom: 4,
                  }}
                >
                  You said
                </div>
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 19,
                    lineHeight: 1.3,
                    letterSpacing: -0.2,
                    color: T.ink,
                  }}
                >
                  <span style={{ color: T.pencil, fontSize: 16 }}>&ldquo;</span>
                  {transcript}
                </div>
              </div>
            </div>

          ) : phase === "thinking" ? (
            /* Thinking / transcribing */
            <div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 20,
                  color: T.pencil,
                  letterSpacing: -0.3,
                  marginBottom: 20,
                }}
              >
                {isTranscribing ? "Transcribing…" : "Understanding…"}
              </div>
              <motion.div
                animate={{ opacity: [0.3, 0.7, 0.3] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 99,
                  background: accent,
                }}
              />
            </div>

          ) : phase === "error" ? (
            /* Error */
            <div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 17,
                  color: "#b84a3a",
                  lineHeight: 1.4,
                  letterSpacing: -0.2,
                  marginBottom: 20,
                }}
              >
                {error}
              </div>
              {transcript.trim() && (
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: 10,
                    border: `1px dashed ${T.hairline}`,
                  }}
                >
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 8.5,
                      letterSpacing: 1.2,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                      marginBottom: 3,
                    }}
                  >
                    You said
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 14,
                      color: T.pencil,
                      letterSpacing: -0.1,
                    }}
                  >
                    &ldquo;{transcript}&rdquo;
                  </div>
                </div>
              )}
            </div>

          ) : phase === "listening" ? (
            /* Actively recording */
            <div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.5,
                  color: T.pencil,
                  textTransform: "uppercase",
                  marginBottom: 20,
                }}
              >
                Listening &mdash; tap mic to stop
              </div>
              <Waveform accent={accent} bars={24} playing height={28} />
            </div>

          ) : (
            /* Idle — instructions */
            <div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 15,
                  color: T.pencil,
                  lineHeight: 1.45,
                  letterSpacing: -0.1,
                  marginBottom: 24,
                }}
              >
                Course, group, and stakes &mdash; any order, one sentence.
              </div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.4,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                  marginBottom: 10,
                }}
              >
                Try saying
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {[
                  "“Harding Park, Jack and Sam, whites, skins at five”",
                  "“Playing Sawgrass with the boys, from the blues”",
                  "“Quick nine at my home course with Justin”",
                ].map((s, i) => (
                  <div
                    key={i}
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 16,
                      color: T.pencil,
                      letterSpacing: -0.2,
                      lineHeight: 1.3,
                    }}
                  >
                    {s}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer — mic or confirm/retry buttons */}
        <div
          style={{
            padding: "12px 22px max(24px, env(safe-area-inset-bottom))",
            background: `linear-gradient(to top, ${T.paper} 70%, ${T.paper}00)`,
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          {phase === "result" ? (
            /* Confirm + retry */
            <>
              <button
                onClick={handleRetry}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 99,
                  border: `1px solid ${T.hairline}`,
                  background: "transparent",
                  color: T.pencil,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
                aria-label="Try again"
              >
                <RefreshIcon />
              </button>
              <button
                onClick={handleConfirm}
                style={{
                  flex: 1,
                  padding: "14px",
                  borderRadius: 99,
                  border: "none",
                  background: T.ink,
                  color: T.paper,
                  cursor: "pointer",
                  fontFamily: T.sans,
                  fontSize: 14,
                  fontWeight: 500,
                  letterSpacing: -0.1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Start round</span>
                <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, opacity: 0.7 }}>
                  {"→"}
                </span>
              </button>
            </>

          ) : phase === "transcribed" ? (
            /* Parse trigger */
            <>
              <button
                onClick={handleRetry}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 99,
                  border: `1px solid ${T.hairline}`,
                  background: "transparent",
                  color: T.pencil,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
                aria-label="Discard and try again"
              >
                <RefreshIcon />
              </button>
              <button
                onClick={handleParse}
                style={{
                  flex: 1,
                  padding: "14px",
                  borderRadius: 99,
                  border: "none",
                  background: T.ink,
                  color: T.paper,
                  cursor: "pointer",
                  fontFamily: T.sans,
                  fontSize: 14,
                  fontWeight: 500,
                  letterSpacing: -0.1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Understand this</span>
                <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, opacity: 0.7 }}>
                  {"→"}
                </span>
              </button>
            </>

          ) : phase === "error" ? (
            /* Error recovery */
            <button
              onClick={handleMicTap}
              style={{
                flex: 1,
                padding: "14px",
                borderRadius: 99,
                border: "none",
                background: T.ink,
                color: T.paper,
                cursor: "pointer",
                fontFamily: T.sans,
                fontSize: 14,
                fontWeight: 500,
                letterSpacing: -0.1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <MicIcon size={16} stroke={T.paper} />
              <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Try again</span>
            </button>

          ) : (
            /* Idle / listening / thinking — mic button */
            <>
              <div
                style={{
                  flex: 1,
                  fontFamily: T.mono,
                  fontSize: 9.5,
                  letterSpacing: 1.3,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                }}
              >
                {phase === "listening"
                  ? "Tap to stop"
                  : phase === "thinking"
                  ? "One sec…"
                  : "Tap to speak"}
              </div>
              <motion.button
                onClick={handleMicTap}
                disabled={phase === "thinking"}
                whileTap={{ scale: 0.92 }}
                animate={phase === "listening" ? { scale: [1, 1.05, 1] } : { scale: 1 }}
                transition={{
                  duration: 1.4,
                  repeat: phase === "listening" ? Infinity : 0,
                  ease: "easeInOut",
                }}
                style={{
                  position: "relative",
                  width: 64,
                  height: 64,
                  borderRadius: 99,
                  border: "none",
                  background: phase === "listening" ? accent : T.ink,
                  color: T.paper,
                  cursor: phase === "thinking" ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow:
                    phase === "listening"
                      ? `0 0 0 8px ${accent}22, 0 10px 24px rgba(26,42,26,0.3)`
                      : "0 10px 24px rgba(26,42,26,0.25)",
                  opacity: phase === "thinking" ? 0.5 : 1,
                }}
                aria-label={phase === "listening" ? "Stop recording" : "Start recording"}
              >
                {phase === "listening" ? (
                  <Waveform accent={T.paper} bars={5} playing height={22} />
                ) : (
                  <MicIcon size={22} stroke={T.paper} />
                )}
              </motion.button>
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
