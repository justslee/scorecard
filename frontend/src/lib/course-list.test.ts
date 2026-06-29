import { describe, it, expect } from 'vitest';
import { mapRecentCourses } from './course-list';
import { courseHref } from './course-url';

describe('mapRecentCourses', () => {
  it('maps a row to the correct shape', () => {
    const rows = [{ id: 42, name: 'Bethpage Black', clubName: 'Bethpage' }];
    const items = mapRecentCourses(rows);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '42',
      title: 'Bethpage Black',
      subtitle: 'Bethpage',
      href: courseHref({ courseId: 42 }),
    });
  });

  it('blanks subtitle when clubName equals name', () => {
    const rows = [{ id: '1', name: 'Pebble Beach', clubName: 'Pebble Beach' }];
    const items = mapRecentCourses(rows);
    expect(items[0].subtitle).toBe('');
  });

  it('keeps subtitle when clubName differs from name', () => {
    const rows = [{ id: '2', name: 'The Black Course', clubName: 'Bethpage State Park' }];
    const items = mapRecentCourses(rows);
    expect(items[0].subtitle).toBe('Bethpage State Park');
  });

  it('stringifies numeric ids', () => {
    const rows = [{ id: 99, name: 'Augusta National', clubName: 'Augusta National' }];
    const items = mapRecentCourses(rows);
    expect(items[0].id).toBe('99');
  });

  it('builds href using courseHref (no clubId)', () => {
    const rows = [{ id: 55, name: 'Shinnecock Hills', clubName: 'Shinnecock Hills' }];
    const items = mapRecentCourses(rows);
    expect(items[0].href).toBe(courseHref({ courseId: 55 }));
  });

  it('returns an empty array for empty input', () => {
    expect(mapRecentCourses([])).toEqual([]);
  });

  it('maps multiple rows preserving order', () => {
    const rows = [
      { id: 1, name: 'A', clubName: 'Club A' },
      { id: 2, name: 'B', clubName: 'B' },
    ];
    const items = mapRecentCourses(rows);
    expect(items[0].id).toBe('1');
    expect(items[1].id).toBe('2');
    expect(items[1].subtitle).toBe('');
  });
});
