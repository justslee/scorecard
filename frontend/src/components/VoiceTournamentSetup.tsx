"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Mic,
  MicOff,
  Loader2,
  Check,
  X,
  AlertCircle,
  Wand2,
  Trophy,
  RefreshCw,
  Calendar,
  MapPin,
  Users,
} from "lucide-react";
import { parseVoiceCommand, VoiceParseResult } from "@/lib/voice-parser";

interface VoiceTournamentSetupProps {
  onCreateTournament: (config: {
    name: string;
    numRounds: number;
    courses: string[];
    playerNames: string[];
    groupings?: string[][];
    handicaps?: Record<string, number>;
    handicapAdjustment?: { type: string; description: string };
  }) => void;
  onClose: () => void;
}

export default function VoiceTournamentSetup({
  onCreateTournament,
  onClose,
}: VoiceTournamentSetupProps) {
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
      setError("Speech recognition not supported. Try Chrome or Safari.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: any) => {
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
        setError("Microphone access denied.");
      } else if (event.error !== "aborted") {
        setError(`Error: ${event.error}`);
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
      setError("Failed to start microphone.");
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
      setError("No speech detected.");
      return;
    }

    setIsParsing(true);
    setError(null);

    try {
      const apiKey = typeof window !== "undefined" ? (localStorage.getItem("anthropic_api_key") || undefined) : undefined;
      const result = await parseVoiceCommand(fullTranscript, undefined, { apiKey });
      setParseResult(result);
    } catch (err) {
      setError("Failed to understand. Please try again.");
    } finally {
      setIsParsing(false);
    }
  };

  const handleConfirm = () => {
    if (!parseResult?.tournament) return;

    const { tournament } = parseResult;
    onCreateTournament({
      name: tournament.name || "Tournament",
      numRounds: tournament.numRounds || 1,
      courses: tournament.courses || [],
      playerNames: tournament.playerNames || [],
      groupings: tournament.groupings,
      handicaps: tournament.handicaps,
      handicapAdjustment: tournament.handicapAdjustment,
    });
  };

  const handleRetry = () => {
    setParseResult(null);
    setTranscript("");
    setInterimTranscript("");
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950/95 backdrop-blur-xl flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-lg bg-zinc-900 rounded-3xl border border-zinc-800 overflow-hidden max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="p-6 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                <Trophy className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">Tournament Setup</h2>
                <p className="text-sm text-zinc-400">Describe your tournament</p>
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
          ) : parseResult?.tournament ? (
            // Show parsed result
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-zinc-800/50 border border-zinc-700">
                <div className="flex items-center gap-2 mb-4">
                  <Check className="w-5 h-5 text-emerald-400" />
                  <span className="text-sm font-medium text-emerald-400">Understood!</span>
                </div>

                <div className="space-y-4">
                  {/* Tournament name */}
                  <div>
                    <span className="text-xs text-zinc-500 uppercase tracking-wider">Name</span>
                    <p className="text-white font-medium">{parseResult.tournament.name}</p>
                  </div>

                  {/* Rounds & Courses */}
                  <div className="flex gap-4">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-zinc-400" />
                      <span className="text-white">{parseResult.tournament.numRounds} rounds</span>
                    </div>
                  </div>

                  {/* Courses */}
                  {parseResult.tournament.courses.length > 0 && (
                    <div>
                      <span className="text-xs text-zinc-500 uppercase tracking-wider">Courses</span>
                      <div className="mt-1 space-y-1">
                        {parseResult.tournament.courses.map((course, i) => (
                          <div key={i} className="flex items-center gap-2 text-white">
                            <MapPin className="w-3 h-3 text-zinc-400" />
                            Day {i + 1}: {course}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Players */}
                  {parseResult.tournament.playerNames.length > 0 && (
                    <div>
                      <span className="text-xs text-zinc-500 uppercase tracking-wider">Players</span>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {parseResult.tournament.playerNames.map((name, i) => (
                          <span
                            key={i}
                            className="px-3 py-1 rounded-full bg-zinc-700 text-white text-sm"
                          >
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Groupings */}
                  {parseResult.tournament.groupings && parseResult.tournament.groupings.length > 0 && (
                    <div>
                      <span className="text-xs text-zinc-500 uppercase tracking-wider">Groupings</span>
                      <div className="mt-1 space-y-2">
                        {parseResult.tournament.groupings.map((group, i) => (
                          <div key={i} className="p-2 rounded-lg bg-zinc-700/50">
                            <span className="text-xs text-zinc-400">Group {i + 1}:</span>
                            <span className="text-white ml-2">{group.join(", ")}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Handicaps */}
                  {parseResult.tournament.handicaps && Object.keys(parseResult.tournament.handicaps).length > 0 && (
                    <div>
                      <span className="text-xs text-zinc-500 uppercase tracking-wider">Handicaps</span>
                      <div className="mt-1 space-y-1">
                        {Object.entries(parseResult.tournament.handicaps).map(([name, hcp]) => (
                          <div key={name} className="text-white">
                            {name}: {hcp}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Handicap Adjustment */}
                  {parseResult.tournament.handicapAdjustment && (
                    <div>
                      <span className="text-xs text-zinc-500 uppercase tracking-wider">
                        Handicap Adjustment
                      </span>
                      <p className="text-white text-sm mt-1">
                        {parseResult.tournament.handicapAdjustment.description}
                      </p>
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
                  Create Tournament
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
                      : "bg-amber-500 hover:bg-amber-600"
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

              {error && (
                <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
                  {error}
                </div>
              )}

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
                      Create Tournament
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
                  <p>
                    "3 day tournament at Pebble Beach, Spyglass, and Spanish Bay with
                    Justin, Dan, Matt, and JBell"
                  </p>
                  <p>
                    "Tournament with 4 rounds, handicaps adjust by half the divergence
                    each day"
                  </p>
                  <p>
                    "Weekend tournament, Justin and Dan in group 1, Matt and JBell in
                    group 2"
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
