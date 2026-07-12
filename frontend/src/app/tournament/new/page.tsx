"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { tournamentHref } from "@/lib/round-url";
import { useRouter } from "next/navigation";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { createTournament, createPlayer, getPlayers } from "@/lib/api";
import { saveTournament, saveSavedPlayer, getSavedPlayers } from "@/lib/storage";
import type { SavedPlayer } from "@/lib/types";
import { useCaddiePageContext } from "@/hooks/useCaddiePageContext";
import type { TaskParse, TaskAck } from "@/lib/caddie-context";
import { buildKeyterms } from "@/lib/voice/keyterms";
import { parseVoiceTranscript } from "@/lib/voice/pipeline";
import type { VoiceParseResultValidated } from "@/lib/voice/schemas";
import { tournamentTaskParse, tournamentPrefillFromParse } from "@/lib/tournament-prefill";
import {
  formatProgramDate,
  fieldSummary,
  colophonLine,
  ghostCount,
} from "@/lib/tournament-program";

const NUM_ROUNDS = [1, 2, 3, 4] as const;

export default function TournamentSetupPage() {
  const router = useRouter();
  // Motion/haptics: NORTHSTAR-calm — subtle, purposeful, disabled visually
  // under prefers-reduced-motion. Same gate pattern as the view page
  // (TournamentPageClient.tsx:99).
  const reduce = useReducedMotion();

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
  // "The Program" cover-plate date. Gated to post-mount so the static export
  // prerender never bakes the BUILD date into the HTML (would mismatch on
  // hydration) — device-local timezone is correct by definition, it's the
  // user's "today".
  const [today, setToday] = useState<Date | null>(null);

  const customInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Defer the state update out of the effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => setToday(new Date()), 0);
    return () => clearTimeout(t);
  }, []);

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

  // ── Voice — through the omnipresent caddie-orb contract ──
  // The orb summons the SHARED sheet host (CaddieOrbSheet, mounted in the
  // root layout); this page registers what its own deterministic tournament
  // parser understood (specs/omnipresent-caddie-orb-plan.md §4). Creation
  // STAYS a human tap — apply() only fills the form; it never calls
  // handleCreate. Filling the form by hand remains the fallback.
  const apply = useCallback((p: TaskParse): TaskAck => {
    const result = p.payload as VoiceParseResultValidated;
    const plan = tournamentPrefillFromParse(result, apiPlayers, []);
    if (plan.name) setName(plan.name);
    setNumRounds(plan.numRounds);
    if (plan.selectedIds.length > 0) {
      setSelectedIds((prev) => new Set([...prev, ...plan.selectedIds]));
    }
    if (plan.customPlayerNames.length > 0) {
      setCustomPlayers((prev) => {
        const existingLower = new Set([
          ...apiPlayers.map((sp) => sp.name.toLowerCase()),
          ...prev.map((cp) => cp.name.toLowerCase()),
        ]);
        const newOnes = plan.customPlayerNames
          .filter((n) => !existingLower.has(n.toLowerCase()))
          .map((n) => ({ id: crypto.randomUUID(), name: n }));
        return newOnes.length > 0 ? [...prev, ...newOnes] : prev;
      });
    }
    // Tournament creation is a human tap on "Create tournament" — the
    // visibly-filled form + this ack line IS the confirmation, never a
    // confirming beat / auto-dispatch.
    return { line: plan.ackLine, dispatched: false };
  }, [apiPlayers]);

  useCaddiePageContext({
    id: "tournament-setup",
    kind: "task",
    copy: {
      title: "Set up your tournament",
      hint: "Tell me the name, how many rounds, and who’s playing.",
      nudge: "Want to start a tournament? Say the name, the rounds, and who’s in.",
    },
    // Bias STT toward the roster on screen — "Justin" beats "Justine".
    getKeyterms: () => buildKeyterms(apiPlayers.map((p) => p.name)),
    parse: async (transcript) => {
      const result = await parseVoiceTranscript({
        transcript,
        known: { players: apiPlayers.map((p) => p.name) },
      });
      return tournamentTaskParse(transcript, result);
    },
    apply,
  });

  // ── validation ────────────────────────────────────────────────────────────
  const totalPlayers = selectedIds.size + customPlayers.length;
  const nameMissing = name.trim().length === 0;
  const playersMissing = totalPlayers === 0;

  // ── entry numbers ("Card of entry") ─────────────────────────────────────
  // Selection order: saved entrants first (JS Set preserves insertion order —
  // togglePlayer add/delete keeps it), then customs in add order. Voice
  // `apply` bulk-adds in parse order, so this stays correct there too.
  // Program numbers, not IDs — they reflow on deselect/remove.
  const entryNumberById = new Map<string, number>();
  [...Array.from(selectedIds), ...customPlayers.map((c) => c.id)].forEach(
    (pid, i) => entryNumberById.set(pid, i + 1)
  );
  const ghosts = ghostCount(totalPlayers);
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
      router.push(tournamentHref(created.id));
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
              The Program{today ? ` · ${formatProgramDate(today)}` : ""}
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 34,
                letterSpacing: -0.8,
                color: name.trim() ? T.ink : T.pencilSoft,
                lineHeight: 1.05,
                overflowWrap: "break-word",
              }}
            >
              {name.trim() || "Set up a tournament."}
            </div>
            <div
              style={{
                marginTop: 12,
                borderTop: `1px solid ${T.hairline}`,
                height: 3,
                borderBottom: `1px solid ${T.hairline}`,
              }}
            />
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
                The event
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
                Order of play
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
              {/* Itinerary preview — non-interactive; rounds are actually
                  drawn later from the tournament page. */}
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                <AnimatePresence initial={false}>
                  {Array.from({ length: numRounds }, (_, i) => (
                    <motion.div
                      key={i}
                      layout={reduce ? false : true}
                      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={reduce ? undefined : { opacity: 0, scale: 0.96 }}
                      transition={reduce ? { duration: 0 } : T.springSoft}
                      style={{
                        flex: 1,
                        borderRadius: 12,
                        border: `1px solid ${T.hairline}`,
                        background: "transparent",
                        padding: "10px 12px",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8.5,
                          letterSpacing: 1.3,
                          color: T.pencil,
                          textTransform: "uppercase",
                          marginBottom: 2,
                        }}
                      >
                        Day {i + 1}
                      </div>
                      <div
                        style={{
                          fontFamily: T.serif,
                          fontSize: 14,
                          letterSpacing: -0.2,
                          color: T.pencil,
                          lineHeight: 1.1,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        Course to be drawn
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
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
                  Card of entry
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
                        {sel && (
                          <div
                            style={{
                              fontFamily: T.mono,
                              fontSize: 9,
                              letterSpacing: 1.2,
                              color: T.pencil,
                              flexShrink: 0,
                            }}
                          >
                            №{entryNumberById.get(p.id)}
                          </div>
                        )}
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
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 9,
                          letterSpacing: 1.2,
                          color: T.pencil,
                          flexShrink: 0,
                        }}
                      >
                        №{entryNumberById.get(cp.id)}
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

              {/* Ghost entry lines — dead-space fill, decorative only. */}
              {ghosts > 0 && (
                <div aria-hidden style={{ pointerEvents: "none", marginTop: 6 }}>
                  <AnimatePresence initial={false}>
                    {Array.from({ length: ghosts }, (_, i) => (
                      <motion.div
                        key={totalPlayers + i + 1}
                        layout={reduce ? false : true}
                        initial={reduce ? false : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={reduce ? undefined : { opacity: 0 }}
                        transition={reduce ? { duration: 0 } : T.springSoft}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          minHeight: 44,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: T.mono,
                            fontSize: 9,
                            letterSpacing: 1.2,
                            color: T.pencilSoft,
                          }}
                        >
                          №{totalPlayers + i + 1}
                        </span>
                        <span
                          style={{
                            flex: 1,
                            borderBottom: `1px dashed ${T.hairlineSoft}`,
                          }}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}

              {/* Composing summary sentence */}
              {totalPlayers > 0 && (
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 15,
                    color: T.pencil,
                    marginTop: 12,
                  }}
                >
                  {fieldSummary(totalPlayers, numRounds)}
                </div>
              )}
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
          {totalPlayers > 0 && (
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.3,
                color: T.pencil,
                textAlign: "center",
                marginBottom: 8,
                textTransform: "uppercase",
              }}
            >
              {colophonLine(numRounds, totalPlayers)}
            </div>
          )}
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
