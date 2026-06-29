/**
 * Course favorites — localStorage-based persistence for single-user builds.
 *
 * Multi-user is sequenced later; localStorage is the correct scope now.
 * The shape is intentionally portable so a backend swap (PUT /api/favorites)
 * only touches this file.
 *
 * Key: "looper_course_favorites"
 * Value: JSON-encoded FavoriteCourse[]
 *
 * Design note: The read/write layer accepts an optional `storage` parameter so
 * pure-logic unit tests can inject an in-memory store without needing a browser
 * environment — no jsdom or localStorage mock required.
 */

const KEY = "looper_course_favorites";

export interface FavoriteCourse {
  /** The course's canonical id (UUID for mapped/OSM; prefixed string for GolfAPI). */
  id: string;
  name: string;
  /** Club/property name when different from the course name. */
  clubName?: string;
  /** Geo center — used to show distance in the favorites list. */
  center?: { lat: number; lng: number };
  /** Source tag so the selection path knows how to route. */
  source: "mapped" | "osm" | "golfapi" | "local";
  /** GolfAPI club id — needed to build the course detail URL for golfapi results. */
  golfApiClubId?: string;
  /** ISO timestamp of when the course was favorited. */
  favoritedAt: string;
}

/** Minimal storage interface — localStorage and Map<string,string> both satisfy it. */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory KVStore — used as the default in SSR/Node, and injectable in tests. */
export class MemoryStore implements KVStore {
  private data: Map<string, string> = new Map();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

/** Browser-safe accessor for localStorage — SSR falls back to a shared MemoryStore. */
const _ssrFallback = new MemoryStore();
function defaultStore(): KVStore {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return _ssrFallback;
}

// ---------------------------------------------------------------------------
// Internal read/write helpers
// ---------------------------------------------------------------------------

/** Read the raw favorites array from storage. Returns [] on any parse error. */
export function readFavorites(store: KVStore = defaultStore()): FavoriteCourse[] {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FavoriteCourse[]) : [];
  } catch {
    return [];
  }
}

/** Write favorites array to storage. */
function writeFavorites(favorites: FavoriteCourse[], store: KVStore): void {
  try {
    store.setItem(KEY, JSON.stringify(favorites));
  } catch {
    // Storage full or blocked — silently ignore.
  }
}

// ---------------------------------------------------------------------------
// Public API — all accept an optional `store` parameter for testability
// ---------------------------------------------------------------------------

/**
 * List all favorited courses, most-recently-favorited first.
 */
export function listFavorites(store: KVStore = defaultStore()): FavoriteCourse[] {
  const favs = readFavorites(store);
  return [...favs].sort(
    (a, b) => new Date(b.favoritedAt).getTime() - new Date(a.favoritedAt).getTime()
  );
}

/**
 * Return true if a course id is currently favorited.
 */
export function isFavorite(id: string, store: KVStore = defaultStore()): boolean {
  return readFavorites(store).some((f) => f.id === id);
}

/**
 * Add a course to favorites. De-duplicates by id (refreshes favoritedAt if already present).
 * Returns the updated list (most-recent-first).
 */
export function addFavorite(
  course: Omit<FavoriteCourse, "favoritedAt">,
  store: KVStore = defaultStore()
): FavoriteCourse[] {
  const existing = readFavorites(store);
  const filtered = existing.filter((f) => f.id !== course.id);
  const entry: FavoriteCourse = { ...course, favoritedAt: new Date().toISOString() };
  writeFavorites([entry, ...filtered], store);
  return listFavorites(store);
}

/**
 * Remove a course from favorites by id. No-op if not present.
 * Returns the updated list (most-recent-first).
 */
export function removeFavorite(id: string, store: KVStore = defaultStore()): FavoriteCourse[] {
  const existing = readFavorites(store);
  writeFavorites(existing.filter((f) => f.id !== id), store);
  return listFavorites(store);
}

/**
 * Toggle favorite status for a course.
 * If currently favorited → removes it.
 * If not favorited → adds it.
 * Returns `{ isFavorite, favorites }`.
 */
export function toggleFavorite(
  course: Omit<FavoriteCourse, "favoritedAt">,
  store: KVStore = defaultStore()
): { isFavorite: boolean; favorites: FavoriteCourse[] } {
  if (isFavorite(course.id, store)) {
    const favorites = removeFavorite(course.id, store);
    return { isFavorite: false, favorites };
  } else {
    const favorites = addFavorite(course, store);
    return { isFavorite: true, favorites };
  }
}

/**
 * Clear all favorites. Primarily for dev reset / testing.
 */
export function clearFavorites(store: KVStore = defaultStore()): void {
  try {
    store.removeItem(KEY);
  } catch {
    // ignore
  }
}
