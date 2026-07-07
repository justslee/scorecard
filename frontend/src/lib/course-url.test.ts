import { describe, it, expect } from 'vitest';
import { courseHref, courseDetailHref, COURSE_VIEW_SEGMENT } from './course-url';

describe('courseHref', () => {
  it('builds a basic href without clubId', () => {
    expect(courseHref({ courseId: 123 })).toBe(`/courses/${COURSE_VIEW_SEGMENT}?id=123`);
  });

  it('includes clubId when provided', () => {
    expect(courseHref({ courseId: 123, clubId: 45 })).toBe(
      `/courses/${COURSE_VIEW_SEGMENT}?id=123&clubId=45`
    );
  });

  it('omits clubId when it is an empty string', () => {
    expect(courseHref({ courseId: 123, clubId: '' })).toBe(
      `/courses/${COURSE_VIEW_SEGMENT}?id=123`
    );
  });

  it('encodes a courseId containing a space', () => {
    const href = courseHref({ courseId: 'Bethpage Black' });
    expect(href).toBe(`/courses/${COURSE_VIEW_SEGMENT}?id=Bethpage%20Black`);
  });

  it('encodes a courseId containing an ampersand', () => {
    const href = courseHref({ courseId: 'a&b' });
    expect(href).toBe(`/courses/${COURSE_VIEW_SEGMENT}?id=a%26b`);
  });

  it('encodes a courseId with unicode', () => {
    const href = courseHref({ courseId: 'café' });
    expect(href).toBe(`/courses/${COURSE_VIEW_SEGMENT}?id=caf%C3%A9`);
  });

  it('encodes a clubId containing special characters', () => {
    const href = courseHref({ courseId: 1, clubId: 'club&id' });
    expect(href).toBe(`/courses/${COURSE_VIEW_SEGMENT}?id=1&clubId=club%26id`);
  });

  it('stringifies numeric ids', () => {
    expect(courseHref({ courseId: 0 })).toBe(`/courses/${COURSE_VIEW_SEGMENT}?id=0`);
  });
});

// The unified select-handler mapping: EVERY search selection lands on the
// detail page (/courses/view), never on the bare /map/course viewer.
describe('courseDetailHref', () => {
  const CENTER = { lat: 40.7362, lng: -73.4551 };

  it('routes a mapped course to detail with src=mapped', () => {
    const href = courseDetailHref({
      id: '2b8caab5-2c55-5752-8cda-336c3a396dac',
      source: 'mapped',
      name: 'Bethpage Black',
      center: CENTER,
    });
    expect(href).toBe(
      `/courses/${COURSE_VIEW_SEGMENT}?id=2b8caab5-2c55-5752-8cda-336c3a396dac&src=mapped`
    );
  });

  it('routes an OSM course with a centre to detail carrying the display params', () => {
    const href = courseDetailHref({
      id: 'osm-123',
      source: 'osm',
      name: 'Bethpage Red',
      location: 'Farmingdale, NY',
      center: CENTER,
    });
    const url = new URL(`https://x${href}`);
    expect(url.pathname).toBe(`/courses/${COURSE_VIEW_SEGMENT}`);
    expect(url.searchParams.get('id')).toBe('osm-123');
    expect(url.searchParams.get('src')).toBe('osm');
    expect(url.searchParams.get('name')).toBe('Bethpage Red');
    expect(url.searchParams.get('lat')).toBe('40.7362');
    expect(url.searchParams.get('lng')).toBe('-73.4551');
    expect(url.searchParams.get('loc')).toBe('Farmingdale, NY');
  });

  it('omits loc when no location is known', () => {
    const href = courseDetailHref({
      id: 'osm-9',
      source: 'local',
      name: 'X',
      center: CENTER,
    });
    expect(href).not.toContain('loc=');
  });

  it('routes a golfapi course exactly like courseHref (id + clubId)', () => {
    expect(
      courseDetailHref({ id: 123, clubId: 45, source: 'golfapi', center: CENTER })
    ).toBe(courseHref({ courseId: 123, clubId: 45 }));
  });

  it('routes a sourceless selection (favorites) like courseHref', () => {
    expect(courseDetailHref({ id: 7 })).toBe(courseHref({ courseId: 7 }));
  });

  it('falls back to the golfapi path for a non-golfapi source WITHOUT a centre', () => {
    expect(courseDetailHref({ id: 'osm-1', source: 'osm', name: 'Y' })).toBe(
      courseHref({ courseId: 'osm-1' })
    );
  });

  it('never routes to /map/course', () => {
    const cases = [
      courseDetailHref({ id: 'u', source: 'mapped' }),
      courseDetailHref({ id: 'o', source: 'osm', center: CENTER }),
      courseDetailHref({ id: 1, source: 'golfapi' }),
      courseDetailHref({ id: 2 }),
    ];
    for (const href of cases) {
      expect(href.startsWith(`/courses/${COURSE_VIEW_SEGMENT}?`)).toBe(true);
    }
  });
});
