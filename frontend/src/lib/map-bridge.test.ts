/**
 * Unit tests for map-bridge helpers.
 * Pure functions — no DOM, no React, safe in vitest node environment.
 */

import { describe, it, expect } from 'vitest';
import {
  clampHole,
  parseHoleParam,
  resolveMappedCourse,
  buildMapUrl,
} from './map-bridge';
import type { MappedCourseListItem } from './map-bridge';

// ─────────────────────────────────────────────────────────────────────────────
// clampHole
// ─────────────────────────────────────────────────────────────────────────────

describe('clampHole', () => {
  it('clamps below-1 input to 1', () => {
    expect(clampHole(0)).toBe(1);
    expect(clampHole(-5)).toBe(1);
  });

  it('clamps above-18 to 18 by default', () => {
    expect(clampHole(19)).toBe(18);
    expect(clampHole(100)).toBe(18);
  });

  it('passes valid in-range values through', () => {
    expect(clampHole(1)).toBe(1);
    expect(clampHole(9)).toBe(9);
    expect(clampHole(18)).toBe(18);
  });

  it('rounds floats before clamping', () => {
    expect(clampHole(4.7)).toBe(5);
    expect(clampHole(4.2)).toBe(4);
  });

  it('respects a custom totalHoles upper bound', () => {
    expect(clampHole(10, 9)).toBe(9);
    expect(clampHole(5, 9)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseHoleParam
// ─────────────────────────────────────────────────────────────────────────────

describe('parseHoleParam', () => {
  it('returns null for absent param (null input)', () => {
    expect(parseHoleParam(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseHoleParam('')).toBeNull();
    expect(parseHoleParam('  ')).toBeNull();
  });

  it('returns null for non-numeric string', () => {
    expect(parseHoleParam('abc')).toBeNull();
    expect(parseHoleParam('hole7')).toBeNull();
  });

  it('parses a valid hole number', () => {
    expect(parseHoleParam('7')).toBe(7);
    expect(parseHoleParam('18')).toBe(18);
    expect(parseHoleParam('1')).toBe(1);
  });

  it('clamps out-of-range values', () => {
    expect(parseHoleParam('0')).toBe(1);
    expect(parseHoleParam('25')).toBe(18);
    expect(parseHoleParam('-3')).toBe(1);
  });

  it('parses float strings (rounds)', () => {
    expect(parseHoleParam('4.7')).toBe(5);
  });

  it('respects custom totalHoles', () => {
    expect(parseHoleParam('10', 9)).toBe(9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveMappedCourse
// ─────────────────────────────────────────────────────────────────────────────

const MAPPED: MappedCourseListItem[] = [
  { id: 'uuid-bethpage-black', name: 'Bethpage Black' },
  { id: 'uuid-pebble',         name: 'Pebble Beach Golf Links' },
  { id: 'uuid-augusta',        name: 'Augusta National' },
];

describe('resolveMappedCourse', () => {
  it('returns null for empty courseName', () => {
    expect(resolveMappedCourse('', MAPPED)).toBeNull();
  });

  it('returns null for whitespace-only courseName', () => {
    expect(resolveMappedCourse('  ', MAPPED)).toBeNull();
  });

  it('returns null when the courses list is empty', () => {
    expect(resolveMappedCourse('Bethpage Black', [])).toBeNull();
  });

  it('returns null when no match found', () => {
    expect(resolveMappedCourse('Torrey Pines', MAPPED)).toBeNull();
  });

  it('exact match is case-insensitive', () => {
    const result = resolveMappedCourse('bethpage black', MAPPED);
    expect(result?.id).toBe('uuid-bethpage-black');
  });

  it('exact match on a multi-word name', () => {
    const result = resolveMappedCourse('Augusta National', MAPPED);
    expect(result?.id).toBe('uuid-augusta');
  });

  it('prefix match: round name is a prefix of mapped name (≥5 chars)', () => {
    // "Bethpage" is a prefix of "Bethpage Black"
    const result = resolveMappedCourse('Bethpage', MAPPED);
    expect(result?.id).toBe('uuid-bethpage-black');
  });

  it('prefix match ignores short round names (<5 normalized chars)', () => {
    // "TPC" normalizes to "tpc" (3 chars) — too short for prefix match
    const short: MappedCourseListItem[] = [{ id: 'uuid-tpc', name: 'TPC Sawgrass' }];
    expect(resolveMappedCourse('TPC', short)).toBeNull();
  });

  it('exact match beats prefix match — returns exact first', () => {
    // If both "Bethpage" and "Bethpage Black" were mapped, exact match wins
    const both: MappedCourseListItem[] = [
      { id: 'uuid-b-exact', name: 'Bethpage' },
      { id: 'uuid-b-black', name: 'Bethpage Black' },
    ];
    const result = resolveMappedCourse('Bethpage', both);
    expect(result?.id).toBe('uuid-b-exact');
  });

  it('prefix match handles punctuation-folded names', () => {
    // "Pebble Beach" matches "Pebble Beach Golf Links" via prefix
    const result = resolveMappedCourse('Pebble Beach', MAPPED);
    expect(result?.id).toBe('uuid-pebble');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildMapUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMapUrl', () => {
  it('builds a correct URL for a valid hole', () => {
    const url = buildMapUrl('uuid-bethpage-black', 7);
    expect(url).toBe('/map/course?id=uuid-bethpage-black&hole=7');
  });

  it('clamps hole param in the URL', () => {
    expect(buildMapUrl('uuid-abc', 0)).toBe('/map/course?id=uuid-abc&hole=1');
    expect(buildMapUrl('uuid-abc', 25)).toBe('/map/course?id=uuid-abc&hole=18');
  });

  it('URL-encodes the course id', () => {
    const url = buildMapUrl('uuid with spaces', 3);
    expect(url).toContain('id=uuid%20with%20spaces');
  });
});
