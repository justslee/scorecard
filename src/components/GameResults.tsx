'use client';

import { Round, Game } from '@/lib/types';
import { computeGameResults } from '@/lib/games';

interface GameResultsProps {
  round: Round;
  game: Game;
  onUpdateGame?: (next: Game) => void;
}

export default function GameResults({ round, game, onUpdateGame }: GameResultsProps) {
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
            <div className="text-xs text-yellow-300 mt-2">Match-play Nassau is stubbed; using stroke totals.</div>
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

  if (game.format === 'threePoint' && results.threePoint) {
    const tp = results.threePoint;
    const teamName = (id: string) => game.teams?.find(t => t.id === id)?.name ?? id;

    const teamA = tp.teamAId;
    const teamB = tp.teamBId;

    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-400">{teamName(teamA)}</div>
            <div className="text-3xl font-bold">{tp.totals[teamA] ?? 0}</div>
          </div>
          <div className="bg-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-400">{teamName(teamB)}</div>
            <div className="text-3xl font-bold">{tp.totals[teamB] ?? 0}</div>
          </div>
        </div>

        <details className="bg-gray-900 border border-gray-700 rounded-lg p-3" open>
          <summary className="cursor-pointer text-sm text-gray-300">Hole-by-hole points (running totals)</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400">
                  <th className="p-2 text-left">Hole</th>
                  <th className="p-2 text-center">{teamName(teamA)}</th>
                  <th className="p-2 text-center">{teamName(teamB)}</th>
                  <th className="p-2 text-center">Running ({teamName(teamA)})</th>
                  <th className="p-2 text-center">Running ({teamName(teamB)})</th>
                </tr>
              </thead>
              <tbody>
                {tp.holeDetails.map(h => (
                  <tr key={h.holeNumber} className="border-t border-gray-800">
                    <td className="p-2">{h.holeNumber}</td>
                    <td className="p-2 text-center">{h.holeTotal.teamA}</td>
                    <td className="p-2 text-center">{h.holeTotal.teamB}</td>
                    <td className="p-2 text-center">{tp.runningTotalsByHole[teamA]?.[h.holeNumber - 1] ?? 0}</td>
                    <td className="p-2 text-center">{tp.runningTotalsByHole[teamB]?.[h.holeNumber - 1] ?? 0}</td>
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
      <div className="space-y-3">
        <div className="grid gap-2">
          {sorted.map(p => (
            <div key={p.playerId} className="flex items-center justify-between bg-gray-800 rounded-lg p-3">
              <div>
                <div className="font-semibold">{playerName(p.playerId)}</div>
                <div className="text-xs text-gray-400">Holes played: {p.holesPlayed}</div>
              </div>
              <div className="text-2xl font-bold">{p.total}</div>
            </div>
          ))}
        </div>
        {st.winnerPlayerId && (
          <div className="text-xs text-green-300">Leader: {playerName(st.winnerPlayerId)}</div>
        )}
      </div>
    );
  }

  if (game.format === 'matchPlay' && results.matchPlay) {
    const mp = results.matchPlay;
    return (
      <div className="space-y-3">
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">{playerName(mp.player1Id)} vs {playerName(mp.player2Id)}</div>
            <div className="text-2xl font-bold">{mp.currentStatus}</div>
          </div>
          {mp.endedAtHole && mp.winnerPlayerId && (
            <div className="text-xs text-green-300 mt-1">Winner: {playerName(mp.winnerPlayerId)} (ended on hole {mp.endedAtHole})</div>
          )}
        </div>

        <details className="bg-gray-900 border border-gray-700 rounded-lg p-3">
          <summary className="cursor-pointer text-sm text-gray-300">Hole-by-hole</summary>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            {mp.holes.map(h => (
              <div key={h.holeNumber} className="bg-gray-800 rounded p-2">
                <div className="text-gray-400 text-xs">Hole {h.holeNumber}</div>
                <div className="font-medium">{h.statusAfter}</div>
                <div className="text-xs text-gray-400">
                  {h.result === 'P1'
                    ? `${playerName(mp.player1Id)} won`
                    : h.result === 'P2'
                      ? `${playerName(mp.player2Id)} won`
                      : h.result === 'HALVED'
                        ? 'Halved'
                        : 'No score'}
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
      <div className="space-y-3">
        <div className="bg-gray-800 rounded-lg p-3">
          <div className="text-sm font-semibold mb-2">Points</div>
          <div className="grid gap-2">
            {totalsSorted.map(([pid, pts]) => (
              <div key={pid} className="flex items-center justify-between bg-gray-900 rounded p-2">
                <div className="font-medium">{playerName(pid)}</div>
                <div className="text-xl font-bold">{pts}</div>
              </div>
            ))}
          </div>
        </div>

        <details className="bg-gray-900 border border-gray-700 rounded-lg p-3" open>
          <summary className="cursor-pointer text-sm text-gray-300">Hole-by-hole setup & results</summary>
          <div className="mt-3 space-y-2">
            {wolf.holes.map(h => {
              const wolfPid = h.wolfPlayerId;
              const choice = (game.settings.wolfHoleChoices ?? {})[h.holeNumber] ?? null;
              const partnerValue = choice && choice.mode === 'partner' ? choice.partnerId : '';

              const partnerOptions = wolf.orderPlayerIds.filter(pid => pid !== wolfPid);
              const otherPlayers = wolf.orderPlayerIds.filter(pid => pid !== wolfPid && (!partnerValue || pid !== partnerValue));

              return (
                <div key={h.holeNumber} className="bg-gray-800 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs text-gray-400">Hole {h.holeNumber}</div>
                      <div className="font-semibold">Wolf: {playerName(wolfPid)}</div>
                    </div>
                    <div className="text-xs text-gray-300">
                      {Object.keys(h.pointsDelta).length
                        ? `Δ ${Object.entries(h.pointsDelta).map(([pid, d]) => `${playerName(pid)} ${d > 0 ? '+' : ''}${d}`).join(', ')}`
                        : '—'}
                    </div>
                  </div>

                  {!onUpdateGame && (
                    <div className="text-xs text-yellow-300 mt-2">Editing disabled in this view.</div>
                  )}

                  {onUpdateGame && orderSet.size === 4 && (
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <button
                        onClick={() => updateChoice(h.holeNumber, { mode: 'lone' })}
                        className={`p-2 rounded border ${choice?.mode === 'lone' ? 'bg-green-700 border-green-500' : 'bg-gray-900 border-gray-700'}`}
                      >
                        Lone Wolf
                      </button>

                      <div className="sm:col-span-2 flex gap-2">
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
                          className="flex-1 p-2 bg-gray-900 border border-gray-700 rounded"
                        >
                          <option value="">Pick partner (2v2)</option>
                          {partnerOptions.map(pid => (
                            <option key={pid} value={pid}>{playerName(pid)}</option>
                          ))}
                        </select>
                        <button onClick={() => clearChoice(h.holeNumber)} className="px-3 bg-gray-900 border border-gray-700 rounded">
                          Clear
                        </button>
                      </div>

                      {choice?.mode === 'partner' && partnerValue && (
                        <div className="sm:col-span-3 text-xs text-gray-400">
                          Teams: ({playerName(wolfPid)} + {playerName(partnerValue)}) vs ({otherPlayers.map(playerName).join(' + ')}) • Best ball wins 1 pt each.
                        </div>
                      )}
                      {choice?.mode === 'lone' && (
                        <div className="sm:col-span-3 text-xs text-gray-400">
                          Lone Wolf: {playerName(wolfPid)} vs field • Win +3, lose -3.
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
    <div className="bg-gray-800 rounded-lg p-4 text-sm text-gray-300">Results for this game format are not implemented yet.</div>
  );
}
