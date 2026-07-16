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

import { storageKey } from "../storage-keys";

// Per-user namespaced (specs/multi-user-epic-plan.md §3.5) — computed per
// call, not cached, so a user switch on one device reads the new namespace.
function liveModeStorageKey(): string {
  return storageKey("caddie_live_mode");
}

export function getCaddieLiveMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(liveModeStorageKey()) !== "0";
  } catch {
    return true;
  }
}

export function setCaddieLiveMode(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(liveModeStorageKey(), enabled ? "1" : "0");
  } catch {
    // Private mode / quota — non-fatal, just doesn't persist this device.
  }
}
