/**
 * `getCurrentUserId()` — the SYNCHRONOUS "who am I" source of truth used for
 * localStorage key derivation (specs/multi-user-epic-plan.md §3.5,
 * multiuser-p0-client-identity).
 *
 * Deliberately split out of `lib/identity.ts` (which also exports the
 * `useMe()` React hook and pulls in `react` + `@clerk/react`) so that
 * `lib/storage-keys.ts` — and every pure-logic module that derives a
 * namespaced key (satellite-helpers.ts, course-favorites.ts, ...) — can stay
 * framework-free and runnable in plain Node/vitest with zero React/Clerk
 * import cost, matching those files' existing "no DOM/React required" design
 * intent. `lib/identity.ts` re-exports this function so `getCurrentUserId`
 * has one canonical import path for consumers that don't care about the
 * split (`import { getCurrentUserId } from "@/lib/identity"` still works).
 */

const LAST_USER_KEY = "scorecard_last_user_id";

/**
 * Resolution order:
 *   1. `window.Clerk?.user?.id` — the live Clerk session, when hydrated
 *      (reliable on web; frequently absent on native/Capacitor — see the
 *      extensive comments in api.ts / storage-api.ts / AuthProvider.tsx).
 *   2. `scorecard_last_user_id` — the last known signed-in user id on this
 *      device, written by (1) below and by `useMe()` (lib/identity.ts).
 *      Covers offline reads and native, where `window.Clerk` never hydrates.
 *   3. `null` — a device that has never signed in (or SSR/Node with no
 *      `window`).
 */
export function getCurrentUserId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const liveId = window.Clerk?.user?.id;
    if (liveId) {
      try {
        window.localStorage.setItem(LAST_USER_KEY, liveId);
      } catch {
        // Private mode / quota — non-fatal; the in-memory id still resolves
        // correctly for this call.
      }
      return liveId;
    }
  } catch {
    // window.Clerk not ready / threw — fall through to the persisted id.
  }
  try {
    return window.localStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
}

/**
 * Clear the persisted namespace pointer (sign-out teardown, THE TOCTOU fix —
 * specs/multiuser-p0-signout-namespace-clear-plan.md §1 step 2 / §2 row 3).
 * After this, `getCurrentUserId()` returns null and every `storageKey()` read
 * resolves to the `anon` namespace — the departing user's data is
 * unreachable by name for whoever signs in next on this device. MUST be
 * called only after Clerk has already cleared `window.Clerk.user` (i.e. from
 * the reactive signed-in→signed-out transition), or the very next
 * synchronous call to `getCurrentUserId()` above would resurrect the pointer
 * via its opportunistic re-write.
 */
export function clearLastUserId(): void {
  try {
    window.localStorage.removeItem(LAST_USER_KEY);
  } catch {
    // Private mode / quota — non-fatal.
  }
}
