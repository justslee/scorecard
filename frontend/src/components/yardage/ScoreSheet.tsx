"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { T } from "./tokens";
import { Waveform } from "./Voice";
import type { SeedPlayer } from "./Scorecard";
import { VoiceRecorder, transcribeBlob } from "@/lib/voice/deepgram";
import { parseVoiceScoresLocally } from "@/lib/voice/parseVoiceScores";
import { missingScoreNote } from "@/lib/voice/confirm-guidance";
import { fetchAPI } from "@/lib/api";

// ---------------------------------------------------------------------------
// Voice state machine for the score-entry voice path
// ---------------------------------------------------------------------------

type ScoreVoicePhase =
  | "idle"      // "Or say…" mic cue visible
  | "listening" // recording — waveform animates, interim transcript shown
  | "thinking"  // transcribing or parsing — mic pulses
  | "confirm"   // parsed result shown, awaiting confirm or retry
  | "error";    // transcription or parse failure

// ---------------------------------------------------------------------------
// Inline icons (no lucide-react)
// ---------------------------------------------------------------------------

function MicIcon({ size = 20, stroke = "currentColor" }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function RefreshIcon({ size = 14, stroke = "currentColor" }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// DigitWheel
// ---------------------------------------------------------------------------

function DigitWheel({ value, onChange, par, accent }: { value: number | null; onChange: (v: number | null) => void; par: number; accent: string }) {
  const opts: (number | null)[] = [null, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const idx = opts.indexOf(value);
  const rowH = 56;

  return (
    <div
      style={{
        position: "relative",
        width: 92,
        height: rowH * 3,
        overflow: "hidden",
        maskImage: "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)",
      }}
    >
      <motion.div
        animate={{ y: -idx * rowH + rowH }}
        transition={T.spring}
        style={{ position: "absolute", left: 0, right: 0, top: 0 }}
      >
        {opts.map((o, i) => {
          const diff = o == null ? null : o - par;
          const color =
            o == null
              ? T.pencilSoft
              : diff! <= -2
              ? T.eagle
              : diff === -1
              ? T.birdie
              : diff === 0
              ? T.par
              : diff === 1
              ? T.bogey
              : T.double;
          const isActive = i === idx;
          return (
            <div
              key={i}
              onClick={() => onChange(o)}
              style={{
                height: rowH,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: T.serif,
                fontSize: isActive ? 54 : 38,
                color,
                opacity: isActive ? 1 : 0.35,
                fontVariantNumeric: "tabular-nums",
                transition: "font-size 0.18s, opacity 0.18s",
                cursor: "pointer",
              }}
            >
              {o ?? "—"}
            </div>
          );
        })}
      </motion.div>
      {/* Selection brackets */}
      <div style={{ position: "absolute", left: 0, right: 0, top: rowH, height: rowH, pointerEvents: "none" }}>
        <div style={{ position: "absolute", top: 6, left: 8, width: 10, height: 1.5, background: accent }} />
        <div style={{ position: "absolute", top: 6, left: 8, width: 1.5, height: 8, background: accent }} />
        <div style={{ position: "absolute", top: 6, right: 8, width: 10, height: 1.5, background: accent }} />
        <div style={{ position: "absolute", top: 6, right: 8, width: 1.5, height: 8, background: accent }} />
        <div style={{ position: "absolute", bottom: 6, left: 8, width: 10, height: 1.5, background: accent }} />
        <div style={{ position: "absolute", bottom: 6, left: 8, width: 1.5, height: 8, background: accent }} />
        <div style={{ position: "absolute", bottom: 6, right: 8, width: 10, height: 1.5, background: accent }} />
        <div style={{ position: "absolute", bottom: 6, right: 8, width: 1.5, height: 8, background: accent }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VoiceConfirmPanel — inline sub-component for the confirm step
// ---------------------------------------------------------------------------

function VoiceConfirmPanel({
  players,
  parsedScores,
  confidence,
  onApply,
  onRetry,
}: {
  players: SeedPlayer[];
  parsedScores: Record<string, number>;
  confidence: number | undefined;
  onApply: () => void;
  onRetry: () => void;
}) {
  // Low-confidence: undefined → treat as high (no cue).
  const isLow = typeof confidence === "number" && confidence < 0.65;
  const hasAnyScore = Object.keys(parsedScores).length > 0;
  // Calm, specific note naming the players the parse missed (low-conf only).
  const note = missingScoreNote(players, parsedScores, confidence);

  return (
    <div style={{ marginTop: 16 }}>
      {/* Confidence kicker — 10px matches VoiceRoundSetup/ScanSheet */}
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          letterSpacing: 1.4,
          color: isLow ? T.warningInk : T.pencil,
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {isLow ? "Double-check these — I wasn't sure" : "Confirm scores"}
      </div>

      {/* Specific, calm note naming who the parse missed (low-confidence only).
          Serif-italic = a quiet aside, not an alarm; matches the yardage-book voice. */}
      {note && (
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            lineHeight: 1.35,
            // Pencil, not amber: the kicker + tiles carry the alert; this is the
            // calm clarification beneath it (designer note — avoid 3 amber layers).
            color: T.pencil,
            marginBottom: 12,
          }}
        >
          {note}
        </div>
      )}

      {/* Per-player score tiles.
          Surgical amber: only absent/unparsed tiles get the wash — matched
          tiles are calm so the visual weight is on what's MISSING, not alarming
          the whole panel (mirrors ScanSheet's per-field approach). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        {players.map((p) => {
          const score = parsedScores[p.name];
          const hasParsed = score !== undefined;
          // Amber only on absent tiles when the parse is low-confidence.
          const tileAmber = isLow && !hasParsed;
          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                borderRadius: 12,
                background: tileAmber ? T.warningWash : T.paperDeep,
                // 88 opacity matches ScanSheet's sunlight-legible amber border.
                border: `1px solid ${tileAmber ? `${T.warningInk}88` : T.hairline}`,
              }}
            >
              <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, color: tileAmber ? T.warningInk : T.pencil, textTransform: "uppercase" }}>
                {p.name}
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 26, color: hasParsed ? T.ink : T.pencilSoft, letterSpacing: -0.5 }}>
                {hasParsed ? score : "—"}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer: "Try again" ghost (44pt) + "Apply scores" solid */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onRetry}
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
          onClick={onApply}
          disabled={!hasAnyScore}
          style={{
            flex: 1,
            padding: "12px",
            borderRadius: 99,
            border: "none",
            // Disabled: paperDeep bg + pencilSoft text so it's legible (not paper-on-paper).
            background: hasAnyScore ? T.ink : T.paperDeep,
            color: hasAnyScore ? T.paper : T.pencilSoft,
            fontFamily: T.sans,
            fontSize: 13,
            fontWeight: 500,
            cursor: hasAnyScore ? "pointer" : "not-allowed",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            opacity: hasAnyScore ? 1 : 0.5,
          }}
          aria-label="Apply scores"
        >
          <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Apply scores</span>
          <span style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.2, opacity: 0.7 }}>{"→"}</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScoreSheet
// ---------------------------------------------------------------------------

export default function ScoreSheet({
  open,
  onClose,
  hole,
  players,
  scores,
  onSetScore,
  accent,
}: {
  open: boolean;
  onClose: () => void;
  hole: { number: number; par: number };
  players: SeedPlayer[];
  scores: Record<string, (number | null)[]>;
  onSetScore: (pid: string, idx: number, val: number | null) => void;
  accent: string;
}) {
  const [activePid, setActivePid] = useState(players[0]?.id ?? "");

  // --- Voice state ---
  const [voicePhase, setVoicePhase] = useState<ScoreVoicePhase>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [parsedScores, setParsedScores] = useState<Record<string, number>>({});
  const [parseConfidence, setParseConfidence] = useState<number | undefined>(undefined);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Open-generation counter — incremented every time the sheet opens.
  // Async operations (startVoice, stopAndParse) snapshot the gen before each
  // await and bail if the gen has changed when they resume. This prevents:
  //   1. Hot-mic race: getUserMedia resolves after close → recorder leaks.
  //   2. Stale confirm: stopAndParse resolves after close → wrong-hole apply.
  // Increment happens in useLayoutEffect (fires synchronously during commit,
  // before any pending Promise callbacks resume), which is the earliest safe
  // place that doesn't trigger the react-hooks/refs render-body rule.
  const openGenRef = useRef(0);
  useLayoutEffect(() => {
    if (open) openGenRef.current++;
  }, [open]);

  const resetVoice = useCallback(() => {
    setVoicePhase("idle");
    setInterimTranscript("");
    setParsedScores({});
    setParseConfidence(undefined);
    setVoiceError(null);
  }, []);

  // When the sheet opens/closes, reset state.
  // Uses the React "store previous prop" pattern (setState during render) to
  // avoid the set-state-in-effect lint rule. Ref access is NOT done here
  // (lint: no refs during render) — ref cleanup lives in a separate effect.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setActivePid(players[0]?.id ?? "");
      resetVoice(); // also clear stale confirm state on every reopen
    }
    if (!open) resetVoice(); // clear voice state; refs cleaned up in effect
  }

  // Ref cleanup when the sheet closes (effect — refs only, no setState).
  useEffect(() => {
    if (!open) {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    }
  }, [open]);

  // Cancel mic on unmount.
  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const startVoice = useCallback(async () => {
    setVoiceError(null);
    setInterimTranscript("");
    setParsedScores({});
    setParseConfidence(undefined);
    // Snapshot gen BEFORE any await so it's accessible in both the try body and
    // the catch block (a const inside try is not in scope for catch).
    const gen = openGenRef.current;
    try {
      const recorder = new VoiceRecorder();
      // Assign to ref BEFORE await so the close-cleanup effect can reach it if
      // the sheet closes during the getUserMedia permission prompt.
      recorderRef.current = recorder;

      await recorder.start(); // getUserMedia — may show a browser permission dialog

      // Guard: bail if the sheet closed (ref was nulled by cleanup effect)
      // OR was reopened (gen changed). Both cases mean this recorder is stale.
      if (openGenRef.current !== gen || recorderRef.current !== recorder) {
        recorder.cancel();
        recorderRef.current = null;
        return;
      }

      setVoicePhase("listening");

      // Best-effort interim display via Web Speech API; Deepgram is authoritative.
      const SpeechRecognitionCtor =
        (typeof window !== "undefined" &&
          (window.SpeechRecognition ?? window.webkitSpeechRecognition)) ||
        null;
      if (SpeechRecognitionCtor) {
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
        recognition.onerror = () => { /* silent — Deepgram is authoritative */ };
        recognition.onend = () => { /* no-op */ };
        recognition.start();
        recognitionRef.current = recognition;
      }
    } catch (err) {
      // If the error fired after the sheet was closed/reopened, drop it silently.
      if (openGenRef.current !== gen) return;
      setVoiceError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone access denied. Allow mic access and try again."
          : "Failed to start microphone."
      );
      setVoicePhase("error");
    }
  }, []);

  const stopAndParse = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;

    // Snapshot gen before any await — used to detect close/reopen mid-flight.
    const gen = openGenRef.current;

    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setInterimTranscript("");
    setVoicePhase("thinking");

    try {
      const blob = await recorder.stop();
      recorderRef.current = null;
      if (openGenRef.current !== gen) return; // sheet closed during stop

      const transcribeResult = await transcribeBlob(blob);
      if (openGenRef.current !== gen) return; // sheet closed during transcription

      const transcript = transcribeResult.transcript.trim();
      if (!transcript) {
        setVoiceError("No speech detected. Try again.");
        setVoicePhase("error");
        return;
      }

      // Post to the backend; fall back to local heuristics on failure.
      const playerNames = players.map((p) => p.name);
      try {
        type ParseResponse = { hole: number; scores: Record<string, number>; confidence?: number };
        const parsed = await fetchAPI<ParseResponse>("/api/voice/parse-scores", {
          method: "POST",
          body: JSON.stringify({
            transcript,
            playerNames,
            hole: hole.number,
            par: hole.par,
          }),
        });
        if (openGenRef.current !== gen) return; // sheet closed during backend call
        setParsedScores(parsed.scores ?? {});
        setParseConfidence(parsed.confidence);
      } catch {
        if (openGenRef.current !== gen) return;
        // Backend unavailable — fall back to local parse.
        const local = parseVoiceScoresLocally(transcript, {
          playerNames,
          hole: hole.number,
          par: hole.par,
        });
        setParsedScores(local.scores ?? {});
        setParseConfidence(local.confidence);
      }

      if (openGenRef.current !== gen) return; // final guard before phase change
      setVoicePhase("confirm");
    } catch (err) {
      recorderRef.current = null;
      if (openGenRef.current !== gen) return;
      setVoiceError(
        err instanceof Error ? err.message : "Transcription failed."
      );
      setVoicePhase("error");
    }
  }, [players, hole]);

  const applyVoiceScores = useCallback(() => {
    for (const player of players) {
      const val = parsedScores[player.name];
      // Range-validate: parsers can yield 0 ("zero") or large numbers ("100").
      // Manual entry is constrained to 1–9; we allow up to 15 for voice
      // (a very bad hole on a par 5 is realistic). Out-of-range → skip silently.
      if (Number.isInteger(val) && val >= 1 && val <= 15) {
        onSetScore(player.id, hole.number - 1, val);
      }
    }
    onClose();
  }, [players, parsedScores, onSetScore, hole, onClose]);

  const handleMicTap = useCallback(() => {
    if (voicePhase === "listening") {
      stopAndParse();
    } else {
      startVoice();
    }
  }, [voicePhase, stopAndParse, startVoice]);

  const labelFor = (v: number, par: number) => {
    const diff = v - par;
    if (diff === -2) return "Eagle";
    if (diff === -1) return "Birdie";
    if (diff === 0) return "Par";
    if (diff === 1) return "Bogey";
    if (diff === 2) return "Double";
    return `+${diff}`;
  };

  const inConfirm = voicePhase === "confirm";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="sbackdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          style={{ position: "fixed", inset: 0, background: "rgba(26,42,26,0.3)", zIndex: 40 }}
        />
      )}
      {open && (
        <motion.div
          key="ssheet"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={T.springSoft}
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 50,
            background: T.paper,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            boxShadow: "0 -20px 50px rgba(26,42,26,0.25)",
            padding: "14px 20px 34px",
            maxWidth: 420,
            margin: "0 auto",
          }}
        >
          <div style={{ width: 40, height: 4, borderRadius: 99, background: T.hairline, margin: "0 auto 14px" }} />

          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase" }}>
                Hole {hole.number} · Par {hole.par}
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 22, fontStyle: "italic", color: T.ink, letterSpacing: -0.4, marginTop: 2 }}>Enter your score</div>
            </div>
            <button
              onClick={onClose}
              style={{
                width: 30,
                height: 30,
                borderRadius: 99,
                border: `1px solid ${T.hairline}`,
                background: "transparent",
                color: T.ink,
                fontSize: 16,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ×
            </button>
          </div>

          {/* Player tabs — unchanged */}
          <div style={{ display: "flex", gap: 6, marginBottom: 18, overflowX: "auto" }}>
            {players.map((p) => {
              const v = scores[p.id]?.[hole.number - 1] ?? null;
              const isActive = activePid === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setActivePid(p.id)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 99,
                    border: `1px solid ${isActive ? T.ink : T.hairline}`,
                    background: isActive ? T.ink : "transparent",
                    color: isActive ? T.paper : T.ink,
                    fontFamily: T.sans,
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.name}
                  {v != null && (
                    <span style={{ marginLeft: 6, opacity: 0.6, fontFamily: T.mono, fontSize: 11 }}>{v}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Digit wheel + Quick pick — unchanged primary path.
              De-emphasised in confirm phase so the confirm panel has clear
              visual priority; pointer-events blocked to prevent accidental taps. */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            opacity: inConfirm ? 0.35 : 1,
            pointerEvents: inConfirm ? "none" : "auto",
            transition: "opacity 0.2s",
          }}>
            <DigitWheel
              value={scores[activePid]?.[hole.number - 1] ?? null}
              onChange={(v) => onSetScore(activePid, hole.number - 1, v)}
              par={hole.par}
              accent={accent}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: 1.4, color: T.pencil, textTransform: "uppercase", marginBottom: 8 }}>
                Quick pick
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                {[hole.par - 2, hole.par - 1, hole.par, hole.par + 1, hole.par + 2, hole.par + 3]
                  .filter((v) => v >= 1 && v <= 9)
                  .map((v) => {
                    const isSel = scores[activePid]?.[hole.number - 1] === v;
                    return (
                      <button
                        key={v}
                        onClick={() => onSetScore(activePid, hole.number - 1, v)}
                        style={{
                          padding: "8px 4px",
                          borderRadius: 10,
                          border: `1px solid ${isSel ? accent : T.hairline}`,
                          background: isSel ? accent : "transparent",
                          // T.paper (warm parchment) instead of literal #fff — token-pure.
                          color: isSel ? T.paper : T.ink,
                          fontFamily: T.sans,
                          fontSize: 11,
                          fontWeight: 500,
                          cursor: "pointer",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 2,
                        }}
                      >
                        <span style={{ fontFamily: T.serif, fontSize: 18, fontWeight: 400 }}>{v}</span>
                        <span style={{ fontSize: 9, letterSpacing: 0.3, opacity: 0.8 }}>{labelFor(v, hole.par)}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          </div>

          {/* ── Voice entry path (additive — below manual entry) ── */}

          {/* Confirm panel — animated entry via AnimatePresence + motion.div,
              matching the slide-in feel of other voice surfaces. */}
          <AnimatePresence mode="wait">
            {inConfirm && (
              <motion.div
                key="voice-confirm"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.18 }}
              >
                <VoiceConfirmPanel
                  players={players}
                  parsedScores={parsedScores}
                  confidence={parseConfidence}
                  onApply={applyVoiceScores}
                  onRetry={resetVoice}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {voicePhase === "error" ? (
            /* Error state */
            <div
              style={{
                marginTop: 16,
                padding: "10px 14px",
                borderRadius: 14,
                border: `1px dashed ${T.hairline}`,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ flex: 1, fontFamily: T.serif, fontStyle: "italic", fontSize: 13, color: T.errorInk }}>
                {voiceError ?? "Couldn't hear that."}
              </div>
              {/* 44pt minimum touch target */}
              <button
                onClick={resetVoice}
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
            </div>

          ) : !inConfirm ? (
            /* Idle / listening / thinking — mic row */
            <div
              style={{
                marginTop: 16,
                padding: "10px 14px",
                borderRadius: 14,
                border: `1px dashed ${T.hairline}`,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              {/* Mic button — 44pt minimum touch target.
                  listening: scales + accent ring.
                  thinking: breathing opacity pulse so there's no dead air. */}
              <motion.button
                onClick={handleMicTap}
                disabled={voicePhase === "thinking"}
                whileTap={{ scale: 0.9 }}
                animate={
                  voicePhase === "listening"
                    ? { scale: [1, 1.08, 1] }
                    : voicePhase === "thinking"
                    ? { opacity: [0.5, 0.9, 0.5] }
                    : { scale: 1, opacity: 1 }
                }
                transition={
                  voicePhase === "thinking"
                    ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
                    : {
                        duration: 1.4,
                        repeat: voicePhase === "listening" ? Infinity : 0,
                        ease: "easeInOut",
                      }
                }
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 99,
                  border: "none",
                  background: voicePhase === "listening" ? accent : T.ink,
                  color: T.paper,
                  cursor: voicePhase === "thinking" ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  boxShadow: voicePhase === "listening"
                    ? `0 0 0 6px ${accent}22, 0 6px 16px rgba(26,42,26,0.2)`
                    : "0 4px 12px rgba(26,42,26,0.18)",
                }}
                aria-label={voicePhase === "listening" ? "Stop recording" : "Start voice score entry"}
              >
                {voicePhase === "listening" ? (
                  <Waveform accent={T.paper} bars={5} playing height={16} />
                ) : (
                  <MicIcon size={18} stroke={T.paper} />
                )}
              </motion.button>

              {/* Status text / interim transcript */}
              <div style={{ flex: 1 }}>
                {voicePhase === "listening" && interimTranscript.trim() ? (
                  <motion.div
                    key="interim"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15 }}
                  >
                    <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", marginBottom: 2 }}>
                      Hearing&hellip;
                    </div>
                    <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.inkSoft, lineHeight: 1.3 }}>
                      {interimTranscript}
                    </div>
                  </motion.div>
                ) : (
                  <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.pencil }}>
                    {voicePhase === "listening"
                      ? <span style={{ color: T.ink }}>Tap mic to stop</span>
                      : voicePhase === "thinking"
                      ? <span style={{ color: T.pencilSoft }}>One sec&hellip;</span>
                      : <>Or say <span style={{ color: T.ink }}>&ldquo;Justin four, Bob five&rdquo;</span></>}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
