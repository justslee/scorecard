"use client";

/**
 * CourseIntelSheet — the map tap-sheet (course-discovery-intel, Build 3).
 *
 * Swaps in for CourseScoutMap.tsx's old thin one-row tap card with a floating
 * INSET slide-up paper card — not the docked, edge-to-edge LooperSheetShell
 * (frontend/src/components/LooperSheet.tsx:138-172) idiom studied for the
 * motion/token language, but a smaller floating card that keeps the map
 * visible/interactive above it (per the designer). Same easing
 * (`T.springSoft`), same paper/hairline/serif/mono tokens already used by
 * CourseScoutMap's old card.
 *
 * Dumb renderer — fetching/state stays in CourseScoutMap.tsx. `intel` is
 * `null` while the `/intel` fetch is in flight OR after it fails; either
 * way the sheet already has the pin's name from `pin` alone and degrades to
 * name + subline + Add (Add must keep working even when `/intel` 500s).
 */

import { useCallback } from "react";
import { motion } from "framer-motion";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { sourceLabelFor, type InBoundsCourse } from "@/lib/golf-api";
import type { CourseIntel } from "@/lib/types";
import { InkStars, ClampedProse } from "@/components/course/intel-bits";

export interface CourseIntelSheetProps {
  pin: InBoundsCourse;
  /** null while loading OR on fetch failure — the sheet degrades honestly. */
  intel: CourseIntel | null;
  onAdd: () => void;
  onStartRound: () => void;
  onViewCourse: () => void;
  onClose: () => void;
}

const SWIPE_CLOSE_THRESHOLD = 70;

export default function CourseIntelSheet({
  pin,
  intel,
  onAdd,
  onStartRound,
  onViewCourse,
  onClose,
}: CourseIntelSheetProps) {
  const handleDragEnd = useCallback(
    (_: unknown, info: { offset: { y: number } }) => {
      if (info.offset.y > SWIPE_CLOSE_THRESHOLD) onClose();
    },
    [onClose],
  );

  const subline = pin.address ?? sourceLabelFor(pin.source);
  const description = intel?.description.text ?? null;
  const stats = intel?.stats;
  const hasStatsBlock = stats != null && stats.holesMapped != null && stats.parTotal != null;

  return (
    <motion.div
      key={pin.id}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={T.springSoft}
      drag="y"
      dragElastic={0.15}
      dragConstraints={{ top: 0, bottom: 0 }}
      onDragEnd={handleDragEnd}
      style={{
        position: "absolute",
        left: 14,
        right: 14,
        bottom: "max(14px, env(safe-area-inset-bottom))",
        maxHeight: "52dvh",
        display: "flex",
        flexDirection: "column",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        border: `1px solid ${T.hairline}`,
        borderRadius: 16,
        boxShadow: "0 10px 32px rgba(0,0,0,0.18)",
        zIndex: 10,
        overflow: "hidden",
      }}
    >
      {/* Grabber */}
      <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 4px", flexShrink: 0 }}>
        <div style={{ width: 36, height: 4, borderRadius: 99, background: T.hairline }} />
      </div>

      {/* Scrollable content */}
      <div style={{ overflowY: "auto", padding: "0 18px 14px" }}>
        <div
          style={{
            fontFamily: T.serif,
            fontSize: 18,
            color: T.ink,
            letterSpacing: -0.3,
            lineHeight: 1.2,
          }}
        >
          {pin.name}
        </div>
        {subline && (
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 8.5,
              letterSpacing: 1.1,
              color: T.pencilSoft,
              textTransform: "uppercase",
              marginTop: 3,
            }}
          >
            {subline}
          </div>
        )}

        {/* Stars — always rendered once intel has loaded (the empty state
            IS the content); omitted entirely while intel is still loading. */}
        {intel && (
          <div style={{ marginTop: 12 }}>
            <InkStars avg={intel.stars.avg} count={intel.stars.count} />
          </div>
        )}

        {/* Stats row — Holes / Par / Rounds played (+ Avg score if present).
            Omitted for an unmapped pin, mirroring the detail page's
            !isCenterOnly Tees guard. */}
        {hasStatsBlock && stats && (
          <div style={{ display: "flex", gap: 18, marginTop: 14 }}>
            <SheetMiniStat k="Holes" v={stats.holesMapped!} />
            <SheetMiniStat k="Par" v={stats.parTotal!} />
            <SheetMiniStat k="Rounds" v={stats.roundsPlayed} />
            {stats.avgScore != null && (
              <SheetMiniStat k="Avg score" v={stats.avgScore.toFixed(1)} />
            )}
          </div>
        )}

        {/* Description — 2-line clamp + "More" expand; omitted when null. */}
        {description && (
          <div style={{ marginTop: 14 }}>
            <ClampedProse text={description} lines={2} fontSize={14} />
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          <button
            onClick={onStartRound}
            style={{
              background: T.ink,
              color: T.paper,
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 14,
              border: "none",
              borderRadius: 99,
              padding: "10px 18px",
              minHeight: 44,
              cursor: "pointer",
            }}
          >
            Start a round
          </button>
          <button
            onClick={onAdd}
            data-testid="course-scout-add"
            style={{
              background: "transparent",
              color: T.ink,
              fontFamily: T.mono,
              fontSize: 10,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              border: `1px solid ${T.hairline}`,
              borderRadius: 99,
              padding: "10px 16px",
              minHeight: 44,
              cursor: "pointer",
            }}
          >
            Add
          </button>
          <button
            onClick={onViewCourse}
            style={{
              background: "transparent",
              color: T.pencil,
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.1,
              textTransform: "uppercase",
              border: "none",
              padding: "10px 4px",
              minHeight: 44,
              cursor: "pointer",
            }}
          >
            View course →
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function SheetMiniStat({ k, v }: { k: string; v: number | string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 8,
          letterSpacing: 1.2,
          color: T.pencilSoft,
          textTransform: "uppercase",
        }}
      >
        {k}
      </div>
      <div
        style={{
          fontFamily: T.serif,
          fontSize: 18,
          color: T.ink,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
          marginTop: 2,
        }}
      >
        {v}
      </div>
    </div>
  );
}
