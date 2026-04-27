// Local personality definitions for UI rendering (mirrors Python backend)

export interface CaddiePersonality {
  id: string;
  name: string;
  description: string;
  avatar: string;
  responseStyle: 'brief' | 'detailed' | 'conversational';
  traits: string[];
  voiceStyle: {
    pitch: number;
    rate: number;
  };
}

// First-paint seed list. The DB at /api/caddie/personalities is the source of
// truth — CaddiePanel fetches and replaces this on mount.
export const PERSONALITIES: CaddiePersonality[] = [
  {
    id: 'strategist',
    name: 'The Strategist',
    description: 'Data-driven, DECADE-style. Numbers and probabilities.',
    avatar: '📊',
    responseStyle: 'brief',
    traits: ['statistical', 'precise', 'strokes-gained'],
    voiceStyle: { pitch: 0.9, rate: 0.95 },
  },
  {
    id: 'classic',
    name: 'The Classic Caddie',
    description: 'Traditional caddie feel — conversational, focused.',
    avatar: '🏌️',
    responseStyle: 'conversational',
    traits: ['experienced', 'calm', 'course-savvy'],
    voiceStyle: { pitch: 1.0, rate: 1.0 },
  },
  {
    id: 'hype',
    name: 'The Hype Man',
    description: 'Motivational, positive energy. Confidence builder.',
    avatar: '🔥',
    responseStyle: 'conversational',
    traits: ['energetic', 'positive', 'celebratory'],
    voiceStyle: { pitch: 1.15, rate: 1.1 },
  },
  {
    id: 'professor',
    name: 'The Professor',
    description: 'Teaches as you go. Explains the why behind everything.',
    avatar: '🎓',
    responseStyle: 'detailed',
    traits: ['educational', 'thorough', 'analytical'],
    voiceStyle: { pitch: 0.95, rate: 0.9 },
  },
  {
    id: 'veteran-looper',
    name: 'The Veteran Looper',
    description: 'Old-school course manager. Calm, patient, conservative.',
    avatar: '🎒',
    responseStyle: 'conversational',
    traits: ['calm', 'patient', 'course-management'],
    voiceStyle: { pitch: 0.95, rate: 0.92 },
  },
  {
    id: 'hard-edge',
    name: 'The Hard Edge',
    description: 'Intense and blunt. No sugar-coating. Demands commitment.',
    avatar: '💎',
    responseStyle: 'brief',
    traits: ['intense', 'blunt', 'demanding'],
    voiceStyle: { pitch: 0.92, rate: 1.0 },
  },
  {
    id: 'course-historian',
    name: 'The Course Historian',
    description: 'Knows every blade of grass. Stories and traditional feel.',
    avatar: '📜',
    responseStyle: 'conversational',
    traits: ['traditional', 'storytelling', 'feel-based'],
    voiceStyle: { pitch: 0.95, rate: 0.9 },
  },
  {
    id: 'trash-talker',
    name: 'The Trash Talker',
    description: 'Keeps you loose with humor. Playful, confident, real advice underneath.',
    avatar: '😈',
    responseStyle: 'conversational',
    traits: ['playful', 'sharp-tongued', 'loose'],
    voiceStyle: { pitch: 1.1, rate: 1.05 },
  },
];

const CADDIE_PERSONALITY_KEY = 'scorecard_caddie_personality';
const CLASSIC = PERSONALITIES.find(p => p.id === 'classic')!;

export function getSelectedPersonalityId(): string {
  if (typeof window === 'undefined') return CLASSIC.id;
  return localStorage.getItem(CADDIE_PERSONALITY_KEY) || CLASSIC.id;
}

export function getSelectedPersonality(personas: CaddiePersonality[] = PERSONALITIES): CaddiePersonality {
  const id = getSelectedPersonalityId();
  return personas.find(p => p.id === id)
    || PERSONALITIES.find(p => p.id === id)
    || personas[0]
    || CLASSIC;
}

export function setSelectedPersonality(id: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CADDIE_PERSONALITY_KEY, id);
}

/**
 * Map an API persona response back into the local CaddiePersonality shape so
 * the picker UI can render any persona — built-in or user-authored — without
 * a separate code path.
 */
export function adaptApiPersona(api: {
  id: string;
  name: string;
  description: string;
  avatar: string;
  response_style?: string;
  traits?: string[];
}): CaddiePersonality {
  const seed = PERSONALITIES.find(p => p.id === api.id);
  return {
    id: api.id,
    name: api.name,
    description: api.description,
    avatar: api.avatar,
    responseStyle: (api.response_style as CaddiePersonality['responseStyle']) || seed?.responseStyle || 'conversational',
    traits: api.traits ?? seed?.traits ?? [],
    voiceStyle: seed?.voiceStyle ?? { pitch: 1.0, rate: 1.0 },
  };
}
