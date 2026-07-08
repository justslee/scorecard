"use client";

/**
 * Caddie live-mode (Realtime transport) preference
 * (specs/caddie-realtime-slice-c1-plan.md §2).
 *
 * Mirrors the localStorage pattern in tts-pref.ts exactly. Default ON as of
 * 2026-07-09 (owner directive — the URL-param flag was unreachable in the
 * native app, and live mode IS the product: "this is the main priority").
 * The classic Deepgram/tap-to-talk path remains the automatic fallback for
 * every failure (connect/mic/offline/drop — C1+D never-dead contract) and
 * can be forced with `?liveMode=0` / this key set to "0".
 */

const STORAGE_KEY = "looper.caddieLiveMode";

export function getCaddieLiveMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
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
