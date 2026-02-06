'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Round, Tournament } from '@/lib/types';
import { getRound, saveRound, getTournament, getRounds } from '@/lib/storage';
import { parseScorecard, ocrResultToScores } from '@/lib/ocr';
import ScoreGrid from '@/components/ScoreGrid';
import CameraCapture from '@/components/CameraCapture';
import GamesPanel from '@/components/GamesPanel';
import GameLeaderboards from '@/components/GameLeaderboards';
import GPSMapView from '@/components/GPSMapView';
import RoundSummary from '@/components/RoundSummary';
import CaddieModal from '@/components/CaddieModal';
import TournamentLeaderboard from '@/components/TournamentLeaderboard';
import EditGroupsModal from '@/components/EditGroupsModal';
import { AnimatePresence, motion } from 'framer-motion';
import { Camera, Check, Map, Trophy, ChevronRight, Users, Settings2 } from 'lucide-react';
import { getCourseCoordinates, CourseCoordinates } from '@/lib/golf-api';
import { hapticCelebration, hapticSuccess } from '@/lib/haptics';

export default function RoundPage() {
  const params = useParams();
  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCamera, setShowCamera] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [mapCoordinates, setMapCoordinates] = useState<CourseCoordinates[]>([]);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [currentHole, setCurrentHole] = useState(1);
  const [activeTab, setActiveTab] = useState<'scores' | 'games' | 'tournament'>('scores');
  const [showCaddie, setShowCaddie] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showEditGroups, setShowEditGroups] = useState(false);

  // Tournament data (if this round is part of one)
  const tournament = useMemo(() => {
    if (!round?.tournamentId) return null;
    return getTournament(round.tournamentId);
  }, [round?.tournamentId]);

  // All rounds in this tournament (for leaderboard)
  const tournamentRounds = useMemo(() => {
    if (!tournament) return [];
    const allRounds = getRounds();
    return allRounds.filter(r => 
      tournament.roundIds.includes(r.id) || r.tournamentId === tournament.id
    );
  }, [tournament]);

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
    // IMPORTANT: use functional state update so multiple rapid calls (e.g. voice filling many players)
    // don't clobber each other due to stale `round` closures.
    setRound((prev) => {
      if (!prev) return prev;

      const updatedScores = [...prev.scores];
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

      const updatedRound = { ...prev, scores: updatedScores };
      saveRound(updatedRound);
      return updatedRound;
    });
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

    const updatedRound = { ...round, status: 'completed' as const };
    setRound(updatedRound);
    saveRound(updatedRound);
    setShowSummary(true);
    hapticCelebration(); // 🎉 Festive haptics!
  };

  const handleOpenMap = async () => {
    if (!round) return;
    
    // Check if we have a GolfAPI course ID
    // For now, use demo coordinates or fetch from API
    // TODO: Load actual coordinates from GolfAPI based on golfApiCourseId
    
    // Demo: Generate sample coordinates for testing
    // In production, this would come from GolfAPI.io
    const demoCoordinates: CourseCoordinates[] = [];
    
    // If round has stored coordinates, use those
    // Otherwise show error that GPS isn't available for this course
    if (mapCoordinates.length === 0 && demoCoordinates.length === 0) {
      alert('GPS map data not available for this course yet. Course data will be available after connecting to GolfAPI.io.');
      return;
    }
    
    setShowMap(true);
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

            {/* Edit Groups button - only show if round has groups or is a tournament round */}
            {(round.groups || round.tournamentId) && (
              <button 
                onClick={() => setShowEditGroups(true)} 
                className="btn btn-icon" 
                title="Edit Groups" 
                aria-label="Edit Groups"
              >
                <Users className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
            <button onClick={() => setShowCaddie(true)} className="btn btn-icon" title="Caddie" aria-label="Caddie">
              <Map className="h-5 w-5" aria-hidden="true" />
            </button>
            <button onClick={() => setShowCamera(true)} className="btn btn-icon" title="Scan scorecard" aria-label="Scan scorecard">
              <Camera className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      {/* Tournament Banner - shows when round is part of a tournament */}
      {tournament && (
        <div className="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border-b border-amber-500/20">
          <div className="max-w-4xl mx-auto px-4 py-2">
            <Link 
              href={`/tournament/${tournament.id}`}
              className="flex items-center justify-between group"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                  <Trophy className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-amber-200 group-hover:text-amber-100 transition-colors">
                    {tournament.name}
                  </div>
                  <div className="text-xs text-amber-400/70">
                    Round {tournamentRounds.findIndex(r => r.id === round?.id) + 1} of {tournament.numRounds || tournamentRounds.length}
                    {' • '}{tournament.playerIds.length} players
                  </div>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-amber-400/50 group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all" />
            </Link>
          </div>
        </div>
      )}

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
          {tournament && (
            <button
              onClick={() => setActiveTab('tournament')}
              className={`pill-tab flex items-center gap-1.5 ${activeTab === 'tournament' ? 'pill-tab-active text-amber-200' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              <Trophy className="w-3.5 h-3.5" />
              Leaderboard
            </button>
          )}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {activeTab === 'scores' && (
            <motion.div
              key="scores"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <ScoreGrid round={round} onScoreChange={handleScoreChange} currentHole={currentHole} onHoleSelect={setCurrentHole} />
              <GameLeaderboards round={round} />

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
          )}
          {activeTab === 'games' && (
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
          {activeTab === 'tournament' && tournament && (
            <motion.div
              key="tournament"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              {/* Tournament header */}
              <div className="card p-5 mb-4 bg-gradient-to-br from-amber-500/10 to-transparent border-amber-500/20">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center">
                    <Trophy className="w-5 h-5 text-amber-400" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-lg text-amber-100">{tournament.name}</h2>
                    <p className="text-sm text-amber-400/70">
                      {tournamentRounds.length} round{tournamentRounds.length !== 1 ? 's' : ''} • {tournament.playerIds.length} players
                    </p>
                  </div>
                </div>
                <Link 
                  href={`/tournament/${tournament.id}`}
                  className="text-sm text-amber-400 hover:text-amber-300 flex items-center gap-1"
                >
                  View full tournament page
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>

              {/* Live leaderboard */}
              <div className="card p-4 mb-4">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <h3 className="text-sm font-medium text-zinc-200">Live Leaderboard</h3>
                </div>
                <TournamentLeaderboard tournament={tournament} rounds={tournamentRounds} />
              </div>

              {/* This round's scores by group */}
              {round.groups && round.groups.length > 0 && (
                <div className="card p-4">
                  <h3 className="text-sm font-medium text-zinc-200 mb-3 flex items-center gap-2">
                    <Users className="w-4 h-4 text-zinc-400" />
                    Groups Playing Now
                  </h3>
                  <div className="space-y-3">
                    {round.groups.map((group, idx) => {
                      const groupPlayers = round.players.filter(p => 
                        group.playerIds.includes(p.id) || p.groupId === group.id
                      );
                      return (
                        <div key={group.id} className="bg-white/5 rounded-lg p-3">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium text-zinc-200">{group.name}</span>
                            {group.teeTime && (
                              <span className="text-xs text-zinc-500">{group.teeTime}</span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {groupPlayers.map(player => {
                              const playerScores = round.scores.filter(s => s.playerId === player.id);
                              const holesPlayed = playerScores.filter(s => s.strokes !== null).length;
                              const totalStrokes = playerScores.reduce((sum, s) => sum + (s.strokes || 0), 0);
                              return (
                                <div key={player.id} className="bg-white/5 px-2 py-1 rounded text-xs">
                                  <span className="text-zinc-300">{player.name}</span>
                                  {holesPlayed > 0 && (
                                    <span className="text-zinc-500 ml-1">
                                      ({totalStrokes} thru {holesPlayed})
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
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

      <AnimatePresence>
        {showMap && mapCoordinates.length > 0 && (
          <motion.div key="map" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            <GPSMapView
              courseId={parseInt(round.courseId) || 0}
              courseName={round.courseName}
              holeCoordinates={mapCoordinates}
              currentHole={currentHole}
              onHoleChange={setCurrentHole}
              onClose={() => setShowMap(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showSummary && (
          <motion.div key="summary" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            <RoundSummary round={round} onClose={() => setShowSummary(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Caddie Panel Modal */}
      <AnimatePresence>
        {showCaddie && (
          <CaddieModal
            round={round}
            currentHole={currentHole}
            onHoleChange={setCurrentHole}
            onClose={() => setShowCaddie(false)}
          />
        )}
      </AnimatePresence>

      {/* Edit Groups Modal */}
      <AnimatePresence>
        {showEditGroups && (
          <EditGroupsModal
            round={round}
            onSave={(groups) => {
              // Update players with new group assignments
              const updatedPlayers = round.players.map(p => {
                const playerGroup = groups.find(g => g.playerIds.includes(p.id));
                return { ...p, groupId: playerGroup?.id };
              });
              
              const updatedRound = {
                ...round,
                groups: groups.length > 0 ? groups : undefined,
                players: updatedPlayers,
              };
              setRound(updatedRound);
              saveRound(updatedRound);
              setShowEditGroups(false);
            }}
            onClose={() => setShowEditGroups(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
