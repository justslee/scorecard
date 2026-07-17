// ─── Native session-token store (Capacitor iOS / Android) ────────────────────
//
// Single source of truth for persisting the Clerk session JWT that the native
// FAPI flow echoes in the "authorization" response header (see AuthProvider).
// Centralised here so the storage BACKEND can be swapped in one place.
//
// CURRENT BACKEND: @aparajita/capacitor-secure-storage → iOS Keychain /
// Android Keystore. Every set() explicitly pins
// KeychainAccess.whenUnlockedThisDeviceOnly — encrypted at rest, excluded
// from iCloud/device backups, and NOT synchronizable to iCloud Keychain
// (every call also passes `sync: false` explicitly rather than relying on
// the plugin's default, per the App-Store-grade token-at-rest requirement —
// see specs/multi-user-epic-plan.md §3.4).
//
// PRIOR BACKEND (pre-App-Store): @capacitor/preferences → iOS UserDefaults /
// Android SharedPreferences. That was PLAINTEXT and included in device/
// iCloud backups. `migrateFromPreferences()` below does a one-time
// migrate-then-delete of any leftover plaintext value so no residue survives
// an app upgrade.
//
// Every read/write/clear goes through the three functions below, so a future
// backend swap is (again) a change to THIS FILE ONLY.

import { Preferences } from "@capacitor/preferences";
import { SecureStorage, KeychainAccess } from "@aparajita/capacitor-secure-storage";

const CLERK_CLIENT_JWT_KEY = "__clerk_client_jwt";

// Never migrate to other devices via iCloud Keychain, and only readable while
// the device is unlocked (foreground-appropriate; does NOT survive a restore
// to a different device). Passed explicitly on every write below.
const KEYCHAIN_ACCESS = KeychainAccess.whenUnlockedThisDeviceOnly;
// Passed explicitly on every call (get/set/remove) so behavior never depends
// on the plugin's internal default or on setSynchronize() having run first.
const NO_ICLOUD_SYNC = false;

/**
 * One-time migration of a pre-Keychain plaintext token out of
 * @capacitor/preferences and into the Keychain, then deletes the plaintext
 * entry so no residue remains. Idempotent and race-safe: the in-flight
 * promise is cached at module scope so concurrent callers (e.g. two FAPI
 * request hooks racing on cold start) await the SAME migration instead of
 * each reading/writing/deleting independently (which could re-write a
 * just-deleted plaintext value or double-migrate).
 */
let migration: Promise<void> | null = null;

function migrateFromPreferences(): Promise<void> {
  if (!migration) {
    migration = (async () => {
      const { value } = await Preferences.get({ key: CLERK_CLIENT_JWT_KEY });
      if (value) {
        await SecureStorage.set(
          CLERK_CLIENT_JWT_KEY,
          value,
          true,
          NO_ICLOUD_SYNC,
          KEYCHAIN_ACCESS,
        );
        await Preferences.remove({ key: CLERK_CLIENT_JWT_KEY });
      }
    })();
  }
  return migration;
}

/** Read the persisted session JWT. Returns null if absent. Throws on backend error. */
export async function getNativeToken(): Promise<string | null> {
  await migrateFromPreferences();
  const value = await SecureStorage.get(CLERK_CLIENT_JWT_KEY, true, NO_ICLOUD_SYNC);
  return typeof value === "string" ? value : null;
}

/** Persist the session JWT. Throws on backend error. */
export async function setNativeToken(value: string): Promise<void> {
  await SecureStorage.set(CLERK_CLIENT_JWT_KEY, value, true, NO_ICLOUD_SYNC, KEYCHAIN_ACCESS);
}

/** Remove the persisted session JWT (e.g. on sign-out). Throws on backend error. */
export async function clearNativeToken(): Promise<void> {
  await SecureStorage.remove(CLERK_CLIENT_JWT_KEY, NO_ICLOUD_SYNC);
  // Belt-and-suspenders: clear any lingering plaintext Preferences entry too,
  // so a sign-out always leaves zero residue in either store even if the
  // migration above hasn't run yet in this session.
  await Preferences.remove({ key: CLERK_CLIENT_JWT_KEY });
}
