"use client";

/**
 * ScanSheet — OCR scorecard-scan flow, mounted on the in-round scoring screen.
 *
 * Flow:
 *   capture   → CameraCapture full-screen overlay (camera or photo-library)
 *   scanning  → full-screen "Reading the card…" while the image is processed
 *   review    → bottom sheet: per-player editable score grid + name mapping
 *   applying  → "Saving scores…" while onSetScore calls complete
 *   error     → error display with retry
 *
 * Design: yardage-book only — T.* tokens, PAPER_NOISE, Instrument Serif,
 * inline SVGs, 44pt touch targets, safe-area-aware. No lucide-react, no
 * zinc/emerald/slate. Mirrors CaddieSheet's bottom-sheet pattern.
 *
 * Persistence: calls the same onSetScore callback as manual per-hole entry
 * in RoundPageClient — no new API endpoint.
 *
 * Auth note: voice_advanced.router is registered with dependencies=_owner_only
 * in backend/app/main.py. fetchAPI (used by parseScorecard) attaches the
 * Clerk Bearer token automatically — no extra auth wiring needed here.
 */

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import type { Round, Player } from "@/lib/types";
import { parseScorecard } from "@/lib/ocr";
import CameraCapture from "@/components/CameraCapture";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ScanPhase = "capture" | "scanning" | "review" | "applying" | "error";

/** Internal per-player review state */
interface OcrPlayerLocal {
  ocrName: string;
  /** Always 18 slots; null = blank/unreadable hole */
  scores: (number | null)[];
  /** null = "Skip" (do not apply) */
  mappedPlayerId: string | null;
}

export interface ScanSheetProps {
  open: boolean;
  onClose: () => void;
  round: Round;
  /**
   * Same callback as manual hole entry in RoundPageClient (handleSetScore).
   * Called per (player, holeIdx, strokes) triple — reuses the existing
   * optimistic+persist path unchanged.
   */
  onSetScore: (pid: string, idx: number, val: number | null) => void | Promise<void>;
  accent: string;
}

// ---------------------------------------------------------------------------
// Inline icons — no lucide-react
// ---------------------------------------------------------------------------

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M1.5 1.5l10 10M11.5 1.5l-10 10" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ScanSheet({ open, onClose, round, onSetScore, accent }: ScanSheetProps) {
  const [phase, setPhase] = useState<ScanPhase>("capture");
  const [ocrPlayers, setOcrPlayers] = useState<OcrPlayerLocal[]>([]);
  const [confidence, setConfidence] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [applyCount, setApplyCount] = useState(0);
  const [applyTotal, setApplyTotal] = useState(0);
  /** Partial-failure message surfaced after handleApply when some writes reject */
  const [applyError, setApplyError] = useState<string | null>(null);
  // No reset useEffect needed — parent passes a fresh key on each open,
  // causing React to unmount+remount ScanSheet with default state.

  // ── Capture → OCR ──────────────────────────────────────────────────────────

  const handleCapture = async (imageBase64: string) => {
    setPhase("scanning");
    setError(null);
    try {
      const result = await parseScorecard(imageBase64, round.players);
      setConfidence(result.confidence);

      if (result.players.length === 0) {
        setError("No players found in the scan. Try a clearer photo or better lighting.");
        setPhase("error");
        return;
      }

      // Match OCR names to round players (case-insensitive)
      const init: OcrPlayerLocal[] = result.players.map((p) => {
        const match = round.players.find(
          (rp: Player) => rp.name.toLowerCase() === p.name.toLowerCase()
        );
        // Pad / truncate to exactly 18 slots
        const padded: (number | null)[] = Array(18).fill(null);
        p.scores.forEach((s: number | null, i: number) => {
          if (i < 18) padded[i] = s;
        });
        return {
          ocrName: p.name,
          scores: padded,
          mappedPlayerId: match?.id ?? null,
        };
      });

      setOcrPlayers(init);
      setPhase("review");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Scan failed.";
      setError(msg.length > 120 ? "Scan failed — check connection." : msg);
      setPhase("error");
    }
  };

  // ── Score cell edit ─────────────────────────────────────────────────────────

  /**
   * Update a score cell. Clamps to 1–15: values outside that range are stored
   * as null so out-of-range typos don't silently survive to Apply.
   */
  const handleCellChange = (playerIdx: number, holeIdx: number, raw: string) => {
    const parsed = parseInt(raw, 10);
    let val: number | null;
    if (raw === "" || isNaN(parsed)) {
      val = null;
    } else if (parsed < 1 || parsed > 15) {
      val = null; // reject out-of-range; cell goes blank to signal the rejection
    } else {
      val = parsed;
    }
    setOcrPlayers((prev) => {
      const next = [...prev];
      const p = { ...next[playerIdx], scores: [...next[playerIdx].scores] };
      p.scores[holeIdx] = val;
      next[playerIdx] = p;
      return next;
    });
  };

  const handleMappingChange = (playerIdx: number, playerId: string | null) => {
    setOcrPlayers((prev) => {
      const next = [...prev];
      next[playerIdx] = { ...next[playerIdx], mappedPlayerId: playerId };
      return next;
    });
  };

  // ── Apply scores ────────────────────────────────────────────────────────────

  const handleApply = async () => {
    setPhase("applying");
    setApplyError(null);
    // Collect all valid (playerId, holeIdx, strokes) to persist
    const entries: [string, number, number][] = [];
    for (const op of ocrPlayers) {
      if (!op.mappedPlayerId) continue;
      op.scores.forEach((val, i) => {
        if (val !== null && val >= 1 && val <= 15) {
          entries.push([op.mappedPlayerId!, i, val]);
        }
      });
    }
    setApplyTotal(entries.length);
    setApplyCount(0);

    // Fire all in parallel — handleSetScore's optimistic updater is safe for
    // concurrent calls (functional setScores updater per unique player/hole).
    // The seq guard in handleSetScore drops stale server snapshots; UI scores
    // are already correct via the optimistic updates.
    const tasks = entries.map(([pid, idx, val]) => {
      const r = onSetScore(pid, idx, val);
      const p: Promise<void> = r instanceof Promise ? r : Promise.resolve();
      return p.then(() => setApplyCount((c) => c + 1));
    });

    const results = await Promise.allSettled(tasks);
    const failCount = results.filter((r) => r.status === "rejected").length;

    if (failCount > 0) {
      // Stay open so user can retry. pendingRef in RoundPageClient will already
      // retry on next foreground save; surface the count so the user knows.
      const successCount = entries.length - failCount;
      setApplyError(
        `${successCount} of ${entries.length} saved — ${failCount} didn't reach the server. Tap Apply to retry.`
      );
      setPhase("review");
    } else {
      onClose();
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!open) return null;

  const isLowConfidence = confidence > 0 && confidence < 0.6;

  // Detect duplicate player assignments across OCR rows
  const mappedIds = ocrPlayers.map((op) => op.mappedPlayerId).filter(Boolean) as string[];
  const hasDuplicate = mappedIds.length !== new Set(mappedIds).size;
  const hasAnyMapping = mappedIds.length > 0;
  const canApply = hasAnyMapping && !hasDuplicate;

  return (
    <AnimatePresence mode="wait">
      {/* Capture phase — CameraCapture is its own full-screen overlay */}
      {phase === "capture" && (
        <motion.div
          key="scan-capture"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{ position: "fixed", inset: 0, zIndex: 50 }}
        >
          <CameraCapture onCapture={handleCapture} onClose={onClose} />
        </motion.div>
      )}

      {/* Scanning — full-screen loading */}
      {phase === "scanning" && (
        <motion.div
          key="scan-scanning"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 70,
            background: `${PAPER_NOISE}, ${T.paper}`,
            backgroundBlendMode: "multiply",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 22,
              color: T.ink,
              letterSpacing: -0.3,
            }}
          >
            Reading the card…
          </div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.4,
              color: T.pencil,
              textTransform: "uppercase",
            }}
          >
            This may take a moment
          </div>
        </motion.div>
      )}

      {/* Review / Applying / Error — bottom sheet */}
      {(phase === "review" || phase === "applying" || phase === "error") && (
        <motion.div
          key="scan-sheet-wrapper"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{ position: "fixed", inset: 0, zIndex: 50 }}
        >
          {/* Backdrop — dismissable in review and error phases */}
          <div
            onClick={phase === "review" || phase === "error" ? onClose : undefined}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(26,42,26,0.32)",
              backdropFilter: "blur(3px)",
            }}
          />

          {/* Bottom sheet */}
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={T.springSoft}
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              maxWidth: 420,
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              maxHeight: "88dvh",
              background: `${PAPER_NOISE}, ${T.paper}`,
              backgroundBlendMode: "multiply",
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              paddingBottom: "max(20px, env(safe-area-inset-bottom))",
              boxShadow: "0 -8px 40px rgba(26,42,26,0.18)",
            }}
          >
            {/* Drag handle */}
            <div
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                background: T.hairline,
                margin: "10px auto 0",
                flexShrink: 0,
              }}
            />

            {/* Header */}
            <div
              style={{
                padding: "12px 20px 12px",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                borderBottom: `1px solid ${T.hairline}`,
                flexShrink: 0,
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.5,
                    color: T.pencil,
                    textTransform: "uppercase",
                    marginBottom: 3,
                  }}
                >
                  {phase === "error" ? "Scan failed" : "Scan review"}
                </div>
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 21,
                    letterSpacing: -0.3,
                    color: T.ink,
                    lineHeight: 1.1,
                  }}
                >
                  {phase === "applying"
                    ? "Saving scores…"
                    : phase === "error"
                    ? "Try again"
                    : "Confirm scores"}
                </div>
                {/* Confidence kicker — review phase only; semantic plain language */}
                {phase === "review" && confidence > 0 && (
                  <div
                    style={{
                      marginTop: 5,
                      fontFamily: T.mono,
                      fontSize: 10,
                      letterSpacing: 1.2,
                      textTransform: "uppercase",
                      color: isLowConfidence ? T.warningInk : T.pencil,
                    }}
                  >
                    {isLowConfidence
                      ? "Hard to read — check each score carefully"
                      : "Looks good — confirm scores below"}
                  </div>
                )}
              </div>

              {/* Close — 44×44 tap target */}
              <button
                onClick={onClose}
                aria-label="Close scan sheet"
                style={{
                  minWidth: 44,
                  minHeight: 44,
                  borderRadius: 99,
                  border: `1px solid ${T.hairline}`,
                  background: "transparent",
                  color: T.pencil,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  marginTop: 2,
                }}
              >
                <CloseIcon />
              </button>
            </div>

            {/* Scrollable body */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "16px 20px 16px",
                WebkitOverflowScrolling:
                  "touch" as React.CSSProperties["WebkitOverflowScrolling"],
              }}
            >
              {/* Error state */}
              {phase === "error" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: 12,
                      background: T.errorWash,
                      border: `1px solid ${T.errorInk}33`,
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 14,
                      color: T.errorInk,
                      lineHeight: 1.4,
                    }}
                  >
                    {error}
                  </div>
                  <button
                    onClick={() => setPhase("capture")}
                    style={{
                      padding: "13px 0",
                      borderRadius: 99,
                      border: `1px solid ${T.hairline}`,
                      background: "transparent",
                      color: T.ink,
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 15,
                      cursor: "pointer",
                      width: "100%",
                      minHeight: 44,
                    }}
                  >
                    Try again
                  </button>
                </div>
              )}

              {/* Applying state */}
              {phase === "applying" && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 10,
                    padding: "24px 0",
                  }}
                >
                  {applyTotal > 0 && (
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.3,
                        color: T.pencil,
                        textTransform: "uppercase",
                      }}
                    >
                      {applyCount} of {applyTotal} scores
                    </div>
                  )}
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 14,
                      color: T.pencilSoft,
                      textAlign: "center",
                      lineHeight: 1.5,
                    }}
                  >
                    Writing to the scorecard…
                  </div>
                </div>
              )}

              {/* Review state */}
              {phase === "review" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {/* Partial-failure banner (after a failed apply attempt) */}
                  {applyError && (
                    <div
                      style={{
                        padding: "9px 12px",
                        borderRadius: 12,
                        background: T.warningWash,
                        border: `1px solid ${T.warningInk}33`,
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 13,
                        color: T.warningInk,
                        lineHeight: 1.4,
                      }}
                    >
                      {applyError}
                    </div>
                  )}

                  {/* Low-confidence notice */}
                  {isLowConfidence && (
                    <div
                      style={{
                        padding: "9px 12px",
                        borderRadius: 12,
                        background: T.warningWash,
                        border: `1px solid ${T.warningInk}33`,
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 13,
                        color: T.warningInk,
                        lineHeight: 1.4,
                      }}
                    >
                      Low confidence read — check each score before applying.
                    </div>
                  )}

                  {/* Per-player review cards */}
                  {ocrPlayers.map((op, pi) => (
                    <OcrPlayerCard
                      key={pi}
                      playerIdx={pi}
                      op={op}
                      roundPlayers={round.players}
                      isLowConfidence={isLowConfidence}
                      allMappedPlayerIds={mappedIds}
                      accent={accent}
                      onMappingChange={handleMappingChange}
                      onCellChange={handleCellChange}
                    />
                  ))}

                  {/* Hints when blocked */}
                  {!hasAnyMapping && (
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 13,
                        color: T.pencilSoft,
                        textAlign: "center",
                        lineHeight: 1.5,
                      }}
                    >
                      Assign at least one player to apply scores.
                    </div>
                  )}
                  {hasDuplicate && (
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 13,
                        color: T.warningInk,
                        textAlign: "center",
                        lineHeight: 1.5,
                      }}
                    >
                      Two rows are assigned to the same player — fix the duplicate to apply.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer — Apply / Cancel buttons (review phase only) */}
            {phase === "review" && (
              <div
                style={{
                  flexShrink: 0,
                  padding: "14px 20px",
                  borderTop: `1px solid ${T.hairline}`,
                  display: "flex",
                  gap: 10,
                }}
              >
                <button
                  onClick={onClose}
                  style={{
                    flex: 1,
                    padding: "13px 0",
                    borderRadius: 99,
                    border: `1px solid ${T.hairline}`,
                    background: "transparent",
                    color: T.pencil,
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 15,
                    cursor: "pointer",
                    minHeight: 44,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleApply}
                  disabled={!canApply}
                  style={{
                    flex: 2,
                    padding: "13px 0",
                    borderRadius: 99,
                    border: "none",
                    background: canApply ? T.ink : T.pencilSoft,
                    color: T.paper,
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 15,
                    cursor: canApply ? "pointer" : "default",
                    minHeight: 44,
                    opacity: canApply ? 1 : 0.6,
                  }}
                >
                  Apply scores
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// OcrPlayerCard — one OCR player: name mapping + editable 18-hole score grid
// ---------------------------------------------------------------------------

interface OcrPlayerCardProps {
  playerIdx: number;
  op: OcrPlayerLocal;
  roundPlayers: Player[];
  isLowConfidence: boolean;
  /** All mapped player IDs across all rows (including this row's own mapping). */
  allMappedPlayerIds: string[];
  accent: string;
  onMappingChange: (playerIdx: number, pid: string | null) => void;
  onCellChange: (playerIdx: number, holeIdx: number, raw: string) => void;
}

function OcrPlayerCard({
  playerIdx,
  op,
  roundPlayers,
  isLowConfidence,
  allMappedPlayerIds,
  accent,
  onMappingChange,
  onCellChange,
}: OcrPlayerCardProps) {
  const unmatched = op.mappedPlayerId === null;
  // Duplicate = this row's assignment appears more than once across all rows
  const isDuplicate =
    op.mappedPlayerId !== null &&
    allMappedPlayerIds.filter((id) => id === op.mappedPlayerId).length > 1;

  const borderColor = isDuplicate
    ? T.warningInk + "88"
    : unmatched
    ? T.warningInk + "44"
    : T.hairline;

  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 16,
        background: T.paperDeep,
        border: `1px solid ${borderColor}`,
      }}
    >
      {/* Player name + round-player assignment */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        {/* OCR name kicker */}
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.pencil,
            textTransform: "uppercase",
            flexShrink: 0,
          }}
        >
          {op.ocrName}
        </div>

        <div style={{ flex: 1, height: 1, background: T.hairline, minWidth: 10 }} />

        {/* Duplicate badge — takes priority over No-match */}
        {isDuplicate ? (
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 8,
              letterSpacing: 1,
              color: T.warningInk,
              textTransform: "uppercase",
              flexShrink: 0,
            }}
          >
            Already assigned
          </div>
        ) : unmatched ? (
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 8,
              letterSpacing: 1,
              color: T.warningInk,
              textTransform: "uppercase",
              flexShrink: 0,
            }}
          >
            No match
          </div>
        ) : null}

        {/* Player selector */}
        <select
          value={op.mappedPlayerId ?? ""}
          onChange={(e) => onMappingChange(playerIdx, e.target.value || null)}
          aria-label={`Assign ${op.ocrName} to round player`}
          style={{
            padding: "5px 8px",
            borderRadius: 8,
            border: `1px solid ${isDuplicate ? T.warningInk : T.hairline}`,
            background: T.paper,
            color: T.ink,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 0.4,
            outline: "none",
            cursor: "pointer",
            flexShrink: 0,
            minHeight: 32,
          }}
        >
          <option value="">Skip</option>
          {roundPlayers.map((rp: Player) => (
            <option key={rp.id} value={rp.id}>
              {rp.name}
            </option>
          ))}
        </select>
      </div>

      {/* Score grid — front 9 then back 9 */}
      <ScoreRow
        holeStart={1}
        scores={op.scores}
        playerIdx={playerIdx}
        isLowConfidence={isLowConfidence}
        accent={accent}
        onCellChange={onCellChange}
      />
      <div style={{ marginTop: 8 }}>
        <ScoreRow
          holeStart={10}
          scores={op.scores}
          playerIdx={playerIdx}
          isLowConfidence={isLowConfidence}
          accent={accent}
          onCellChange={onCellChange}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScoreRow — 9 numbered cells (holes holeStart through holeStart+8)
// ---------------------------------------------------------------------------

interface ScoreRowProps {
  /** 1-indexed hole number for the first cell in this row */
  holeStart: number;
  scores: (number | null)[];
  playerIdx: number;
  isLowConfidence: boolean;
  accent: string;
  onCellChange: (playerIdx: number, holeIdx: number, raw: string) => void;
}

function ScoreRow({ holeStart, scores, playerIdx, isLowConfidence, onCellChange }: ScoreRowProps) {
  // 9 cells: holes holeStart…holeStart+8
  const holes = Array.from({ length: 9 }, (_, i) => holeStart + i);

  return (
    <div>
      {/* Hole-number header row */}
      <div style={{ display: "flex", gap: 3, marginBottom: 3 }}>
        {holes.map((h) => (
          <div
            key={h}
            style={{
              width: 28,
              textAlign: "center",
              fontFamily: T.mono,
              fontSize: 9,
              color: T.pencilSoft,
              letterSpacing: 0.3,
              lineHeight: 1,
            }}
          >
            {h}
          </div>
        ))}
      </div>

      {/* Score input cells */}
      <div style={{ display: "flex", gap: 3 }}>
        {holes.map((h) => {
          const holeIdx = h - 1; // 0-based
          const val = scores[holeIdx];
          // Amber highlight: low confidence AND cell has a value
          const flagged = isLowConfidence && val !== null;
          return (
            <input
              key={holeIdx}
              type="number"
              inputMode="numeric"
              min={1}
              max={15}
              placeholder="—"
              value={val !== null ? String(val) : ""}
              onChange={(e) => onCellChange(playerIdx, holeIdx, e.target.value)}
              aria-label={`Hole ${h} score`}
              style={{
                width: 28,
                height: 40,
                padding: 0,
                textAlign: "center",
                fontFamily: T.mono,
                fontSize: 14,
                fontVariantNumeric: "tabular-nums",
                color: T.ink,
                // Amber cell background (highlighter-annotation feel) when confidence is low
                background: flagged ? T.warningWash : T.paper,
                border: `1px solid ${flagged ? T.warningInk : T.hairline}`,
                borderRadius: 6,
                outline: "none",
                // Remove browser number spinners
                MozAppearance: "textfield",
                WebkitAppearance: "none",
              } as React.CSSProperties}
            />
          );
        })}
      </div>
    </div>
  );
}
