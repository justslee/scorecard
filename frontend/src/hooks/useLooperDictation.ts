"use client";

// Shared live-dictation machinery for Looper sheets (specs/looper-orb-plan.md):
// VoiceRecorder keeps the fallback blob while DeepgramLiveTranscriber streams
// interim text; stopAndResolve() returns the final transcript (live-first,
// blob fallback — the same decision helpers as CaddieSheet). Each Looper
// context owns its brain; this hook owns the microphone.

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceRecorder, transcribeBlob } from "@/lib/voice/deepgram";
import { DeepgramLiveTranscriber } from "@/lib/voice/deepgram-live";
import { pickDictationTranscript, isEmptyTranscript } from "@/lib/caddie/dictation";
import { voiceEvent } from "@/lib/voice/telemetry";

export interface LooperDictation {
  listening: boolean;
  /** Live best-so-far transcript while listening. */
  interim: string;
  /** Open the mic + live stream. Sets micError instead of throwing. */
  start(): Promise<void>;
  /**
   * Stop and resolve the final transcript. Returns null when nothing usable
   * was heard (silence) or the session was cancelled meanwhile. May take a
   * moment on the fallback path (blob transcription) — callers show their own
   * thinking state around it.
   */
  stopAndResolve(): Promise<string | null>;
  /** Release the mic + stream silently (sheet closed, unmount). */
  cancel(): void;
  micError: string | null;
}

export interface LooperDictationOptions {
  /** Telemetry label for this consumer (e.g. "looper-general", "tee-time"). */
  surface?: string;
  /** Context vocabulary resolved at start() time (players, courses, golf terms). */
  getKeyterms?: () => readonly string[];
  /** Deepgram heard end-of-speech with words on the wire — callers auto-send.
   *  Fires at most once per listening session. */
  onUtteranceEnd?: () => void;
}

export function useLooperDictation(options?: LooperDictationOptions): LooperDictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [micError, setMicError] = useState<string | null>(null);

  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const utteranceFiredRef = useRef(false);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const liveRef = useRef<DeepgramLiveTranscriber | null>(null);
  const liveTranscriptRef = useRef("");
  const liveFailedRef = useRef(false);
  const genRef = useRef(0);

  const cancel = useCallback(() => {
    genRef.current++;
    liveRef.current?.stop();
    liveRef.current = null;
    recorderRef.current?.cancel();
    recorderRef.current = null;
    liveTranscriptRef.current = "";
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(async () => {
    setMicError(null);
    setInterim("");
    liveTranscriptRef.current = "";
    liveFailedRef.current = false;
    utteranceFiredRef.current = false;
    const gen = ++genRef.current;
    try {
      const recorder = new VoiceRecorder();
      await recorder.start();
      if (genRef.current !== gen) {
        recorder.cancel();
        return;
      }
      recorderRef.current = recorder;
      setListening(true);
      const stream = recorder.getStream();
      if (stream && DeepgramLiveTranscriber.isSupported()) {
        try {
          const live = new DeepgramLiveTranscriber(
            {
              onInterim: (t) => {
                if (genRef.current !== gen) return;
                liveTranscriptRef.current = t;
                setInterim(t);
              },
              onFinal: (t) => {
                if (genRef.current !== gen) return;
                liveTranscriptRef.current = t;
              },
              onUtteranceEnd: () => {
                if (genRef.current !== gen || utteranceFiredRef.current) return;
                utteranceFiredRef.current = true;
                optionsRef.current?.onUtteranceEnd?.();
              },
              onError: () => {
                liveFailedRef.current = true;
              },
            },
            { keyterms: optionsRef.current?.getKeyterms?.() ?? [] },
          );
          await live.start(stream);
          if (genRef.current !== gen) {
            live.stop();
            return;
          }
          liveRef.current = live;
          voiceEvent(optionsRef.current?.surface ?? "dictation", "live_start_ok");
        } catch {
          liveFailedRef.current = true;
          liveRef.current = null;
          voiceEvent(optionsRef.current?.surface ?? "dictation", "live_start_failed");
        }
      } else {
        liveFailedRef.current = true; // unsupported → blob fallback on stop
        voiceEvent(optionsRef.current?.surface ?? "dictation", "live_unsupported");
      }
    } catch (err) {
      setListening(false);
      voiceEvent(optionsRef.current?.surface ?? "dictation", "mic_error", {
        detail: err instanceof Error ? err.name : "unknown",
      });
      setMicError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Microphone access denied."
          : "Couldn't start the microphone."
      );
    }
  }, []);

  const stopAndResolve = useCallback(async (): Promise<string | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;
    const startedAt = performance.now();
    const gen = genRef.current;
    const snapshot = liveTranscriptRef.current;
    liveRef.current?.stop();
    liveRef.current = null;
    recorderRef.current = null;
    setListening(false);
    setInterim("");
    try {
      const pick = pickDictationTranscript(snapshot, liveFailedRef.current);
      let finalText: string;
      if (pick.source === "live") {
        recorder.cancel(); // mic released; the words are already resolved
        finalText = pick.transcript;
        voiceEvent(optionsRef.current?.surface ?? "dictation", "resolved_live", {
          ms: Math.round(performance.now() - startedAt),
        });
      } else {
        const blob = await recorder.stop();
        const result = await transcribeBlob(blob, {
          keyterms: optionsRef.current?.getKeyterms?.(),
        });
        if (genRef.current !== gen) return null;
        finalText = result.transcript;
        voiceEvent(optionsRef.current?.surface ?? "dictation", "resolved_fallback", {
          ms: Math.round(performance.now() - startedAt),
        });
      }
      return isEmptyTranscript(finalText) ? null : finalText;
    } catch {
      return null;
    }
  }, []);

  return { listening, interim, start, stopAndResolve, cancel, micError };
}
