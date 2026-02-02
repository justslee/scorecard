/**
 * API-backed storage layer.
 * Provides async versions of the storage functions that use the backend API.
 * Falls back to localStorage when API is unavailable or user is not authenticated.
 */

import * as api from './api';
import * as localStorage from './storage';
import { Round, Course, Tournament, GolferProfile } from './types';

// Check if user is authenticated
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
  try {
    if (await isAuthenticated()) {
      const apiRounds = await api.getRounds({ limit: 100 });
      // Fetch full details for each round
      const fullRounds = await Promise.all(
        apiRounds.map(r => api.getRound(r.id))
      );
      // Convert API format to frontend format
      return fullRounds.map(convertApiRoundToLocal);
    }
  } catch (e) {
    console.warn('API unavailable, using localStorage:', e);
  }
  return localStorage.getRounds();
}

export async function getRoundAsync(id: string): Promise<Round | null> {
  try {
    if (await isAuthenticated()) {
      const apiRound = await api.getRound(id);
      return convertApiRoundToLocal(apiRound);
    }
  } catch (e) {
    console.warn('API unavailable, using localStorage:', e);
  }
  return localStorage.getRound(id);
}

export async function saveRoundAsync(round: Round): Promise<void> {
  // Always save to localStorage for offline support
  localStorage.saveRound(round);
  
  try {
    if (await isAuthenticated()) {
      // Check if round exists
      try {
        await api.getRound(round.id);
        // Update existing
        await api.updateRound(round.id, {
          status: round.status,
          tee_id: round.teeId,
          tee_name: round.teeName,
        });
        // Sync scores
        for (const score of round.scores) {
          if (score.strokes !== null) {
            await api.addScore(round.id, {
              player_id: score.playerId,
              hole_number: score.holeNumber,
              strokes: score.strokes,
            });
          }
        }
      } catch {
        // Create new round
        await api.createRound({
          course_id: round.courseId,
          course_name: round.courseName,
          tee_id: round.teeId,
          tee_name: round.teeName,
          date: round.date,
          holes: round.holes,
          players: round.players.map(p => ({
            name: p.name,
            handicap: p.handicap,
          })),
          tournament_id: round.tournamentId,
        });
      }
    }
  } catch (e) {
    console.warn('Failed to sync round to API:', e);
  }
}

export async function deleteRoundAsync(id: string): Promise<void> {
  localStorage.deleteRound(id);
  
  try {
    if (await isAuthenticated()) {
      await api.deleteRound(id);
    }
  } catch (e) {
    console.warn('Failed to delete round from API:', e);
  }
}

// ================
// Tournaments
// ================

export async function getTournamentsAsync(): Promise<Tournament[]> {
  try {
    if (await isAuthenticated()) {
      const apiTournaments = await api.getTournaments({ limit: 100 });
      return apiTournaments.map(convertApiTournamentToLocal);
    }
  } catch (e) {
    console.warn('API unavailable, using localStorage:', e);
  }
  return localStorage.getTournaments();
}

export async function getTournamentAsync(id: string): Promise<Tournament | null> {
  try {
    if (await isAuthenticated()) {
      const apiTournament = await api.getTournament(id);
      return convertApiTournamentToLocal(apiTournament);
    }
  } catch (e) {
    console.warn('API unavailable, using localStorage:', e);
  }
  return localStorage.getTournament(id);
}

export async function saveTournamentAsync(tournament: Tournament): Promise<void> {
  localStorage.saveTournament(tournament);
  
  try {
    if (await isAuthenticated()) {
      try {
        await api.getTournament(tournament.id);
        // Update existing
        await api.updateTournament(tournament.id, {
          name: tournament.name,
          num_rounds: tournament.numRounds,
        });
      } catch {
        // Create new
        await api.createTournament({
          name: tournament.name,
          num_rounds: tournament.numRounds,
          player_ids: tournament.playerIds,
          player_names_by_id: tournament.playerNamesById || {},
        });
      }
    }
  } catch (e) {
    console.warn('Failed to sync tournament to API:', e);
  }
}

export async function deleteTournamentAsync(id: string): Promise<void> {
  localStorage.deleteTournament(id);
  
  try {
    if (await isAuthenticated()) {
      await api.deleteTournament(id);
    }
  } catch (e) {
    console.warn('Failed to delete tournament from API:', e);
  }
}

// ================
// Profile
// ================

export async function getGolferProfileAsync(): Promise<GolferProfile | null> {
  try {
    if (await isAuthenticated()) {
      const apiProfile = await api.getGolferProfile();
      if (apiProfile) {
        return convertApiProfileToLocal(apiProfile);
      }
    }
  } catch (e) {
    console.warn('API unavailable, using localStorage:', e);
  }
  return localStorage.getGolferProfile();
}

export async function saveGolferProfileAsync(profile: GolferProfile): Promise<void> {
  localStorage.saveGolferProfile(profile);
  
  try {
    if (await isAuthenticated()) {
      const existing = await api.getGolferProfile();
      if (existing) {
        await api.updateGolferProfile({
          name: profile.name,
          handicap: profile.handicap,
          home_course: profile.homeCourse,
          club_distances: convertClubDistancesToApi(profile.clubDistances),
        });
      } else {
        await api.createGolferProfile({
          name: profile.name,
          handicap: profile.handicap,
          home_course: profile.homeCourse,
          club_distances: convertClubDistancesToApi(profile.clubDistances),
        });
      }
    }
  } catch (e) {
    console.warn('Failed to sync profile to API:', e);
  }
}

// ================
// Converters
// ================

function convertApiRoundToLocal(apiRound: api.Round): Round {
  return {
    id: apiRound.id,
    courseId: apiRound.course_id,
    courseName: apiRound.course_name,
    teeId: apiRound.tee_id || undefined,
    teeName: apiRound.tee_name || undefined,
    date: apiRound.date,
    players: apiRound.players.map(p => ({
      id: p.id,
      name: p.name,
      handicap: p.handicap ?? undefined,
    })),
    scores: apiRound.scores.map(s => ({
      playerId: s.player_id,
      holeNumber: s.hole_number,
      strokes: s.strokes,
    })),
    holes: apiRound.holes,
    games: [], // Games loaded separately if needed
    status: apiRound.status,
    tournamentId: apiRound.tournament_id || undefined,
    createdAt: apiRound.created_at,
    updatedAt: apiRound.updated_at,
  };
}

function convertApiTournamentToLocal(apiTournament: api.Tournament): Tournament {
  return {
    id: apiTournament.id,
    name: apiTournament.name,
    playerIds: apiTournament.player_ids,
    roundIds: apiTournament.round_ids,
    createdAt: apiTournament.created_at,
    numRounds: apiTournament.num_rounds ?? undefined,
    playerNamesById: apiTournament.player_names_by_id,
  };
}

function convertApiProfileToLocal(apiProfile: api.GolferProfile): GolferProfile {
  const clubDistances: GolferProfile['clubDistances'] = {};
  
  if (apiProfile.club_distances) {
    const mapping: Record<string, keyof GolferProfile['clubDistances']> = {
      driver: 'driver',
      three_wood: 'threeWood',
      five_wood: 'fiveWood',
      hybrid: 'hybrid',
      four_iron: 'fourIron',
      five_iron: 'fiveIron',
      six_iron: 'sixIron',
      seven_iron: 'sevenIron',
      eight_iron: 'eightIron',
      nine_iron: 'nineIron',
      pitching_wedge: 'pitchingWedge',
      gap_wedge: 'gapWedge',
      sand_wedge: 'sandWedge',
      lob_wedge: 'lobWedge',
      putter: 'putter',
    };
    
    for (const [apiKey, localKey] of Object.entries(mapping)) {
      if (apiProfile.club_distances[apiKey] !== undefined) {
        clubDistances[localKey] = apiProfile.club_distances[apiKey];
      }
    }
  }
  
  return {
    id: apiProfile.id,
    name: apiProfile.name,
    handicap: apiProfile.handicap,
    homeCourse: apiProfile.home_course,
    clubDistances,
  };
}

function convertClubDistancesToApi(
  clubDistances: GolferProfile['clubDistances']
): Record<string, number> | null {
  if (!clubDistances) return null;
  
  const result: Record<string, number> = {};
  const mapping: Record<keyof GolferProfile['clubDistances'], string> = {
    driver: 'driver',
    threeWood: 'three_wood',
    fiveWood: 'five_wood',
    hybrid: 'hybrid',
    fourIron: 'four_iron',
    fiveIron: 'five_iron',
    sixIron: 'six_iron',
    sevenIron: 'seven_iron',
    eightIron: 'eight_iron',
    nineIron: 'nine_iron',
    pitchingWedge: 'pitching_wedge',
    gapWedge: 'gap_wedge',
    sandWedge: 'sand_wedge',
    lobWedge: 'lob_wedge',
    putter: 'putter',
  };
  
  for (const [localKey, apiKey] of Object.entries(mapping)) {
    const value = clubDistances[localKey as keyof typeof clubDistances];
    if (value !== undefined) {
      result[apiKey] = value;
    }
  }
  
  return Object.keys(result).length > 0 ? result : null;
}
