"use client";

/**
 * Sheet TTS mute preference (specs/voice-tts-sheet-replies-plan.md §5).
 *
 * Mirrors the localStorage pattern in lib/caddie/persona.ts. NORTHSTAR is a
 * quiet, calm app — audio that starts itself is the opposite of quiet — so
 * this defaults OFF (opt-in). The one-tap speaker toggle in the sheet header
 * flips it; useSheetTTS.speak() checks it before ever fetching audio.
 */

const STORAGE_KEY = "looper.sheetTtsEnabled";

export function getSheetTtsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSheetTtsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Private mode / quota — non-fatal, just doesn't persist this device.
  }
}
