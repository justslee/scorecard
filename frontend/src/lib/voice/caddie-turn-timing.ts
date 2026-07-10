/**
 * caddie-turn-timing — per-turn caddie stage-timing telemetry
 * (specs/caddie-realtime-telemetry-plan.md). Extends the existing
 * `voiceEvent` bus with the caddie-turn latency legs on BOTH live paths:
 * the classic sheet (Deepgram VAD + SSE text + useSheetTTS) and the
 * Realtime orb (useVoiceCaddie). Telemetry only — no behavior change.
 *
 * Design rules (baked in so callers stay dumb and safe):
 *   - Emit only COMPLETE legs — a leg needs BOTH bracketing marks for the
 *     current turn. No mark → no leg. Never a bogus 0 or a huge number.
 *   - Sanity clamp — a computed leg that is <=0ms or >60000ms is dropped
 *     (stale/aborted-turn cross-talk, clock weirdness).
 *   - Once per turn — each leg emits at most once per turn; a second
 *     markFirstToken()/markFirstAudio() in the same turn is a no-op.
 *   - markEos() resets all downstream marks — the per-turn reset that makes
 *     rapid successive turns safe.
 *   - Everything is wrapped in try/catch and swallows, exactly like the
 *     voiceEvent bus — a telemetry failure can NEVER throw into
 *     dictation/audio.
 *
 * The headline `caddie.eos_to_first_audio` is flushed IMMEDIATELY at
 * markFirstAudio() (rather than waiting for the batch timer/visibilitychange)
 * so it survives an iOS background before the batch would otherwise fire
 * (the known "voicetel flush-drop" — §3 of the plan). The two earlier legs
 * (`caddie.eos_to_transcript`, `caddie.transcript_to_first_token`) flush
 * immediately too, right after each is emitted — they must survive an iOS
 * WKWebView suspend even when first audio is NEVER marked (e.g. `onSpeakStart`
 * doesn't fire), so a turn's earlier progress isn't lost just because it never
 * reaches the terminal mark (specs/voicetel-timing-immediate-flush-plan.md).
 */

import { voiceEvent, flushVoiceEvents } from "@/lib/voice/telemetry";

/** A leg above this is almost certainly stale/cross-turn skew, not a real duration. */
const MAX_PLAUSIBLE_MS = 60_000;

export interface CaddieTurnTimerOptions {
  /** "caddie-turn" (classic sheet) | "caddie-rt" (Realtime orb). */
  surface: string;
  /** Injectable monotonic clock — defaults to performance.now(). */
  now?: () => number;
  /** Injectable event bus — defaults to the real voiceEvent (swallows, never throws). */
  emit?: (surface: string, event: string, data?: { detail?: string; ms?: number }) => void;
  /** Injectable immediate flush — defaults to the real flushVoiceEvents. */
  flush?: () => void | Promise<void>;
}

export interface CaddieTurnTimer {
  /** Start of turn — records t_eos and resets all downstream marks/flags. */
  markEos(): void;
  /** Final transcript resolved. Idempotent — only the first call per turn sticks. */
  markTranscript(): void;
  /** First SSE token. Idempotent — only the first call per turn sticks. */
  markFirstToken(): void;
  /** Audio actually playing. TERMINAL — emits the remaining legs, then flushes. */
  markFirstAudio(): void;
}

export function createCaddieTurnTimer(opts: CaddieTurnTimerOptions): CaddieTurnTimer {
  const surface = opts.surface;
  const now = opts.now ?? (() => performance.now());
  const emitFn = opts.emit ?? voiceEvent;
  const flushFn = opts.flush ?? flushVoiceEvents;

  let tEos: number | null = null;
  let tTranscript: number | null = null;
  let tFirstToken: number | null = null;
  let audioMarked = false; // once-per-turn guard for markFirstAudio

  /** Bracketed duration, or null if incomplete or outside the plausible range. */
  const leg = (t1: number | null, t2: number): number | null => {
    if (t1 === null) return null;
    const ms = Math.round(t2 - t1);
    if (ms <= 0 || ms > MAX_PLAUSIBLE_MS) return null;
    return ms;
  };

  const safeEmit = (event: string, ms: number): void => {
    try {
      emitFn(surface, event, { ms });
    } catch {
      /* telemetry must never break the caller */
    }
  };

  const safeFlush = (): void => {
    try {
      const result = flushFn();
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {
          /* dropped — never retry-loop telemetry */
        });
      }
    } catch {
      /* telemetry must never break the caller */
    }
  };

  const markEos = (): void => {
    try {
      tEos = now();
      tTranscript = null;
      tFirstToken = null;
      audioMarked = false;
    } catch {
      /* telemetry must never break the caller */
    }
  };

  const markTranscript = (): void => {
    try {
      if (tTranscript !== null) return; // idempotent — only the first sticks
      const t = now();
      tTranscript = t;
      const ms = leg(tEos, t);
      if (ms !== null) {
        safeEmit("caddie.eos_to_transcript", ms);
        safeFlush();
      }
    } catch {
      /* telemetry must never break the caller */
    }
  };

  const markFirstToken = (): void => {
    try {
      if (tFirstToken !== null) return; // idempotent — only the first sticks
      const t = now();
      tFirstToken = t;
      const ms = leg(tTranscript, t);
      if (ms !== null) {
        safeEmit("caddie.transcript_to_first_token", ms);
        safeFlush();
      }
    } catch {
      /* telemetry must never break the caller */
    }
  };

  const markFirstAudio = (): void => {
    try {
      if (audioMarked) return; // once per turn — collapses repeated calls (e.g. Realtime's many 'speaking' transitions)
      audioMarked = true;
      const t = now();
      const tokenToAudioMs = leg(tFirstToken, t);
      if (tokenToAudioMs !== null) safeEmit("caddie.first_token_to_first_audio", tokenToAudioMs);
      const headlineMs = leg(tEos, t);
      if (headlineMs !== null) safeEmit("caddie.eos_to_first_audio", headlineMs);
      // Flush synchronously right after the headline emit — the headline is
      // the one number we cannot afford to lose to an iOS background before
      // the batch timer fires.
      safeFlush();
    } catch {
      /* telemetry must never break the caller */
    }
  };

  return { markEos, markTranscript, markFirstToken, markFirstAudio };
}
