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
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import type { Caddy } from "@/components/yardage/tokens";
import { Waveform, PulseDot } from "@/components/yardage/Voice";
import { Transcript, ConversationTurn } from "@/components/yardage/Transcript";
import { captionPersonaName } from "@/lib/caddie/persona";
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
import { createSentenceStream } from "@/lib/caddie/sentence-stream";
import { useSheetTTS } from "@/hooks/useSheetTTS";
import { getSheetTtsEnabled, setSheetTtsEnabled } from "@/lib/voice/tts-pref";
import { createCaddieTurnTimer } from "@/lib/voice/caddie-turn-timing";
import type { UseCaddieLiveSessionResult } from "@/hooks/useCaddieLiveSession";
import { buildOpeningGreetingText } from "@/lib/caddie/opening-turn";
import type { RealtimeMessage, RealtimeStatus } from "@/lib/voice/realtime";
import { liveStatusLabel, liveEmptyStateHint } from "@/lib/caddie/live-copy";
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
  /** Resolved yardage (lib/caddie/hole-yardage.ts) — null when nothing honest
   *  is known yet (no GPS fix, no selected-tee data, no card snapshot).
   *  NEVER the mock illustration constant. */
  holeYards: number | null;
  /** Honest basis caption for the header ("204 to the green" / "231 yds ·
   *  black tees" / "—") — parent-computed via `yardageCaption` so every
   *  surface reads the same provenance label. */
  yardsCaption?: string;
  /** Provenance of `holeYards`: 'gps' | 'tee-card' | 'tee-geom' | 'card' |
   *  null — plumbed into every voice request so the caddie's grounding
   *  matches the header (specs/caddie-yardage-gps-selected-tee-plan.md
   *  §2.3/§2.4). 'gps' also drives `distance_to_green_yards`. */
  yardageBasis?: 'gps' | 'tee-card' | 'tee-geom' | 'card' | null;
  /** The golfer's selected tee (e.g. "Black") — labels "from the {tee}
   *  tees" wording; omitted when unknown (legacy rounds). */
  teeName?: string | null;
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
  /** Resolves the golfer's live distance-to-pin (yards) for the auto opening
   *  turn, or null when there is no GPS fix / no green coords / it times out.
   *  Parent owns GPS + course coords; the sheet stays GPS-free. */
  resolveOpeningShot?: () => Promise<{ distanceYards: number; fromTee?: boolean } | null>;
  /**
   * DETACHED live session (specs/caddie-detach-and-language-pin-plan.md, Item
   * B) — CaddieSheet is now an ATTACHER, not the owner: RoundPageClient owns
   * the live Realtime session via `useDetachedCaddieLive` and passes it in.
   * Closing the sheet no longer stops `live` — only `onEndLive` does. `live`
   * is a stable stub (`liveOn` always false) when the round isn't eligible,
   * so this render path is byte-identical to today whenever live never
   * activates.
   */
  live: UseCaddieLiveSessionResult;
  /** True from a user-triggered live start until an explicit end (or a
   *  fallback-while-closed auto-release) — NOT tied to the sheet being open. */
  liveOn: boolean;
  /** Ends the live session (mic cut + gate flip) — wired to the live
   *  footer's END affordance. Does NOT close the sheet by itself; callers
   *  that want both call `onEndLive()` then `onClose()`. */
  onEndLive: () => void;
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

// Conversational hands-free loop (specs/caddie-conversational-loop-plan.md §3.2).
// Hands-free is IMPLICIT — armed whenever the sheet is open, mode is "voice",
// and the persisted speaker pref (ttsEnabled) is on. No new toggle.
const REARM_GRACE_MS = 400; // §3.3 echo guard — wait past playback end before opening the mic
const DEAD_AIR_MS = 6000; // §3.4 — armed but silent too long → drop out
const MAX_EMPTY_STREAK = 2; // §3.4 — consecutive empty/failed loop-armed listens → drop out

// Sentence-level TTS pipelining (specs/caddie-realtime-conversation-plan.md
// §6.5.4, Slice A2) — a completed sentence shorter than this is held and
// merged with the next one before it's sent to TTS, so a 2-word fragment
// mid-stream doesn't burn a whole extra `/speak` proxy call. Tuned so a
// short caddie beat ("Easy 7.") merges with what follows rather than firing
// alone — real caddie replies' opening clauses comfortably clear it.
const MIN_TTS_CHUNK_CHARS = 20;

// Live-mode (Realtime) status → calm copy (specs/caddie-realtime-slice-c1-plan.md
// §5). Mirrors VoiceRoundSetupRealtime's STATUS_LABEL.
/** The models are instructed to emit plain speech, but a stray **bold** or
 * emoji still leaks (owner screenshot: "**Rip the driver, my friend!**").
 * Spoken text must read like speech — strip markers defensively. */
function stripSpokenMarkdown(text: string): string {
  return text.replace(/\*\*/g, "").replace(/(^|\n)#+\s*/g, "$1");
}

// LIVE_STATUS_LABEL now lives in lib/caddie/live-copy.ts alongside
// liveEmptyStateHint, so the two copy sources are testable together for the
// "empty state never contradicts the footer" invariant
// (specs/caddie-voice-reliability-hardening-plan.md §3).

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
  yardsCaption,
  yardageBasis = null,
  teeName = null,
  convHistory,
  onUpdateConvHistory,
  roundId,
  sessionActive,
  personaId,
  personas,
  onSelectPersona,
  resolveOpeningShot,
  live,
  liveOn,
  onEndLive,
}: CaddieSheetProps) {
  // Live GPS distance to the middle of the green — only meaningful when the
  // resolver's basis is 'gps' (specs/caddie-yardage-gps-selected-tee-plan.md
  // §2.3); undefined otherwise so requests never claim a live fix that isn't
  // real.
  const distanceToGreenYards = yardageBasis === "gps" ? holeYards ?? undefined : undefined;
  // Controls the swipe-down-to-dismiss drag, started from the grab handle only.
  const dragControls = useDragControls();
  // Lock the page behind the sheet so a swipe on the grab handle can't fall
  // through to scroll the background (esp. iOS WKWebView rubber-banding).
  useBodyScrollLock(open);
  const [mode, setMode] = useState<Mode>("voice");

  // Live mode (Realtime transport) — DETACHED from the sheet
  // (specs/caddie-detach-and-language-pin-plan.md, Item B): `live`/`liveOn`
  // are owned by RoundPageClient via `useDetachedCaddieLive` and passed in as
  // props. CaddieSheet is an ATTACHER — it renders from whatever session is
  // handed to it and never mints/tears one down itself.
  //
  // Eligible for live AND hasn't fallen back this activation — gates both
  // the render swap and the classic effects below. `open` still gates the
  // RENDER (a detached-but-live session shows the live footer/body only
  // while the sheet is actually open). `connect-failed` (specs/caddie-live
  // -p0-connect-hole-plan.md §2.3) is excluded too — while open, it swaps to
  // the classic tap-to-talk body exactly like `fellBack`, an honest, visible,
  // usable state instead of a dead/stalled live view.
  const liveActive = open && liveOn && !live.fellBack && live.liveState !== "connect-failed";
  // Live was attempted but degraded (mint-timeout / connect-fail / mic-deny)
  // — render the classic voice UI plus a calm, honest mode label. Also true
  // for `connect-failed` — the chip mechanism is reused (designer may want
  // distinct copy for it later).
  const showFallbackIndicator = liveOn && (live.fellBack || live.liveState === "connect-failed");
  // Ref mirror so callbacks defined before `live` exists (handlePlaybackEnd,
  // below) can read the current value without being recreated on every
  // liveActive flip — mirrors the ttsEnabledRef/loopDroppedOutRef pattern.
  const liveActiveRef = useRef(liveActive);
  useEffect(() => {
    liveActiveRef.current = liveActive;
  }, [liveActive]);

  // ── Slice D — fallback continuity (specs/caddie-realtime-slice-d-plan.md §4) ──
  // The fallback SEEDING effect (writing `live.messages` into `convHistory`
  // when the live session degrades) now lives in the OWNER (RoundPageClient)
  // — it must run even while the sheet is CLOSED, or the transcript is lost
  // the instant `useDetachedCaddieLive`'s auto-release effect flips `liveOn`
  // off (which wipes the inner hook's `messages`). Only the LOCAL "have we
  // shown any live transcript this activation" tracking stays here — it
  // guards CaddieSheet's own classic auto-open effect below from re-greeting
  // on top of a preserved conversation.
  const liveTranscriptSeenRef = useRef(false);
  useEffect(() => {
    if (live.messages.length > 0) liveTranscriptSeenRef.current = true;
  }, [live.messages.length]);
  // Reset per live-session (not per open) — `liveOn` persists across a sheet
  // close, so this correctly stays true across a close+reopen of the SAME
  // activation and only resets once the live session truly ends.
  useEffect(() => {
    if (!liveOn) {
      liveTranscriptSeenRef.current = false;
    }
  }, [liveOn]);

  // Voice mode state
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [transcript, setTranscript] = useState("");
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [voiceAnswer, setVoiceAnswer] = useState<string | null>(null);
  // True from the FIRST streamed token until the ladder resolves (success or
  // terminal failure) — distinct from `isThinking` (true for the whole turn,
  // including the pre-first-token wait). Gates the follow-up/clear CTAs and
  // the mic re-arm so they don't mount/become tappable while the reply is
  // still typing in (a tap on "Ask follow-up" mid-stream would blank
  // `voiceAnswer` out from under the still-pushing buffer — a visible
  // restart-from-blank bug the designer flagged).
  const [isStreaming, setIsStreaming] = useState(false);
  // Server-side tool-round label (caddie-tool-loop-parity): a `status` SSE
  // frame means the caddie is fetching live numbers before answering. Shown
  // in the existing thinking pulse ("checking the numbers…") — no new phase.
  const [statusLabel, setStatusLabel] = useState<string | null>(null);

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
  // Ref mirror so handlePlaybackEnd (below) reads the latest pref without a
  // stale closure — mirrors the convHistoryRef pattern.
  const ttsEnabledRef = useRef(ttsEnabled);
  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  // Hands-free conversational loop (specs/caddie-conversational-loop-plan.md
  // §3.2) — implicit, armed whenever the sheet is open, mode is "voice", and
  // the speaker pref above is on. No new toggle.
  // True once the loop has calmly exited (dead air / empty-streak) — blocks
  // further auto re-arm until the golfer manually taps the mic again.
  const [loopDroppedOut, setLoopDroppedOut] = useState(false);
  const loopDroppedOutRef = useRef(false);
  useEffect(() => {
    loopDroppedOutRef.current = loopDroppedOut;
  }, [loopDroppedOut]);
  const graceTimerRef = useRef<number | null>(null); // post-playback re-arm timer (§3.3)
  const deadAirTimerRef = useRef<number | null>(null); // "armed but silent" timer (§3.4)
  const emptyStreakRef = useRef(0); // consecutive empty/failed auto-listens (§3.4)
  // True from just before the loop calls startListening until that listen
  // cycle ends — distinguishes an auto re-arm (which should run the dead-air
  // timer + count toward the empty-streak) from a manual tap (which should not).
  const armedByLoopRef = useRef(false);
  // Ref indirection so handlePlaybackEnd (defined here, before startListening
  // exists) can trigger it — mirrors the existing autoStopRef pattern below.
  const startListeningRef = useRef<() => void>(() => {});

  /**
   * Fires when TTS playback finishes NATURALLY (`ended`, never `pause` — see
   * useSheetTTS.ts split). Guarded per plan §3.3: only schedules a re-arm
   * when the sheet is genuinely idle and hands-free is armed. Grace delay
   * lets the audio element fully release before `getUserMedia` runs (§3.5 —
   * never overlap playback release and mic acquisition).
   *
   * Deviation from the plan's literal guard list: `streamAbortRef.current` is
   * NOT checked here. `streamAbortRef` is set once per askCaddie call and
   * (by existing, pre-this-plan design) only ever cleared to null on sheet
   * close/unmount — never after a turn settles — so gating on its mere
   * presence would block every re-arm after the very first turn, permanently.
   * `isThinking`/`isStreaming` already express "a turn is in flight" (the
   * same pair `showMic` already gates the mic's reappearance on), so they are
   * the correct, sufficient in-flight signal.
   */
  const handlePlaybackEnd = useCallback(() => {
    if (
      !open ||
      mode !== "voice" ||
      liveActiveRef.current || // live mode owns its own audio — never re-arm the classic loop
      !ttsEnabledRef.current ||
      loopDroppedOutRef.current ||
      isListening ||
      isTranscribing ||
      isThinking ||
      isStreaming
    ) {
      return;
    }
    if (graceTimerRef.current) window.clearTimeout(graceTimerRef.current);
    graceTimerRef.current = window.setTimeout(() => {
      graceTimerRef.current = null;
      armedByLoopRef.current = true; // this arm came from the loop — see startListening
      startListeningRef.current();
    }, REARM_GRACE_MS);
  }, [open, mode, isListening, isTranscribing, isThinking, isStreaming]);

  // Classic-path per-turn stage-timing telemetry (silent —
  // specs/caddie-realtime-telemetry-plan.md). One instance per sheet
  // instance, held in a ref so it persists across renders.
  const turn = useRef(createCaddieTurnTimer({ surface: "caddie-turn" })).current;

  const tts = useSheetTTS({ onPlaybackEnd: handlePlaybackEnd, onSpeakStart: () => turn.markFirstAudio() });

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

  /**
   * Ref mirror of `resolveOpeningShot` — mirrors the `convHistoryRef` pattern
   * so the auto-fire effect (below) need not list it as a dep.
   */
  const resolveOpeningShotRef = useRef<CaddieSheetProps["resolveOpeningShot"]>(resolveOpeningShot);
  useEffect(() => {
    resolveOpeningShotRef.current = resolveOpeningShot;
  }, [resolveOpeningShot]);

  // Fire-once-on-open flag for the auto opening shot recommendation — set
  // synchronously BEFORE the first await so React strict-mode's double-invoke
  // fires the network turn at most once. Reset only on close (never in a
  // cleanup that runs on a strict-mode remount).
  const openingFiredRef = useRef(false);
  // Dedicated generation counter for the opening-turn async gap — bumped ONLY
  // by the auto-fire effect's own close branch (below), never by the
  // pre-existing `openGenRef` bump above (which re-runs on every effect
  // commit, including React strict-mode's synthetic unmount→remount of that
  // OTHER effect during initial mount). Sharing `openGenRef` here would let
  // that harmless dev-only double-invoke look like a real close/reopen and
  // silently swallow the awaited GPS fix.
  const openingGenRef = useRef(0);

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
      setIsStreaming(false);
      setDistanceInput("");
      setIsRecThinking(false);
      setRecommendation(null);
      setError(null);
      setMode("voice");
      setPersonaPickerOpen(false);
      // Hands-free loop (specs/caddie-conversational-loop-plan.md §3.7) — a
      // closed sheet exits the loop cleanly, no dangling timers.
      if (graceTimerRef.current) {
        window.clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      if (deadAirTimerRef.current) {
        window.clearTimeout(deadAirTimerRef.current);
        deadAirTimerRef.current = null;
      }
      armedByLoopRef.current = false;
      emptyStreakRef.current = 0;
      setLoopDroppedOut(false);
    }
    return () => {
      recorderRef.current?.cancel();
      liveRef.current?.stop();
      liveRef.current = null;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      // Belt-and-braces, like the recorder/live teardown above.
      if (graceTimerRef.current) {
        window.clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      if (deadAirTimerRef.current) {
        window.clearTimeout(deadAirTimerRef.current);
        deadAirTimerRef.current = null;
      }
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
    async (question: string, opts?: { suppressError?: boolean }) => {
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
      setIsStreaming(false); // flips true on the FIRST token — see onToken below
      setStatusLabel(null);
      const currentHistory = convHistoryRef.current;

      // A server-side tool round is running — surface it in the thinking
      // pulse. Stale turns must not repaint the label of a newer one.
      const onStatus = (label: string) => {
        if (!isStale()) setStatusLabel(label);
      };

      // Sentence-level TTS pipelining (specs/caddie-realtime-conversation-plan.md
      // §6.5.4, Slice A2) — local to THIS call (a superseded turn's own
      // closure just stops being fed once isStale() flips true; no shared
      // ref bookkeeping needed across turns). `ttsBegun` gates the one-time
      // tts.beginStream() call to the first real token of this turn — a
      // stale/aborted call's late tokens never reach it (isStale() guard
      // below). `ttsAnyEnqueued` tracks whether ANY chunk was pipelined
      // mid-stream; if none was (short reply, or the non-streaming fallback
      // with zero tokens), completion falls back to the exact old
      // single-call tts.speak() behavior.
      const sentenceStream = createSentenceStream();
      let ttsBegun = false;
      let ttsAnyEnqueued = false;
      let ttsPending = ""; // sentence(s) extracted but held under MIN_TTS_CHUNK_CHARS
      const onToken = (delta: string) => {
        setIsStreaming(true); // no-op re-render after the first call (same value)
        turn.markFirstToken(); // idempotent — lands on the first token only
        answerBuffer.push(delta);
        if (isStale()) return; // a superseded turn must not enqueue TTS chunks
        if (!ttsBegun) {
          ttsBegun = true;
          tts.beginStream();
        }
        for (const sentence of sentenceStream.push(delta)) {
          ttsPending = ttsPending ? `${ttsPending} ${sentence}` : sentence;
          if (ttsPending.length >= MIN_TTS_CHUNK_CHARS) {
            tts.enqueue(ttsPending, personaId);
            ttsAnyEnqueued = true;
            ttsPending = "";
          }
        }
      };

      const askStatelessNonStream = async (): Promise<string> => {
        const profile = getGolferProfile();
        const clubMap = buildClubMap();
        const res = await talkToCaddie({
          transcript: question,
          personality_id: personaId,
          hole_number: holeNumber,
          par: holePar,
          yards: holeYards ?? undefined,
          distance_to_green_yards: distanceToGreenYards,
          yardage_basis: yardageBasis ?? undefined,
          tee_name: teeName ?? undefined,
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
            yards: holeYards ?? undefined,
            distance_to_green_yards: distanceToGreenYards,
            yardage_basis: yardageBasis ?? undefined,
            tee_name: teeName ?? undefined,
            club_distances: Object.keys(clubMap).length > 0 ? clubMap : undefined,
            handicap: profile?.handicap ?? undefined,
            conversation_history: currentHistory,
          },
          { onToken, onStatus, signal: controller.signal },
        );
      };

      try {
        let responseText: string;
        if (sessionActive && roundId) {
          try {
            responseText = await sessionVoiceStream(
              {
                round_id: roundId,
                transcript: question,
                personality_id: personaId,
                hole_number: holeNumber,
                distance_to_green_yards: distanceToGreenYards,
                hole_yards: holeYards ?? undefined,
                yardage_basis: yardageBasis ?? undefined,
                tee_name: teeName ?? undefined,
              },
              { onToken, onStatus, signal: controller.signal },
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
        // Drop any still-pending coalesced chunk FIRST: a flush scheduled for
        // the next animation frame would otherwise land AFTER this overwrite
        // and append the tail a second time ("Smooth 6.Smooth 6." — the race
        // CI's slower frame timing exposed).
        answerBuffer.cancel();
        setVoiceAnswer(stripSpokenMarkdown(responseText)); // authoritative full text — overwrites any partial coalesced render

        // Reconcile against the authoritative responseText: enqueue only the
        // not-yet-enqueued remainder, so the full text is spoken exactly
        // once (no drop, no duplicate) — never a second full-text speak() on
        // top of chunks already queued (plan §6.5.4 hard invariant #1).
        const tail = [ttsPending, ...sentenceStream.flush()].filter(Boolean).join(" ");
        if (!ttsAnyEnqueued) {
          // Nothing was pipelined mid-stream (short reply, or the
          // non-streaming fallback with zero tokens) — exactly the old
          // single-call behavior.
          tts.speak(responseText, personaId);
        } else {
          if (tail) tts.enqueue(tail, personaId);
          tts.endStream();
        }
      } catch (err) {
        if (isStale()) return; // superseded (new question / sheet close) — not a real failure
        tts.stop(); // discard any chunks already queued for this failed turn — never speak a partial
        answerBuffer.cancel();
        // Discard the partial rather than keep it on screen (plan §5): a
        // truncated caddie reply can be actively misleading (cut mid-club or
        // mid-aim), and the server persisted nothing for this turn either.
        setVoiceAnswer(null);
        if (opts?.suppressError) {
          // The unprompted auto opening turn failed — the golfer asked
          // nothing yet, so stay honestly idle rather than surface an error
          // bubble over a turn they never initiated (specs/caddie-auto-shot-reco-plan.md §4).
          setError(null);
        } else {
          setError(
            humanizeVoiceError(err instanceof Error ? err.message : undefined, "Caddie unavailable — try again.")
          );
        }
      } finally {
        if (!isStale()) {
          setIsThinking(false);
          setIsStreaming(false); // reply complete (or terminally failed) — safe to re-arm controls
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      personaId,
      sessionActive,
      roundId,
      holeNumber,
      holePar,
      holeYards,
      yardageBasis,
      teeName,
      distanceToGreenYards,
      onUpdateConvHistory,
      tts.speak,
      tts.beginStream,
      tts.enqueue,
      tts.endStream,
      tts.stop,
      answerBuffer,
    ]
    // convHistory intentionally absent — read from convHistoryRef.current (#1).
    // Individual tts.* methods (not the whole `tts` object) — the hook
    // memoizes each stably, so depending on the full object would recreate
    // askCaddie every render.
  );

  /**
   * Auto opening shot recommendation (specs/caddie-auto-shot-reco-plan.md;
   * specs/caddie-remove-seeded-question-plan.md). On a fresh sheet-open
   * during an active session, resolve the golfer's live GPS distance-to-pin
   * (owned by the parent) and seed a deterministic, caddie-authored greeting
   * — no typing/speaking required, and no network turn. Every fallback
   * branch (no session, no GPS fix, no green coords, implausible distance)
   * leaves the sheet in its existing idle state — never a fabricated
   * recommendation, and never a fabricated player question.
   */
  useEffect(() => {
    if (!open) {
      openingFiredRef.current = false; // reset only on close
      openingGenRef.current++; // invalidate any opening-turn async still awaiting GPS
      return;
    }
    // Live mode owns the opening turn itself (spoken, via sendOpener — see
    // useCaddieLiveSession) — the classic text auto-fire must not ALSO run,
    // or the golfer gets a double opening turn and a phantom text mic
    // (specs/caddie-realtime-slice-c1-plan.md §4/§9).
    if (liveActive) return;
    // Fallback-after-live-drop (Slice D §4): never re-greet mid-round — the
    // seeded convHistory (above) independently suppresses this too (belt and
    // suspenders for the race before the seed effect runs).
    if (liveTranscriptSeenRef.current) return;
    if (openingFiredRef.current) return; // already fired this open (guards
    // re-render AND strict-mode double effect)
    if (!sessionActive || !roundId) return; // no session → open exactly as today
    if (!resolveOpeningShotRef.current) return; // parent opted out → idle
    if (convHistory.length > 0) return; // reopened onto an existing thread → no auto-fire
    if (voiceAnswer || isThinking || isListening) return; // never fire over an in-flight/answered turn

    openingFiredRef.current = true; // set BEFORE any await → strict-mode-safe
    const gen = openingGenRef.current; // dedicated gen — see openingGenRef comment above
    void (async () => {
      const shot = await resolveOpeningShotRef.current!();
      if (openingGenRef.current !== gen) return; // sheet closed/reopened while awaiting GPS
      // The GPS fix can take up to 6s — re-check the sheet is still PRISTINE
      // idle (via refs, never stale closed-over state) before stomping over
      // whatever the golfer did in the meantime. Without this, a user turn
      // that starts and even finishes DURING the await gets silently aborted
      // and its transcript overwritten by the canned opening question
      // (specs/caddie-auto-shot-reco-plan.md deviation — reviewer-caught).
      if (streamAbortRef.current || recorderRef.current || convHistoryRef.current.length > 0) return;
      if (!shot) return; // no GPS fix → stay idle (open as today)
      // Caddie-authored greeting; no network turn, no fabricated user line
      // (specs/caddie-remove-seeded-question-plan.md §3.2).
      const greeting = buildOpeningGreetingText(shot);
      const seeded: VoiceCaddieMessage[] = [{ role: "assistant", content: greeting }];
      convHistoryRef.current = seeded; // next askCaddie sees it immediately (ref-mirror pattern, matches askCaddie)
      onUpdateConvHistory(seeded);
      setVoiceAnswer(greeting); // renders the caddie answer card (phase → "answered"); transcript stays "" so no quoted user line
      tts.speak(greeting, personaId); // spoken once; onPlaybackEnd re-arms the hands-free loop exactly as after any reply
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionActive, roundId, convHistory.length, liveActive]);

  const startListening = useCallback(async () => {
    setError(null);
    setTranscript("");
    setInterimTranscript("");
    // Whether THIS listen cycle was auto-armed by the loop (vs. a manual
    // tap) — read BEFORE deciding whether to clear the previous answer (see
    // below), and once more here so it carries through the whole cycle
    // (dead-air timer below, empty-streak accounting in stopListening). The
    // ref itself stays true until stopListening/dead-air-expiry/an error
    // resets it, so it is stable to read again there.
    const loopArmed = armedByLoopRef.current;
    if (!loopArmed) {
      // Manual "tap the mic" (fresh question or "Ask follow-up") — clear the
      // previous answer immediately, same as today.
      //
      // A loop-driven auto re-arm leaves `voiceAnswer` alone: the golfer just
      // heard it spoken a moment ago, and swallowing it here would blank the
      // screen the instant the mic reopens (designer-caught regression —
      // VoiceBody below keeps rendering it, layered under the waveform,
      // until a NEW answer actually starts streaming in).
      setVoiceAnswer(null);
    }
    liveTranscriptRef.current = "";
    liveFailedRef.current = false;
    const gen = openGenRef.current;
    let recorder: VoiceRecorder | null = null;
    try {
      recorder = new VoiceRecorder();
      await recorder.start();
      if (openGenRef.current !== gen) {
        recorder.cancel(); // sheet closed while the mic was being acquired
        armedByLoopRef.current = false;
        return;
      }
      recorderRef.current = recorder;
      setIsListening(true);

      if (loopArmed) {
        // Auto-armed by the hands-free loop (§3.4) — start the dead-air
        // timer. UtteranceEnd never fires on pure silence, so without this a
        // silent golfer would leave the mic open forever; expiry drops the
        // loop out calmly (no error) back to the idle "Tap to speak" state.
        if (deadAirTimerRef.current) window.clearTimeout(deadAirTimerRef.current);
        deadAirTimerRef.current = window.setTimeout(() => {
          deadAirTimerRef.current = null;
          armedByLoopRef.current = false;
          recorderRef.current?.cancel();
          recorderRef.current = null;
          liveRef.current?.stop();
          liveRef.current = null;
          setInterimTranscript("");
          setIsListening(false);
          setLoopDroppedOut(true);
          // This listen produced no turn — the persisted answer (kept on
          // screen through the "listening" phase above) has nothing left to
          // stay attached to, so drop it too and go fully idle, exactly as
          // before this listen started.
          setVoiceAnswer(null);
        }, DEAD_AIR_MS);
      }

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
                // Speech detected — cancel dead air, let UtteranceEnd finish the turn.
                if (deadAirTimerRef.current) {
                  window.clearTimeout(deadAirTimerRef.current);
                  deadAirTimerRef.current = null;
                }
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
      armedByLoopRef.current = false; // failed to open — never left dangling for the next attempt
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
    // Start of turn — honest end-of-speech instant for the classic VAD path
    // (specs/caddie-realtime-telemetry-plan.md §1.4). Resets the timer's
    // downstream marks for this new turn.
    turn.markEos();
    const gen = openGenRef.current;
    // This listen cycle is ending — consume the loop-armed flag now (before
    // any await) so a manual tap racing in can't be mistaken for this cycle,
    // and clear the dead-air timer (§3.4 — "whenever listening stops").
    const loopArmed = armedByLoopRef.current;
    armedByLoopRef.current = false;
    if (deadAirTimerRef.current) {
      window.clearTimeout(deadAirTimerRef.current);
      deadAirTimerRef.current = null;
    }
    // Empty-streak counter (§3.4) — belt-and-braces for ambient noise that
    // trips UtteranceEnd but yields nothing usable. Only counts loop-armed
    // listens; a manual tap ending empty keeps today's exact behavior.
    const registerLoopEmpty = () => {
      if (!loopArmed) return;
      emptyStreakRef.current += 1;
      if (emptyStreakRef.current >= MAX_EMPTY_STREAK) {
        setLoopDroppedOut(true);
      }
      // This listen produced no new turn — same as the dead-air path above,
      // drop the persisted answer and settle back to plain idle rather than
      // leave a stale answer sitting under a mic that isn't actually about
      // to say anything new.
      setVoiceAnswer(null);
    };
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
        // Loop-armed: calm — no error, just count toward the streak and let
        // the sheet settle back to its normal idle mic block (plan §3.4).
        // Manual tap: unchanged today's-exact error copy.
        if (loopArmed) {
          registerLoopEmpty();
        } else {
          setError("No speech detected. Tap the mic to try again.");
        }
        return;
      }
      if (openGenRef.current !== gen) return;
      emptyStreakRef.current = 0; // a real turn is starting — reset the streak
      setTranscript(finalText);
      turn.markTranscript(); // brackets eos_to_transcript
      // Auto-call caddie with the finalized transcript
      await askCaddie(finalText);
    } catch (err) {
      registerLoopEmpty();
      if (openGenRef.current === gen) {
        setError(
          humanizeVoiceError(err instanceof Error ? err.message : undefined, "Lost that one — tap the mic and try again.")
        );
      }
    } finally {
      recorderRef.current = null;
      setIsTranscribing(false);
    }
    // `turn` (a useRef .current) is stable for the component's lifetime — no
    // eslint-disable needed, but listed for exhaustiveness.
  }, [askCaddie, turn]);

  autoStopRef.current = () => void stopListening();
  startListeningRef.current = () => void startListening(); // hands-free loop indirection (§3.3)

  const handleMicTap = () => {
    // Bless the <audio> element in the SAME gesture as dictation start — must
    // run synchronously, before any async work below (§3 iOS unlock wiring).
    tts.unlock();
    // Barge-in (§3.6) — tapping the mic while the caddie is still talking (or
    // a re-arm is about to fire) interrupts cleanly: cancel any pending auto
    // re-arm first, stop playback if it's speaking (fires `pause`, not
    // `ended` — no re-arm from the interruption), and clear the loop's
    // drop-out/streak state since the golfer just re-engaged.
    if (graceTimerRef.current) {
      window.clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
    if (tts.isSpeaking) {
      tts.stop();
    }
    armedByLoopRef.current = false;
    emptyStreakRef.current = 0;
    setLoopDroppedOut(false);
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
        yards: holeYards ?? undefined,
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
            yards: holeYards ?? undefined,
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

  // `!isStreaming` — the mic doesn't re-arm until the reply has FINISHED
  // typing in, not merely started (designer: premature-affordance drift).
  const showMic = mode === "voice" && phase !== "transcribing" && phase !== "thinking" && !isStreaming;

  // Close DETACHES only — the core behavioral change of
  // specs/caddie-detach-and-language-pin-plan.md Item B. The live session
  // (owned by RoundPageClient) keeps running after the sheet closes; only an
  // explicit END (LiveFooter's onEnd -> onEndLive) stops it.
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="cs-backdrop"
          data-no-backswipe
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={handleClose}
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
          data-no-backswipe
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
            if (shouldDismissSheetDrag(info.offset.y, info.velocity.y)) handleClose();
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
                  Hole {holeNumber} &middot; Par {holePar} &middot; {yardsCaption ?? (holeYards != null ? `${holeYards} yds` : "—")}
                </span>
              </div>
            </div>

            {/* Close button — 44×44 (#4) */}
            <button
              onClick={handleClose}
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
          {/* TODO(audit): stick to bottom as the streaming answer grows past the
              viewport (unless the user scrolled up) — follow-up, not this cycle. */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "18px 20px 20px",
              WebkitOverflowScrolling: "touch" as React.CSSProperties["WebkitOverflowScrolling"],
            }}
          >
            {mode === "voice" ? (
              liveActive ? (
                <LiveVoiceBody
                  messages={live.messages}
                  status={live.status}
                  caddy={caddy}
                  paused={live.liveState === "suspended"}
                  retrying={live.liveState === "retrying"}
                />
              ) : (
                <VoiceBody
                  phase={phase}
                  isSupported={isSupported}
                  interimTranscript={interimTranscript}
                  transcript={transcript}
                  voiceAnswer={voiceAnswer}
                  isStreaming={isStreaming}
                  statusLabel={statusLabel}
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
              )
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
           * Footer — non-scrolling bottom block (#2), rendered OUTSIDE the
           * scroll area so it stays fixed as conversation history/transcript
           * grows. Live mode swaps in a status line + mute toggle (no
           * tap-to-start/stop mic — server VAD runs it); classic mode keeps
           * the existing mic button. Mirrors Voice.tsx:239-298 vmic pattern.
           */}
          {mode === "voice" && liveActive ? (
            <LiveFooter
              status={live.status}
              personaName={captionPersonaName(caddy.name)}
              muted={live.muted}
              onToggleMute={live.toggleMute}
              paused={live.liveState === "suspended"}
              onResume={live.resume}
              onEnd={() => {
                onEndLive();
                onClose();
              }}
            />
          ) : (
            showMic && (
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
              {showFallbackIndicator && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.2,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                  }}
                >
                  Tap-to-talk mode
                </div>
              )}
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
                  : phase === "answered" && ttsEnabled && !loopDroppedOut
                  ? // Hands-free is armed and will re-listen on its own the
                    // moment playback ends (§3.3 grace window) — "Tap to ask
                    // again" would read as an instruction the golfer doesn't
                    // need to follow; a tap here still works, it just barges
                    // in early.
                    "Tap to interrupt"
                  : "Tap to ask again"}
              </div>
            </div>
            )
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: LiveVoiceBody — live-mode (Realtime) transcript, restyled
// from VoiceRoundSetupRealtime's bubble list into CaddieSheet chrome
// (specs/caddie-realtime-slice-c1-plan.md §4/§5). Messages arrive already
// sortByOrder'd from useCaddieLiveSession — render as-is.
// ---------------------------------------------------------------------------

function LiveVoiceBody({
  messages,
  status,
  caddy,
  paused,
  retrying = false,
}: {
  messages: RealtimeMessage[];
  status: RealtimeStatus;
  caddy: Caddy;
  /** True when `liveState === "suspended"` (Slice E) — the socket already
   *  idled out. The footer owns the "Paused — tap to resume" claim; this
   *  empty-state hint must not contradict it by claiming the caddy is
   *  actively listening (no-fake-data / honest-states). */
  paused: boolean;
  /** True when `liveState === "retrying"` (specs/caddie-live-p0-connect-hole
   *  -plan.md §2.3) — the one quiet pre-connect auto-retry is in flight. The
   *  footer still renders `status`'s own "Connecting…" copy (a fresh retry
   *  client re-arms `status` to `'connecting'`); this empty-state hint must
   *  agree with it. */
  retrying?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {messages.length === 0 && paused && (
        // Paused (Slice E, follow-up) — the footer already claims "Paused —
        // tap to resume"; this hint must agree with it, not contradict it
        // with a fake "is listening" claim (no-fake-data / honest-states).
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.2,
            color: T.pencilSoft,
            textAlign: "center",
            textTransform: "uppercase",
            lineHeight: 1.5,
          }}
        >
          {liveEmptyStateHint(status, paused, captionPersonaName(caddy.name), retrying)}
        </div>
      )}
      {messages.length === 0 && !paused && (
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          {liveEmptyStateHint(status, paused, captionPersonaName(caddy.name), retrying)}
        </div>
      )}
      {/* render as-is — messages arrive PRE-SORTED by `order` from
          useCaddieLiveSession; this adapter is 1:1 (no filter/sort/dedup) so
          the caddie-realtime-double-emit fix upstream is never regressed. */}
      <Transcript
        turns={messages.map((m) => ({
          key: m.id,
          speaker: m.role === "user" ? "user" : "caddie",
          text: m.text,
          // DESIGNER OVERRIDE (plan §3.2): partial -> streaming (opacity 1 +
          // caption pulse), NOT muted/0.7 — dimmed live text reads as broken.
          streaming: m.partial,
        }))}
        speakerLabel={captionPersonaName(caddy.name)}
      />
    </div>
  );
}

/** Mic glyph with an optional muted slash — mirrors VoiceRoundSetupRealtime's
 *  local MicIcon (duplicated here rather than shared/exported, matching this
 *  file's existing pattern of small, file-local icon helpers). */
function LiveMicIcon({ size = 20, stroke = "currentColor", muted = false }: { size?: number; stroke?: string; muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      {muted && <line x1="4" y1="3" x2="20" y2="21" />}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: LiveFooter — live-mode footer: status line + mute toggle.
// No tap-to-start/stop mic in live mode — server VAD runs it (§5).
// ---------------------------------------------------------------------------

/** Quiet text-only End affordance — mirrors the mono/uppercase small-button
 *  language already used for "Clear conversation" elsewhere in this file. No
 *  new icon language, no alarm color — ending live mode is a normal action,
 *  not an error. The primary end path is the pill's long-press
 *  (specs/caddie-detach-and-language-pin-plan.md §B3); this is the
 *  in-sheet equivalent for when the golfer is already looking at the
 *  transcript. */
function EndLiveButton({ onEnd }: { onEnd: () => void }) {
  return (
    <button
      onClick={onEnd}
      aria-label="End live session"
      style={{
        padding: "0 4px",
        border: "none",
        background: "transparent",
        color: T.pencilSoft,
        fontFamily: T.mono,
        fontSize: 9,
        letterSpacing: 1.2,
        textTransform: "uppercase",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      End
    </button>
  );
}

function LiveFooter({
  status,
  personaName,
  muted,
  onToggleMute,
  paused,
  onResume,
  onEnd,
}: {
  status: RealtimeStatus;
  /** Cross-surface identity name (`captionPersonaName(caddy.name)`) —
   *  resolves the `speaking` status label so it never disagrees with the
   *  transcript's `speakerLabel` (specs/caddie-coherence-polish-plan.md §2). */
  personaName: string;
  muted: boolean;
  onToggleMute: () => void;
  /** True when `liveState === "suspended"` (Slice E) — the socket is
   *  already stopped by the 90s idle cutoff; render a calm paused affordance
   *  instead of the stale/dead status + mute controls. */
  paused: boolean;
  onResume: () => void;
  /** Ends the live session entirely (mic cut + gate flip), then closes the
   *  sheet — specs/caddie-detach-and-language-pin-plan.md §B2. */
  onEnd: () => void;
}) {
  if (paused) {
    // Honest, calm suspended state — NOT an error (T.pencil, not
    // T.warningInk/an alarm color) and no mute toggle (meaningless on a
    // stopped socket). The mic button becomes the resume affordance.
    return (
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 20px 18px",
          borderTop: `1px solid ${T.hairline}`,
        }}
      >
        <div
          style={{
            flex: 1,
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.pencil,
            textTransform: "uppercase",
          }}
        >
          Paused — tap to resume
        </div>
        <button
          onClick={onResume}
          aria-label="Resume listening"
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: 99,
            border: `1px solid ${T.hairline}`,
            background: "transparent",
            color: T.ink,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <LiveMicIcon stroke={T.ink} />
        </button>
        <EndLiveButton onEnd={onEnd} />
      </div>
    );
  }

  // The setup flow's blue "listening" accent (owner: "I do like the blue
  // listening" ) — live and unmuted reads as actively listening.
  const listening = !muted && (status === "connected" || status === "listening");
  return (
    <div
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 20px 18px",
        borderTop: `1px solid ${T.hairline}`,
      }}
    >
      <div
        style={{
          flex: 1,
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1.3,
          color: status === "error" ? T.warningInk : listening ? DEFAULT_ACCENT : T.pencil,
          textTransform: "uppercase",
        }}
      >
        {liveStatusLabel(status, personaName)}
      </div>
      <button
        onClick={onToggleMute}
        aria-label={muted ? "Unmute" : "Mute"}
        style={{
          minWidth: 44,
          minHeight: 44,
          borderRadius: 99,
          border: `1px solid ${muted ? T.warningInk : listening ? DEFAULT_ACCENT : T.hairline}`,
          background: muted ? `${T.warningInk}14` : listening ? `${DEFAULT_ACCENT}14` : "transparent",
          color: muted ? T.warningInk : listening ? DEFAULT_ACCENT : T.ink,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <LiveMicIcon muted={muted} stroke={muted ? T.warningInk : listening ? DEFAULT_ACCENT : T.ink} />
      </button>
      <EndLiveButton onEnd={onEnd} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: ListeningIndicator (waveform + "Hearing…"/interim text) —
// shared by the bare "voice-listening" state and the loop-armed re-listen
// that renders underneath a still-persisting answer (see VoiceBody below).
// ---------------------------------------------------------------------------

function ListeningIndicator({
  accent,
  interimTranscript,
  compact,
}: {
  accent: string;
  interimTranscript: string;
  /** Tighter spacing/size when nested under a persisting answer card rather
   *  than standing alone as the whole turn. */
  compact?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: compact ? 8 : 12,
        paddingTop: compact ? 4 : 8,
      }}
    >
      <Waveform accent={accent} playing bars={compact ? 16 : 22} height={compact ? 16 : 20} />
      {/* Both "Hearing…" and interim text use same serif-italic style (#8) */}
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: compact ? 13 : 15,
          color: T.inkSoft,
          textAlign: "center",
          lineHeight: 1.4,
          letterSpacing: -0.1,
        }}
      >
        {interimTranscript ? `“${interimTranscript}”` : "Hearing…"}
      </div>
    </div>
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
  /** True while a reply is still streaming in (first token → completion) —
   *  the follow-up/clear CTAs stay unmounted until it flips false, so they
   *  never fire mid-stream and blank out a still-growing answer. */
  isStreaming: boolean;
  /** Server-side tool-round label ("checking the numbers") — swaps the
   *  thinking-pulse copy while the caddie fetches live numbers. */
  statusLabel: string | null;
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
  isStreaming,
  statusLabel,
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
        <Transcript
          turns={convHistory.slice(0, -2).map((msg, i) => ({
            key: String(i),
            speaker: msg.role === "user" ? "user" : "caddie",
            text: msg.content,
          }))}
          speakerLabel={captionPersonaName(caddy.name)}
        />
      )}

      {/* Current / most recent turn */}
      <AnimatePresence mode="wait">
        {(phase === "answered" || phase === "listening") && voiceAnswer ? (
          // Loop-armed re-listen with a persisted answer (see startListening's
          // loopArmed guard) renders here too — same "voice-answer" key as the
          // plain "answered" case, so AnimatePresence's mode="wait" never
          // treats the mic reopening as a key change and hard-swaps the just
          // -spoken answer out for the waveform (designer-caught regression:
          // the answer used to vanish ~400-500ms after the caddie finished
          // speaking, the instant the loop reopened the mic).
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
              <ConversationTurn
                turn={{ key: "current", speaker: "caddie", text: voiceAnswer }}
                speakerLabel={captionPersonaName(caddy.name)}
                captionColor={T.pencilSoft}
              />
            </div>

            {/* Follow-up / clear — unmounted until the reply has FINISHED
                streaming (not merely started), AND unmounted again once the
                loop reopens the mic (phase "listening"): a new turn is
                already in flight at that point, so the CTAs would be dead
                weight sitting on top of a card that's about to be replaced.
                The listening indicator below takes their place. Mounting
                mid-stream let a tap blank `voiceAnswer` out from under the
                still-growing text, and caused the row to reflow underneath it. */}
            {!isStreaming && phase !== "listening" && (
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
            )}

            {/* Loop re-armed the mic while this answer is still on screen —
                show the listening waveform underneath it rather than hard
                -swapping the whole card away (see the mode="wait" comment
                above). */}
            {phase === "listening" && (
              <div style={{ marginTop: 14 }}>
                <ListeningIndicator accent={accent} interimTranscript={interimTranscript} compact />
              </div>
            )}
          </motion.div>
        ) : phase === "listening" ? (
          // No persisted answer (fresh question, or a manual "ask again" that
          // already cleared it — see startListening) — the bare waveform is
          // the whole turn, same as before.
          <motion.div
            key="voice-listening"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            <ListeningIndicator accent={accent} interimTranscript={interimTranscript} />
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
                {statusLabel ? `${statusLabel}…` : `${caddy.name} is thinking…`}
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
