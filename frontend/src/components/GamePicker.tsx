"use client";

/**
 * Presentational game-format picker — extracted verbatim from
 * `app/round/new/page.tsx` (formerly the local `GamePicker` function) so the
 * tournament round-creation flow can reuse it without duplicating ~240 lines
 * of money-adjacent stake UI. Fully props-driven; no page state, no hooks,
 * no routing.
 */

import { T } from "@/components/yardage/tokens";
import { GAME_OPTIONS } from "@/lib/round-games";
import type { GameId, GameOption } from "@/lib/round-games";

export default function GamePicker({
  accent,
  selected,
  onToggle,
  onStakeFor,
  onDone,
  options = GAME_OPTIONS,
}: {
  accent: string;
  selected: { id: GameId; stake: string }[];
  onToggle: (g: GameId) => void;
  onStakeFor: (g: GameId, s: string) => void;
  onDone: () => void;
  options?: GameOption[];
}) {
  const stakes = ["$2", "$5", "$10", "$20"];
  return (
    <div style={{ overflow: "auto", padding: "0 0 10px" }}>
      <div style={{ padding: "0 22px 4px" }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9.5,
            letterSpacing: 1.5,
            color: T.pencil,
            textTransform: "uppercase",
          }}
        >
          Pick your games
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 22,
            color: T.ink,
            letterSpacing: -0.3,
          }}
        >
          The formats
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontSize: 12.5,
            color: T.pencil,
            letterSpacing: -0.1,
            marginTop: 2,
          }}
        >
          Stack several &mdash; or say:{" "}
          <span style={{ color: accent }}>&ldquo;skins at ten&rdquo;</span>,{" "}
          <span style={{ color: accent }}>&ldquo;wolf, no money&rdquo;</span>
        </div>
      </div>
      <div style={{ padding: "8px 14px 0" }}>
        {options.map((g) => {
          const sel = selected.find((s) => s.id === g.id);
          const active = sel !== undefined;
          const takesStake = g.id !== "none";
          return (
            <div
              key={g.id}
              role="button"
              tabIndex={0}
              onClick={() => onToggle(g.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onToggle(g.id);
              }}
              style={{
                width: "100%",
                padding: "12px",
                marginBottom: 4,
                borderRadius: 12,
                border: `1px solid ${active ? T.ink : "transparent"}`,
                background: active ? T.paperDeep : "transparent",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        fontFamily: T.serif,
                        fontSize: 17,
                        color: T.ink,
                        letterSpacing: -0.2,
                      }}
                    >
                      {g.l}
                    </span>
                    {g.tag && (
                      <span
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8,
                          letterSpacing: 1,
                          color: T.pencil,
                          border: `1px solid ${T.hairline}`,
                          padding: "1px 5px",
                          borderRadius: 3,
                          textTransform: "uppercase",
                        }}
                      >
                        {g.tag}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 12.5,
                      color: T.pencil,
                      letterSpacing: -0.1,
                      marginTop: 1,
                    }}
                  >
                    {g.sub}
                  </div>
                </div>
                {active && (
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 99,
                      background: accent,
                      color: T.paper,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontFamily: T.mono,
                    }}
                  >
                    {"✓"}
                  </div>
                )}
              </div>

              {/* Per-format stake — inline in the selected card, so several
                  games and their bets are defined in one visit. */}
              {active && takesStake && sel && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  style={{
                    display: "flex",
                    gap: 5,
                    marginTop: 10,
                    paddingTop: 10,
                    borderTop: `1px dashed ${T.hairline}`,
                    alignItems: "center",
                  }}
                >
                  {stakes.map((s) => (
                    <button
                      key={s}
                      onClick={() => onStakeFor(g.id, s)}
                      style={{
                        flex: 1,
                        padding: "7px 0",
                        borderRadius: 10,
                        border: `1px solid ${sel.stake === s ? T.ink : T.hairline}`,
                        background: sel.stake === s ? T.ink : "transparent",
                        color: sel.stake === s ? T.paper : T.ink,
                        fontFamily: T.serif,
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      {s}
                    </button>
                  ))}
                  <input
                    value={stakes.includes(sel.stake) ? "" : sel.stake}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[^0-9$]/g, "");
                      onStakeFor(g.id, raw.startsWith("$") ? raw : `$${raw}`);
                    }}
                    placeholder="$…"
                    inputMode="numeric"
                    style={{
                      width: 52,
                      padding: "7px 6px",
                      borderRadius: 10,
                      border: `1px solid ${
                        !stakes.includes(sel.stake) && sel.stake !== ""
                          ? T.ink
                          : T.hairline
                      }`,
                      background: "transparent",
                      color: T.ink,
                      fontFamily: T.serif,
                      fontSize: 14,
                      textAlign: "center",
                      outline: "none",
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Done — multi-select never auto-closes */}
      <div style={{ padding: "10px 22px 0" }}>
        <button
          onClick={onDone}
          style={{
            width: "100%",
            padding: "14px",
            borderRadius: 99,
            border: "none",
            background: accent,
            color: T.paper,
            fontFamily: T.sans,
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
            letterSpacing: -0.1,
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
