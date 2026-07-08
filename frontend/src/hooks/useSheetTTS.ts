"use client";

/**
 * useSheetTTS — spoken caddie replies for the text sheets
 * (specs/voice-tts-sheet-replies-plan.md).
 *
 * Single owner of one HTMLAudioElement per hook instance, reusing the exact
 * iOS-unlock pattern from lib/voice/realtime.ts (DOM-attached, playsinline,
 * hidden, bless-play-then-pause inside a gesture). Strictly additive: the
 * reply text is always rendered by the caller regardless of what TTS does —
 * every failure path here is swallowed (autoplay blocked, offline, TTS
 * error) and reported via lib/voice/telemetry.ts, never thrown at the caller.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { speakCaddieReply } from "@/lib/caddie/api";
import { getSheetTtsEnabled } from "@/lib/voice/tts-pref";
import { voiceEvent } from "@/lib/voice/telemetry";

// A short, known-good, silent mp3 encoded as a data URI — used to prime the
// persistent audio element with a REAL decodable source inside the unlocking
// gesture (specs/fix-ios-tts-playback-plan.md Part B). A genuine
// gesture-activated media load makes the later programmatic speak() .play()
// reliably allowed under WKWebView autoplay rules, rather than blessing an
// element with no `src` at all.
const SILENT_MP3_DATA_URI =
  "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0VAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV";

export interface SheetTTS {
  /** Bless the audio element for autoplay — call SYNCHRONOUSLY inside a user
   *  gesture (mic tap, speaker-toggle tap). Idempotent. */
  unlock(): void;
  /** Speak a completed reply. No-op if the mute pref is off or text is empty.
   *  Aborts any in-flight fetch/playback first — a single element makes
   *  double-voice structurally impossible. Never throws. */
  speak(text: string, personaId: string): void;
  /** Silence current playback (tap-to-silence / sheet close / unmount). */
  stop(): void;
  isSpeaking: boolean;
}

export interface UseSheetTTSOptions {
  onPlaybackEnd?: () => void;
  /** Fires once when a REAL reply's audio actually begins playing (play()
   *  resolved) — never for the silent prime clip in unlock(), never for an
   *  aborted/superseded speak() (specs/caddie-realtime-telemetry-plan.md
   *  §1.5). Pure signal only — this hook emits no telemetry itself. */
  onSpeakStart?: () => void;
}

function createAudioEl(onEnded: () => void, onPaused: () => void): HTMLAudioElement {
  const el = document.createElement("audio");
  el.setAttribute("playsinline", ""); // inline playback on iOS WKWebView
  el.style.display = "none";
  // Split, per the conversational-loop plan (specs/caddie-conversational-loop-plan.md
  // §3.3): `ended` = natural completion — the ONLY signal that should ever
  // re-arm hands-free listening. `pause` = stop()/a new speak()/barge-in —
  // must never re-arm (double-arm would otherwise be possible).
  el.addEventListener("ended", onEnded);
  el.addEventListener("pause", onPaused);
  document.body.appendChild(el);
  return el;
}

export function useSheetTTS(opts?: UseSheetTTSOptions): SheetTTS {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // True only while a REAL reply is playing (set right before speak()'s
  // .play(), cleared by stop() / a new speak() / onEnded). Guards the `ended`
  // re-arm against the silent prime clip in unlock() — the prime clip's
  // native `ended` must be inert, never re-arming the hands-free loop
  // (specs/fix-ios-tts-playback-plan.md Part B).
  const playingRealRef = useRef(false);
  // Ref-mirrored so the DOM listener (attached once, at element creation)
  // always calls the LATEST callback identity without recreating the audio
  // element every render (mirrors the convHistoryRef pattern elsewhere).
  const onPlaybackEndRef = useRef(opts?.onPlaybackEnd);
  useEffect(() => {
    onPlaybackEndRef.current = opts?.onPlaybackEnd;
  }, [opts?.onPlaybackEnd]);
  // Same ref-mirror pattern for onSpeakStart (telemetry's markFirstAudio seam).
  const onSpeakStartRef = useRef(opts?.onSpeakStart);
  useEffect(() => {
    onSpeakStartRef.current = opts?.onSpeakStart;
  }, [opts?.onSpeakStart]);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const onEnded = useCallback(() => {
    setIsSpeaking(false);
    // Only a real reply's natural completion re-arms the hands-free loop —
    // the silent prime clip in unlock() can also fire `ended`, and must not.
    if (playingRealRef.current) {
      playingRealRef.current = false;
      onPlaybackEndRef.current?.();
    }
  }, []);
  const onPaused = useCallback(() => setIsSpeaking(false), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    playingRealRef.current = false;
    const el = audioElRef.current;
    if (el) {
      try {
        el.pause();
        el.currentTime = 0;
      } catch {
        /* best effort */
      }
    }
    releaseObjectUrl();
    setIsSpeaking(false);
  }, [releaseObjectUrl]);

  const unlock = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!audioElRef.current) {
      audioElRef.current = createAudioEl(onEnded, onPaused);
    }
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    // Prime with a REAL, decodable source (a short silent mp3 data-URI) —
    // not just an empty-src element — so WebKit sees a genuine
    // gesture-activated media load. Bless-play-then-pause inside the gesture
    // so the later programmatic .play() in speak() is reliably allowed under
    // WKWebView autoplay rules (mirrors the realtime.ts remote-audio-sink
    // pattern). playingRealRef stays false through this dance — the prime
    // clip's `ended`/`pause` must never re-arm the hands-free loop (guarded
    // in onEnded above).
    try {
      audioElRef.current.src = SILENT_MP3_DATA_URI;
      const p = audioElRef.current.play();
      if (p && typeof p.then === "function") {
        p.then(() => audioElRef.current?.pause()).catch((err) => {
          // autoplay blocked before unlock — a real gesture-driven speak() still works
          voiceEvent("sheet-tts", "prime_failed", {
            detail: err instanceof Error ? err.name : "unknown",
          });
        });
      } else {
        audioElRef.current.pause();
      }
    } catch (err) {
      // never block the caller's gesture handler
      voiceEvent("sheet-tts", "prime_failed", {
        detail: err instanceof Error ? err.name : "unknown",
      });
    }
  }, [onEnded, onPaused]);

  const speak = useCallback(
    (text: string, personaId: string) => {
      const trimmed = (text || "").trim();
      if (!trimmed || !getSheetTtsEnabled()) return;

      // Overlap handling: a new reply cancels an outstanding fetch and stops
      // whatever is currently playing before starting the new one.
      abortRef.current?.abort();
      playingRealRef.current = false;
      const el = audioElRef.current;
      if (el) {
        try {
          el.pause();
          el.currentTime = 0;
        } catch {
          /* best effort */
        }
      }
      releaseObjectUrl();
      setIsSpeaking(false);

      const controller = new AbortController();
      abortRef.current = controller;

      void (async () => {
        try {
          const blob = await speakCaddieReply(trimmed, personaId, controller.signal);
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          if (!audioElRef.current) {
            // unlock() wasn't called first — create the element anyway; if
            // it isn't blessed, play() below simply rejects (swallowed).
            audioElRef.current = createAudioEl(onEnded, onPaused);
          }
          audioElRef.current.src = url;
          setIsSpeaking(true);
          playingRealRef.current = true;
          await audioElRef.current.play();
          if (controller.signal.aborted) return; // a newer speak() superseded this one mid-play()
          onSpeakStartRef.current?.();
        } catch (err) {
          if (controller.signal.aborted) return; // expected — a newer speak() took over
          setIsSpeaking(false);
          voiceEvent("sheet-tts", "speak_failed", {
            detail: err instanceof Error ? err.name : "unknown",
          });
        }
      })();
    },
    [onEnded, onPaused, releaseObjectUrl],
  );

  // Unmount cleanup — mirrors realtime.ts's teardown of its audio sink.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      releaseObjectUrl();
      const el = audioElRef.current;
      if (el) {
        try {
          el.pause();
          el.remove();
        } catch {
          /* best effort */
        }
      }
      audioElRef.current = null;
    };
  }, [releaseObjectUrl]);

  return { unlock, speak, stop, isSpeaking };
}
