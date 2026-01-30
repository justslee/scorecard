'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Round, Score } from '@/lib/types';
import { getRound, saveRound } from '@/lib/storage';
import { parseScorecard, ocrResultToScores } from '@/lib/ocr';
import ScoreGrid from '@/components/ScoreGrid';
import CameraCapture from '@/components/CameraCapture';

export default function RoundPage() {
  const params = useParams();
  const router = useRouter();
  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCamera, setShowCamera] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [currentHole, setCurrentHole] = useState(1);

  useEffect(() => {
    const id = params.id as string;
    const data = getRound(id);
    if (data) {
      setRound(data);
      // Find first hole without scores
      const holesWithScores = new Set(data.scores.map(s => s.holeNumber));
      for (let h = 1; h <= 18; h++) {
        if (!holesWithScores.has(h)) {
          setCurrentHole(h);
          break;
        }
      }
    }
    setLoading(false);
  }, [params.id]);

  const handleScoreChange = (playerId: string, holeNumber: number, strokes: number | null) => {
    if (!round) return;

    const updatedScores = [...round.scores];
    const existingIndex = updatedScores.findIndex(
      s => s.playerId === playerId && s.holeNumber === holeNumber
    );

    if (existingIndex >= 0) {
      if (strokes === null) {
        updatedScores.splice(existingIndex, 1);
      } else {
        updatedScores[existingIndex].strokes = strokes;
      }
    } else if (strokes !== null) {
      updatedScores.push({ playerId, holeNumber, strokes });
    }

    const updatedRound = { ...round, scores: updatedScores };
    setRound(updatedRound);
    saveRound(updatedRound);
  };

  const handleOCRCapture = async (imageBase64: string) => {
    if (!round) return;
    
    setShowCamera(false);
    setOcrLoading(true);
    setOcrError(null);

    try {
      const result = await parseScorecard(imageBase64, round.players);
      
      if (result.players.length === 0) {
        setOcrError('Could not read scorecard. Please try again with a clearer image.');
        return;
      }

      // Convert OCR result to scores
      const ocrScores = ocrResultToScores(result, round.players);
      
      if (ocrScores.length === 0) {
        // If no matches, try to add players from OCR
        setOcrError(
          `Found players: ${result.players.map(p => p.name).join(', ')}. ` +
          `Expected: ${round.players.map(p => p.name).join(', ')}. ` +
          `Player names must match to import scores.`
        );
        return;
      }

      // Merge OCR scores with existing (OCR overwrites)
      const mergedScores = [...round.scores];
      for (const ocrScore of ocrScores) {
        const existingIndex = mergedScores.findIndex(
          s => s.playerId === ocrScore.playerId && s.holeNumber === ocrScore.holeNumber
        );
        if (ocrScore.strokes !== null) {
          if (existingIndex >= 0) {
            mergedScores[existingIndex] = ocrScore;
          } else {
            mergedScores.push(ocrScore);
          }
        }
      }

      const updatedRound = { ...round, scores: mergedScores };
      setRound(updatedRound);
      saveRound(updatedRound);

      alert(`✅ Imported ${ocrScores.filter(s => s.strokes !== null).length} scores!`);
    } catch (error) {
      console.error('OCR error:', error);
      setOcrError(error instanceof Error ? error.message : 'Failed to scan scorecard');
    } finally {
      setOcrLoading(false);
    }
  };

  const handleCompleteRound = () => {
    if (!round) return;
    
    const hasAnyScores = round.scores.length > 0;
    if (!hasAnyScores) {
      alert('Enter at least some scores before completing the round.');
      return;
    }

    if (confirm('Mark this round as complete?')) {
      const updatedRound = { ...round, status: 'completed' as const };
      setRound(updatedRound);
      saveRound(updatedRound);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-green-500"></div>
      </div>
    );
  }

  if (!round) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
        <p className="text-xl mb-4">Round not found</p>
        <Link href="/" className="text-green-400 hover:underline">
          ← Back to Home
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-green-700 p-4 sticky top-0 z-20">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-4">
            <Link href="/" className="p-2 hover:bg-green-600 rounded">
              ←
            </Link>
            <div className="flex-1">
              <h1 className="text-lg font-bold truncate">{round.courseName}</h1>
              <p className="text-sm text-green-200">
                Hole {currentHole} • {round.players.length} player{round.players.length !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              onClick={() => setShowCamera(true)}
              className="p-2 bg-green-600 hover:bg-green-500 rounded-lg flex items-center gap-2"
              title="Scan scorecard"
            >
              📷
            </button>
          </div>
        </div>
      </header>

      {/* OCR Status */}
      {ocrLoading && (
        <div className="bg-blue-900 p-4 text-center">
          <div className="flex items-center justify-center gap-2">
            <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white"></div>
            <span>Scanning scorecard...</span>
          </div>
        </div>
      )}

      {ocrError && (
        <div className="bg-red-900 p-4 text-center">
          <p className="text-red-200">{ocrError}</p>
          <button
            onClick={() => setOcrError(null)}
            className="text-sm underline mt-2"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-4xl mx-auto p-4 pb-32">
        <ScoreGrid
          round={round}
          onScoreChange={handleScoreChange}
          currentHole={currentHole}
          onHoleSelect={setCurrentHole}
        />

        {/* Actions */}
        <div className="mt-6 space-y-3">
          <button
            onClick={() => setShowCamera(true)}
            className="w-full p-4 bg-blue-600 hover:bg-blue-700 rounded-xl font-bold flex items-center justify-center gap-2"
          >
            📷 Scan Physical Scorecard
          </button>
          
          {round.status === 'active' && (
            <button
              onClick={handleCompleteRound}
              className="w-full p-4 bg-gray-700 hover:bg-gray-600 rounded-xl font-bold"
            >
              ✓ Complete Round
            </button>
          )}
        </div>

        {/* Score Legend */}
        <div className="mt-6 p-4 bg-gray-800 rounded-lg">
          <h3 className="text-sm font-semibold text-gray-400 mb-2">Score Colors</h3>
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="flex items-center gap-1">
              <span className="w-6 h-6 bg-yellow-400 rounded"></span> Eagle
            </span>
            <span className="flex items-center gap-1">
              <span className="w-6 h-6 bg-red-500 rounded"></span> Birdie
            </span>
            <span className="flex items-center gap-1">
              <span className="w-6 h-6 bg-green-500 rounded"></span> Par
            </span>
            <span className="flex items-center gap-1">
              <span className="w-6 h-6 bg-blue-400 rounded"></span> Bogey
            </span>
            <span className="flex items-center gap-1">
              <span className="w-6 h-6 bg-blue-600 rounded"></span> Double+
            </span>
          </div>
        </div>
      </main>

      {/* Camera Modal */}
      {showCamera && (
        <CameraCapture
          onCapture={handleOCRCapture}
          onClose={() => setShowCamera(false)}
        />
      )}
    </div>
  );
}
