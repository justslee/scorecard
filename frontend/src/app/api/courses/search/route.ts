import { NextRequest, NextResponse } from 'next/server';

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

interface SearchResult {
  id: string;
  name: string;
  address?: string;
  center: { lat: number; lng: number };
  source: 'mapbox' | 'osm';
  boundary?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

// Search Mapbox for places (works better for finding locations)
async function searchMapbox(query: string): Promise<SearchResult[]> {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=10&access_token=${MAPBOX_TOKEN}`;
  
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    
    return (data.features || []).map((f: any) => ({
      id: `mapbox-${f.id}`,
      name: f.text || f.place_name?.split(',')[0] || query,
      address: f.place_name,
      center: { lng: f.center[0], lat: f.center[1] },
      source: 'mapbox' as const,
    }));
  } catch {
    return [];
  }
}

// Search OSM for golf courses by name OR near a location
async function searchOSM(params: { name?: string; lat?: number; lng?: number; radius?: number }): Promise<SearchResult[]> {
  const { name, lat, lng, radius = 10000 } = params;
  
  let aroundClause = '';
  if (lat != null && lng != null) {
    aroundClause = `(around:${radius},${lat},${lng})`;
  }
  
  const nameFilter = name ? `["name"~"${name.replace(/['"]/g, '')}",i]` : '';
  
  if (!nameFilter && !aroundClause) return [];
  
  // Simpler query - just get centers first for speed
  const query = `
[out:json][timeout:8];
(
  way["leisure"="golf_course"]${nameFilter}${aroundClause};
  relation["leisure"="golf_course"]${nameFilter}${aroundClause};
);
out center;
`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const data = await res.json();
    
    return (data.elements || [])
      .filter((el: any) => el.tags?.leisure === 'golf_course' && el.center)
      .map((el: any) => ({
        id: `osm-${el.type}-${el.id}`,
        name: el.tags?.name || 'Golf Course',
        address: [el.tags?.['addr:city'], el.tags?.['addr:state']].filter(Boolean).join(', ') || undefined,
        center: { lat: el.center.lat, lng: el.center.lon },
        source: 'osm' as const,
        osmId: `${el.type}/${el.id}`, // for fetching boundary later
      }))
      .slice(0, 15);
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim() || '';
  
  if (!q) {
    return NextResponse.json({ error: 'Provide q (search query)' }, { status: 400 });
  }
  
  // Strategy: 
  // 1. Search Mapbox for the location (reliable for addresses/places)
  // 2. Search OSM for golf courses by name
  // 3. If we found a Mapbox location, also search OSM for golf courses nearby
  
  const [mapboxResults, osmNameResults] = await Promise.all([
    searchMapbox(q + ' golf'),
    searchOSM({ name: q }),
  ]);
  
  // If we found Mapbox results, search for golf courses near the top result
  let osmNearbyResults: SearchResult[] = [];
  if (mapboxResults.length > 0) {
    const topResult = mapboxResults[0];
    osmNearbyResults = await searchOSM({ 
      lat: topResult.center.lat, 
      lng: topResult.center.lng, 
      radius: 15000 // 15km radius
    });
  }
  
  // Dedupe and merge results
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  
  // Prioritize OSM results with boundaries
  for (const r of [...osmNameResults, ...osmNearbyResults]) {
    const key = `${r.center.lat.toFixed(4)},${r.center.lng.toFixed(4)}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(r);
    }
  }
  
  // Add Mapbox results as fallback (for zooming to location)
  for (const r of mapboxResults) {
    const key = `${r.center.lat.toFixed(4)},${r.center.lng.toFixed(4)}`;
    if (!seen.has(key) && results.length < 15) {
      seen.add(key);
      results.push(r);
    }
  }
  
  return NextResponse.json({ 
    courses: results.slice(0, 15),
    query: q,
  });
}
