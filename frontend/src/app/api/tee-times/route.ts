import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

type TeeTime = {
  id: string;
  courseId: string;
  courseName: string;
  city: string;
  date: string;
  time: string;
  players: number;
  priceUsd: number;
  cartIncluded: boolean;
  distanceMiles: number;
  rating: number;
  designer?: string;
};

const COURSES = [
  { id: 'pebble', name: 'Pebble Beach Golf Links', city: 'Pebble Beach, CA', designer: 'Jack Neville', rating: 4.9, miles: 18 },
  { id: 'spyglass', name: 'Spyglass Hill', city: 'Pebble Beach, CA', designer: 'Robert Trent Jones', rating: 4.8, miles: 22 },
  { id: 'spanish', name: 'Spanish Bay', city: 'Pebble Beach, CA', designer: 'Tom Watson', rating: 4.6, miles: 20 },
  { id: 'harding', name: 'Harding Park', city: 'San Francisco, CA', designer: 'Willie Watson', rating: 4.5, miles: 3 },
  { id: 'presidio', name: 'The Presidio', city: 'San Francisco, CA', designer: 'Robert Johnstone', rating: 4.3, miles: 2 },
  { id: 'olympic', name: 'The Olympic Club — Lake', city: 'San Francisco, CA', designer: 'Willie Watson', rating: 4.8, miles: 5 },
  { id: 'poppy-hills', name: 'Poppy Hills', city: 'Pebble Beach, CA', designer: 'Robert Trent Jones Jr.', rating: 4.4, miles: 21 },
  { id: 'half-moon', name: 'Half Moon Bay — Old Course', city: 'Half Moon Bay, CA', designer: 'Arnold Palmer', rating: 4.5, miles: 12 },
];

function seededRandom(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 13), 2246822507);
    h = Math.imul(h ^ (h >>> 16), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function buildTimes(query: string, players: number, date: string): TeeTime[] {
  const rand = seededRandom(`${query}|${players}|${date}`);
  const times: string[] = [];
  // morning slots 6:10 - 11:50 in 10-min grid, sample ~12
  for (let h = 6; h <= 13; h++) {
    for (let m of [0, 10, 20, 30, 40, 50]) {
      times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }

  const picked: TeeTime[] = [];
  const filtered = query
    ? COURSES.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()) || c.city.toLowerCase().includes(query.toLowerCase()))
    : COURSES;
  const list = filtered.length ? filtered : COURSES;

  for (const course of list) {
    const slots = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < slots; i++) {
      const time = times[Math.floor(rand() * times.length)];
      picked.push({
        id: `${course.id}-${date}-${time}-${i}`,
        courseId: course.id,
        courseName: course.name,
        city: course.city,
        date,
        time,
        players,
        priceUsd: 65 + Math.floor(rand() * 220),
        cartIncluded: rand() > 0.3,
        distanceMiles: course.miles,
        rating: course.rating,
        designer: course.designer,
      });
    }
  }

  return picked.sort((a, b) => a.time.localeCompare(b.time)).slice(0, 12);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const players = Math.max(1, Math.min(4, Number(url.searchParams.get('players') ?? 2)));

  const results = buildTimes(q, players, date);
  await new Promise((r) => setTimeout(r, 180));

  return NextResponse.json({
    query: q,
    date,
    players,
    results,
  });
}
