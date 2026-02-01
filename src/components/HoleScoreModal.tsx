"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { X, Mic, MicOff, Loader2 } from "lucide-react";
import { Player, HoleInfo } from "@/lib/types";

interface HoleScoreModalProps {
  hole: HoleInfo;
  players: Player[];
  scores: Record<string, number | null>; // playerId -> score
  onScoreChange: (playerId: string, score: number | null) => void;
  onClose: () => void;
}

export default function HoleScoreModal({
  hole,
  players,
  scores,
  onScoreChange,
  onClose,
}: HoleScoreModalProps) {
  const [isListening, setIsListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const recognitionRef = useRef<any>(null);

  // Initialize speech recognition
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

        // If final result, process it
        if (event.results[0].isFinal) {
          processVoiceInput(transcript);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.onerror = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }

    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  const processVoiceInput = async (transcript: string) => {
    setIsProcessing(true);
    try {
      // Try API first
      const response = await fetch("/api/parse-voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          systemPrompt: `Parse golf scores from voice. Players: ${players.map(p => p.name).join(", ")}. Hole par: ${hole.par}.

Common patterns:
- "[Name] got a [number]" or "[Name] [number]"
- "par for [Name]" means score = ${hole.par}
- "birdie for [Name]" means score = ${hole.par - 1}
- "bogey for [Name]" means score = ${hole.par + 1}
- "double for [Name]" means score = ${hole.par + 2}
- "eagle for [Name]" means score = ${hole.par - 2}
- "everyone par" or "all par" means everyone gets ${hole.par}
- "everyone par except [Name] who got [X]"

Return JSON only: {"scores": {"PlayerName": number, ...}}

Parse: "${transcript}"`,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.scores) {
          applyParsedScores(result.scores);
        }
      } else {
        // Fallback to local parsing
        const parsed = parseScoresLocally(transcript);
        applyParsedScores(parsed);
      }
    } catch (err) {
      // Fallback to local parsing
      const parsed = parseScoresLocally(transcript);
      applyParsedScores(parsed);
    } finally {
      setIsProcessing(false);
      setVoiceTranscript("");
    }
  };

  const parseScoresLocally = (text: string): Record<string, number> => {
    const result: Record<string, number> = {};
    const lower = text.toLowerCase();

    // Check for "everyone/all par" patterns
    if (lower.includes("everyone par") || lower.includes("all par") || lower.includes("all pars")) {
      players.forEach((p) => {
        result[p.name] = hole.par;
      });

      // Check for exceptions: "except [Name] who got [X]"
      const exceptPattern = /except\s+(\w+)\s+(?:who\s+)?(?:got\s+)?(?:a\s+)?(\d+|par|birdie|bogey|double|eagle)/gi;
      const exceptMatches = text.matchAll(exceptPattern);
      for (const match of exceptMatches) {
        const name = match[1];
        const scoreText = match[2].toLowerCase();
        const player = players.find((p) => p.name.toLowerCase().includes(name.toLowerCase()));
        if (player) {
          result[player.name] = textToScore(scoreText, hole.par);
        }
      }
      return result;
    }

    // Parse individual scores
    for (const player of players) {
      // Pattern 1: "[score] for [Name]" - check first (more specific)
      const pattern1 = new RegExp(
        `(\\d+|par|birdie|bogey|double|eagle)\\s+for\\s+${player.name}(?:\\s|$|,)`,
        "i"
      );
      const match1 = text.match(pattern1);
      if (match1 && match1[1]) {
        result[player.name] = textToScore(match1[1], hole.par);
        continue;
      }

      // Pattern 2: "[Name] got a [X]" or "[Name] [X]"
      const pattern2 = new RegExp(
        `${player.name}\\s+(?:got\\s+)?(?:a\\s+)?(\\d+|par|birdie|bogey|double|eagle)(?:\\s|$|,)`,
        "i"
      );
      const match2 = text.match(pattern2);
      if (match2 && match2[1]) {
        result[player.name] = textToScore(match2[1], hole.par);
        continue;
      }
    }

    return result;
  };

  const textToScore = (text: string, par: number): number => {
    const lower = text.toLowerCase();
    if (lower === "par") return par;
    if (lower === "birdie") return par - 1;
    if (lower === "eagle") return par - 2;
    if (lower === "bogey") return par + 1;
    if (lower === "double") return par + 2;
    const num = parseInt(text, 10);
    return isNaN(num) ? par : num;
  };

  const applyParsedScores = (parsed: Record<string, number>) => {
    for (const [name, score] of Object.entries(parsed)) {
      const player = players.find(
        (p) => p.name.toLowerCase() === name.toLowerCase()
      );
      if (player) {
        onScoreChange(player.id, score);
      }
    }
  };

  const toggleVoice = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      setVoiceTranscript("");
      recognitionRef.current?.start();
      setIsListening(true);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        className="w-full max-w-sm bg-zinc-900 rounded-2xl border border-zinc-800 shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div>
            <h3 className="font-semibold text-white">Hole {hole.number}</h3>
            <p className="text-sm text-zinc-400">Par {hole.par}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleVoice}
              disabled={isProcessing}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                isListening
                  ? "bg-red-500 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700"
              }`}
            >
              {isProcessing ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : isListening ? (
                <MicOff className="w-5 h-5" />
              ) : (
                <Mic className="w-5 h-5" />
              )}
            </button>
            <button
              onClick={onClose}
              className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center hover:bg-zinc-700"
            >
              <X className="w-5 h-5 text-zinc-400" />
            </button>
          </div>
        </div>

        {/* Voice feedback */}
        {(isListening || voiceTranscript) && (
          <div className="px-4 py-2 bg-zinc-800/50 border-b border-zinc-800">
            <p className="text-sm text-zinc-300">
              {isListening && !voiceTranscript && (
                <span className="text-emerald-400">Listening...</span>
              )}
              {voiceTranscript && <span className="italic">"{voiceTranscript}"</span>}
            </p>
          </div>
        )}

        {/* Player scores grid */}
        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {players.map((player) => (
            <ScoreScrollInput
              key={player.id}
              playerName={player.name}
              score={scores[player.id] ?? null}
              par={hole.par}
              onChange={(score) => onScoreChange(player.id, score)}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-800 space-y-2">
          <button
            onClick={() => {
              players.forEach((p) => onScoreChange(p.id, hole.par));
            }}
            className="btn btn-secondary w-full text-sm"
          >
            Set All to Par ({hole.par})
          </button>
          <button onClick={onClose} className="btn btn-primary w-full">
            Done
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// Scroll-to-change score input component with quick buttons
function ScoreScrollInput({
  playerName,
  score,
  par,
  onChange,
}: {
  playerName: string;
  score: number | null;
  par: number;
  onChange: (score: number | null) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const startY = useRef(0);
  const startScore = useRef(score ?? par);

  const getScoreColor = (s: number | null): string => {
    if (s === null) return "text-zinc-500";
    const diff = s - par;
    if (diff <= -2) return "text-yellow-400";
    if (diff === -1) return "text-red-400";
    if (diff === 0) return "text-emerald-400";
    if (diff === 1) return "text-sky-400";
    return "text-blue-400";
  };

  const getScoreLabel = (s: number | null): string => {
    if (s === null) return "";
    const diff = s - par;
    if (diff <= -2) return "Eagle";
    if (diff === -1) return "Birdie";
    if (diff === 0) return "Par";
    if (diff === 1) return "Bogey";
    if (diff === 2) return "Double";
    return `+${diff}`;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const current = score ?? par;
    const delta = e.deltaY > 0 ? 1 : -1;
    const newScore = Math.max(1, Math.min(15, current + delta));
    onChange(newScore);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    setIsDragging(true);
    startY.current = e.touches[0].clientY;
    startScore.current = score ?? par;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return;
    const deltaY = startY.current - e.touches[0].clientY;
    const deltaScore = Math.round(deltaY / 25);
    const newScore = Math.max(1, Math.min(15, startScore.current + deltaScore));
    onChange(newScore);
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
  };

  const increment = () => {
    const current = score ?? par;
    if (current < 15) onChange(current + 1);
  };

  const decrement = () => {
    const current = score ?? par;
    if (current > 1) onChange(current - 1);
  };

  // Quick score buttons
  const quickScores = [
    { label: "Birdie", value: par - 1, color: "bg-red-500/20 text-red-300 border-red-500/30" },
    { label: "Par", value: par, color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
    { label: "Bogey", value: par + 1, color: "bg-sky-500/20 text-sky-300 border-sky-500/30" },
    { label: "+2", value: par + 2, color: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  ];

  return (
    <div className="p-3 rounded-xl bg-zinc-800/50 border border-zinc-700">
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-white truncate">{playerName}</span>
        <span className={`text-xs ${getScoreColor(score)}`}>{getScoreLabel(score)}</span>
      </div>
      
      <div className="flex items-center gap-2">
        {/* Quick score buttons */}
        <div className="flex gap-1 flex-1">
          {quickScores.map((qs) => (
            <button
              key={qs.label}
              onClick={() => onChange(qs.value)}
              className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-all ${
                score === qs.value ? qs.color + " scale-105" : "bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700"
              }`}
            >
              {qs.label}
            </button>
          ))}
        </div>

        {/* Manual adjustment */}
        <div className="flex items-center gap-1">
          <button
            onClick={decrement}
            className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-zinc-600 flex items-center justify-center text-zinc-300 text-lg font-bold active:scale-95"
          >
            −
          </button>

          <div
            onWheel={handleWheel}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className={`w-12 h-10 rounded-lg flex items-center justify-center cursor-ns-resize select-none transition-all ${
              isDragging ? "bg-emerald-500/20 border-emerald-500 scale-105" : "bg-zinc-900 border-zinc-600"
            } border-2`}
          >
            <span className={`text-xl font-bold ${getScoreColor(score)}`}>
              {score ?? "–"}
            </span>
          </div>

          <button
            onClick={increment}
            className="w-8 h-8 rounded-lg bg-zinc-700 hover:bg-zinc-600 flex items-center justify-center text-zinc-300 text-lg font-bold active:scale-95"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
