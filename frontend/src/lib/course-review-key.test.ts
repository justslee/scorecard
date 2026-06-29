/**
 * Unit tests for course-review-key helpers.
 * Pure functions — no DOM, no React, safe in vitest node environment.
 */

import { describe, it, expect } from 'vitest';
import { normalizeCourseName, resolveCourseKey } from './course-review-key';

// ─────────────────────────────────────────────────────────────────────────────
// normalizeCourseName
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeCourseName', () => {
  it('lowercases and trims', () => {
    expect(normalizeCourseName('  Pebble Beach  ')).toBe('pebble-beach');
  });

  it('replaces slashes with dashes', () => {
    const result = normalizeCourseName('Pebble Beach / Old Course');
    expect(result).toBe('pebble-beach-old-course');
    expect(result).not.toContain('/');
  });

  it('collapses multiple non-alnum runs into a single dash', () => {
    expect(normalizeCourseName('TPC  --  Sawgrass')).toBe('tpc-sawgrass');
  });

  it('strips leading/trailing dashes', () => {
    expect(normalizeCourseName('---Augusta---')).toBe('augusta');
  });

  it('handles empty string', () => {
    expect(normalizeCourseName('')).toBe('');
  });

  it('handles purely punctuation', () => {
    // Only non-alnum chars → all become dashes → stripped → empty string
    expect(normalizeCourseName('!!!')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCourseKey
// ─────────────────────────────────────────────────────────────────────────────

const RECENT = [
  { id: 42, name: 'Pebble Beach', clubName: 'Pebble Beach Golf Links' },
  { id: 99, name: 'Augusta National', clubName: 'Augusta National Golf Club' },
];

describe('resolveCourseKey', () => {
  it('returns null for empty courseName', () => {
    expect(resolveCourseKey({ courseName: '' }, RECENT)).toBeNull();
  });

  it('returns null for whitespace-only courseName', () => {
    expect(resolveCourseKey({ courseName: '   ' }, RECENT)).toBeNull();
  });

  it('returns null for null courseName', () => {
    expect(resolveCourseKey({ courseName: null }, RECENT)).toBeNull();
  });

  it('returns null for undefined courseName', () => {
    expect(resolveCourseKey({}, RECENT)).toBeNull();
  });

  it('matches by name and returns the GolfAPI id as string', () => {
    const key = resolveCourseKey({ courseName: 'Pebble Beach' }, RECENT);
    expect(key).toBe('42');
  });

  it('matches by clubName and returns the GolfAPI id as string', () => {
    const key = resolveCourseKey(
      { courseName: 'Pebble Beach Golf Links' },
      RECENT,
    );
    expect(key).toBe('42');
  });

  it('returns name: fallback when no recent match', () => {
    const key = resolveCourseKey({ courseName: 'Torrey Pines' }, RECENT);
    expect(key).toBe('name:torrey-pines');
  });

  it('name: fallback is slash-free for a name containing a slash', () => {
    const key = resolveCourseKey(
      { courseName: 'Pebble Beach / Old Course' },
      [],
    );
    // Should produce name:pebble-beach-old-course — no '/' in the key
    expect(key).toBe('name:pebble-beach-old-course');
    expect(key).not.toContain('/');
  });

  it('coerces numeric id to string', () => {
    const recent = [{ id: 7, name: 'TPC Sawgrass', clubName: '' }];
    const key = resolveCourseKey({ courseName: 'TPC Sawgrass' }, recent);
    expect(key).toBe('7');
    expect(typeof key).toBe('string');
  });

  it('returns name: fallback when recent is empty', () => {
    const key = resolveCourseKey({ courseName: 'Augusta National' }, []);
    expect(key).toBe('name:augusta-national');
  });

  it('matching is case-insensitive', () => {
    const key = resolveCourseKey({ courseName: 'pebble beach' }, RECENT);
    expect(key).toBe('42');
  });
});
