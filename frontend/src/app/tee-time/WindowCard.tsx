"use client";

// A single tee-time window — tap the card to select it, drag its track to
// resize it, tap the date chip to pick an exact day, tap the quiet × to
// remove it. Replaces the old inline WindowChip (static, un-editable).

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { T } from "@/components/yardage/tokens";
import MiniCalendar from "@/components/yardage/MiniCalendar";
import { haptic } from "@/lib/haptics";
import { toISODateLocal } from "@/lib/teetime/dates";
import {
  TRACK_START_MIN,
  TRACK_END_MIN,
  hhmmToMin,
  minToHhmm,
  minToFrac,
  pickHandle,
  applyDrag,
  fracToMin,
  type Handle,
} from "@/lib/teetime/window-slider";

/** Structurally the page's TimeWindow — kept local so this stays a leaf. */
export interface WindowCardWindow {
  id: string;
  label: string;
  sub: string;
  start: string;
  end: string;
  date: string;
  selected: boolean;
}

export interface WindowCardProps {
  win: WindowCardWindow;
  accent: string;
  onToggle: () => void;
  onEdit: (start: string, end: string) => void;
  onPickDate: (date: string) => void;
  onDelete: () => void;
}

/** Pointer has to move this many CSS px on the track before it counts as a
 *  drag rather than a tap (which just toggles the card, same as elsewhere). */
const MOVE_THRESHOLD_PX = 6;

const TICK_HOURS = [6, 9, 12, 15, 18, 21];

/** "2026-07-11" → "SAT · JUL 11". */
function formatDateChip(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const wd = d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
  const mon = d.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  return `${wd} · ${mon} ${d.getDate()}`;
}

interface DragSession {
  handle: Handle;
  startX: number;
  moved: boolean;
  grabOffsetMin: number;
  rectLeft: number;
  rectWidth: number;
}

export default function WindowCard({ win, accent, onToggle, onEdit, onPickDate, onDelete }: WindowCardProps) {
  const [showCalendar, setShowCalendar] = useState(false);
  const dragRef = useRef<DragSession | null>(null);

  const startMin = hhmmToMin(win.start);
  const endMin = hhmmToMin(win.end);
  const selected = win.selected;
  const fg = selected ? T.paper : T.ink;
  // T.pencil (not pencilSoft) on unselected paper: pencilSoft measures ~2.9:1
  // against T.paper — illegible in sunlight (designer review, WCAG AA).
  const fgSoft = selected ? "rgba(244,241,234,0.6)" : T.pencil;

  const fracFromClientX = (clientX: number, rectLeft: number, rectWidth: number) =>
    rectWidth > 0 ? (clientX - rectLeft) / rectWidth : 0;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = fracFromClientX(e.clientX, rect.left, rect.width);
    const handle = pickHandle(frac, startMin, endMin);
    dragRef.current = {
      handle,
      startX: e.clientX,
      moved: false,
      grabOffsetMin: handle === "band" ? fracToMin(frac) - startMin : 0,
      rectLeft: rect.left,
      rectWidth: rect.width,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < MOVE_THRESHOLD_PX) return;
    d.moved = true;
    const frac = fracFromClientX(e.clientX, d.rectLeft, d.rectWidth);
    const { start, end } = applyDrag(d.handle, frac, startMin, endMin, d.grabOffsetMin);
    if (start !== startMin || end !== endMin) {
      haptic("light"); // a 30-min snap crossed
      onEdit(minToHhmm(start), minToHhmm(end));
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const d = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Below the movement threshold — this was a TAP on the track, not a
    // drag. The track never eats taps: it toggles the card like the rest.
    if (d && !d.moved) onToggle();
  };

  const startFrac = minToFrac(startMin);
  const endFrac = minToFrac(endMin);
  const today = toISODateLocal(new Date());

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={onToggle}
        style={{
          textAlign: "left" as const,
          padding: "10px 30px 10px 12px",
          borderRadius: 10,
          background: selected ? T.ink : T.paper,
          color: fg,
          border: `1px solid ${selected ? T.ink : T.hairline}`,
          cursor: "pointer",
          width: "100%",
          position: "relative",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 16, letterSpacing: -0.2 }}>{win.label}</div>
            <div
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setShowCalendar((s) => !s); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setShowCalendar((s) => !s); } }}
              style={{
                fontFamily: T.mono,
                fontSize: 8,
                letterSpacing: 1,
                fontWeight: 600,
                color: fgSoft,
                textTransform: "uppercase" as const,
                // Generous padding + negative margin: ~44pt hit target (the
                // chip is the ONLY way to the date picker) without shifting
                // the visual layout (designer review).
                padding: "14px 10px",
                margin: "-8px -6px",
                cursor: "pointer",
                whiteSpace: "nowrap" as const,
              }}
            >
              {formatDateChip(win.date)}
            </div>
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: fgSoft, textTransform: "uppercase" as const, flexShrink: 0 }}>
            {win.sub}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 0.5, fontVariantNumeric: "tabular-nums", color: fg }}>
            {win.start} → {win.end}
          </div>
        </div>

        {/* The drag surface — a taller strip than the visual band so it's
            comfortable to grab on a phone; drag math lives in window-slider.ts. */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => { dragRef.current = null; }}
          onClick={(e) => e.stopPropagation()}
          style={{ position: "relative", height: 26, marginTop: 6, touchAction: "none" as const, cursor: "ew-resize" }}
        >
          <div style={{ position: "absolute", left: 0, right: 0, top: 12, height: 1, background: selected ? "rgba(244,241,234,0.25)" : T.hairline }} />
          {TICK_HOURS.map((h) => {
            const pct = ((h * 60 - TRACK_START_MIN) / (TRACK_END_MIN - TRACK_START_MIN)) * 100;
            return <div key={h} style={{ position: "absolute", left: `${pct}%`, top: 8, width: 1, height: 9, background: selected ? "rgba(244,241,234,0.28)" : T.hairline }} />;
          })}
          <div
            style={{
              position: "absolute",
              left: `${startFrac * 100}%`,
              width: `${(endFrac - startFrac) * 100}%`,
              top: 10,
              height: 5,
              borderRadius: 1,
              background: selected ? accent : T.ink,
            }}
          />
          {/* Small visual handle pills at each edge — the actual grab math
              uses a generous edge bias, not these pixels, for the hit test. */}
          <div style={{ position: "absolute", left: `calc(${startFrac * 100}% - 1.5px)`, top: 6, width: 3, height: 13, borderRadius: 2, background: selected ? T.paper : T.ink }} />
          <div style={{ position: "absolute", left: `calc(${endFrac * 100}% - 1.5px)`, top: 6, width: 3, height: 13, borderRadius: 2, background: selected ? T.paper : T.ink }} />
        </div>
      </button>

      <button
        onClick={(e) => { e.stopPropagation(); haptic("light"); onDelete(); }}
        aria-label="Delete window"
        style={{
          position: "absolute",
          top: -6,
          right: -6,
          width: 44,
          height: 44,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          color: selected ? "rgba(244,241,234,0.55)" : T.pencilSoft,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 12 12">
          <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      <AnimatePresence>
        {showCalendar && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >
            <MiniCalendar
              value={win.date}
              min={today}
              onPick={(date) => { onPickDate(date); setShowCalendar(false); }}
              onClose={() => setShowCalendar(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
