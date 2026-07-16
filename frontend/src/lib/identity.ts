"use client";

/**
 * Client identity — "who am I" (specs/multi-user-epic-plan.md §3.5,
 * multiuser-p0-client-identity).
 *
 * `getCurrentUserId()` is the SYNCHRONOUS source of truth used by
 * `storage-keys.ts` (and therefore storage.ts + every pref store) for
 * localStorage key derivation. storage.ts's reads are synchronous and
 * cannot await Clerk's async hydration, so this must stay synchronous.
 *
 * `useMe()` is the reactive counterpart — wraps Clerk's `useUser()`
 * (ClerkProvider already wraps the app, see AuthProvider.tsx). It is the
 * PRIMARY writer of `scorecard_last_user_id`: on native/Capacitor,
 * `window.Clerk` frequently never hydrates (see the extensive comments in
 * api.ts / storage-api.ts / AuthProvider.tsx — the whole reason
 * ClerkTokenBridge exists), so `getCurrentUserId()`'s opportunistic write
 * below is a nice-to-have on web only; `useMe()`, mounted via
 * `<IdentityBridge/>` in AuthProvider.tsx, is what makes this reliable on
 * every platform.
 */

import { useEffect, useRef } from "react";
import { useUser } from "@clerk/react";
import { getGolferProfileAsync, updateGolferProfile } from "./api";
import { getCurrentUserId } from "./identity-core";

const LAST_USER_KEY = "scorecard_last_user_id";

// Re-exported so `getCurrentUserId` has one canonical import path
// (`@/lib/identity`) for consumers that don't need the framework-free split
// — see identity-core.ts's file header for why the implementation lives
// there.
export { getCurrentUserId };

/**
 * Idempotent, best-effort "ensure the golfer_profiles row exists" — reuses
 * the existing upsert PUT (no new backend endpoint). PUT with no fields is a
 * safe no-op against an existing row (backend only touches fields present in
 * `model_fields_set`, see backend/app/routes/profile.py) and creates an empty
 * row on first sign-in otherwise. Never throws — offline/API failure is
 * silently skipped; the profile route upserts lazily on the next real save
 * anyway, so nothing is lost by skipping here.
 */
async function ensureGolferProfile(): Promise<void> {
  try {
    const existing = await getGolferProfileAsync();
    if (existing) return;
    await updateGolferProfile({});
  } catch {
    // Offline / API error — non-fatal, retried on the next sign-in.
  }
}

// ---------------------------------------------------------------------------
// NOTE — self SavedPlayer (deliberately NOT implemented, see below)
// ---------------------------------------------------------------------------
// specs/multi-user-epic-plan.md §3.5 also asks to "ensure a self SavedPlayer
// exists with clerkUserId === me". The `players.clerk_user_id` COLUMN exists
// (backend/app/db/models.py:211) but there is no API path to WRITE it:
// `PlayerCreate`/`PlayerUpdate` (backend/app/models.py:61-74) have no
// `clerkUserId` field and `POST /api/players` never stamps one. Creating a
// player from the client today would produce an unidentifiable "Me" row with
// `clerkUserId: null` — the idempotency check
// (`getSavedPlayers().some(p => p.clerkUserId === me)`) could never find it
// on a later sign-in, so every sign-in on every device would mint a NEW
// duplicate "Me" player. That's worse than not doing it. Left as a no-op
// pending a small, explicitly-scoped backend addition (accept an optional
// `clerkUserId` in `PlayerCreate`, server-stamped/validated to
// `== current_user_id` — never client-trusted for any other value) — flagged
// for the eng-lead rather than guessed at here. The "this is me" pill
// (app/round/new/page.tsx) and `ownerIndex` default are UNCHANGED (still
// default to 0 / the first player) for the same reason: there is no reliable
// self-player marker to default onto yet.
// ---------------------------------------------------------------------------

export interface MeState {
  /** The signed-in Clerk user id, or null when signed out / not yet loaded. */
  userId: string | null;
  isLoaded: boolean;
  isSignedIn: boolean;
}

/**
 * `useMe()` — the reactive "who am I" hook. Wraps `useUser()`. On sign-in it
 * best-effort ensures the `golfer_profiles` row exists (see
 * `ensureGolferProfile` above) and persists `scorecard_last_user_id` so
 * offline/logged-out reads on this device resolve to the correct namespace
 * (`getCurrentUserId()`'s fallback, `storage-api.ts`'s offline path).
 *
 * Defensive by design: every side effect is wrapped so a failure here can
 * never throw into render or block sign-in.
 */
export function useMe(): MeState {
  const { isLoaded, isSignedIn, user } = useUser();
  const ensuredForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user?.id) return;

    try {
      window.localStorage.setItem(LAST_USER_KEY, user.id);
    } catch {
      // Private mode / quota — non-fatal, this device just won't remember
      // the namespace across an offline reload.
    }

    // Run the ensure-steps once per signed-in user id (not on every
    // re-render — `user` is a fresh object reference from Clerk often).
    if (ensuredForRef.current === user.id) return;
    ensuredForRef.current = user.id;

    void ensureGolferProfile();
  }, [isLoaded, isSignedIn, user?.id]);

  return {
    userId: isSignedIn && user?.id ? user.id : null,
    isLoaded: Boolean(isLoaded),
    isSignedIn: Boolean(isSignedIn),
  };
}

/**
 * Invisible bridge component that mounts `useMe()` for the whole app — same
 * pattern as `ClerkTokenBridge` (must render inside `<ClerkProvider>`, and
 * before `<AuthGate>` so its effect (persisting `scorecard_last_user_id`)
 * commits before any newly-mounted page reads namespaced storage). Renders
 * no UI.
 */
export function IdentityBridge(): null {
  useMe();
  return null;
}
