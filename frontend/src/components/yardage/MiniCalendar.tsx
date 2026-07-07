"use client";

// A dependency-free, compact month grid in the yardage-book idiom — the
// affordance for picking an arbitrary date on the tee-time prefs screen.
// No native <input type="date">, no date-picker dependency: mono weekday
// headers, serif day numerals, T.ink/T.hairline tokens, an accent ring on
// the selected day. Reads like a page torn from the book, not a SaaS widget.

import { useState } from "react";
import { T, DEFAULT_ACCENT } from "./tokens";

export interface MiniCalendarProps {
  /** Currently selected ISO date (YYYY-MM-DD). */
  value: string;
  /** Earliest selectable ISO date — days before this render disabled. */
  min?: string;
  onPick: (date: string) => void;
  onClose: () => void;
}

const WEEKDAY_HEADERS = ["S", "M", "T", "W", "T", "F", "S"];

function toISO(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseISO(iso: string): { y: number; m: number } {
  const [y, m] = iso.split("-").map(Number);
  return { y, m: m - 1 };
}

export default function MiniCalendar({ value, min, onPick, onClose }: MiniCalendarProps) {
  const sel = parseISO(value);
  const [viewY, setViewY] = useState(sel.y);
  const [viewM, setViewM] = useState(sel.m);

  const floor = min ? parseISO(min) : null;
  const beforeFloorMonth = floor ? (viewY < floor.y || (viewY === floor.y && viewM < floor.m)) : false;
  const atFloorMonth = floor ? (viewY === floor.y && viewM === floor.m) : false;
  const prevDisabled = beforeFloorMonth || atFloorMonth;

  const firstOfMonth = new Date(viewY, viewM, 1);
  const startWeekday = firstOfMonth.getDay(); // 0 = Sunday
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const monthLabel = firstOfMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const goPrev = () => {
    if (prevDisabled) return;
    const d = new Date(viewY, viewM - 1, 1);
    setViewY(d.getFullYear());
    setViewM(d.getMonth());
  };
  const goNext = () => {
    const d = new Date(viewY, viewM + 1, 1);
    setViewY(d.getFullYear());
    setViewM(d.getMonth());
  };

  const cells: Array<{ day: number; iso: string; disabled: boolean; selected: boolean } | null> = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = toISO(viewY, viewM, day);
    cells.push({ day, iso, disabled: min != null && iso < min, selected: iso === value });
  }

  return (
    <div
      style={{
        marginTop: 8,
        padding: "12px 12px 10px",
        borderRadius: 12,
        background: T.paperDeep,
        border: `1px solid ${T.hairline}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <button
          onClick={goPrev}
          disabled={prevDisabled}
          aria-label="Previous month"
          style={{
            width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
            border: "none", background: "none", padding: 0,
            cursor: prevDisabled ? "default" : "pointer", opacity: prevDisabled ? 0.25 : 1,
          }}
        >
          <svg width="9" height="9" viewBox="0 0 12 12">
            <path d="M8 2 L3 6 L8 10" stroke={T.ink} strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15, color: T.ink, letterSpacing: -0.2 }}>
          {monthLabel}
        </div>
        <button
          onClick={goNext}
          aria-label="Next month"
          style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "none", padding: 0, cursor: "pointer" }}
        >
          <svg width="9" height="9" viewBox="0 0 12 12">
            <path d="M4 2 L9 6 L4 10" stroke={T.ink} strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 2 }}>
        {WEEKDAY_HEADERS.map((h, i) => (
          <div
            key={i}
            style={{ textAlign: "center" as const, fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase" as const, padding: "2px 0" }}
          >
            {h}
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {cells.map((c, i) =>
          c === null ? (
            <div key={`blank-${i}`} />
          ) : (
            <button
              key={c.iso}
              disabled={c.disabled}
              onClick={() => onPick(c.iso)}
              style={{
                width: "100%",
                aspectRatio: "1",
                minHeight: 30,
                borderRadius: 99,
                border: c.selected ? `1.5px solid ${DEFAULT_ACCENT}` : "1px solid transparent",
                background: "transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: T.serif,
                fontSize: 13,
                letterSpacing: -0.2,
                color: c.disabled ? T.pencilSoft : T.ink,
                opacity: c.disabled ? 0.35 : 1,
                cursor: c.disabled ? "default" : "pointer",
              }}
            >
              {c.day}
            </button>
          )
        )}
      </div>

      <div style={{ marginTop: 8, textAlign: "right" as const }}>
        <button
          onClick={onClose}
          style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" as const, border: "none", background: "none", cursor: "pointer", padding: "6px 4px" }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
