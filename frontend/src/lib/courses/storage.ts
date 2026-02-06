import fs from 'fs/promises';
import path from 'path';
import { CourseData, CourseListItem } from './types';

const COURSES_DIR = path.join(process.cwd(), 'public', 'courses');
const INDEX_PATH = path.join(COURSES_DIR, 'index.json');

async function ensureDir() {
  await fs.mkdir(COURSES_DIR, { recursive: true });
}

function coursePath(id: string) {
  return path.join(COURSES_DIR, `${id}.json`);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, data: unknown) {
  await ensureDir();
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function listCourses(params?: { search?: string }): Promise<CourseListItem[]> {
  const index = (await readJsonFile<{ courses: CourseListItem[] }>(INDEX_PATH)) || {
    courses: [],
  };
  const q = params?.search?.trim().toLowerCase();
  const rows = Array.isArray(index.courses) ? index.courses : [];
  if (!q) return rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return rows
    .filter((c) => c.name.toLowerCase().includes(q) || (c.address || '').toLowerCase().includes(q))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getCourse(id: string): Promise<CourseData | null> {
  const course = await readJsonFile<CourseData>(coursePath(id));
  return course;
}

export async function upsertCourse(course: CourseData): Promise<CourseData> {
  const now = new Date().toISOString();
  const existing = await getCourse(course.id);
  const merged: CourseData = {
    ...course,
    createdAt: existing?.createdAt || course.createdAt || now,
    updatedAt: now,
  };

  await writeJsonFile(coursePath(course.id), merged);

  const index = (await readJsonFile<{ courses: CourseListItem[] }>(INDEX_PATH)) || {
    courses: [],
  };
  const list: CourseListItem[] = Array.isArray(index.courses) ? index.courses : [];
  const item: CourseListItem = {
    id: merged.id,
    name: merged.name,
    location: merged.location,
    address: merged.address,
    updatedAt: merged.updatedAt,
  };
  const next = [item, ...list.filter((c) => c.id !== merged.id)];
  await writeJsonFile(INDEX_PATH, { courses: next });

  return merged;
}

export async function deleteCourse(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await ensureDir();
    // delete course file if exists
    await fs.rm(coursePath(id), { force: true });

    const index = (await readJsonFile<{ courses: CourseListItem[] }>(INDEX_PATH)) || {
      courses: [],
    };
    const list: CourseListItem[] = Array.isArray(index.courses) ? index.courses : [];
    await writeJsonFile(INDEX_PATH, { courses: list.filter((c) => c.id !== id) });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'delete failed' };
  }
}

// Placeholder for future Supabase/PostGIS implementation
export async function findNearbyCourses(_params: {
  lat: number;
  lng: number;
  radiusMeters?: number;
}): Promise<CourseListItem[]> {
  // Local fallback: return all (client can filter)
  return listCourses();
}
