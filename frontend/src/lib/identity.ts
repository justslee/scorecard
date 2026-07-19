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

import { useEffect, useSyncExternalStore } from "react";
import { useUser } from "@clerk/react";
import { getGolferProfileAsync, updateGolferProfile } from "./api";
import { getCurrentUserId } from "./identity-core";
import { storageKey } from "./storage-keys";
import type { GolferProfile } from "./types";

const LAST_USER_KEY = "scorecard_last_user_id";

// Re-exported so `getCurrentUserId` has one canonical import path
// (`@/lib/identity`) for consumers that don't need the framework-free split
// — see identity-core.ts's file header for why the implementation lives
// there.
export { getCurrentUserId };

// ---------------------------------------------------------------------------
// Onboarding tri-state store (specs/onboarding-shell-and-gate-plan.md §1.2)
// ---------------------------------------------------------------------------
// A small module-level store, consumed via `useSyncExternalStore` so every
// `useMe()` call site (IdentityBridge AND AuthGate) sees ONE shared value —
// no new architectural seam, this lives beside `useMe` deliberately.

/** The last COMPLETED onboarding step. */
export type OnboardingStepValue = "name" | "handicap" | "bag" | "done";
/** Tri-state gate value: 'unknown' until the profile GET resolves; null =
 *  row exists/created but nothing completed yet (brand-new user). */
export type OnboardingStepState = OnboardingStepValue | null | "unknown";

const ONBOARDING_STEP_CACHE_NAME = "onboarding_step";
/** localStorage can't store `null` directly — 'new' is the null sentinel. */
const ONBOARDING_NULL_SENTINEL = "new";

interface OnboardingSnapshot {
  userId: string | null;
  step: OnboardingStepState;
  /** The GolferProfile fetched during hydration — lets the onboarding flow
   *  prefill (name, handicap, ...) with NO second fetch. */
  profile: GolferProfile | null;
}

function readCachedOnboardingStep(): OnboardingStepState {
  try {
    const raw = window.localStorage.getItem(storageKey(ONBOARDING_STEP_CACHE_NAME));
    if (raw === null) return "unknown";
    if (raw === ONBOARDING_NULL_SENTINEL) return null;
    return raw as OnboardingStepValue;
  } catch {
    return "unknown"; // Storage unavailable (private mode / quota).
  }
}

function writeCachedOnboardingStep(step: OnboardingStepValue | null): void {
  try {
    window.localStorage.setItem(
      storageKey(ONBOARDING_STEP_CACHE_NAME),
      step === null ? ONBOARDING_NULL_SENTINEL : step,
    );
  } catch {
    // Private mode / quota — non-fatal, just no persisted cache for next open.
  }
}

// Lazy-initialize SYNCHRONOUSLY from the namespaced cache so a returning
// "done" user's first render already reads 'done' — zero-flash — while the
// GET below revalidates in the background. On the server (no window) this
// stays 'unknown', which is exactly right (AuthGate never mounts at
// static-export prerender, per AuthGate.tsx's header comment).
let onboardingSnapshot: OnboardingSnapshot = {
  userId: typeof window !== "undefined" ? getCurrentUserId() : null,
  step: typeof window !== "undefined" ? readCachedOnboardingStep() : "unknown",
  profile: null,
};

const onboardingListeners = new Set<() => void>();

/** Module-level once-per-user guard — replaces a per-instance ref so a
 *  SECOND `useMe()` mount (AuthGate, alongside IdentityBridge) can never
 *  double-fetch / double-run the ensure-PUT. */
let hydratedForUserId: string | null = null;

function notifyOnboardingListeners(): void {
  onboardingListeners.forEach((listener) => listener());
}

function subscribeOnboarding(listener: () => void): () => void {
  onboardingListeners.add(listener);
  return () => onboardingListeners.delete(listener);
}

function getOnboardingSnapshot(): OnboardingSnapshot {
  return onboardingSnapshot;
}

function setOnboardingSnapshot(
  userId: string | null,
  step: OnboardingStepState,
  opts: { persist?: boolean; profile?: GolferProfile | null } = {},
): void {
  const { persist = false, profile } = opts;
  onboardingSnapshot = {
    userId,
    step,
    profile: profile !== undefined ? profile : onboardingSnapshot.profile,
  };
  if (persist && step !== "unknown") {
    writeCachedOnboardingStep(step);
  }
  notifyOnboardingListeners();
}

/**
 * Writer API for the onboarding flow — call after each successful step PUT.
 * Calling it with 'done' is what lets `router.replace('/')` land straight on
 * children with no bounce-back through the gate.
 */
export function publishOnboardingStep(
  userId: string,
  step: OnboardingStepValue | null,
): void {
  setOnboardingSnapshot(userId, step, { persist: true });
}

/** The GolferProfile fetched during hydration, for the onboarding flow's
 *  prefills (name / handicap). Null before hydration resolves. */
export function getHydratedGolferProfile(): GolferProfile | null {
  return onboardingSnapshot.profile;
}

/**
 * Fetch the golfer profile once per signed-in user, publish the onboarding
 * step (and retain the profile for prefills — no second fetch needed by the
 * onboarding flow), and preserve the existing ensure-PUT-{} behavior when no
 * row exists yet. Never throws into render: on fetch failure, fail OPEN to
 * the cached step (or 'done' if nothing is cached) with `persist:false` so
 * the next successful GET re-gates correctly — this also keeps the existing
 * Tier-2 e2e core journeys green, since Playwright runs with no backend at
 * localhost:8000 (specs/onboarding-shell-and-gate-plan.md §1.2/§4).
 */
async function hydrateGolferProfile(userId: string): Promise<void> {
  // Re-anchor the snapshot to THIS user immediately (covers the case where
  // module init ran before a user id was known, or a different user's cache
  // was last on this device — account switch) so the tri-state reads
  // correctly while the GET below is in flight.
  if (onboardingSnapshot.userId !== userId) {
    setOnboardingSnapshot(userId, readCachedOnboardingStep(), { persist: false });
  }

  try {
    const existing = await getGolferProfileAsync();
    if (existing) {
      setOnboardingSnapshot(
        userId,
        (existing.onboardingStep as OnboardingStepValue | null) ?? null,
        { persist: true, profile: existing },
      );
      return;
    }
    // 204 — no row yet. Ensure it exists (existing behavior: a safe no-op
    // PUT that creates an empty row), then publish null (a freshly-ensured
    // row has onboarding_step NULL — funneled into onboarding, by design).
    await updateGolferProfile({});
    setOnboardingSnapshot(userId, null, { persist: true, profile: null });
  } catch {
    const cached = readCachedOnboardingStep();
    setOnboardingSnapshot(userId, cached === "unknown" ? "done" : cached, {
      persist: false,
    });
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
  /** Tri-state onboarding gate value — 'unknown' until the profile GET
   *  resolves for THIS user (never leaks another user's step on account
   *  switch — see `hydrateGolferProfile`'s per-user re-anchor). */
  onboardingStep: OnboardingStepState;
}

/**
 * `useMe()` — the reactive "who am I" hook. Wraps `useUser()`. On sign-in it
 * hydrates the onboarding step (see `hydrateGolferProfile` above, which also
 * best-effort ensures the `golfer_profiles` row exists) and persists
 * `scorecard_last_user_id` so offline/logged-out reads on this device
 * resolve to the correct namespace (`getCurrentUserId()`'s fallback,
 * `storage-api.ts`'s offline path).
 *
 * Defensive by design: every side effect is wrapped so a failure here can
 * never throw into render or block sign-in.
 */
export function useMe(): MeState {
  const { isLoaded, isSignedIn, user } = useUser();
  const onboarding = useSyncExternalStore(
    subscribeOnboarding,
    getOnboardingSnapshot,
    getOnboardingSnapshot,
  );

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user?.id) return;

    try {
      window.localStorage.setItem(LAST_USER_KEY, user.id);
    } catch {
      // Private mode / quota — non-fatal, this device just won't remember
      // the namespace across an offline reload.
    }

    // Run the hydrate-steps once per signed-in user id (module-level guard —
    // not a per-instance ref — so a SECOND useMe() mount, e.g. AuthGate
    // alongside IdentityBridge, can never double-fetch/double-ensure).
    if (hydratedForUserId === user.id) return;
    hydratedForUserId = user.id;

    void hydrateGolferProfile(user.id);
  }, [isLoaded, isSignedIn, user?.id]);

  const userId = isSignedIn && user?.id ? user.id : null;

  return {
    userId,
    isLoaded: Boolean(isLoaded),
    isSignedIn: Boolean(isSignedIn),
    // Never leak a mismatched user's snapshot (account switch on one device).
    onboardingStep: userId && onboarding.userId === userId ? onboarding.step : "unknown",
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
