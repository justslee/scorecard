"use client";

/**
 * Caddie live-mode (Realtime transport) preference
 * (specs/caddie-realtime-slice-c1-plan.md §2).
 *
 * Mirrors the localStorage pattern in tts-pref.ts exactly. Default OFF — the
 * in-round Ask Caddie sheet renders the classic Deepgram/tap-to-talk path
 * exactly as today until this key is explicitly set to "1". Stage 1 has no
 * shipped UI toggle: the owner flips it via a one-shot `?liveMode=1` URL
 * param on the round page (see RoundPageClient), or via the browser console
 * (`localStorage.setItem('looper.caddieLiveMode','1')`) on a tethered debug
 * build.
 */

const STORAGE_KEY = "looper.caddieLiveMode";

export function getCaddieLiveMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCaddieLiveMode(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Private mode / quota — non-fatal, just doesn't persist this device.
  }
}
