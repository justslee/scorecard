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
 * Profile (GolferProfile): backed by GET/PUT /api/profile/golfer.
 * localStorage is used as an explicit offline cache (write-through on save).
 */

import * as api from './api';
import * as localCache from './storage';
import { Round, Tournament, GolferProfile, SavedPlayer } from './types';

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------

async function isAuthenticated(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  // window.Clerk is typed via @clerk/clerk-js global declaration.
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
// Profile — API authoritative; localStorage is an explicit offline cache.
// ================

export async function getGolferProfileAsync(): Promise<GolferProfile | null> {
  if (!(await isAuthenticated())) {
    return localCache.getGolferProfile();
  }
  try {
    const remote = await api.getGolferProfileAsync();
    if (remote) {
      // Keep local cache warm so the app can render offline.
      localCache.saveGolferProfile(remote);
    }
    return remote;
  } catch (e) {
    console.error('[storage-api] getGolferProfile: API unavailable, falling back to local cache:', e);
    return localCache.getGolferProfile();
  }
}

export async function saveGolferProfileAsync(profile: GolferProfile): Promise<void> {
  // Write-through: persist locally first so the app works offline.
  localCache.saveGolferProfile(profile);

  if (!(await isAuthenticated())) return;

  try {
    // Identity fields only — clubDistances is intentionally OMITTED.
    // Omitting means the backend (model_fields_set) won't touch the bag,
    // protecting an existing bag from being wiped by a stale/empty cache value
    // when the identity editor saves. The bag is written via saveGolferBagAsync.
    //
    // null flows through explicitly (intentional field clear) — the backend
    // model_fields_set sees "handicap":null and writes NULL to the column.
    await api.updateGolferProfile({
      name: profile.name,
      handicap: profile.handicap,      // null → explicit clear
      homeCourse: profile.homeCourse,  // null → explicit clear
    });
  } catch (e) {
    console.error('[storage-api] saveGolferProfile: API sync failed (local cache saved):', e);
    // Re-throw API rejections (4xx / 5xx) so callers can surface the error in UI.
    // Keep network-down (TypeError: failed to fetch) as a silent offline operation —
    // local cache already has the value; a reload will retry.
    if (!(e instanceof TypeError)) {
      throw e;
    }
  }
}

// ================
// Players — API authoritative; localStorage is an explicit offline cache.
// ================

/**
 * Fetch the owner's saved players.
 * When authenticated, uses the API (source of truth) and falls back to the
 * local cache only when the API is unreachable. When not authenticated,
 * returns the local cache.
 */
export async function getPlayersAsync(): Promise<SavedPlayer[]> {
  if (!(await isAuthenticated())) {
    return localCache.getSavedPlayers();
  }
  try {
    return await api.getPlayers();
  } catch (e) {
    console.error('[storage-api] getPlayers: API unavailable, falling back to local cache:', e);
    return localCache.getSavedPlayers();
  }
}

/**
 * Create a new saved player via the API.
 * Write-through: on success the local cache is updated so the app works offline.
 * Throws when not authenticated or when the API rejects (4xx/5xx).
 */
export async function createPlayerAsync(data: api.PlayerCreate): Promise<SavedPlayer> {
  if (!(await isAuthenticated())) {
    throw new Error('Sign in to add players.');
  }
  // API-authoritative: throws on any API error; let the caller surface it.
  const saved = await api.createPlayer(data);
  localCache.saveSavedPlayer(saved);
  return saved;
}

/**
 * Update an existing saved player via the API.
 * Write-through: on success the local cache is updated.
 * Throws when not authenticated or when the API rejects (4xx/5xx).
 */
export async function updatePlayerAsync(
  id: string,
  data: api.PlayerUpdate
): Promise<SavedPlayer> {
  if (!(await isAuthenticated())) {
    throw new Error('Sign in to edit players.');
  }
  const saved = await api.updatePlayer(id, data);
  localCache.saveSavedPlayer(saved);
  return saved;
}

/**
 * Delete a saved player via the API, then remove from the local cache.
 * If not authenticated, removes from local cache only.
 * Throws on API rejection so the caller can roll back optimistic UI updates.
 * Network errors (offline) are re-thrown as well — the caller decides whether
 * to rollback or accept the local-only delete.
 */
export async function deletePlayerAsync(id: string): Promise<void> {
  if (!(await isAuthenticated())) {
    localCache.deleteSavedPlayer(id);
    return;
  }
  // API-authoritative: remove from backend first, then sync local cache.
  await api.deletePlayer(id);
  localCache.deleteSavedPlayer(id);
}

/**
 * Save only the bag (clubDistances) via PUT /api/profile/golfer.
 *
 * Kept separate from saveGolferProfileAsync (identity: name/handicap/homeCourse)
 * so the two editors never clobber each other's fields. The backend only updates
 * the fields present in the JSON body (model_fields_set), so sending only
 * clubDistances here leaves the identity fields untouched, and saving identity
 * leaves the bag untouched.
 */
export async function saveGolferBagAsync(
  clubDistances: GolferProfile['clubDistances']
): Promise<void> {
  // Write-through: merge into local cache so the app works offline.
  const cached = localCache.getGolferProfile();
  if (cached) {
    localCache.saveGolferProfile({ ...cached, clubDistances });
  }

  if (!(await isAuthenticated())) return;

  try {
    // Send ONLY clubDistances — name/handicap/homeCourse intentionally omitted
    // so identity values set by the identity editor are never overwritten here.
    await api.updateGolferProfile({ clubDistances });
  } catch (e) {
    console.error('[storage-api] saveGolferBag: API sync failed (local cache saved):', e);
    // Re-throw API rejections (4xx / 5xx) so the UI can surface the error.
    // Keep network-down (TypeError: failed to fetch) silent — local cache updated.
    if (!(e instanceof TypeError)) {
      throw e;
    }
  }
}
