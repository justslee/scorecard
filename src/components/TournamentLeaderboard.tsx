'use client';

import { Tournament, Round, calculateTotals } from '@/lib/types';

type LeaderboardRow = {
  playerId: string;
  name: string;
  roundToPar: Record<string, number | null>; // roundId -> toPar (null if no scores)
  roundStrokes: Record<string, number | null>;
  totalStrokes: number | null;
  totalToPar: number | null;
};

function formatToPar(value: number | null): string {
  if (value === null) return '-';
  if (value === 0) return 'E';
  return `${value > 0 ? '+' : ''}${value}`;
}

export default function TournamentLeaderboard({
  tournament,
  rounds,
}: {
  tournament: Tournament;
  rounds: Round[];
}) {
  const rows: LeaderboardRow[] = tournament.playerIds.map(playerId => {
    const name =
      tournament.playerNamesById?.[playerId] ||
      // fallback: first occurrence in any round
      rounds.flatMap(r => r.players).find(p => p.id === playerId)?.name ||
      'Player';

    const roundToPar: Record<string, number | null> = {};
    const roundStrokes: Record<string, number | null> = {};

    let totalStrokes: number | null = 0;
    let totalToPar: number | null = 0;

    rounds.forEach(r => {
      const totals = calculateTotals(r.scores, r.holes, playerId);
      const anyScore = r.scores.some(s => s.playerId === playerId && s.strokes !== null);

      if (!anyScore) {
        roundToPar[r.id] = null;
        roundStrokes[r.id] = null;
        return;
      }

      roundToPar[r.id] = totals.toPar;
      roundStrokes[r.id] = totals.total;
      totalStrokes = (totalStrokes ?? 0) + totals.total;
      totalToPar = (totalToPar ?? 0) + totals.toPar;
    });

    // If player has literally no scores across all rounds, keep totals null
    const anyAcross = rounds.some(r => r.scores.some(s => s.playerId === playerId && s.strokes !== null));
    if (!anyAcross) {
      totalStrokes = null;
      totalToPar = null;
    }

    return {
      playerId,
      name,
      roundToPar,
      roundStrokes,
      totalStrokes,
      totalToPar,
    };
  });

  rows.sort((a, b) => {
    if (a.totalStrokes === null && b.totalStrokes === null) return a.name.localeCompare(b.name);
    if (a.totalStrokes === null) return 1;
    if (b.totalStrokes === null) return -1;
    return a.totalStrokes - b.totalStrokes;
  });

  return (
    <div className="bg-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">Leaderboard</h2>
        <div className="text-xs text-gray-400">Total strokes (lower is better)</div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-gray-300">
              <th className="text-left p-2">#</th>
              <th className="text-left p-2">Player</th>
              {rounds.map((r, idx) => (
                <th key={r.id} className="text-center p-2 min-w-[70px]">
                  R{idx + 1}
                </th>
              ))}
              <th className="text-center p-2 min-w-[90px]">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.playerId} className="border-t border-gray-700">
                <td className="p-2 text-gray-400">{i + 1}</td>
                <td className="p-2 font-medium">{row.name}</td>
                {rounds.map(r => {
                  const tp = row.roundToPar[r.id];
                  const strokes = row.roundStrokes[r.id];
                  const color =
                    tp === null
                      ? 'text-gray-500'
                      : tp < 0
                        ? 'text-red-400'
                        : tp > 0
                          ? 'text-blue-300'
                          : 'text-green-300';

                  return (
                    <td key={r.id} className={`p-2 text-center ${color}`}>
                      <div className="font-bold">{formatToPar(tp)}</div>
                      <div className="text-xs text-gray-500">{strokes ?? '-'}</div>
                    </td>
                  );
                })}
                <td className="p-2 text-center">
                  <div
                    className={`font-bold text-lg ${
                      row.totalToPar === null
                        ? 'text-gray-500'
                        : row.totalToPar < 0
                          ? 'text-red-400'
                          : row.totalToPar > 0
                            ? 'text-blue-300'
                            : 'text-green-300'
                    }`}
                  >
                    {formatToPar(row.totalToPar)}
                  </div>
                  <div className="text-xs text-gray-400">{row.totalStrokes ?? '-'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
