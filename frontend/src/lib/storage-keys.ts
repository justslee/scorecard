/**
 * Per-user localStorage key derivation + one-time legacy migration
 * (specs/multi-user-epic-plan.md §3.5 — multiuser-p0-client-identity).
 *
 * Shared by storage.ts's 5 data keys AND the pref stores (caddie persona,
 * caddie personality, course favorites, sheet TTS, live-mode, map-view).
 *
 * NOT namespaced (deliberately): the GolfAPI course cache (golf-api.ts's
 * `golfapi_*` keys) — device-global, non-personal reference data per
 * specs/multi-user-epic-plan.md §3.5.
 *
 * SYNCHRONOUS by design: storage.ts's reads (getRounds/getCourses/...) are
 * synchronous and cannot await Clerk's async hydration, so `storageKey()` and
 * `getCurrentUserId()` (lib/identity-core.ts, re-exported from lib/identity.ts)
 * must stay synchronous too.
 */

import { getCurrentUserId } from "./identity-core";

/**
 * Stable namespace for a device that has never seen a signed-in user (no
 * live Clerk id, no persisted `scorecard_last_user_id`). Keeps reads/writes
 * on that device internally consistent without colliding with the legacy
 * bare keys — which are MOVED (not read directly) once a real user id
 * becomes available, see `migrateLegacyKeysIfNeeded` below.
 */
const ANON_NAMESPACE = "anon";

/**
 * Derive the per-user localStorage key for a base name (e.g. "rounds",
 * "caddie_persona"). Always attempts the one-time legacy migration first so
 * every caller — storage.ts and every pref store — derives the namespace
 * identically and the migration can never race a read into an empty
 * namespace (the read path and the migration path must agree, see
 * `migrateLegacyKeysIfNeeded`'s doc comment).
 */
export function storageKey(name: string): string {
  migrateLegacyKeysIfNeeded();
  const uid = getCurrentUserId();
  return `scorecard_${uid ?? ANON_NAMESPACE}_${name}`;
}

const MIGRATED_FLAG = "scorecard_migrated_v1";

/**
 * base name -> legacy (pre-namespacing) localStorage key. Every personal-data
 * key that existed before this change. Keep this in sync with every call
 * site that uses `storageKey(name)` — the `name` here must match exactly, or
 * the migrated value lands under a key nothing reads.
 */
const LEGACY_KEYS: Record<string, string> = {
  rounds: "scorecard_rounds",
  courses: "scorecard_courses",
  tournaments: "scorecard_tournaments",
  profile: "scorecard_profile",
  players: "scorecard_players",
  caddie_persona: "looper.caddiePersonaId",
  caddie_personality: "scorecard_caddie_personality",
  sheet_tts_enabled: "looper.sheetTtsEnabled",
  caddie_live_mode: "looper.caddieLiveMode",
  map_view_pref: "looper_map_view_pref",
  course_favorites: "looper_course_favorites",
};

/**
 * One-time legacy migration.
 *
 * On first namespaced run, if legacy un-namespaced keys exist AND a
 * signed-in user id is already known, move each legacy key's value into that
 * user's namespace (this device's pre-multi-user data is definitionally the
 * current owner's today), then record `scorecard_migrated_v1`.
 *
 * Idempotent + guarded:
 *   - Skips entirely once the flag is set (never runs twice).
 *   - Never overwrites an existing namespaced value (a re-run or a race
 *     between two call sites can't clobber real per-user data already
 *     written under the namespaced key).
 *   - Removes the legacy key once handled either way (migrated, or skipped
 *     because the namespaced key already had a value) so nothing keeps
 *     reading stale legacy data after migration completes.
 *
 * Ordering (the highest-risk part): NO-OPs when no user id is available yet
 * — fires before Clerk has resolved a user, or on a device that has never
 * signed in. Migrating into the wrong/blank namespace would look like the
 * owner's data vanished (a data-loss-looking regression), so this function
 * is safe to call speculatively and often; it is cheap (one flag getItem)
 * after the first successful run, and retries automatically on every
 * `storageKey()` call until a user id becomes available.
 */
export function migrateLegacyKeysIfNeeded(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(MIGRATED_FLAG)) return;
    const uid = getCurrentUserId();
    if (!uid) return; // Wait for a real user id — never migrate into anon/blank.

    for (const [name, legacyKey] of Object.entries(LEGACY_KEYS)) {
      const legacyValue = window.localStorage.getItem(legacyKey);
      if (legacyValue === null) continue;
      const namespaced = `scorecard_${uid}_${name}`;
      if (window.localStorage.getItem(namespaced) === null) {
        window.localStorage.setItem(namespaced, legacyValue);
      }
      window.localStorage.removeItem(legacyKey);
    }
    window.localStorage.setItem(MIGRATED_FLAG, "1");
  } catch {
    // Storage unavailable (private mode / quota) — leave un-migrated; the
    // next `storageKey()` call retries.
  }
}

/**
 * Clear only the CURRENT user's namespaced data — every base name in
 * `LEGACY_KEYS` (the 5 data keys + the pref stores), derived the same way
 * `storageKey()` derives them. Used by Settings "clear cache" (previously a
 * bare `localStorage.clear()`, which would nuke every other signed-in user's
 * cache on this device — see settings/page.tsx). Deliberately does NOT touch
 * the device-global GolfAPI course cache (`golfapi_*`) or the migration flag
 * / last-user-id bookkeeping keys — those aren't per-user personal data.
 */
export function clearCurrentUserStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (const name of Object.keys(LEGACY_KEYS)) {
      window.localStorage.removeItem(storageKey(name));
    }
  } catch {
    // Storage unavailable — nothing to clear.
  }
}
