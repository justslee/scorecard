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
 *
 * B2: Adds an optional course-review affordance (rating 1-5 + short note).
 * courseKey is resolved by the parent (RoundPageClient) and passed as a prop.
 * The review POST never blocks the Done flow.
 */

import { useMemo, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { T, PAPER_NOISE } from '@/components/yardage/tokens';
import { Round, calculateTotals } from '@/lib/types';
import GameResults from '@/components/GameResults';
import SettleUpPanel from '@/components/SettleUpPanel';
import { createCourseReview } from '@/lib/api';
import { getRoundsAsync } from '@/lib/storage-api';
import { computeRoundInsights } from '@/lib/round-insights';

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface RoundRecapProps {
  open: boolean;
  round: Round;
  /** Parent calls router.push('/') here — recap is purely a display view. */
  onDone: () => void;
  /**
   * Resolved course key (GolfAPI id string, or name:<slug>).
   * When null or absent the review affordance is hidden.
   * Resolved by RoundPageClient to keep RoundRecap a display-plus-one-action view.
   */
  courseKey?: string | null;
  /** Raw display name captured at write time (so B3 can render without re-resolving). */
  courseName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatToPar(n: number): string {
  if (n === 0) return 'E';
  if (n > 0) return `+${n}`;
  return String(n); // negative already carries the '-' sign
}

/** Format a float average-to-par with sign, 1 decimal place. */
function formatAvgToPar(n: number): string {
  if (n === 0) return 'E';
  const rounded = Math.round(n * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)}`;
}

/**
 * Format an absolute delta value for the "better / worse than average" narrative.
 * Strips trailing .0 so "3.0 strokes" becomes "3 strokes".
 */
function formatDeltaStr(n: number): string {
  const abs = Math.abs(Math.round(n * 10) / 10);
  return abs % 1 === 0 ? String(Math.round(abs)) : abs.toFixed(1);
}

/** Return an English ordinal string: 1 → "1st", 2 → "2nd", 3 → "3rd", etc. */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function toParColor(n: number): string {
  if (n < 0) return T.birdie;   // under par — warm reddish, like a birdie circle
  if (n === 0) return T.ink;    // even — full ink
  return T.pencil;              // over par — muted
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function RoundRecap({
  open,
  round,
  onDone,
  courseKey,
  courseName,
}: RoundRecapProps) {
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

  // Filter out the synthetic 'settlement' game record — it is rendered via
  // SettleUpPanel below, not via GameResults, to avoid double-rendering.
  const games = (round.games ?? []).filter((g) => g.format !== 'settlement');
  const hasGames = games.length > 0;
  // Does this round have any money games (including the settlement record)?
  const hasMoneyGames = (round.games ?? []).some(
    (g) => g.format !== 'settlement' && (g.settings?.pointValue ?? 0) > 0
  );

  // ─── Round insights: history-relative comparison ────────────────────────
  // Loaded async on open; silently absent if history fails to load.
  const [roundHistory, setRoundHistory] = useState<Round[]>([]);
  const [historyReady, setHistoryReady] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getRoundsAsync()
      .then((rounds) => {
        if (!cancelled) {
          setRoundHistory(rounds);
          setHistoryReady(true);
        }
      })
      .catch(() => {
        // Silently ignore — insights section simply won't appear.
        if (!cancelled) setHistoryReady(true);
      });
    return () => { cancelled = true; };
  }, [open, round.id]);

  const insights = useMemo(
    () => (historyReady ? computeRoundInsights(round, roundHistory) : null),
    [round, roundHistory, historyReady]
  );

  // ─── Course review affordance (B2) ───────────────────────────────────────
  // Self-contained state; never blocks the Done flow.
  const showReview = Boolean(courseKey);
  const [reviewRating, setReviewRating] = useState<number | null>(null);
  const [reviewBody, setReviewBody] = useState('');
  type ReviewStatus = 'idle' | 'saving' | 'saved' | 'error';
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>('idle');

  async function handleSubmitReview() {
    if (!courseKey || reviewRating === null) return;
    setReviewStatus('saving');

    // Derive a safe ISO date from round.date — guard against non-ISO strings.
    let playedAt: string | undefined;
    try {
      const d = new Date(round.date);
      if (!isNaN(d.getTime())) playedAt = d.toISOString().slice(0, 10);
    } catch {
      // leave playedAt undefined — server treats absent as NULL
    }

    try {
      await createCourseReview(courseKey, {
        rating: reviewRating,
        body: reviewBody.trim() || undefined,
        roundId: round.id,
        courseName: courseName ?? round.courseName,
        playedAt,
      });
      setReviewStatus('saved');
    } catch {
      // Never throw — the Done button keeps working regardless.
      setReviewStatus('error');
    }
  }

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

              {/* ── Settle up (money games only) ────────────────────────────── */}
              {/* Shown when at least one game has a pointValue; hidden otherwise.  */}
              {hasMoneyGames && (
                <>
                  <div style={hairlineRule} />
                  <SettleUpPanel
                    round={round}
                    ownerPlayerId={round.ownerPlayerId}
                  />
                </>
              )}

              {/* ── Round insights: how this round compared to history ───────── */}
              {/* Only shown when state === 'ready' (≥2 valid history rounds). */}
              {insights && insights.state === 'ready' && insights.vsAverageToPar && (
                <>
                  <div style={hairlineRule} />
                  <div style={sectionLabel}>How this round compared</div>

                  {/* Main narrative: strokes better / worse than average */}
                  <div style={{ marginBottom: 16 }}>
                    <div
                      style={{
                        fontFamily: T.sans,
                        fontSize: 14,
                        fontWeight: 500,
                        color:
                          insights.vsAverageToPar.delta < 0
                            ? T.birdie
                            : insights.vsAverageToPar.delta === 0
                            ? T.ink
                            : T.pencil,
                        marginBottom: 5,
                      }}
                    >
                      {insights.vsAverageToPar.delta < 0
                        ? `${formatDeltaStr(insights.vsAverageToPar.delta)} strokes better than your average`
                        : insights.vsAverageToPar.delta === 0
                        ? 'Even with your average'
                        : `${formatDeltaStr(insights.vsAverageToPar.delta)} strokes above your average`}
                    </div>
                    {/* Compact kicker: this round / avg / sample */}
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: '0.8px',
                        color: T.pencilSoft,
                        textTransform: 'uppercase',
                      }}
                    >
                      {formatToPar(insights.vsAverageToPar.thisRound)} this round
                      {' · '}avg {formatAvgToPar(insights.vsAverageToPar.historicalAvg)}
                      {' over '}
                      {insights.vsAverageToPar.sampleSize} round
                      {insights.vsAverageToPar.sampleSize !== 1 ? 's' : ''}
                    </div>
                  </div>

                  {/* Ranking line — highlighted when it's the best round */}
                  {insights.ranking && (
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: '1px',
                        color: insights.ranking.rank === 1 ? T.birdie : T.pencilSoft,
                        textTransform: 'uppercase',
                        marginBottom: 16,
                      }}
                    >
                      {insights.ranking.rank === 1
                        ? `Best round of your last ${insights.ranking.total}`
                        : `${ordinal(insights.ranking.rank)} best of your last ${insights.ranking.total}`}
                    </div>
                  )}

                  {/* Par-type breakdown — quiet table */}
                  {insights.parTypeComparison && insights.parTypeComparison.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        marginBottom: 8,
                      }}
                    >
                      {insights.parTypeComparison.map((pt) => (
                        <div
                          key={pt.par}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'baseline',
                          }}
                        >
                          <span
                            style={{
                              fontFamily: T.mono,
                              fontSize: 9,
                              letterSpacing: '1px',
                              color: T.pencil,
                              textTransform: 'uppercase',
                            }}
                          >
                            Par {pt.par}s
                          </span>
                          <span
                            style={{
                              fontFamily: T.mono,
                              fontSize: 9,
                              letterSpacing: '0.5px',
                              color: pt.delta < 0 ? T.birdie : T.pencilSoft,
                            }}
                          >
                            {formatAvgToPar(pt.thisRoundAvgToPar)} · avg{' '}
                            {formatAvgToPar(pt.historicalAvgToPar)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
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
                  marginTop: insights && insights.state === 'ready' ? 20 : 0,
                }}
              >
                {isPartial ? `Thru ${maxPlayedHoles}` : `${holeCount} holes`}
              </div>

              {/* ── Course review affordance (B2) — hidden when courseKey is absent ── */}
              {showReview && (
                <>
                  <div style={{ ...hairlineRule, marginTop: 28 }} />

                  {reviewStatus === 'saved' ? (
                    /* Quiet confirmed state — replaces the form once submitted */
                    <div
                      style={{
                        textAlign: 'center',
                        fontFamily: T.mono,
                        fontSize: 10,
                        letterSpacing: '1.2px',
                        color: T.pencilSoft,
                        textTransform: 'uppercase',
                        paddingBottom: 8,
                      }}
                    >
                      Noted.
                    </div>
                  ) : (
                    <div style={{ paddingBottom: 8 }}>
                      {/* Section kicker */}
                      <div style={{ ...sectionLabel, marginBottom: 16 }}>
                        How was it?
                      </div>

                      {/* Star rating — 5 tappable marks, ≥44pt targets */}
                      <div
                        style={{
                          display: 'flex',
                          gap: 4,
                          marginBottom: 16,
                          justifyContent: 'center',
                        }}
                      >
                        {[1, 2, 3, 4, 5].map((n) => (
                          <button
                            key={n}
                            aria-label={`Rate ${n} star${n !== 1 ? 's' : ''}`}
                            onClick={() => setReviewRating(n)}
                            style={{
                              minWidth: 44,
                              minHeight: 44,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              padding: 0,
                            }}
                          >
                            <span
                              style={{
                                fontFamily: T.serif,
                                fontStyle: 'italic',
                                fontSize: 24,
                                color: reviewRating !== null && n <= reviewRating
                                  ? T.ink
                                  : T.pencilSoft,
                                lineHeight: 1,
                                userSelect: 'none',
                              }}
                            >
                              {n}
                            </span>
                          </button>
                        ))}
                      </div>

                      {/* Short note — quiet single-line textarea */}
                      <textarea
                        placeholder="A word or two…"
                        value={reviewBody}
                        onChange={(e) => setReviewBody(e.target.value)}
                        maxLength={2000}
                        rows={2}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          resize: 'none',
                          background: T.paper,
                          border: `1px solid ${T.hairline}`,
                          borderRadius: 10,
                          padding: '10px 12px',
                          fontFamily: T.sans,
                          fontSize: 14,
                          color: T.ink,
                          lineHeight: 1.5,
                          outline: 'none',
                          marginBottom: 12,
                        }}
                      />

                      {/* Submit — quiet ink button; disabled until rating chosen */}
                      <button
                        onClick={handleSubmitReview}
                        disabled={reviewRating === null || reviewStatus === 'saving'}
                        style={{
                          width: '100%',
                          padding: '12px 20px',
                          minHeight: 44,
                          borderRadius: 10,
                          border: `1px solid ${T.hairline}`,
                          background: reviewRating === null ? 'transparent' : T.paperDeep,
                          color: reviewRating === null ? T.pencilSoft : T.ink,
                          fontFamily: T.sans,
                          fontSize: 14,
                          fontWeight: 500,
                          cursor: reviewRating === null ? 'default' : 'pointer',
                          letterSpacing: '0.1px',
                          transition: 'background 0.15s',
                        }}
                      >
                        {reviewStatus === 'saving' ? 'Saving…' : 'Save note'}
                      </button>

                      {/* Error state — muted, never blocks Done */}
                      {reviewStatus === 'error' && (
                        <div
                          style={{
                            marginTop: 8,
                            fontFamily: T.mono,
                            fontSize: 10,
                            letterSpacing: '0.8px',
                            color: T.errorInk,
                            textAlign: 'center',
                            textTransform: 'uppercase',
                          }}
                        >
                          Couldn&apos;t save — tap again or skip
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

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
