'use client';

import { useMemo, useState } from 'react';
import { Game, Round } from '@/lib/types';
import AddGameModal from './AddGameModal';
import GameResults from './GameResults';
import VoiceGameSetup from './VoiceGameSetup';
import { AnimatePresence, motion } from 'framer-motion';
import { Mic } from 'lucide-react';

interface GamesPanelProps {
  round: Round;
  onUpdateRound: (next: Round) => void;
}

export default function GamesPanel({ round, onUpdateRound }: GamesPanelProps) {
  const games = useMemo(() => round.games ?? [], [round.games]);
  const [showAdd, setShowAdd] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [activeGameId, setActiveGameId] = useState<string | null>(() => (round.games ?? [])[0]?.id ?? null);

  const activeGame = useMemo(() => games.find((g) => g.id === activeGameId) ?? null, [games, activeGameId]);

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
    const nextGames = (round.games ?? []).filter((g) => g.id !== id);
    const next: Round = { ...round, games: nextGames };
    onUpdateRound(next);
    if (activeGameId === id) setActiveGameId(nextGames[0]?.id ?? null);
  };

  const handleVoiceGame = (gameConfig: Omit<Game, 'id' | 'roundId'>) => {
    const game: Game = {
      ...gameConfig,
      id: crypto.randomUUID(),
      roundId: round.id,
    };
    handleAddGame(game);
    setShowVoice(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Games</h2>
          <p className="text-sm text-zinc-400">Add side bets and formats on top of the round.</p>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => setShowVoice(true)} 
            className="btn btn-secondary flex items-center gap-2"
            title="Voice setup"
          >
            <Mic className="h-4 w-4" />
            <span className="hidden sm:inline">Voice</span>
          </button>
          <button onClick={() => setShowAdd(true)} className="btn btn-primary">
            + Add Game
          </button>
        </div>
      </div>

      {games.length === 0 ? (
        <div className="card p-5">
          <div className="font-semibold text-zinc-200 mb-1">No games yet</div>
          <div className="text-sm text-zinc-400">Add Skins, Best Ball, or Nassau.</div>
        </div>
      ) : (
        <div className="grid gap-3">
          {games.map((g) => (
            <button
              key={g.id}
              onClick={() => setActiveGameId(g.id)}
              className={`text-left p-4 rounded-2xl border transition-all duration-150 ${
                activeGameId === g.id
                  ? 'bg-emerald-500/10 border-emerald-400/25 shadow-[0_0_24px_rgba(16,185,129,0.12)]'
                  : 'bg-white/3 border-white/10 hover:bg-white/5'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-zinc-200">{g.name}</div>
                  <div className="text-xs text-zinc-500 uppercase tracking-wide">{g.format}</div>
                </div>
                <span
                  className="text-xs text-red-200 hover:text-red-100 px-3 py-1 rounded-full bg-red-500/10 border border-red-400/20"
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
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-xs font-medium text-zinc-400 tracking-wide uppercase">Selected</div>
              <div className="text-lg font-semibold tracking-tight">{activeGame.name}</div>
            </div>
          </div>
          <GameResults
            round={round}
            game={activeGame}
            onUpdateGame={(nextGame) => {
              const nextGames = (round.games ?? []).map((g) => (g.id === nextGame.id ? nextGame : g));
              onUpdateRound({ ...round, games: nextGames });
            }}
          />
        </div>
      )}

      <AnimatePresence>
        {showAdd && (
          <motion.div key="add-game" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            <AddGameModal round={round} onClose={() => setShowAdd(false)} onAddGame={handleAddGame} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showVoice && (
          <motion.div key="voice-game" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            <VoiceGameSetup 
              players={round.players} 
              onCreateGame={handleVoiceGame} 
              onClose={() => setShowVoice(false)} 
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
