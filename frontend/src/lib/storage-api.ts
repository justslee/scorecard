/**
 * API-backed storage layer.
 *
 * Semantics:
 *   - When authenticated: the backend API is authoritative. A cache copy is written
 *     to localStorage after every successful write so the app works offline.
 *   - When the API fails: the error is logged with console.error (never silently
 *     swallowed), and the call falls back to the local cache.
 *   - When not authenticated: localStorage only.
 *
 * Profile (GolferProfile): /api/profile/golfer does not exist yet. These functions
 * are localStorage-only until the backend-profile-endpoint item lands.
 */

import * as api from './api';
import * as localCache from './storage';
import { Round, Tournament, GolferProfile } from './types';

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------

async function isAuthenticated(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  // @ts-expect-error - Clerk exposes this on window
  const clerk = window.Clerk;
  return !!clerk?.session;
}

// ================
// Rounds
// ================

export async function getRoundsAsync(): Promise<Round[]> {
  if (!(await isAuthenticated())) {
    return localCache.getRounds();
  }
  try {
    // Backend returns full Round objects — no N+1 needed.
    return await api.getRounds();
  } catch (e) {
    console.error('[storage-api] getRounds: API unavailable, falling back to local cache:', e);
    return localCache.getRounds();
  }
}

export async function getRoundAsync(id: string): Promise<Round | null> {
  if (!(await isAuthenticated())) {
    return localCache.getRound(id);
  }
  try {
    return await api.getRound(id);
  } catch (e) {
    console.error(`[storage-api] getRound(${id}): API unavailable, falling back to local cache:`, e);
    return localCache.getRound(id);
  }
}

export async function saveRoundAsync(round: Round): Promise<void> {
  // Write-through: always persist locally so the app works offline.
  localCache.saveRound(round);

  if (!(await isAuthenticated())) return;

  try {
    // Check whether the round already exists on the backend.
    let exists = false;
    try {
      await api.getRound(round.id);
      exists = true;
    } catch {
      // 404 → not yet created.
    }

    if (exists) {
      // Push the current state (scores, games, groups, status) in one PUT.
      await api.updateRound(round.id, {
        scores: round.scores,
        games: round.games,
        groups: round.groups,
        status: round.status,
      });
    } else {
      // Create on the backend. Note: the backend will assign its own id;
      // full id reconciliation is handled in the wire-round-new item.
      await api.createRound({
        courseId: round.courseId,
        courseName: round.courseName,
        teeId: round.teeId,
        teeName: round.teeName,
        players: round.players,   // includes id — required by backend
        holes: round.holes,
        games: round.games,
        groups: round.groups,
        tournamentId: round.tournamentId,
      });
    }
  } catch (e) {
    console.error('[storage-api] saveRound: API sync failed (local cache saved):', e);
  }
}

export async function deleteRoundAsync(id: string): Promise<void> {
  localCache.deleteRound(id);

  if (!(await isAuthenticated())) return;

  try {
    await api.deleteRound(id);
  } catch (e) {
    console.error(`[storage-api] deleteRound(${id}): API call failed:`, e);
  }
}

// ================
// Tournaments
// ================

export async function getTournamentsAsync(): Promise<Tournament[]> {
  if (!(await isAuthenticated())) {
    return localCache.getTournaments();
  }
  try {
    return await api.getTournaments();
  } catch (e) {
    console.error('[storage-api] getTournaments: API unavailable, falling back to local cache:', e);
    return localCache.getTournaments();
  }
}

export async function getTournamentAsync(id: string): Promise<Tournament | null> {
  if (!(await isAuthenticated())) {
    return localCache.getTournament(id);
  }
  try {
    return await api.getTournament(id);
  } catch (e) {
    console.error(`[storage-api] getTournament(${id}): API unavailable, falling back to local cache:`, e);
    return localCache.getTournament(id);
  }
}

export async function saveTournamentAsync(tournament: Tournament): Promise<void> {
  localCache.saveTournament(tournament);

  if (!(await isAuthenticated())) return;

  try {
    let exists = false;
    try {
      await api.getTournament(tournament.id);
      exists = true;
    } catch {
      // 404 → not yet created.
    }

    if (exists) {
      await api.updateTournament(tournament.id, {
        name: tournament.name,
        numRounds: tournament.numRounds,
        roundIds: tournament.roundIds,
        playerIds: tournament.playerIds,
        games: tournament.games,
      });
    } else {
      await api.createTournament({
        name: tournament.name,
        numRounds: tournament.numRounds,
        playerIds: tournament.playerIds,
      });
    }
  } catch (e) {
    console.error('[storage-api] saveTournament: API sync failed (local cache saved):', e);
  }
}

export async function deleteTournamentAsync(id: string): Promise<void> {
  localCache.deleteTournament(id);

  if (!(await isAuthenticated())) return;

  try {
    await api.deleteTournament(id);
  } catch (e) {
    console.error(`[storage-api] deleteTournament(${id}): API call failed:`, e);
  }
}

// ================
// Profile — localStorage only until backend-profile-endpoint lands
// ================

export async function getGolferProfileAsync(): Promise<GolferProfile | null> {
  // TODO(backend-profile-endpoint): fetch from /api/profile/golfer once route exists.
  return localCache.getGolferProfile();
}

export async function saveGolferProfileAsync(profile: GolferProfile): Promise<void> {
  // TODO(backend-profile-endpoint): sync to /api/profile/golfer once route exists.
  localCache.saveGolferProfile(profile);
}
