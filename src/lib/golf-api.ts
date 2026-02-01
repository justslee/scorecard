// GolfAPI.io Service
// API Documentation: https://golfapi.io

const API_BASE = "https://golfapi.io/api/v1";

export interface GolfClub {
  id: number;
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
  id: number;
  name: string;
  holes: number;
  par?: number;
  slope?: number;
  rating?: number;
  tees?: Tee[];
  holeData?: HoleData[];
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
  hazards?: Array<{
    type: string;
    lat: number;
    lng: number;
  }>;
}

// Search for golf clubs by name or location
export async function searchCourses(query: string): Promise<GolfClub[]> {
  try {
    const response = await fetch(
      `${API_BASE}/clubs?search=${encodeURIComponent(query)}`,
      {
        headers: getHeaders(),
      }
    );

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data.clubs || data || [];
  } catch (error) {
    console.error("Error searching courses:", error);
    // Return cached results if available
    return getCachedSearchResults(query);
  }
}

// Get club details including courses
export async function getClubDetails(clubId: number): Promise<GolfClub | null> {
  try {
    const response = await fetch(`${API_BASE}/clubs/${clubId}`, {
      headers: getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    // Cache for offline use
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
    const response = await fetch(`${API_BASE}/courses/${courseId}`, {
      headers: getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    // Cache for offline use
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
