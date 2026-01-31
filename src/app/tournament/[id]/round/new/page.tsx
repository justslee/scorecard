'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Course, Round, Player } from '@/lib/types';
import { addRoundToTournament, getCourses, getTournament, saveRound } from '@/lib/storage';
import { Flag } from 'lucide-react';

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

  const selectedCourse = useMemo(() => courses.find((c) => c.id === selectedCourseId) || null, [courses, selectedCourseId]);

  const teeOptions = selectedCourse?.tees ?? [];

  useEffect(() => {
    if (!selectedCourse) return;
    if (teeOptions.length > 0) setSelectedTeeId(teeOptions[0].id);
    else setSelectedTeeId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCourseId]);

  const handleStartRound = () => {
    if (!tournamentId || !tournament) return;
    if (!selectedCourse) {
      alert('Select a course');
      return;
    }

    const players: Player[] = tournament.playerIds.map((pid) => ({
      id: pid,
      name: tournament.playerNamesById?.[pid] ?? 'Player',
    }));

    const selectedTee = teeOptions.find((t) => t.id === selectedTeeId);

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
      <div className="min-h-screen px-6 py-8">
        <Link href="/" className="text-emerald-400 hover:text-emerald-300 transition-colors">
          ← Back
        </Link>
        <p className="mt-6 text-zinc-300">Tournament not found.</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href={`/tournament/${tournament.id}`} className="btn btn-icon" aria-label="Back">
            ←
          </Link>
          <div>
            <h1 className="text-base font-semibold tracking-tight">Add Round</h1>
            <p className="text-sm text-zinc-400">For {tournament.name}</p>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-24 space-y-4">
        <section className="card p-5">
          <div className="text-xs font-medium text-zinc-400 tracking-wide uppercase">Tournament</div>
          <div className="font-semibold text-zinc-100 mt-1">{tournament.name}</div>
          <div className="text-xs text-zinc-500 mt-1">Players: {tournament.playerIds.length}</div>
        </section>

        <section className="card p-5">
          <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">Course</label>
          <select
            value={selectedCourseId}
            onChange={(e) => setSelectedCourseId(e.target.value)}
            className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10"
          >
            <option value="" disabled>
              Select a course…
            </option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2 mt-4">Tee box</label>
          <select
            value={selectedTeeId}
            onChange={(e) => setSelectedTeeId(e.target.value)}
            className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10"
            disabled={!selectedCourse || teeOptions.length === 0}
          >
            {teeOptions.length === 0 ? (
              <option value="">Default</option>
            ) : (
              teeOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))
            )}
          </select>

          <p className="text-xs text-zinc-500 mt-2">Tee boxes can change yardage/pars.</p>
        </section>

        <button onClick={handleStartRound} className="btn btn-primary w-full">
          <span className="inline-flex items-center justify-center gap-2">
            <Flag className="h-5 w-5" aria-hidden="true" />
            <span>Start Round</span>
          </span>
        </button>
      </main>
    </div>
  );
}
