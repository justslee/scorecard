'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Course, Round, Player } from '@/lib/types';
import { addRoundToTournament, getCourses, getTournament, saveRound } from '@/lib/storage';

export default function NewTournamentRoundPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const tournamentId = params?.id;

  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string>('');
  const [selectedTeeId, setSelectedTeeId] = useState<string>('');

  const tournament = useMemo(() => (tournamentId ? getTournament(tournamentId) : null), [tournamentId]);

  useEffect(() => {
    setCourses(getCourses());
  }, []);

  const selectedCourse = useMemo(
    () => courses.find(c => c.id === selectedCourseId) || null,
    [courses, selectedCourseId]
  );

  const teeOptions = selectedCourse?.tees ?? [];

  useEffect(() => {
    // Auto-select first tee when course changes
    if (!selectedCourse) return;
    if (teeOptions.length > 0) {
      setSelectedTeeId(teeOptions[0].id);
    } else {
      setSelectedTeeId('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCourseId]);

  const handleStartRound = () => {
    if (!tournamentId || !tournament) return;
    if (!selectedCourse) {
      alert('Select a course');
      return;
    }

    const players: Player[] = tournament.playerIds.map(pid => ({
      id: pid,
      name: tournament.playerNamesById?.[pid] ?? 'Player',
    }));

    const selectedTee = teeOptions.find(t => t.id === selectedTeeId);

    const round: Round = {
      id: crypto.randomUUID(),
      courseId: selectedCourse.id,
      courseName: selectedCourse.name,
      teeId: selectedTee?.id,
      teeName: selectedTee?.name,
      date: new Date().toISOString(),
      players,
      scores: [],
      holes: selectedTee?.holes ?? selectedCourse.holes,
      status: 'active',
      tournamentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveRound(round);
    addRoundToTournament(tournamentId, round.id);
    router.push(`/round/${round.id}`);
  };

  if (!tournament) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <Link href="/" className="text-green-400">← Back</Link>
        <p className="mt-6 text-gray-300">Tournament not found.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-green-700 p-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center gap-4">
          <Link href={`/tournament/${tournament.id}`} className="p-2 hover:bg-green-600 rounded">
            ←
          </Link>
          <h1 className="text-xl font-bold">Add Round</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 pb-24 space-y-6">
        <section className="bg-gray-800 rounded-xl p-4">
          <div className="text-sm text-gray-400">Tournament</div>
          <div className="font-bold">{tournament.name}</div>
          <div className="text-xs text-gray-500 mt-1">Players: {tournament.playerIds.length}</div>
        </section>

        <section className="bg-gray-800 rounded-xl p-4">
          <label className="block text-sm text-gray-300 mb-2">Course</label>
          <select
            value={selectedCourseId}
            onChange={e => setSelectedCourseId(e.target.value)}
            className="w-full p-3 bg-gray-700 rounded-lg"
          >
            <option value="" disabled>Select a course...</option>
            {courses.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <label className="block text-sm text-gray-300 mb-2 mt-4">Tee box</label>
          <select
            value={selectedTeeId}
            onChange={e => setSelectedTeeId(e.target.value)}
            className="w-full p-3 bg-gray-700 rounded-lg"
            disabled={!selectedCourse || teeOptions.length === 0}
          >
            {teeOptions.length === 0 ? (
              <option value="">Default</option>
            ) : (
              teeOptions.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))
            )}
          </select>

          <p className="text-xs text-gray-500 mt-2">Tee boxes can change yardage/pars.</p>
        </section>

        <button
          onClick={handleStartRound}
          className="w-full p-4 bg-green-600 hover:bg-green-700 rounded-xl text-xl font-bold"
        >
          ⛳ Start Round
        </button>
      </main>
    </div>
  );
}
