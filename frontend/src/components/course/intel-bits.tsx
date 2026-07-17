"use client";

/**
 * Shared yardage-book bits for CourseIntel (course-discovery-intel) — used by
 * BOTH the map tap-sheet (CourseIntelSheet.tsx) and the course detail page
 * (CourseDetailClient.tsx), so the two surfaces render identical stars/prose
 * treatment. Reuses the existing yardage-book tokens only — no new design
 * language, no new component library (NORTHSTAR.md).
 */

import { useState } from "react";
import { T } from "@/components/yardage/tokens";

// ── InkStars — typographic stars, NEVER colored/gold ───────────────────────

/**
 * `★★★★☆`-style glyphs in `T.ink` + `4.3 (12)` in `T.mono`. `count === 0`
 * (or `avg` is null) renders the honest empty-state line instead — the
 * empty state IS the content, never a fabricated "0.0★".
 */
export function InkStars({ avg, count }: { avg: number | null; count: number }) {
  if (count === 0 || avg == null) {
    return (
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 14,
          color: T.pencilSoft,
          letterSpacing: -0.1,
        }}
      >
        No reviews yet — play it and be the first.
      </div>
    );
  }
  const filled = Math.max(0, Math.min(5, Math.round(avg)));
  const glyphs = "★".repeat(filled) + "☆".repeat(5 - filled);
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
      <span style={{ fontFamily: T.serif, fontSize: 15, color: T.ink, letterSpacing: 1 }}>
        {glyphs}
      </span>
      <span
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          letterSpacing: 1,
          color: T.pencilSoft,
        }}
      >
        {avg.toFixed(1)} ({count})
      </span>
    </div>
  );
}

// ── ClampedProse — N-line clamp + a calm "More" text-button expand ─────────

export function ClampedProse({
  text,
  lines = 2,
  fontSize = 15,
}: {
  text: string;
  lines?: number;
  fontSize?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <div
        style={{
          fontFamily: T.serif,
          fontSize,
          color: T.ink,
          letterSpacing: -0.1,
          lineHeight: 1.45,
          ...(expanded
            ? {}
            : {
                display: "-webkit-box",
                WebkitLineClamp: lines,
                WebkitBoxOrient: "vertical" as const,
                overflow: "hidden",
              }),
        }}
      >
        {text}
      </div>
      {!expanded && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            marginTop: 4,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 13,
            color: T.pencil,
            minHeight: 32,
          }}
        >
          More
        </button>
      )}
    </div>
  );
}
