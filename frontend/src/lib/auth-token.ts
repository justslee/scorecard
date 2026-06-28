/**
 * Module-level Clerk token getter singleton.
 *
 * Non-component code (api.ts, deepgram.ts) calls getTokenViaClerk() to
 * retrieve a Clerk session JWT. ClerkTokenBridge (a client component inside
 * <ClerkProvider>) registers the supported useAuth().getToken function here
 * on every auth-state change, replacing the unreliable window.Clerk path.
 *
 * Why a singleton and not a React context:
 *   api.ts / deepgram.ts are plain module functions invoked outside the
 *   React render tree (e.g. from event handlers), so they cannot call hooks.
 *   The singleton is the standard pattern for bridging hook state into
 *   module-level code.
 */

type TokenGetter = () => Promise<string | null>;

/** Snapshot of Clerk auth state — kept current by ClerkTokenBridge. */
export interface ClerkAuthState {
  isLoaded: boolean;
  isSignedIn: boolean;
  /** True once setTokenGetter has been called at least once (Clerk is configured). */
  getterRegistered: boolean;
}

let _getter: TokenGetter | null = null;
let _everRegistered = false;
let _state: Pick<ClerkAuthState, 'isLoaded' | 'isSignedIn'> = {
  isLoaded: false,
  isSignedIn: false,
};

/**
 * Called by ClerkTokenBridge on every useAuth() state change.
 * Passing null for getter is valid (component unmounting or not loaded).
 */
export function setTokenGetter(
  getter: TokenGetter | null,
  state: { isLoaded: boolean; isSignedIn: boolean },
): void {
  _getter = getter;
  _state = state;
  _everRegistered = true; // Clerk is configured; at least one call has been made
}

/**
 * Retrieve a Clerk session JWT via the registered hook getter.
 *
 * waitMs: how long to poll for the getter to be registered before giving up.
 * Only waits when Clerk is configured (_everRegistered = true) but the getter
 * hasn't been set yet (ClerkTokenBridge not yet mounted). When Clerk is NOT
 * configured the getter is never registered and we return null immediately.
 */
export async function getTokenViaClerk(waitMs = 0): Promise<string | null> {
  // Fast path — getter already registered.
  // Capture into a local const so TypeScript's narrowing holds across the await.
  const fast = _getter;
  if (fast !== null) {
    try {
      return await fast();
    } catch (err) {
      console.error('[auth] hook getToken threw:', err);
      return null;
    }
  }

  // If Clerk was never configured, don't wait.
  if (!_everRegistered) return null;

  // Getter is temporarily null (first-render race: ClerkTokenBridge rendered
  // but its useEffect hasn't fired yet). Poll briefly.
  if (waitMs > 0) {
    const deadline = Date.now() + waitMs;
    while (_getter === null && Date.now() < deadline) {
      await new Promise<void>(r => setTimeout(r, 50));
    }
    // Re-capture after the poll loop for TypeScript narrowing.
    const polled = _getter;
    if (polled !== null) {
      try {
        return await polled();
      } catch (err) {
        console.error('[auth] hook getToken threw (after wait):', err);
        return null;
      }
    }
  }

  return null;
}

/**
 * Return a snapshot of the current Clerk auth state for diagnostic messages.
 * Safe to call from anywhere; never throws.
 */
export function getAuthDiagnostics(): ClerkAuthState {
  return {
    isLoaded: _state.isLoaded,
    isSignedIn: _state.isSignedIn,
    getterRegistered: _getter !== null,
  };
}
