'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Course, Player, Round, SavedPlayer, createDefaultCourse } from '@/lib/types';
import { getCourses, saveCourse, saveRound, getSavedPlayers } from '@/lib/storage';
import type { CourseListItem, CourseData } from '@/lib/courses/types';
import { AnimatePresence, motion } from 'framer-motion';
import { Flag, Mic, Users } from 'lucide-react';
import VoiceRoundSetup from '@/components/VoiceRoundSetup';
import PlayerAutocomplete from '@/components/PlayerAutocomplete';

export default function NewRound() {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[]>([]);
  const [mappedCourses, setMappedCourses] = useState<CourseListItem[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [selectedTeeId, setSelectedTeeId] = useState<string>('');
  const [customCourseName, setCustomCourseName] = useState('');
  const [players, setPlayers] = useState<Player[]>([{ id: crypto.randomUUID(), name: '' }]);
  const [showCustom, setShowCustom] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [step, setStep] = useState<'course' | 'players'>('course');
  const [savedPlayers, setSavedPlayers] = useState<SavedPlayer[]>([]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCourses(getCourses());
    setSavedPlayers(getSavedPlayers());

    // Load mapped courses (Phase 3)
    (async () => {
      try {
        const res = await fetch('/api/courses');
        const data = await res.json();
        setMappedCourses(Array.isArray(data.courses) ? data.courses : []);
      } catch {
        setMappedCourses([]);
      }
    })();
  }, []);

  const handleVoiceSetup = (config: { courseName: string; playerNames: string[]; teeName?: string }) => {
    // Create or find the course
    const existingCourse = courses.find(
      (c) => c.name.toLowerCase() === config.courseName.toLowerCase()
    );
    
    if (existingCourse) {
      setSelectedCourse(existingCourse);
      if (existingCourse.tees && existingCourse.tees.length > 0) {
        // Try to match tee name
        const matchedTee = config.teeName
          ? existingCourse.tees.find((t) => t.name.toLowerCase().includes(config.teeName!.toLowerCase()))
          : existingCourse.tees[0];
        setSelectedTeeId(matchedTee?.id || existingCourse.tees[0].id);
      }
    } else {
      // Create new custom course
      const newCourse = createDefaultCourse(config.courseName);
      saveCourse(newCourse);
      setCourses((prev) => [...prev, newCourse]);
      setSelectedCourse(newCourse);
      if (newCourse.tees && newCourse.tees.length > 0) {
        setSelectedTeeId(newCourse.tees[0].id);
      }
    }

    // Set up players
    if (config.playerNames.length > 0) {
      setPlayers(
        config.playerNames.map((name) => ({
          id: crypto.randomUUID(),
          name,
        }))
      );
    }

    setStep('players');
    setShowVoice(false);
  };

  const handleAddPlayer = () => setPlayers([...players, { id: crypto.randomUUID(), name: '' }]);

  const handleRemovePlayer = (id: string) => {
    if (players.length > 1) setPlayers(players.filter((p) => p.id !== id));
  };

  const handlePlayerChange = (index: number, player: Player) => {
    const updated = [...players];
    updated[index] = player;
    setPlayers(updated);
  };

  const handleSelectSavedPlayer = (savedPlayer: SavedPlayer) => {
    const newPlayer: Player = {
      id: savedPlayer.id,
      name: savedPlayer.name,
      handicap: savedPlayer.handicap,
    };

    // Add as new player if not already added
    if (!players.some((p) => p.id === savedPlayer.id)) {
      const emptyIndex = players.findIndex((p) => !p.name.trim());
      if (emptyIndex >= 0) {
        const updated = [...players];
        updated[emptyIndex] = newPlayer;
        setPlayers(updated);
      } else if (players.length < 6) {
        setPlayers([...players, newPlayer]);
      }
    }
  };

  // Filter saved players not already in the round
  const availableSavedPlayers = savedPlayers.filter(
    (sp) => !players.some((p) => p.id === sp.id)
  );

  // Get top 4 most frequent players (sorted by roundsPlayed)
  const frequentPlayers = [...availableSavedPlayers]
    .sort((a, b) => (b.roundsPlayed || 0) - (a.roundsPlayed || 0))
    .slice(0, 4);

  // Get all selected player IDs
  const selectedPlayerIds = players.map((p) => p.id);

  const handleSelectCourse = (course: Course) => {
    setSelectedCourse(course);
    if (course.tees && course.tees.length > 0) setSelectedTeeId(course.tees[0].id);
    else setSelectedTeeId('');

    setShowCustom(false);
    setStep('players');
  };

  const handleCreateCustomCourse = () => {
    if (!customCourseName.trim()) return;

    const course = createDefaultCourse(customCourseName.trim());
    saveCourse(course);
    setSelectedCourse(course);
    if (course.tees && course.tees.length > 0) setSelectedTeeId(course.tees[0].id);
    else setSelectedTeeId('');

    setShowCustom(false);
    setStep('players');
  };

  const handleStartRound = () => {
    if (!selectedCourse) return;

    const validPlayers = players.filter((p) => p.name.trim());
    if (validPlayers.length === 0) {
      alert('Add at least one player');
      return;
    }

    const selectedTee = selectedCourse.tees?.find((t) => t.id === selectedTeeId);

    const round: Round = {
      id: crypto.randomUUID(),
      courseId: selectedCourse.id,
      courseName: selectedCourse.name,
      teeId: selectedTee?.id,
      teeName: selectedTee?.name,
      date: new Date().toISOString(),
      players: validPlayers.map((p) => ({ ...p, name: p.name.trim() })),
      scores: [],
      holes: selectedTee?.holes ?? selectedCourse.holes,
      games: [],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveRound(round);
    router.push(`/round/${round.id}`);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/" className="btn btn-icon" aria-label="Back">
            ←
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold tracking-tight">New Round</h1>
            <p className="text-sm text-zinc-400">Set course and players.</p>
          </div>
          <button
            onClick={() => setShowVoice(true)}
            className="btn btn-secondary flex items-center gap-2"
            title="Voice setup"
          >
            <Mic className="h-4 w-4" />
            <span className="hidden sm:inline">Voice</span>
          </button>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-24">
        <div className="flex gap-2 mb-6">
          <div className={`flex-1 h-1.5 rounded-full ${step === 'course' ? 'bg-emerald-400/80' : 'bg-white/10'}`} />
          <div className={`flex-1 h-1.5 rounded-full ${step === 'players' ? 'bg-emerald-400/80' : 'bg-white/10'}`} />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {step === 'course' ? (
            <motion.div
              key="course"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <h2 className="text-sm font-medium text-zinc-400 tracking-wide uppercase mb-3">Select course</h2>

              <div className="space-y-3 mb-4">
                {courses.map((course) => (
                  <button
                    key={course.id}
                    onClick={() => handleSelectCourse(course)}
                    className="w-full text-left card card-hover p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-lg tracking-tight truncate">{course.name}</div>
                        {course.location && <div className="text-sm text-zinc-400 truncate">{course.location}</div>}
                        <div className="text-sm text-zinc-500 mt-1">
                          {course.holes.length} holes • Par {course.holes.reduce((s, h) => s + h.par, 0)}
                        </div>
                      </div>
                      <div className="text-zinc-500">→</div>
                    </div>
                  </button>
                ))}

                {mappedCourses.length > 0 ? (
                  <div className="pt-3">
                    <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Mapped courses</div>
                    <div className="space-y-2">
                      {mappedCourses.map((mc) => (
                        <button
                          key={mc.id}
                          onClick={async () => {
                            try {
                              const res = await fetch(`/api/courses/${encodeURIComponent(mc.id)}`);
                              const data = await res.json();
                              const course = data.course as CourseData | undefined;
                              if (!course) return;

                              // Convert mapped course -> internal Course model
                              const baseHoles = course.holes.map((h) => ({
                                number: h.number,
                                par: h.par,
                                handicap: h.handicap,
                              }));

                              const tees = course.teeSets.map((t) => ({
                                id: t.name,
                                name: t.name,
                                holes: course.holes.map((h) => ({
                                  number: h.number,
                                  par: h.par,
                                  handicap: h.handicap,
                                  yards: h.yardages?.[t.name] || undefined,
                                })),
                              }));

                              handleSelectCourse({
                                id: course.id,
                                name: course.name,
                                holes: baseHoles,
                                tees,
                                location: course.address,
                              });
                            } catch {
                              // ignore
                            }
                          }}
                          className="w-full text-left card card-hover p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-semibold tracking-tight truncate">{mc.name}</div>
                              {mc.address ? (
                                <div className="text-sm text-zinc-400 truncate">{mc.address}</div>
                              ) : null}
                            </div>
                            <div className="text-zinc-500">→</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {showCustom ? (
                <div className="card p-5">
                  <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">Custom course</label>
                  <input
                    type="text"
                    placeholder="Course name"
                    value={customCourseName}
                    onChange={(e) => setCustomCourseName(e.target.value)}
                    className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
                    autoFocus
                  />
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => setShowCustom(false)} className="btn btn-secondary flex-1">
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateCustomCourse}
                      className="btn btn-primary flex-1"
                      disabled={!customCourseName.trim()}
                    >
                      Create
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowCustom(true)}
                  className="w-full rounded-2xl border border-dashed border-white/20 px-5 py-5 text-zinc-400 hover:text-zinc-200 hover:border-white/30 transition-colors"
                >
                  + Create Custom Course
                </button>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="players"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="flex justify-between items-center mb-4">
                <div>
                  <h2 className="text-sm font-medium text-zinc-400 tracking-wide uppercase">Players</h2>
                  <p className="text-lg font-semibold tracking-tight">Who’s playing?</p>
                </div>
                <button onClick={() => setStep('course')} className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
                  ← Course
                </button>
              </div>

              <div className="card p-5 mb-4">
                <div className="text-sm text-zinc-400">Playing at</div>
                <div className="font-semibold text-zinc-100">{selectedCourse?.name}</div>

                {(selectedCourse?.tees?.length ?? 0) > 0 && (
                  <div className="mt-4">
                    <div className="text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">Tee box</div>
                    <select
                      value={selectedTeeId}
                      onChange={(e) => setSelectedTeeId(e.target.value)}
                      className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10"
                    >
                      {selectedCourse?.tees?.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Quick add - top 4 frequent players */}
              {frequentPlayers.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Users className="h-4 w-4 text-zinc-500" />
                    <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Frequent Players</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {frequentPlayers.map((sp) => (
                      <button
                        key={sp.id}
                        onClick={() => handleSelectSavedPlayer(sp)}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 hover:border-emerald-400/30 transition-colors"
                      >
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-emerald-500/20 to-teal-500/20 flex items-center justify-center text-xs font-medium text-emerald-300">
                          {sp.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm">{sp.nickname || sp.name.split(' ')[0]}</span>
                        {sp.handicap !== undefined && (
                          <span className="text-xs text-zinc-500">({sp.handicap})</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-3 mb-4">
                {players.map((player, index) => (
                  <PlayerAutocomplete
                    key={index}
                    value={player}
                    index={index}
                    savedPlayers={savedPlayers}
                    selectedIds={selectedPlayerIds}
                    placeholder={`Player ${index + 1}`}
                    onChange={(updated) => handlePlayerChange(index, updated)}
                    onRemove={() => handleRemovePlayer(player.id)}
                    canRemove={players.length > 1}
                  />
                ))}
              </div>

              {players.length < 6 && (
                <button
                  onClick={handleAddPlayer}
                  className="w-full rounded-2xl border border-dashed border-white/20 px-5 py-4 text-zinc-400 hover:text-zinc-200 hover:border-white/30 transition-colors mb-6"
                >
                  + Add Player
                </button>
              )}

              <button onClick={handleStartRound} className="btn btn-primary w-full">
                <span className="inline-flex items-center justify-center gap-2">
                  <Flag className="h-5 w-5" aria-hidden="true" />
                  <span>Start Round</span>
                </span>
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {showVoice && (
          <motion.div
            key="voice-round"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            <VoiceRoundSetup
              onSetupRound={handleVoiceSetup}
              onClose={() => setShowVoice(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
