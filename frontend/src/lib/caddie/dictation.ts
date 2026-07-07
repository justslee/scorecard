// Pure decision helpers for the CaddieSheet live-dictation path
// (specs/caddie-live-dictation-plan.md). Kept out of the component so the
// live-vs-fallback branch — the line that decides whether the "Transcribing…"
// dead state appears at all — is unit-testable without a DOM.

/** Which transcript source to use when the golfer taps stop. */
export interface DictationPick {
  source: "live" | "fallback";
  /** The transcript to send when source === "live" (trimmed). Empty for fallback. */
  transcript: string;
}

/**
 * Live wins whenever the streaming transcriber produced text and didn't
 * error mid-utterance — the words are already on screen, so the sheet goes
 * straight to `thinking` with no upload. Anything else (unsupported WKWebView,
 * socket failure, silence) falls back to the recorded-blob transcription,
 * where a brief "Transcribing…" is acceptable.
 */
export function pickDictationTranscript(
  liveSnapshot: string,
  liveFailed: boolean
): DictationPick {
  const transcript = liveSnapshot.trim();
  if (transcript && !liveFailed) return { source: "live", transcript };
  return { source: "fallback", transcript: "" };
}

/** The no-speech case — trims whitespace so "  " never reaches the caddie. */
export function isEmptyTranscript(t: string): boolean {
  return t.trim().length === 0;
}
