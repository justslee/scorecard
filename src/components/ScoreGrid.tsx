'use client';

import { Round, calculateTotals, getScoreClass } from '@/lib/types';
import { useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface ScoreGridProps {
  round: Round;
  onScoreChange: (playerId: string, holeNumber: number, strokes: number | null) => void;
  currentHole?: number;
  onHoleSelect?: (hole: number) => void;
}

export default function ScoreGrid({ round, onScoreChange, currentHole, onHoleSelect }: ScoreGridProps) {
  const [selectedCell, setSelectedCell] = useState<{ playerId: string; hole: number } | null>(null);

  const getScore = (playerId: string, holeNumber: number): number | null => {
    const score = round.scores.find((s) => s.playerId === playerId && s.holeNumber === holeNumber);
    return score?.strokes ?? null;
  };

  const handleCellClick = (playerId: string, hole: number) => {
    setSelectedCell({ playerId, hole });
    onHoleSelect?.(hole);
  };

  const submitScore = useCallback(
    (strokes: number | null) => {
      if (!selectedCell) return;

      const { playerId, hole } = selectedCell;

      onScoreChange(playerId, hole, strokes);

      const currentPlayerIndex = round.players.findIndex((p) => p.id === playerId);

      if (currentPlayerIndex < round.players.length - 1) {
        const nextPlayer = round.players[currentPlayerIndex + 1];
        setSelectedCell({ playerId: nextPlayer.id, hole });
      } else if (hole < 18) {
        const nextHole = hole + 1;
        setSelectedCell({ playerId: round.players[0].id, hole: nextHole });
        onHoleSelect?.(nextHole);
      } else {
        setSelectedCell(null);
      }
    },
    [selectedCell, round.players, onScoreChange, onHoleSelect]
  );

  const handleNumberPadClick = (num: number) => submitScore(num);
  const handleClearScore = () => submitScore(null);

  const holeHeaderCell = (holeNumber: number) => {
    const isCurrent = currentHole === holeNumber;
    return (
      <button
        key={holeNumber}
        type="button"
        onClick={() => onHoleSelect?.(holeNumber)}
        className={
          `min-w-[40px] w-full px-2 py-2 text-center text-xs font-medium transition-colors ` +
          (isCurrent
            ? 'text-emerald-200 bg-emerald-500/10'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5')
        }
      >
        {holeNumber}
      </button>
    );
  };

  const renderNine = (start: number, end: number, label: string) => {
    const holes = round.holes.slice(start - 1, end);
    const totalPar = holes.reduce((sum, h) => sum + h.par, 0);

    return (
      <div className="card p-3 sm:p-4 mb-4 overflow-hidden">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold tracking-tight">{label}</h3>
            <span className="text-xs text-zinc-500">Par {totalPar}</span>
          </div>
          <span className="text-xs text-zinc-500">Tap a cell to enter scores</span>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            {/* Header row */}
            <div className="grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch rounded-xl overflow-hidden border border-white/10 bg-white/3">
              <div className="px-3 py-2 text-xs font-medium text-zinc-400">{label}</div>
              {holes.map((h) => holeHeaderCell(h.number))}
              <div className="px-2 py-2 text-center text-xs font-semibold text-zinc-300">TOT</div>
            </div>

            {/* Par row */}
            <div className="grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch border-x border-b border-white/10 bg-white/2">
              <div className="px-3 py-2 text-xs text-zinc-500">Par</div>
              {holes.map((h) => (
                <div key={h.number} className="px-2 py-2 text-center text-xs text-zinc-400">
                  {h.par}
                </div>
              ))}
              <div className="px-2 py-2 text-center text-xs font-semibold text-zinc-300">{totalPar}</div>
            </div>

            {/* Players */}
            <div className="divide-y divide-white/6 border-x border-b border-white/10 rounded-b-xl overflow-hidden">
              {round.players.map((player) => {
                const totals = calculateTotals(round.scores, round.holes, player.id);
                const nineTotal = start === 1 ? totals.front9 : totals.back9;

                return (
                  <div
                    key={`${player.id}-${start}`}
                    className="grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch bg-white/0"
                  >
                    <div className="px-3 py-2 text-sm font-medium text-zinc-200 truncate">
                      {player.name}
                    </div>

                    {holes.map((hole) => {
                      const score = getScore(player.id, hole.number);
                      const isSelected = selectedCell?.playerId === player.id && selectedCell?.hole === hole.number;

                      const scoreStateClass =
                        score !== null
                          ? getScoreClass(score, hole.par)
                          : 'text-zinc-300';

                      return (
                        <button
                          key={`${player.id}-${hole.number}`}
                          type="button"
                          onClick={() => handleCellClick(player.id, hole.number)}
                          className={
                            `relative px-2 py-2 text-center transition-all duration-150 ` +
                            `hover:bg-white/5 active:scale-[0.99] ` +
                            (isSelected
                              ? 'bg-emerald-500/10 shadow-[0_0_0_1px_rgba(16,185,129,0.25),0_0_24px_rgba(16,185,129,0.18)]'
                              : '')
                          }
                        >
                          <span className={`text-[15px] font-semibold ${scoreStateClass}`}>{score ?? '–'}</span>
                          {isSelected ? <span className="absolute inset-x-2 bottom-1 h-[2px] rounded-full bg-emerald-400/70" /> : null}
                        </button>
                      );
                    })}

                    <div className="px-2 py-2 text-center text-sm font-semibold text-zinc-100 bg-white/3">
                      {nineTotal || '–'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      {renderNine(1, 9, 'Front 9')}
      {renderNine(10, 18, 'Back 9')}

      <div className="card p-4">
        <h3 className="text-sm font-semibold tracking-tight mb-3">Totals</h3>
        <div className="grid gap-2">
          {round.players.map((player) => {
            const totals = calculateTotals(round.scores, round.holes, player.id);
            return (
              <div
                key={player.id}
                className="flex justify-between items-center rounded-2xl px-4 py-3 bg-white/4 border border-white/10"
              >
                <span className="font-medium text-zinc-200">{player.name}</span>
                <div className="flex items-center gap-4 text-sm text-zinc-300">
                  <span className="text-zinc-400">F9: {totals.front9 || '–'}</span>
                  <span className="text-zinc-400">B9: {totals.back9 || '–'}</span>
                  <span
                    className={`font-semibold text-base ${
                      totals.toPar < 0 ? 'text-red-300' : totals.toPar > 0 ? 'text-sky-300' : 'text-emerald-300'
                    }`}
                  >
                    {totals.playedHoles > 0 ? totals.total : '–'} (
                    {totals.playedHoles === 0 ? '–' : totals.toPar === 0 ? 'E' : `${totals.toPar > 0 ? '+' : ''}${totals.toPar}`})
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <AnimatePresence>
        {selectedCell && (
          <motion.div
            key="numpad"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 18 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed bottom-0 left-0 right-0 z-50"
          >
            <div className="backdrop-blur-xl bg-zinc-950/70 border-t border-white/10">
              <div className="max-w-md mx-auto px-4 py-4">
                <p className="text-center text-sm text-zinc-400 mb-3">
                  <span className="font-semibold text-zinc-100">
                    {round.players.find((p) => p.id === selectedCell.playerId)?.name}
                  </span>
                  {' • '}Hole {selectedCell.hole}
                  {' • '}Par {round.holes[selectedCell.hole - 1]?.par}
                </p>

                <div className="grid grid-cols-4 gap-2">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((num) => (
                    <button
                      key={num}
                      onClick={() => handleNumberPadClick(num)}
                      className="btn rounded-2xl py-3 bg-white/6 hover:bg-white/10 border border-white/10 text-lg font-semibold active:scale-[0.97]"
                    >
                      {num}
                    </button>
                  ))}
                </div>

                <div className="flex gap-2 mt-3">
                  <button
                    onClick={handleClearScore}
                    className="btn flex-1 rounded-full py-3 bg-red-500/10 hover:bg-red-500/20 border border-red-400/20 text-red-200"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setSelectedCell(null)}
                    className="btn flex-1 btn-secondary"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
