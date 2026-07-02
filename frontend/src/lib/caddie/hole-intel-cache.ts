/**
 * HoleIntelBundle cache — tier 3 of the caddie transport ladder.
 *
 * At session start (once course intel / weather resolves) we snapshot the
 * per-hole essentials into IndexedDB. When the phone is fully offline the
 * voice orb opens a static recommendation card rendered from this bundle —
 * the yardage book still works in a dead-cell valley.
 *
 * Raw IndexedDB behind a tiny promise wrapper (no new dependency); every
 * call is a silent no-op / null on SSR, unsupported browsers, or errors —
 * the cache is an enhancement, never a failure surface.
 */

export interface CachedHoleIntel {
  holeNumber: number;
  par: number;
  yards: number;
  /** Elevation-adjusted plays-like yardage (from course intel; may be absent). */
  effectiveYards?: number;
  hazards: Array<{ type: string; side: string; distance_from_green: number }>;
}

export interface CachedRecommendation {
  holeNumber: number;
  club: string;
  targetYards: number;
  aim: string;
  missSide: string;
}

export interface HoleIntelBundle {
  roundId: string;
  courseName?: string;
  savedAt: number;
  holes: CachedHoleIntel[];
  lastRecommendation: CachedRecommendation | null;
}

const DB_NAME = 'looper-caddie';
const DB_VERSION = 1;
const STORE = 'hole-intel-bundles';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'roundId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Persist (or refresh) the round's offline bundle. Silent on failure. */
export async function saveHoleIntelBundle(bundle: HoleIntelBundle): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(bundle);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

/** Load the round's offline bundle; null when absent/unavailable. */
export async function loadHoleIntelBundle(roundId: string): Promise<HoleIntelBundle | null> {
  const db = await openDb();
  if (!db) return null;
  const bundle = await new Promise<HoleIntelBundle | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(roundId);
      req.onsuccess = () => resolve((req.result as HoleIntelBundle) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  db.close();
  return bundle;
}

/** Update just the last recommendation on an existing bundle (best-effort). */
export async function saveLastRecommendation(
  roundId: string,
  rec: CachedRecommendation,
): Promise<void> {
  const existing = await loadHoleIntelBundle(roundId);
  if (!existing) return;
  await saveHoleIntelBundle({ ...existing, lastRecommendation: rec, savedAt: Date.now() });
}
