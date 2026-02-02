'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import * as storageApi from '@/lib/storage-api';
import * as localStorage from '@/lib/storage';
import { Round, Tournament, GolferProfile } from '@/lib/types';

/**
 * Hook for accessing rounds with API sync.
 */
export function useRounds() {
  const { isSignedIn } = useAuth();
  const [rounds, setRounds] = useState<Round[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await storageApi.getRoundsAsync();
      setRounds(data);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to load rounds'));
      // Fall back to localStorage
      setRounds(localStorage.getRounds());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, isSignedIn]);

  const saveRound = useCallback(async (round: Round) => {
    await storageApi.saveRoundAsync(round);
    await refresh();
  }, [refresh]);

  const deleteRound = useCallback(async (id: string) => {
    await storageApi.deleteRoundAsync(id);
    await refresh();
  }, [refresh]);

  return { rounds, loading, error, refresh, saveRound, deleteRound };
}

/**
 * Hook for accessing a single round with API sync.
 */
export function useRound(id: string | undefined) {
  const { isSignedIn } = useAuth();
  const [round, setRound] = useState<Round | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!id) {
      setRound(null);
      setLoading(false);
      return;
    }
    
    setLoading(true);
    setError(null);
    try {
      const data = await storageApi.getRoundAsync(id);
      setRound(data);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to load round'));
      setRound(localStorage.getRound(id));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh, isSignedIn]);

  const save = useCallback(async (updated: Round) => {
    await storageApi.saveRoundAsync(updated);
    setRound(updated);
  }, []);

  return { round, loading, error, refresh, save };
}

/**
 * Hook for accessing tournaments with API sync.
 */
export function useTournaments() {
  const { isSignedIn } = useAuth();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await storageApi.getTournamentsAsync();
      setTournaments(data);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to load tournaments'));
      setTournaments(localStorage.getTournaments());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, isSignedIn]);

  const saveTournament = useCallback(async (tournament: Tournament) => {
    await storageApi.saveTournamentAsync(tournament);
    await refresh();
  }, [refresh]);

  const deleteTournament = useCallback(async (id: string) => {
    await storageApi.deleteTournamentAsync(id);
    await refresh();
  }, [refresh]);

  return { tournaments, loading, error, refresh, saveTournament, deleteTournament };
}

/**
 * Hook for accessing a single tournament with API sync.
 */
export function useTournament(id: string | undefined) {
  const { isSignedIn } = useAuth();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!id) {
      setTournament(null);
      setLoading(false);
      return;
    }
    
    setLoading(true);
    setError(null);
    try {
      const data = await storageApi.getTournamentAsync(id);
      setTournament(data);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to load tournament'));
      setTournament(localStorage.getTournament(id));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh, isSignedIn]);

  const save = useCallback(async (updated: Tournament) => {
    await storageApi.saveTournamentAsync(updated);
    setTournament(updated);
  }, []);

  return { tournament, loading, error, refresh, save };
}

/**
 * Hook for accessing golfer profile with API sync.
 */
export function useGolferProfile() {
  const { isSignedIn } = useAuth();
  const [profile, setProfile] = useState<GolferProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await storageApi.getGolferProfileAsync();
      setProfile(data);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Failed to load profile'));
      setProfile(localStorage.getGolferProfile());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, isSignedIn]);

  const save = useCallback(async (updated: GolferProfile) => {
    await storageApi.saveGolferProfileAsync(updated);
    setProfile(updated);
  }, []);

  return { profile, loading, error, refresh, save };
}
