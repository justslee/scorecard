'use client';

import { Round, Game } from '@/lib/types';
import { computeGameResults } from '@/lib/games';

interface GameResultsProps {
  round: Round;
  game: Game;
  onUpdateGame?: (next: Game) => void;
}

const box = 'rounded-2xl bg-white/4 border border-white/10';
const boxSubtle = 'rounded-2xl bg-white/3 border border-white/10';

export default function GameResults({ round, game, onUpdateGame }: GameResultsProps) {
  const results = computeGameResults(round, game);
  const playerName = (id: string) => round.players.find((p) => p.id === id)?.name ?? 'Unknown';

  if (game.format === 'skins' && results.skins) {
    const sorted = [...results.skins.byPlayer].sort((a, b) => b.skins - a.skins);
    return (
      <div className="space-y-3">
        <div className="grid gap-2">
          {sorted.map((r) => (
            <div key={r.playerId} className={`${box} p-4 flex items-center justify-between`}>
              <div>
                <div className="font-semibold text-zinc-200">{playerName(r.playerId)}</div>
                <div className="text-xs text-zinc-500">Holes: {r.holesWon.length ? r.holesWon.join(', ') : '–'}</div>
              </div>
              <div className="text-2xl font-semibold text-zinc-100">{r.skins}</div>
            </div>
          ))}
        </div>

        <details className={`${boxSubtle} p-4`}>
          <summary className="cursor-pointer text-sm text-zinc-300">Hole-by-hole</summary>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            {results.skins.holeWinners.map((h) => (
              <div key={h.holeNumber} className="rounded-2xl bg-white/4 border border-white/10 p-3">
                <div className="text-zinc-500 text-xs">Hole {h.holeNumber}</div>
                <div className="font-medium text-zinc-200">
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
      <div className="space-y-3">
        <div className="grid gap-2">
          {sorted.map((t) => (
            <div key={t.teamId} className={`${box} p-4`}>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-zinc-200">{teamName(t.teamId)}</div>
                  <div className="text-xs text-zinc-500">{playersForTeam(t.teamId) || '–'}</div>
                </div>
                <div className="text-2xl font-semibold text-zinc-100">{t.holesPlayed ? t.total : '–'}</div>
              </div>
              {bb.winnerTeamId === t.teamId && <div className="text-xs text-emerald-300 mt-1">Leader</div>}
            </div>
          ))}
        </div>

        <details className={`${boxSubtle} p-4`}>
          <summary className="cursor-pointer text-sm text-zinc-300">Hole-by-hole best ball</summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 border-b border-white/10">
                  <th className="text-left py-2 pr-2">Team</th>
                  {Array.from({ length: 18 }).map((_, i) => (
                    <th key={i} className="py-2 px-2 text-center">
                      {i + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/6">
                {(game.teams ?? []).map((team) => (
                  <tr key={team.id}>
                    <td className="py-2 pr-2 font-medium text-zinc-200">{team.name}</td>
                    {(bb.teamScoresByHole[team.id] ?? []).map((v, idx) => (
                      <td key={idx} className="py-2 px-2 text-center text-zinc-300">
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
    const competitorName = (id: string) => {
      if (scope === 'team') return game.teams?.find((t) => t.id === id)?.name ?? id;
      return playerName(id);
    };

    const renderWinner = (id: string | null) => (id ? competitorName(id) : 'Push');

    const totalsEntries = Object.entries(na.overallTotals);
    totalsEntries.sort((a, b) => a[1] - b[1]);

    return (
      <div className="space-y-3">
        <div className={`${box} p-4`}>
          <div className="text-sm text-zinc-400 mb-2">Winners (stroke totals)</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="rounded-2xl bg-white/3 border border-white/10 p-3">
              <div className="text-xs text-zinc-500">Front 9</div>
              <div className="font-semibold text-zinc-200">{renderWinner(na.front9WinnerId)}</div>
            </div>
            <div className="rounded-2xl bg-white/3 border border-white/10 p-3">
              <div className="text-xs text-zinc-500">Back 9</div>
              <div className="font-semibold text-zinc-200">{renderWinner(na.back9WinnerId)}</div>
            </div>
            <div className="rounded-2xl bg-white/3 border border-white/10 p-3">
              <div className="text-xs text-zinc-500">Overall</div>
              <div className="font-semibold text-zinc-200">{renderWinner(na.overallWinnerId)}</div>
            </div>
          </div>
          {na.mode === 'match' && <div className="text-xs text-amber-200 mt-2">Match-play Nassau is stubbed; using stroke totals.</div>}
        </div>

        <div className={`${box} p-4`}>
          <div className="text-sm font-semibold text-zinc-200 mb-2">Totals</div>
          <div className="space-y-2">
            {totalsEntries.map(([id, total]) => (
              <div key={id} className="flex items-center justify-between rounded-2xl bg-white/3 border border-white/10 p-3">
                <div className="font-medium text-zinc-200">{competitorName(id)}</div>
                <div className="text-sm text-zinc-400">F9 {na.front9Totals[id] ?? 0} • B9 {na.back9Totals[id] ?? 0} • 18 {total}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (game.format === 'threePoint' && results.threePoint) {
    const tp = results.threePoint;
    const teamName = (id: string) => game.teams?.find((t) => t.id === id)?.name ?? id;

    const teamA = tp.teamAId;
    const teamB = tp.teamBId;

    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className={`${box} p-4`}>
            <div className="text-xs text-zinc-500">{teamName(teamA)}</div>
            <div className="text-3xl font-semibold text-zinc-100">{tp.totals[teamA] ?? 0}</div>
          </div>
          <div className={`${box} p-4`}>
            <div className="text-xs text-zinc-500">{teamName(teamB)}</div>
            <div className="text-3xl font-semibold text-zinc-100">{tp.totals[teamB] ?? 0}</div>
          </div>
        </div>

        <details className={`${boxSubtle} p-4`} open>
          <summary className="cursor-pointer text-sm text-zinc-300">Hole-by-hole points (running totals)</summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-zinc-500 border-b border-white/10">
                  <th className="py-2 text-left">Hole</th>
                  <th className="py-2 text-center">{teamName(teamA)}</th>
                  <th className="py-2 text-center">{teamName(teamB)}</th>
                  <th className="py-2 text-center">Running ({teamName(teamA)})</th>
                  <th className="py-2 text-center">Running ({teamName(teamB)})</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/6">
                {tp.holeDetails.map((h) => (
                  <tr key={h.holeNumber}>
                    <td className="py-2 text-zinc-300">{h.holeNumber}</td>
                    <td className="py-2 text-center text-zinc-300">{h.holeTotal.teamA}</td>
                    <td className="py-2 text-center text-zinc-300">{h.holeTotal.teamB}</td>
                    <td className="py-2 text-center text-zinc-300">{tp.runningTotalsByHole[teamA]?.[h.holeNumber - 1] ?? 0}</td>
                    <td className="py-2 text-center text-zinc-300">{tp.runningTotalsByHole[teamB]?.[h.holeNumber - 1] ?? 0}</td>
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
          {sorted.map((p) => (
            <div key={p.playerId} className={`${box} p-4 flex items-center justify-between`}>
              <div>
                <div className="font-semibold text-zinc-200">{playerName(p.playerId)}</div>
                <div className="text-xs text-zinc-500">Holes played: {p.holesPlayed}</div>
              </div>
              <div className="text-2xl font-semibold text-zinc-100">{p.total}</div>
            </div>
          ))}
        </div>
        {st.winnerPlayerId && <div className="text-xs text-emerald-300">Leader: {playerName(st.winnerPlayerId)}</div>}
      </div>
    );
  }

  if (game.format === 'matchPlay' && results.matchPlay) {
    const mp = results.matchPlay;
    return (
      <div className="space-y-3">
        <div className={`${box} p-4`}>
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-200">
              {playerName(mp.player1Id)} vs {playerName(mp.player2Id)}
            </div>
            <div className="text-2xl font-semibold text-zinc-100">{mp.currentStatus}</div>
          </div>
          {mp.endedAtHole && mp.winnerPlayerId && (
            <div className="text-xs text-emerald-300 mt-1">Winner: {playerName(mp.winnerPlayerId)} (ended on hole {mp.endedAtHole})</div>
          )}
        </div>

        <details className={`${boxSubtle} p-4`}>
          <summary className="cursor-pointer text-sm text-zinc-300">Hole-by-hole</summary>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
            {mp.holes.map((h) => (
              <div key={h.holeNumber} className="rounded-2xl bg-white/4 border border-white/10 p-3">
                <div className="text-zinc-500 text-xs">Hole {h.holeNumber}</div>
                <div className="font-medium text-zinc-200">{h.statusAfter}</div>
                <div className="text-xs text-zinc-500">
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
      <div className="space-y-3">
        <div className={`${box} p-4`}>
          <div className="text-sm font-semibold text-zinc-200 mb-2">Points</div>
          <div className="grid gap-2">
            {totalsSorted.map(([pid, pts]) => (
              <div key={pid} className="flex items-center justify-between rounded-2xl bg-white/3 border border-white/10 p-3">
                <div className="font-medium text-zinc-200">{playerName(pid)}</div>
                <div className="text-xl font-semibold text-zinc-100">{pts}</div>
              </div>
            ))}
          </div>
        </div>

        <details className={`${boxSubtle} p-4`} open>
          <summary className="cursor-pointer text-sm text-zinc-300">Hole-by-hole setup & results</summary>
          <div className="mt-3 space-y-2">
            {wolf.holes.map((h) => {
              const wolfPid = h.wolfPlayerId;
              const choice = (game.settings.wolfHoleChoices ?? {})[h.holeNumber] ?? null;
              const partnerValue = choice && choice.mode === 'partner' ? choice.partnerId : '';

              const partnerOptions = wolf.orderPlayerIds.filter((pid) => pid !== wolfPid);
              const otherPlayers = wolf.orderPlayerIds.filter((pid) => pid !== wolfPid && (!partnerValue || pid !== partnerValue));

              return (
                <div key={h.holeNumber} className="rounded-2xl bg-white/4 border border-white/10 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs text-zinc-500">Hole {h.holeNumber}</div>
                      <div className="font-semibold text-zinc-200">Wolf: {playerName(wolfPid)}</div>
                    </div>
                    <div className="text-xs text-zinc-400 text-right">
                      {Object.keys(h.pointsDelta).length
                        ? `Δ ${Object.entries(h.pointsDelta)
                            .map(([pid, d]) => `${playerName(pid)} ${d > 0 ? '+' : ''}${d}`)
                            .join(', ')}`
                        : '—'}
                    </div>
                  </div>

                  {!onUpdateGame && <div className="text-xs text-amber-200 mt-2">Editing disabled in this view.</div>}

                  {onUpdateGame && orderSet.size === 4 && (
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <button
                        onClick={() => updateChoice(h.holeNumber, { mode: 'lone' })}
                        className={`rounded-2xl py-2 px-3 border text-sm font-semibold transition-colors ${
                          choice?.mode === 'lone'
                            ? 'bg-emerald-500/10 border-emerald-400/25 text-emerald-100'
                            : 'bg-white/4 border-white/10 text-zinc-200 hover:bg-white/6'
                        }`}
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
                          className="flex-1 px-3 py-2 rounded-2xl bg-white/5 border border-white/10"
                        >
                          <option value="">Pick partner (2v2)</option>
                          {partnerOptions.map((pid) => (
                            <option key={pid} value={pid}>
                              {playerName(pid)}
                            </option>
                          ))}
                        </select>
                        <button onClick={() => clearChoice(h.holeNumber)} className="btn btn-secondary px-4 py-2">
                          Clear
                        </button>
                      </div>

                      {choice?.mode === 'partner' && partnerValue && (
                        <div className="sm:col-span-3 text-xs text-zinc-500">
                          Teams: ({playerName(wolfPid)} + {playerName(partnerValue)}) vs ({otherPlayers.map(playerName).join(' + ')}) • Best ball wins 1 pt each.
                        </div>
                      )}
                      {choice?.mode === 'lone' && (
                        <div className="sm:col-span-3 text-xs text-zinc-500">Lone Wolf: {playerName(wolfPid)} vs field • Win +3, lose -3.</div>
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

  return <div className={`${box} p-4 text-sm text-zinc-300`}>Results for this game format are not implemented yet.</div>;
}
