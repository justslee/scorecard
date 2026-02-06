import { getSupabase } from '../supabase';
import { CourseData, CourseListItem, HoleData, TeeSet } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// List courses
// ─────────────────────────────────────────────────────────────────────────────
export async function listCourses(params?: { search?: string }): Promise<CourseListItem[]> {
  const supabase = getSupabase();
  let query = supabase
    .from('courses')
    .select('id, name, address, location, updated_at')
    .order('updated_at', { ascending: false });

  if (params?.search) {
    query = query.or(`name.ilike.%${params.search}%,address.ilike.%${params.search}%`);
  }

  const { data, error } = await query;
  if (error) {
    console.error('listCourses error:', error);
    return [];
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    name: row.name,
    address: row.address,
    location: row.location
      ? { lng: row.location.coordinates[0], lat: row.location.coordinates[1] }
      : undefined,
    updatedAt: row.updated_at,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Get single course with all holes + features
// ─────────────────────────────────────────────────────────────────────────────
export async function getCourse(id: string): Promise<CourseData | null> {
  const supabase = getSupabase();

  // Fetch course
  const { data: courseRow, error: courseErr } = await supabase
    .from('courses')
    .select('*')
    .eq('id', id)
    .single();

  if (courseErr || !courseRow) {
    console.error('getCourse error:', courseErr);
    return null;
  }

  // Fetch tee sets
  const { data: teeSetRows } = await supabase
    .from('tee_sets')
    .select('*')
    .eq('course_id', id);

  const teeSets: TeeSet[] = (teeSetRows || []).map((ts: any) => ({
    name: ts.name,
    color: ts.color || '#888888',
  }));

  // Map tee set name -> id for yardage lookup
  const teeSetIdMap: Record<string, string> = {};
  const teeSetNameMap: Record<string, string> = {};
  (teeSetRows || []).forEach((ts: any) => {
    teeSetIdMap[ts.name] = ts.id;
    teeSetNameMap[ts.id] = ts.name;
  });

  // Fetch holes
  const { data: holeRows } = await supabase
    .from('holes')
    .select('*')
    .eq('course_id', id)
    .order('hole_number', { ascending: true });

  const holeIdMap: Record<number, string> = {};
  (holeRows || []).forEach((h: any) => {
    holeIdMap[h.hole_number] = h.id;
  });

  // Fetch yardages
  const holeIds = Object.values(holeIdMap);
  const { data: yardageRows } = holeIds.length
    ? await supabase.from('hole_yardages').select('*').in('hole_id', holeIds)
    : { data: [] };

  // Fetch features
  const { data: featureRows } = holeIds.length
    ? await supabase.from('hole_features').select('*').in('hole_id', holeIds)
    : { data: [] };

  // Build holes array
  const holes: HoleData[] = (holeRows || []).map((h: any) => {
    const yardages: Record<string, number> = {};
    (yardageRows || [])
      .filter((y: any) => y.hole_id === h.id)
      .forEach((y: any) => {
        const teeName = teeSetNameMap[y.tee_set_id];
        if (teeName) yardages[teeName] = y.yards;
      });

    const features: GeoJSON.Feature[] = (featureRows || [])
      .filter((f: any) => f.hole_id === h.id)
      .map((f: any) => ({
        type: 'Feature' as const,
        id: f.id,
        properties: {
          ...f.properties,
          featureType: f.feature_type,
          hole: h.hole_number,
          teeSet: f.tee_set_id ? teeSetNameMap[f.tee_set_id] : undefined,
        },
        geometry: f.geom,
      }));

    return {
      number: h.hole_number,
      par: h.par,
      handicap: h.handicap || h.hole_number,
      yardages,
      features: { type: 'FeatureCollection' as const, features },
    };
  });

  // Ensure 18 holes exist (fill missing with defaults)
  const holesMap = new Map(holes.map((h) => [h.number, h]));
  const fullHoles: HoleData[] = [];
  for (let i = 1; i <= 18; i++) {
    fullHoles.push(
      holesMap.get(i) || {
        number: i,
        par: 4,
        handicap: i,
        yardages: {},
        features: { type: 'FeatureCollection', features: [] },
      }
    );
  }

  return {
    id: courseRow.id,
    name: courseRow.name,
    address: courseRow.address,
    location: courseRow.location
      ? { lng: courseRow.location.coordinates[0], lat: courseRow.location.coordinates[1] }
      : { lat: 0, lng: 0 },
    teeSets: teeSets.length ? teeSets : [
      { name: 'Black', color: '#1a1a1a' },
      { name: 'Blue', color: '#2563eb' },
      { name: 'White', color: '#e5e5e5' },
      { name: 'Red', color: '#dc2626' },
    ],
    holes: fullHoles,
    createdAt: courseRow.created_at,
    updatedAt: courseRow.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upsert course (create or update)
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertCourse(course: CourseData): Promise<CourseData> {
  const supabase = getSupabase();
  const { id, name, address, location, teeSets, holes } = course;

  // Upsert course row
  const { error: courseErr } = await supabase.from('courses').upsert(
    {
      id,
      name,
      address,
      location: location ? `SRID=4326;POINT(${location.lng} ${location.lat})` : null,
    },
    { onConflict: 'id' }
  );
  if (courseErr) console.error('upsert course error:', courseErr);

  // Upsert tee sets
  for (const ts of teeSets) {
    const { error: tsErr } = await supabase.from('tee_sets').upsert(
      { course_id: id, name: ts.name, color: ts.color },
      { onConflict: 'course_id,name' }
    );
    if (tsErr) console.error('upsert tee_set error:', tsErr);
  }

  // Fetch tee set IDs
  const { data: teeSetRows } = await supabase
    .from('tee_sets')
    .select('id, name')
    .eq('course_id', id);
  const teeSetIdMap: Record<string, string> = {};
  (teeSetRows || []).forEach((ts: any) => {
    teeSetIdMap[ts.name] = ts.id;
  });

  // Upsert holes
  for (const hole of holes) {
    // Check if hole has any data worth saving
    const hasFeatures = hole.features.features.length > 0;
    const hasYardages = Object.values(hole.yardages).some((y) => y > 0);
    if (!hasFeatures && !hasYardages && hole.par === 4) continue;

    const { data: holeRow, error: holeErr } = await supabase
      .from('holes')
      .upsert(
        {
          course_id: id,
          hole_number: hole.number,
          par: hole.par,
          handicap: hole.handicap,
        },
        { onConflict: 'course_id,hole_number' }
      )
      .select('id')
      .single();

    if (holeErr) {
      console.error('upsert hole error:', holeErr);
      continue;
    }
    const holeId = holeRow.id;

    // Upsert yardages
    for (const [teeName, yards] of Object.entries(hole.yardages)) {
      const teeSetId = teeSetIdMap[teeName];
      if (!teeSetId || !yards) continue;
      const { error: yErr } = await supabase.from('hole_yardages').upsert(
        { hole_id: holeId, tee_set_id: teeSetId, yards },
        { onConflict: 'hole_id,tee_set_id' }
      );
      if (yErr) console.error('upsert yardage error:', yErr);
    }

    // Delete existing features for this hole, then insert new ones
    await supabase.from('hole_features').delete().eq('hole_id', holeId);

    for (const feature of hole.features.features) {
      const props = feature.properties || {};
      const featureType = props.featureType || 'green';
      const teeSetId = props.teeSet ? teeSetIdMap[props.teeSet] : null;

      const { error: fErr } = await supabase.from('hole_features').insert({
        hole_id: holeId,
        feature_type: featureType,
        tee_set_id: teeSetId,
        geom: feature.geometry,
        properties: props,
      });
      if (fErr) console.error('insert feature error:', fErr);
    }
  }

  // Return updated course
  return (await getCourse(id)) || course;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete course
// ─────────────────────────────────────────────────────────────────────────────
export async function deleteCourse(
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = getSupabase();
  const { error } = await supabase.from('courses').delete().eq('id', id);
  if (error) {
    console.error('deleteCourse error:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Find nearby courses (PostGIS)
// ─────────────────────────────────────────────────────────────────────────────
export async function findNearbyCourses(params: {
  lat: number;
  lng: number;
  radiusMeters?: number;
}): Promise<CourseListItem[]> {
  const supabase = getSupabase();
  const { lat, lng, radiusMeters = 50000 } = params;

  // Use PostGIS ST_DWithin for efficient radius search
  const { data, error } = await supabase.rpc('find_nearby_courses', {
    p_lat: lat,
    p_lng: lng,
    p_radius_meters: radiusMeters,
  });

  if (error) {
    console.error('findNearbyCourses error:', error);
    // Fallback to listing all
    return listCourses();
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    name: row.name,
    address: row.address,
    location: row.location
      ? { lng: row.location.coordinates[0], lat: row.location.coordinates[1] }
      : undefined,
    updatedAt: row.updated_at,
  }));
}
