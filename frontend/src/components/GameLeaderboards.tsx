'use client';

import { Round, Game } from '@/lib/types';
import { computeGameResults } from '@/lib/games';
import { Trophy } from 'lucide-react';

interface GameLeaderboardsProps {
  round: Round;
}

export default function GameLeaderboards({ round }: GameLeaderboardsProps) {
  const games = round.games ?? [];
  
  if (games.length === 0) return null;

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center gap-2">
        <Trophy className="w-5 h-5 text-amber-400" />
        <h3 className="text-base font-semibold text-white">Leaderboards</h3>
      </div>
      <div className="space-y-4">
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
      <div className="rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50 overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-zinc-700/50 bg-amber-500/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-white">{game.name}</span>
              {betAmount > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                  ${betAmount}/skin
                </span>
              )}
            </div>
          </div>
          {potSize > 1 && (
            <div className="text-xs text-amber-400 mt-1">
              🔥 {potSize} skins in the pot{betAmount > 0 ? ` ($${potSize * betAmount})` : ''}
            </div>
          )}
        </div>

        {/* Leaderboard */}
        <div className="divide-y divide-zinc-800/50">
          {sorted.map((p, i) => {
            const winnings = betAmount > 0 ? p.skins * betAmount : 0;
            return (
              <div 
                key={p.playerId} 
                className={`px-4 py-3 flex items-center gap-3 ${i === 0 && p.skins > 0 ? 'bg-emerald-500/5' : ''}`}
              >
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
                  i === 0 && p.skins > 0 ? 'bg-amber-500 text-black' : 
                  i === 1 && p.skins > 0 ? 'bg-zinc-400 text-black' :
                  i === 2 && p.skins > 0 ? 'bg-amber-700 text-white' :
                  'bg-zinc-700 text-zinc-400'
                }`}>
                  {i + 1}
                </div>
                <div className="flex-1">
                  <div className={`font-semibold ${i === 0 && p.skins > 0 ? 'text-white' : 'text-zinc-300'}`}>
                    {playerName(p.playerId)}
                  </div>
                  {p.holesWon.length > 0 && (
                    <div className="text-xs text-zinc-500">
                      Holes: {[...new Set(p.holesWon)].join(', ')}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className={`text-xl font-bold ${i === 0 && p.skins > 0 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                    {p.skins}
                  </div>
                  {winnings > 0 && (
                    <div className="text-xs text-emerald-400">${winnings}</div>
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
    const getName = (id: string | null) => {
      if (!id) return 'Tied';
      return na.scope === 'team' ? teamName(id) : playerName(id);
    };

    const totalsEntries = Object.entries(na.overallTotals).sort((a, b) => a[1] - b[1]);

    return (
      <div className="rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-700/50 bg-emerald-500/5">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-white">{game.name}</span>
            {betAmount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                ${betAmount}/bet
              </span>
            )}
          </div>
        </div>

        {/* Winners */}
        <div className="px-4 py-3 grid grid-cols-3 gap-2">
          {[
            { label: 'Front 9', winner: na.front9WinnerId },
            { label: 'Back 9', winner: na.back9WinnerId },
            { label: 'Overall', winner: na.overallWinnerId },
          ].map((seg) => (
            <div key={seg.label} className="text-center p-2 rounded-xl bg-zinc-800/50">
              <div className="text-xs text-zinc-500 mb-1">{seg.label}</div>
              <div className={`text-sm font-bold truncate ${seg.winner ? 'text-emerald-400' : 'text-zinc-500'}`}>
                {getName(seg.winner)}
              </div>
              {betAmount > 0 && seg.winner && (
                <div className="text-xs text-emerald-400">${betAmount}</div>
              )}
            </div>
          ))}
        </div>

        {/* Totals */}
        <div className="divide-y divide-zinc-800/50 border-t border-zinc-700/50">
          {totalsEntries.map(([id, total], i) => (
            <div 
              key={id} 
              className={`px-4 py-2 flex items-center gap-3 ${i === 0 ? 'bg-emerald-500/5' : ''}`}
            >
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                i === 0 ? 'bg-amber-500 text-black' : 'bg-zinc-700 text-zinc-400'
              }`}>
                {i + 1}
              </div>
              <div className="flex-1 font-medium text-zinc-300">
                {na.scope === 'team' ? teamName(id) : playerName(id)}
              </div>
              <div className="text-sm text-zinc-400">
                {na.front9Totals[id]}/{na.back9Totals[id]}/{total}
              </div>
            </div>
          ))}
        </div>
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
      <div className="rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-700/50 bg-sky-500/5">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-white">{game.name}</span>
            {betAmount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                ${betAmount}
              </span>
            )}
          </div>
        </div>

        <div className="divide-y divide-zinc-800/50">
          {sorted.map((t, i) => {
            const team = game.teams?.find(tm => tm.id === t.teamId);
            const names = team?.playerIds.map(playerName).join(' & ') ?? teamName(t.teamId);
            return (
              <div 
                key={t.teamId} 
                className={`px-4 py-3 flex items-center gap-3 ${i === 0 && t.holesPlayed > 0 ? 'bg-emerald-500/5' : ''}`}
              >
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
                  i === 0 && t.holesPlayed > 0 ? 'bg-amber-500 text-black' : 'bg-zinc-700 text-zinc-400'
                }`}>
                  {i + 1}
                </div>
                <div className="flex-1 font-semibold text-zinc-300">{names}</div>
                <div className={`text-xl font-bold ${i === 0 && t.holesPlayed > 0 ? 'text-emerald-400' : 'text-zinc-400'}`}>
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
      <div className="rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-700/50 bg-purple-500/5">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-white">{game.name}</span>
            {betAmount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                ${betAmount}/pt
              </span>
            )}
          </div>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-center gap-8">
            <div className="text-center">
              <div className={`text-4xl font-bold ${teamAPoints > teamBPoints ? 'text-emerald-400' : 'text-zinc-400'}`}>
                {teamAPoints}
              </div>
              <div className="text-sm text-zinc-400 mt-1">{teamAName}</div>
            </div>
            <div className="text-2xl text-zinc-600">vs</div>
            <div className="text-center">
              <div className={`text-4xl font-bold ${teamBPoints > teamAPoints ? 'text-emerald-400' : 'text-zinc-400'}`}>
                {teamBPoints}
              </div>
              <div className="text-sm text-zinc-400 mt-1">{teamBName}</div>
            </div>
          </div>
          {betAmount > 0 && pointDiff > 0 && (
            <div className="text-center mt-3 text-sm text-emerald-400">
              {teamAPoints > teamBPoints ? teamAName : teamBName} up ${pointDiff * betAmount}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Stableford
  if ((game.format === 'stableford' || game.format === 'modifiedStableford') && results.stableford) {
    const st = results.stableford;
    const sorted = [...st.pointsByPlayer].sort((a, b) => b.total - a.total);

    return (
      <div className="rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-700/50 bg-orange-500/5">
          <span className="text-base font-bold text-white">{game.name}</span>
        </div>

        <div className="divide-y divide-zinc-800/50">
          {sorted.map((p, i) => (
            <div 
              key={p.playerId} 
              className={`px-4 py-3 flex items-center gap-3 ${i === 0 ? 'bg-emerald-500/5' : ''}`}
            >
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
                i === 0 ? 'bg-amber-500 text-black' : 
                i === 1 ? 'bg-zinc-400 text-black' :
                i === 2 ? 'bg-amber-700 text-white' :
                'bg-zinc-700 text-zinc-400'
              }`}>
                {i + 1}
              </div>
              <div className="flex-1 font-semibold text-zinc-300">{playerName(p.playerId)}</div>
              <div className={`text-xl font-bold ${i === 0 ? 'text-emerald-400' : 'text-zinc-400'}`}>
                {p.total} pts
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Match Play
  if (game.format === 'matchPlay' && results.matchPlay) {
    const mp = results.matchPlay;
    const p1Leading = mp.holes[mp.holes.length - 1]?.matchDiffAfter > 0;
    const p2Leading = mp.holes[mp.holes.length - 1]?.matchDiffAfter < 0;
    
    return (
      <div className="rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-700/50 bg-red-500/5">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-white">{game.name}</span>
            {betAmount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                ${betAmount}
              </span>
            )}
          </div>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between">
            <div className={`text-lg font-semibold ${p1Leading ? 'text-emerald-400' : 'text-zinc-300'}`}>
              {playerName(mp.player1Id)}
            </div>
            <div className="text-2xl font-bold text-white px-4">{mp.currentStatus}</div>
            <div className={`text-lg font-semibold ${p2Leading ? 'text-emerald-400' : 'text-zinc-300'}`}>
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
      <div className="rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-700/50 bg-yellow-500/5">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-white">{game.name}</span>
            {betAmount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                ${betAmount}/pt
              </span>
            )}
          </div>
        </div>

        <div className="divide-y divide-zinc-800/50">
          {sorted.map(([pid, pts], i) => {
            const winnings = betAmount > 0 ? pts * betAmount : 0;
            return (
              <div 
                key={pid} 
                className={`px-4 py-3 flex items-center gap-3 ${i === 0 && pts > 0 ? 'bg-emerald-500/5' : ''}`}
              >
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
                  i === 0 && pts > 0 ? 'bg-amber-500 text-black' : 'bg-zinc-700 text-zinc-400'
                }`}>
                  {i + 1}
                </div>
                <div className="flex-1 font-semibold text-zinc-300">{playerName(pid)}</div>
                <div className="text-right">
                  <div className={`text-xl font-bold ${pts > 0 ? 'text-emerald-400' : pts < 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                    {pts > 0 ? '+' : ''}{pts}
                  </div>
                  {winnings !== 0 && (
                    <div className={`text-xs ${winnings > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
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
    <div className="rounded-2xl bg-gradient-to-b from-zinc-800/80 to-zinc-900/80 border border-zinc-700/50 p-4">
      <div className="flex items-center gap-2">
        <span className="text-base font-bold text-white">{game.name}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-600/50 text-zinc-400">{game.format}</span>
      </div>
      <div className="text-sm text-zinc-500 mt-2">Leaderboard updates as you enter scores</div>
    </div>
  );
}
