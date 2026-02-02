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
  RefreshCw,
  Users,
  MapPin,
} from "lucide-react";

interface VoiceRoundSetupProps {
  onSetupRound: (config: {
    courseName: string;
    playerNames: string[];
    teeName?: string;
  }) => void;
  onClose: () => void;
}

interface ParsedRoundConfig {
  courseName: string;
  playerNames: string[];
  teeName?: string;
  gameFormat?: string;
}

export default function VoiceRoundSetup({
  onSetupRound,
  onClose,
}: VoiceRoundSetupProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isParsing, setIsParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParsedRoundConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);

  const recognitionRef = useRef<any>(null);

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
    try {
      recognitionRef.current.stop();
      recognitionRef.current.abort?.();
    } catch {
      // Ignore errors on stop
    }
    setIsListening(false);
    setInterimTranscript("");
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
      const response = await fetch("/api/parse-voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: fullTranscript,
          systemPrompt: `Parse this golf round setup request. Extract:
- courseName: the golf course name mentioned
- playerNames: array of player names
- teeName: tee box color if mentioned (blue, white, red, etc.)

Return JSON only:
{
  "courseName": "Course Name",
  "playerNames": ["Player1", "Player2"],
  "teeName": "Blue" // optional
}

User said: "${fullTranscript}"`,
        }),
      });

      if (!response.ok) {
        throw new Error("Parse failed");
      }

      const result = await response.json();
      setParseResult(result);
    } catch (err) {
      // Fallback: try local parsing
      const parsed = parseLocally(fullTranscript);
      if (parsed.courseName || parsed.playerNames.length > 0) {
        setParseResult(parsed);
      } else {
        setError("Couldn't understand. Please try again.");
      }
    } finally {
      setIsParsing(false);
    }
  };

  const parseLocally = (text: string): ParsedRoundConfig => {
    const playerNames: string[] = [];
    const lower = text.toLowerCase();

    // Extract player names - look for patterns like "with Justin, Dan, and Matt"
    const withPattern = /(?:with|players?:?)\s+([A-Z][a-z]+(?:\s*,?\s*(?:and\s+)?[A-Z][a-z]+)*)/gi;
    const withMatches = text.matchAll(withPattern);
    for (const match of withMatches) {
      const names = match[1].split(/,|\s+and\s+/).map((n) => n.trim()).filter(Boolean);
      playerNames.push(...names);
    }

    // Also try to find capitalized names
    const namePattern = /\b([A-Z][a-z]{2,})\b/g;
    const nameMatches = text.matchAll(namePattern);
    const commonWords = new Set(['Playing', 'Round', 'Golf', 'Course', 'Tee', 'Blue', 'White', 'Red', 'Gold', 'Black']);
    for (const match of nameMatches) {
      if (!commonWords.has(match[1]) && !playerNames.includes(match[1])) {
        // Could be a player name or course word
      }
    }

    // Extract course name - look for "at [Course Name]" or "[Course Name] golf"
    let courseName = "";
    const atPattern = /(?:at|playing)\s+([A-Z][A-Za-z\s]+?)(?:\s+(?:golf|course|with|today)|\s*$|,)/i;
    const atMatch = text.match(atPattern);
    if (atMatch) {
      courseName = atMatch[1].trim();
    }

    // Extract tee
    let teeName: string | undefined;
    const teePattern = /(?:from\s+(?:the\s+)?)?(\w+)\s+tees?/i;
    const teeMatch = text.match(teePattern);
    if (teeMatch) {
      teeName = teeMatch[1];
    }

    return {
      courseName,
      playerNames: [...new Set(playerNames)],
      teeName,
    };
  };

  const handleConfirm = () => {
    if (!parseResult) return;
    onSetupRound({
      courseName: parseResult.courseName || "Custom Course",
      playerNames: parseResult.playerNames,
      teeName: parseResult.teeName,
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
                <p className="text-sm text-zinc-400">Describe your round</p>
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
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-zinc-800/50 border border-zinc-700">
                <div className="flex items-center gap-2 mb-4">
                  <Check className="w-5 h-5 text-emerald-400" />
                  <span className="text-sm font-medium text-emerald-400">Got it!</span>
                </div>

                <div className="space-y-3">
                  {parseResult.courseName && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-zinc-400" />
                      <span className="text-white">{parseResult.courseName}</span>
                    </div>
                  )}

                  {parseResult.playerNames.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <Users className="w-4 h-4 text-zinc-400" />
                        <span className="text-zinc-400 text-sm">Players</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {parseResult.playerNames.map((name, i) => (
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

                  {parseResult.teeName && (
                    <div className="text-zinc-400 text-sm">
                      Tee: <span className="text-white">{parseResult.teeName}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-3 rounded-xl bg-zinc-800/30 border border-zinc-800">
                <p className="text-xs text-zinc-500 mb-1">You said:</p>
                <p className="text-sm text-zinc-300 italic">"{transcript}"</p>
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
                  Set Up Round
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center">
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
                      Set Up Round
                    </>
                  )}
                </button>
              )}

              <div className="mt-8 text-left">
                <p className="text-xs text-zinc-500 uppercase tracking-wider mb-3">
                  Example commands
                </p>
                <div className="space-y-2 text-sm text-zinc-400">
                  <p>"Playing at Pebble Beach with Justin, Dan, Matt, and JBell"</p>
                  <p>"Round at TPC Sawgrass from the blue tees with the boys"</p>
                  <p>"Quick 18 at my home course with Justin and Dan"</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
