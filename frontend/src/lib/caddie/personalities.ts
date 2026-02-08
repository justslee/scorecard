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
];

const CADDIE_PERSONALITY_KEY = 'scorecard_caddie_personality';

export function getSelectedPersonality(): CaddiePersonality {
  if (typeof window === 'undefined') return PERSONALITIES[1]; // classic
  const id = localStorage.getItem(CADDIE_PERSONALITY_KEY);
  return PERSONALITIES.find(p => p.id === id) || PERSONALITIES[1];
}

export function setSelectedPersonality(id: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CADDIE_PERSONALITY_KEY, id);
}
