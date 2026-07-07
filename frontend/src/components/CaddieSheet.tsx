"use client";

/**
 * CaddieSheet — lean, voice-first AI caddie overlay reachable from the in-round screen.
 *
 * GPS-free. No mapbox, no shot-tracking, no PinMarkControl.
 *
 * Backend paths — session-first, stateless fallback, streaming-first
 * (specs/voice-streaming-replies-plan.md):
 *   • Voice: a 3-tier ladder — POST /caddie/session/voice/stream (SSE, rich
 *     session context: effective yards, hazards, green slope, weather,
 *     cross-round memories, full round conversation) → POST /caddie/voice/stream
 *     (SSE, locally-built context) → POST /caddie/voice (JSON, existing
 *     calm-copy + 1-retry path). Each tier advances only when NO token has
 *     arrived yet (BeforeFirstByteError); once text is rendering, a failure
 *     is terminal — never falls through mid-reply. The sheet always answers.
 *   • Recommend (tap mode, unchanged): POST /caddie/session/recommend, falling
 *     back to POST /caddie/recommend.
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
import { Waveform, PulseDot } from "@/components/yardage/Voice";
import { VoiceRecorder, transcribeBlob } from "@/lib/voice/deepgram";
import { DeepgramLiveTranscriber } from "@/lib/voice/deepgram-live";
import { pickDictationTranscript, isEmptyTranscript, humanizeVoiceError } from "@/lib/caddie/dictation";
import { buildKeyterms } from "@/lib/voice/keyterms";
import {
  talkToCaddie,
  fetchRecommendation,
  sessionRecommend,
  sessionVoiceStream,
  talkToCaddieStream,
  BeforeFirstByteError,
} from "@/lib/caddie/api";
import { getGolferProfile } from "@/lib/storage";
import { buildClubMap } from "@/lib/caddie/clubs";
import { shouldDismissSheetDrag, useBodyScrollLock } from "@/lib/sheet";
import { useStreamBuffer } from "@/lib/caddie/stream-buffer";
import { useSheetTTS } from "@/hooks/useSheetTTS";
import { getSheetTtsEnabled, setSheetTtsEnabled } from "@/lib/voice/tts-pref";
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

/** Quiet speaker glyph — tap-to-silence / mute-toggle affordance (§3). Two
 *  visual states: filled + waves (speaking or enabled), crossed-out (muted). */
function SpeakerIcon({ muted, size = 13, stroke = "currentColor" }: { muted: boolean; size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 15 15" fill="none" stroke={stroke} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5.5h2.3L8 2.7v9.6L4.3 9.5H2z" fill={stroke} fillOpacity={0.18} />
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

  // Spoken caddie replies (specs/voice-tts-sheet-replies-plan.md) — opt-in,
  // default off. Reads the persisted pref lazily so SSR/first-paint stays
  // deterministic; the toggle flips both this state and localStorage.
  const [ttsEnabled, setTtsEnabled] = useState(false);
  useEffect(() => {
    setTtsEnabled(getSheetTtsEnabled());
  }, []);
  const tts = useSheetTTS();

  // Streaming caddie reply (specs/voice-streaming-replies-plan.md). One
  // AbortController per in-flight ask — a new question or a sheet close
  // aborts whatever is still streaming; `isStale()` inside askCaddie compares
  // against the CURRENT ref value so a superseded call's settle is a silent
  // no-op rather than an error flash over the newer turn.
  const streamAbortRef = useRef<AbortController | null>(null);
  const answerBuffer = useStreamBuffer((chunk) => {
    setVoiceAnswer((prev) => (prev ?? "") + chunk);
  });

  const recorderRef = useRef<VoiceRecorder | null>(null);
  // Live dictation (specs/caddie-live-dictation-plan.md): the streaming
  // transcript is authoritative — the recorded blob is only the fallback.
  const liveRef = useRef<DeepgramLiveTranscriber | null>(null);
  const liveTranscriptRef = useRef("");
  const liveFailedRef = useRef(false);
  // Bumped on every open/close so stale async (a late interim, a late
  // transcription) from a previous sheet lifetime is dropped.
  const openGenRef = useRef(0);
  // Auto-send indirection: UtteranceEnd fires stopListening (defined later).
  const autoStopRef = useRef<() => void>(() => {});

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
    openGenRef.current++; // invalidate any in-flight async from the previous lifetime
    if (!open) {
      recorderRef.current?.cancel();
      liveRef.current?.stop();
      liveRef.current = null;
      liveTranscriptRef.current = "";
      liveFailedRef.current = false;
      tts.stop(); // sheet close mid-playback (§7 edge case)
      streamAbortRef.current?.abort(); // close mid-stream — never persisted server-side either
      streamAbortRef.current = null;
      answerBuffer.cancel();
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
      liveRef.current?.stop();
      liveRef.current = null;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!VoiceRecorder.isSupported()) {
      setIsSupported(false);
    }
  }, []);

  // Derive display phase from state.
  //
  // `voiceAnswer` is checked BEFORE `isThinking` so a streaming reply
  // (specs/voice-streaming-replies-plan.md) renders progressively into the
  // "answered" bubble the moment the first coalesced chunk lands, instead of
  // staying pinned on the "thinking…" pulse until the whole turn completes —
  // isThinking stays true for the WHOLE turn (it only flips false once the
  // ladder fully resolves), so without this ordering the answer would be
  // built up invisibly behind the spinner.
  const phase: Phase =
    isListening
      ? "listening"
      : isTranscribing
      ? "transcribing"
      : voiceAnswer
      ? "answered"
      : isThinking
      ? "thinking"
      : isRecThinking
      ? "rec-thinking"
      : error
      ? "error"
      : recommendation
      ? "recommended"
      : "idle";

  // ── Voice path ───────────────────────────────────────────────────────────

  /**
   * Ask the caddie with a question — streaming-first, 3-tier ladder
   * (specs/voice-streaming-replies-plan.md):
   *   1. session-stream    sessionVoiceStream  — rich session context, live
   *   2. stateless-stream  talkToCaddieStream  — locally-built context, live
   *   3. stateless         talkToCaddie        — existing calm-copy + 1-retry
   *
   * Each tier only advances to the next on a `BeforeFirstByteError` (no
   * first token arrived yet — pre-first-byte, fallback-eligible). The moment
   * a first token renders, any further failure on that tier is TERMINAL: it
   * surfaces a calm error and discards the partial rather than falling
   * through to a lower tier, which would double-render/double-speak on top
   * of text already on screen (plan §5, §Risks 1).
   *
   * Reads convHistory from the ref (#1) so it is always current regardless of
   * when this closure was captured. onUpdateConvHistory is stable (parent
   * useState setter), so deps are safe.
   */
  const askCaddie = useCallback(
    async (question: string) => {
      // A new question supersedes whatever the previous one was still doing.
      streamAbortRef.current?.abort();
      const controller = new AbortController();
      streamAbortRef.current = controller;
      answerBuffer.cancel();
      // True once a NEWER ask (or a sheet close) has taken over — this call's
      // eventual settle is then a silent no-op, never an error flash over
      // whatever the newer call is doing.
      const isStale = () => streamAbortRef.current !== controller;

      setIsThinking(true);
      setError(null);
      setVoiceAnswer(null);
      const currentHistory = convHistoryRef.current;
      const onToken = (delta: string) => answerBuffer.push(delta);

      const askStatelessNonStream = async (): Promise<string> => {
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

      const askStatelessStream = async (): Promise<string> => {
        const profile = getGolferProfile();
        const clubMap = buildClubMap();
        return talkToCaddieStream(
          {
            transcript: question,
            personality_id: personaId,
            hole_number: holeNumber,
            par: holePar,
            yards: holeYards,
            club_distances: Object.keys(clubMap).length > 0 ? clubMap : undefined,
            handicap: profile?.handicap ?? undefined,
            conversation_history: currentHistory,
          },
          { onToken, signal: controller.signal },
        );
      };

      try {
        let responseText: string;
        if (sessionActive && roundId) {
          try {
            responseText = await sessionVoiceStream(
              { round_id: roundId, transcript: question, personality_id: personaId, hole_number: holeNumber },
              { onToken, signal: controller.signal },
            );
          } catch (err) {
            if (!(err instanceof BeforeFirstByteError)) throw err; // terminal — a token already rendered
            answerBuffer.cancel();
            try {
              responseText = await askStatelessStream();
            } catch (err2) {
              if (!(err2 instanceof BeforeFirstByteError)) throw err2;
              answerBuffer.cancel();
              responseText = await askStatelessNonStream();
            }
          }
        } else {
          try {
            responseText = await askStatelessStream();
          } catch (err) {
            if (!(err instanceof BeforeFirstByteError)) throw err;
            answerBuffer.cancel();
            responseText = await askStatelessNonStream();
          }
        }
        if (isStale()) return;
        answerBuffer.flush(); // final coalesce before the authoritative set (plan §4.3)

        const newHistory: VoiceCaddieMessage[] = [
          ...currentHistory,
          { role: "user", content: question },
          { role: "assistant", content: responseText },
        ];
        // Update the ref immediately so the next turn sees the latest history
        // even before React re-renders.
        convHistoryRef.current = newHistory;
        onUpdateConvHistory(newHistory);
        setVoiceAnswer(responseText); // authoritative full text — overwrites any partial coalesced render
        tts.speak(responseText, personaId); // fires exactly once, on completion
      } catch (err) {
        if (isStale()) return; // superseded (new question / sheet close) — not a real failure
        answerBuffer.cancel();
        // Discard the partial rather than keep it on screen (plan §5): a
        // truncated caddie reply can be actively misleading (cut mid-club or
        // mid-aim), and the server persisted nothing for this turn either.
        setVoiceAnswer(null);
        setError(
          humanizeVoiceError(err instanceof Error ? err.message : undefined, "Caddie unavailable — try again.")
        );
      } finally {
        if (!isStale()) setIsThinking(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [personaId, sessionActive, roundId, holeNumber, holePar, holeYards, onUpdateConvHistory, tts.speak, answerBuffer]
    // convHistory intentionally absent — read from convHistoryRef.current (#1).
    // tts.speak (not the whole `tts` object) — the hook memoizes it stably, so
    // depending on the full object would recreate askCaddie every render.
  );

  const startListening = useCallback(async () => {
    setError(null);
    setTranscript("");
    setInterimTranscript("");
    setVoiceAnswer(null);
    liveTranscriptRef.current = "";
    liveFailedRef.current = false;
    const gen = openGenRef.current;
    let recorder: VoiceRecorder | null = null;
    try {
      recorder = new VoiceRecorder();
      await recorder.start();
      if (openGenRef.current !== gen) {
        recorder.cancel(); // sheet closed while the mic was being acquired
        return;
      }
      recorderRef.current = recorder;
      setIsListening(true);

      // Live dictation: stream the SAME mic stream to Deepgram so the words
      // appear as the golfer speaks, and the live final becomes the message
      // (no post-stop "Transcribing…"). The recorder keeps running for the
      // whole utterance so the blob fallback always exists.
      const stream = recorder.getStream();
      if (stream && DeepgramLiveTranscriber.isSupported()) {
        try {
          const live = new DeepgramLiveTranscriber(
            {
              onInterim: (t) => {
                if (openGenRef.current !== gen) return;
                liveTranscriptRef.current = t;
                setInterimTranscript(t);
              },
              onFinal: (t) => {
                if (openGenRef.current !== gen) return;
                liveTranscriptRef.current = t;
              },
              onUtteranceEnd: () => {
                // Auto-send: end-of-speech = the golfer finished the question.
                if (openGenRef.current !== gen) return;
                autoStopRef.current();
              },
              onError: () => {
                // Non-fatal mid-utterance — the blob fallback covers it.
                liveFailedRef.current = true;
              },
            },
            { keyterms: buildKeyterms() },
          );
          await live.start(stream);
          if (openGenRef.current !== gen) {
            live.stop();
            return;
          }
          liveRef.current = live;
        } catch {
          // Token/socket failure — dictate via the blob fallback instead.
          liveFailedRef.current = true;
          liveRef.current = null;
        }
      } else {
        // Older WKWebView without MediaRecorder streaming — fallback path.
        liveFailedRef.current = true;
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
    const gen = openGenRef.current;
    // Snapshot BEFORE stopping the stream — the best-so-far live transcript.
    const snapshot = liveTranscriptRef.current;
    liveRef.current?.stop();
    liveRef.current = null;
    setInterimTranscript("");
    setIsListening(false);
    try {
      const pick = pickDictationTranscript(snapshot, liveFailedRef.current);
      let finalText: string;
      if (pick.source === "live") {
        // The words are already on screen — straight to thinking, no
        // "Transcribing…" dead state, no audio upload.
        recorder.cancel(); // release the mic; the blob isn't needed
        finalText = pick.transcript;
      } else {
        // Fallback (live unsupported / failed / heard nothing): today's
        // record→upload path, where a brief "Transcribing…" is honest.
        setIsTranscribing(true);
        const blob = await recorder.stop();
        const result = await transcribeBlob(blob, { keyterms: buildKeyterms() });
        if (openGenRef.current !== gen) return;
        finalText = result.transcript;
      }
      if (isEmptyTranscript(finalText)) {
        setError("No speech detected. Tap the mic to try again.");
        return;
      }
      if (openGenRef.current !== gen) return;
      setTranscript(finalText);
      // Auto-call caddie with the finalized transcript
      await askCaddie(finalText);
    } catch (err) {
      if (openGenRef.current === gen) {
        setError(
          humanizeVoiceError(err instanceof Error ? err.message : undefined, "Lost that one — tap the mic and try again.")
        );
      }
    } finally {
      recorderRef.current = null;
      setIsTranscribing(false);
    }
  }, [askCaddie]);

  autoStopRef.current = () => void stopListening();

  const handleMicTap = () => {
    // Bless the <audio> element in the SAME gesture as dictation start — must
    // run synchronously, before any async work below (§3 iOS unlock wiring).
    tts.unlock();
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
        humanizeVoiceError(err instanceof Error ? err.message : undefined, "Caddie unavailable — try again.")
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
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                {/* Caddie identifier — tap to switch persona (quiet picker) */}
                <button
                  onClick={() => setPersonaPickerOpen((v) => !v)}
                  aria-label="Change caddie persona"
                  aria-expanded={personaPickerOpen}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
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

                {/* Spoken replies toggle — quiet, minor control (§3). Idle tap
                    flips the mute pref; a tap while speaking silences it. */}
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
                      ? "Silence caddie voice"
                      : ttsEnabled
                      ? "Turn off spoken replies"
                      : "Turn on spoken replies"
                  }
                  aria-pressed={ttsEnabled}
                  style={{
                    // 44×44 hit area for on-course glove use (the app's own
                    // ≥44pt standard); negative margin keeps the visual footprint
                    // at the 22px circle so the header row layout is unchanged.
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 44,
                    height: 44,
                    margin: -11,
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
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      border: `1px solid ${T.hairline}`,
                      background: tts.isSpeaking ? `${accent}1f` : "transparent",
                      color: tts.isSpeaking ? accent : ttsEnabled ? T.pencil : T.pencilSoft,
                    }}
                  >
                    <SpeakerIcon muted={!ttsEnabled && !tts.isSpeaking} size={11} />
                  </span>
                </button>
              </div>

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
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <PulseDot accent={accent} />
              <StatusNote>
                {caddy.name} is thinking…
              </StatusNote>
            </div>
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
