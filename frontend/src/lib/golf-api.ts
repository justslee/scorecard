// GolfAPI.io Service
// API Documentation: https://golfapi.io
//
// When running in the browser, routes through /api/golf proxy to keep API key server-side.
// Falls back to direct API calls when proxy is unavailable.

import type { Course, HoleInfo, TeeOption } from './types';
import type { CourseData, TeeSet, HoleData as PgHoleData } from './courses/types';

const API_BASE = "https://golfapi.io/api/v1";
const PROXY_BASE = "/api/golf";

export interface GolfClub {
  id: number | string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  courses?: GolfCourse[];
}

export interface GolfCourse {
  id: number | string;
  name: string;
  holes: number;
  par?: number;
  slope?: number;
  rating?: number;
  tees?: Tee[];
  holeData?: HoleData[];
  hasGPS?: number;
}

export interface Tee {
  id: number | string;
  name: string;
  color?: string;
  slope?: number;
  rating?: number;
  totalYards?: number;
  /** Per-hole yardages for this tee (from backend normalization of length1..length18) */
  holeData?: Array<{ hole: number; yards: number }>;
}

export interface HoleData {
  hole: number;
  par: number;
  strokeIndex?: number;
  yards?: number;
  coordinates?: {
    green?: { lat: number; lng: number };
    tee?: { lat: number; lng: number };
    front?: { lat: number; lng: number };
    back?: { lat: number; lng: number };
  };
}

export interface CourseCoordinates {
  holeNumber: number;
  green: { lat: number; lng: number };
  tee?: { lat: number; lng: number };
  front?: { lat: number; lng: number };
  back?: { lat: number; lng: number };
  /** Optional pin location (if mapped) */
  pin?: { lat: number; lng: number };
  hazards?: Array<{
    type: string;
    lat: number;
    lng: number;
  }>;
}

// ===== Course Name Composition =====

const CLUB_NAME_SUFFIXES = [
  'golf course',
  'golf club',
  'country club',
  'golf links',
  'golf & country club',
  'golf and country club',
  'state park',
  'ny state park',
  'resort',
  'resort & spa',
  'golf resort',
  'municipal golf',
  'public golf',
];

/**
 * Compose a display name from club + course names.
 * "Bethpage NY State Park" + "Black" → "Bethpage Black"
 * "Pebble Beach Golf Links" + "Pebble Beach" → "Pebble Beach"
 */
export function composeCourseName(clubName: string, courseName: string): string {
  if (!clubName || !courseName) return courseName || clubName || 'Unknown Course';

  // If course name already looks like a full name (contains the first
  // significant word of the club), use it as-is.
  let cleanedClub = clubName.trim();
  for (const suffix of CLUB_NAME_SUFFIXES) {
    const re = new RegExp(`\\s*${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    cleanedClub = cleanedClub.replace(re, '');
  }
  cleanedClub = cleanedClub.trim();

  // Get first significant word of cleaned club name (skip short words)
  const clubWords = cleanedClub.split(/\s+/);
  const significantWord = clubWords.find(w => w.length > 2) || clubWords[0];

  if (!significantWord) return courseName;

  // If courseName already contains the significant club word, use courseName as-is
  if (courseName.toLowerCase().includes(significantWord.toLowerCase())) {
    return courseName;
  }

  // Otherwise compose: "Bethpage" + "Black" → "Bethpage Black"
  return `${cleanedClub} ${courseName}`;
}

// ===== API Functions =====

// Search for golf clubs by name or location
export async function searchCourses(query: string): Promise<GolfClub[]> {
  try {
    // Try proxy first (keeps API key server-side)
    const useProxy = typeof window !== "undefined";
    const url = useProxy
      ? `${PROXY_BASE}?action=search&q=${encodeURIComponent(query)}`
      : `${API_BASE}/clubs?search=${encodeURIComponent(query)}`;

    const response = await fetch(url, {
      headers: useProxy ? {} : getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const clubs = data.clubs || data || [];

    // Cache on success
    cacheSearchResults(query, clubs);

    return clubs;
  } catch (error) {
    console.error("Error searching courses:", error);
    return getCachedSearchResults(query);
  }
}

// Get club details including courses
export async function getClubDetails(clubId: number | string): Promise<GolfClub | null> {
  // Cache-first: check localStorage before making API call
  const cached = getCachedClubData(clubId);
  if (cached) return cached;

  try {
    const useProxy = typeof window !== "undefined";
    const url = useProxy
      ? `${PROXY_BASE}?action=club&id=${clubId}`
      : `${API_BASE}/clubs/${clubId}`;

    const response = await fetch(url, {
      headers: useProxy ? {} : getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    cacheClubData(clubId, data);
    return data;
  } catch (error) {
    console.error("Error fetching club details:", error);
    return null;
  }
}

// Get full course details with hole data and coordinates
export async function getCourseDetails(courseId: number | string): Promise<GolfCourse | null> {
  // Cache-first: check localStorage before making API call
  const cached = getCachedCourseData(courseId);
  if (cached) return cached;

  try {
    const useProxy = typeof window !== "undefined";
    const url = useProxy
      ? `${PROXY_BASE}?action=course&id=${courseId}`
      : `${API_BASE}/courses/${courseId}`;

    const response = await fetch(url, {
      headers: useProxy ? {} : getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    cacheCourseData(courseId, data);
    return data;
  } catch (error) {
    console.error("Error fetching course details:", error);
    return null;
  }
}

// Fetch coordinates for a course (separate endpoint)
export async function fetchCourseCoordinates(courseId: number | string): Promise<CourseCoordinates[]> {
  try {
    const useProxy = typeof window !== "undefined";
    const url = useProxy
      ? `${PROXY_BASE}?action=coordinates&id=${courseId}`
      : `${API_BASE}/coordinates/${courseId}`;

    const response = await fetch(url, {
      headers: useProxy ? {} : getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const holeData = data.holeData || [];

    return holeData
      .filter((h: { green?: { lat: number; lng: number } }) => h.green)
      .map((h: { hole: number; green: { lat: number; lng: number }; tee?: { lat: number; lng: number }; front?: { lat: number; lng: number }; back?: { lat: number; lng: number } }) => ({
        holeNumber: h.hole,
        green: h.green,
        tee: h.tee,
        front: h.front,
        back: h.back,
      }));
  } catch (error) {
    console.error("Error fetching course coordinates:", error);
    return [];
  }
}

// Get coordinates for all holes on a course (legacy — uses course detail)
export async function getCourseCoordinates(courseId: number | string): Promise<CourseCoordinates[]> {
  const course = await getCourseDetails(courseId);
  if (!course?.holeData) return [];

  return course.holeData
    .filter((hole) => hole.coordinates?.green)
    .map((hole) => ({
      holeNumber: hole.hole,
      green: hole.coordinates!.green!,
      tee: hole.coordinates?.tee,
      front: hole.coordinates?.front,
      back: hole.coordinates?.back,
    }));
}

// Helper to get API headers
function getHeaders(): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  // Add API key if configured
  const apiKey = process.env.GOLF_API_KEY || process.env.NEXT_PUBLIC_GOLF_API_KEY;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return headers;
}

// ===== Local Storage Caching for Offline Use =====

const CACHE_PREFIX = "golfapi_";
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

function cacheClubData(clubId: number | string, data: GolfClub) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    `${CACHE_PREFIX}club_${clubId}`,
    JSON.stringify({ data, timestamp: Date.now() })
  );
}

function getCachedClubData(clubId: number | string): GolfClub | null {
  if (typeof window === "undefined") return null;
  const cached = localStorage.getItem(`${CACHE_PREFIX}club_${clubId}`);
  if (!cached) return null;

  const { data, timestamp } = JSON.parse(cached);
  if (Date.now() - timestamp > CACHE_DURATION) {
    localStorage.removeItem(`${CACHE_PREFIX}club_${clubId}`);
    return null;
  }
  return data;
}

function cacheCourseData(courseId: number | string, data: GolfCourse) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    `${CACHE_PREFIX}course_${courseId}`,
    JSON.stringify({ data, timestamp: Date.now() })
  );
}

function getCachedCourseData(courseId: number | string): GolfCourse | null {
  if (typeof window === "undefined") return null;
  const cached = localStorage.getItem(`${CACHE_PREFIX}course_${courseId}`);
  if (!cached) return null;

  const { data, timestamp } = JSON.parse(cached);
  if (Date.now() - timestamp > CACHE_DURATION) {
    localStorage.removeItem(`${CACHE_PREFIX}course_${courseId}`);
    return null;
  }
  return data;
}

function cacheSearchResults(query: string, data: GolfClub[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    `${CACHE_PREFIX}search_${query.toLowerCase()}`,
    JSON.stringify({ data, timestamp: Date.now() })
  );
}

function getCachedSearchResults(query: string): GolfClub[] {
  if (typeof window === "undefined") return [];
  const cached = localStorage.getItem(`${CACHE_PREFIX}search_${query.toLowerCase()}`);
  if (!cached) return [];

  const { data, timestamp } = JSON.parse(cached);
  if (Date.now() - timestamp > CACHE_DURATION) {
    localStorage.removeItem(`${CACHE_PREFIX}search_${query.toLowerCase()}`);
    return [];
  }
  return data;
}

// Save recent courses for quick access
export function saveRecentCourse(course: { id: number | string; name: string; clubName: string }) {
  if (typeof window === "undefined") return;

  const recent = getRecentCourses();
  const filtered = recent.filter((c) => String(c.id) !== String(course.id));
  const updated = [course, ...filtered].slice(0, 10); // Keep last 10

  localStorage.setItem(`${CACHE_PREFIX}recent_courses`, JSON.stringify(updated));
}

export function getRecentCourses(): Array<{ id: number | string; name: string; clubName: string }> {
  if (typeof window === "undefined") return [];
  const cached = localStorage.getItem(`${CACHE_PREFIX}recent_courses`);
  return cached ? JSON.parse(cached) : [];
}

// ===== Course Import: Convert GolfAPI data to app models =====

/** Search result combining GolfAPI and OSM data */
export interface CourseSearchResult {
  id: string;
  name: string;
  clubName?: string;
  address?: string;
  city?: string;
  state?: string;
  center?: { lat: number; lng: number };
  source: 'golfapi' | 'osm' | 'mapped' | 'local';
  golfApiClubId?: number | string;
  golfApiCourseId?: number | string;
  courseCount?: number;
  hasCoordinates?: boolean;
}

/** Unified search across GolfAPI, OSM, and local courses */
export async function searchAllCourses(
  query: string,
  options?: { lat?: number; lng?: number }
): Promise<CourseSearchResult[]> {
  const results: CourseSearchResult[] = [];

  // 1. Search GolfAPI
  const golfApiPromise = searchCourses(query).then((clubs) => {
    for (const club of clubs) {
      if (club.courses && club.courses.length > 0) {
        for (const course of club.courses) {
          results.push({
            id: `golfapi-${course.id}`,
            name: composeCourseName(club.name, course.name || club.name),
            clubName: club.name,
            address: club.address,
            city: club.city,
            state: club.state,
            center: club.latitude && club.longitude
              ? { lat: club.latitude, lng: club.longitude }
              : undefined,
            source: 'golfapi',
            golfApiClubId: club.id,
            golfApiCourseId: course.id,
            hasCoordinates: (course.hasGPS ?? 0) > 0,
          });
        }
      } else {
        results.push({
          id: `golfapi-club-${club.id}`,
          name: club.name,
          clubName: club.name,
          address: club.address,
          city: club.city,
          state: club.state,
          center: club.latitude && club.longitude
            ? { lat: club.latitude, lng: club.longitude }
            : undefined,
          source: 'golfapi',
          golfApiClubId: club.id,
          courseCount: club.courses?.length,
        });
      }
    }
  }).catch(() => {});

  // 2. Search OSM / Mapbox via our API
  const osmPromise = fetch(`/api/courses/search?q=${encodeURIComponent(query)}`)
    .then((r) => r.json())
    .then((data) => {
      for (const c of data.courses || []) {
        // Deduplicate against GolfAPI results by name proximity
        const isDupe = results.some(
          (r) => r.name.toLowerCase() === c.name?.toLowerCase()
        );
        if (!isDupe) {
          results.push({
            id: c.id,
            name: c.name,
            address: c.address,
            center: c.center,
            source: 'osm',
          });
        }
      }
    })
    .catch(() => {});

  // 3. Search mapped courses in Supabase
  const mappedPromise = fetch(`/api/courses?search=${encodeURIComponent(query)}`)
    .then((r) => r.json())
    .then((data) => {
      for (const c of data.courses || []) {
        results.push({
          id: c.id,
          name: c.name,
          address: c.address,
          center: c.location,
          source: 'mapped',
          hasCoordinates: true,
        });
      }
    })
    .catch(() => {});

  await Promise.all([golfApiPromise, osmPromise, mappedPromise]);

  // Sort: mapped first (they have full data), then GolfAPI with coords, then rest
  results.sort((a, b) => {
    if (a.source === 'mapped' && b.source !== 'mapped') return -1;
    if (b.source === 'mapped' && a.source !== 'mapped') return 1;
    if (a.hasCoordinates && !b.hasCoordinates) return -1;
    if (b.hasCoordinates && !a.hasCoordinates) return 1;
    return 0;
  });

  return results;
}

/** Convert a GolfAPI course into the app's Course model */
export function golfApiCourseToAppCourse(
  club: GolfClub,
  apiCourse: GolfCourse
): Course {
  // Build base holes from holeData (par + handicap)
  const holes: HoleInfo[] = (apiCourse.holeData || []).map((h) => ({
    number: h.hole,
    par: h.par,
    yards: h.yards,
    handicap: h.strokeIndex,
  }));

  // Fill to expected hole count
  const numHoles = typeof apiCourse.holes === 'number' ? apiCourse.holes : 18;
  while (holes.length < numHoles) {
    holes.push({ number: holes.length + 1, par: 4 });
  }

  // Build tees from normalized tee data (each tee has holeData with per-hole yards)
  const tees: TeeOption[] = (apiCourse.tees || []).map((t) => {
    // Merge base hole info with tee-specific yardages
    const teeHoles: HoleInfo[] = holes.map((baseHole) => {
      const teeHoleData = t.holeData?.find((th) => th.hole === baseHole.number);
      return {
        ...baseHole,
        yards: teeHoleData?.yards ?? baseHole.yards,
      };
    });

    return {
      id: `golfapi-tee-${t.id}`,
      name: t.name || 'Unknown',
      color: t.color,
      slope: t.slope,
      rating: t.rating,
      totalYards: t.totalYards,
      holes: teeHoles,
    };
  });

  // Default tees if none provided
  if (tees.length === 0) {
    tees.push(
      { id: crypto.randomUUID(), name: 'Blue', holes: holes.map((h) => ({ ...h })) },
      { id: crypto.randomUUID(), name: 'White', holes: holes.map((h) => ({ ...h })) },
      { id: crypto.randomUUID(), name: 'Red', holes: holes.map((h) => ({ ...h })) },
    );
  }

  const courseName = composeCourseName(club.name, apiCourse.name || club.name);

  return {
    id: `golfapi-${apiCourse.id}`,
    name: courseName,
    holes,
    tees,
    location: [club.city, club.state].filter(Boolean).join(', ') || club.address,
    golfApiCourseId: apiCourse.id,
    golfApiClubId: club.id,
  };
}

// ===== Postgres Persistence =====

/** Convert app Course model to Postgres CourseData for upsertCourse() */
function courseToPostgresData(course: Course): CourseData {
  // Extract unique tee sets
  const teeSets: TeeSet[] = (course.tees || []).map((t) => ({
    name: t.name,
    color: t.color || '#888888',
  }));

  // Build holes with yardages from each tee
  const pgHoles: PgHoleData[] = course.holes.map((hole) => {
    const yardages: Record<string, number> = {};
    for (const tee of course.tees || []) {
      const teeHole = tee.holes.find((h) => h.number === hole.number);
      if (teeHole?.yards) {
        yardages[tee.name] = teeHole.yards;
      }
    }

    // Build GeoJSON features from holeCoordinates
    const features: GeoJSON.Feature[] = [];
    const coords = course.holeCoordinates?.find((c) => c.holeNumber === hole.number);
    if (coords) {
      if (coords.green) {
        features.push({
          type: 'Feature',
          properties: { featureType: 'green', hole: hole.number },
          geometry: { type: 'Point', coordinates: [coords.green.lng, coords.green.lat] },
        });
      }
      if (coords.tee) {
        features.push({
          type: 'Feature',
          properties: { featureType: 'tee', hole: hole.number },
          geometry: { type: 'Point', coordinates: [coords.tee.lng, coords.tee.lat] },
        });
      }
      if (coords.front) {
        features.push({
          type: 'Feature',
          properties: { featureType: 'green', subtype: 'front', hole: hole.number },
          geometry: { type: 'Point', coordinates: [coords.front.lng, coords.front.lat] },
        });
      }
      if (coords.back) {
        features.push({
          type: 'Feature',
          properties: { featureType: 'green', subtype: 'back', hole: hole.number },
          geometry: { type: 'Point', coordinates: [coords.back.lng, coords.back.lat] },
        });
      }
    }

    return {
      number: hole.number,
      par: hole.par,
      handicap: hole.handicap || hole.number,
      yardages,
      features: { type: 'FeatureCollection' as const, features },
    };
  });

  // Determine center location from first hole coordinates or default
  const firstCoord = course.holeCoordinates?.[0];
  const location = firstCoord?.green
    ? { lat: firstCoord.green.lat, lng: firstCoord.green.lng }
    : { lat: 0, lng: 0 };

  return {
    id: course.id,
    name: course.name,
    address: course.location,
    location,
    teeSets,
    holes: pgHoles,
  };
}

/** Persist a course to Postgres (Supabase) — non-blocking, best-effort */
async function persistCourseToPostgres(course: Course): Promise<void> {
  try {
    const { upsertCourse } = await import('./courses/storage');
    const courseData = courseToPostgresData(course);
    await upsertCourse(courseData);
  } catch (e) {
    // Silently fail — Supabase may not be configured
    console.warn('Failed to persist course to Postgres:', e);
  }
}

/** Fetch and convert a GolfAPI course into the app model, ready for use */
export async function importGolfApiCourse(
  clubId: number | string,
  courseId?: number | string
): Promise<Course | null> {
  const club = await getClubDetails(clubId);
  if (!club) return null;

  let apiCourse: GolfCourse | null = null;

  if (courseId) {
    apiCourse = await getCourseDetails(courseId);
  } else if (club.courses && club.courses.length > 0) {
    // Get first course details
    apiCourse = await getCourseDetails(club.courses[0].id);
  }

  if (!apiCourse) return null;

  const course = golfApiCourseToAppCourse(club, apiCourse);

  // Fetch GPS coordinates if available
  const effectiveCourseId = courseId || club.courses?.[0]?.id;
  if (apiCourse.hasGPS && effectiveCourseId && !course.holeCoordinates?.length) {
    const coords = await fetchCourseCoordinates(effectiveCourseId);
    if (coords.length > 0) {
      course.holeCoordinates = coords;
    }
  }

  // Save to recent
  const displayName = composeCourseName(club.name, apiCourse.name || club.name);
  saveRecentCourse({
    id: apiCourse.id,
    name: displayName,
    clubName: club.name,
  });

  // Persist to Postgres (async, non-blocking)
  persistCourseToPostgres(course).catch(() => {});

  return course;
}

/** Search courses by GPS proximity via multiple sources */
export async function searchNearby(
  lat: number,
  lng: number,
  radiusMeters = 25000
): Promise<CourseSearchResult[]> {
  const results: CourseSearchResult[] = [];

  // 1. Search our mapped courses (PostGIS)
  const mappedPromise = fetch(
    `/api/courses/nearby?lat=${lat}&lng=${lng}&radiusMeters=${radiusMeters}`
  )
    .then((r) => r.json())
    .then((data) => {
      for (const c of data.courses || []) {
        results.push({
          id: c.id,
          name: c.name,
          address: c.address,
          center: c.location,
          source: 'mapped',
          hasCoordinates: true,
        });
      }
    })
    .catch(() => {});

  // 2. Search OSM nearby
  const osmPromise = fetch(
    `/api/courses/search?q=golf+course&lat=${lat}&lng=${lng}&radius=${radiusMeters}`
  )
    .then((r) => r.json())
    .then((data) => {
      for (const c of data.courses || []) {
        const isDupe = results.some(
          (r) => r.name.toLowerCase() === c.name?.toLowerCase()
        );
        if (!isDupe) {
          results.push({
            id: c.id,
            name: c.name,
            address: c.address,
            center: c.center,
            source: 'osm',
          });
        }
      }
    })
    .catch(() => {});

  await Promise.all([mappedPromise, osmPromise]);

  return results;
}
