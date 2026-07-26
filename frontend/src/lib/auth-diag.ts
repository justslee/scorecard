/**
 * Native auth diagnostic state — DEV/SIM-ONLY (specs/p0-login-blocked-plan.md).
 *
 * Written by AuthProvider's FAPI request/response hooks (which fire
 * asynchronously, after each FAPI round-trip). Read by NativeAuthDiag, the
 * on-screen debug chip that only renders when NEXT_PUBLIC_AUTH_DIAG=1 is
 * baked into the build (see SignInClient.tsx's build-time-conditional
 * import) — it never ships to TestFlight.
 *
 * Uses a lightweight subscriber pattern so React components re-render
 * when async hook data arrives. No dependency on React state or context
 * so it can be written to from module-level code (the window global
 * callbacks run outside the React tree).
 *
 * ── Why lastResponse is a single ATOMIC record ──────────────────────────────
 * A previous version tracked `authHeaderReceived` as one global overwritten by
 * every FAPI response's after-hook, with `lastFapiPath` written separately by
 * the before-hook. Because those two fields describe DIFFERENT hooks firing
 * at different times, they routinely paired up to describe two unrelated
 * requests — a readout like "auth-hdr=false path=/v1/client" could actually
 * mean "/v1/environment had no auth header; the last REQUEST happened to be
 * /v1/client". That manufactured a phantom P0 (see the plan's falsification
 * section). `lastResponse` is now written ONCE, atomically, by the
 * after-response hook only, so path/status/authHeaderPresent always describe
 * the SAME response. `responseByPath` additionally keeps the last response
 * seen per FAPI path so the panel can show the one value that actually means
 * something: the auth header on /v1/client specifically.
 */

/** Atomic snapshot of one FAPI response — always describes a single call. */
export interface FapiResponseRecord {
  /** URL pathname of the request this response answered. */
  path: string | null;
  /** HTTP status code of the response, if known. */
  status: number | null;
  /** Whether the "authorization" response header was present and non-empty. */
  authHeaderPresent: boolean;
}

export interface AuthDiagState {
  /**
   * True if a persisted JWT was found in the native token store on the
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
   * Path of the last FAPI REQUEST seen by the before-request hook. A
   * REQUEST-time field — do not pair it with `lastResponse`, which may
   * describe an entirely different call (see the module comment above).
   */
  lastRequestPath: string | null;

  /**
   * Atomic snapshot of the last FAPI RESPONSE, written only by the
   * after-response hook (nativeOnAfterResponse in AuthProvider.tsx) so
   * path/status/authHeaderPresent always describe the same call.
   * Null until the first response is observed.
   */
  lastResponse: FapiResponseRecord | null;

  /**
   * Last response record seen for each FAPI path, keyed by pathname (at
   * minimum "/v1/client" — the only endpoint whose auth header actually
   * signals a captured session JWT; /v1/environment responses never carry
   * one even on a fully healthy run).
   */
  responseByPath: Record<string, FapiResponseRecord>;
}

let _state: AuthDiagState = {
  tokenRestored: false,
  nativeApiDisabled: false,
  lastError: null,
  isNativeSent: false,
  lastRequestPath: null,
  lastResponse: null,
  responseByPath: {},
};

const _listeners = new Set<() => void>();

/** Console-mirror every update so async hook state is readable from the
 * native log stream (xcrun simctl spawn booted log stream …) — this is how
 * builds are validated in the simulator without the owner on-device. Gated
 * behind the build-time flag: with NEXT_PUBLIC_AUTH_DIAG unset the inline
 * literal condition is a compile-time constant false and the whole branch
 * (including the "[authdiag]" string) is eliminated at parse time, so no
 * auth-state telemetry reaches a shipped build's device log. */
function mirrorToConsole(): void {
  if (process.env.NEXT_PUBLIC_AUTH_DIAG === "1") {
    try {
      console.log(`[authdiag] ${JSON.stringify(_state)}`);
    } catch {
      /* console unavailable — ignore */
    }
  }
}

/** Merge a partial update into the diagnostic state and notify subscribers.
 * For response data, use `recordFapiResponse` instead — this generic merge
 * is for the independent scalar fields (tokenRestored, isNativeSent, etc.)
 * and the before-hook's `lastRequestPath`. */
export function setAuthDiag(patch: Partial<AuthDiagState>): void {
  _state = { ..._state, ...patch };
  mirrorToConsole();
  _listeners.forEach((fn) => fn());
}

/**
 * Atomically record one FAPI response. Called ONLY from the after-response
 * hook, with all three fields read from the same response object, so
 * `lastResponse` can never mix fields from two different calls.
 */
export function recordFapiResponse(record: FapiResponseRecord): void {
  const key = record.path ?? "?";
  _state = {
    ..._state,
    lastResponse: record,
    responseByPath: { ..._state.responseByPath, [key]: record },
  };
  mirrorToConsole();
  _listeners.forEach((fn) => fn());
}

/** Read the current diagnostic state snapshot. */
export function getAuthDiag(): AuthDiagState {
  return _state;
}

/**
 * Subscribe to state changes. Returns an unsubscribe function.
 * Call the returned function in a useEffect cleanup to avoid leaks.
 */
export function subscribeAuthDiag(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}
