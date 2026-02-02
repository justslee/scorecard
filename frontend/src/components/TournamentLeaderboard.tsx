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
  if (value === null) return '–';
  if (value === 0) return 'E';
  return `${value > 0 ? '+' : ''}${value}`;
}

export default function TournamentLeaderboard({ tournament, rounds }: { tournament: Tournament; rounds: Round[] }) {
  const rows: LeaderboardRow[] = tournament.playerIds.map((playerId) => {
    const name =
      tournament.playerNamesById?.[playerId] ||
      rounds.flatMap((r) => r.players).find((p) => p.id === playerId)?.name ||
      'Player';

    const roundToPar: Record<string, number | null> = {};
    const roundStrokes: Record<string, number | null> = {};

    let totalStrokes: number | null = 0;
    let totalToPar: number | null = 0;

    rounds.forEach((r) => {
      const totals = calculateTotals(r.scores, r.holes, playerId);
      const anyScore = r.scores.some((s) => s.playerId === playerId && s.strokes !== null);

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

    const anyAcross = rounds.some((r) => r.scores.some((s) => s.playerId === playerId && s.strokes !== null));
    if (!anyAcross) {
      totalStrokes = null;
      totalToPar = null;
    }

    return { playerId, name, roundToPar, roundStrokes, totalStrokes, totalToPar };
  });

  rows.sort((a, b) => {
    if (a.totalStrokes === null && b.totalStrokes === null) return a.name.localeCompare(b.name);
    if (a.totalStrokes === null) return 1;
    if (b.totalStrokes === null) return -1;
    return a.totalStrokes - b.totalStrokes;
  });

  return (
    <section className="card p-5">
      <div className="flex items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-400 tracking-wide uppercase">Leaderboard</h2>
          <p className="text-lg font-semibold tracking-tight">Total strokes</p>
        </div>
        <div className="text-xs text-zinc-500">Lower is better</div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-zinc-400 border-b border-white/10">
              <th className="text-left py-2 pr-2">#</th>
              <th className="text-left py-2 px-2">Player</th>
              {rounds.map((r, idx) => (
                <th key={r.id} className="text-center py-2 px-2 min-w-[70px]">
                  R{idx + 1}
                </th>
              ))}
              <th className="text-center py-2 pl-2 min-w-[90px]">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/6">
            {rows.map((row, i) => (
              <tr key={row.playerId} className="">
                <td className="py-3 pr-2 text-zinc-500">{i + 1}</td>
                <td className="py-3 px-2 font-medium text-zinc-200">{row.name}</td>
                {rounds.map((r) => {
                  const tp = row.roundToPar[r.id];
                  const strokes = row.roundStrokes[r.id];
                  const color =
                    tp === null ? 'text-zinc-500' : tp < 0 ? 'text-red-300' : tp > 0 ? 'text-sky-300' : 'text-emerald-300';

                  return (
                    <td key={r.id} className={`py-3 px-2 text-center ${color}`}>
                      <div className="font-semibold">{formatToPar(tp)}</div>
                      <div className="text-xs text-zinc-500">{strokes ?? '–'}</div>
                    </td>
                  );
                })}
                <td className="py-3 pl-2 text-center">
                  <div
                    className={`font-semibold text-base ${
                      row.totalToPar === null
                        ? 'text-zinc-500'
                        : row.totalToPar < 0
                          ? 'text-red-300'
                          : row.totalToPar > 0
                            ? 'text-sky-300'
                            : 'text-emerald-300'
                    }`}
                  >
                    {formatToPar(row.totalToPar)}
                  </div>
                  <div className="text-xs text-zinc-500">{row.totalStrokes ?? '–'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
