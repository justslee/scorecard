'use client';

import { useMemo, useState } from 'react';
import { Game, Round } from '@/lib/types';
import AddGameModal from './AddGameModal';
import GameResults from './GameResults';

interface GamesPanelProps {
  round: Round;
  onUpdateRound: (next: Round) => void;
}

export default function GamesPanel({ round, onUpdateRound }: GamesPanelProps) {
  const games = round.games ?? [];
  const [showAdd, setShowAdd] = useState(false);
  const [activeGameId, setActiveGameId] = useState<string | null>(games[0]?.id ?? null);

  const activeGame = useMemo(() => games.find(g => g.id === activeGameId) ?? null, [games, activeGameId]);

  const handleAddGame = (game: Game) => {
    const next: Round = {
      ...round,
      games: [game, ...(round.games ?? [])],
    };
    onUpdateRound(next);
    setActiveGameId(game.id);
    setShowAdd(false);
  };

  const handleRemoveGame = (id: string) => {
    if (!confirm('Remove this game from the round?')) return;
    const nextGames = (round.games ?? []).filter(g => g.id !== id);
    const next: Round = { ...round, games: nextGames };
    onUpdateRound(next);
    if (activeGameId === id) setActiveGameId(nextGames[0]?.id ?? null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Games</h2>
        <button
          onClick={() => setShowAdd(true)}
          className="px-3 py-2 bg-green-600 hover:bg-green-700 rounded-lg font-semibold"
        >
          + Add Game
        </button>
      </div>

      {games.length === 0 ? (
        <div className="bg-gray-800 rounded-lg p-4 text-gray-300">
          <div className="font-semibold mb-1">No games yet</div>
          <div className="text-sm text-gray-400">Add Skins, Best Ball, or Nassau on top of this round.</div>
        </div>
      ) : (
        <div className="grid gap-3">
          {games.map(g => (
            <button
              key={g.id}
              onClick={() => setActiveGameId(g.id)}
              className={`text-left p-3 rounded-lg border transition-colors ${
                activeGameId === g.id ? 'bg-gray-800 border-green-600' : 'bg-gray-900 border-gray-700 hover:bg-gray-800'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">{g.name}</div>
                  <div className="text-xs text-gray-400">{g.format}</div>
                </div>
                <span
                  className="text-xs text-red-300 hover:text-red-200 px-2 py-1 rounded bg-red-900/30"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleRemoveGame(g.id);
                  }}
                >
                  Remove
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {activeGame && (
        <div className="bg-gray-900 border border-gray-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm text-gray-400">Selected game</div>
              <div className="text-xl font-bold">{activeGame.name}</div>
            </div>
          </div>
          <GameResults
            round={round}
            game={activeGame}
            onUpdateGame={(nextGame) => {
              const nextGames = (round.games ?? []).map(g => (g.id === nextGame.id ? nextGame : g));
              onUpdateRound({ ...round, games: nextGames });
            }}
          />
        </div>
      )}

      {showAdd && (
        <AddGameModal
          round={round}
          onClose={() => setShowAdd(false)}
          onAddGame={handleAddGame}
        />
      )}
    </div>
  );
}
