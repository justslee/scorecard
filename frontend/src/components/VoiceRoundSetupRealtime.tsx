"use client";

/**
 * Conversational round setup on the OpenAI Realtime engine.
 *
 * Replaces the batch record→transcribe→parse flow: opens a continuous Realtime
 * voice session (live transcription + the caddie talking back), so the golfer
 * can say partial info and the caddie asks for what's missing (course, players,
 * tees — incl. per-player groups). When the caddie has enough it calls the
 * `set_round_setup` tool; we map that to the round form via onSetupRound and the
 * golfer confirms with "Tee off".
 *
 * The WebRTC voice path can only be exercised on a real device — this component
 * is structured to fail calm (clear error + retry) rather than dead-end.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import {
  RealtimeCaddieClient,
  type RealtimeMessage,
  type RealtimeStatus,
} from "@/lib/voice/realtime";

interface SetRoundSetupArgs {
  courseName?: string;
  players?: Array<{ name?: string; tee?: string }>;
  teeName?: string;
  holes?: number;
  gameFormat?: string;
}

interface Props {
  onSetupRound: (config: {
    courseName: string;
    playerNames: string[];
    teeName?: string;
  }) => void;
  onClose: () => void;
  /** Begin the voice session immediately on open (single tap from the mic). */
  autoStart?: boolean;
}

const STATUS_LABEL: Record<RealtimeStatus, string> = {
  idle: "Tap to start",
  connecting: "Connecting…",
  connected: "Ready — go ahead",
  listening: "Listening…",
  speaking: "Caddie speaking…",
  closed: "Ended",
  error: "Couldn't connect",
};

/** True once the live voice line is open (mic active). */
function isLive(s: RealtimeStatus): boolean {
  return s === "connected" || s === "listening" || s === "speaking";
}

/**
 * Inline mic glyph (no lucide-react). When `muted`, a slash is drawn across it
 * so the control reads as "mic off" at a glance rather than relying on a word.
 */
function MicIcon({ size = 20, stroke = "currentColor", muted = false }: { size?: number; stroke?: string; muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      {muted && <line x1="4" y1="3" x2="20" y2="21" />}
    </svg>
  );
}

export default function VoiceRoundSetupRealtime({
  onSetupRound,
  onClose,
  autoStart = false,
}: Props) {
  const accent = DEFAULT_ACCENT;
  // Swipe-down-to-dismiss, started ONLY from the grab handle (below) so the
  // conversation list still scrolls normally. Mirrors CaddieSheet.
  const dragControls = useDragControls();
  const clientRef = useRef<RealtimeCaddieClient | null>(null);
  const mountedRef = useRef(true);
  const handledSetupRef = useRef(false);

  const [status, setStatus] = useState<RealtimeStatus>("idle");
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const upsert = useCallback((m: RealtimeMessage) => {
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      if (i === -1) return [...prev, m];
      const next = prev.slice();
      next[i] = m;
      return next;
    });
  }, []);

  const handleSetRoundSetup = useCallback(
    (args: SetRoundSetupArgs) => {
      if (handledSetupRef.current) return; // create the round once
      const players = (args.players ?? [])
        .map((p) => (p?.name ?? "").trim())
        .filter(Boolean);
      const course = (args.courseName ?? "").trim();
      if (!course && players.length === 0) return; // nothing usable yet
      handledSetupRef.current = true;
      // Default tee: explicit default, else the first player's assigned tee.
      // (Per-player tee groups are captured in the tool but the round model
      //  carries a single tee for now — tracked as a follow-up.)
      const teeName = args.teeName?.trim() || args.players?.[0]?.tee?.trim() || undefined;
      clientRef.current?.stop();
      onSetupRound({ courseName: course, playerNames: players, teeName });
    },
    [onSetupRound],
  );

  const start = useCallback(async () => {
    if (clientRef.current) return;
    setError(null);
    const client = new RealtimeCaddieClient(
      { mode: "setup", personalityId: "classic" },
      {
        onStatus: (s) => mountedRef.current && setStatus(s),
        onMessage: (m) => mountedRef.current && upsert(m),
        onToolCall: (name, rawArgs) => {
          if (name === "set_round_setup") handleSetRoundSetup(rawArgs as SetRoundSetupArgs);
        },
        onError: (e) => mountedRef.current && setError(e.message),
      },
    );
    clientRef.current = client;
    try {
      await client.start();
    } catch {
      clientRef.current = null;
    }
  }, [upsert, handleSetRoundSetup]);

  // Connect on open; tear the session down on unmount. The component is mounted
  // ONLY while the sheet is open (parent gates it on showVoiceSetup), so the live
  // Realtime session never runs in the background — a warm/preloaded session let
  // whisper-1 hallucinate phantom transcripts on silence before the user spoke.
  // start() is deferred a tick so it doesn't setState synchronously in the effect.
  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (autoStart) {
      timer = setTimeout(() => {
        if (mountedRef.current) void start();
      }, 0);
    }
    return () => {
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
      clientRef.current?.stop();
      clientRef.current = null;
    };
  }, [autoStart, start]);

  const handleClose = useCallback(() => {
    clientRef.current?.stop();
    clientRef.current = null;
    onClose();
  }, [onClose]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    clientRef.current?.setMuted(next);
    setMuted(next);
  }, [muted]);

  return (
    <AnimatePresence>
      <motion.div
        key="vrsr-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={handleClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(26,42,26,0.35)",
          backdropFilter: "blur(4px)",
          zIndex: 50,
        }}
      />
      <motion.div
        key="vrsr-sheet"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={T.springSoft}
        // Drag past ~120px or a downward flick closes it; else it springs back.
        drag="y"
        dragListener={false}
        dragControls={dragControls}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        onDragEnd={(_e, info) => {
          if (info.offset.y > 120 || info.velocity.y > 600) handleClose();
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
            height: 44, // ≥44pt touch target
            flexShrink: 0,
            cursor: "grab",
            touchAction: "none",
          }}
        >
          <div style={{ width: 36, height: 4, borderRadius: 2, background: T.hairline }} />
        </div>

        {/* Header — the subtitle becomes the live status once a conversation is
            under way, so the screen reflects the session instead of a static prompt. */}
        <div style={{ padding: "4px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase", marginBottom: 3 }}>
              Voice · Setup
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.4 }}>
              {error
                ? "Let's try that again."
                : isLive(status) || messages.length > 0
                ? STATUS_LABEL[status]
                : status === "connecting"
                ? STATUS_LABEL.connecting
                : "Tell me what you’re playing."}
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            style={{
              width: 44, height: 44, borderRadius: 99, border: "none",
              background: "transparent", color: T.pencil, cursor: "pointer", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
            }}
          >
            ✕
          </button>
        </div>

        {/* Conversation */}
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 20px 12px", display: "flex", flexDirection: "column", gap: 10, minHeight: 160 }}>
          {messages.length === 0 && !error && (
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15, color: T.pencil, lineHeight: 1.4 }}>
              {status === "connecting"
                ? "Getting the caddie on the line…"
                : isLive(status)
                ? "Say something like “Pebble with Dan and Matt off the whites.” The caddie will ask for anything it's missing."
                : "Tap Start to open a live line with your caddie."}
            </div>
          )}
          {/* Listening affordance before the first bubble — so the screen never reads as frozen. */}
          {messages.length === 0 && !error && isLive(status) && (
            <motion.div
              aria-hidden
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              style={{ width: 8, height: 8, borderRadius: 99, background: accent, marginTop: 2 }}
            />
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                padding: "8px 12px",
                borderRadius: 14,
                background: m.role === "user" ? T.ink : T.paperDeep,
                color: m.role === "user" ? T.paper : T.ink,
                fontFamily: m.role === "user" ? T.sans : T.serif,
                fontStyle: m.role === "user" ? "normal" : "italic",
                fontSize: 15,
                lineHeight: 1.35,
                opacity: m.partial ? 0.7 : 1,
              }}
            >
              {m.text}
            </div>
          ))}
          {error && (
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.warningInk, lineHeight: 1.4 }}>
              {error} — tap Start to try again.
            </div>
          )}
        </div>

        {/* Footer: status + mic/mute */}
        <div style={{ padding: "10px 20px 20px", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, fontFamily: T.mono, fontSize: 10, letterSpacing: 1.4, color: status === "error" ? T.warningInk : T.pencil, textTransform: "uppercase" }}>
            {error ? STATUS_LABEL.error : STATUS_LABEL[status]}
          </div>
          {isLive(status) ? (
            <button
              onClick={toggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
              style={{
                width: 44, height: 44, borderRadius: 99,
                border: `1px solid ${muted ? T.warningInk : T.hairline}`,
                background: muted ? `${T.warningInk}14` : "transparent",
                color: muted ? T.warningInk : T.ink, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <MicIcon muted={muted} stroke={muted ? T.warningInk : T.ink} />
            </button>
          ) : status === "connecting" ? null /* status label suffices; nothing to mute yet */ : (
            <button
              onClick={() => { clientRef.current = null; void start(); }}
              style={{ padding: "12px 20px", borderRadius: 99, border: "none", background: accent, color: T.paper, fontFamily: T.sans, fontSize: 14, fontWeight: 500, cursor: "pointer" }}
            >
              Start
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
