/**
 * Native auth diagnostic state.
 *
 * Written by AuthProvider's FAPI request/response hooks (which fire
 * asynchronously, after the first FAPI round-trip completes).  Read by
 * the on-screen debug strip in SignInClient so the owner can validate
 * the native-mode setup on-device without rebuilding blind.
 *
 * Uses a lightweight subscriber pattern so React components re-render
 * when async hook data arrives.  No dependency on React state or context
 * so it can be written to from module-level code (the window global
 * callbacks run outside the React tree).
 */

export interface AuthDiagState {
  /**
   * True if a persisted JWT was found in @capacitor/preferences on the
   * initial FAPI request (cold-start token restore succeeded).
   */
  tokenRestored: boolean;

  /**
   * True if the Clerk FAPI returned a native_api_disabled error code.
   * Fix: Dashboard → Configure → Native applications → enable.
   * URL: https://dashboard.clerk.com/last-active?path=native-applications
   */
  nativeApiDisabled: boolean;

  /**
   * Last error string encountered inside the native FAPI hooks.
   * Null when no error has occurred.
   */
  lastError: string | null;

  /**
   * True once __internal_onBeforeRequest has successfully appended
   * _is_native=1 to at least one FAPI request URL.
   * False = hook never fired (check AuthProvider setup).
   */
  isNativeSent: boolean;

  /**
   * Whether the "authorization" response header was readable on the last
   * FAPI response.
   *   null  = no response observed yet
   *   true  = header received and readable (JWT captured) ← expected outcome
   *   false = response received but header absent/unreadable ← CORS issue
   *
   * The expected value is true once the user signs in.  If it stays false,
   * CapacitorHttp is not routing fetch() through native HTTP (check that
   * `npx cap sync` was run after the capacitor.config change).
   */
  authHeaderReceived: boolean | null;

  /**
   * Path of the last FAPI request seen by the before-request hook.
   * Helps confirm which endpoint is being intercepted.
   */
  lastFapiPath: string | null;
}

let _state: AuthDiagState = {
  tokenRestored: false,
  nativeApiDisabled: false,
  lastError: null,
  isNativeSent: false,
  authHeaderReceived: null,
  lastFapiPath: null,
};

const _listeners = new Set<() => void>();

/** Merge a partial update into the diagnostic state and notify subscribers. */
export function setAuthDiag(patch: Partial<AuthDiagState>): void {
  _state = { ..._state, ...patch };
  // Mirror every update to the console so the FAPI-hook auth state is readable
  // from the native log stream (xcrun simctl spawn booted log stream …) — this
  // is how builds are validated in the simulator without the owner on-device.
  try {
    console.log(`[authdiag] ${JSON.stringify(_state)}`);
  } catch {
    /* console unavailable — ignore */
  }
  _listeners.forEach((fn) => fn());
}

/** Read the current diagnostic state snapshot. */
export function getAuthDiag(): AuthDiagState {
  return _state;
}

/**
 * Subscribe to state changes.  Returns an unsubscribe function.
 * Call the returned function in a useEffect cleanup to avoid leaks.
 */
export function subscribeAuthDiag(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}
