"use client";

/**
 * CaddieSheet — lean, voice-first AI caddie overlay reachable from the in-round screen.
 *
 * GPS-free. No mapbox, no shot-tracking, no PinMarkControl.
 *
 * Backend paths — session-first, stateless fallback:
 *   • POST /caddie/session/voice + /caddie/session/recommend — when the round
 *     has an active caddie session (started by RoundPageClient on mount), the
 *     sheet gets the rich server-side context: effective yards, hazards, green
 *     slope, weather, cross-round memories, and the full round conversation.
 *   • POST /caddie/voice + /caddie/recommend — legacy/offline rounds (no
 *     session), or any session call that fails, fall back to the stateless
 *     path with locally-built context. The sheet always answers.
 *
 * Design: yardage-book aesthetic only — T.* tokens, PAPER_NOISE, Instrument Serif,
 * inline SVGs. Mirrors VoiceRoundSetup recording UX (VoiceRecorder + transcribeBlob
 * + Web Speech API interim display).
 *
 * Architecture notes:
 *   • convHistory is lifted to the parent (RoundPageClient) so closing to enter a score
 *     then reopening continues the same thread. #9
 *   • convHistoryRef keeps a ref in sync with the prop so askCaddie reads the latest
 *     history without closing over stale state — fixes multi-turn voice memory. #1
 *   • Mic button lives outside the scroll area (non-scrolling bottom block) so it stays
 *     on screen as conversation history grows. #2
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import type { Caddy } from "@/components/yardage/tokens";
import { Waveform } from "@/components/yardage/Voice";
import { VoiceRecorder, transcribeBlob } from "@/lib/voice/deepgram";
import {
  talkToCaddie,
  fetchRecommendation,
  sessionVoice,
  sessionRecommend,
} from "@/lib/caddie/api";
import { getGolferProfile } from "@/lib/storage";
import { buildClubMap } from "@/lib/caddie/clubs";
import { shouldDismissSheetDrag, useBodyScrollLock } from "@/lib/sheet";
import type {
  CaddieRecommendation,
  VoiceCaddieMessage,
  CaddiePersonalityInfo,
} from "@/lib/caddie/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CaddieSheetProps {
  open: boolean;
  onClose: () => void;
  caddy: Caddy;
  accent: string;
  holeNumber: number;
  holePar: number;
  holeYards: number;
  /** Conversation history — owned by parent so it persists across close/reopen. */
  convHistory: VoiceCaddieMessage[];
  onUpdateConvHistory: (history: VoiceCaddieMessage[]) => void;
  /** The active round id — keys the session endpoints. */
  roundId: string;
  /**
   * True when RoundPageClient successfully started a caddie session for this
   * round. False (legacy/offline/local rounds) keeps the sheet on the
   * stateless /caddie/voice + /caddie/recommend path it used before.
   */
  sessionActive: boolean;
  /** Real backend persona id (classic/strategist/hype/professor/custom-…). */
  personaId: string;
  /** Personas visible to the user — drives the header picker. */
  personas: CaddiePersonalityInfo[];
  onSelectPersona: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Inline icon helpers (no lucide-react)
// ---------------------------------------------------------------------------

function MicIcon({ size = 26, stroke = "currentColor" }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M1.5 1.5l10 10M11.5 1.5l-10 10" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M2 1v9" />
      <path d="M2 1.8L8 3.5 2 5.2V1.8Z" fill="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "answered"
  | "rec-thinking"
  | "recommended"
  | "error";

type Mode = "voice" | "tap";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CaddieSheet({
  open,
  onClose,
  caddy,
  accent,
  holeNumber,
  holePar,
  holeYards,
  convHistory,
  onUpdateConvHistory,
  roundId,
  sessionActive,
  personaId,
  personas,
  onSelectPersona,
}: CaddieSheetProps) {
  // Controls the swipe-down-to-dismiss drag, started from the grab handle only.
  const dragControls = useDragControls();
  // Lock the page behind the sheet so a swipe on the grab handle can't fall
  // through to scroll the background (esp. iOS WKWebView rubber-banding).
  useBodyScrollLock(open);
  const [mode, setMode] = useState<Mode>("voice");

  // Voice mode state
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [transcript, setTranscript] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [voiceAnswer, setVoiceAnswer] = useState<string | null>(null);

  // Tap mode state
  const [distanceInput, setDistanceInput] = useState("");
  const [isRecThinking, setIsRecThinking] = useState(false);
  const [recommendation, setRecommendation] = useState<CaddieRecommendation | null>(null);

  // Shared
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  // Compact persona list toggled from the header identifier row.
  const [personaPickerOpen, setPersonaPickerOpen] = useState(false);

  const recorderRef = useRef<VoiceRecorder | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  /**
   * Ref mirror of convHistory prop. askCaddie reads from this ref so it
   * always sees the latest history without capturing stale state in its
   * closure — the root cause of multi-turn memory loss (#1).
   */
  const convHistoryRef = useRef<VoiceCaddieMessage[]>(convHistory);
  useEffect(() => {
    convHistoryRef.current = convHistory;
  }, [convHistory]);

  // Cleanup on close. History intentionally NOT cleared here — it is owned
  // by the parent so closing to enter a score then reopening continues the
  // thread (#9).
  useEffect(() => {
    if (!open) {
      recorderRef.current?.cancel();
      recognitionRef.current?.abort();
      setIsListening(false);
      setInterimTranscript("");
      setTranscript("");
      setIsTranscribing(false);
      setIsThinking(false);
      setVoiceAnswer(null);
      setDistanceInput("");
      setIsRecThinking(false);
      setRecommendation(null);
      setError(null);
      setMode("voice");
      setPersonaPickerOpen(false);
    }
    return () => {
      recorderRef.current?.cancel();
      recognitionRef.current?.abort();
    };
  }, [open]);

  useEffect(() => {
    if (!VoiceRecorder.isSupported()) {
      setIsSupported(false);
    }
  }, []);

  // Derive display phase from state
  const phase: Phase =
    isListening
      ? "listening"
      : isTranscribing
      ? "transcribing"
      : isThinking
      ? "thinking"
      : isRecThinking
      ? "rec-thinking"
      : error
      ? "error"
      : recommendation
      ? "recommended"
      : voiceAnswer
      ? "answered"
      : "idle";

  // ── Voice path ───────────────────────────────────────────────────────────

  /**
   * Ask the caddie with a question. Session-first: the round session carries
   * the rich context (hole intel, weather, memories, whole-round conversation)
   * server-side. Any session failure — or no session at all — falls back to
   * the stateless path with locally-built context, so the sheet always answers.
   *
   * Reads convHistory from the ref (#1) so it is always current regardless of
   * when this closure was captured. onUpdateConvHistory is stable (parent
   * useState setter), so deps are safe.
   */
  const askCaddie = useCallback(
    async (question: string) => {
      setIsThinking(true);
      setError(null);
      const currentHistory = convHistoryRef.current;

      const askStateless = async (): Promise<string> => {
        const profile = getGolferProfile();
        const clubMap = buildClubMap();
        const res = await talkToCaddie({
          transcript: question,
          personality_id: personaId,
          hole_number: holeNumber,
          par: holePar,
          yards: holeYards,
          club_distances: Object.keys(clubMap).length > 0 ? clubMap : undefined,
          handicap: profile?.handicap ?? undefined,
          conversation_history: currentHistory,
        });
        return res.response;
      };

      try {
        let responseText: string;
        if (sessionActive && roundId) {
          try {
            const res = await sessionVoice({
              round_id: roundId,
              transcript: question,
              personality_id: personaId,
              hole_number: holeNumber,
            });
            responseText = res.response;
          } catch {
            // Session expired/unreachable — silent downgrade, keep answering.
            responseText = await askStateless();
          }
        } else {
          responseText = await askStateless();
        }
        const newHistory: VoiceCaddieMessage[] = [
          ...currentHistory,
          { role: "user", content: question },
          { role: "assistant", content: responseText },
        ];
        // Update the ref immediately so the next turn sees the latest history
        // even before React re-renders.
        convHistoryRef.current = newHistory;
        onUpdateConvHistory(newHistory);
        setVoiceAnswer(responseText);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message.length > 80
              ? "Caddie unavailable — check connection."
              : err.message
            : "Caddie unavailable."
        );
      } finally {
        setIsThinking(false);
      }
    },
    [personaId, sessionActive, roundId, holeNumber, holePar, holeYards, onUpdateConvHistory]
    // convHistory intentionally absent — read from convHistoryRef.current (#1)
  );

  const startListening = useCallback(async () => {
    setError(null);
    setTranscript("");
    setInterimTranscript("");
    setVoiceAnswer(null);
    let recorder: VoiceRecorder | null = null;
    try {
      recorder = new VoiceRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setIsListening(true);

      // Best-effort Web Speech API for live interim display.
      // Deepgram (transcribeBlob) is authoritative for final transcript.
      const SpeechRecognitionCtor =
        (typeof window !== "undefined" &&
          (window.SpeechRecognition ?? window.webkitSpeechRecognition)) ||
        null;
      if (SpeechRecognitionCtor) {
        // If recognition.start() throws after the recorder started, cancel
        // the recorder so the mic doesn't stay hot (#12).
        try {
          const recognition = new SpeechRecognitionCtor();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = "en-US";
          recognition.onresult = (event: SpeechRecognitionEvent) => {
            let interim = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
              interim += event.results[i][0].transcript;
            }
            setInterimTranscript(interim);
          };
          recognition.onerror = () => {
            /* Deepgram is authoritative — interim errors are non-fatal */
          };
          recognition.onend = () => {
            /* no-op; abort() is called explicitly on stop */
          };
          recognition.start();
          recognitionRef.current = recognition;
        } catch {
          // Recognition failed to start — cancel the recorder so the mic stream
          // is released and we don't leave the mic open (#12).
          recorder.cancel();
          recorderRef.current = null;
          setIsListening(false);
          throw new Error("Failed to start voice recognition.");
        }
      }
    } catch (err) {
      setError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone access denied."
          : err instanceof Error
          ? err.message
          : "Failed to start microphone."
      );
    }
  }, []);

  /**
   * stopListening depends on askCaddie. askCaddie is stable (ref-based history,
   * no convHistory state in deps), so no eslint-disable needed.
   */
  const stopListening = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setInterimTranscript("");
    setIsListening(false);
    setIsTranscribing(true);
    try {
      const blob = await recorder.stop();
      const result = await transcribeBlob(blob);
      if (!result.transcript.trim()) {
        setError("No speech detected. Tap the mic to try again.");
        return;
      }
      setTranscript(result.transcript);
      // Auto-call caddie after transcription
      await askCaddie(result.transcript);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      recorderRef.current = null;
      setIsTranscribing(false);
    }
  }, [askCaddie]);

  const handleMicTap = () => {
    if (isListening) {
      stopListening();
    } else if (!isTranscribing && !isThinking) {
      startListening();
    }
  };

  const handleFollowUp = () => {
    // Reset answer display but keep convHistory (in parent) for context
    setTranscript("");
    setVoiceAnswer(null);
    setError(null);
  };

  // ── Tap / distance path ──────────────────────────────────────────────────

  const handleGetRecommendation = useCallback(async () => {
    const dist = parseInt(distanceInput, 10);
    if (!dist || dist < 1 || dist > 800) {
      setError("Enter a valid distance (1–800 yards).");
      return;
    }
    setError(null);
    setRecommendation(null);
    setIsRecThinking(true);

    // Stateless fallback — locally-built context (legacy/offline rounds, or a
    // session call that failed).
    const recStateless = async (): Promise<CaddieRecommendation> => {
      const profile = getGolferProfile();
      const clubMap = buildClubMap();
      return fetchRecommendation({
        hole_number: holeNumber,
        distance_yards: dist,
        par: holePar,
        yards: holeYards,
        club_distances: Object.keys(clubMap).length > 0 ? clubMap : undefined,
        handicap: profile?.handicap ?? undefined,
      });
    };

    try {
      let rec: CaddieRecommendation;
      if (sessionActive && roundId) {
        try {
          // Session path — server already holds clubs, handicap, hole intel,
          // weather, and personal stats from /session/start + course-intel.
          rec = await sessionRecommend({
            round_id: roundId,
            hole_number: holeNumber,
            distance_yards: dist,
            par: holePar,
            yards: holeYards,
          });
        } catch {
          rec = await recStateless();
        }
      } else {
        rec = await recStateless();
      }
      setRecommendation(rec);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.length > 80
            ? "Caddie unavailable — check connection."
            : err.message
          : "Caddie unavailable."
      );
    } finally {
      setIsRecThinking(false);
    }
  }, [holeNumber, holePar, holeYards, distanceInput, sessionActive, roundId]);

  // ── Render ───────────────────────────────────────────────────────────────

  const showMic = mode === "voice" && phase !== "transcribing" && phase !== "thinking";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="cs-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(26,42,26,0.32)",
            backdropFilter: "blur(3px)",
            zIndex: 50,
            // Swallow touch-move on the backdrop so the page underneath can't
            // scroll; the body lock above is the primary guard, this is belt-and-braces.
            touchAction: "none",
            overscrollBehavior: "contain",
          }}
        />
      )}

      {open && (
        <motion.div
          key="cs-sheet"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={T.springSoft}
          // Swipe down to dismiss — started ONLY from the grab handle (below) via
          // dragControls, so the sheet's inner content still scrolls normally. A
          // drag past ~120px or a downward flick closes it; else it springs back.
          drag="y"
          dragListener={false}
          dragControls={dragControls}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.6 }}
          onDragEnd={(_e, info) => {
            if (shouldDismissSheetDrag(info.offset.y, info.velocity.y)) onClose();
          }}
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 60,
            background: `${PAPER_NOISE}, ${T.paper}`,
            backgroundBlendMode: "multiply",
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            maxWidth: 420,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            maxHeight: "88dvh",
            paddingBottom: "env(safe-area-inset-bottom)",
            boxShadow: "0 -8px 40px rgba(26,42,26,0.18)",
            touchAction: "pan-y",
          }}
        >
          {/* Drag handle — starts the swipe-down-to-dismiss drag. Generous,
              invisible touch target around the visible bar for an easy grab. */}
          <div
            onPointerDown={(e) => dragControls.start(e)}
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              height: 44, // ≥44pt touch target — easy grab on-course with gloves
              flexShrink: 0,
              cursor: "grab",
              touchAction: "none",
            }}
          >
            <div
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                background: T.hairline,
              }}
            />
          </div>

          {/* Header */}
          <div
            style={{
              padding: "12px 20px 12px",
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              borderBottom: `1px solid ${T.hairline}`,
              flexShrink: 0,
            }}
          >
            <div>
              {/* Caddie identifier — tap to switch persona (quiet picker) */}
              <button
                onClick={() => setPersonaPickerOpen((v) => !v)}
                aria-label="Change caddie persona"
                aria-expanded={personaPickerOpen}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  marginBottom: 3,
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  cursor: "pointer",
                  minHeight: 28,
                }}
              >
                {/* Caddie initial medallion */}
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 11,
                    color: T.paper, // #5 — cream not white
                    flexShrink: 0,
                  }}
                >
                  {caddy.initial}
                </div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.5,
                    color: T.pencil,
                    textTransform: "uppercase",
                  }}
                >
                  {caddy.name} &middot; On the bag
                </div>
                {/* Chevron — hints the persona list */}
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  fill="none"
                  stroke={T.pencilSoft}
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  style={{
                    transform: personaPickerOpen ? "rotate(180deg)" : "none",
                    transition: "transform 0.18s",
                    flexShrink: 0,
                  }}
                >
                  <path d="M1.5 3l2.5 2.5L6.5 3" />
                </svg>
              </button>

              {/* Title */}
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 21,
                  letterSpacing: -0.3,
                  color: T.ink,
                  lineHeight: 1.1,
                }}
              >
                Ask your caddie
              </div>

              {/* Hole context chip */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  marginTop: 5,
                  color: T.pencil,
                }}
              >
                <FlagIcon />
                <span
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.3,
                    textTransform: "uppercase",
                  }}
                >
                  Hole {holeNumber} &middot; Par {holePar} &middot; {holeYards} yds
                </span>
              </div>
            </div>

            {/* Close button — 44×44 (#4) */}
            <button
              onClick={onClose}
              aria-label="Close caddie sheet"
              style={{
                minWidth: 44,
                minHeight: 44,
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
            >
              <CloseIcon />
            </button>
          </div>

          {/* Persona picker — compact list under the header, yardage-book quiet */}
          <AnimatePresence>
            {personaPickerOpen && personas.length > 0 && (
              <motion.div
                key="persona-picker"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                style={{
                  overflow: "hidden",
                  borderBottom: `1px solid ${T.hairline}`,
                  flexShrink: 0,
                }}
              >
                <div style={{ maxHeight: 200, overflowY: "auto", padding: "8px 20px 10px" }}>
                  {personas.map((p) => {
                    const selected = p.id === personaId;
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          onSelectPersona(p.id);
                          setPersonaPickerOpen(false);
                        }}
                        aria-label={`Choose ${p.name}`}
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 8,
                          width: "100%",
                          textAlign: "left",
                          padding: "10px 2px",
                          border: "none",
                          borderBottom: `1px solid ${T.hairline}`,
                          background: "transparent",
                          cursor: "pointer",
                          minHeight: 44,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: T.serif,
                            fontStyle: "italic",
                            fontSize: 15,
                            color: selected ? accent : T.ink,
                            letterSpacing: -0.2,
                            flexShrink: 0,
                          }}
                        >
                          {p.name}
                        </span>
                        <span
                          style={{
                            fontFamily: T.mono,
                            fontSize: 8.5,
                            letterSpacing: 0.6,
                            color: T.pencilSoft,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {p.description}
                        </span>
                        {selected && (
                          <span
                            style={{
                              fontFamily: T.mono,
                              fontSize: 8,
                              letterSpacing: 1.2,
                              color: accent,
                              textTransform: "uppercase",
                              flexShrink: 0,
                            }}
                          >
                            On the bag
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Mode toggle — 44pt tap target (#3) */}
          <div
            style={{
              display: "flex",
              gap: 0,
              padding: "0 20px",
              flexShrink: 0,
            }}
          >
            {(["voice", "tap"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                style={{
                  flex: 1,
                  padding: "16px 0", // #3 — was 7px, raised to 44pt
                  border: "none",
                  borderBottom: `2px solid ${mode === m ? accent : T.hairline}`,
                  background: "transparent",
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.4,
                  textTransform: "uppercase",
                  color: mode === m ? accent : T.pencil,
                  cursor: "pointer",
                  transition: "color 0.15s, border-color 0.15s",
                }}
              >
                {m === "voice" ? "Voice" : "Distance"}
              </button>
            ))}
          </div>

          {/* Scrollable body — mic is NOT in here for voice mode (#2) */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "18px 20px 20px",
              WebkitOverflowScrolling: "touch" as React.CSSProperties["WebkitOverflowScrolling"],
            }}
          >
            {mode === "voice" ? (
              <VoiceBody
                phase={phase}
                isSupported={isSupported}
                interimTranscript={interimTranscript}
                transcript={transcript}
                voiceAnswer={voiceAnswer}
                convHistory={convHistory}
                error={error}
                accent={accent}
                caddy={caddy}
                onFollowUp={handleFollowUp}
                onClear={() => {
                  onUpdateConvHistory([]);
                  setVoiceAnswer(null);
                  setTranscript("");
                  setError(null);
                }}
              />
            ) : (
              <TapBody
                phase={phase}
                distanceInput={distanceInput}
                recommendation={recommendation}
                error={error}
                accent={accent}
                caddy={caddy}
                onDistanceChange={setDistanceInput}
                onSubmit={handleGetRecommendation}
                onClear={() => {
                  setRecommendation(null);
                  setDistanceInput("");
                  setError(null);
                }}
              />
            )}
          </div>

          {/*
           * Mic button — non-scrolling bottom block (#2).
           * Rendered OUTSIDE the scroll area so it stays fixed as
           * conversation history grows. Mirrors Voice.tsx:239-298 vmic pattern.
           */}
          {showMic && (
            <div
              style={{
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: "14px 20px 18px",
                borderTop: `1px solid ${T.hairline}`,
              }}
            >
              <motion.button
                onClick={handleMicTap}
                whileTap={{ scale: 0.93 }}
                aria-label={isListening ? "Stop recording" : "Start recording"}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: "50%",
                  border: isListening
                    ? `2px solid ${accent}`
                    : `1px solid ${T.hairline}`,
                  background: isListening ? accent : T.paperDeep,
                  color: isListening ? T.paper : T.ink, // #5 — cream not white
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: isListening
                    ? `0 0 0 6px ${accent}22`
                    : "none",
                  transition: "background 0.18s, border-color 0.18s, box-shadow 0.18s",
                }}
              >
                <MicIcon size={26} />
              </motion.button>

              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencil,
                  textTransform: "uppercase",
                }}
              >
                {isListening
                  ? "Tap to stop"
                  : phase === "idle" || phase === "error"
                  ? "Tap to speak"
                  : "Tap to ask again"}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: VoiceBody (scroll area content only — mic is in parent)
// ---------------------------------------------------------------------------

interface VoiceBodyProps {
  phase: Phase;
  isSupported: boolean;
  interimTranscript: string;
  transcript: string;
  voiceAnswer: string | null;
  convHistory: VoiceCaddieMessage[];
  error: string | null;
  accent: string;
  caddy: Caddy;
  onFollowUp: () => void;
  onClear: () => void;
}

function VoiceBody({
  phase,
  isSupported,
  interimTranscript,
  transcript,
  voiceAnswer,
  convHistory,
  error,
  accent,
  caddy,
  onFollowUp,
  onClear,
}: VoiceBodyProps) {
  if (!isSupported) {
    return (
      <StatusNote>
        Voice recording not supported in this browser.
      </StatusNote>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Conversation history (all prior turns except current) */}
      {convHistory.length > 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {convHistory.slice(0, -2).map((msg, i) => (
            <div
              key={i}
              style={{
                padding: "9px 12px",
                borderRadius: 12,
                background: msg.role === "user" ? T.paperDeep : T.paperEdge,
                border: `1px solid ${T.hairline}`,
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 8,
                  letterSpacing: 1.3,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                  marginBottom: 3,
                }}
              >
                {msg.role === "user" ? "You" : caddy.name}
              </div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: msg.role === "assistant" ? "italic" : "normal",
                  fontSize: 14,
                  color: T.ink,
                  lineHeight: 1.45,
                  letterSpacing: -0.1,
                }}
              >
                {msg.content}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Current / most recent turn */}
      <AnimatePresence mode="wait">
        {phase === "answered" && voiceAnswer ? (
          <motion.div
            key="voice-answer"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
          >
            {/* User's question */}
            {transcript && (
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  color: T.pencil,
                  letterSpacing: 0.5,
                  marginBottom: 10,
                  lineHeight: 1.4,
                }}
              >
                &ldquo;{transcript}&rdquo;
              </div>
            )}

            {/* Caddie answer */}
            <div
              style={{
                padding: "14px 16px",
                borderRadius: 16,
                background: T.paperDeep,
                border: `1px solid ${T.hairline}`,
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1.3,
                  color: accent,
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                {caddy.name}
              </div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 18,
                  color: T.ink,
                  lineHeight: 1.5,
                  letterSpacing: -0.2,
                }}
              >
                {voiceAnswer}
              </div>
            </div>

            {/* Follow-up / clear */}
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 14,
              }}
            >
              <button
                onClick={onFollowUp}
                style={{
                  flex: 1,
                  padding: "11px 0",
                  borderRadius: 99,
                  border: `1px solid ${T.hairline}`,
                  background: "transparent",
                  color: T.ink,
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 14,
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                Ask follow-up
              </button>
              {convHistory.length > 2 && (
                <button
                  onClick={onClear}
                  style={{
                    padding: "11px 14px",
                    borderRadius: 99,
                    border: `1px solid ${T.hairline}`,
                    background: "transparent",
                    color: T.pencil,
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.2,
                    textTransform: "uppercase",
                    cursor: "pointer",
                    lineHeight: 1,
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </motion.div>
        ) : phase === "listening" ? (
          <motion.div
            key="voice-listening"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
              paddingTop: 8,
            }}
          >
            <Waveform accent={accent} playing bars={22} height={20} />
            {/* Both "Hearing…" and interim text use same serif-italic 15px style (#8) */}
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 15,
                color: T.inkSoft,
                textAlign: "center",
                lineHeight: 1.4,
                letterSpacing: -0.1,
              }}
            >
              {interimTranscript
                ? `“${interimTranscript}”`
                : "Hearing…"}
            </div>
          </motion.div>
        ) : phase === "transcribing" ? (
          <motion.div
            key="voice-transcribing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ textAlign: "center", paddingTop: 8 }}
          >
            <StatusNote>Transcribing…</StatusNote>
          </motion.div>
        ) : phase === "thinking" ? (
          <motion.div
            key="voice-thinking"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ paddingTop: 8 }}
          >
            {transcript && (
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  color: T.pencil,
                  letterSpacing: 0.5,
                  marginBottom: 10,
                  lineHeight: 1.4,
                }}
              >
                &ldquo;{transcript}&rdquo;
              </div>
            )}
            <StatusNote>
              {caddy.name} is thinking…
            </StatusNote>
          </motion.div>
        ) : phase === "error" ? (
          <motion.div
            key="voice-error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                background: T.errorWash,
                border: `1px solid ${T.errorInk}33`,
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 14,
                color: T.errorInk,
                lineHeight: 1.4,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Idle prompt */}
      {phase === "idle" && (
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
            textAlign: "center",
            lineHeight: 1.5,
            letterSpacing: -0.1,
          }}
        >
          Ask anything — &ldquo;what club from 150?&rdquo;, &ldquo;how do I play
          this hole?&rdquo;, &ldquo;lay up or go for it?&rdquo;
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: TapBody
// ---------------------------------------------------------------------------

interface TapBodyProps {
  phase: Phase;
  distanceInput: string;
  recommendation: CaddieRecommendation | null;
  error: string | null;
  accent: string;
  caddy: Caddy;
  onDistanceChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
}

function TapBody({
  phase,
  distanceInput,
  recommendation,
  error,
  accent,
  caddy,
  onDistanceChange,
  onSubmit,
  onClear,
}: TapBodyProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Distance input row */}
      <div>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.4,
            color: T.pencil,
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Yards to pin
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="number"
            inputMode="numeric"
            placeholder="e.g. 155"
            value={distanceInput}
            onChange={(e) => onDistanceChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
            style={{
              flex: 1,
              padding: "12px 14px",
              borderRadius: 12,
              border: `1px solid ${T.hairline}`,
              background: T.paperDeep,
              fontFamily: T.mono,
              fontSize: 20,
              color: T.ink,
              outline: "none",
              fontVariantNumeric: "tabular-nums",
              // Remove default number spinners (#10)
              MozAppearance: "textfield",
              WebkitAppearance: "none",
            } as React.CSSProperties}
          />
          <motion.button
            onClick={onSubmit}
            whileTap={{ scale: 0.96 }}
            disabled={phase === "rec-thinking"}
            style={{
              padding: "12px 18px",
              borderRadius: 12,
              border: "none",
              background: phase === "rec-thinking" ? T.pencilSoft : T.ink,
              color: T.paper,
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 15,
              cursor: phase === "rec-thinking" ? "default" : "pointer",
              flexShrink: 0,
              lineHeight: 1,
            }}
          >
            {phase === "rec-thinking" ? "…" : "Advise"}
          </motion.button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            background: T.errorWash,
            border: `1px solid ${T.errorInk}33`,
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.errorInk,
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}

      {/* Recommendation */}
      <AnimatePresence>
        {recommendation && (
          <motion.div
            key="rec-card"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
          >
            {/* Club call — prominent */}
            <div
              style={{
                padding: "16px 18px",
                borderRadius: 16,
                background: T.paperDeep,
                border: `1px solid ${T.hairline}`,
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1.3,
                  color: accent,
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                {caddy.name}&rsquo;s play
              </div>

              {/* Club */}
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 36,
                  color: T.ink,
                  lineHeight: 1,
                  letterSpacing: -0.8,
                  marginBottom: 4,
                }}
              >
                {recommendation.club}
              </div>

              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9.5,
                  color: T.pencil,
                  letterSpacing: 0.8,
                  marginBottom: 12,
                }}
              >
                {recommendation.target_yards} yds &middot; aim {recommendation.aim_point.description}
              </div>

              {/* Strategy line */}
              {recommendation.reasoning.length > 0 && (
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 16,
                    color: T.inkSoft,
                    lineHeight: 1.5,
                    letterSpacing: -0.1,
                    paddingTop: 10,
                    borderTop: `1px solid ${T.hairline}`,
                  }}
                >
                  {recommendation.reasoning[0]}
                </div>
              )}
            </div>

            {/* Miss side / aggressiveness row */}
            <div
              style={{
                display: "flex",
                gap: 8,
              }}
            >
              <InfoChip label="Miss">
                {recommendation.miss_side.preferred} — {recommendation.miss_side.description}
              </InfoChip>
              {/* Capitalize aggressiveness (#13) */}
              <InfoChip label="Approach">
                {recommendation.aggressiveness.charAt(0).toUpperCase() +
                  recommendation.aggressiveness.slice(1)}
              </InfoChip>
            </div>

            <button
              onClick={onClear}
              style={{
                marginTop: 14,
                padding: "10px 0",
                width: "100%",
                borderRadius: 99,
                border: `1px solid ${T.hairline}`,
                background: "transparent",
                color: T.pencil,
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              New distance
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading feedback (#7) */}
      {phase === "rec-thinking" && (
        <StatusNote>Checking yardages…</StatusNote>
      )}

      {/* Idle hint */}
      {!recommendation && phase !== "rec-thinking" && !error && (
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
            lineHeight: 1.5,
            letterSpacing: -0.1,
          }}
        >
          Enter your distance to the pin and {caddy.name} will recommend a club and a shot strategy.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Micro helpers
// ---------------------------------------------------------------------------

function StatusNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: T.mono,
        fontSize: 10,
        letterSpacing: 1.4,
        color: T.pencil,
        textTransform: "uppercase",
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

function InfoChip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        padding: "9px 12px",
        borderRadius: 12,
        background: T.paperDeep,
        border: `1px solid ${T.hairline}`,
      }}
    >
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 8,
          letterSpacing: 1.2,
          color: T.pencilSoft,
          textTransform: "uppercase",
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 13,
          color: T.ink,
          lineHeight: 1.3,
          letterSpacing: -0.1,
        }}
      >
        {children}
      </div>
    </div>
  );
}
