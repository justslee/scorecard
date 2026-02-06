import { NextRequest, NextResponse } from 'next/server';

// OSM Overpass endpoint (public)
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

type OverpassElement =
  | {
      type: 'way';
      id: number;
      tags?: Record<string, string>;
      // out geom
      geometry?: Array<{ lat: number; lon: number }>;
      center?: { lat: number; lon: number };
    }
  | {
      type: 'relation';
      id: number;
      tags?: Record<string, string>;
      members?: Array<{
        type: string;
        role: string;
        geometry?: Array<{ lat: number; lon: number }>;
      }>;
      center?: { lat: number; lon: number };
    };

function bboxFromGeom(coords: Array<{ lat: number; lon: number }>) {
  let minLat = Infinity,
    minLon = Infinity,
    maxLat = -Infinity,
    maxLon = -Infinity;
  for (const p of coords) {
    minLat = Math.min(minLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLat = Math.max(maxLat, p.lat);
    maxLon = Math.max(maxLon, p.lon);
  }
  return { minLat, minLon, maxLat, maxLon };
}

function asGeoJSONPolygonFromWay(el: Extract<OverpassElement, { type: 'way' }>) {
  const geom = el.geometry || [];
  if (geom.length < 4) return null;
  // Ensure closed
  const ring = geom.map((p) => [p.lon, p.lat] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);

  return {
    type: 'Polygon' as const,
    coordinates: [ring],
  };
}

function asGeoJSONMultiPolygonFromRelation(el: Extract<OverpassElement, { type: 'relation' }>) {
  // Many golf_course boundaries are relations with outer members
  const outers = (el.members || []).filter((m) => m.role === 'outer' && m.geometry?.length);
  if (!outers.length) return null;

  const polys: Array<Array<Array<[number, number]>>> = [];
  for (const m of outers) {
    const ring = (m.geometry || []).map((p) => [p.lon, p.lat] as [number, number]);
    if (ring.length < 4) continue;
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    polys.push([ring]);
  }
  if (!polys.length) return null;
  return {
    type: 'MultiPolygon' as const,
    coordinates: polys,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim() || '';
  const latStr = searchParams.get('lat');
  const lngStr = searchParams.get('lng');
  const radiusStr = searchParams.get('radiusMeters');

  const radius = Math.max(5000, Math.min(100000, Number(radiusStr || 50000)));

  let aroundClause = '';
  if (latStr && lngStr) {
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      aroundClause = `(around:${radius},${lat},${lng})`;
    }
  }

  if (!q && !aroundClause) {
    return NextResponse.json(
      { error: 'Provide q (name) or lat/lng for nearby search' },
      { status: 400 }
    );
  }

  // Prefer relations/ways tagged leisure=golf_course.
  // Use out center + geom for ways, out geom for relations members.
  const nameFilter = q ? `["name"~"${q.replace(/"/g, '')}",i]` : '';

  const overpassQuery = `
[out:json][timeout:25];
(
  way["leisure"="golf_course"]${nameFilter}${aroundClause};
  relation["leisure"="golf_course"]${nameFilter}${aroundClause};
);
out center;
>;
out geom;
`;

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: `data=${encodeURIComponent(overpassQuery)}`,
      // Next.js route handler runs on server; allow caching off
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Overpass error (${res.status})`, details: text.slice(0, 500) },
        { status: 502 }
      );
    }

    const data = (await res.json()) as { elements?: OverpassElement[] };
    const elements = data.elements || [];

    // Only keep golf_course items
    const courseEls = elements.filter(
      (e) => (e.type === 'way' || e.type === 'relation') && e.tags?.leisure === 'golf_course'
    ) as OverpassElement[];

    const results = courseEls
      .map((el) => {
        const name = el.tags?.name || '(Unnamed golf course)';
        const geojson =
          el.type === 'way'
            ? asGeoJSONPolygonFromWay(el)
            : asGeoJSONMultiPolygonFromRelation(el);
        if (!geojson) return null;

        // Compute center from bbox if not provided
        let center = el.center;
        if (!center) {
          if (el.type === 'way' && el.geometry?.length) {
            const bb = bboxFromGeom(el.geometry);
            center = { lat: (bb.minLat + bb.maxLat) / 2, lon: (bb.minLon + bb.maxLon) / 2 };
          } else if (el.type === 'relation') {
            const firstOuter = (el.members || []).find((m) => m.role === 'outer' && m.geometry);
            if (firstOuter?.geometry?.length) {
              const bb = bboxFromGeom(firstOuter.geometry);
              center = { lat: (bb.minLat + bb.maxLat) / 2, lon: (bb.minLon + bb.maxLon) / 2 };
            }
          }
        }

        return {
          osmId: `${el.type}/${el.id}`,
          name,
          center: center ? { lat: center.lat, lng: center.lon } : undefined,
          boundary: geojson,
          tags: el.tags || {},
        };
      })
      .filter(Boolean)
      .slice(0, 25);

    return NextResponse.json({ courses: results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to query Overpass' },
      { status: 500 }
    );
  }
}
