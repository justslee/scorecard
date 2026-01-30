'use client';

import { Round, Course, Player } from './types';

const ROUNDS_KEY = 'scorecard_rounds';
const COURSES_KEY = 'scorecard_courses';

// Rounds
export function getRounds(): Round[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(ROUNDS_KEY);
  return data ? JSON.parse(data) : [];
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
}

// Courses
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

function getDefaultCourses(): Course[] {
  return [
    {
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
    },
    {
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
    },
  ];
}

// Initialize with defaults
export function initializeStorage(): void {
  if (typeof window === 'undefined') return;
  
  if (!localStorage.getItem(COURSES_KEY)) {
    localStorage.setItem(COURSES_KEY, JSON.stringify(getDefaultCourses()));
  }
}
