import { describe, it, expect } from 'vitest';
import { courseHref, COURSE_VIEW_SEGMENT } from './course-url';

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
