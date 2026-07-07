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

function createAudioEl(onEndedOrPaused: () => void): HTMLAudioElement {
  const el = document.createElement("audio");
  el.setAttribute("playsinline", ""); // inline playback on iOS WKWebView
  el.style.display = "none";
  el.addEventListener("ended", onEndedOrPaused);
  el.addEventListener("pause", onEndedOrPaused);
  document.body.appendChild(el);
  return el;
}

export function useSheetTTS(): SheetTTS {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const onEndedOrPaused = useCallback(() => setIsSpeaking(false), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
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
      audioElRef.current = createAudioEl(onEndedOrPaused);
    }
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    // Bless-play-then-pause inside the gesture so a later programmatic
    // .play() is allowed under WKWebView autoplay rules (mirrors the
    // realtime.ts remote-audio-sink pattern).
    try {
      const p = audioElRef.current.play();
      if (p && typeof p.then === "function") {
        p.then(() => audioElRef.current?.pause()).catch(() => {
          /* autoplay blocked before unlock — a real gesture-driven speak() still works */
        });
      } else {
        audioElRef.current.pause();
      }
    } catch {
      /* best effort — never block the caller's gesture handler */
    }
  }, [onEndedOrPaused]);

  const speak = useCallback(
    (text: string, personaId: string) => {
      const trimmed = (text || "").trim();
      if (!trimmed || !getSheetTtsEnabled()) return;

      // Overlap handling: a new reply cancels an outstanding fetch and stops
      // whatever is currently playing before starting the new one.
      abortRef.current?.abort();
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
            audioElRef.current = createAudioEl(onEndedOrPaused);
          }
          audioElRef.current.src = url;
          setIsSpeaking(true);
          await audioElRef.current.play();
        } catch (err) {
          if (controller.signal.aborted) return; // expected — a newer speak() took over
          setIsSpeaking(false);
          voiceEvent("sheet-tts", "speak_failed", {
            detail: err instanceof Error ? err.name : "unknown",
          });
        }
      })();
    },
    [onEndedOrPaused, releaseObjectUrl],
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
