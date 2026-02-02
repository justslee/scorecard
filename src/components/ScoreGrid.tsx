'use client';

import { Round, Player, PlayerGroup, calculateTotals, getScoreClass } from '@/lib/types';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Mic, MicOff, Loader2, Users } from 'lucide-react';
import HoleScoreModal from './HoleScoreModal';

interface ScoreGridProps {
  round: Round;
  onScoreChange: (playerId: string, holeNumber: number, strokes: number | null) => void;
  currentHole?: number;
  onHoleSelect?: (hole: number) => void;
}

// Group colors for visual distinction - more prominent colors
const GROUP_COLORS = [
  { bg: 'bg-emerald-500/20', border: 'border-emerald-500/40', text: 'text-emerald-300', badge: 'bg-emerald-500', row: 'bg-emerald-500/10' },
  { bg: 'bg-blue-500/20', border: 'border-blue-500/40', text: 'text-blue-300', badge: 'bg-blue-500', row: 'bg-blue-500/10' },
  { bg: 'bg-purple-500/20', border: 'border-purple-500/40', text: 'text-purple-300', badge: 'bg-purple-500', row: 'bg-purple-500/10' },
  { bg: 'bg-amber-500/20', border: 'border-amber-500/40', text: 'text-amber-300', badge: 'bg-amber-500', row: 'bg-amber-500/10' },
  { bg: 'bg-rose-500/20', border: 'border-rose-500/40', text: 'text-rose-300', badge: 'bg-rose-500', row: 'bg-rose-500/10' },
  { bg: 'bg-cyan-500/20', border: 'border-cyan-500/40', text: 'text-cyan-300', badge: 'bg-cyan-500', row: 'bg-cyan-500/10' },
];

interface GroupedPlayers {
  group: PlayerGroup | null;
  players: Player[];
  colorIndex: number;
}

export default function ScoreGrid({ round, onScoreChange, currentHole, onHoleSelect }: ScoreGridProps) {
  const [selectedCell, setSelectedCell] = useState<{ playerId: string; hole: number } | null>(null);
  const [holeModalHole, setHoleModalHole] = useState<number | null>(null);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [isProcessingVoice, setIsProcessingVoice] = useState(false);
  const recognitionRef = useRef<any>(null);

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

  // Initialize voice recognition
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0].transcript)
          .join("");
        setVoiceTranscript(transcript);

        if (event.results[0].isFinal) {
          processVoiceScores(transcript);
        }
      };

      recognition.onend = () => {
        setIsVoiceActive(false);
      };

      recognition.onerror = () => {
        setIsVoiceActive(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const processVoiceScores = async (transcript: string) => {
    setIsProcessingVoice(true);
    const targetHole = currentHole || 1;

    try {
      const response = await fetch("/api/parse-voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          systemPrompt: `Parse golf scores from voice. Players: ${round.players.map(p => p.name).join(", ")}. Current hole: ${targetHole}. Hole par: ${round.holes[targetHole - 1]?.par}.

Common patterns:
- "[Name] got a [number]" or "[Name] [number]"
- "par for [Name]" means par score
- "birdie for [Name]" means par - 1
- "bogey for [Name]" means par + 1
- "double for [Name]" or "double bogey" means par + 2
- "eagle for [Name]" means par - 2
- "everyone par" or "all par" means everyone gets par
- "everyone par except [Name] [score]"
- Can also specify hole: "hole 5 Justin 4 Dan 5"

Return JSON: {"hole": number (use ${targetHole} if not specified), "scores": {"PlayerName": number}}

Parse: "${transcript}"`,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        applyVoiceScores(result);
      } else {
        applyVoiceScores(parseVoiceLocally(transcript, targetHole));
      }
    } catch {
      applyVoiceScores(parseVoiceLocally(transcript, targetHole));
    } finally {
      setIsProcessingVoice(false);
      setVoiceTranscript("");
    }
  };

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

    // Individual scores
    for (const player of round.players) {
      // Pattern 1: "[score] for [Name]" - check this first (more specific)
      const pattern1 = new RegExp(`(\\d+|par|birdie|bogey|double|eagle)\\s+for\\s+${player.name}(?:\\s|$|,)`, "i");
      const match1 = text.match(pattern1);
      if (match1 && match1[1]) {
        result.scores[player.name] = textToScore(match1[1]);
        continue;
      }

      // Pattern 2: "[Name] got a [X]" or "[Name] [X]" 
      const pattern2 = new RegExp(`${player.name}\\s+(?:got\\s+)?(?:a\\s+)?(\\d+|par|birdie|bogey|double|eagle)(?:\\s|$|,)`, "i");
      const match2 = text.match(pattern2);
      if (match2 && match2[1]) {
        result.scores[player.name] = textToScore(match2[1]);
        continue;
      }
    }

    return result;
  };

  const applyVoiceScores = (parsed: { hole: number; scores: Record<string, number> }) => {
    for (const [name, score] of Object.entries(parsed.scores)) {
      const player = round.players.find(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (player) {
        onScoreChange(player.id, parsed.hole, score);
      }
    }
    onHoleSelect?.(parsed.hole);
  };

  const toggleVoice = () => {
    if (isVoiceActive) {
      recognitionRef.current?.stop();
      setIsVoiceActive(false);
    } else {
      setVoiceTranscript("");
      recognitionRef.current?.start();
      setIsVoiceActive(true);
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

  const handleNumberPadClick = (num: number) => submitScore(num);
  const handleClearScore = () => submitScore(null);

  const holeHeaderCell = (holeNumber: number) => {
    const isCurrent = currentHole === holeNumber;
    return (
      <button
        key={holeNumber}
        type="button"
        onClick={() => handleHoleClick(holeNumber)}
        className={
          `min-w-[40px] w-full px-2 py-2 text-center text-xs font-medium transition-colors ` +
          (isCurrent
            ? 'text-emerald-200 bg-emerald-500/10'
            : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5')
        }
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
            <h3 className="text-sm font-semibold tracking-tight">{label}</h3>
            <span className="text-xs text-zinc-500">Par {totalPar}</span>
          </div>
          <span className="text-xs text-zinc-500">Tap hole # for all players</span>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            {/* Header row */}
            <div className="grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch rounded-xl overflow-hidden border border-white/10 bg-white/3">
              <div className="px-3 py-2 text-xs font-medium text-zinc-400">{label}</div>
              {holes.map((h) => holeHeaderCell(h.number))}
              <div className="px-2 py-2 text-center text-xs font-semibold text-zinc-300">TOT</div>
            </div>

            {/* Par row */}
            <div className="grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch border-x border-b border-white/10 bg-white/2">
              <div className="px-3 py-2 text-xs text-zinc-500">Par</div>
              {holes.map((h) => (
                <div key={h.number} className="px-2 py-2 text-center text-xs text-zinc-400">
                  {h.par}
                </div>
              ))}
              <div className="px-2 py-2 text-center text-xs font-semibold text-zinc-300">{totalPar}</div>
            </div>

            {/* Players - grouped by tee time */}
            <div className="border-x border-b border-white/10 rounded-b-xl overflow-hidden">
              {groupedPlayers.map(({ group, players, colorIndex }) => {
                const colors = GROUP_COLORS[colorIndex];
                const hasGroups = round.groups && round.groups.length > 0;
                
                return (
                  <div key={group?.id || 'ungrouped'}>
                    {/* Group header - only show if groups are defined */}
                    {hasGroups && (
                      <div className={`grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch ${colors.bg} border-t ${colors.border}`}>
                        <div className="col-span-11 px-3 py-1.5 flex items-center gap-2">
                          <Users className={`w-3.5 h-3.5 ${colors.text}`} />
                          <span className={`text-xs font-medium ${colors.text}`}>
                            {group?.name || 'Unassigned'}
                          </span>
                          {group?.teeTime && (
                            <span className={`text-xs px-1.5 py-0.5 rounded ${colors.badge} ${colors.text}`}>
                              {group.teeTime}
                            </span>
                          )}
                          {group?.startingHole && (
                            <span className={`text-xs px-1.5 py-0.5 rounded ${colors.badge} ${colors.text}`}>
                              Hole {group.startingHole}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    
                    {/* Players in this group */}
                    <div className="divide-y divide-white/6">
                      {players.map((player) => {
                        const totals = calculateTotals(round.scores, round.holes, player.id);
                        const nineTotal = start === 1 ? totals.front9 : totals.back9;

                        return (
                          <div
                            key={`${player.id}-${start}`}
                            className={`grid grid-cols-[120px_repeat(9,1fr)_70px] items-stretch ${hasGroups ? colors.row : 'bg-white/0'}`}
                          >
                            <div className="px-3 py-2 text-sm font-medium text-zinc-200 truncate flex items-center gap-2">
                              {hasGroups && (
                                <span className={`w-2.5 h-2.5 rounded-full ${colors.badge}`} />
                              )}
                              {player.name}
                            </div>

                            {holes.map((hole) => {
                              const score = getScore(player.id, hole.number);
                              const isSelected = selectedCell?.playerId === player.id && selectedCell?.hole === hole.number;

                              const scoreStateClass =
                                score !== null
                                  ? getScoreClass(score, hole.par)
                                  : 'text-zinc-300';
                              
                              // Golf score indicator: circle for birdie, square for bogey, etc.
                              const diff = score !== null ? score - hole.par : 0;
                              const getScoreIndicator = () => {
                                if (score === null) return null;
                                if (diff <= -2) {
                                  // Eagle or better: double circle
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span className="w-7 h-7 rounded-full border-2 border-yellow-400" />
                                      <span className="absolute w-5 h-5 rounded-full border-2 border-yellow-400" />
                                    </span>
                                  );
                                }
                                if (diff === -1) {
                                  // Birdie: circle
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span className="w-7 h-7 rounded-full border-2 border-red-400" />
                                    </span>
                                  );
                                }
                                if (diff === 1) {
                                  // Bogey: square
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span className="w-6 h-6 rounded-sm border-2 border-sky-400" />
                                    </span>
                                  );
                                }
                                if (diff === 2) {
                                  // Double bogey: double square
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span className="w-7 h-7 rounded-sm border-2 border-blue-400" />
                                      <span className="absolute w-5 h-5 rounded-sm border-2 border-blue-400" />
                                    </span>
                                  );
                                }
                                if (diff >= 3) {
                                  // Triple+ bogey: filled square
                                  return (
                                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                      <span className="w-7 h-7 rounded-sm border-2 border-indigo-400 bg-indigo-400/20" />
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
                                  className={
                                    `relative px-2 py-2 text-center transition-all duration-150 ` +
                                    `hover:bg-white/5 active:scale-[0.99] ` +
                                    (isSelected
                                      ? 'bg-emerald-500/10 shadow-[0_0_0_1px_rgba(16,185,129,0.25),0_0_24px_rgba(16,185,129,0.18)]'
                                      : '')
                                  }
                                >
                                  {getScoreIndicator()}
                                  <span className={`relative z-10 text-[15px] font-semibold ${scoreStateClass}`}>{score ?? '–'}</span>
                                  {isSelected ? <span className="absolute inset-x-2 bottom-1 h-[2px] rounded-full bg-emerald-400/70" /> : null}
                                </button>
                              );
                            })}

                            <div className="px-2 py-2 text-center text-sm font-semibold text-zinc-100 bg-white/3">
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
      <div className="mb-4 p-3 rounded-2xl bg-zinc-800/50 border border-zinc-700">
        <div className="flex items-center gap-3">
          <button
            onClick={toggleVoice}
            disabled={isProcessingVoice}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all flex-shrink-0 ${
              isVoiceActive
                ? "bg-red-500 text-white scale-110 animate-pulse"
                : "bg-emerald-500 text-white hover:bg-emerald-600"
            } disabled:opacity-50`}
          >
            {isProcessingVoice ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : isVoiceActive ? (
              <MicOff className="w-6 h-6" />
            ) : (
              <Mic className="w-6 h-6" />
            )}
          </button>
          <div className="flex-1 min-w-0">
            {isVoiceActive && !voiceTranscript && (
              <p className="text-emerald-400 text-sm font-medium">Listening...</p>
            )}
            {voiceTranscript && (
              <p className="text-white text-sm truncate">"{voiceTranscript}"</p>
            )}
            {!isVoiceActive && !voiceTranscript && !isProcessingVoice && (
              <div>
                <p className="text-zinc-300 text-sm font-medium">Voice Score Entry</p>
                <p className="text-zinc-500 text-xs">Hole {currentHole || 1}</p>
              </div>
            )}
            {isProcessingVoice && (
              <p className="text-emerald-400 text-sm">Updating scores...</p>
            )}
          </div>
        </div>
        {!isVoiceActive && !isProcessingVoice && (
          <div className="mt-2 pt-2 border-t border-zinc-700/50">
            <p className="text-zinc-500 text-xs">
              Try: "{round.players[0]?.name || 'Justin'} 4, {round.players[1]?.name || 'Dan'} 5" • "everyone par" • "par except {round.players[0]?.name || 'Justin'} bogey"
            </p>
          </div>
        )}
      </div>

      {renderNine(1, 9, 'Front 9')}
      {renderNine(10, 18, 'Back 9')}

      <div className="card p-4">
        <h3 className="text-sm font-semibold tracking-tight mb-3">Totals</h3>
        <div className="grid gap-2">
          {round.players.map((player) => {
            const totals = calculateTotals(round.scores, round.holes, player.id);
            return (
              <div
                key={player.id}
                className="flex justify-between items-center rounded-2xl px-4 py-3 bg-white/4 border border-white/10"
              >
                <span className="font-medium text-zinc-200">{player.name}</span>
                <div className="flex items-center gap-4 text-sm text-zinc-300">
                  <span className="text-zinc-400">F9: {totals.front9 || '–'}</span>
                  <span className="text-zinc-400">B9: {totals.back9 || '–'}</span>
                  <span
                    className={`font-semibold text-base ${
                      totals.toPar < 0 ? 'text-red-300' : totals.toPar > 0 ? 'text-sky-300' : 'text-emerald-300'
                    }`}
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
            <div className="backdrop-blur-xl bg-zinc-950/70 border-t border-white/10">
              <div className="max-w-md mx-auto px-4 py-4">
                <p className="text-center text-sm text-zinc-400 mb-3">
                  <span className="font-semibold text-zinc-100">
                    {round.players.find((p) => p.id === selectedCell.playerId)?.name}
                  </span>
                  {' • '}Hole {selectedCell.hole}
                  {' • '}Par {round.holes[selectedCell.hole - 1]?.par}
                </p>

                <div className="grid grid-cols-4 gap-2">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((num) => (
                    <button
                      key={num}
                      onClick={() => handleNumberPadClick(num)}
                      className="btn rounded-2xl py-3 bg-white/6 hover:bg-white/10 border border-white/10 text-lg font-semibold active:scale-[0.97]"
                    >
                      {num}
                    </button>
                  ))}
                </div>

                <div className="flex gap-2 mt-3">
                  <button
                    onClick={handleClearScore}
                    className="btn flex-1 rounded-full py-3 bg-red-500/10 hover:bg-red-500/20 border border-red-400/20 text-red-200"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setSelectedCell(null)}
                    className="btn flex-1 btn-secondary"
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
