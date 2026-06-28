'use client';

/**
 * RoundRecap — shown after a round is finished, before returning home.
 *
 * Feels like the back page of a printed yardage book / a completed scorecard.
 * Restrained, on-paper aesthetic: Instrument Serif for the stroke count,
 * mono kickers for labels, PAPER_NOISE grain, generous whitespace.
 *
 * Design rules: T.* tokens only, no zinc/emerald/slate/lucide-react.
 * Mobile-first, 44pt+ Done target, safe-area-aware.
 * Done button is non-scrolling (sticky bottom bar) so it is always reachable.
 *
 * Data: reads existing Round/scores/players — no new data model or endpoints.
 * Games: delegates to <GameResults readOnly> which already owns all format logic.
 */

import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { T, PAPER_NOISE } from '@/components/yardage/tokens';
import { Round, calculateTotals } from '@/lib/types';
import GameResults from '@/components/GameResults';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface RoundRecapProps {
  open: boolean;
  round: Round;
  /** Parent calls router.push('/') here — recap is purely a display view. */
  onDone: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatToPar(n: number): string {
  if (n === 0) return 'E';
  if (n > 0) return `+${n}`;
  return String(n); // negative already carries the '-' sign
}

function toParColor(n: number): string {
  if (n < 0) return T.birdie;   // under par — warm reddish, like a birdie circle
  if (n === 0) return T.ink;    // even — full ink
  return T.pencil;              // over par — muted
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function RoundRecap({ open, round, onDone }: RoundRecapProps) {
  // Compute per-player totals + quiet highlights (birdies, eagles, best hole).
  // calculateTotals is the same helper used everywhere else in the app.
  const playerStats = useMemo(() => {
    return round.players.map((player) => {
      const totals = calculateTotals(round.scores, round.holes, player.id);

      const holeParByNumber = new Map(round.holes.map((h) => [h.number, h.par]));
      let birdies = 0;
      let eagles = 0;
      let bestHoleDelta = Infinity;
      let bestHoleNumber: number | null = null;

      for (const s of round.scores) {
        if (s.playerId !== player.id || s.strokes === null) continue;
        const par = holeParByNumber.get(s.holeNumber);
        if (par === undefined) continue;
        const delta = s.strokes - par;
        if (delta === -1) birdies++;
        if (delta <= -2) eagles++;
        if (delta < bestHoleDelta) {
          bestHoleDelta = delta;
          bestHoleNumber = s.holeNumber;
        }
      }

      return { player, totals, birdies, eagles, bestHoleNumber, bestHoleDelta };
    });
  }, [round]);

  const holeCount = round.holes.length || 18;

  // Use the max holes played across all players to detect partial rounds.
  const maxPlayedHoles = playerStats.reduce(
    (max, ps) => Math.max(max, ps.totals.playedHoles),
    0
  );
  const isPartial = maxPlayedHoles > 0 && maxPlayedHoles < holeCount;

  // Format the round date — round.date is an ISO-parseable string.
  const dateStr = useMemo(() => {
    const d = new Date(round.date);
    if (isNaN(d.getTime())) return round.date;
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }, [round.date]);

  const games = round.games ?? [];
  const hasGames = games.length > 0;

  // ─────────────────────────────────────────────────────────────────────────
  // Inline style constants — mirrors CaddieSheet / ScanSheet patterns
  // ─────────────────────────────────────────────────────────────────────────

  const monoKickerSoft: React.CSSProperties = {
    fontFamily: T.mono,
    fontSize: 9,
    letterSpacing: '1.4px',
    color: T.pencilSoft,
    textTransform: 'uppercase',
  };

  const sectionLabel: React.CSSProperties = {
    fontFamily: T.mono,
    fontSize: 9,
    letterSpacing: '1.4px',
    color: T.pencil,
    textTransform: 'uppercase',
    marginBottom: 12,
  };

  const hairlineRule: React.CSSProperties = {
    height: 1,
    background: T.hairline,
    margin: '0 0 24px',
  };

  // Shared paper background (scroll area + Done bar need it)
  const paperBg: React.CSSProperties = {
    background: `${PAPER_NOISE}, ${T.paper}`,
    backgroundBlendMode: 'multiply',
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="round-recap"
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 28 }}
          transition={{ duration: 0.32, ease: T.ease }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            ...paperBg,
            display: 'flex',
            flexDirection: 'column',
          }}
        >

          {/* ── Scrollable content area ────────────────────────────────────
               flex:1 + overflowY:auto keeps the Done bar always visible.   */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
            }}
          >
            <div
              style={{
                maxWidth: 420,
                margin: '0 auto',
                padding: '0 20px',
                paddingTop: 'max(52px, calc(env(safe-area-inset-top) + 32px))',
                paddingBottom: 28,
              }}
            >

              {/* ── Header: round-complete anchor + course + date ───────── */}
              <div style={{ marginBottom: 28 }}>
                {/* "ROUND COMPLETE" — quiet finishing marker */}
                <div style={{ ...monoKickerSoft, marginBottom: 4 }}>
                  Round complete
                </div>
                {/* Date (+ partial notice) */}
                <div
                  style={{
                    ...monoKickerSoft,
                    marginBottom: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <span>{dateStr}</span>
                  {isPartial && (
                    <span style={{ color: T.warningInk }}>
                      · Thru {maxPlayedHoles}
                    </span>
                  )}
                </div>
                {/* Course name — primary serif display */}
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: 'italic',
                    fontSize: 28,
                    color: T.ink,
                    letterSpacing: -0.5,
                    lineHeight: 1.15,
                    marginBottom: round.teeName ? 4 : 0,
                  }}
                >
                  {round.courseName}
                </div>
                {round.teeName && (
                  <div style={{ ...monoKickerSoft }}>
                    {round.teeName} tees · {holeCount} holes
                  </div>
                )}
              </div>

              {/* ── Rule ────────────────────────────────────────────────── */}
              <div style={hairlineRule} />

              {/* ── Player score rows — no section label (hairline carries the division) */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  marginBottom: 28,
                }}
              >
                {playerStats.map((ps, idx) => {
                  const isPrimary = idx === 0; // first player is the owner — emphasised
                  const hasScore = ps.totals.playedHoles > 0;
                  const tpLabel = hasScore ? formatToPar(ps.totals.toPar) : '–';
                  const tpColor = hasScore ? toParColor(ps.totals.toPar) : T.pencilSoft;

                  // Best-hole kicker — only shown on the owner's (primary) row.
                  // bestHoleDelta < 0 means at least a birdie; bestHoleNumber is the hole.
                  const showBestHole =
                    isPrimary &&
                    ps.bestHoleNumber !== null &&
                    ps.bestHoleDelta < 0;

                  return (
                    <div
                      key={ps.player.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: isPrimary ? '14px 16px' : '10px 14px',
                        border: `1px solid ${isPrimary ? T.hairline : T.hairlineSoft}`,
                        borderRadius: 14,
                        background: isPrimary ? T.paperDeep : 'transparent',
                      }}
                    >
                      {/* Left: name + quiet highlights */}
                      <div style={{ minWidth: 0, flex: 1, marginRight: 12 }}>
                        <div
                          style={{
                            fontFamily: T.sans,
                            fontSize: isPrimary ? 16 : 14,
                            fontWeight: isPrimary ? 600 : 500,
                            color: T.ink,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {ps.player.name}
                        </div>
                        {/* Birdies / eagles — one quiet line, only if any */}
                        {(ps.birdies > 0 || ps.eagles > 0) && (
                          <div
                            style={{
                              fontFamily: T.mono,
                              fontSize: 9,
                              letterSpacing: '1px',
                              color: T.pencilSoft,
                              textTransform: 'uppercase',
                              marginTop: 3,
                            }}
                          >
                            {ps.eagles > 0 && `${ps.eagles} eagle${ps.eagles !== 1 ? 's' : ''}`}
                            {ps.eagles > 0 && ps.birdies > 0 && ' · '}
                            {ps.birdies > 0 && `${ps.birdies} birdie${ps.birdies !== 1 ? 's' : ''}`}
                          </div>
                        )}
                        {/* Best hole — owner only, birdie-or-better only */}
                        {showBestHole && (
                          <div
                            style={{
                              fontFamily: T.mono,
                              fontSize: 9,
                              letterSpacing: '1px',
                              color: T.pencilSoft,
                              textTransform: 'uppercase',
                              marginTop: 3,
                            }}
                          >
                            Best · Hole {ps.bestHoleNumber}
                          </div>
                        )}
                      </div>

                      {/* Right: strokes (serif, large) + to-par (mono, smaller) */}
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: isPrimary ? 10 : 7,
                          flexShrink: 0,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: T.serif,
                            // Owner's hero score is italic — matches hand-scored entry feel
                            fontStyle: isPrimary ? 'italic' : 'normal',
                            fontSize: isPrimary ? 38 : 28,
                            color: T.ink,
                            fontVariantNumeric: 'tabular-nums',
                            lineHeight: 1,
                          }}
                        >
                          {hasScore ? ps.totals.total : '–'}
                        </div>
                        <div
                          style={{
                            fontFamily: T.mono,
                            fontSize: isPrimary ? 13 : 11,
                            letterSpacing: '0.4px',
                            color: tpColor,
                            fontVariantNumeric: 'tabular-nums',
                            minWidth: 20,
                            textAlign: 'right',
                          }}
                        >
                          {tpLabel}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── Games section (reuses GameResults in read-only mode) ── */}
              {hasGames && (
                <>
                  <div style={hairlineRule} />
                  <div style={sectionLabel}>Game results</div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 20,
                      marginBottom: 28,
                    }}
                  >
                    {games.map((game) => (
                      <div key={game.id}>
                        {/* Game name kicker */}
                        <div
                          style={{
                            fontFamily: T.mono,
                            fontSize: 9,
                            letterSpacing: '1px',
                            color: T.pencilSoft,
                            textTransform: 'uppercase',
                            marginBottom: 8,
                          }}
                        >
                          {game.name}
                        </div>
                        {/* readOnly suppresses "Editing disabled" + collapses tables */}
                        <GameResults round={round} game={game} readOnly />
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* ── Closing caption — just the holes info, course already in header ── */}
              <div
                style={{
                  textAlign: 'center',
                  fontFamily: T.serif,
                  fontStyle: 'italic',
                  fontSize: 13,
                  color: T.pencilSoft,
                  letterSpacing: -0.1,
                }}
              >
                {isPartial ? `Thru ${maxPlayedHoles}` : `${holeCount} holes`}
              </div>

            </div>
          </div>

          {/* ── Non-scrolling Done bar — always reachable regardless of content length.
               Mirrors the CaddieSheet non-scrolling mic-block pattern.               */}
          <div
            style={{
              flexShrink: 0,
              ...paperBg,
              borderTop: `1px solid ${T.hairline}`,
              padding: '12px 20px',
              paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
            }}
          >
            <div style={{ maxWidth: 420, margin: '0 auto' }}>
              <button
                onClick={onDone}
                style={{
                  width: '100%',
                  padding: '16px 24px',
                  minHeight: 54,
                  borderRadius: 14,
                  border: 'none',
                  background: T.ink,
                  color: T.paper,
                  fontFamily: T.sans,
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: 'pointer',
                  letterSpacing: '0.1px',
                }}
              >
                Done
              </button>
            </div>
          </div>

        </motion.div>
      )}
    </AnimatePresence>
  );
}
