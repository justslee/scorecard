'use client';

import { Round, Game } from '@/lib/types';
import { computeGameResults } from '@/lib/games';
import { T } from '@/components/yardage/tokens';

interface GameLeaderboardsProps {
  round: Round;
}

// Module-level constants — T.* tokens are static
const cardStyle: React.CSSProperties = {
  border: `1px solid ${T.hairline}`,
  borderRadius: 14,
  background: T.paper,
  overflow: 'hidden',
};

// Rank circle — serif italic position number; leader gets accent color border + text
function RankCircle({ pos, isLeader }: { pos: number; isLeader: boolean }) {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 99,
        border: `${isLeader ? '1.5px' : '1px'} solid ${isLeader ? T.accent : T.hairline}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: T.serif,
        fontStyle: 'italic',
        fontSize: 13,
        color: isLeader ? T.accent : T.pencil,
        flexShrink: 0,
      }}
    >
      {pos}
    </div>
  );
}

// Card header — game name (serif italic) + optional mono bet kicker
function CardHeader({ gameName, betAmount, betSuffix }: { gameName: string; betAmount: number; betSuffix?: string }) {
  return (
    <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.hairlineSoft}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 18, color: T.ink, letterSpacing: '-0.3px' }}>
          {gameName}
        </span>
        {betAmount > 0 && betSuffix && (
          <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.pencil, textTransform: 'uppercase' }}>
            ${betAmount}{betSuffix}
          </span>
        )}
      </div>
    </div>
  );
}

export default function GameLeaderboards({ round }: GameLeaderboardsProps) {
  // Filter out the synthetic 'settlement' game (rendered by SettleUpPanel, not here)
  const games = (round.games ?? []).filter((g) => g.format !== 'settlement');

  if (games.length === 0) return null;

  return (
    <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Section header — typographic, no icon */}
      <div>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: '1.4px', color: T.pencil, textTransform: 'uppercase', marginBottom: 3 }}>
          Game standings
        </div>
        <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 20, color: T.ink, letterSpacing: '-0.4px' }}>
          Leaderboards
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {games.map((game) => (
          <GameLeaderboardCard key={game.id} round={round} game={game} />
        ))}
      </div>
    </div>
  );
}

function GameLeaderboardCard({ round, game }: { round: Round; game: Game }) {
  const results = computeGameResults(round, game);
  const playerName = (id: string) => round.players.find((p) => p.id === id)?.name ?? '?';
  const teamName = (id: string) => game.teams?.find((t) => t.id === id)?.name ?? id;

  const betAmount = game.settings.pointValue ?? 0;

  // Skins
  if (game.format === 'skins' && results.skins) {
    const sorted = [...results.skins.byPlayer].sort((a, b) => b.skins - a.skins);
    const carryover = results.skins.holeWinners.find(h => h.winnerPlayerId === null && h.value > 1);
    const potSize = carryover?.value ?? 0;

    return (
      <div style={cardStyle}>
        <CardHeader gameName={game.name} betAmount={betAmount} betSuffix="/skin" />

        {/* Carrying pot note */}
        {potSize > 1 && (
          <div style={{ padding: '8px 16px', borderBottom: `1px solid ${T.hairlineSoft}`, fontFamily: T.mono, fontSize: 9.5, letterSpacing: '1px', color: T.warningInk, textTransform: 'uppercase' }}>
            {potSize} skins carrying{betAmount > 0 ? ` · $${potSize * betAmount} up for grabs` : ''}
          </div>
        )}

        {/* Leaderboard */}
        <div>
          {sorted.map((p, i) => {
            const winnings = betAmount > 0 ? p.skins * betAmount : 0;
            const isLeader = i === 0 && p.skins > 0;
            return (
              <div
                key={p.playerId}
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  background: isLeader ? 'rgba(26,42,26,0.03)' : 'transparent',
                  borderTop: i > 0 ? `1px solid ${T.hairlineSoft}` : 'none',
                }}
              >
                <RankCircle pos={i + 1} isLeader={isLeader} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}>
                    {playerName(p.playerId)}
                  </div>
                  {p.holesWon.length > 0 && (
                    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.pencilSoft, textTransform: 'uppercase', marginTop: 2 }}>
                      Holes: {[...new Set(p.holesWon)].join(', ')}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: T.serif, fontSize: 22, color: p.skins > 0 ? T.ink : T.pencilSoft, fontVariantNumeric: 'tabular-nums' }}>
                    {p.skins}
                  </div>
                  {winnings > 0 && (
                    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.accent, textTransform: 'uppercase', marginTop: 1 }}>
                      +${winnings}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Nassau
  if (game.format === 'nassau' && results.nassau) {
    const na = results.nassau;
    const isMatchMode = na.mode === 'match' && na.front9Match != null;
    const getName = (id: string | null) => {
      if (!id) return 'Tied';
      return na.scope === 'team' ? teamName(id) : playerName(id);
    };

    const totalsEntries = Object.entries(na.overallTotals).sort((a, b) => a[1] - b[1]);
    const matchSegs = isMatchMode ? [
      { label: 'F9', seg: na.front9Match! },
      { label: 'B9', seg: na.back9Match! },
      { label: '18', seg: na.overallMatch! },
    ] : [];

    return (
      <div style={cardStyle}>
        <CardHeader gameName={game.name} betAmount={betAmount} betSuffix="/bet" />

        {/* Winners grid */}
        <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0, borderBottom: `1px solid ${T.hairlineSoft}` }}>
          {[
            { label: 'Front 9', winner: na.front9WinnerId },
            { label: 'Back 9', winner: na.back9WinnerId },
            { label: 'Overall', winner: na.overallWinnerId },
          ].map((seg, i) => (
            <div
              key={seg.label}
              style={{ textAlign: 'center', padding: '10px 8px', borderLeft: i > 0 ? `1px solid ${T.hairlineSoft}` : 'none' }}
            >
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: '1px', color: T.pencilSoft, textTransform: 'uppercase', marginBottom: 4 }}>
                {seg.label}
              </div>
              <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 15, color: seg.winner ? T.ink : T.pencilSoft, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getName(seg.winner)}
              </div>
              {betAmount > 0 && seg.winner && (
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '0.8px', color: T.pencil, textTransform: 'uppercase', marginTop: 2 }}>
                  ${betAmount}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Match-play segment status */}
        {isMatchMode && (
          <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0 }}>
            {matchSegs.map(({ label, seg }, i) => (
              <div
                key={label}
                style={{ textAlign: 'center', padding: '10px 8px', borderLeft: i > 0 ? `1px solid ${T.hairlineSoft}` : 'none' }}
              >
                <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: '1px', color: T.pencilSoft, textTransform: 'uppercase', marginBottom: 4 }}>
                  {label}
                </div>
                <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 14, color: seg.holesPlayed > 0 ? T.ink : T.pencilSoft }}>
                  {seg.statusLabel}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Stroke totals — stroke mode only */}
        {!isMatchMode && (
          <div>
            {totalsEntries.map(([id, total], i) => {
              const isLeader = i === 0;
              return (
                <div
                  key={id}
                  style={{
                    padding: '10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    borderTop: `1px solid ${T.hairlineSoft}`,
                    background: isLeader ? 'rgba(26,42,26,0.03)' : 'transparent',
                  }}
                >
                  <RankCircle pos={i + 1} isLeader={isLeader} />
                  <div style={{ flex: 1, fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink }}>
                    {na.scope === 'team' ? teamName(id) : playerName(id)}
                  </div>
                  <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.5px', color: T.pencil }}>
                    {na.front9Totals[id]}/{na.back9Totals[id]}/{total}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Best Ball
  if (game.format === 'bestBall' && results.bestBall) {
    const bb = results.bestBall;
    const sorted = [...bb.totals].sort((a, b) => {
      if (a.holesPlayed === 0) return 1;
      if (b.holesPlayed === 0) return -1;
      return a.total - b.total;
    });

    return (
      <div style={cardStyle}>
        <CardHeader gameName={game.name} betAmount={betAmount} />
        <div>
          {sorted.map((t, i) => {
            const team = game.teams?.find(tm => tm.id === t.teamId);
            const names = team?.playerIds.map(playerName).join(' & ') ?? teamName(t.teamId);
            const isLeader = i === 0 && t.holesPlayed > 0;
            return (
              <div
                key={t.teamId}
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  borderTop: i > 0 ? `1px solid ${T.hairlineSoft}` : 'none',
                  background: isLeader ? 'rgba(26,42,26,0.03)' : 'transparent',
                }}
              >
                <RankCircle pos={i + 1} isLeader={isLeader} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {names}
                  </div>
                </div>
                <div style={{ fontFamily: T.serif, fontSize: 22, color: t.holesPlayed > 0 ? T.ink : T.pencilSoft, fontVariantNumeric: 'tabular-nums' }}>
                  {t.holesPlayed ? t.total : '–'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // 3-Point
  if (game.format === 'threePoint' && results.threePoint) {
    const tp = results.threePoint;
    const teamAName = teamName(tp.teamAId);
    const teamBName = teamName(tp.teamBId);
    const teamAPoints = tp.totals[tp.teamAId] ?? 0;
    const teamBPoints = tp.totals[tp.teamBId] ?? 0;
    const pointDiff = Math.abs(teamAPoints - teamBPoints);

    return (
      <div style={cardStyle}>
        <CardHeader gameName={game.name} betAmount={betAmount} betSuffix="/pt" />
        <div style={{ padding: '20px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: T.serif, fontSize: 44, color: teamAPoints > teamBPoints ? T.ink : T.pencilSoft, fontVariantNumeric: 'tabular-nums', lineHeight: 1, letterSpacing: '-1px' }}>
                {teamAPoints}
              </div>
              <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink, marginTop: 5, letterSpacing: '-0.2px' }}>
                {teamAName}
              </div>
              {teamAPoints > teamBPoints && (
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1.2px', color: T.accent, textTransform: 'uppercase', marginTop: 3 }}>
                  Up {pointDiff}{betAmount > 0 ? ` · +$${pointDiff * betAmount}` : ''}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 18, color: T.pencilSoft }}>vs</div>
              <div style={{ width: 1, height: 36, background: T.hairline }} />
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: T.serif, fontSize: 44, color: teamBPoints > teamAPoints ? T.ink : T.pencilSoft, fontVariantNumeric: 'tabular-nums', lineHeight: 1, letterSpacing: '-1px' }}>
                {teamBPoints}
              </div>
              <div style={{ fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink, marginTop: 5, letterSpacing: '-0.2px' }}>
                {teamBName}
              </div>
              {teamBPoints > teamAPoints && (
                <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1.2px', color: T.accent, textTransform: 'uppercase', marginTop: 3 }}>
                  Up {pointDiff}{betAmount > 0 ? ` · +$${pointDiff * betAmount}` : ''}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Stableford
  if ((game.format === 'stableford' || game.format === 'modifiedStableford') && results.stableford) {
    const st = results.stableford;
    const sorted = [...st.pointsByPlayer].sort((a, b) => b.total - a.total);

    return (
      <div style={cardStyle}>
        <CardHeader gameName={game.name} betAmount={betAmount} />
        <div>
          {sorted.map((p, i) => {
            const isLeader = i === 0 && p.holesPlayed > 0;
            return (
              <div
                key={p.playerId}
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  borderTop: i > 0 ? `1px solid ${T.hairlineSoft}` : 'none',
                  background: isLeader ? 'rgba(26,42,26,0.03)' : 'transparent',
                }}
              >
                <RankCircle pos={i + 1} isLeader={isLeader} />
                <div style={{ flex: 1, fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}>
                  {playerName(p.playerId)}
                </div>
                <div style={{ fontFamily: T.serif, fontSize: 22, color: p.holesPlayed > 0 ? T.ink : T.pencilSoft, fontVariantNumeric: 'tabular-nums' }}>
                  {p.total > 0 ? `${p.total} pts` : '–'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Match Play
  if (game.format === 'matchPlay' && results.matchPlay) {
    const mp = results.matchPlay;
    const lastHole = mp.holes[mp.holes.length - 1];
    const p1Leading = (lastHole?.matchDiffAfter ?? 0) > 0;
    const p2Leading = (lastHole?.matchDiffAfter ?? 0) < 0;

    return (
      <div style={cardStyle}>
        <CardHeader gameName={game.name} betAmount={betAmount} />
        <div style={{ padding: '18px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontFamily: T.sans, fontSize: 15, fontWeight: 500, color: p1Leading ? T.ink : T.pencilSoft, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {playerName(mp.player1Id)}
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 26, color: T.ink, padding: '0 8px', textAlign: 'center', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {mp.currentStatus}
            </div>
            <div style={{ fontFamily: T.sans, fontSize: 15, fontWeight: 500, color: p2Leading ? T.ink : T.pencilSoft, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>
              {playerName(mp.player2Id)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Wolf
  if (game.format === 'wolf' && results.wolf) {
    const wolf = results.wolf;
    const sorted = Object.entries(wolf.totals).sort((a, b) => b[1] - a[1]);

    return (
      <div style={cardStyle}>
        <CardHeader gameName={game.name} betAmount={betAmount} betSuffix="/pt" />
        <div>
          {sorted.map(([pid, pts], i) => {
            const winnings = betAmount > 0 ? pts * betAmount : 0;
            const isLeader = i === 0 && pts > 0;
            return (
              <div
                key={pid}
                style={{
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  borderTop: i > 0 ? `1px solid ${T.hairlineSoft}` : 'none',
                  background: isLeader ? 'rgba(26,42,26,0.03)' : 'transparent',
                }}
              >
                <RankCircle pos={i + 1} isLeader={isLeader} />
                <div style={{ flex: 1, fontFamily: T.sans, fontSize: 14, fontWeight: 500, color: T.ink }}>
                  {playerName(pid)}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: T.serif, fontSize: 22, color: pts > 0 ? T.ink : pts < 0 ? T.errorInk : T.pencilSoft, fontVariantNumeric: 'tabular-nums' }}>
                    {pts > 0 ? '+' : ''}{pts}
                  </div>
                  {winnings !== 0 && (
                    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: winnings > 0 ? T.accent : T.errorInk, textTransform: 'uppercase', marginTop: 1 }}>
                      {winnings > 0 ? '+' : ''}${winnings}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Default / stub
  return (
    <div style={{ border: `1px solid ${T.hairline}`, borderRadius: 14, background: T.paper, padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 16, color: T.ink }}>
          {game.name}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '1px', color: T.pencilSoft, textTransform: 'uppercase' }}>
          {game.format}
        </span>
      </div>
      <div style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 13, color: T.pencilSoft, marginTop: 8 }}>
        Leaderboard updates as you enter scores
      </div>
    </div>
  );
}
