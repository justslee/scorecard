'use client';

import { useState } from 'react';
import { Tournament, Round, Game, GameFormat } from '@/lib/types';
import { saveTournament } from '@/lib/storage';
import { Plus, Trophy, X, ChevronRight, Users, DollarSign } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

interface TournamentGamesPanelProps {
  tournament: Tournament;
  rounds: Round[];
  onUpdate: () => void;
}

const GAME_OPTIONS: { format: GameFormat; name: string; description: string }[] = [
  { format: 'skins', name: 'Skins', description: 'Win the hole outright to take the skin' },
  { format: 'nassau', name: 'Nassau', description: 'Three bets: front 9, back 9, overall' },
  { format: 'stableford', name: 'Stableford', description: 'Points based on score relative to par' },
  { format: 'matchPlay', name: 'Match Play', description: 'Head-to-head hole-by-hole competition' },
];

export default function TournamentGamesPanel({ tournament, rounds, onUpdate }: TournamentGamesPanelProps) {
  const [showAddGame, setShowAddGame] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState<GameFormat | null>(null);
  const [gameName, setGameName] = useState('');
  const [pointValue, setPointValue] = useState(5);
  const [handicapped, setHandicapped] = useState(false);
  const [carryover, setCarryover] = useState(true);

  const games = tournament.games || [];

  const handleAddGame = () => {
    if (!selectedFormat) return;

    const newGame: Game = {
      id: crypto.randomUUID(),
      roundId: tournament.id, // Using tournament ID as a placeholder
      format: selectedFormat,
      name: gameName || GAME_OPTIONS.find(g => g.format === selectedFormat)?.name || selectedFormat,
      playerIds: tournament.playerIds,
      settings: {
        pointValue,
        handicapped,
        carryover: selectedFormat === 'skins' ? carryover : undefined,
      },
    };

    const updatedTournament = {
      ...tournament,
      games: [...games, newGame],
    };

    saveTournament(updatedTournament);
    onUpdate();
    resetForm();
  };

  const handleRemoveGame = (gameId: string) => {
    const updatedTournament = {
      ...tournament,
      games: games.filter(g => g.id !== gameId),
    };
    saveTournament(updatedTournament);
    onUpdate();
  };

  const resetForm = () => {
    setShowAddGame(false);
    setSelectedFormat(null);
    setGameName('');
    setPointValue(5);
    setHandicapped(false);
    setCarryover(true);
  };

  // Calculate game standings across all rounds
  const calculateGameStandings = (game: Game) => {
    const standings: Record<string, number> = {};
    
    // Initialize all players
    tournament.playerIds.forEach(pid => {
      standings[pid] = 0;
    });

    if (game.format === 'skins') {
      // Calculate skins across all rounds
      rounds.forEach(round => {
        for (let hole = 1; hole <= 18; hole++) {
          const holeScores: { playerId: string; score: number }[] = [];
          
          round.players.forEach(player => {
            if (!tournament.playerIds.includes(player.id)) return;
            const score = round.scores.find(s => s.playerId === player.id && s.holeNumber === hole);
            if (score?.strokes) {
              holeScores.push({ playerId: player.id, score: score.strokes });
            }
          });

          if (holeScores.length > 0) {
            const minScore = Math.min(...holeScores.map(s => s.score));
            const winners = holeScores.filter(s => s.score === minScore);
            
            if (winners.length === 1) {
              standings[winners[0].playerId] += game.settings.pointValue || 1;
            }
          }
        }
      });
    } else if (game.format === 'stableford') {
      // Calculate stableford points
      rounds.forEach(round => {
        round.players.forEach(player => {
          if (!tournament.playerIds.includes(player.id)) return;
          
          round.holes.forEach(hole => {
            const score = round.scores.find(s => s.playerId === player.id && s.holeNumber === hole.number);
            if (score?.strokes) {
              const diff = score.strokes - hole.par;
              let points = 0;
              if (diff <= -2) points = 4; // Eagle or better
              else if (diff === -1) points = 3; // Birdie
              else if (diff === 0) points = 2; // Par
              else if (diff === 1) points = 1; // Bogey
              // Double bogey or worse = 0
              
              standings[player.id] += points;
            }
          });
        });
      });
    }

    // Convert to sorted array
    return Object.entries(standings)
      .map(([playerId, score]) => ({
        playerId,
        name: tournament.playerNamesById?.[playerId] || 'Player',
        score,
      }))
      .sort((a, b) => b.score - a.score);
  };

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-400 tracking-wide uppercase">Games</h2>
          <p className="text-lg font-semibold tracking-tight">Side bets & competitions</p>
        </div>
        <button 
          onClick={() => setShowAddGame(true)}
          className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-1"
        >
          <Plus className="w-4 h-4" />
          Add Game
        </button>
      </div>

      {/* Add Game Form */}
      <AnimatePresence>
        {showAddGame && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-4 overflow-hidden"
          >
            <div className="border border-white/10 rounded-xl p-4 bg-white/2">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium">New Game</span>
                <button onClick={resetForm} className="p-1 rounded hover:bg-white/5">
                  <X className="w-4 h-4 text-zinc-400" />
                </button>
              </div>

              {/* Game Type Selection */}
              {!selectedFormat ? (
                <div className="grid grid-cols-2 gap-2">
                  {GAME_OPTIONS.map(opt => (
                    <button
                      key={opt.format}
                      onClick={() => {
                        setSelectedFormat(opt.format);
                        setGameName(opt.name);
                      }}
                      className="p-3 rounded-xl border border-white/10 bg-white/2 hover:bg-white/5 text-left"
                    >
                      <div className="text-sm font-medium text-zinc-200">{opt.name}</div>
                      <div className="text-xs text-zinc-500">{opt.description}</div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-zinc-400 block mb-1">Game Name</label>
                    <input
                      type="text"
                      value={gameName}
                      onChange={(e) => setGameName(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm"
                      placeholder="e.g., $5 Skins"
                    />
                  </div>

                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-xs text-zinc-400 block mb-1">Point Value</label>
                      <div className="flex items-center gap-2">
                        <DollarSign className="w-4 h-4 text-zinc-500" />
                        <input
                          type="number"
                          value={pointValue}
                          onChange={(e) => setPointValue(parseInt(e.target.value) || 0)}
                          className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={handicapped}
                        onChange={(e) => setHandicapped(e.target.checked)}
                        className="rounded border-white/20"
                      />
                      <span className="text-zinc-300">Use handicaps</span>
                    </label>

                    {selectedFormat === 'skins' && (
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={carryover}
                          onChange={(e) => setCarryover(e.target.checked)}
                          className="rounded border-white/20"
                        />
                        <span className="text-zinc-300">Carryover ties</span>
                      </label>
                    )}
                  </div>

                  <div className="flex gap-2 pt-2">
                    <button onClick={resetForm} className="btn btn-secondary flex-1">
                      Cancel
                    </button>
                    <button onClick={handleAddGame} className="btn btn-primary flex-1">
                      Add Game
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Games List */}
      {games.length === 0 && !showAddGame ? (
        <div className="text-center py-8 text-zinc-400">
          <Trophy className="w-10 h-10 mx-auto mb-2 text-zinc-600" />
          <div className="text-zinc-300 font-medium">No games yet</div>
          <div className="text-sm text-zinc-500 mt-1">Add skins, nassau, or other side games</div>
        </div>
      ) : (
        <div className="space-y-3">
          {games.map(game => {
            const standings = calculateGameStandings(game);
            const leader = standings[0];
            
            return (
              <div key={game.id} className="border border-white/10 rounded-xl p-4 bg-white/2">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="font-medium text-zinc-200">{game.name}</div>
                    <div className="text-xs text-zinc-500 flex items-center gap-2">
                      <span className="capitalize">{game.format}</span>
                      {game.settings.pointValue && (
                        <span>• ${game.settings.pointValue}/point</span>
                      )}
                      {game.settings.handicapped && (
                        <span>• Handicapped</span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemoveGame(game.id)}
                    className="p-1 rounded hover:bg-white/5 text-zinc-500 hover:text-red-400"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Mini Leaderboard */}
                {standings.length > 0 && leader.score > 0 && (
                  <div className="space-y-1">
                    {standings.slice(0, 3).map((player, idx) => (
                      <div 
                        key={player.playerId}
                        className={`flex items-center justify-between px-2 py-1 rounded ${
                          idx === 0 ? 'bg-amber-500/10' : 'bg-white/2'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium ${
                            idx === 0 ? 'text-amber-400' : 'text-zinc-500'
                          }`}>
                            {idx + 1}
                          </span>
                          <span className="text-sm text-zinc-200">{player.name}</span>
                        </div>
                        <span className={`text-sm font-medium ${
                          idx === 0 ? 'text-amber-300' : 'text-zinc-400'
                        }`}>
                          {player.score} {game.format === 'skins' ? 'skins' : 'pts'}
                        </span>
                      </div>
                    ))}
                    {standings.length > 3 && (
                      <div className="text-xs text-zinc-500 text-center pt-1">
                        +{standings.length - 3} more players
                      </div>
                    )}
                  </div>
                )}

                {standings.length > 0 && leader.score === 0 && (
                  <div className="text-xs text-zinc-500 text-center py-2">
                    No scores yet — play some holes!
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
