"use client";

/**
 * Caddie persona selection — the REAL backend personas (classic / strategist /
 * hype / professor + user customs), replacing the cosmetic CADDIES list in
 * tokens.ts whose ids ("steve"…) don't exist server-side and silently fell
 * back to 'classic' in every prompt.
 *
 * Resolution order for the active persona id:
 *   1. server profile (player_profiles.preferred_personality_id) — wins
 *   2. localStorage (last selection; offline fallback)
 *   3. 'classic'
 * Selection persists to BOTH (PUT /caddie/profile is fire-and-forget).
 */

import { useCallback, useEffect, useState } from 'react';
import type { Caddy } from '@/components/yardage/tokens';
import type { CaddiePersonalityInfo } from './types';
import { fetchPersonalities, getCaddieProfile, updateCaddieProfile } from './api';

export const DEFAULT_PERSONA_ID = 'classic';

const STORAGE_KEY = 'looper.caddiePersonaId';

/** Static fallback for the 4 built-ins so the sheet renders a real persona
 *  name before (or without) the network. Mirrors backend personalities.py. */
export const BUILTIN_PERSONAS: CaddiePersonalityInfo[] = [
  {
    id: 'classic',
    name: 'The Classic Caddie',
    description: 'Traditional caddie feel — knowledgeable, conversational, focused.',
    avatar: '🏌️',
    response_style: 'conversational',
    traits: [],
    is_builtin: true,
  },
  {
    id: 'strategist',
    name: 'The Strategist',
    description: 'Data-driven, DECADE-style. Speaks in numbers and probabilities.',
    avatar: '📊',
    response_style: 'brief',
    traits: [],
    is_builtin: true,
  },
  {
    id: 'hype',
    name: 'The Hype Man',
    description: 'Motivational, positive energy. Builds confidence.',
    avatar: '🔥',
    response_style: 'conversational',
    traits: [],
    is_builtin: true,
  },
  {
    id: 'professor',
    name: 'The Professor',
    description: 'Teaches as you go. Explains the why behind every decision.',
    avatar: '🎓',
    response_style: 'detailed',
    traits: [],
    is_builtin: true,
  },
];

/** Strips a leading "The " (case-insensitive) from a persona's display name
 *  — e.g. "The Hype Man" → "Hype Man". Shared by the Caddy adapter below and
 *  any surface that needs the short form (e.g. the Looper sheet's speaker
 *  attribution captions). */
export function shortPersonaName(name: string): string {
  return name.replace(/^The\s+/i, '').trim();
}

/** Display adapter: backend persona → the yardage-book Caddy shape the round
 *  screen + sheet already render (medallion initial, name, tag line). */
export function personaToCaddy(p: CaddiePersonalityInfo): Caddy {
  const short = shortPersonaName(p.name);
  return {
    id: p.id,
    name: p.name,
    initial: (short[0] || p.name[0] || 'C').toUpperCase(),
    tag: p.description,
  };
}

/** Server preference wins; localStorage covers offline; 'classic' is the floor. */
export function resolvePersonaId(
  serverPreferred: string | null | undefined,
  local: string | null | undefined,
): string {
  return serverPreferred || local || DEFAULT_PERSONA_ID;
}

function readLocalPersonaId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocalPersonaId(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode / quota — non-fatal, server profile still persists.
  }
}

export interface CaddiePersonaState {
  /** Active persona id — always a usable backend id. */
  personaId: string;
  /** Display shape for the existing round-screen/sheet chrome. */
  caddy: Caddy;
  /** All personas visible to the user (built-ins + own customs). */
  personas: CaddiePersonalityInfo[];
  /** Select + persist (localStorage immediately, PUT profile fire-and-forget). */
  selectPersona: (id: string) => void;
}

// Cross-instance sync: the picker lives ONLY on the round page's CaddieSheet
// today (RoundPageClient -> CaddieSheet), while the omnipresent orb host
// (CaddieOrbSheet, mounted once in layout.tsx) mounts its OWN hook instance.
// A `storage` event fires only in OTHER tabs, never the tab that wrote it, so
// it can't converge the same-tab "change persona on the round page, then talk
// to the orb on Home" path. This tiny module-level pub-sub (same pattern as
// looper-bus.ts's onLooperOpen / caddie-context.ts's onCaddieContextChange)
// lets every mounted instance converge on whichever one resolves last.
const personaListeners = new Set<(id: string) => void>();

function notifyPersonaChange(id: string): void {
  for (const l of personaListeners) l(id);
}

export function useCaddiePersona(): CaddiePersonaState {
  const [personaId, setPersonaId] = useState<string>(
    () => readLocalPersonaId() || DEFAULT_PERSONA_ID,
  );
  const [personas, setPersonas] = useState<CaddiePersonalityInfo[]>(BUILTIN_PERSONAS);

  useEffect(() => {
    personaListeners.add(setPersonaId);
    return () => {
      personaListeners.delete(setPersonaId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Independent fetches: a profile failure must not hide the persona list.
      const [listRes, profileRes] = await Promise.allSettled([
        fetchPersonalities(),
        getCaddieProfile(),
      ]);
      if (cancelled) return;
      if (listRes.status === 'fulfilled' && listRes.value.length > 0) {
        setPersonas(listRes.value);
      }
      if (profileRes.status === 'fulfilled') {
        const resolved = resolvePersonaId(
          profileRes.value.preferred_personality_id,
          readLocalPersonaId(),
        );
        setPersonaId(resolved);
        writeLocalPersonaId(resolved);
        notifyPersonaChange(resolved);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectPersona = useCallback((id: string) => {
    setPersonaId(id);
    writeLocalPersonaId(id);
    notifyPersonaChange(id);
    updateCaddieProfile(id).catch(() => {
      // Offline / transient — localStorage keeps the choice for this device.
    });
  }, []);

  const active =
    personas.find((p) => p.id === personaId) ??
    BUILTIN_PERSONAS.find((p) => p.id === personaId) ??
    BUILTIN_PERSONAS[0];

  return { personaId, caddy: personaToCaddy(active), personas, selectPersona };
}
