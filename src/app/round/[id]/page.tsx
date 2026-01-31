'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Round } from '@/lib/types';
import { getRound, saveRound } from '@/lib/storage';
import { parseScorecard, ocrResultToScores } from '@/lib/ocr';
import ScoreGrid from '@/components/ScoreGrid';
import CameraCapture from '@/components/CameraCapture';
import GamesPanel from '@/components/GamesPanel';
import { AnimatePresence, motion } from 'framer-motion';
import { Camera, Check } from 'lucide-react';

export default function RoundPage() {
  const params = useParams();
  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCamera, setShowCamera] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [currentHole, setCurrentHole] = useState(1);
  const [activeTab, setActiveTab] = useState<'scores' | 'games'>('scores');

  useEffect(() => {
    const id = params.id as string;
    const data = getRound(id);
    if (data) {
      // ensure migration defaults
      const migrated: Round = { ...data, games: Array.isArray(data.games) ? data.games : [] };
      setRound(migrated);

      // Find first hole without scores
      const holesWithScores = new Set(migrated.scores.map((s) => s.holeNumber));
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
    const existingIndex = updatedScores.findIndex((s) => s.playerId === playerId && s.holeNumber === holeNumber);

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

  const handleUpdateRound = (next: Round) => {
    setRound(next);
    saveRound(next);
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
          `Found players: ${result.players.map((p) => p.name).join(', ')}. ` +
            `Expected: ${round.players.map((p) => p.name).join(', ')}. ` +
            `Player names must match to import scores.`
        );
        return;
      }

      // Merge OCR scores with existing (OCR overwrites)
      const mergedScores = [...round.scores];
      for (const ocrScore of ocrScores) {
        const existingIndex = mergedScores.findIndex(
          (s) => s.playerId === ocrScore.playerId && s.holeNumber === ocrScore.holeNumber
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

      alert(`Imported ${ocrScores.filter((s) => s.strokes !== null).length} scores.`);
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
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-emerald-500/80" />
      </div>
    );
  }

  if (!round) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 text-zinc-100">
        <p className="text-xl font-semibold mb-2">Round not found</p>
        <Link href="/" className="text-emerald-400 hover:text-emerald-300 transition-colors">
          ← Back to Home
        </Link>
      </div>
    );
  }

  const backHref = round.tournamentId ? `/tournament/${round.tournamentId}` : '/';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Link href={backHref} className="btn btn-icon" aria-label="Back">
              ←
            </Link>

            <div className="flex-1 min-w-0">
              <h1 className="text-base sm:text-lg font-semibold tracking-tight truncate">
                {round.courseName}
                {round.teeName ? ` (${round.teeName})` : ''}
              </h1>
              <p className="text-sm text-zinc-400">
                Hole <span className="text-zinc-200 font-medium">{currentHole}</span> • {round.players.length} player
                {round.players.length !== 1 ? 's' : ''}
              </p>
            </div>

            <button onClick={() => setShowCamera(true)} className="btn btn-icon" title="Scan scorecard" aria-label="Scan scorecard">
              <Camera className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <AnimatePresence initial={false}>
        {ocrLoading ? (
          <motion.div
            key="ocr-loading"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.16 }}
            className="px-4"
          >
            <div className="max-w-4xl mx-auto mt-4 card px-4 py-3">
              <div className="flex items-center justify-center gap-2 text-sm text-zinc-200">
                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-white/80" />
                <span>Scanning scorecard…</span>
              </div>
            </div>
          </motion.div>
        ) : null}

        {ocrError ? (
          <motion.div
            key="ocr-error"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.16 }}
            className="px-4"
          >
            <div className="max-w-4xl mx-auto mt-4 card px-4 py-3 border border-red-400/20">
              <p className="text-sm text-red-200">{ocrError}</p>
              <button onClick={() => setOcrError(null)} className="text-sm text-zinc-300 hover:text-white underline mt-2">
                Dismiss
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <main className="max-w-4xl mx-auto px-4 pt-5 pb-32">
        <div className="pill-tabs flex gap-1 mb-4">
          <button
            onClick={() => setActiveTab('scores')}
            className={`pill-tab ${activeTab === 'scores' ? 'pill-tab-active text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            Scores
          </button>
          <button
            onClick={() => setActiveTab('games')}
            className={`pill-tab ${activeTab === 'games' ? 'pill-tab-active text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            Games
          </button>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {activeTab === 'scores' ? (
            <motion.div
              key="scores"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <ScoreGrid round={round} onScoreChange={handleScoreChange} currentHole={currentHole} onHoleSelect={setCurrentHole} />

              <div className="mt-6 space-y-3">
                <button onClick={() => setShowCamera(true)} className="btn btn-secondary w-full">
                  <span className="inline-flex items-center justify-center gap-2">
                    <Camera className="h-5 w-5" aria-hidden="true" />
                    <span>Scan Physical Scorecard</span>
                  </span>
                </button>

                {round.status === 'active' && (
                  <button onClick={handleCompleteRound} className="btn btn-primary w-full">
                    <span className="inline-flex items-center justify-center gap-2">
                      <Check className="h-5 w-5" aria-hidden="true" />
                      <span>Complete Round</span>
                    </span>
                  </button>
                )}
              </div>

              <div className="mt-6 card p-4">
                <h3 className="text-xs font-medium text-zinc-400 tracking-wide uppercase mb-3">Score Colors</h3>
                <div className="flex flex-wrap gap-3 text-sm">
                  <span className="flex items-center gap-2 text-zinc-300">
                    <span className="w-4 h-4 rounded-md bg-yellow-400/90" /> Eagle
                  </span>
                  <span className="flex items-center gap-2 text-zinc-300">
                    <span className="w-4 h-4 rounded-md bg-red-500/90" /> Birdie
                  </span>
                  <span className="flex items-center gap-2 text-zinc-300">
                    <span className="w-4 h-4 rounded-md bg-emerald-500/90" /> Par
                  </span>
                  <span className="flex items-center gap-2 text-zinc-300">
                    <span className="w-4 h-4 rounded-md bg-sky-400/90" /> Bogey
                  </span>
                  <span className="flex items-center gap-2 text-zinc-300">
                    <span className="w-4 h-4 rounded-md bg-blue-600/90" /> Double+
                  </span>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="games"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <GamesPanel round={round} onUpdateRound={handleUpdateRound} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {showCamera && (
          <motion.div key="camera" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            <CameraCapture onCapture={handleOCRCapture} onClose={() => setShowCamera(false)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
