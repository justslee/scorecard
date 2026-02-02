'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Round, Player, calculateTotals, getScoreClass } from '@/lib/types';
import { computeGameResults } from '@/lib/games';
import { Trophy, DollarSign, ArrowRight, X, ChevronLeft, ChevronRight } from 'lucide-react';

interface RoundSummaryProps {
  round: Round;
  onClose: () => void;
}

interface Settlement {
  from: string;
  to: string;
  amount: number;
}

export default function RoundSummary({ round, onClose }: RoundSummaryProps) {
  const [selectedPlayer, setSelectedPlayer] = useState<Player | null>(null);
  const playerName = (id: string) => round.players.find((p) => p.id === id)?.name ?? '?';
  const games = round.games ?? [];

  // Calculate player totals
  const playerTotals = round.players.map((player) => {
    const totals = calculateTotals(round.scores, round.holes, player.id);
    return { player, totals };
  }).sort((a, b) => {
    if (a.totals.playedHoles === 0) return 1;
    if (b.totals.playedHoles === 0) return -1;
    return a.totals.total - b.totals.total;
  });

  // Calculate money owed per player from all games
  const moneyByPlayer: Record<string, number> = {};
  round.players.forEach((p) => { moneyByPlayer[p.id] = 0; });

  games.forEach((game) => {
    const betAmount = game.settings.pointValue ?? 0;
    if (betAmount <= 0) return;

    const results = computeGameResults(round, game);

    // Skins
    if (game.format === 'skins' && results.skins) {
      const totalSkins = results.skins.byPlayer.reduce((sum, p) => sum + p.skins, 0);
      const numPlayers = game.playerIds.length;
      
      results.skins.byPlayer.forEach((p) => {
        if (p.skins > 0) {
          const winnings = p.skins * betAmount;
          moneyByPlayer[p.playerId] = (moneyByPlayer[p.playerId] ?? 0) + winnings;
        }
      });
      
      if (totalSkins > 0) {
        const potTotal = totalSkins * betAmount;
        const perPlayerCost = potTotal / numPlayers;
        game.playerIds.forEach((pid) => {
          moneyByPlayer[pid] = (moneyByPlayer[pid] ?? 0) - perPlayerCost;
        });
      }
    }

    // Nassau
    if (game.format === 'nassau' && results.nassau) {
      const na = results.nassau;
      const competitors = na.scope === 'team' 
        ? (game.teams ?? []).map((t) => t.id)
        : game.playerIds;
      
      const numCompetitors = competitors.length;
      
      [na.front9WinnerId, na.back9WinnerId, na.overallWinnerId].forEach((winnerId) => {
        if (winnerId && numCompetitors > 1) {
          if (na.scope === 'team') {
            const team = game.teams?.find((t) => t.id === winnerId);
            if (team) {
              const perPlayer = betAmount / team.playerIds.length;
              team.playerIds.forEach((pid) => {
                moneyByPlayer[pid] = (moneyByPlayer[pid] ?? 0) + perPlayer * (numCompetitors - 1) / numCompetitors;
              });
              competitors.filter((c) => c !== winnerId).forEach((loserId) => {
                const loserTeam = game.teams?.find((t) => t.id === loserId);
                if (loserTeam) {
                  const perLoser = betAmount / loserTeam.playerIds.length / (numCompetitors - 1);
                  loserTeam.playerIds.forEach((pid) => {
                    moneyByPlayer[pid] = (moneyByPlayer[pid] ?? 0) - perLoser;
                  });
                }
              });
            }
          } else {
            moneyByPlayer[winnerId] = (moneyByPlayer[winnerId] ?? 0) + betAmount * (numCompetitors - 1) / numCompetitors;
            competitors.filter((c) => c !== winnerId).forEach((loserId) => {
              moneyByPlayer[loserId] = (moneyByPlayer[loserId] ?? 0) - betAmount / (numCompetitors - 1);
            });
          }
        }
      });
    }

    // Best Ball
    if (game.format === 'bestBall' && results.bestBall) {
      const bb = results.bestBall;
      if (bb.winnerTeamId && game.teams) {
        const winnerTeam = game.teams.find((t) => t.id === bb.winnerTeamId);
        const loserTeam = game.teams.find((t) => t.id !== bb.winnerTeamId);
        
        if (winnerTeam && loserTeam) {
          const perWinner = betAmount / winnerTeam.playerIds.length;
          const perLoser = betAmount / loserTeam.playerIds.length;
          
          winnerTeam.playerIds.forEach((pid) => {
            moneyByPlayer[pid] = (moneyByPlayer[pid] ?? 0) + perWinner;
          });
          loserTeam.playerIds.forEach((pid) => {
            moneyByPlayer[pid] = (moneyByPlayer[pid] ?? 0) - perLoser;
          });
        }
      }
    }

    // 3-Point
    if (game.format === 'threePoint' && results.threePoint) {
      const tp = results.threePoint;
      const diff = (tp.totals[tp.teamAId] ?? 0) - (tp.totals[tp.teamBId] ?? 0);
      
      if (diff !== 0 && game.teams) {
        const winnerTeamId = diff > 0 ? tp.teamAId : tp.teamBId;
        const loserTeamId = diff > 0 ? tp.teamBId : tp.teamAId;
        const pointDiff = Math.abs(diff);
        const totalAmount = pointDiff * betAmount;
        
        const winnerTeam = game.teams.find((t) => t.id === winnerTeamId);
        const loserTeam = game.teams.find((t) => t.id === loserTeamId);
        
        if (winnerTeam && loserTeam) {
          const perWinner = totalAmount / winnerTeam.playerIds.length;
          const perLoser = totalAmount / loserTeam.playerIds.length;
          
          winnerTeam.playerIds.forEach((pid) => {
            moneyByPlayer[pid] = (moneyByPlayer[pid] ?? 0) + perWinner;
          });
          loserTeam.playerIds.forEach((pid) => {
            moneyByPlayer[pid] = (moneyByPlayer[pid] ?? 0) - perLoser;
          });
        }
      }
    }

    // Match Play
    if (game.format === 'matchPlay' && results.matchPlay) {
      const mp = results.matchPlay;
      if (mp.winnerPlayerId) {
        const loserId = mp.winnerPlayerId === mp.player1Id ? mp.player2Id : mp.player1Id;
        moneyByPlayer[mp.winnerPlayerId] = (moneyByPlayer[mp.winnerPlayerId] ?? 0) + betAmount;
        moneyByPlayer[loserId] = (moneyByPlayer[loserId] ?? 0) - betAmount;
      }
    }

    // Wolf
    if (game.format === 'wolf' && results.wolf) {
      const wolf = results.wolf;
      Object.entries(wolf.totals).forEach(([pid, pts]) => {
        const amount = pts * betAmount;
        moneyByPlayer[pid] = (moneyByPlayer[pid] ?? 0) + amount;
      });
    }
  });

  const settlements = calculateSettlements(moneyByPlayer, playerName);

  // Player detail view
  if (selectedPlayer) {
    return (
      <PlayerDetailView
        round={round}
        player={selectedPlayer}
        moneyByPlayer={moneyByPlayer}
        onBack={() => setSelectedPlayer(null)}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/90 overflow-y-auto">
      <div className="min-h-screen p-4 sm:p-6">
        <div className="max-w-2xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white">Round Complete 🎉</h1>
              <p className="text-zinc-400">{round.courseName}</p>
            </div>
            <button
              onClick={onClose}
              className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center hover:bg-zinc-700"
            >
              <X className="w-5 h-5 text-zinc-400" />
            </button>
          </div>

          {/* Leaderboard */}
          <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-zinc-800 bg-amber-500/5">
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-amber-400" />
                <span className="font-semibold text-white">Final Leaderboard</span>
              </div>
              <p className="text-xs text-zinc-500 mt-1">Tap a player for detailed stats</p>
            </div>
            <div className="divide-y divide-zinc-800">
              {playerTotals.map(({ player, totals }, i) => (
                <motion.button
                  key={player.id}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setSelectedPlayer(player)}
                  className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors hover:bg-white/5 ${i === 0 ? 'bg-emerald-500/5' : ''}`}
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    i === 0 ? 'bg-amber-500 text-black' : 
                    i === 1 ? 'bg-zinc-400 text-black' :
                    i === 2 ? 'bg-amber-700 text-white' :
                    'bg-zinc-700 text-zinc-400'
                  }`}>
                    {i + 1}
                  </div>
                  <div className="flex-1">
                    <div className={`font-semibold ${i === 0 ? 'text-white' : 'text-zinc-300'}`}>
                      {player.name}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-xl font-bold ${
                      totals.toPar < 0 ? 'text-red-400' : 
                      totals.toPar > 0 ? 'text-sky-400' : 
                      'text-emerald-400'
                    }`}>
                      {totals.playedHoles > 0 ? totals.total : '–'}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {totals.playedHoles > 0 
                        ? (totals.toPar === 0 ? 'E' : `${totals.toPar > 0 ? '+' : ''}${totals.toPar}`)
                        : '–'
                      }
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-zinc-600" />
                </motion.button>
              ))}
            </div>
          </div>

          {/* Money Settlement */}
          {settlements.length > 0 && (
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
              <div className="px-4 py-3 border-b border-zinc-800 bg-emerald-500/5">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-5 h-5 text-emerald-400" />
                  <span className="font-semibold text-white">Settlement</span>
                </div>
                <p className="text-xs text-zinc-500 mt-1">Who owes who</p>
              </div>
              <div className="divide-y divide-zinc-800">
                {settlements.map((s, i) => (
                  <div key={i} className="px-4 py-3 flex items-center gap-3">
                    <span className="font-medium text-red-400">{s.from}</span>
                    <ArrowRight className="w-4 h-4 text-zinc-600" />
                    <span className="font-medium text-emerald-400">{s.to}</span>
                    <span className="ml-auto text-xl font-bold text-white">${s.amount.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Net Position */}
          {Object.values(moneyByPlayer).some((v) => v !== 0) && (
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
              <div className="px-4 py-3 border-b border-zinc-800">
                <span className="font-semibold text-white">Net Position</span>
              </div>
              <div className="divide-y divide-zinc-800">
                {Object.entries(moneyByPlayer)
                  .sort((a, b) => b[1] - a[1])
                  .map(([pid, amount]) => (
                    <div key={pid} className="px-4 py-3 flex items-center justify-between">
                      <span className="font-medium text-zinc-300">{playerName(pid)}</span>
                      <span className={`text-lg font-bold ${
                        amount > 0 ? 'text-emerald-400' : amount < 0 ? 'text-red-400' : 'text-zinc-500'
                      }`}>
                        {amount > 0 ? '+' : ''}${amount.toFixed(2)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* No bets message */}
          {settlements.length === 0 && (
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 text-center">
              <p className="text-zinc-400">No bets were placed this round</p>
              <p className="text-xs text-zinc-600 mt-1">Add bet amounts to games to track money</p>
            </div>
          )}

          {/* Close button */}
          <button
            onClick={onClose}
            className="w-full py-4 rounded-2xl bg-emerald-500 text-black font-semibold text-lg hover:bg-emerald-400 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Player Detail View Component
function PlayerDetailView({
  round,
  player,
  moneyByPlayer,
  onBack,
  onClose,
}: {
  round: Round;
  player: Player;
  moneyByPlayer: Record<string, number>;
  onBack: () => void;
  onClose: () => void;
}) {
  const totals = calculateTotals(round.scores, round.holes, player.id);
  const getScore = (holeNumber: number) => {
    const score = round.scores.find((s) => s.playerId === player.id && s.holeNumber === holeNumber);
    return score?.strokes ?? null;
  };

  // Count birdies, pars, bogeys, etc.
  let eagles = 0, birdies = 0, pars = 0, bogeys = 0, doubles = 0, others = 0;
  round.holes.forEach((hole) => {
    const score = getScore(hole.number);
    if (score === null) return;
    const diff = score - hole.par;
    if (diff <= -2) eagles++;
    else if (diff === -1) birdies++;
    else if (diff === 0) pars++;
    else if (diff === 1) bogeys++;
    else if (diff === 2) doubles++;
    else others++;
  });

  const netMoney = moneyByPlayer[player.id] ?? 0;

  return (
    <motion.div
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -50 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 bg-black/90 overflow-y-auto"
    >
      <div className="min-h-screen p-4 sm:p-6">
        <div className="max-w-2xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <button
                onClick={onBack}
                className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center hover:bg-zinc-700"
              >
                <ChevronLeft className="w-5 h-5 text-zinc-400" />
              </button>
              <div>
                <h1 className="text-2xl font-bold text-white">{player.name}</h1>
                <p className="text-zinc-400">{round.courseName}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center hover:bg-zinc-700"
            >
              <X className="w-5 h-5 text-zinc-400" />
            </button>
          </div>

          {/* Score Summary */}
          <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
            <div className="p-6 text-center">
              <div className={`text-5xl font-bold ${
                totals.toPar < 0 ? 'text-red-400' : 
                totals.toPar > 0 ? 'text-sky-400' : 
                'text-emerald-400'
              }`}>
                {totals.total || '–'}
              </div>
              <div className="text-lg text-zinc-400 mt-1">
                {totals.playedHoles > 0 
                  ? (totals.toPar === 0 ? 'Even' : `${totals.toPar > 0 ? '+' : ''}${totals.toPar}`)
                  : '–'
                }
              </div>
              <div className="flex justify-center gap-6 mt-4 text-sm">
                <div>
                  <div className="text-zinc-500">Front</div>
                  <div className="text-white font-semibold">{totals.front9 || '–'}</div>
                </div>
                <div>
                  <div className="text-zinc-500">Back</div>
                  <div className="text-white font-semibold">{totals.back9 || '–'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Score Distribution */}
          <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-zinc-800">
              <span className="font-semibold text-white">Score Breakdown</span>
            </div>
            <div className="p-4 grid grid-cols-3 sm:grid-cols-6 gap-3">
              {[
                { label: 'Eagles', count: eagles, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
                { label: 'Birdies', count: birdies, color: 'text-red-400', bg: 'bg-red-500/10' },
                { label: 'Pars', count: pars, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
                { label: 'Bogeys', count: bogeys, color: 'text-sky-400', bg: 'bg-sky-500/10' },
                { label: 'Doubles', count: doubles, color: 'text-blue-400', bg: 'bg-blue-500/10' },
                { label: 'Other', count: others, color: 'text-indigo-400', bg: 'bg-indigo-500/10' },
              ].map(({ label, count, color, bg }) => (
                <div key={label} className={`${bg} rounded-xl p-3 text-center`}>
                  <div className={`text-2xl font-bold ${color}`}>{count}</div>
                  <div className="text-xs text-zinc-500">{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Hole by Hole */}
          <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-zinc-800">
              <span className="font-semibold text-white">Hole by Hole</span>
            </div>
            
            {/* Front 9 */}
            <div className="p-4 border-b border-zinc-800">
              <div className="text-xs text-zinc-500 mb-2">Front 9</div>
              <div className="grid grid-cols-9 gap-1">
                {round.holes.slice(0, 9).map((hole) => {
                  const score = getScore(hole.number);
                  const diff = score !== null ? score - hole.par : 0;
                  return (
                    <div key={hole.number} className="text-center">
                      <div className="text-xs text-zinc-600">{hole.number}</div>
                      <div className="relative flex items-center justify-center">
                        {score !== null && diff <= -2 && (
                          <>
                            <span className="absolute w-7 h-7 rounded-full border-2 border-yellow-400" />
                            <span className="absolute w-5 h-5 rounded-full border-2 border-yellow-400" />
                          </>
                        )}
                        {score !== null && diff === -1 && (
                          <span className="absolute w-7 h-7 rounded-full border-2 border-red-400" />
                        )}
                        {score !== null && diff === 1 && (
                          <span className="absolute w-6 h-6 rounded-sm border-2 border-sky-400" />
                        )}
                        {score !== null && diff === 2 && (
                          <>
                            <span className="absolute w-7 h-7 rounded-sm border-2 border-blue-400" />
                            <span className="absolute w-5 h-5 rounded-sm border-2 border-blue-400" />
                          </>
                        )}
                        {score !== null && diff >= 3 && (
                          <span className="absolute w-7 h-7 rounded-sm border-2 border-indigo-400 bg-indigo-400/20" />
                        )}
                        <span className={`relative z-10 text-sm font-semibold py-1 ${score !== null ? getScoreClass(score, hole.par) : 'text-zinc-600'}`}>
                          {score ?? '–'}
                        </span>
                      </div>
                      <div className="text-xs text-zinc-700">{hole.par}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Back 9 */}
            <div className="p-4">
              <div className="text-xs text-zinc-500 mb-2">Back 9</div>
              <div className="grid grid-cols-9 gap-1">
                {round.holes.slice(9, 18).map((hole) => {
                  const score = getScore(hole.number);
                  const diff = score !== null ? score - hole.par : 0;
                  return (
                    <div key={hole.number} className="text-center">
                      <div className="text-xs text-zinc-600">{hole.number}</div>
                      <div className="relative flex items-center justify-center">
                        {score !== null && diff <= -2 && (
                          <>
                            <span className="absolute w-7 h-7 rounded-full border-2 border-yellow-400" />
                            <span className="absolute w-5 h-5 rounded-full border-2 border-yellow-400" />
                          </>
                        )}
                        {score !== null && diff === -1 && (
                          <span className="absolute w-7 h-7 rounded-full border-2 border-red-400" />
                        )}
                        {score !== null && diff === 1 && (
                          <span className="absolute w-6 h-6 rounded-sm border-2 border-sky-400" />
                        )}
                        {score !== null && diff === 2 && (
                          <>
                            <span className="absolute w-7 h-7 rounded-sm border-2 border-blue-400" />
                            <span className="absolute w-5 h-5 rounded-sm border-2 border-blue-400" />
                          </>
                        )}
                        {score !== null && diff >= 3 && (
                          <span className="absolute w-7 h-7 rounded-sm border-2 border-indigo-400 bg-indigo-400/20" />
                        )}
                        <span className={`relative z-10 text-sm font-semibold py-1 ${score !== null ? getScoreClass(score, hole.par) : 'text-zinc-600'}`}>
                          {score ?? '–'}
                        </span>
                      </div>
                      <div className="text-xs text-zinc-700">{hole.par}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Net Money */}
          {netMoney !== 0 && (
            <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
              <div className="p-6 text-center">
                <div className="text-zinc-500 text-sm mb-1">Net Money</div>
                <div className={`text-3xl font-bold ${netMoney > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {netMoney > 0 ? '+' : ''}${netMoney.toFixed(2)}
                </div>
              </div>
            </div>
          )}

          {/* Back button */}
          <button
            onClick={onBack}
            className="w-full py-4 rounded-2xl bg-zinc-800 text-white font-semibold text-lg hover:bg-zinc-700 transition-colors"
          >
            ← Back to Summary
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// Calculate simplified settlements (minimize transactions)
function calculateSettlements(
  balances: Record<string, number>,
  getName: (id: string) => string
): Settlement[] {
  const settlements: Settlement[] = [];
  
  const debtors: { id: string; amount: number }[] = [];
  const creditors: { id: string; amount: number }[] = [];
  
  Object.entries(balances).forEach(([id, amount]) => {
    const rounded = Math.round(amount * 100) / 100;
    if (rounded < -0.01) {
      debtors.push({ id, amount: Math.abs(rounded) });
    } else if (rounded > 0.01) {
      creditors.push({ id, amount: rounded });
    }
  });
  
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);
  
  let i = 0;
  let j = 0;
  
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    
    const amount = Math.min(debtor.amount, creditor.amount);
    
    if (amount > 0.01) {
      settlements.push({
        from: getName(debtor.id),
        to: getName(creditor.id),
        amount: Math.round(amount * 100) / 100,
      });
    }
    
    debtor.amount -= amount;
    creditor.amount -= amount;
    
    if (debtor.amount < 0.01) i++;
    if (creditor.amount < 0.01) j++;
  }
  
  return settlements;
}
