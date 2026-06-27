'use client';

import { Round, Player, PlayerGroup, calculateTotals } from '@/lib/types';
import { T } from '@/components/yardage/tokens';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import HoleScoreModal from './HoleScoreModal';
import { fetchAPI } from '@/lib/api';

// ---------------------------------------------------------------------------
// Inline SVG icons — yardage-book; no third-party icon library needed.
// ---------------------------------------------------------------------------
function MicIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
      <path d="M5 12a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="8.5" y1="22" x2="15.5" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function MicOffIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
      <path d="M5 12a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="8.5" y1="22" x2="15.5" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SpinnerIcon({ size = 24 }: { size?: number }) {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Group colors — yardage-book warm ink palette (no neon/saturated Tailwind classes).
// ---------------------------------------------------------------------------
interface GroupColor {
  bg: string;
  border: string;
  text: string;
  badge: string;
  row: string;
}

const GROUP_COLORS: GroupColor[] = [
  { bg: 'rgba(26,42,26,0.05)',  border: T.hairline,              text: T.ink,     badge: T.ink,     row: 'rgba(26,42,26,0.02)'  },
  { bg: 'rgba(58,74,138,0.07)', border: 'rgba(58,74,138,0.20)', text: T.accent,  badge: T.accent,  row: 'rgba(58,74,138,0.03)' },
  { bg: 'rgba(107,58,26,0.07)', border: 'rgba(107,58,26,0.20)', text: '#6b3a1a', badge: '#6b3a1a', row: 'rgba(107,58,26,0.03)' },
  { bg: 'rgba(106,42,42,0.07)', border: 'rgba(106,42,42,0.20)', text: '#6a2a2a', badge: '#6a2a2a', row: 'rgba(106,42,42,0.03)' },
  { bg: 'rgba(42,90,58,0.07)',  border: 'rgba(42,90,58,0.20)',  text: '#2a5a3a', badge: '#2a5a3a', row: 'rgba(42,90,58,0.03)'  },
  { bg: 'rgba(90,42,90,0.07)',  border: 'rgba(90,42,90,0.20)',  text: '#5a2a5a', badge: '#5a2a5a', row: 'rgba(90,42,90,0.03)'  },
];

interface GroupedPlayers {
  group: PlayerGroup | null;
  players: Player[];
  colorIndex: number;
}

// ---------------------------------------------------------------------------
// Yardage-book score colors (inline, not Tailwind dark-mode classes)
// ---------------------------------------------------------------------------
function scoreColor(score: number | null, par: number): string {
  if (score === null) return T.pencilSoft;
  const diff = score - par;
  if (diff <= -2) return T.eagle;
  if (diff === -1) return T.flag;
  if (diff === 0) return T.par;
  if (diff === 1) return T.bogey;
  if (diff === 2) return T.double;
  return T.pencilSoft; // triple+
}

// Parse a single score from a voice transcript (number or golf term). Pure — no component state.
function parseSimpleScore(text: string, par: number): number | null {
  const lower = text.toLowerCase().trim();

  // Direct numbers
  const numMatch = lower.match(/\b(\d+)\b/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    if (num >= 1 && num <= 15) return num;
  }

  // Word numbers
  const wordNumbers: Record<string, number> = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'won': 1, 'to': 2, 'too': 2, 'for': 4, 'fore': 4,
  };
  for (const [word, num] of Object.entries(wordNumbers)) {
    if (lower.includes(word)) return num;
  }

  // Golf terms
  if (lower.includes('ace') || lower.includes('hole in one')) return 1;
  if (lower.includes('albatross') || lower.includes('double eagle')) return par - 3;
  if (lower.includes('eagle')) return par - 2;
  if (lower.includes('birdie')) return par - 1;
  if (lower.includes('par')) return par;
  if (lower.includes('bogey') && lower.includes('double')) return par + 2;
  if (lower.includes('bogey') && lower.includes('triple')) return par + 3;
  if (lower.includes('bogey')) return par + 1;
  if (lower.includes('double')) return par + 2;
  if (lower.includes('triple')) return par + 3;

  return null;
}

interface ScoreGridProps {
  round: Round;
  onScoreChange: (playerId: string, holeNumber: number, strokes: number | null) => void;
  currentHole?: number;
  onHoleSelect?: (hole: number) => void;
}

export default function ScoreGrid({ round, onScoreChange, currentHole, onHoleSelect }: ScoreGridProps) {
  const [selectedCell, setSelectedCell] = useState<{ playerId: string; hole: number } | null>(null);
  const [holeModalHole, setHoleModalHole] = useState<number | null>(null);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const [pendingScores, setPendingScores] = useState<{ hole: number; scores: Record<string, number> } | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // Ref keeps the latest processVoiceScores without causing the recognition setup to re-run.
  const processVoiceScoresRef = useRef<(transcript: string) => Promise<void>>(async () => {});

  // Organize players by group
  const groupedPlayers = useMemo((): GroupedPlayers[] => {
    if (!round.groups || round.groups.length === 0) {
      // No groups defined - return all players in one "group"
      return [{ group: null, players: round.players, colorIndex: 0 }];
    }

    const result: GroupedPlayers[] = [];
    const assignedPlayerIds = new Set<string>();

    // Sort groups by tee time
    const sortedGroups = [...round.groups].sort((a, b) => {
      if (!a.teeTime && !b.teeTime) return 0;
      if (!a.teeTime) return 1;
      if (!b.teeTime) return -1;
      return a.teeTime.localeCompare(b.teeTime);
    });

    sortedGroups.forEach((group, index) => {
      const groupPlayers = round.players.filter(p =>
        group.playerIds.includes(p.id) || p.groupId === group.id
      );
      groupPlayers.forEach(p => assignedPlayerIds.add(p.id));
      result.push({
        group,
        players: groupPlayers,
        colorIndex: index % GROUP_COLORS.length,
      });
    });

    // Add any unassigned players
    const unassignedPlayers = round.players.filter(p => !assignedPlayerIds.has(p.id));
    if (unassignedPlayers.length > 0) {
      result.push({
        group: null,
        players: unassignedPlayers,
        colorIndex: result.length % GROUP_COLORS.length,
      });
    }

    return result;
  }, [round.groups, round.players]);

  // Initialize voice recognition — runs once; processVoiceScores is accessed via ref
  // to avoid a stale closure without needing to re-create the recognition on each render.
  useEffect(() => {
    type SpeechRecognitionCtor = new () => SpeechRecognition;
    const w = window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
    const SpeechRecognitionAPI = w.SpeechRecognition ?? w.webkitSpeechRecognition;

    if (SpeechRecognitionAPI) {
      const recognition = new SpeechRecognitionAPI();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const transcript = Array.from(event.results)
          .map((result: SpeechRecognitionResult) => result[0].transcript)
          .join("");
        setVoiceTranscript(transcript);

        if (event.results[0].isFinal) {
          void processVoiceScoresRef.current(transcript);
        }
      };

      recognition.onend = () => {
        setIsVoiceActive(false);
        setVoiceTranscript("");
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.log('Speech recognition error:', event.error);
        setIsVoiceActive(false);
        setVoiceTranscript("");
      };

      recognitionRef.current = recognition;
    }

    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  // submitScore must be declared before processVoiceScores (react-hooks/immutability).
  const submitScore = useCallback(
    (strokes: number | null) => {
      if (!selectedCell) return;

      const { playerId, hole } = selectedCell;
      onScoreChange(playerId, hole, strokes);

      const currentPlayerIndex = round.players.findIndex((p) => p.id === playerId);

      if (currentPlayerIndex < round.players.length - 1) {
        const nextPlayer = round.players[currentPlayerIndex + 1];
        setSelectedCell({ playerId: nextPlayer.id, hole });
      } else if (hole < 18) {
        const nextHole = hole + 1;
        setSelectedCell({ playerId: round.players[0].id, hole: nextHole });
        onHoleSelect?.(nextHole);
      } else {
        setSelectedCell(null);
      }
    },
    [selectedCell, round.players, onScoreChange, onHoleSelect]
  );

  // parseVoiceLocally must be declared before processVoiceScores (react-hooks/immutability).
  const parseVoiceLocally = (text: string, defaultHole: number) => {
    const result: { hole: number; scores: Record<string, number> } = {
      hole: defaultHole,
      scores: {},
    };
    const lower = text.toLowerCase();
    const par = round.holes[defaultHole - 1]?.par || 4;

    // Check for hole number
    const holeMatch = text.match(/hole\s+(\d+)/i);
    if (holeMatch) {
      result.hole = parseInt(holeMatch[1], 10);
    }

    const textToScore = (t: string): number => {
      const l = t.toLowerCase();
      if (l === "par") return par;
      if (l === "birdie") return par - 1;
      if (l === "eagle") return par - 2;
      if (l === "bogey") return par + 1;
      if (l === "double") return par + 2;
      const num = parseInt(t, 10);
      return isNaN(num) ? par : num;
    };

    // "everyone par" pattern
    if (lower.includes("everyone par") || lower.includes("all par")) {
      round.players.forEach((p) => {
        result.scores[p.name] = par;
      });
      // Check for exceptions
      const exceptPattern = /except\s+(\w+)\s+(?:got\s+)?(?:a\s+)?(\d+|par|birdie|bogey|double|eagle)/gi;
      for (const match of text.matchAll(exceptPattern)) {
        const name = match[1];
        const player = round.players.find((p) =>
          p.name.toLowerCase().includes(name.toLowerCase())
        );
        if (player) {
          result.scores[player.name] = textToScore(match[2]);
        }
      }
      return result;
    }

    // Word to number mapping
    const wordToNum: Record<string, number> = {
      'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
      'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
      'won': 1, 'to': 2, 'too': 2, 'for': 4, 'fore': 4,
    };

    // Individual scores - try full name and first name
    for (const player of round.players) {
      const fullName = player.name;
      const firstName = fullName.split(' ')[0].toLowerCase();

      const lowerText = text.toLowerCase();

      // Check if player's first name appears
      const nameIndex = lowerText.indexOf(firstName);
      if (nameIndex === -1) continue;

      // Look for a number/word after the name
      const afterName = lowerText.substring(nameIndex + firstName.length);

      // Try digit first
      const numberMatch = afterName.match(/(\d+)/);
      if (numberMatch) {
        const score = parseInt(numberMatch[1], 10);
        if (score >= 1 && score <= 15) {
          result.scores[player.name] = score;
          console.log(`Matched ${player.name} -> ${score} (digit)`);
          continue;
        }
      }

      // Try word numbers (four, five, six, etc.)
      for (const [word, num] of Object.entries(wordToNum)) {
        const wordMatch = afterName.match(new RegExp(`\\b${word}\\b`));
        if (wordMatch) {
          result.scores[player.name] = num;
          console.log(`Matched ${player.name} -> ${num} (word: ${word})`);
          break;
        }
      }
      if (result.scores[player.name]) continue;

      // Also check for words like par, birdie, bogey
      const scoreWords = ['par', 'birdie', 'eagle', 'bogey', 'double'];
      for (const word of scoreWords) {
        if (afterName.toLowerCase().includes(word)) {
          result.scores[player.name] = textToScore(word);
          console.log(`Matched ${player.name} (via "${firstName}") -> ${word} = ${textToScore(word)}`);
          break;
        }
      }
    }

    console.log('Final local parse result:', result);
    return result;
  };

  // parseSimpleScore is a module-level pure function (declared above the component).
  const processVoiceScores = async (transcript: string) => {
    console.log('Processing voice transcript:', transcript);
    setIsProcessingVoice(true);
    const targetHole = currentHole || 1;
    const par = round.holes[targetHole - 1]?.par || 4;
    const playerNames = round.players.map(p => p.name);

    // SIMPLE MODE: If a cell is selected, just parse a single score
    if (selectedCell) {
      const score = parseSimpleScore(transcript, par);
      console.log('Simple score parse:', transcript, '->', score);
      if (score !== null) {
        submitScore(score);
      }
      setIsProcessingVoice(false);
      setVoiceTranscript("");
      return;
    }

    // MULTI-PLAYER MODE: Use Claude to parse via the backend
    try {
      const result = await fetchAPI<{ hole?: number; scores?: Record<string, number> }>(
        "/api/voice/parse-scores",
        {
          method: "POST",
          body: JSON.stringify({
            transcript,
            playerNames,
            hole: targetHole,
            par,
          }),
        }
      );
      console.log('Claude parse result:', result);

      if (result.scores && Object.keys(result.scores).length > 0) {
        setPendingScores({ hole: result.hole || targetHole, scores: result.scores });
      } else {
        alert(`Couldn't parse scores from: "${transcript}"\n\nTry: "Justin 4 Mike 5" or "everyone par"`);
      }
    } catch (err) {
      console.error('Voice parse error:', err);
      // Fallback to local parsing
      const localResult = parseVoiceLocally(transcript, targetHole);
      if (Object.keys(localResult.scores).length > 0) {
        setPendingScores(localResult);
      } else {
        alert(`Couldn't parse scores from: "${transcript}"`);
      }
    }

    setIsProcessingVoice(false);
    setVoiceTranscript("");
  };

  // Keep the ref current so the recognition handler always calls the latest version.
  useEffect(() => {
    processVoiceScoresRef.current = processVoiceScores;
  });

  const confirmPendingScores = () => {
    if (!pendingScores) return;

    console.log('Confirming scores:', pendingScores);
    for (const [playerName, score] of Object.entries(pendingScores.scores)) {
      const player = round.players.find(p => p.name === playerName);
      if (player) {
        onScoreChange(player.id, pendingScores.hole, score);
      }
    }
    onHoleSelect?.(pendingScores.hole);
    setPendingScores(null);
  };

  const cancelPendingScores = () => {
    setPendingScores(null);
  };

  const toggleVoice = () => {
    if (isVoiceActive) {
      // Force stop recognition
      try {
        recognitionRef.current?.stop();
        recognitionRef.current?.abort?.();
      } catch {
        // Ignore errors on stop
      }
      setIsVoiceActive(false);
      setVoiceTranscript("");
    } else {
      setVoiceTranscript("");
      try {
        recognitionRef.current?.start();
        setIsVoiceActive(true);
      } catch {
        // Recognition might already be running or unavailable
        setIsVoiceActive(false);
      }
    }
  };

  const getScore = (playerId: string, holeNumber: number): number | null => {
    const score = round.scores.find((s) => s.playerId === playerId && s.holeNumber === holeNumber);
    return score?.strokes ?? null;
  };

  const handleCellClick = (playerId: string, hole: number) => {
    setSelectedCell({ playerId, hole });
    onHoleSelect?.(hole);
  };

  const handleHoleClick = (holeNumber: number) => {
    setHoleModalHole(holeNumber);
    onHoleSelect?.(holeNumber);
  };

  const handleNumberPadClick = (num: number) => submitScore(num);
  const handleClearScore = () => submitScore(null);

  const holeHeaderCell = (holeNumber: number) => {
    const isCurrent = currentHole === holeNumber;
    return (
      <button
        key={holeNumber}
        type="button"
        onClick={() => handleHoleClick(holeNumber)}
        className="min-w-[40px] w-full px-2 py-2 text-center text-xs font-medium transition-colors"
        style={{
          color: isCurrent ? T.accent : T.pencil,
          background: isCurrent ? `rgba(58,74,138,0.08)` : 'transparent',
          fontFamily: T.mono,
          letterSpacing: '0.05em',
        }}
      >
        {holeNumber}
      </button>
    );
  };

  const renderNine = (start: number, end: number, label: string) => {
    const holes = round.holes.slice(start - 1, end);
    const totalPar = holes.reduce((sum, h) => sum + h.par, 0);

    return (
      <div className="card p-3 sm:p-4 mb-4 overflow-hidden">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-baseline gap-2">
            <h3
              className="text-sm font-semibold tracking-tight"
              style={{ fontFamily: T.serif, fontStyle: 'italic', color: T.ink }}
            >
              {label}
            </h3>
            <span
              className="text-xs"
              style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.08em', color: T.pencilSoft }}
            >
              Par {totalPar}
            </span>
          </div>
          <span
            className="text-xs"
            style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '0.06em', color: T.pencilSoft }}
          >
            Tap hole # for all players
          </span>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            {/* Header row */}
            <div
              className="grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch rounded-xl overflow-hidden"
              style={{ border: `1px solid ${T.hairline}`, background: T.paperDeep }}
            >
              <div
                className="px-3 py-2 text-xs font-medium"
                style={{ fontFamily: T.mono, letterSpacing: '0.06em', color: T.pencil }}
              >
                {label}
              </div>
              {holes.map((h) => holeHeaderCell(h.number))}
              <div
                className="px-2 py-2 text-center text-xs font-semibold"
                style={{ fontFamily: T.mono, letterSpacing: '0.06em', color: T.ink }}
              >
                TOT
              </div>
            </div>

            {/* Par row */}
            <div
              className="grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch"
              style={{ borderLeft: `1px solid ${T.hairlineSoft}`, borderRight: `1px solid ${T.hairlineSoft}`, borderBottom: `1px solid ${T.hairlineSoft}`, background: T.paper }}
            >
              <div
                className="px-3 py-2 text-xs"
                style={{ fontFamily: T.mono, letterSpacing: '0.06em', color: T.pencilSoft }}
              >
                Par
              </div>
              {holes.map((h) => (
                <div
                  key={h.number}
                  className="px-2 py-2 text-center text-xs"
                  style={{ color: T.pencil, fontFamily: T.mono }}
                >
                  {h.par}
                </div>
              ))}
              <div
                className="px-2 py-2 text-center text-xs font-semibold"
                style={{ fontFamily: T.mono, color: T.ink }}
              >
                {totalPar}
              </div>
            </div>

            {/* Players - grouped by tee time */}
            <div
              className="rounded-b-xl overflow-hidden"
              style={{ borderLeft: `1px solid ${T.hairlineSoft}`, borderRight: `1px solid ${T.hairlineSoft}`, borderBottom: `1px solid ${T.hairlineSoft}` }}
            >
              {groupedPlayers.map(({ group, players, colorIndex }) => {
                const colors = GROUP_COLORS[colorIndex];
                const hasGroups = round.groups && round.groups.length > 0;

                return (
                  <div key={group?.id || 'ungrouped'}>
                    {/* Group header - only show if groups are defined */}
                    {hasGroups && (
                      <div
                        className="grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch"
                        style={{ background: colors.bg, borderTop: `1px solid ${colors.border}` }}
                      >
                        <div className="col-span-11 px-3 py-1.5 flex items-center gap-2">
                          {/* Group dot indicator */}
                          <span
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ background: colors.badge }}
                          />
                          <span
                            className="text-xs font-medium"
                            style={{ color: colors.text, fontFamily: T.sans }}
                          >
                            {group?.name || 'Unassigned'}
                          </span>
                          {group?.teeTime && (
                            <span
                              className="text-xs px-1.5 py-0.5 rounded"
                              style={{
                                background: colors.badge,
                                color: T.paper,
                                fontFamily: T.mono,
                                fontSize: 9,
                                letterSpacing: '0.06em',
                              }}
                            >
                              {group.teeTime}
                            </span>
                          )}
                          {group?.startingHole && (
                            <span
                              className="text-xs px-1.5 py-0.5 rounded"
                              style={{
                                background: colors.badge,
                                color: T.paper,
                                fontFamily: T.mono,
                                fontSize: 9,
                                letterSpacing: '0.06em',
                              }}
                            >
                              Hole {group.startingHole}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Players in this group */}
                    <div>
                      {players.map((player, pIdx) => {
                        const totals = calculateTotals(round.scores, round.holes, player.id);
                        const nineTotal = start === 1 ? totals.front9 : totals.back9;

                        return (
                          <div
                            key={`${player.id}-${start}`}
                            className="grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch"
                            style={{
                              background: hasGroups ? colors.row : 'transparent',
                              borderTop: pIdx > 0 ? `1px solid ${T.hairlineSoft}` : undefined,
                            }}
                          >
                            <div
                              className="px-3 py-2 text-sm font-medium truncate flex items-center gap-2"
                              style={{ color: T.ink, fontFamily: T.sans }}
                            >
                              {hasGroups && (
                                <span
                                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                  style={{ background: colors.badge }}
                                />
                              )}
                              {player.name}
                            </div>

                            {holes.map((hole) => {
                              const score = getScore(player.id, hole.number);
                              const isSelected = selectedCell?.playerId === player.id && selectedCell?.hole === hole.number;

                              const textColor = scoreColor(score, hole.par);

                              // Golf score indicator: circle for birdie, square for bogey, etc.
                              const diff = score !== null ? score - hole.par : 0;
                              const getScoreIndicator = () => {
                                if (score === null) return null;
                                if (diff <= -2) {
                                  // Eagle or better: double circle
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span className="w-7 h-7 rounded-full border-2" style={{ borderColor: T.eagle }} />
                                      <span className="absolute w-5 h-5 rounded-full border-2" style={{ borderColor: T.eagle }} />
                                    </span>
                                  );
                                }
                                if (diff === -1) {
                                  // Birdie: single circle — flag/terracotta
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span className="w-7 h-7 rounded-full border-2" style={{ borderColor: T.flag }} />
                                    </span>
                                  );
                                }
                                if (diff === 1) {
                                  // Bogey: single square
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span className="w-6 h-6 rounded-sm border-2" style={{ borderColor: T.bogey }} />
                                    </span>
                                  );
                                }
                                if (diff === 2) {
                                  // Double bogey: double square
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span className="w-7 h-7 rounded-sm border-2" style={{ borderColor: T.double }} />
                                      <span className="absolute w-5 h-5 rounded-sm border-2" style={{ borderColor: T.double }} />
                                    </span>
                                  );
                                }
                                if (diff >= 3) {
                                  // Triple+ bogey: filled square
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span
                                        className="w-7 h-7 rounded-sm border-2"
                                        style={{ borderColor: T.pencilSoft, background: `${T.pencilSoft}30` }}
                                      />
                                    </span>
                                  );
                                }
                                return null; // Par: no indicator
                              };

                              return (
                                <button
                                  key={`${player.id}-${hole.number}`}
                                  type="button"
                                  onClick={() => handleCellClick(player.id, hole.number)}
                                  className="relative px-2 py-2 text-center transition-all duration-150 active:scale-[0.99]"
                                  style={{
                                    background: isSelected
                                      ? 'rgba(58,74,138,0.08)'
                                      : 'transparent',
                                    boxShadow: isSelected
                                      ? `0 0 0 1px rgba(58,74,138,0.25), 0 0 18px rgba(58,74,138,0.12)`
                                      : undefined,
                                    minHeight: 44,
                                  }}
                                >
                                  {getScoreIndicator()}
                                  <span
                                    className="relative z-10 text-[15px] font-semibold"
                                    style={{
                                      color: textColor,
                                      fontFamily: T.serif,
                                      fontVariantNumeric: 'tabular-nums',
                                    }}
                                  >
                                    {score ?? '–'}
                                  </span>
                                  {isSelected && (
                                    <span
                                      className="absolute inset-x-2 bottom-1 h-[2px] rounded-full"
                                      style={{ background: `${T.accent}B0` }}
                                    />
                                  )}
                                </button>
                              );
                            })}

                            <div
                              className="px-2 py-2 text-center text-sm font-semibold"
                              style={{ color: T.ink, background: T.paperDeep, fontFamily: T.serif, fontVariantNumeric: 'tabular-nums' }}
                            >
                              {nineTotal || '–'}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Voice input bar */}
      <div
        className="mb-4 p-3 rounded-2xl"
        style={{ background: T.paperDeep, border: `1px solid ${T.hairline}` }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={toggleVoice}
            disabled={isProcessingVoice}
            className="w-12 h-12 rounded-full flex items-center justify-center transition-all flex-shrink-0 disabled:opacity-50"
            style={{
              background: isVoiceActive ? T.errorInk : T.accent,
              color: T.paper,
              minWidth: 48,
              minHeight: 48,
            }}
          >
            {isProcessingVoice ? (
              <SpinnerIcon size={24} />
            ) : isVoiceActive ? (
              <MicOffIcon size={24} />
            ) : (
              <MicIcon size={24} />
            )}
          </button>
          <div className="flex-1 min-w-0">
            {isVoiceActive && !voiceTranscript && (
              <p
                className="text-sm font-medium"
                style={{ color: T.accent, fontFamily: T.sans }}
              >
                Listening…
              </p>
            )}
            {voiceTranscript && (
              <p
                className="text-sm truncate"
                style={{ color: T.ink, fontFamily: T.serif, fontStyle: 'italic' }}
              >
                &ldquo;{voiceTranscript}&rdquo;
              </p>
            )}
            {!isVoiceActive && !voiceTranscript && !isProcessingVoice && (
              <div>
                <p
                  className="text-sm font-medium"
                  style={{ color: T.ink, fontFamily: T.sans }}
                >
                  Voice Score Entry
                </p>
                <p
                  className="text-xs"
                  style={{ color: T.pencilSoft, fontFamily: T.mono }}
                >
                  {selectedCell
                    ? `${round.players.find(p => p.id === selectedCell.playerId)?.name} · Hole ${selectedCell.hole}`
                    : `Hole ${currentHole || 1}`
                  }
                </p>
              </div>
            )}
            {isProcessingVoice && (
              <p
                className="text-sm"
                style={{ color: T.pencil, fontFamily: T.sans }}
              >
                Updating scores…
              </p>
            )}
          </div>
        </div>
        {!isVoiceActive && !isProcessingVoice && !pendingScores && (
          <div
            className="mt-2 pt-2"
            style={{ borderTop: `1px solid ${T.hairlineSoft}` }}
          >
            <p
              className="text-xs"
              style={{ color: T.pencilSoft, fontFamily: T.mono, fontSize: 10, letterSpacing: '0.04em' }}
            >
              Say: &ldquo;Justin 4 Mike 5&rdquo; or &ldquo;everyone par&rdquo; or &ldquo;par except Mike bogey&rdquo;
            </p>
          </div>
        )}
      </div>

      {/* Pending scores confirmation */}
      {pendingScores && (
        <div
          className="mb-4 p-4 rounded-2xl"
          style={{ background: 'rgba(58,74,138,0.07)', border: `1px solid rgba(58,74,138,0.20)` }}
        >
          <p
            className="text-sm font-medium mb-3"
            style={{ color: T.accent, fontFamily: T.mono, letterSpacing: '0.04em' }}
          >
            Hole {pendingScores.hole} — Confirm scores:
          </p>
          <div className="space-y-2 mb-4">
            {Object.entries(pendingScores.scores).map(([name, score]) => (
              <div
                key={name}
                className="flex justify-between items-center px-3 py-2 rounded-xl"
                style={{ background: T.paper, border: `1px solid ${T.hairlineSoft}` }}
              >
                <span
                  className="font-medium"
                  style={{ color: T.ink, fontFamily: T.sans }}
                >
                  {name}
                </span>
                <span
                  className="font-bold text-lg"
                  style={{ color: T.accent, fontFamily: T.serif, fontVariantNumeric: 'tabular-nums' }}
                >
                  {score}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={cancelPendingScores}
              className="flex-1 px-4 py-3 rounded-xl"
              style={{
                background: T.paper,
                border: `1px solid ${T.hairline}`,
                color: T.pencil,
                fontFamily: T.sans,
                minHeight: 44,
              }}
            >
              Cancel
            </button>
            <button
              onClick={confirmPendingScores}
              className="flex-1 px-4 py-3 rounded-xl font-medium"
              style={{
                background: T.accent,
                color: T.paper,
                fontFamily: T.sans,
                minHeight: 44,
                border: 'none',
              }}
            >
              Apply Scores
            </button>
          </div>
        </div>
      )}

      {renderNine(1, 9, 'Front 9')}
      {renderNine(10, 18, 'Back 9')}

      <div className="card p-4">
        <h3
          className="text-sm font-semibold tracking-tight mb-3"
          style={{ fontFamily: T.serif, fontStyle: 'italic', color: T.ink }}
        >
          Totals
        </h3>
        <div className="grid gap-2">
          {round.players.map((player) => {
            const totals = calculateTotals(round.scores, round.holes, player.id);
            const toParColor =
              totals.toPar < 0 ? T.flag : totals.toPar > 0 ? T.bogey : T.par;
            return (
              <div
                key={player.id}
                className="flex justify-between items-center rounded-2xl px-4 py-3"
                style={{ background: T.paperDeep, border: `1px solid ${T.hairlineSoft}` }}
              >
                <span
                  className="font-medium"
                  style={{ color: T.ink, fontFamily: T.sans }}
                >
                  {player.name}
                </span>
                <div className="flex items-center gap-4 text-sm">
                  <span
                    style={{ color: T.pencil, fontFamily: T.mono, fontSize: 11, letterSpacing: '0.04em' }}
                  >
                    F9: {totals.front9 || '–'}
                  </span>
                  <span
                    style={{ color: T.pencil, fontFamily: T.mono, fontSize: 11, letterSpacing: '0.04em' }}
                  >
                    B9: {totals.back9 || '–'}
                  </span>
                  <span
                    className="font-semibold text-base"
                    style={{ color: toParColor, fontFamily: T.serif, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {totals.playedHoles > 0 ? totals.total : '–'} (
                    {totals.playedHoles === 0 ? '–' : totals.toPar === 0 ? 'E' : `${totals.toPar > 0 ? '+' : ''}${totals.toPar}`})
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Number pad for individual cell */}
      <AnimatePresence>
        {selectedCell && (
          <motion.div
            key="numpad"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 18 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed bottom-0 left-0 right-0 z-50"
          >
            <div
              style={{
                background: T.paper,
                borderTop: `1px solid ${T.hairline}`,
                boxShadow: '0 -8px 32px rgba(26,42,26,0.12)',
              }}
            >
              <div className="max-w-md mx-auto px-4 py-4" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
                <p
                  className="text-center text-sm mb-3"
                  style={{ color: T.pencil, fontFamily: T.mono, letterSpacing: '0.04em' }}
                >
                  <span
                    className="font-semibold"
                    style={{ color: T.ink, fontFamily: T.sans }}
                  >
                    {round.players.find((p) => p.id === selectedCell.playerId)?.name}
                  </span>
                  {' · '}Hole {selectedCell.hole}
                  {' · '}Par {round.holes[selectedCell.hole - 1]?.par}
                </p>

                <div className="grid grid-cols-4 gap-2">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((num) => (
                    <button
                      key={num}
                      onClick={() => handleNumberPadClick(num)}
                      className="btn rounded-2xl active:scale-[0.97] transition-transform"
                      style={{
                        padding: '12px 8px',
                        background: T.paperDeep,
                        border: `1px solid ${T.hairline}`,
                        color: T.ink,
                        fontSize: 18,
                        fontFamily: T.serif,
                        fontWeight: 600,
                        minHeight: 44,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {num}
                    </button>
                  ))}
                </div>

                <div className="flex gap-2 mt-3">
                  <button
                    onClick={handleClearScore}
                    className="btn flex-1 rounded-full"
                    style={{
                      padding: '12px 16px',
                      background: T.errorWash,
                      border: `1px solid rgba(184,74,58,0.2)`,
                      color: T.errorInk,
                      fontFamily: T.sans,
                      minHeight: 44,
                    }}
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setSelectedCell(null)}
                    className="btn flex-1 rounded-full"
                    style={{
                      padding: '12px 16px',
                      background: T.paperDeep,
                      border: `1px solid ${T.hairline}`,
                      color: T.ink,
                      fontFamily: T.sans,
                      minHeight: 44,
                    }}
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hole score modal */}
      <AnimatePresence>
        {holeModalHole !== null && (
          <HoleScoreModal
            hole={round.holes[holeModalHole - 1]}
            players={round.players}
            scores={Object.fromEntries(
              round.players.map((p) => [p.id, getScore(p.id, holeModalHole)])
            )}
            onScoreChange={(playerId, score) => {
              onScoreChange(playerId, holeModalHole, score);
            }}
            onClose={() => setHoleModalHole(null)}
            onPrevHole={() => {
              if (holeModalHole > 1) {
                setHoleModalHole(holeModalHole - 1);
                onHoleSelect?.(holeModalHole - 1);
              }
            }}
            onNextHole={() => {
              if (holeModalHole < 18) {
                setHoleModalHole(holeModalHole + 1);
                onHoleSelect?.(holeModalHole + 1);
              }
            }}
            totalHoles={18}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
