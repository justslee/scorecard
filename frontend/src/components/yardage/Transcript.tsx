"use client";

// The ONE shared caddie/user turn primitive (specs/caddie-transcript-render-
// unify-plan.md). Every live surface that shows a caddie conversation —
// VoiceSheet's medallion turns, LooperSheet's stacked list, CaddieSheet's
// classic "Ask caddie" history + current-turn card, and CaddieSheet's
// Realtime live mode — renders turns through this component so the calm
// yardage-book idiom (flat mono caption + serif body, NO chat bubbles) is
// ONE implementation instead of four forks. Per-surface differences
// (medallion, waveform, streaming/listening/thinking, display vs book sizing)
// are COMPOSITION via the props below, never forked bubble markup.
//
// HARD INVARIANT: `Transcript` / `ConversationTurn` render EXACTLY the array
// they are given, in the given order, keyed by the CALLER's `turn.key`. This
// file owns VISUALS ONLY — it never sorts, dedups, filters, or invents keys.
// Ordering/dedup live upstream (lib/voice/realtime-ordering.ts,
// hooks/useCaddieLiveSession.ts) and are NOT touched here — violating this
// regresses the caddie-realtime-double-emit fix.

import type { CSSProperties, ReactNode } from "react";
import { motion } from "framer-motion";
import { T } from "./tokens";
import { PulseDot } from "./Voice";

// ── Visual constants (designer-authoritative, plan §2.3) ────────────────────
// A later design tweak should be a constants-only diff — do not inline these
// values elsewhere in this file.

const CAPTION_STYLE: CSSProperties = {
  fontFamily: T.mono,
  fontSize: 9,
  letterSpacing: 1.3,
  textTransform: "uppercase",
};

const CAPTION_MARGIN_BOTTOM = 6;

const USER_BODY_SIZE = { book: 20, display: 24 };
const USER_BODY_LINE_HEIGHT = { book: 1.28, display: 1.22 };
const USER_BODY_LETTER_SPACING = { book: -0.3, display: -0.4 };

const CADDIE_BODY_SIZE = { book: 16, display: 18 };
const CADDIE_BODY_LINE_HEIGHT = { book: 1.4, display: 1.4 };
const CADDIE_BODY_LETTER_SPACING = { book: -0.15, display: -0.15 };

// Spacing defaults — intent, not a pixel mandate (plan §2.3).
const USER_TURN_MARGIN_BOTTOM = 16;
const CADDIE_TURN_MARGIN_BOTTOM = 14;
const TRANSCRIPT_DEFAULT_GAP = 10;

const QUOTE_GLYPH_STYLE: CSSProperties = {
  color: T.pencil,
  fontSize: "85%",
  verticalAlign: "15%",
};

const STREAMING_PULSE_SIZE = 15;

export type TranscriptTurn = {
  /** Caller-owned React key — live mode: `m.id`; every other surface:
   *  `String(i)`. This primitive NEVER re-keys or invents its own. */
  key: string;
  speaker: "user" | "caddie";
  text: string;
  /** Still-growing turn: user → blinking listening caret (display size);
   *  caddie → live reply pulse in the caption row, opacity stays 1 (dimming
   *  a streaming reply reads as broken — designer override, plan §3.2). */
  streaming?: boolean;
  /** Reduced emphasis. Kept in the API; NOT used for live partials — see
   *  plan §3.2 (the designer overrode dimming streaming turns). */
  muted?: boolean;
};

export function ConversationTurn({
  turn,
  speakerLabel = "Caddy",
  size = "book",
  accent = T.ink,
  captionColor = T.pencilSoft,
  leading,
  captionTrailing,
}: {
  turn: TranscriptTurn;
  /** Caddie caption; user always shows "You". */
  speakerLabel?: string;
  /** book = LooperSheet base (default); display = VoiceSheet hero. */
  size?: "book" | "display";
  /** Streaming caret / pulse color. */
  accent?: string;
  /** Caption color override (default T.pencilSoft). */
  captionColor?: string;
  /** Slot left of the turn — VoiceSheet's medallion. */
  leading?: ReactNode;
  /** Slot after the caption — VoiceSheet's Waveform while the caddie speaks. */
  captionTrailing?: ReactNode;
}) {
  const isUser = turn.speaker === "user";
  const captionText = isUser ? "You" : speakerLabel;

  const bodyStyle: CSSProperties = isUser
    ? {
        fontFamily: T.serif,
        fontStyle: "italic",
        fontSize: USER_BODY_SIZE[size],
        lineHeight: USER_BODY_LINE_HEIGHT[size],
        letterSpacing: USER_BODY_LETTER_SPACING[size],
        color: T.ink,
      }
    : {
        fontFamily: T.serif,
        fontStyle: "italic",
        fontSize: CADDIE_BODY_SIZE[size],
        lineHeight: CADDIE_BODY_LINE_HEIGHT[size],
        letterSpacing: CADDIE_BODY_LETTER_SPACING[size],
        color: T.ink,
        // NO card, NO border, NO background wash (plan §2.3).
      };

  return (
    <div
      style={{
        marginBottom: isUser ? USER_TURN_MARGIN_BOTTOM : CADDIE_TURN_MARGIN_BOTTOM,
        display: "flex",
        gap: leading ? 10 : 0,
        alignItems: "flex-start",
      }}
    >
      {leading}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            ...CAPTION_STYLE,
            color: captionColor,
            marginBottom: CAPTION_MARGIN_BOTTOM,
          }}
        >
          <span>{captionText}</span>
          {!isUser && turn.streaming && <PulseDot accent={accent} size={STREAMING_PULSE_SIZE} />}
          {captionTrailing}
        </div>
        <div style={bodyStyle}>
          {/* The quote glyph is a SIBLING of the text span below — not a
              descendant of it — so `.textContent` on the matched text node
              stays exactly `turn.text` (no leading curly quote baked into
              the string). Both are inline, so they still read as one
              wrapped paragraph with the glyph as its visual first char. */}
          {isUser && <span style={QUOTE_GLYPH_STYLE}>&ldquo;</span>}
          <span>{turn.text}</span>
          {isUser && turn.streaming && (
            <motion.span
              animate={{ opacity: [0, 1, 0] }}
              transition={{ duration: 0.9, repeat: Infinity }}
              style={{
                display: "inline-block",
                width: 2,
                height: USER_BODY_SIZE[size] * 0.85,
                background: accent,
                marginLeft: 2,
                verticalAlign: "-3px",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function Transcript({
  turns,
  speakerLabel,
  size,
  accent,
  gap = TRANSCRIPT_DEFAULT_GAP,
}: {
  turns: TranscriptTurn[];
  speakerLabel?: string;
  size?: "book" | "display";
  accent?: string;
  gap?: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {turns.map((t) => (
        <ConversationTurn key={t.key} turn={t} speakerLabel={speakerLabel} size={size} accent={accent} />
      ))}
    </div>
  );
}
