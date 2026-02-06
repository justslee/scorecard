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
  // 1. Search OSM for golf courses by name (primary - most relevant)
  // 2. Search Mapbox for location as fallback
  // 3. If no OSM results but Mapbox found something, search OSM nearby
  
  // Run OSM name search first (most relevant for golf courses)
  const osmNameResults = await searchOSM({ name: q });
  
  // If OSM found results, return those
  if (osmNameResults.length > 0) {
    return NextResponse.json({ 
      courses: osmNameResults,
      query: q,
    });
  }
  
  // Fallback: use Mapbox to find location, then search OSM nearby
  const mapboxResults = await searchMapbox(q);
  
  if (mapboxResults.length > 0) {
    const topResult = mapboxResults[0];
    const osmNearbyResults = await searchOSM({ 
      lat: topResult.center.lat, 
      lng: topResult.center.lng, 
      radius: 20000 // 20km radius
    });
    
    if (osmNearbyResults.length > 0) {
      return NextResponse.json({ 
        courses: osmNearbyResults,
        query: q,
        searchedNear: topResult.name,
      });
    }
  }
  
  // Last resort: return Mapbox results so user can at least zoom to area
  const results = mapboxResults.slice(0, 10);
  
  return NextResponse.json({ 
    courses: results.slice(0, 15),
    query: q,
  });
}
