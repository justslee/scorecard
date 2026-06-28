"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { createTournament, createPlayer, getPlayers } from "@/lib/api";
import { saveTournament, saveSavedPlayer, getSavedPlayers } from "@/lib/storage";
import type { SavedPlayer } from "@/lib/types";

const NUM_ROUNDS = [1, 2, 3, 4] as const;

export default function TournamentSetupPage() {
  const router = useRouter();

  // ── form state ────────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [numRounds, setNumRounds] = useState<1 | 2 | 3 | 4>(1);
  const [apiPlayers, setApiPlayers] = useState<SavedPlayer[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [customPlayers, setCustomPlayers] = useState<{ id: string; name: string }[]>([]);
  const [customInput, setCustomInput] = useState("");
  const [playersLoading, setPlayersLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Surface name-empty validation only after a submit attempt
  const [touched, setTouched] = useState(false);

  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getPlayers()
      .then((p) => {
        setApiPlayers(p);
        setPlayersLoading(false);
      })
      .catch(() => {
        // fall back to localStorage cache
        setApiPlayers(getSavedPlayers());
        setPlayersLoading(false);
      });
  }, []);

  // ── player helpers ────────────────────────────────────────────────────────
  const togglePlayer = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addCustom = () => {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    if (
      apiPlayers.some((p) => p.name.toLowerCase() === trimmed.toLowerCase()) ||
      customPlayers.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())
    ) {
      setCustomInput("");
      return;
    }
    setCustomPlayers((prev) => [...prev, { id: crypto.randomUUID(), name: trimmed }]);
    setCustomInput("");
    customInputRef.current?.focus();
  };

  const removeCustom = (id: string) => {
    setCustomPlayers((prev) => prev.filter((p) => p.id !== id));
  };

  // ── validation ────────────────────────────────────────────────────────────
  const totalPlayers = selectedIds.size + customPlayers.length;
  const nameMissing = name.trim().length === 0;
  const playersMissing = totalPlayers === 0;
  const canCreate = !nameMissing && !playersMissing && !creating;

  // ── submit ────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    setTouched(true);
    if (nameMissing || playersMissing) return;
    setCreating(true);
    setError(null);

    try {
      // Persist any custom (unsaved) players to POST /api/players first so the
      // backend can resolve their names via playerNamesById (players table join).
      // If any player create fails, we surface the error and abort — no silent drops.
      const persistedCustom: SavedPlayer[] = [];
      for (const cp of customPlayers) {
        const saved = await createPlayer({ name: cp.name });
        // Write-through: warm local cache so the players page sees them immediately.
        saveSavedPlayer(saved);
        persistedCustom.push(saved);
      }

      const allPlayerIds = [
        ...Array.from(selectedIds),
        ...persistedCustom.map((p) => p.id),
      ];

      const created = await createTournament({
        name: name.trim(),
        numRounds,
        playerIds: allPlayerIds,
      });

      // Build playerNamesById for the local cache so the detail page can resolve
      // names when offline (backend derives it from the players table join).
      const playerNamesById: Record<string, string> = {};
      for (const sp of apiPlayers) {
        if (selectedIds.has(sp.id)) playerNamesById[sp.id] = sp.name;
      }
      for (const cp of persistedCustom) {
        playerNamesById[cp.id] = cp.name;
      }

      // Write-through: warm the local cache with the server-returned tournament
      // (merged with the local playerNamesById for offline name resolution).
      saveTournament({ ...created, playerNamesById });

      // Navigate using the SERVER-RETURNED id (not a client placeholder).
      router.push(`/tournament/${created.id}`);
    } catch (e) {
      if (!(e instanceof TypeError)) {
        const msg = e instanceof Error ? e.message : "Failed to create tournament.";
        setError(
          msg.length > 120
            ? "Server error — check your connection and try again."
            : msg
        );
        setCreating(false);
        return;
      }
      // Network error (offline) — tournament creation requires a server-assigned
      // id for the round flow to work, so we don't support offline creation.
      setError(
        "No connection — connect to the internet to create a tournament."
      );
      setCreating(false);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: "relative",
        minHeight: "100vh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        fontFamily: T.sans,
        color: T.ink,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          maxWidth: 420,
          margin: "0 auto",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          width: "100%",
        }}
      >
        <div style={{ flex: 1 }}>
          {/* ── Header ───────────────────────────────────────────────── */}
          <div
            style={{
              padding: "max(14px, env(safe-area-inset-top)) 22px 14px",
            }}
          >
            <button
              onClick={() => router.push("/")}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.4,
                color: T.pencil,
                textTransform: "uppercase",
                display: "flex",
                alignItems: "center",
                gap: 4,
                marginBottom: 8,
                minHeight: 44,
              }}
            >
              <span style={{ fontSize: 11 }}>←</span> Home
            </button>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                marginBottom: 2,
              }}
            >
              New · Tournament
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 30,
                letterSpacing: -0.6,
                color: T.ink,
                lineHeight: 1.05,
              }}
            >
              Set up a tournament.
            </div>
          </div>

          {/* ── Name ──────────────────────────────────────────────────── */}
          <div style={{ padding: "0 22px" }}>
            <div
              style={{
                borderBottom: `1px dashed ${T.hairline}`,
                paddingBottom: 16,
              }}
            >
              <label
                htmlFor="tournament-name"
                style={{
                  display: "block",
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                Name
              </label>
              <input
                id="tournament-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Club Championship"
                maxLength={80}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  borderBottom: `1.5px solid ${
                    touched && nameMissing ? T.errorInk : T.pencilSoft
                  }`,
                  outline: "none",
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 22,
                  letterSpacing: -0.3,
                  color: T.ink,
                  paddingBottom: 4,
                  boxSizing: "border-box",
                }}
              />
              {touched && nameMissing && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.1,
                    color: T.errorInk,
                    marginTop: 4,
                  }}
                >
                  Name is required.
                </div>
              )}
            </div>

            {/* ── Rounds ──────────────────────────────────────────────── */}
            <div
              style={{
                paddingTop: 16,
                paddingBottom: 16,
                borderBottom: `1px dashed ${T.hairline}`,
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                Rounds
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {NUM_ROUNDS.map((n) => {
                  const active = numRounds === n;
                  return (
                    <button
                      key={n}
                      onClick={() => setNumRounds(n as 1 | 2 | 3 | 4)}
                      style={{
                        flex: 1,
                        minHeight: 44,
                        borderRadius: 10,
                        border: `1px solid ${active ? T.ink : T.hairline}`,
                        background: active ? T.ink : "transparent",
                        color: active ? T.paper : T.pencil,
                        fontFamily: T.serif,
                        fontSize: 18,
                        letterSpacing: -0.2,
                        cursor: "pointer",
                        transition: "background 0.15s, border-color 0.15s",
                      }}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Players ──────────────────────────────────────────────── */}
            <div style={{ paddingTop: 16, paddingBottom: 80 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.3,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                  }}
                >
                  Field
                </div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.2,
                    color: totalPlayers > 0 ? T.pencil : T.pencilSoft,
                  }}
                >
                  {totalPlayers > 0
                    ? `${totalPlayers} selected`
                    : "select players"}
                </div>
              </div>

              {touched && playersMissing && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.1,
                    color: T.errorInk,
                    marginBottom: 8,
                  }}
                >
                  Add at least one player.
                </div>
              )}

              {/* Saved players list */}
              {playersLoading ? (
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 14,
                    color: T.pencilSoft,
                    padding: "12px 0",
                  }}
                >
                  Loading players…
                </div>
              ) : apiPlayers.length === 0 ? (
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 14,
                    color: T.pencilSoft,
                    padding: "8px 0 12px",
                  }}
                >
                  No saved players yet — add names below.
                </div>
              ) : (
                <div
                  style={{
                    border: `1px solid ${T.hairline}`,
                    borderRadius: 14,
                    overflow: "hidden",
                    marginBottom: 10,
                  }}
                >
                  {apiPlayers.map((p, i) => {
                    const sel = selectedIds.has(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => togglePlayer(p.id)}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "12px 14px",
                          background: sel ? T.paperDeep : "transparent",
                          border: "none",
                          borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                          cursor: "pointer",
                          minHeight: 44,
                          textAlign: "left",
                        }}
                      >
                        {/* Avatar */}
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 99,
                            background: sel ? T.ink : T.paperDeep,
                            color: sel ? T.paper : T.pencil,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontFamily: T.serif,
                            fontStyle: "italic",
                            fontSize: 13,
                            flexShrink: 0,
                            transition: "background 0.15s",
                          }}
                        >
                          {sel ? "✓" : p.name.charAt(0).toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontFamily: T.sans,
                              fontSize: 14,
                              fontWeight: 500,
                              color: T.ink,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {p.name}
                          </div>
                        </div>
                        {p.handicap != null && (
                          <div
                            style={{
                              fontFamily: T.serif,
                              fontSize: 16,
                              color: T.pencil,
                              fontVariantNumeric: "tabular-nums",
                              flexShrink: 0,
                            }}
                          >
                            {p.handicap != null && p.handicap > 0 ? `+${p.handicap}` : p.handicap}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Custom players added this session */}
              {customPlayers.length > 0 && (
                <div
                  style={{
                    border: `1px solid ${T.hairline}`,
                    borderRadius: 14,
                    overflow: "hidden",
                    marginBottom: 10,
                  }}
                >
                  {customPlayers.map((cp, i) => (
                    <div
                      key={cp.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "12px 14px",
                        background: T.paperDeep,
                        borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                        minHeight: 44,
                      }}
                    >
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 99,
                          background: T.ink,
                          color: T.paper,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: T.serif,
                          fontStyle: "italic",
                          fontSize: 13,
                          flexShrink: 0,
                        }}
                      >
                        {cp.name.charAt(0).toUpperCase()}
                      </div>
                      <div
                        style={{
                          flex: 1,
                          fontFamily: T.sans,
                          fontSize: 14,
                          fontWeight: 500,
                          color: T.ink,
                        }}
                      >
                        {cp.name}
                      </div>
                      <button
                        onClick={() => removeCustom(cp.id)}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: "4px 8px",
                          cursor: "pointer",
                          fontFamily: T.mono,
                          fontSize: 11,
                          color: T.pencilSoft,
                          minHeight: 44,
                          display: "flex",
                          alignItems: "center",
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add custom name */}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  border: `1px solid ${T.hairline}`,
                  borderRadius: 14,
                  padding: "10px 14px",
                  background: T.paper,
                }}
              >
                <input
                  ref={customInputRef}
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustom();
                    }
                  }}
                  placeholder="Add a player by name…"
                  maxLength={60}
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 16,
                    letterSpacing: -0.1,
                    color: T.ink,
                    minHeight: 28,
                  }}
                />
                {customInput.trim().length > 0 && (
                  <button
                    onClick={addCustom}
                    style={{
                      background: T.ink,
                      border: "none",
                      borderRadius: 99,
                      padding: "5px 12px",
                      cursor: "pointer",
                      fontFamily: T.mono,
                      fontSize: 9,
                      letterSpacing: 1.2,
                      color: T.paper,
                      textTransform: "uppercase",
                      minHeight: 44,
                    }}
                  >
                    Add
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Sticky CTA ────────────────────────────────────────────────── */}
        <div
          style={{
            padding: "10px 22px max(26px, env(safe-area-inset-bottom, 26px))",
            background: `linear-gradient(to top, ${T.paper} 65%, rgba(0,0,0,0))`,
            flexShrink: 0,
            position: "sticky",
            bottom: 0,
          }}
        >
          {error && (
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.1,
                color: T.errorInk,
                background: T.errorWash,
                border: `1px solid ${T.errorInk}30`,
                borderRadius: 10,
                padding: "10px 14px",
                marginBottom: 10,
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}
          <button
            onClick={handleCreate}
            disabled={creating || (touched && (!canCreate))}
            style={{
              width: "100%",
              padding: "14px",
              borderRadius: 99,
              border: "none",
              background: canCreate ? T.ink : T.pencilSoft,
              color: T.paper,
              cursor: canCreate ? "pointer" : "default",
              fontFamily: T.sans,
              fontSize: 14,
              fontWeight: 500,
              letterSpacing: -0.1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              transition: "background 0.2s",
              minHeight: 52,
              opacity: creating ? 0.7 : 1,
            }}
          >
            <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>
              {creating ? "Creating…" : "Create tournament"}
            </span>
            {!creating && (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  letterSpacing: 1.2,
                  opacity: 0.7,
                }}
              >
                →
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
