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

/**
 * Human-safe error line: backend failures can surface as raw JSON bodies
 * (e.g. '{"detail": "list index out of range"}' — the owner saw exactly that
 * in the sheet). Pass anything that LOOKS machine-made through to a calm
 * fallback; keep short human sentences as-is.
 */
export function humanizeVoiceError(message: string | undefined, fallback: string): string {
  const m = (message ?? "").trim();
  if (!m) return fallback;
  const looksRaw =
    m.startsWith("{") ||
    m.startsWith("[") ||
    m.includes('"detail"') ||
    /index out of range|traceback|exception|typeerror|keyerror/i.test(m) ||
    m.length > 90;
  return looksRaw ? fallback : m;
}
