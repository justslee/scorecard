"use client";

/**
 * Sheet TTS mute preference (specs/voice-tts-sheet-replies-plan.md §5).
 *
 * Mirrors the localStorage pattern in lib/caddie/persona.ts. NORTHSTAR is a
 * quiet, calm app — audio that starts itself is the opposite of quiet — so
 * this defaults OFF (opt-in). The one-tap speaker toggle in the sheet header
 * flips it; useSheetTTS.speak() checks it before ever fetching audio.
 */

import { storageKey } from "../storage-keys";

// Per-user namespaced (specs/multi-user-epic-plan.md §3.5) — computed per
// call, not cached, so a user switch on one device reads the new namespace.
function ttsStorageKey(): string {
  return storageKey("sheet_tts_enabled");
}

export function getSheetTtsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(ttsStorageKey()) === "1";
  } catch {
    return false;
  }
}

export function setSheetTtsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ttsStorageKey(), enabled ? "1" : "0");
  } catch {
    // Private mode / quota — non-fatal, just doesn't persist this device.
  }
}
