/**
 * Golfer location for tee-time search — "lat,lng" area with a last-known
 * fallback so the UI never blocks on a permission prompt.
 *
 * Storage follows the injectable-KVStore pattern of lib/course-favorites.ts;
 * the GPS call is dynamically imported so this module stays importable in
 * pure-node tests (lib/gps.ts pulls in Capacitor + turf).
 */

import type { KVStore } from "@/lib/course-favorites";
import { formatAreaLatLng } from "./query";

const KEY = "looper_teetime_last_area";

const _memory = new Map<string, string>();
function defaultStore(): KVStore {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  return {
    getItem: (k) => _memory.get(k) ?? null,
    setItem: (k, v) => { _memory.set(k, v); },
    removeItem: (k) => { _memory.delete(k); },
  };
}

const AREA_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

/** The last "lat,lng" we successfully located, or null. */
export function readLastKnownArea(store: KVStore = defaultStore()): string | null {
  try {
    const raw = store.getItem(KEY);
    return raw && AREA_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveLastKnownArea(area: string, store: KVStore = defaultStore()): void {
  try {
    store.setItem(KEY, area);
  } catch {
    // Storage blocked — the fix simply won't persist.
  }
}

/**
 * Acquire the golfer's current position as a "lat,lng" area string.
 * Resolves null on denial/failure — callers fall back to last-known / none.
 * Never throws.
 */
export async function acquireArea(store: KVStore = defaultStore()): Promise<string | null> {
  try {
    const { GPSWatcher } = await import("@/lib/gps");
    const pos = await GPSWatcher.getCurrentPosition();
    const area = formatAreaLatLng(pos.lat, pos.lng);
    saveLastKnownArea(area, store);
    return area;
  } catch {
    return null;
  }
}
