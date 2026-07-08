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
 *
 * Sentence-level pipelining (specs/caddie-realtime-conversation-plan.md
 * §6.5.4, Slice A2): internally this is a single ordered PLAY QUEUE, always
 * played back-to-back on the SAME persistent element. `speak()` is sugar for
 * "one chunk, whole turn" (unchanged observable behavior — every existing
 * caller/test keeps working); `beginStream()`/`enqueue()`/`endStream()` let a
 * caller feed the queue sentence-by-sentence as an SSE reply streams in, so
 * the first sentence can start playing while the rest is still arriving.
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
  /** Speak a completed reply as ONE chunk — the whole turn. No-op if the
   *  mute pref is off or text is empty. Clears any in-flight/queued chunks
   *  first — a single element makes double-voice structurally impossible.
   *  Never throws. */
  speak(text: string, personaId: string): void;
  /** Mark the start of a NEW streamed turn — clears any leftover
   *  queued/playing chunks from a previous (now superseded) turn and resets
   *  the once-per-turn `onSpeakStart`/`onPlaybackEnd` guards. Call once,
   *  before the first `enqueue()` of a turn. Safe to call even if nothing
   *  needs clearing. */
  beginStream(): void;
  /** Append one sentence-sized chunk to the current turn's play queue —
   *  synthesizes it and, if nothing is currently playing, starts it as soon
   *  as it's ready. Subsequent chunks play back-to-back on the same element.
   *  No-op if the mute pref is off or text is empty. */
  enqueue(text: string, personaId: string): void;
  /** Mark the current turn's text as fully sent — once the queue then
   *  drains (the last chunk's natural `ended`), `onPlaybackEnd` fires. */
  endStream(): void;
  /** Silence current playback and clear the whole queue (tap-to-silence /
   *  sheet close / unmount / barge-in). Never re-arms hands-free. */
  stop(): void;
  isSpeaking: boolean;
}

export interface UseSheetTTSOptions {
  onPlaybackEnd?: () => void;
  /** Fires once when a REAL reply's audio actually begins playing (play()
   *  resolved) — never for the silent prime clip in unlock(), never for an
   *  aborted/superseded chunk (specs/caddie-realtime-telemetry-plan.md
   *  §1.5). On the queued path this fires on the FIRST chunk of the turn
   *  only. Pure signal only — this hook emits no telemetry itself. */
  onSpeakStart?: () => void;
}

interface QueueItem {
  id: number;
  text: string;
  personaId: string;
  controller: AbortController;
  blobUrl: string | null;
  status: "loading" | "ready" | "playing" | "error";
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
  const objectUrlRef = useRef<string | null>(null);

  // The ordered play queue for the CURRENT turn, and per-turn bookkeeping.
  const queueRef = useRef<QueueItem[]>([]);
  const nextIdRef = useRef(0);
  const playingIdRef = useRef<number | null>(null);
  // True once the caller has told us the current turn's text is fully sent
  // (via endStream(), or immediately for a single-shot speak()) — the queue
  // draining to empty only ends the turn (fires onPlaybackEnd) once this is
  // also true, so a mid-stream gap (waiting on the next sentence) never
  // re-arms hands-free early.
  const streamEndedRef = useRef(false);
  // Guards onPlaybackEnd firing more than once for the same turn.
  const turnEndedFiredRef = useRef(false);
  // Guards onSpeakStart firing more than once per turn (fires on chunk 1 only).
  const turnFirstAudioFiredRef = useRef(false);
  // True only while a REAL chunk is playing (set right before a chunk's
  // .play(), cleared by stop()/a new turn/onEnded). Guards the `ended`
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

  // Aborts every in-flight/queued chunk, stops playback, and resets to idle —
  // the shared primitive behind stop()/speak()/beginStream(). Does NOT touch
  // streamEndedRef/turnEndedFiredRef/turnFirstAudioFiredRef; callers set
  // those explicitly since "clear the queue" and "what turn are we starting"
  // are different concerns.
  const clearAllInternal = useCallback(() => {
    for (const item of queueRef.current) {
      item.controller.abort();
      if (item.blobUrl && item.blobUrl !== objectUrlRef.current) {
        try {
          URL.revokeObjectURL(item.blobUrl);
        } catch {
          /* best effort */
        }
      }
    }
    queueRef.current = [];
    playingIdRef.current = null;
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

  // Forward-declared via a ref so playItem/maybeAdvance (defined with useCallback,
  // referencing each other) can call one another without a definition-order
  // problem — both are stable (empty deps) so this is set once.
  const maybeAdvanceRef = useRef<() => void>(() => {});

  const onEnded = useCallback(() => {
    setIsSpeaking(false);
    // Only a real chunk's natural completion advances the queue / re-arms
    // the hands-free loop — the silent prime clip in unlock() can also fire
    // `ended`, and must not.
    if (!playingRealRef.current) return;
    playingRealRef.current = false;
    const finishedId = playingIdRef.current;
    playingIdRef.current = null;
    if (finishedId != null && queueRef.current[0]?.id === finishedId) {
      queueRef.current.shift();
    }
    releaseObjectUrl();
    maybeAdvanceRef.current();
  }, [releaseObjectUrl]);
  const onPaused = useCallback(() => setIsSpeaking(false), []);

  const playItem = useCallback(
    (item: QueueItem) => {
      playingIdRef.current = item.id;
      item.status = "playing";
      releaseObjectUrl();
      objectUrlRef.current = item.blobUrl;
      if (!audioElRef.current) {
        audioElRef.current = createAudioEl(onEnded, onPaused);
      }
      audioElRef.current.src = item.blobUrl!;
      setIsSpeaking(true);
      playingRealRef.current = true;
      const controller = item.controller;
      void (async () => {
        try {
          await audioElRef.current!.play();
          if (controller.signal.aborted || playingIdRef.current !== item.id) return; // superseded mid-await
          if (!turnFirstAudioFiredRef.current) {
            turnFirstAudioFiredRef.current = true;
            onSpeakStartRef.current?.();
          }
        } catch (err) {
          if (controller.signal.aborted) return; // expected — superseded
          setIsSpeaking(false);
          voiceEvent("sheet-tts", "speak_failed", {
            detail: err instanceof Error ? err.name : "unknown",
          });
          // A failed play() ends this turn silently — mirrors the
          // non-queued path's existing behavior: a TTS failure never
          // re-arms hands-free, and any remaining queued chunks are
          // dropped rather than risking more failed play() calls.
          playingIdRef.current = null;
          playingRealRef.current = false;
          clearAllInternal();
          turnEndedFiredRef.current = true; // suppress any late finalize
        }
      })();
    },
    [clearAllInternal, onEnded, onPaused, releaseObjectUrl],
  );

  const maybeAdvance = useCallback(() => {
    if (playingIdRef.current != null) return; // already playing something
    while (queueRef.current.length > 0) {
      const head = queueRef.current[0];
      if (head.status === "error") {
        queueRef.current.shift();
        continue;
      }
      if (head.status === "loading") return; // wait — retried when it resolves
      playItem(head);
      return;
    }
    // Queue is empty. Only a genuinely complete turn (endStream() already
    // called, or a single-shot speak()) fires onPlaybackEnd — a mid-stream
    // gap (more sentences still coming) stays quiet.
    if (streamEndedRef.current && !turnEndedFiredRef.current) {
      turnEndedFiredRef.current = true;
      onPlaybackEndRef.current?.();
    }
  }, [playItem]);
  // Ref-mirrored (not assigned during render) so onEnded/enqueueInternal —
  // defined above maybeAdvance to avoid a circular useCallback dependency —
  // always call the latest identity via an effect, matching the
  // onPlaybackEndRef/onSpeakStartRef pattern above.
  useEffect(() => {
    maybeAdvanceRef.current = maybeAdvance;
  }, [maybeAdvance]);

  const enqueueInternal = useCallback(
    (text: string, personaId: string) => {
      const controller = new AbortController();
      const item: QueueItem = {
        id: ++nextIdRef.current,
        text,
        personaId,
        controller,
        blobUrl: null,
        status: "loading",
      };
      queueRef.current.push(item);
      void (async () => {
        try {
          const blob = await speakCaddieReply(text, personaId, controller.signal);
          if (controller.signal.aborted) return;
          item.blobUrl = URL.createObjectURL(blob);
          item.status = "ready";
          maybeAdvanceRef.current();
        } catch (err) {
          if (controller.signal.aborted) return; // expected — superseded
          item.status = "error";
          voiceEvent("sheet-tts", "speak_failed", {
            detail: err instanceof Error ? err.name : "unknown",
          });
          maybeAdvanceRef.current();
        }
      })();
      maybeAdvanceRef.current();
    },
    [],
  );

  const stop = useCallback(() => {
    clearAllInternal();
    // Suppress any late finalize from an already-aborted item's promise
    // settling — this turn is over, and it must never re-arm hands-free.
    streamEndedRef.current = true;
    turnEndedFiredRef.current = true;
  }, [clearAllInternal]);

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
    // so the later programmatic .play() in speak()/enqueue() is reliably
    // allowed under WKWebView autoplay rules (mirrors the realtime.ts
    // remote-audio-sink pattern). playingRealRef stays false through this
    // dance — the prime clip's `ended`/`pause` must never re-arm the
    // hands-free loop (guarded in onEnded above).
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
      // A single chunk IS the whole turn — clear any previous turn's
      // leftovers first (overlap handling: a single element makes
      // double-voice structurally impossible).
      clearAllInternal();
      turnFirstAudioFiredRef.current = false;
      turnEndedFiredRef.current = false;
      streamEndedRef.current = true;
      enqueueInternal(trimmed, personaId);
    },
    [clearAllInternal, enqueueInternal],
  );

  const beginStream = useCallback(() => {
    clearAllInternal();
    turnFirstAudioFiredRef.current = false;
    turnEndedFiredRef.current = false;
    streamEndedRef.current = false;
  }, [clearAllInternal]);

  const enqueue = useCallback(
    (text: string, personaId: string) => {
      const trimmed = (text || "").trim();
      if (!trimmed || !getSheetTtsEnabled()) return;
      enqueueInternal(trimmed, personaId);
    },
    [enqueueInternal],
  );

  const endStream = useCallback(() => {
    streamEndedRef.current = true;
    maybeAdvanceRef.current();
  }, []);

  // Unmount cleanup — mirrors realtime.ts's teardown of its audio sink.
  useEffect(() => {
    return () => {
      for (const item of queueRef.current) item.controller.abort();
      queueRef.current = [];
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

  return { unlock, speak, beginStream, enqueue, endStream, stop, isSpeaking };
}
