// GolfAPI.io Service
// API Documentation: https://golfapi.io
//
// When running in the browser, routes through /api/golf proxy to keep API key server-side.
// Falls back to direct API calls when proxy is unavailable.

import type { Course, HoleInfo, TeeOption } from './types';

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
  id: number;
  name: string;
  color?: string;
  slope?: number;
  rating?: number;
  totalYards?: number;
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
    return data.clubs || data || [];
  } catch (error) {
    console.error("Error searching courses:", error);
    return getCachedSearchResults(query);
  }
}

// Get club details including courses
export async function getClubDetails(clubId: number): Promise<GolfClub | null> {
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
    return getCachedClubData(clubId);
  }
}

// Get full course details with hole data and coordinates
export async function getCourseDetails(courseId: number): Promise<GolfCourse | null> {
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
    return getCachedCourseData(courseId);
  }
}

// Get coordinates for all holes on a course
export async function getCourseCoordinates(courseId: number): Promise<CourseCoordinates[]> {
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

function cacheClubData(clubId: number, data: GolfClub) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    `${CACHE_PREFIX}club_${clubId}`,
    JSON.stringify({ data, timestamp: Date.now() })
  );
}

function getCachedClubData(clubId: number): GolfClub | null {
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

function cacheCourseData(courseId: number, data: GolfCourse) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    `${CACHE_PREFIX}course_${courseId}`,
    JSON.stringify({ data, timestamp: Date.now() })
  );
}

function getCachedCourseData(courseId: number): GolfCourse | null {
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
export function saveRecentCourse(course: { id: number; name: string; clubName: string }) {
  if (typeof window === "undefined") return;

  const recent = getRecentCourses();
  const filtered = recent.filter((c) => c.id !== course.id);
  const updated = [course, ...filtered].slice(0, 10); // Keep last 10

  localStorage.setItem(`${CACHE_PREFIX}recent_courses`, JSON.stringify(updated));
}

export function getRecentCourses(): Array<{ id: number; name: string; clubName: string }> {
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
  golfApiClubId?: number;
  golfApiCourseId?: number;
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
            name: course.name || club.name,
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
            hasCoordinates: course.holeData?.some((h) => h.coordinates?.green) ?? false,
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
  const holes: HoleInfo[] = (apiCourse.holeData || []).map((h) => ({
    number: h.hole,
    par: h.par,
    yards: h.yards,
    handicap: h.strokeIndex,
  }));

  // Ensure we have 18 holes
  while (holes.length < 18) {
    holes.push({ number: holes.length + 1, par: 4 });
  }

  const tees: TeeOption[] = (apiCourse.tees || []).map((t) => ({
    id: `golfapi-tee-${t.id}`,
    name: t.name,
    holes: holes.map((h) => ({ ...h })),
  }));

  // Default tees if none provided
  if (tees.length === 0) {
    tees.push(
      { id: crypto.randomUUID(), name: 'Blue', holes: holes.map((h) => ({ ...h })) },
      { id: crypto.randomUUID(), name: 'White', holes: holes.map((h) => ({ ...h })) },
      { id: crypto.randomUUID(), name: 'Red', holes: holes.map((h) => ({ ...h })) },
    );
  }

  // Extract hole coordinates
  const holeCoordinates = (apiCourse.holeData || [])
    .filter((h) => h.coordinates?.green)
    .map((h) => ({
      holeNumber: h.hole,
      green: h.coordinates!.green!,
      tee: h.coordinates?.tee,
      front: h.coordinates?.front,
      back: h.coordinates?.back,
    }));

  return {
    id: `golfapi-${apiCourse.id}`,
    name: apiCourse.name || club.name,
    holes,
    tees,
    location: [club.city, club.state].filter(Boolean).join(', ') || club.address,
    golfApiCourseId: apiCourse.id,
    golfApiClubId: club.id,
    holeCoordinates: holeCoordinates.length > 0 ? holeCoordinates : undefined,
  };
}

/** Fetch and convert a GolfAPI course into the app model, ready for use */
export async function importGolfApiCourse(
  clubId: number,
  courseId?: number
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

  // Save to recent
  saveRecentCourse({
    id: apiCourse.id,
    name: apiCourse.name || club.name,
    clubName: club.name,
  });

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
