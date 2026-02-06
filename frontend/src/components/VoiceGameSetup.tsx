"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Mic,
  MicOff,
  Loader2,
  Check,
  X,
  AlertCircle,
  Wand2,
  Users,
  Trophy,
  RefreshCw,
} from "lucide-react";
import { parseVoiceCommand, VoiceParseResult, matchPlayerNames } from "@/lib/voice-parser";
import { Player, Game, GameFormat } from "@/lib/types";

interface VoiceGameSetupProps {
  players: Player[];
  onCreateGame: (game: Omit<Game, "id" | "roundId">) => void;
  onClose: () => void;
}

// Web Speech API types
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

export default function VoiceGameSetup({
  players,
  onCreateGame,
  onClose,
}: VoiceGameSetupProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [parseResult, setParseResult] = useState<VoiceParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);

  const recognitionRef = useRef<any>(null);

  // Check for Web Speech API support
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setIsSupported(false);
      setError("Speech recognition not supported in this browser. Try Chrome or Safari.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (final) {
        setTranscript((prev) => prev + " " + final);
      }
      setInterimTranscript(interim);
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === "not-allowed") {
        setError("Microphone access denied. Please allow microphone access.");
      } else if (event.error !== "aborted") {
        setError(`Speech recognition error: ${event.error}`);
      }
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
    };
  }, []);

  const startListening = useCallback(() => {
    if (!recognitionRef.current) return;

    setError(null);
    setTranscript("");
    setInterimTranscript("");
    setParseResult(null);

    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (err) {
      console.error("Failed to start recognition:", err);
      setError("Failed to start microphone. Please try again.");
    }
  }, []);

  const stopListening = useCallback(() => {
    if (!recognitionRef.current) return;

    recognitionRef.current.stop();
    setIsListening(false);
  }, []);

  const handleParse = async () => {
    const fullTranscript = (transcript + " " + interimTranscript).trim();
    if (!fullTranscript) {
      setError("No speech detected. Please try again.");
      return;
    }

    setIsParsing(true);
    setError(null);

    try {
      const apiKey = typeof window !== "undefined" ? (localStorage.getItem("anthropic_api_key") || undefined) : undefined;
      const result = await parseVoiceCommand(fullTranscript, players, { apiKey });
      setParseResult(result);
    } catch (err) {
      console.error("Parse error:", err);
      setError("Failed to understand the command. Please try again.");
    } finally {
      setIsParsing(false);
    }
  };

  const handleConfirm = () => {
    if (!parseResult?.game) return;

    const { game } = parseResult;

    // Match voice player names to actual players
    const playerMatches = matchPlayerNames(game.playerNames, players);
    const matchedPlayerIds = Array.from(playerMatches.values()).map((p) => p.id);

    // If we couldn't match enough players, use all players
    const finalPlayerIds =
      matchedPlayerIds.length >= 2 ? matchedPlayerIds : players.map((p) => p.id);

    // Build teams if present
    const teams = game.teams?.map((team, i) => {
      const teamPlayerIds = team.playerNames
        .map((name) => playerMatches.get(name)?.id)
        .filter(Boolean) as string[];
      
      return {
        id: crypto.randomUUID(),
        name: team.name || `Team ${i + 1}`,
        playerIds: teamPlayerIds.length > 0 ? teamPlayerIds : [],
      };
    });

    const newGame: Omit<Game, "id" | "roundId"> = {
      format: game.format as GameFormat,
      name: game.name,
      playerIds: finalPlayerIds,
      teams,
      settings: {
        handicapped: !!game.handicaps && Object.keys(game.handicaps).length > 0,
        ...game.settings,
      },
    };

    onCreateGame(newGame);
  };

  const handleRetry = () => {
    setParseResult(null);
    setTranscript("");
    setInterimTranscript("");
    setError(null);
  };

  const formatName = (format: string) => {
    const names: Record<string, string> = {
      skins: "Skins",
      nassau: "Nassau",
      bestBall: "Best Ball",
      matchPlay: "Match Play",
      stableford: "Stableford",
      wolf: "Wolf",
      threePoint: "3-Point System",
      scramble: "Scramble",
    };
    return names[format] || format;
  };

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950/95 backdrop-blur-xl flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-lg bg-zinc-900 rounded-3xl border border-zinc-800 overflow-hidden"
      >
        {/* Header */}
        <div className="p-6 border-b border-zinc-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <Wand2 className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Voice Setup</h2>
                <p className="text-sm text-zinc-400">Describe your game</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center hover:bg-zinc-700"
            >
              <X className="w-4 h-4 text-zinc-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {!isSupported ? (
            <div className="text-center py-8">
              <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <p className="text-zinc-300">{error}</p>
            </div>
          ) : parseResult ? (
            // Show parsed result
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-zinc-800/50 border border-zinc-700">
                <div className="flex items-center gap-2 mb-3">
                  <Check className="w-5 h-5 text-emerald-400" />
                  <span className="text-sm font-medium text-emerald-400">Understood!</span>
                </div>
                
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-400">Format</span>
                    <span className="text-white font-medium">
                      {formatName(parseResult.game?.format || "")}
                    </span>
                  </div>
                  
                  {parseResult.game?.teams && parseResult.game.teams.length > 0 && (
                    <div>
                      <span className="text-zinc-400 text-sm">Teams</span>
                      <div className="mt-1 space-y-1">
                        {parseResult.game.teams.map((team, i) => (
                          <div key={i} className="text-white">
                            {team.name}: {team.playerNames.join(", ")}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  
                  {parseResult.game?.handicaps && Object.keys(parseResult.game.handicaps).length > 0 && (
                    <div>
                      <span className="text-zinc-400 text-sm">Handicaps</span>
                      <div className="mt-1 space-y-1">
                        {Object.entries(parseResult.game.handicaps).map(([name, strokes]) => (
                          <div key={name} className="text-white">
                            {name}: +{strokes} strokes
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-zinc-800/30 border border-zinc-800">
                <p className="text-xs text-zinc-500 mb-1">You said:</p>
                <p className="text-sm text-zinc-300 italic">"{parseResult.rawTranscript}"</p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleRetry}
                  className="flex-1 btn btn-secondary flex items-center justify-center gap-2"
                >
                  <RefreshCw className="w-4 h-4" />
                  Try Again
                </button>
                <button
                  onClick={handleConfirm}
                  className="flex-1 btn btn-primary flex items-center justify-center gap-2"
                >
                  <Check className="w-4 h-4" />
                  Create Game
                </button>
              </div>
            </div>
          ) : (
            // Voice input UI
            <div className="text-center">
              {/* Mic button */}
              <div className="mb-6">
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={isListening ? stopListening : startListening}
                  disabled={isParsing}
                  className={`w-24 h-24 rounded-full flex items-center justify-center mx-auto transition-colors ${
                    isListening
                      ? "bg-red-500 hover:bg-red-600"
                      : "bg-emerald-500 hover:bg-emerald-600"
                  } disabled:opacity-50`}
                >
                  {isParsing ? (
                    <Loader2 className="w-10 h-10 text-white animate-spin" />
                  ) : isListening ? (
                    <MicOff className="w-10 h-10 text-white" />
                  ) : (
                    <Mic className="w-10 h-10 text-white" />
                  )}
                </motion.button>
                
                <p className="mt-4 text-zinc-400">
                  {isParsing
                    ? "Understanding..."
                    : isListening
                    ? "Listening... tap to stop"
                    : "Tap to start speaking"}
                </p>
              </div>

              {/* Transcript display */}
              {(transcript || interimTranscript) && (
                <div className="mb-6 p-4 rounded-xl bg-zinc-800/50 border border-zinc-700 text-left">
                  <p className="text-white">
                    {transcript}
                    <span className="text-zinc-500">{interimTranscript}</span>
                  </p>
                </div>
              )}

              {/* Error display */}
              {error && (
                <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
                  {error}
                </div>
              )}

              {/* Parse button */}
              {(transcript || interimTranscript) && !isListening && (
                <button
                  onClick={handleParse}
                  disabled={isParsing}
                  className="btn btn-primary w-full flex items-center justify-center gap-2"
                >
                  {isParsing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-4 h-4" />
                      Create Game
                    </>
                  )}
                </button>
              )}

              {/* Examples */}
              <div className="mt-8 text-left">
                <p className="text-xs text-zinc-500 uppercase tracking-wider mb-3">
                  Example commands
                </p>
                <div className="space-y-2 text-sm text-zinc-400">
                  <p>"Play 2v2 best ball with Justin and Dan versus Matt and JBell"</p>
                  <p>"Skins game where Justin receives 10 strokes on Dan"</p>
                  <p>"Match play between Justin and Dan, $5 per hole"</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
