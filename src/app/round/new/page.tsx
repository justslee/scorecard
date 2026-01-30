'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Course, Player, Round, HoleInfo, createDefaultCourse } from '@/lib/types';
import { getCourses, saveRound, saveCourse } from '@/lib/storage';

export default function NewRound() {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [selectedTeeId, setSelectedTeeId] = useState<string>('');
  const [customCourseName, setCustomCourseName] = useState('');
  const [players, setPlayers] = useState<Player[]>([{ id: crypto.randomUUID(), name: '' }]);
  const [showCustom, setShowCustom] = useState(false);
  const [step, setStep] = useState<'course' | 'players'>('course');

  useEffect(() => {
    setCourses(getCourses());
  }, []);

  const handleAddPlayer = () => {
    setPlayers([...players, { id: crypto.randomUUID(), name: '' }]);
  };

  const handleRemovePlayer = (id: string) => {
    if (players.length > 1) {
      setPlayers(players.filter(p => p.id !== id));
    }
  };

  const handlePlayerNameChange = (id: string, name: string) => {
    setPlayers(players.map(p => p.id === id ? { ...p, name } : p));
  };

  const handleSelectCourse = (course: Course) => {
    setSelectedCourse(course);
    // Default tee selection
    if (course.tees && course.tees.length > 0) {
      setSelectedTeeId(course.tees[0].id);
    } else {
      setSelectedTeeId('');
    }
    setShowCustom(false);
    setStep('players');
  };

  const handleCreateCustomCourse = () => {
    if (!customCourseName.trim()) return;
    
    const course = createDefaultCourse(customCourseName.trim());
    saveCourse(course);
    setSelectedCourse(course);
    if (course.tees && course.tees.length > 0) {
      setSelectedTeeId(course.tees[0].id);
    } else {
      setSelectedTeeId('');
    }
    setShowCustom(false);
    setStep('players');
  };

  const handleStartRound = () => {
    if (!selectedCourse) return;
    
    const validPlayers = players.filter(p => p.name.trim());
    if (validPlayers.length === 0) {
      alert('Add at least one player');
      return;
    }

    const selectedTee = selectedCourse.tees?.find(t => t.id === selectedTeeId);

    const round: Round = {
      id: crypto.randomUUID(),
      courseId: selectedCourse.id,
      courseName: selectedCourse.name,
      teeId: selectedTee?.id,
      teeName: selectedTee?.name,
      date: new Date().toISOString(),
      players: validPlayers.map(p => ({ ...p, name: p.name.trim() })),
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
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-green-700 p-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center gap-4">
          <Link href="/" className="p-2 hover:bg-green-600 rounded">
            ←
          </Link>
          <h1 className="text-xl font-bold">New Round</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 pb-24">
        {/* Step Indicator */}
        <div className="flex gap-2 mb-6">
          <div className={`flex-1 h-2 rounded ${step === 'course' ? 'bg-green-500' : 'bg-green-700'}`} />
          <div className={`flex-1 h-2 rounded ${step === 'players' ? 'bg-green-500' : 'bg-gray-700'}`} />
        </div>

        {step === 'course' && (
          <>
            <h2 className="text-lg font-semibold mb-4">Select Course</h2>
            
            {/* Course List */}
            <div className="space-y-2 mb-4">
              {courses.map(course => (
                <button
                  key={course.id}
                  onClick={() => handleSelectCourse(course)}
                  className={`w-full p-4 rounded-lg text-left transition-colors ${
                    selectedCourse?.id === course.id
                      ? 'bg-green-600 ring-2 ring-green-400'
                      : 'bg-gray-800 hover:bg-gray-750'
                  }`}
                >
                  <div className="font-bold">{course.name}</div>
                  {course.location && (
                    <div className="text-sm text-gray-400">{course.location}</div>
                  )}
                  <div className="text-sm text-gray-500">
                    {course.holes.length} holes • Par {course.holes.reduce((s, h) => s + h.par, 0)}
                  </div>
                </button>
              ))}
            </div>

            {/* Custom Course */}
            {showCustom ? (
              <div className="bg-gray-800 rounded-lg p-4">
                <input
                  type="text"
                  placeholder="Course name"
                  value={customCourseName}
                  onChange={(e) => setCustomCourseName(e.target.value)}
                  className="w-full p-3 bg-gray-700 rounded-lg mb-3"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowCustom(false)}
                    className="flex-1 p-3 bg-gray-600 rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateCustomCourse}
                    className="flex-1 p-3 bg-green-600 rounded-lg font-bold"
                    disabled={!customCourseName.trim()}
                  >
                    Create
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowCustom(true)}
                className="w-full p-4 border-2 border-dashed border-gray-600 rounded-lg text-gray-400 hover:border-gray-500 hover:text-gray-300"
              >
                + Create Custom Course
              </button>
            )}
          </>
        )}

        {step === 'players' && (
          <>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">Add Players</h2>
              <button
                onClick={() => setStep('course')}
                className="text-sm text-gray-400 hover:text-white"
              >
                ← Back to course
              </button>
            </div>
            
            <div className="bg-gray-800 rounded-lg p-3 mb-4">
              <div className="text-sm text-gray-400">Playing at</div>
              <div className="font-bold">{selectedCourse?.name}</div>

              {(selectedCourse?.tees?.length ?? 0) > 0 && (
                <div className="mt-3">
                  <div className="text-sm text-gray-400 mb-1">Tee box</div>
                  <select
                    value={selectedTeeId}
                    onChange={(e) => setSelectedTeeId(e.target.value)}
                    className="w-full p-3 bg-gray-700 rounded-lg"
                  >
                    {selectedCourse?.tees?.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Player List */}
            <div className="space-y-3 mb-4">
              {players.map((player, index) => (
                <div key={player.id} className="flex gap-2">
                  <input
                    type="text"
                    placeholder={`Player ${index + 1}`}
                    value={player.name}
                    onChange={(e) => handlePlayerNameChange(player.id, e.target.value)}
                    className="flex-1 p-3 bg-gray-800 rounded-lg"
                  />
                  {players.length > 1 && (
                    <button
                      onClick={() => handleRemovePlayer(player.id)}
                      className="p-3 bg-red-900/50 text-red-400 rounded-lg hover:bg-red-900"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>

            {players.length < 6 && (
              <button
                onClick={handleAddPlayer}
                className="w-full p-3 border-2 border-dashed border-gray-600 rounded-lg text-gray-400 hover:border-gray-500 mb-6"
              >
                + Add Player
              </button>
            )}

            {/* Start Button */}
            <button
              onClick={handleStartRound}
              className="w-full p-4 bg-green-600 hover:bg-green-700 rounded-xl text-xl font-bold"
            >
              ⛳ Start Round
            </button>
          </>
        )}
      </main>
    </div>
  );
}
