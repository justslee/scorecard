'use client';

import { Round, Score, HoleInfo, calculateTotals, getScoreClass } from '@/lib/types';
import { useState } from 'react';

interface ScoreGridProps {
  round: Round;
  onScoreChange: (playerId: string, holeNumber: number, strokes: number | null) => void;
  currentHole?: number;
  onHoleSelect?: (hole: number) => void;
}

export default function ScoreGrid({ round, onScoreChange, currentHole, onHoleSelect }: ScoreGridProps) {
  const [selectedCell, setSelectedCell] = useState<{ playerId: string; hole: number } | null>(null);

  const getScore = (playerId: string, holeNumber: number): number | null => {
    const score = round.scores.find(
      s => s.playerId === playerId && s.holeNumber === holeNumber
    );
    return score?.strokes ?? null;
  };

  const handleCellClick = (playerId: string, hole: number) => {
    setSelectedCell({ playerId, hole });
    onHoleSelect?.(hole);
  };

  const handleScoreInput = (value: string) => {
    if (!selectedCell) return;
    
    const strokes = value === '' ? null : parseInt(value);
    if (value !== '' && (isNaN(strokes!) || strokes! < 1 || strokes! > 15)) return;
    
    onScoreChange(selectedCell.playerId, selectedCell.hole, strokes);
    
    // Auto-advance to next cell
    const currentPlayerIndex = round.players.findIndex(p => p.id === selectedCell.playerId);
    if (currentPlayerIndex < round.players.length - 1) {
      // Move to next player same hole
      setSelectedCell({
        playerId: round.players[currentPlayerIndex + 1].id,
        hole: selectedCell.hole,
      });
    } else if (selectedCell.hole < 18) {
      // Move to first player next hole
      setSelectedCell({
        playerId: round.players[0].id,
        hole: selectedCell.hole + 1,
      });
      onHoleSelect?.(selectedCell.hole + 1);
    }
  };

  const renderHoleHeader = (start: number, end: number, label: string) => (
    <tr className="bg-gray-800 text-white text-xs">
      <td className="p-2 font-bold sticky left-0 bg-gray-800 z-10">{label}</td>
      {round.holes.slice(start - 1, end).map(hole => (
        <td
          key={hole.number}
          className={`p-2 text-center min-w-[40px] cursor-pointer hover:bg-gray-700 ${
            currentHole === hole.number ? 'bg-green-700' : ''
          }`}
          onClick={() => onHoleSelect?.(hole.number)}
        >
          {hole.number}
        </td>
      ))}
      <td className="p-2 text-center font-bold bg-gray-900">TOT</td>
    </tr>
  );

  const renderParRow = (start: number, end: number) => {
    const holes = round.holes.slice(start - 1, end);
    const totalPar = holes.reduce((sum, h) => sum + h.par, 0);
    return (
      <tr className="bg-gray-700 text-gray-300 text-xs">
        <td className="p-2 sticky left-0 bg-gray-700 z-10">Par</td>
        {holes.map(hole => (
          <td key={hole.number} className="p-2 text-center">{hole.par}</td>
        ))}
        <td className="p-2 text-center font-bold bg-gray-800">{totalPar}</td>
      </tr>
    );
  };

  const renderPlayerRow = (player: typeof round.players[0], start: number, end: number) => {
    const holes = round.holes.slice(start - 1, end);
    const totals = calculateTotals(round.scores, round.holes, player.id);
    const nineTotal = start === 1 ? totals.front9 : totals.back9;

    return (
      <tr key={`${player.id}-${start}`} className="border-b border-gray-700">
        <td className="p-2 font-medium truncate max-w-[80px] sticky left-0 bg-gray-900 z-10">
          {player.name}
        </td>
        {holes.map(hole => {
          const score = getScore(player.id, hole.number);
          const isSelected = selectedCell?.playerId === player.id && selectedCell?.hole === hole.number;
          
          return (
            <td
              key={hole.number}
              className={`p-1 text-center cursor-pointer transition-all ${
                isSelected
                  ? 'ring-2 ring-yellow-400 bg-yellow-900'
                  : score !== null
                    ? getScoreClass(score, hole.par)
                    : 'hover:bg-gray-700'
              }`}
              onClick={() => handleCellClick(player.id, hole.number)}
            >
              {isSelected ? (
                <input
                  type="number"
                  min="1"
                  max="15"
                  autoFocus
                  className="w-full bg-transparent text-center outline-none text-lg font-bold"
                  value={score ?? ''}
                  onChange={(e) => handleScoreInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setSelectedCell(null);
                    if (e.key >= '1' && e.key <= '9') {
                      handleScoreInput(e.key);
                    }
                  }}
                />
              ) : (
                <span className="text-lg font-bold">{score ?? '-'}</span>
              )}
            </td>
          );
        })}
        <td className="p-2 text-center font-bold bg-gray-800 text-lg">
          {nineTotal || '-'}
        </td>
      </tr>
    );
  };

  return (
    <div className="overflow-x-auto">
      {/* Front 9 */}
      <table className="w-full text-sm border-collapse mb-4">
        <thead>
          {renderHoleHeader(1, 9, 'Front 9')}
          {renderParRow(1, 9)}
        </thead>
        <tbody>
          {round.players.map(player => renderPlayerRow(player, 1, 9))}
        </tbody>
      </table>

      {/* Back 9 */}
      <table className="w-full text-sm border-collapse mb-4">
        <thead>
          {renderHoleHeader(10, 18, 'Back 9')}
          {renderParRow(10, 18)}
        </thead>
        <tbody>
          {round.players.map(player => renderPlayerRow(player, 10, 18))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-bold mb-3">Totals</h3>
        <div className="grid gap-2">
          {round.players.map(player => {
            const totals = calculateTotals(round.scores, round.holes, player.id);
            return (
              <div key={player.id} className="flex justify-between items-center bg-gray-700 rounded p-2">
                <span className="font-medium">{player.name}</span>
                <div className="flex gap-4 text-sm">
                  <span>F9: {totals.front9 || '-'}</span>
                  <span>B9: {totals.back9 || '-'}</span>
                  <span className={`font-bold text-lg ${
                    totals.toPar < 0 ? 'text-red-400' : totals.toPar > 0 ? 'text-blue-400' : 'text-green-400'
                  }`}>
                    {totals.total || '-'} ({totals.toPar >= 0 ? '+' : ''}{totals.toPar || 'E'})
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Input Pad */}
      {selectedCell && (
        <div className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 p-4 z-50">
          <div className="max-w-md mx-auto">
            <p className="text-center text-sm text-gray-400 mb-2">
              {round.players.find(p => p.id === selectedCell.playerId)?.name} - Hole {selectedCell.hole}
            </p>
            <div className="grid grid-cols-6 gap-2">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(num => (
                <button
                  key={num}
                  onClick={() => handleScoreInput(num.toString())}
                  className="p-3 bg-gray-700 rounded-lg text-xl font-bold hover:bg-gray-600 active:bg-gray-500"
                >
                  {num}
                </button>
              ))}
            </div>
            <button
              onClick={() => setSelectedCell(null)}
              className="w-full mt-2 p-2 bg-gray-700 rounded text-sm"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
