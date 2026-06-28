// ─── Native session-token store (Capacitor iOS / Android) ────────────────────
//
// Single source of truth for persisting the Clerk session JWT that the native
// FAPI flow echoes in the "authorization" response header (see AuthProvider).
// Centralised here so the storage BACKEND can be swapped in one place.
//
// CURRENT BACKEND: @capacitor/preferences → iOS UserDefaults / Android
// SharedPreferences. This is PLAINTEXT and included in device/iCloud backups.
// It is acceptable for the owner-only private TestFlight beta but NOT for a
// wider App Store release.
//
// TODO(security, pre-App-Store): move to a Keychain-backed plugin
// (@aparajita/capacitor-secure-storage) with
// kSecAttrAccessibleWhenUnlockedThisDeviceOnly so the JWT is encrypted at rest
// and excluded from backups. Tracked as backlog `clerk-jwt-keychain-swap`.
// Because every read/write/clear goes through the three functions below, that
// swap is a change to THIS FILE ONLY.

import { Preferences } from "@capacitor/preferences";

const CLERK_CLIENT_JWT_KEY = "__clerk_client_jwt";

/** Read the persisted session JWT. Returns null if absent. Throws on backend error. */
export async function getNativeToken(): Promise<string | null> {
  const { value } = await Preferences.get({ key: CLERK_CLIENT_JWT_KEY });
  return value ?? null;
}

/** Persist the session JWT. Throws on backend error. */
export async function setNativeToken(value: string): Promise<void> {
  await Preferences.set({ key: CLERK_CLIENT_JWT_KEY, value });
}

/** Remove the persisted session JWT (e.g. on sign-out). Throws on backend error. */
export async function clearNativeToken(): Promise<void> {
  await Preferences.remove({ key: CLERK_CLIENT_JWT_KEY });
}
