"use client";

/**
 * Presentational game-format picker — extracted verbatim from
 * `app/round/new/page.tsx` (formerly the local `GamePicker` function) so the
 * tournament round-creation flow can reuse it without duplicating ~240 lines
 * of money-adjacent stake UI. Fully props-driven; no page state, no hooks,
 * no routing.
 */

import { T } from "@/components/yardage/tokens";
import { GAME_OPTIONS, STAKE_GAME_IDS, gameSelectableForRoster } from "@/lib/round-games";
import type { GameId, GameOption } from "@/lib/round-games";

/** Calm, honest sub-copy shown in place of the format's normal blurb when the
 *  current roster can't support it — never a toast/warning, just a quieter
 *  fact (tournament-settlement-honesty-plan.md §2, Bug 2). */
const ROSTER_UNMET_COPY: Partial<Record<GameId, string>> = {
  match: "Match play is 1v1 — opponent picker coming.",
  wolf: "Wolf needs a foursome.",
};

export default function GamePicker({
  accent,
  selected,
  onToggle,
  onStakeFor,
  onDone,
  options = GAME_OPTIONS,
  rosterSize,
}: {
  accent: string;
  selected: { id: GameId; stake: string }[];
  onToggle: (g: GameId) => void;
  onStakeFor: (g: GameId, s: string) => void;
  onDone: () => void;
  options?: GameOption[];
  /** Current named-player count; unmet-roster-requirement formats (see
   *  ROSTER_REQUIREMENT) render disabled with honest sub-copy instead of
   *  silently accepting a selection the builder will later skip. Omit to
   *  disable no rows (all requirements treated as met). */
  rosterSize?: number;
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
          const takesStake = STAKE_GAME_IDS.has(g.id);
          const rosterUnmet =
            rosterSize !== undefined && !gameSelectableForRoster(g.id, rosterSize);
          return (
            <div
              key={g.id}
              role="button"
              tabIndex={rosterUnmet ? -1 : 0}
              aria-disabled={rosterUnmet}
              onClick={() => {
                if (rosterUnmet) return;
                onToggle(g.id);
              }}
              onKeyDown={(e) => {
                if (rosterUnmet) return;
                if (e.key === "Enter" || e.key === " ") onToggle(g.id);
              }}
              style={{
                width: "100%",
                padding: "12px",
                marginBottom: 4,
                borderRadius: 12,
                border: `1px solid ${active ? T.ink : "transparent"}`,
                background: active ? T.paperDeep : rosterUnmet ? T.hairlineSoft : "transparent",
                cursor: rosterUnmet ? "default" : "pointer",
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
                          opacity: rosterUnmet ? 0.5 : 1,
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
                    {rosterUnmet ? ROSTER_UNMET_COPY[g.id] ?? g.sub : g.sub}
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
                      opacity: rosterUnmet ? 0.5 : 1,
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

              {/* Non-stake format (points-only OR unconstructible, e.g. stroke,
                  stableford, vegas, best ball, scramble) — quiet italic note
                  so the absent stake reads as intent, not omission (no toast,
                  no chrome). Copy is deliberately format-agnostic: it must be
                  true for every non-STAKE_GAME_IDS format, not just points
                  games (reviewer BLOCKING #2 — the old "Points game" wording
                  was factually wrong for stroke/vegas/bb/scr). */}
              {active && !takesStake && g.id !== "none" && (
                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: `1px dashed ${T.hairline}`,
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 11.5,
                    color: T.pencilSoft,
                  }}
                >
                  No money on this one — nothing to settle.
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
