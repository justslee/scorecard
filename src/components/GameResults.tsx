'use client';

import { Round } from '@/lib/types';
import { Game } from '@/lib/types';
import { computeGameResults } from '@/lib/games';

interface GameResultsProps {
  round: Round;
  game: Game;
}

export default function GameResults({ round, game }: GameResultsProps) {
  const results = computeGameResults(round, game);
  const playerName = (id: string) => round.players.find(p => p.id === id)?.name ?? 'Unknown';

  if (game.format === 'skins' && results.skins) {
    const sorted = [...results.skins.byPlayer].sort((a, b) => b.skins - a.skins);
    return (
      <div className="space-y-3">
        <div className="grid gap-2">
          {sorted.map(r => (
            <div key={r.playerId} className="flex items-center justify-between bg-gray-800 rounded-lg p-3">
              <div>
                <div className="font-semibold">{playerName(r.playerId)}</div>
                <div className="text-xs text-gray-400">Holes: {r.holesWon.length ? r.holesWon.join(', ') : '-'}</div>
              </div>
              <div className="text-2xl font-bold">{r.skins}</div>
            </div>
          ))}
        </div>

        <details className="bg-gray-900 border border-gray-700 rounded-lg p-3">
          <summary className="cursor-pointer text-sm text-gray-300">Hole-by-hole</summary>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            {results.skins.holeWinners.map(h => (
              <div key={h.holeNumber} className="bg-gray-800 rounded p-2">
                <div className="text-gray-400 text-xs">Hole {h.holeNumber}</div>
                <div className="font-medium">
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
    const teamName = (id: string) => game.teams?.find(t => t.id === id)?.name ?? id;
    const playersForTeam = (id: string) => {
      const team = game.teams?.find(t => t.id === id);
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
      <div className="space-y-3">
        <div className="grid gap-2">
          {sorted.map(t => (
            <div key={t.teamId} className="bg-gray-800 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{teamName(t.teamId)}</div>
                  <div className="text-xs text-gray-400">{playersForTeam(t.teamId) || '-'}</div>
                </div>
                <div className="text-2xl font-bold">{t.holesPlayed ? t.total : '-'}</div>
              </div>
              {bb.winnerTeamId === t.teamId && (
                <div className="text-xs text-green-300 mt-1">Leader</div>
              )}
            </div>
          ))}
        </div>

        <details className="bg-gray-900 border border-gray-700 rounded-lg p-3">
          <summary className="cursor-pointer text-sm text-gray-300">Hole-by-hole best ball</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400">
                  <th className="text-left p-2">Team</th>
                  {Array.from({ length: 18 }).map((_, i) => (
                    <th key={i} className="p-2 text-center">{i + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(game.teams ?? []).map(team => (
                  <tr key={team.id} className="border-t border-gray-800">
                    <td className="p-2 font-medium">{team.name}</td>
                    {(bb.teamScoresByHole[team.id] ?? []).map((v, idx) => (
                      <td key={idx} className="p-2 text-center">{v ?? '-'}</td>
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
    const competitorName = (id: string) => {
      if (scope === 'team') return game.teams?.find(t => t.id === id)?.name ?? id;
      return playerName(id);
    };

    const renderWinner = (id: string | null) => (id ? competitorName(id) : 'Push');

    const totalsEntries = Object.entries(na.overallTotals);
    totalsEntries.sort((a, b) => a[1] - b[1]);

    return (
      <div className="space-y-3">
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="text-sm text-gray-400 mb-2">Winners (stroke totals)</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="bg-gray-900 rounded p-2">
              <div className="text-xs text-gray-400">Front 9</div>
              <div className="font-semibold">{renderWinner(na.front9WinnerId)}</div>
            </div>
            <div className="bg-gray-900 rounded p-2">
              <div className="text-xs text-gray-400">Back 9</div>
              <div className="font-semibold">{renderWinner(na.back9WinnerId)}</div>
            </div>
            <div className="bg-gray-900 rounded p-2">
              <div className="text-xs text-gray-400">Overall</div>
              <div className="font-semibold">{renderWinner(na.overallWinnerId)}</div>
            </div>
          </div>
          {na.mode === 'match' && (
            <div className="text-xs text-yellow-300 mt-2">
              Match-play Nassau is stubbed; using stroke totals.
            </div>
          )}
        </div>

        <div className="bg-gray-800 rounded-lg p-3">
          <div className="text-sm font-semibold mb-2">Totals</div>
          <div className="space-y-2">
            {totalsEntries.map(([id, total]) => (
              <div key={id} className="flex items-center justify-between bg-gray-900 rounded p-2">
                <div className="font-medium">{competitorName(id)}</div>
                <div className="text-sm text-gray-300">F9 {na.front9Totals[id] ?? 0} • B9 {na.back9Totals[id] ?? 0} • 18 {total}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (game.format === 'stableford' && results.stableford) {
    const st = results.stableford;
    return (
      <div className="space-y-3">
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="text-sm text-gray-300">Scoring: Double bogey+ 0, Bogey 1, Par 2, Birdie 3, Eagle 4, Albatross 5</div>
        </div>
        <div className="grid gap-2">
          {st.byPlayer.map(r => (
            <div key={r.playerId} className="flex items-center justify-between bg-gray-800 rounded-lg p-3">
              <div className="font-semibold">{playerName(r.playerId)}</div>
              <div className="text-2xl font-bold">{r.holesPlayed ? r.points : '-'}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (game.format === 'modifiedStableford' && results.modifiedStableford) {
    const st = results.modifiedStableford;
    return (
      <div className="space-y-3">
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="text-sm text-gray-300">Scoring: Bogey -1, Par 0, Birdie +2, Eagle +5, Double Eagle +8</div>
        </div>
        <div className="grid gap-2">
          {st.byPlayer.map(r => (
            <div key={r.playerId} className="flex items-center justify-between bg-gray-800 rounded-lg p-3">
              <div className="font-semibold">{playerName(r.playerId)}</div>
              <div className="text-2xl font-bold">{r.holesPlayed ? r.points : '-'}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (game.format === 'matchPlay' && results.matchPlay) {
    const mp = results.matchPlay;
    return (
      <div className="space-y-3">
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="text-sm text-gray-400">Current</div>
          <div className="text-2xl font-bold">{mp.currentStatus}</div>
          <div className="text-sm text-gray-300 mt-1">{playerName(mp.player1Id)} vs {playerName(mp.player2Id)}</div>
        </div>

        <details className="bg-gray-900 border border-gray-700 rounded-lg p-3">
          <summary className="cursor-pointer text-sm text-gray-300">Hole-by-hole</summary>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            {mp.holeResults.map(h => (
              <div key={h.holeNumber} className="bg-gray-800 rounded p-2">
                <div className="text-gray-400 text-xs">Hole {h.holeNumber}</div>
                <div className="font-medium">
                  {h.winnerPlayerId ? playerName(h.winnerPlayerId) : 'Halved'}
                </div>
                <div className="text-xs text-gray-400">{h.statusAfter}</div>
              </div>
            ))}
          </div>
        </details>
      </div>
    );
  }

  if (game.format === 'threePoint' && results.threePoint) {
    const tp = results.threePoint;
    const teamName = (id: string) => game.teams?.find(t => t.id === id)?.name ?? id;
    const totalsByTeam = new Map(tp.totals.map(t => [t.teamId, t.points] as const));

    return (
      <div className="space-y-3">
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="text-sm text-gray-300">3 points per hole: A1 vs B1 (1), A2 vs B2 (1), Best Ball (1). Ties split (0.5).</div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="bg-gray-800 rounded-lg p-3">
            <div className="text-sm text-gray-400">{teamName(tp.teamAId)}</div>
            <div className="text-2xl font-bold">{totalsByTeam.get(tp.teamAId) ?? 0}</div>
          </div>
          <div className="bg-gray-800 rounded-lg p-3">
            <div className="text-sm text-gray-400">{teamName(tp.teamBId)}</div>
            <div className="text-2xl font-bold">{totalsByTeam.get(tp.teamBId) ?? 0}</div>
          </div>
        </div>

        <details className="bg-gray-900 border border-gray-700 rounded-lg p-3">
          <summary className="cursor-pointer text-sm text-gray-300">Hole-by-hole points</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400">
                  <th className="text-left p-2">Hole</th>
                  <th className="p-2 text-center">A pts</th>
                  <th className="p-2 text-center">B pts</th>
                </tr>
              </thead>
              <tbody>
                {tp.holePoints.map(h => {
                  const a = h.a1Points + h.a2Points + h.bestBallA;
                  const b = h.b1Points + h.b2Points + h.bestBallB;
                  return (
                    <tr key={h.holeNumber} className="border-t border-gray-800">
                      <td className="p-2">{h.holeNumber}</td>
                      <td className="p-2 text-center">{a}</td>
                      <td className="p-2 text-center">{b}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4 text-sm text-gray-300">
      Results for this game format are not implemented yet.
    </div>
  );
}
