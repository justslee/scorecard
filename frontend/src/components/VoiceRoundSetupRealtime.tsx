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
import { motion, AnimatePresence } from "framer-motion";
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
  connected: "Listening",
  listening: "Listening…",
  speaking: "Caddie speaking…",
  closed: "Ended",
  error: "Couldn't connect",
};

export default function VoiceRoundSetupRealtime({
  onSetupRound,
  onClose,
  autoStart = false,
}: Props) {
  const accent = DEFAULT_ACCENT;
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

  // Auto-start on open; tear the session down on unmount. start() is deferred a
  // tick so it doesn't setState synchronously inside the effect body.
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
        }}
      >
        {/* Header */}
        <div style={{ padding: "16px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase", marginBottom: 3 }}>
              Voice · Setup
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.4 }}>
              Tell me what you&rsquo;re playing.
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            style={{
              width: 32, height: 32, borderRadius: 99, border: `1px solid ${T.hairline}`,
              background: "transparent", color: T.pencil, cursor: "pointer", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
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
                : "Say something like “Pebble with Dan and Matt off the whites.” The caddie will ask for anything it's missing."}
            </div>
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
              {error} — tap the mic to try again.
            </div>
          )}
        </div>

        {/* Footer: status + mic/mute */}
        <div style={{ padding: "10px 20px 20px", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, fontFamily: T.mono, fontSize: 10, letterSpacing: 1.4, color: status === "error" ? T.warningInk : T.pencil, textTransform: "uppercase" }}>
            {error ? STATUS_LABEL.error : STATUS_LABEL[status]}
          </div>
          {status === "error" || status === "idle" || status === "closed" ? (
            <button
              onClick={() => { clientRef.current = null; void start(); }}
              style={{ padding: "10px 18px", borderRadius: 99, border: "none", background: accent, color: T.paper, fontFamily: T.sans, fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >
              Start
            </button>
          ) : (
            <button
              onClick={toggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
              style={{
                width: 44, height: 44, borderRadius: 99,
                border: `1px solid ${muted ? T.warningInk : T.hairline}`,
                background: muted ? `${T.warningInk}14` : "transparent",
                color: muted ? T.warningInk : T.ink, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono, fontSize: 9,
              }}
            >
              {muted ? "MUTED" : "MIC"}
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
