// Fire-and-forget voice telemetry (specs/voice-agent-audit.md P1.4).
// Events queue locally and flush in small batches; a telemetry failure can
// NEVER affect dictation (all paths swallow). The backend turns these into
// structured log lines so fallback rates and latencies are finally visible.

import { API_BASE, authHeaders } from "@/lib/api";

interface VoiceEvent {
  surface: string;
  event: string;
  detail?: string;
  ms?: number;
}

const queue: VoiceEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_AFTER_MS = 8_000;
const FLUSH_AT_COUNT = 12;
const MAX_QUEUE = 60;

/** Record one event. Synchronous, allocation-cheap, never throws.
 *  Pass `flush: true` for foreground failure/reliability events that should
 *  drain the whole queue immediately (ride-along batched events included)
 *  rather than wait for the count/timer — the flag is a control signal only,
 *  it never enters the queued/POSTed event object. */
export function voiceEvent(
  surface: string,
  event: string,
  data?: { detail?: string; ms?: number; flush?: boolean },
): void {
  try {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ surface, event, detail: data?.detail, ms: data?.ms });
    if (data?.flush) {
      void flushVoiceEvents();
    } else if (queue.length >= FLUSH_AT_COUNT) {
      void flushVoiceEvents();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => void flushVoiceEvents(), FLUSH_AFTER_MS);
    }
  } catch {
    /* telemetry must never break the caller */
  }
}

/** Ship the queue (batched). Exposed for pagehide flushing and tests. */
export async function flushVoiceEvents(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const events = queue.splice(0, queue.length);
  try {
    await fetch(`${API_BASE}/api/voice/telemetry`, {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
      keepalive: true, // survives sheet close / navigation
    });
  } catch {
    /* dropped — never retry-loop telemetry */
  }
}

// Best-effort flush when the app backgrounds (iOS) or the page hides.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushVoiceEvents();
  });
}

// pagehide is the reliable iOS/WKWebView background/suspend signal —
// visibilitychange can miss it. Double-firing with the listener above is
// harmless: flushVoiceEvents() on an empty queue returns early.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flushVoiceEvents());
}
