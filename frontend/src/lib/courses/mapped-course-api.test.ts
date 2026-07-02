import { describe, it, expect } from 'vitest';
import { mappedCourseToCoordinates } from './mapped-course-api';
import type { CourseData, HoleData } from './types';

function feat(featureType: string, geometry: GeoJSON.Geometry): GeoJSON.Feature {
  return { type: 'Feature', geometry, properties: { featureType } } as GeoJSON.Feature;
}

function hole(number: number, features: GeoJSON.Feature[]): HoleData {
  return {
    number,
    par: 4,
    handicap: number,
    yardages: {},
    features: { type: 'FeatureCollection', features },
  };
}

function course(holes: HoleData[]): CourseData {
  return { id: 'c1', name: 'Test', location: { lat: 0, lng: 0 }, holes } as CourseData;
}

// A square polygon centered on (lat, lng).
function square(lat: number, lng: number): GeoJSON.Polygon {
  const d = 0.0005;
  return {
    type: 'Polygon',
    coordinates: [[
      [lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d],
    ]],
  };
}

describe('mappedCourseToCoordinates', () => {
  it('uses polygon centroids for green + tee when present', () => {
    const c = course([hole(1, [
      feat('green', square(40.7451, -73.4514)),
      feat('tee', square(40.7430, -73.4546)),
    ])]);
    const out = mappedCourseToCoordinates(c);
    expect(out).toHaveLength(1);
    expect(out[0].green.lat).toBeCloseTo(40.7451, 3);
    expect(out[0].tee!.lat).toBeCloseTo(40.7430, 3);
  });

  it('derives green + tee from the hole centerline when polygons are absent (the fix)', () => {
    // A hole with ONLY a golf=hole LineString: first point = tee, last = green.
    const c = course([hole(2, [
      feat('hole', {
        type: 'LineString',
        coordinates: [[-73.4546, 40.7430], [-73.4530, 40.7440], [-73.4514, 40.7451]],
      }),
    ])]);
    const out = mappedCourseToCoordinates(c);
    expect(out).toHaveLength(1);
    // last coord → green, first coord → tee
    expect(out[0].green).toEqual({ lat: 40.7451, lng: -73.4514 });
    expect(out[0].tee).toEqual({ lat: 40.7430, lng: -73.4546 });
  });

  it('prefers the polygon green but still fills the tee from the centerline', () => {
    const c = course([hole(3, [
      feat('green', square(40.7460, -73.4500)),
      feat('hole', { type: 'LineString', coordinates: [[-73.4546, 40.7430], [-73.4500, 40.7460]] }),
    ])]);
    const out = mappedCourseToCoordinates(c);
    expect(out[0].green.lat).toBeCloseTo(40.7460, 3); // polygon centroid wins
    expect(out[0].tee).toEqual({ lat: 40.7430, lng: -73.4546 }); // centerline start
  });

  it('skips holes with no derivable green', () => {
    const c = course([hole(4, [feat('bunker', square(40.7440, -73.4520))])]);
    expect(mappedCourseToCoordinates(c)).toHaveLength(0);
  });
});
