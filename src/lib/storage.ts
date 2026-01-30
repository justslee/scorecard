'use client';

import { Round, Course, Tournament, TeeOption, HoleInfo, GolferProfile } from './types';

const ROUNDS_KEY = 'scorecard_rounds';
const COURSES_KEY = 'scorecard_courses';
const TOURNAMENTS_KEY = 'scorecard_tournaments';
const PROFILE_KEY = 'scorecard_profile';

// -----------------
// Rounds
// -----------------
export function getRounds(): Round[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(ROUNDS_KEY);
  const parsed: Round[] = data ? JSON.parse(data) : [];

  // Migration/defaults: older rounds won't have games.
  return parsed.map(r => ({
    ...r,
    games: Array.isArray((r as any).games) ? (r as any).games : [],
  }));
}

export function getRound(id: string): Round | null {
  const rounds = getRounds();
  return rounds.find(r => r.id === id) || null;
}

export function saveRound(round: Round): void {
  const rounds = getRounds();
  const index = rounds.findIndex(r => r.id === round.id);

  round.updatedAt = new Date().toISOString();

  if (index >= 0) {
    rounds[index] = round;
  } else {
    rounds.unshift(round);
  }

  localStorage.setItem(ROUNDS_KEY, JSON.stringify(rounds));
}

export function deleteRound(id: string): void {
  const rounds = getRounds().filter(r => r.id !== id);
  localStorage.setItem(ROUNDS_KEY, JSON.stringify(rounds));

  // Also unlink from tournaments (best-effort)
  const tournaments = getTournaments();
  let changed = false;
  tournaments.forEach(t => {
    const next = t.roundIds.filter(rid => rid !== id);
    if (next.length !== t.roundIds.length) {
      t.roundIds = next;
      changed = true;
    }
  });
  if (changed) {
    localStorage.setItem(TOURNAMENTS_KEY, JSON.stringify(tournaments));
  }
}

// -----------------
// Courses
// -----------------
export function getCourses(): Course[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(COURSES_KEY);
  if (!data) {
    // Return some sample courses
    return getDefaultCourses();
  }
  return JSON.parse(data);
}

export function saveCourse(course: Course): void {
  const courses = getCourses();
  const index = courses.findIndex(c => c.id === course.id);

  if (index >= 0) {
    courses[index] = course;
  } else {
    courses.push(course);
  }

  localStorage.setItem(COURSES_KEY, JSON.stringify(courses));
}

function withTeeOptions(course: Omit<Course, 'tees'> & { holes: HoleInfo[] }): Course {
  // If a course already includes yards, tee yardages are scaled.
  const scale = (holes: HoleInfo[], mult: number): HoleInfo[] =>
    holes.map(h => ({
      ...h,
      yards: typeof h.yards === 'number' ? Math.round(h.yards * mult) : h.yards,
    }));

  const blue = scale(course.holes, 1.05);
  const white = scale(course.holes, 1.0);
  const red = scale(course.holes, 0.9);

  const tees: TeeOption[] = [
    { id: `${course.id}-blue`, name: 'Blue', holes: blue },
    { id: `${course.id}-white`, name: 'White', holes: white },
    { id: `${course.id}-red`, name: 'Red', holes: red },
  ];

  return { ...course, tees };
}

function getDefaultCourses(): Course[] {
  return [
    withTeeOptions({
      id: 'pebble-beach',
      name: 'Pebble Beach Golf Links',
      location: 'Pebble Beach, CA',
      holes: [
        { number: 1, par: 4, yards: 381 },
        { number: 2, par: 5, yards: 502 },
        { number: 3, par: 4, yards: 390 },
        { number: 4, par: 4, yards: 331 },
        { number: 5, par: 3, yards: 195 },
        { number: 6, par: 5, yards: 513 },
        { number: 7, par: 3, yards: 106 },
        { number: 8, par: 4, yards: 428 },
        { number: 9, par: 4, yards: 505 },
        { number: 10, par: 4, yards: 446 },
        { number: 11, par: 4, yards: 380 },
        { number: 12, par: 3, yards: 202 },
        { number: 13, par: 4, yards: 445 },
        { number: 14, par: 5, yards: 580 },
        { number: 15, par: 4, yards: 397 },
        { number: 16, par: 4, yards: 403 },
        { number: 17, par: 3, yards: 178 },
        { number: 18, par: 5, yards: 543 },
      ],
    }),
    withTeeOptions({
      id: 'augusta',
      name: 'Augusta National',
      location: 'Augusta, GA',
      holes: [
        { number: 1, par: 4, yards: 445 },
        { number: 2, par: 5, yards: 575 },
        { number: 3, par: 4, yards: 350 },
        { number: 4, par: 3, yards: 240 },
        { number: 5, par: 4, yards: 495 },
        { number: 6, par: 3, yards: 180 },
        { number: 7, par: 4, yards: 450 },
        { number: 8, par: 5, yards: 570 },
        { number: 9, par: 4, yards: 460 },
        { number: 10, par: 4, yards: 495 },
        { number: 11, par: 4, yards: 520 },
        { number: 12, par: 3, yards: 155 },
        { number: 13, par: 5, yards: 510 },
        { number: 14, par: 4, yards: 440 },
        { number: 15, par: 5, yards: 550 },
        { number: 16, par: 3, yards: 170 },
        { number: 17, par: 4, yards: 440 },
        { number: 18, par: 4, yards: 465 },
      ],
    }),
  ];
}

// -----------------
// Tournaments
// -----------------
export function getTournaments(): Tournament[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(TOURNAMENTS_KEY);
  return data ? JSON.parse(data) : [];
}

export function getTournament(id: string): Tournament | null {
  const tournaments = getTournaments();
  return tournaments.find(t => t.id === id) || null;
}

export function saveTournament(tournament: Tournament): void {
  const tournaments = getTournaments();
  const index = tournaments.findIndex(t => t.id === tournament.id);

  if (index >= 0) {
    tournaments[index] = tournament;
  } else {
    tournaments.unshift(tournament);
  }

  localStorage.setItem(TOURNAMENTS_KEY, JSON.stringify(tournaments));
}

export function deleteTournament(id: string): void {
  const tournaments = getTournaments().filter(t => t.id !== id);
  localStorage.setItem(TOURNAMENTS_KEY, JSON.stringify(tournaments));
}

export function addRoundToTournament(tournamentId: string, roundId: string): void {
  const tournament = getTournament(tournamentId);
  if (!tournament) return;
  if (!tournament.roundIds.includes(roundId)) {
    tournament.roundIds = [...tournament.roundIds, roundId];
    saveTournament(tournament);
  }
}

export function addPlayerToTournament(tournamentId: string, player: { id: string; name: string }): void {
  const tournament = getTournament(tournamentId);
  if (!tournament) return;

  const name = player.name.trim();
  if (!name) return;

  if (!tournament.playerIds.includes(player.id)) {
    tournament.playerIds = [...tournament.playerIds, player.id];
  }

  tournament.playerNamesById = {
    ...(tournament.playerNamesById ?? {}),
    [player.id]: name,
  };

  saveTournament(tournament);
}

// -----------------
// Golfer profile
// -----------------
export function getGolferProfile(): GolferProfile | null {
  if (typeof window === 'undefined') return null;
  const data = localStorage.getItem(PROFILE_KEY);
  return data ? (JSON.parse(data) as GolferProfile) : null;
}

export function saveGolferProfile(profile: GolferProfile): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

// Initialize with defaults
export function initializeStorage(): void {
  if (typeof window === 'undefined') return;

  if (!localStorage.getItem(COURSES_KEY)) {
    localStorage.setItem(COURSES_KEY, JSON.stringify(getDefaultCourses()));
  }

  if (!localStorage.getItem(TOURNAMENTS_KEY)) {
    localStorage.setItem(TOURNAMENTS_KEY, JSON.stringify([]));
  }
}
