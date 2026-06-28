'use client';

import { Round, Game } from '@/lib/types';
import { computeGameResults } from '@/lib/games';
import { T } from '@/components/yardage/tokens';

interface GameResultsProps {
  round: Round;
  game: Game;
  onUpdateGame?: (next: Game) => void;
  /**
   * When true the component renders in a read-only recap context:
   *   - "Editing disabled in this view." warning is suppressed (not needed when the
   *     caller never provides onUpdateGame in the first place).
   *   - Verbose hole-by-hole <details> tables (wolf, threePoint) are collapsed by
   *     default so they don't dominate the recap layout.
   * Defaults to false — active-round callers are unaffected.
   */
  readOnly?: boolean;
}

// Shared inline style helpers — yardage-book aesthetic
const card: React.CSSProperties = {
  border: `1px solid ${T.hairline}`,
  borderRadius: 14,
  background: T.paper,
  overflow: 'hidden',
};

const subRow: React.CSSProperties = {
  padding: '12px 14px',
  border: `1px solid ${T.hairlineSoft}`,
  borderRadius: 12,
};

const monoKicker: React.CSSProperties = {
  fontFamily: T.mono,
  fontSize: 9,
  letterSpacing: '1.2px',
  color: T.pencilSoft,
  textTransform: 'uppercase',
};

const sectionLabel: React.CSSProperties = {
  fontFamily: T.mono,
  fontSize: 9,
  letterSpacing: '1.2px',
  color: T.pencil,
  textTransform: 'uppercase',
  marginBottom: 8,
};

export default function GameResults({ round, game, onUpdateGame, readOnly = false }: GameResultsProps) {
  const results = computeGameResults(round, game);
  const playerName = (id: string) => round.players.find((p) => p.id === id)?.name ?? 'Unknown';

  if (game.format === 'skins' && results.skins) {
    const sorted = [...results.skins.byPlayer].sort((a, b) => b.skins - a.skins);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sorted.map((r) => (
            <div
              key={r.playerId}
              style={{ ...subRow, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div>
                <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}>
                  {playerName(r.playerId)}
                </div>
                <div style={monoKicker}>
                  Holes: {r.holesWon.length ? r.holesWon.join(', ') : '–'}
                </div>
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 26, color: r.skins > 0 ? T.ink : T.pencilSoft, fontVariantNumeric: 'tabular-nums' }}>
                {r.skins}
              </div>
            </div>
          ))}
        </div>

        <details style={{ ...card }}>
          <summary
            style={{ cursor: 'pointer', fontFamily: T.mono, fontSize: 10, letterSpacing: '1px', color: T.pencil, textTransform: 'uppercase', padding: '12px 16px', listStyle: 'none' }}
          >
            Hole-by-hole
          </summary>
          <div style={{ padding: '12px 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {results.skins.holeWinners.map((h) => (
              <div key={h.holeNumber} style={{ ...subRow, padding: 12 }}>
                <div style={monoKicker}>Hole {h.holeNumber}</div>
                <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink, marginTop: 2 }}>
                  {h.winnerPlayerId ? playerName(h.winnerPlayerId) : 'Push'}
                  {h.value > 1 ? ` (+${h.value - 1})` : ''}
                </div>
              </div>
            ))}
          </div>
        </details>
      </div>
    );
  }

  if (game.format === 'bestBall' && results.bestBall) {
    const bb = results.bestBall;
    const teamName = (id: string) => game.teams?.find((t) => t.id === id)?.name ?? id;
    const playersForTeam = (id: string) => {
      const team = game.teams?.find((t) => t.id === id);
      if (!team) return '';
      return team.playerIds.map(playerName).join(' / ');
    };

    const sorted = [...bb.totals].sort((a, b) => {
      if (a.holesPlayed === 0 && b.holesPlayed === 0) return 0;
      if (a.holesPlayed === 0) return 1;
      if (b.holesPlayed === 0) return -1;
      return a.total - b.total;
    });

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sorted.map((t) => (
            <div key={t.teamId} style={{ ...subRow }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}>
                    {teamName(t.teamId)}
                  </div>
                  <div style={monoKicker}>{playersForTeam(t.teamId) || '–'}</div>
                </div>
                <div style={{ fontFamily: T.serif, fontSize: 26, color: t.holesPlayed ? T.ink : T.pencilSoft, fontVariantNumeric: 'tabular-nums' }}>
                  {t.holesPlayed ? t.total : '–'}
                </div>
              </div>
              {bb.winnerTeamId === t.teamId && (
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.accent, textTransform: 'uppercase', marginTop: 4 }}>
                  Leader
                </div>
              )}
            </div>
          ))}
        </div>

        <details style={{ ...card }}>
          <summary
            style={{ cursor: 'pointer', fontFamily: T.mono, fontSize: 10, letterSpacing: '1px', color: T.pencil, textTransform: 'uppercase', padding: '12px 16px', listStyle: 'none' }}
          >
            Hole-by-hole best ball
          </summary>
          <div style={{ padding: '0 16px 16px', overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.hairline}` }}>
                  <th style={{ textAlign: 'left', padding: '8px 8px 8px 0', fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.pencilSoft, textTransform: 'uppercase', fontWeight: 400 }}>
                    Team
                  </th>
                  {Array.from({ length: 18 }).map((_, i) => (
                    <th
                      key={i}
                      style={{ padding: '8px 6px', textAlign: 'center', fontFamily: T.mono, fontSize: 9, letterSpacing: '0.5px', color: T.pencilSoft, fontWeight: 400 }}
                    >
                      {i + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(game.teams ?? []).map((team, rowIdx) => (
                  <tr key={team.id} style={{ borderTop: rowIdx > 0 ? `1px solid ${T.hairlineSoft}` : 'none' }}>
                    <td style={{ padding: '8px 8px 8px 0', fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink }}>
                      {team.name}
                    </td>
                    {(bb.teamScoresByHole[team.id] ?? []).map((v, idx) => (
                      <td key={idx} style={{ padding: '8px 6px', textAlign: 'center', fontFamily: T.serif, fontSize: 13, color: v != null ? T.ink : T.pencilSoft }}>
                        {v ?? '–'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    );
  }

  if (game.format === 'nassau' && results.nassau) {
    const na = results.nassau;
    const scope = na.scope;
    const isMatchMode = na.mode === 'match' && na.front9Match != null;

    const competitorName = (id: string) => {
      if (scope === 'team') return game.teams?.find((t) => t.id === id)?.name ?? id;
      return playerName(id);
    };

    const renderWinner = (id: string | null) => (id ? competitorName(id) : 'Push');

    const totalsEntries = Object.entries(na.overallTotals);
    totalsEntries.sort((a, b) => a[1] - b[1]);

    const matchSegs = isMatchMode ? [
      { label: 'Front 9', seg: na.front9Match! },
      { label: 'Back 9', seg: na.back9Match! },
      { label: 'Overall', seg: na.overallMatch! },
    ] : [];

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Winners grid */}
        <div style={{ ...card }}>
          <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.hairlineSoft}` }}>
            <div style={sectionLabel}>Winners</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0, border: `1px solid ${T.hairline}`, borderRadius: 10, overflow: 'hidden', background: T.paper }}>
              {[
                { label: 'Front 9', winner: na.front9WinnerId },
                { label: 'Back 9', winner: na.back9WinnerId },
                { label: 'Overall', winner: na.overallWinnerId },
              ].map((seg, i) => (
                <div
                  key={seg.label}
                  style={{ padding: '12px 10px', borderLeft: i > 0 ? `1px solid ${T.hairline}` : 'none', textAlign: 'center' }}
                >
                  <div style={monoKicker}>{seg.label}</div>
                  <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 15, color: seg.winner ? T.ink : T.pencilSoft, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {renderWinner(seg.winner)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Match-play segment status */}
        {isMatchMode && (
          <div style={{ ...card }}>
            <div style={{ padding: '14px 16px' }}>
              <div style={sectionLabel}>Match status</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {matchSegs.map(({ label, seg }) => (
                  <div
                    key={label}
                    style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', alignItems: 'center', gap: 8, ...subRow, padding: 12 }}
                  >
                    <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '1px', color: T.pencil, textTransform: 'uppercase' }}>
                      {label}
                    </div>
                    <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 15, color: T.ink, textAlign: 'center' }}>
                      {seg.statusLabel}
                    </div>
                    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.accent, textTransform: 'uppercase', textAlign: 'right' }}>
                      {seg.leaderId ? competitorName(seg.leaderId) : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Stroke totals — stroke mode only */}
        {!isMatchMode && (
          <div style={{ ...card }}>
            <div style={{ padding: '14px 16px' }}>
              <div style={sectionLabel}>Stroke totals</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {totalsEntries.map(([id, total]) => (
                  <div
                    key={id}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...subRow, padding: 12 }}
                  >
                    <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink }}>
                      {competitorName(id)}
                    </div>
                    <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.5px', color: T.pencil }}>
                      F9 {na.front9Totals[id] ?? 0} · B9 {na.back9Totals[id] ?? 0} · 18 {total}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (game.format === 'threePoint' && results.threePoint) {
    const tp = results.threePoint;
    const teamName = (id: string) => game.teams?.find((t) => t.id === id)?.name ?? id;

    const teamA = tp.teamAId;
    const teamB = tp.teamBId;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div style={{ ...subRow, padding: '16px 14px' }}>
            <div style={monoKicker}>{teamName(teamA)}</div>
            <div style={{ fontFamily: T.serif, fontSize: 36, color: T.ink, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
              {tp.totals[teamA] ?? 0}
            </div>
          </div>
          <div style={{ ...subRow, padding: '16px 14px' }}>
            <div style={monoKicker}>{teamName(teamB)}</div>
            <div style={{ fontFamily: T.serif, fontSize: 36, color: T.ink, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
              {tp.totals[teamB] ?? 0}
            </div>
          </div>
        </div>

        <details style={{ ...card }} open={!readOnly}>
          <summary
            style={{ cursor: 'pointer', fontFamily: T.mono, fontSize: 10, letterSpacing: '1px', color: T.pencil, textTransform: 'uppercase', padding: '12px 16px', listStyle: 'none' }}
          >
            Hole-by-hole points (running totals)
          </summary>
          <div style={{ padding: '0 16px 16px', overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.hairline}` }}>
                  {[
                    'Hole',
                    teamName(teamA),
                    teamName(teamB),
                    `Running (${teamName(teamA)})`,
                    `Running (${teamName(teamB)})`,
                  ].map((h) => (
                    <th
                      key={h}
                      style={{ padding: '8px 6px', textAlign: 'center', fontFamily: T.mono, fontSize: 9, letterSpacing: '0.5px', color: T.pencilSoft, fontWeight: 400, whiteSpace: 'nowrap' }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tp.holeDetails.map((h, rowIdx) => (
                  <tr key={h.holeNumber} style={{ borderTop: rowIdx > 0 ? `1px solid ${T.hairlineSoft}` : 'none' }}>
                    <td style={{ padding: '8px 6px', textAlign: 'center', fontFamily: T.mono, fontSize: 10, color: T.pencil }}>{h.holeNumber}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'center', fontFamily: T.serif, fontSize: 13, color: T.ink }}>{h.holeTotal.teamA}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'center', fontFamily: T.serif, fontSize: 13, color: T.ink }}>{h.holeTotal.teamB}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'center', fontFamily: T.serif, fontSize: 13, color: T.ink }}>{tp.runningTotalsByHole[teamA]?.[h.holeNumber - 1] ?? 0}</td>
                    <td style={{ padding: '8px 6px', textAlign: 'center', fontFamily: T.serif, fontSize: 13, color: T.ink }}>{tp.runningTotalsByHole[teamB]?.[h.holeNumber - 1] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    );
  }

  if (game.format === 'stableford' && results.stableford) {
    const st = results.stableford;
    const sorted = [...st.pointsByPlayer].sort((a, b) => b.total - a.total);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sorted.map((p) => (
            <div
              key={p.playerId}
              style={{ ...subRow, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div>
                <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}>
                  {playerName(p.playerId)}
                </div>
                <div style={monoKicker}>Holes played: {p.holesPlayed}</div>
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 26, color: p.total > 0 ? T.ink : T.pencilSoft, fontVariantNumeric: 'tabular-nums' }}>
                {p.total}
              </div>
            </div>
          ))}
        </div>
        {st.winnerPlayerId && (
          <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.accent, textTransform: 'uppercase' }}>
            Leader: {playerName(st.winnerPlayerId)}
          </div>
        )}
      </div>
    );
  }

  if (game.format === 'matchPlay' && results.matchPlay) {
    const mp = results.matchPlay;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ ...card }}>
          <div style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}>
              {playerName(mp.player1Id)} vs {playerName(mp.player2Id)}
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 26, color: T.ink, fontVariantNumeric: 'tabular-nums' }}>
              {mp.currentStatus}
            </div>
          </div>
          {mp.endedAtHole && mp.winnerPlayerId && (
            <div style={{ padding: '0 16px 14px', fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.accent, textTransform: 'uppercase' }}>
              Winner: {playerName(mp.winnerPlayerId)} (ended on hole {mp.endedAtHole})
            </div>
          )}
        </div>

        <details style={{ ...card }}>
          <summary
            style={{ cursor: 'pointer', fontFamily: T.mono, fontSize: 10, letterSpacing: '1px', color: T.pencil, textTransform: 'uppercase', padding: '12px 16px', listStyle: 'none' }}
          >
            Hole-by-hole
          </summary>
          <div style={{ padding: '12px 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {mp.holes.map((h) => (
              <div key={h.holeNumber} style={{ ...subRow, padding: 12 }}>
                <div style={monoKicker}>Hole {h.holeNumber}</div>
                <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink, marginTop: 2 }}>
                  {h.statusAfter}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.pencilSoft, textTransform: 'uppercase', marginTop: 2 }}>
                  {h.result === 'P1'
                    ? `${playerName(mp.player1Id)} won`
                    : h.result === 'P2'
                      ? `${playerName(mp.player2Id)} won`
                      : h.result === 'HALVED'
                        ? 'Halved'
                        : h.result === 'NO_SCORE'
                          ? 'No score'
                          : '–'}
                </div>
              </div>
            ))}
          </div>
        </details>
      </div>
    );
  }

  if (game.format === 'wolf' && results.wolf) {
    const wolf = results.wolf;

    type WolfChoice = { mode: 'lone' } | { mode: 'partner'; partnerId: string };

    const updateChoice = (holeNumber: number, choice: WolfChoice) => {
      if (!onUpdateGame) return;
      const next = {
        ...game,
        settings: {
          ...game.settings,
          wolfHoleChoices: {
            ...(game.settings.wolfHoleChoices ?? {}),
            [holeNumber]: choice,
          },
        },
      };
      onUpdateGame(next);
    };

    const clearChoice = (holeNumber: number) => {
      if (!onUpdateGame) return;
      const nextChoices: Record<number, WolfChoice> = { ...(game.settings.wolfHoleChoices ?? {}) } as Record<number, WolfChoice>;
      delete nextChoices[holeNumber];
      const next = { ...game, settings: { ...game.settings, wolfHoleChoices: nextChoices } };
      onUpdateGame(next);
    };

    const totalsSorted = Object.entries(wolf.totals).sort((a, b) => b[1] - a[1]);
    const orderSet = new Set(wolf.orderPlayerIds);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Points summary */}
        <div style={{ ...card }}>
          <div style={{ padding: '14px 16px' }}>
            <div style={sectionLabel}>Points</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {totalsSorted.map(([pid, pts]) => (
                <div
                  key={pid}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...subRow, padding: 12 }}
                >
                  <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink }}>
                    {playerName(pid)}
                  </div>
                  <div style={{ fontFamily: T.serif, fontSize: 22, color: pts !== 0 ? T.ink : T.pencilSoft, fontVariantNumeric: 'tabular-nums' }}>
                    {pts}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Hole-by-hole setup */}
        <details style={{ ...card }} open={!readOnly}>
          <summary
            style={{ cursor: 'pointer', fontFamily: T.mono, fontSize: 10, letterSpacing: '1px', color: T.pencil, textTransform: 'uppercase', padding: '12px 16px', listStyle: 'none' }}
          >
            Hole-by-hole setup &amp; results
          </summary>
          <div style={{ padding: '12px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {wolf.holes.map((h) => {
              const wolfPid = h.wolfPlayerId;
              const choice = (game.settings.wolfHoleChoices ?? {})[h.holeNumber] ?? null;
              const partnerValue = choice && choice.mode === 'partner' ? choice.partnerId : '';

              const partnerOptions = wolf.orderPlayerIds.filter((pid) => pid !== wolfPid);
              const otherPlayers = wolf.orderPlayerIds.filter((pid) => pid !== wolfPid && (!partnerValue || pid !== partnerValue));

              return (
                <div key={h.holeNumber} style={{ ...subRow, padding: '14px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <div style={monoKicker}>Hole {h.holeNumber}</div>
                      <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink, marginTop: 2 }}>
                        Wolf: {playerName(wolfPid)}
                      </div>
                    </div>
                    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.pencil, textAlign: 'right' }}>
                      {Object.keys(h.pointsDelta).length
                        ? `Δ ${Object.entries(h.pointsDelta)
                            .map(([pid, d]) => `${playerName(pid)} ${d > 0 ? '+' : ''}${d}`)
                            .join(', ')}`
                        : '—'}
                    </div>
                  </div>

                  {!onUpdateGame && !readOnly && (
                    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.warningInk, textTransform: 'uppercase', marginTop: 8 }}>
                      Editing disabled in this view.
                    </div>
                  )}

                  {onUpdateGame && orderSet.size === 4 && (
                    <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <button
                        onClick={() => updateChoice(h.holeNumber, { mode: 'lone' })}
                        style={{
                          padding: '10px 12px',
                          minHeight: 44,
                          border: choice?.mode === 'lone'
                            ? `1.5px solid ${T.accent}`
                            : `1px solid ${T.hairline}`,
                          borderRadius: 12,
                          background: choice?.mode === 'lone' ? `rgba(58,74,138,0.07)` : 'transparent',
                          fontFamily: T.sans,
                          fontSize: 13,
                          fontWeight: 600,
                          color: choice?.mode === 'lone' ? T.accent : T.ink,
                          cursor: 'pointer',
                        }}
                      >
                        Lone Wolf
                      </button>

                      <div style={{ display: 'flex', gap: 8 }}>
                        <select
                          value={partnerValue}
                          onChange={(e) => {
                            const pid = e.target.value;
                            if (!pid) {
                              clearChoice(h.holeNumber);
                              return;
                            }
                            updateChoice(h.holeNumber, { mode: 'partner', partnerId: pid });
                          }}
                          style={{
                            flex: 1,
                            padding: '10px 12px',
                            minHeight: 44,
                            borderRadius: 12,
                            border: `1px solid ${T.hairline}`,
                            background: T.paperDeep,
                            fontFamily: T.sans,
                            fontSize: 13,
                            color: T.ink,
                            cursor: 'pointer',
                          }}
                        >
                          <option value="">Pick partner (2v2)</option>
                          {partnerOptions.map((pid) => (
                            <option key={pid} value={pid}>
                              {playerName(pid)}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => clearChoice(h.holeNumber)}
                          style={{
                            padding: '10px 14px',
                            minHeight: 44,
                            border: `1px solid ${T.hairline}`,
                            borderRadius: 12,
                            background: 'transparent',
                            fontFamily: T.sans,
                            fontSize: 13,
                            color: T.pencil,
                            cursor: 'pointer',
                          }}
                        >
                          Clear
                        </button>
                      </div>

                      {choice?.mode === 'partner' && partnerValue && (
                        <div style={{ gridColumn: '1 / -1', fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.pencilSoft, textTransform: 'uppercase' }}>
                          Teams: ({playerName(wolfPid)} + {playerName(partnerValue)}) vs ({otherPlayers.map(playerName).join(' + ')}) · Best ball wins 1 pt each.
                        </div>
                      )}
                      {choice?.mode === 'lone' && (
                        <div style={{ gridColumn: '1 / -1', fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.pencilSoft, textTransform: 'uppercase' }}>
                          Lone Wolf: {playerName(wolfPid)} vs field · Win +3, lose -3.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      </div>
    );
  }

  return (
    <div style={{ ...card, padding: '16px', fontFamily: T.serif, fontStyle: 'italic', fontSize: 14, color: T.pencilSoft }}>
      Results for this game format are not implemented yet.
    </div>
  );
}
