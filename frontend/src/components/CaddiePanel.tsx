'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, PanInfo } from 'framer-motion';
import {
  Wind,
  Locate,
  Flag,
  ChevronUp,
  Signal,
  Mic,
  MicOff,
  Volume2,
  Target,
  TrendingUp,
  AlertTriangle,
  Compass,
  ChevronDown,
  Loader2,
  MessageCircle,
} from 'lucide-react';
import { Round } from '@/lib/types';
import type { CourseCoordinates } from '@/lib/golf-api';
import { GPSWatcher, calculateDistance, calculateBearing, getAccuracyDescription, Position } from '@/lib/gps';
import { getGolferProfile } from '@/lib/storage';
import {
  PERSONALITIES,
  getSelectedPersonality,
  setSelectedPersonality,
  CaddiePersonality,
} from '@/lib/caddie/personalities';
import {
  fetchRecommendation,
  fetchCourseIntel,
  fetchWeather,
  talkToCaddie,
} from '@/lib/caddie/api';
import type {
  CaddieRecommendation,
  WeatherConditions,
  HoleIntelligence,
  VoiceCaddieMessage,
} from '@/lib/caddie/types';

// Normalize GolferProfile camelCase keys → short keys for the backend
function normalizeClubDistances(raw: Record<string, number | undefined>): Record<string, number> {
  const map: Record<string, string> = {
    driver: 'driver',
    threeWood: '3wood',
    fiveWood: '5wood',
    hybrid: 'hybrid',
    fourIron: '4iron',
    fiveIron: '5iron',
    sixIron: '6iron',
    sevenIron: '7iron',
    eightIron: '8iron',
    nineIron: '9iron',
    pitchingWedge: 'pw',
    gapWedge: 'gw',
    sandWedge: 'sw',
    lobWedge: 'lw',
  };
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v != null && map[k]) result[map[k]] = v;
  }
  return result;
}

const defaultClubDistances: Record<string, number> = {
  driver: 250, '3wood': 230, '5wood': 215, hybrid: 200,
  '4iron': 190, '5iron': 180, '6iron': 170, '7iron': 160,
  '8iron': 150, '9iron': 140, pw: 130, gw: 115, sw: 100, lw: 85,
};

const clubDisplayName = (c: string) =>
  c.replace(/(\d)(wood|iron)/i, '$1 $2').replace(/^pw$/i, 'PW').replace(/^gw$/i, 'GW').replace(/^sw$/i, 'SW').replace(/^lw$/i, 'LW').replace(/^driver$/i, 'Driver').replace(/^hybrid$/i, 'Hybrid');

interface CaddiePanelProps {
  round: Round;
  currentHole: number;
  onHoleChange: (hole: number) => void;
  onClose: () => void;
  holeCoordinates?: CourseCoordinates[];
}

function getHoleInfo(round: Round, holeNumber: number) {
  const holeData = round.holes?.[holeNumber - 1];
  const defaultPars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5];
  const defaultYards = [385, 410, 175, 520, 395, 365, 195, 430, 545, 400, 165, 425, 510, 380, 405, 185, 440, 530];

  return {
    number: holeNumber,
    par: holeData?.par ?? defaultPars[holeNumber - 1] ?? 4,
    yards: holeData?.yards ?? defaultYards[holeNumber - 1] ?? 400,
    handicap: holeData?.handicap ?? holeNumber,
  };
}

type SheetState = 'collapsed' | 'expanded';
type CaddieTab = 'recommend' | 'voice';

export default function CaddiePanel({ round, currentHole, onHoleChange, onClose, holeCoordinates }: CaddiePanelProps) {
  // GPS state
  const [distanceToPin, setDistanceToPin] = useState<number | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsPosition, setGpsPosition] = useState<Position | null>(null);
  const [gpsActive, setGpsActive] = useState(false);
  const [sheetState, setSheetState] = useState<SheetState>('collapsed');
  const [slideDirection, setSlideDirection] = useState<'left' | 'right'>('left');
  const containerRef = useRef<HTMLDivElement>(null);
  const prevHoleRef = useRef(currentHole);
  const gpsWatcherRef = useRef<GPSWatcher | null>(null);

  // Caddie state
  const [activeTab, setActiveTab] = useState<CaddieTab>('recommend');
  const [personality, setPersonality] = useState<CaddiePersonality>(getSelectedPersonality());
  const [showPersonalityPicker, setShowPersonalityPicker] = useState(false);
  const [recommendation, setRecommendation] = useState<CaddieRecommendation | null>(null);
  const [weather, setWeather] = useState<WeatherConditions | null>(null);
  const [holeIntel, setHoleIntel] = useState<HoleIntelligence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Voice state
  const [isListening, setIsListening] = useState(false);
  const [voiceMessages, setVoiceMessages] = useState<VoiceCaddieMessage[]>([]);
  const [voiceInput, setVoiceInput] = useState('');
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Club distances — from profile or defaults
  const [clubDistances, setClubDistances] = useState<Record<string, number>>(defaultClubDistances);
  const [handicap, setHandicap] = useState<number | undefined>(undefined);

  const hole = getHoleInfo(round, currentHole);

  // Load golfer profile on mount
  useEffect(() => {
    const profile = getGolferProfile();
    if (profile) {
      const normalized = normalizeClubDistances(profile.clubDistances);
      if (Object.keys(normalized).length > 0) {
        setClubDistances({ ...defaultClubDistances, ...normalized });
      }
      if (profile.handicap != null) setHandicap(profile.handicap);
    }
  }, []);

  // GPS distance data for current hole
  const currentHoleCoords = holeCoordinates?.find(h => h.holeNumber === currentHole);
  const gpsDistances = gpsPosition && currentHoleCoords ? {
    center: calculateDistance(gpsPosition, currentHoleCoords.green).yards,
    front: currentHoleCoords.front ? calculateDistance(gpsPosition, currentHoleCoords.front).yards : null,
    back: currentHoleCoords.back ? calculateDistance(gpsPosition, currentHoleCoords.back).yards : null,
    pin: currentHoleCoords.pin ? calculateDistance(gpsPosition, currentHoleCoords.pin).yards : null,
  } : null;

  // Bearing from player to green (for wind adjustment)
  const bearingToGreen = gpsPosition && currentHoleCoords
    ? calculateBearing(gpsPosition, currentHoleCoords.green)
    : undefined;

  // Auto-update distanceToPin from GPS
  useEffect(() => {
    if (gpsDistances && gpsActive) {
      setDistanceToPin(gpsDistances.center);
    }
  }, [gpsDistances, gpsActive]);

  // GPS handlers
  const handleGpsPositionUpdate = useCallback((pos: Position) => {
    setGpsPosition(pos);
    setGpsLoading(false);
    setGpsActive(true);
  }, []);

  const handleGpsError = useCallback(() => {
    setGpsLoading(false);
  }, []);

  useEffect(() => {
    return () => { gpsWatcherRef.current?.stop(); };
  }, []);

  // Track slide direction
  if (prevHoleRef.current !== currentHole) {
    setSlideDirection(currentHole > prevHoleRef.current ? 'left' : 'right');
    prevHoleRef.current = currentHole;
  }

  // Reset recommendation when hole changes
  useEffect(() => {
    setRecommendation(null);
    setHoleIntel(null);
  }, [currentHole]);

  // Animation variants
  const slideVariants = {
    enter: (direction: 'left' | 'right') => ({ x: direction === 'left' ? 80 : -80, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (direction: 'left' | 'right') => ({ x: direction === 'left' ? -80 : 80, opacity: 0 }),
  };

  // ---------- Caddie API calls ----------

  const getRecommendation = async () => {
    setLoading(true);
    setError(null);
    try {
      const rec = await fetchRecommendation({
        hole_number: currentHole,
        distance_yards: distanceToPin ?? undefined,
        par: hole.par,
        yards: hole.yards,
        club_distances: clubDistances,
        handicap,
        weather: weather ?? undefined,
        hole_intelligence: holeIntel ?? undefined,
      });
      setRecommendation(rec);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to get recommendation');
    } finally {
      setLoading(false);
    }
  };

  const loadWeather = async () => {
    if (!gpsPosition) return;
    try {
      const w = await fetchWeather(gpsPosition.lat, gpsPosition.lng);
      setWeather(w);
    } catch {
      // silent — weather is supplementary
    }
  };

  const loadCourseIntel = async () => {
    if (!holeCoordinates || holeCoordinates.length === 0) return;
    try {
      const coords = holeCoordinates.map(h => ({
        holeNumber: h.holeNumber,
        green: h.green,
        tee: h.tee,
        front: h.front,
        back: h.back,
        par: round.holes?.[h.holeNumber - 1]?.par,
        yards: round.holes?.[h.holeNumber - 1]?.yards,
        handicap: round.holes?.[h.holeNumber - 1]?.handicap,
      }));
      const result = await fetchCourseIntel(
        coords,
        gpsPosition?.lat,
        gpsPosition?.lng,
      );
      if (result.weather) setWeather(result.weather);
      const thisHole = result.holes?.find(h => h.hole_number === currentHole);
      if (thisHole) setHoleIntel(thisHole);
    } catch {
      // silent
    }
  };

  // Load weather + course intel when GPS activates
  useEffect(() => {
    if (gpsActive && gpsPosition) {
      loadWeather();
      loadCourseIntel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpsActive]);

  // ---------- Voice ----------

  const startListening = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript;
      setVoiceInput(transcript);
      sendVoiceMessage(transcript);
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognition.start();
    recognitionRef.current = recognition;
    setIsListening(true);
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setIsListening(false);
  };

  const speakResponse = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.pitch = personality.voiceStyle.pitch;
    utterance.rate = personality.voiceStyle.rate;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  };

  const sendVoiceMessage = async (transcript: string) => {
    const userMsg: VoiceCaddieMessage = { role: 'user', content: transcript };
    setVoiceMessages(prev => [...prev, userMsg]);
    setVoiceInput('');
    setVoiceLoading(true);

    try {
      const resp = await talkToCaddie({
        transcript,
        personality_id: personality.id,
        hole_number: currentHole,
        par: hole.par,
        yards: hole.yards,
        distance_yards: distanceToPin ?? undefined,
        wind_speed_mph: weather?.wind_speed_mph,
        wind_direction: weather?.wind_direction,
        club_distances: clubDistances,
        handicap,
        current_recommendation: recommendation ?? undefined,
        conversation_history: voiceMessages,
      });
      const assistantMsg: VoiceCaddieMessage = { role: 'assistant', content: resp.response };
      setVoiceMessages(prev => [...prev, assistantMsg]);
      speakResponse(resp.response);
    } catch {
      const errMsg: VoiceCaddieMessage = { role: 'assistant', content: "Sorry, I couldn't process that. Try again." };
      setVoiceMessages(prev => [...prev, errMsg]);
    } finally {
      setVoiceLoading(false);
    }
  };

  // Auto-scroll voice messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [voiceMessages]);

  // ---------- Touch handling ----------

  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const deltaX = e.changedTouches[0].clientX - touchStart.current.x;
    const deltaY = e.changedTouches[0].clientY - touchStart.current.y;

    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX < -50 && currentHole < 18) onHoleChange(currentHole + 1);
      else if (deltaX > 50 && currentHole > 1) onHoleChange(currentHole - 1);
    } else {
      if (deltaY > 80) onClose();
    }
    touchStart.current = null;
  };

  const handleSheetDragEnd = (_: unknown, info: PanInfo) => {
    if (info.velocity.y < -200 || info.offset.y < -30) setSheetState('expanded');
    else if (info.velocity.y > 200 || info.offset.y > 30) setSheetState('collapsed');
  };

  const sheetHeights: Record<SheetState, string> = {
    collapsed: '70px',
    expanded: '75%',
  };

  // Quick club suggestion (simple, before backend call)
  const getSuggestedClub = (distance: number): { club: string; yards: number } => {
    const clubs = Object.entries(clubDistances).sort((a, b) => b[1] - a[1]);
    for (const [club, dist] of clubs) {
      if (dist <= distance + 5) return { club, yards: dist };
    }
    return clubs[clubs.length - 1] ? { club: clubs[clubs.length - 1][0], yards: clubs[clubs.length - 1][1] } : { club: 'pw', yards: 130 };
  };

  const suggestion = distanceToPin ? getSuggestedClub(distanceToPin) : null;

  // GPS toggle
  const handleGetLocation = () => {
    if (!navigator.geolocation) return;
    if (gpsActive && gpsWatcherRef.current) {
      gpsWatcherRef.current.stop();
      gpsWatcherRef.current = null;
      setGpsActive(false);
      setGpsPosition(null);
      return;
    }
    setGpsLoading(true);
    if (holeCoordinates && holeCoordinates.length > 0) {
      gpsWatcherRef.current = new GPSWatcher(handleGpsPositionUpdate, handleGpsError);
      gpsWatcherRef.current.start();
    } else {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGpsLoading(false);
          setGpsPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
          setGpsActive(true);
        },
        () => setGpsLoading(false),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    }
  };

  // Personality change
  const changePersonality = (p: CaddiePersonality) => {
    setPersonality(p);
    setSelectedPersonality(p.id);
    setShowPersonalityPicker(false);
  };

  // Confidence color
  const confidenceColor = (c: number) => c >= 0.7 ? 'text-emerald-400' : c >= 0.4 ? 'text-yellow-400' : 'text-red-400';
  const trafficColor = (t: string) => t === 'green' ? 'bg-emerald-500' : t === 'yellow' ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div ref={containerRef} className="relative h-full flex flex-col bg-black overscroll-none">
      {/* MAP AREA */}
      <div
        className="flex-1 bg-gradient-to-b from-emerald-950 to-zinc-950 relative"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white text-lg"
        >
          ✕
        </button>

        {/* Personality badge */}
        <button
          onClick={() => setShowPersonalityPicker(!showPersonalityPicker)}
          className="absolute top-4 left-1/2 -translate-x-1/2 z-20 bg-black/50 backdrop-blur-sm rounded-full px-3 py-1.5 flex items-center gap-2"
        >
          <span className="text-base">{personality.avatar}</span>
          <span className="text-xs text-zinc-300 font-medium">{personality.name}</span>
          <ChevronDown className="w-3 h-3 text-zinc-500" />
        </button>

        {/* Personality picker dropdown */}
        <AnimatePresence>
          {showPersonalityPicker && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-zinc-900 border border-zinc-700 rounded-xl overflow-hidden shadow-2xl w-64"
            >
              {PERSONALITIES.map(p => (
                <button
                  key={p.id}
                  onClick={() => changePersonality(p)}
                  className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                    personality.id === p.id ? 'bg-emerald-500/20' : 'hover:bg-zinc-800'
                  }`}
                >
                  <span className="text-xl">{p.avatar}</span>
                  <div>
                    <div className="text-sm font-medium text-white">{p.name}</div>
                    <div className="text-xs text-zinc-500">{p.description}</div>
                  </div>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Hole info */}
        <div className="absolute top-4 left-4 z-10">
          <AnimatePresence mode="wait" custom={slideDirection}>
            <motion.div
              key={currentHole}
              custom={slideDirection}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="bg-black/50 backdrop-blur-sm rounded-xl px-4 py-2"
            >
              <div className="text-2xl font-bold text-white">Hole {currentHole}</div>
              <div className="text-sm text-zinc-400">Par {hole.par} • {hole.yards} yds</div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* GPS button */}
        <button
          onClick={handleGetLocation}
          disabled={gpsLoading}
          className={`absolute top-20 right-4 z-10 backdrop-blur-sm border rounded-xl px-3 py-2 flex items-center gap-2 disabled:opacity-50 ${
            gpsActive ? 'bg-emerald-500/30 border-emerald-500/50 text-emerald-300' : 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
          }`}
        >
          <Locate className={`w-5 h-5 ${gpsLoading ? 'animate-pulse' : ''}`} />
          {gpsActive && <span className="text-xs font-medium">Live</span>}
        </button>

        {/* GPS status */}
        {gpsActive && gpsPosition && (
          <div className="absolute top-32 right-4 z-10 flex items-center gap-1.5 bg-black/50 backdrop-blur-sm rounded-lg px-2 py-1">
            <Signal className="w-3 h-3 text-emerald-400" />
            <span className="text-xs text-emerald-400/80">{getAccuracyDescription(gpsPosition.accuracy || 0)}</span>
          </div>
        )}

        {/* Weather bar */}
        {weather && (
          <div className="absolute top-32 left-4 z-10 bg-black/50 backdrop-blur-sm rounded-lg px-2 py-1 flex items-center gap-2 text-xs text-zinc-400">
            <span>{Math.round(weather.temperature_f)}°F</span>
            <Wind className="w-3 h-3" />
            <span>{Math.round(weather.wind_speed_mph)}mph</span>
          </div>
        )}

        {/* GPS front/center/back distances */}
        {gpsActive && gpsDistances && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 mt-14">
            <div className="bg-black/60 backdrop-blur-sm rounded-xl px-3 py-2 flex items-center gap-4">
              {gpsDistances.front !== null && (
                <div className="text-center">
                  <div className="text-xs text-zinc-500">F</div>
                  <div className="text-sm font-bold text-white">{gpsDistances.front}</div>
                </div>
              )}
              <div className="text-center">
                <div className="text-xs text-emerald-400">C</div>
                <div className="text-lg font-bold text-emerald-400">{gpsDistances.center}</div>
              </div>
              {gpsDistances.back !== null && (
                <div className="text-center">
                  <div className="text-xs text-zinc-500">B</div>
                  <div className="text-sm font-bold text-white">{gpsDistances.back}</div>
                </div>
              )}
              {gpsDistances.pin !== null && (
                <div className="text-center border-l border-zinc-700 pl-3">
                  <Flag className="w-3 h-3 text-red-400 mx-auto" />
                  <div className="text-sm font-bold text-white">{gpsDistances.pin}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Navigation arrows */}
        {currentHole > 1 && (
          <button
            onClick={() => onHoleChange(currentHole - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/30 flex items-center justify-center text-white/60 z-10"
          >
            ‹
          </button>
        )}
        {currentHole < 18 && (
          <button
            onClick={() => onHoleChange(currentHole + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/30 flex items-center justify-center text-white/60 z-10"
          >
            ›
          </button>
        )}

        {/* Map placeholder */}
        <AnimatePresence mode="wait" custom={slideDirection}>
          <motion.div
            key={currentHole}
            custom={slideDirection}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none"
          >
            <div className="relative w-40 h-48 mx-auto mb-2">
              <div className="absolute inset-x-6 top-16 bottom-0 bg-emerald-800/30 rounded-t-full" />
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-20 h-20 bg-emerald-600/40 rounded-full" />
              <div className="absolute top-6 left-1/2 -translate-x-1/2">
                <Flag className="w-6 h-6 text-red-400" />
              </div>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-4 h-4 bg-white/50 rounded-full" />
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Hole dots */}
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 flex gap-1.5 z-10">
          {Array.from({ length: 9 }, (_, i) => {
            const holeNum = currentHole <= 9 ? i + 1 : i + 10;
            return (
              <button
                key={holeNum}
                onClick={() => onHoleChange(holeNum)}
                className={`w-2 h-2 rounded-full transition-all ${
                  holeNum === currentHole ? 'bg-emerald-400 w-4' : 'bg-zinc-600 hover:bg-zinc-500'
                }`}
              />
            );
          })}
        </div>

        <p className="absolute bottom-12 left-1/2 -translate-x-1/2 text-zinc-600 text-xs">
          ← swipe for holes • down to close →
        </p>

        {/* Distance overlay */}
        {distanceToPin && sheetState === 'collapsed' && (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm rounded-full px-5 py-2 z-10">
            <span className="text-2xl font-bold text-white">{distanceToPin}</span>
            <span className="text-zinc-400 ml-1 text-sm">yds</span>
            {suggestion && (
              <span className="text-emerald-400 ml-2 font-bold uppercase">{clubDisplayName(suggestion.club)}</span>
            )}
          </div>
        )}
      </div>

      {/* BOTTOM SHEET */}
      <motion.div
        className="absolute bottom-0 left-0 right-0 bg-zinc-900 rounded-t-2xl border-t border-zinc-800 overflow-hidden"
        animate={{ height: sheetHeights[sheetState] }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0.2}
        onDragEnd={handleSheetDragEnd}
      >
        {/* Handle */}
        <div className="w-full py-3 flex flex-col items-center cursor-grab active:cursor-grabbing">
          <div className="w-12 h-1.5 rounded-full bg-zinc-600" />
          <div className="flex items-center gap-1 text-zinc-500 text-xs mt-2">
            <ChevronUp className={`w-4 h-4 transition-transform ${sheetState === 'expanded' ? 'rotate-180' : ''}`} />
            <span>{sheetState === 'collapsed' ? 'Pull up for caddie' : 'Pull down to close'}</span>
          </div>
        </div>

        {/* Sheet content */}
        <AnimatePresence>
          {sheetState === 'expanded' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="px-4 pb-6 overflow-y-auto overscroll-contain"
              style={{ maxHeight: 'calc(100% - 60px)' }}
            >
              {/* Tab bar */}
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setActiveTab('recommend')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                    activeTab === 'recommend' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  <Target className="w-4 h-4" /> Caddie
                </button>
                <button
                  onClick={() => setActiveTab('voice')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                    activeTab === 'voice' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  <MessageCircle className="w-4 h-4" /> Talk
                </button>
              </div>

              {/* RECOMMEND TAB */}
              {activeTab === 'recommend' && (
                <div className="space-y-4">
                  {/* Distance input + quick distances */}
                  <div className="flex gap-3">
                    <input
                      type="number"
                      value={distanceToPin ?? ''}
                      onChange={(e) => setDistanceToPin(e.target.value ? Number(e.target.value) : null)}
                      placeholder="Yards to pin"
                      className="flex-1 px-4 py-4 rounded-xl bg-zinc-800 border border-zinc-700 text-white text-xl font-bold text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none placeholder:text-zinc-600 placeholder:font-normal placeholder:text-base"
                    />
                    <button
                      onClick={getRecommendation}
                      disabled={loading}
                      className="px-5 py-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-sm flex items-center gap-2"
                    >
                      {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Target className="w-5 h-5" />}
                      {loading ? '' : 'Go'}
                    </button>
                  </div>

                  {/* Quick distances */}
                  <div className="flex gap-2">
                    {[75, 100, 125, 150, 175, 200].map((d) => (
                      <button
                        key={d}
                        onClick={() => setDistanceToPin(d)}
                        className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                          distanceToPin === d ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-500'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>

                  {/* Error */}
                  {error && (
                    <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-sm text-red-400">
                      {error}
                    </div>
                  )}

                  {/* Recommendation card */}
                  {recommendation && (
                    <div className="space-y-3">
                      {/* Main recommendation */}
                      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="text-3xl font-bold text-emerald-400 uppercase">
                              {clubDisplayName(recommendation.club)}
                            </div>
                            <div className="text-sm text-zinc-400">
                              {recommendation.target_yards}y
                              {recommendation.raw_yards !== recommendation.target_yards && (
                                <span className="text-zinc-600 ml-1">(raw {recommendation.raw_yards}y)</span>
                              )}
                            </div>
                          </div>
                          <div className={`text-sm font-medium ${confidenceColor(recommendation.confidence)}`}>
                            {Math.round(recommendation.confidence * 100)}%
                          </div>
                        </div>

                        {/* Personality advice */}
                        {recommendation.personality_advice && (
                          <p className="text-sm text-emerald-300/80 italic mb-2">
                            &ldquo;{recommendation.personality_advice}&rdquo;
                          </p>
                        )}

                        {/* Reasoning */}
                        <div className="space-y-1">
                          {recommendation.reasoning.map((r, i) => (
                            <p key={i} className="text-xs text-zinc-400 flex items-start gap-2">
                              <TrendingUp className="w-3 h-3 mt-0.5 shrink-0 text-emerald-500/60" />
                              <span>{r}</span>
                            </p>
                          ))}
                        </div>
                      </div>

                      {/* Aim point + miss side */}
                      <div className="grid grid-cols-2 gap-3">
                        {/* Aim point */}
                        <div className="bg-zinc-800/50 rounded-xl p-3">
                          <div className="flex items-center gap-2 mb-2">
                            <Compass className="w-4 h-4 text-sky-400" />
                            <span className="text-xs font-medium text-sky-400">Aim Point</span>
                          </div>
                          <p className="text-sm text-zinc-300">{recommendation.aim_point.description}</p>
                        </div>
                        {/* Miss side */}
                        <div className="bg-zinc-800/50 rounded-xl p-3">
                          <div className="flex items-center gap-2 mb-2">
                            <AlertTriangle className="w-4 h-4 text-amber-400" />
                            <span className="text-xs font-medium text-amber-400">Miss Side</span>
                          </div>
                          <p className="text-sm text-zinc-300">Prefer: {recommendation.miss_side.preferred}</p>
                          <p className="text-xs text-red-400/60 mt-1">Avoid: {recommendation.miss_side.avoid}</p>
                        </div>
                      </div>

                      {/* Adjustments */}
                      {recommendation.adjustments.length > 0 && (
                        <div className="bg-zinc-800/50 rounded-xl p-3">
                          <div className="text-xs font-medium text-zinc-500 mb-2">Adjustments</div>
                          <div className="space-y-1">
                            {recommendation.adjustments.map((adj, i) => (
                              <div key={i} className="flex justify-between text-xs">
                                <span className="text-zinc-400">{adj.description}</span>
                                <span className={adj.yards > 0 ? 'text-red-400' : 'text-emerald-400'}>
                                  {adj.yards > 0 ? '+' : ''}{adj.yards}y
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Pin traffic light + aggressiveness */}
                      <div className="flex items-center gap-4 text-xs text-zinc-500">
                        {holeIntel && (
                          <div className="flex items-center gap-1.5">
                            <div className={`w-2.5 h-2.5 rounded-full ${trafficColor(holeIntel.pin_traffic_light)}`} />
                            <span>Pin: {holeIntel.pin_traffic_light}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-1.5">
                          <span>Strategy: {recommendation.aggressiveness}</span>
                        </div>
                        {recommendation.expected_score != null && (
                          <div className="flex items-center gap-1.5">
                            <span>Exp: {recommendation.expected_score.toFixed(1)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Hole details + club reference (when no recommendation yet) */}
                  {!recommendation && (
                    <div className="space-y-4">
                      <div className="bg-zinc-800/50 rounded-xl p-4">
                        <h3 className="text-sm font-medium text-zinc-400 mb-3">Hole {currentHole}</h3>
                        <div className="grid grid-cols-3 gap-3 text-center">
                          <div>
                            <div className="text-2xl font-bold text-white">{hole.par}</div>
                            <div className="text-xs text-zinc-500">Par</div>
                          </div>
                          <div>
                            <div className="text-2xl font-bold text-white">{hole.yards}</div>
                            <div className="text-xs text-zinc-500">Yards</div>
                          </div>
                          <div>
                            <div className="text-2xl font-bold text-white">#{hole.handicap}</div>
                            <div className="text-xs text-zinc-500">HCP</div>
                          </div>
                        </div>
                      </div>

                      {/* Club reference grid */}
                      <div className="bg-zinc-800/50 rounded-xl p-4">
                        <h3 className="text-sm font-medium text-zinc-400 mb-3">Your Clubs</h3>
                        <div className="grid grid-cols-4 gap-2 text-center text-xs">
                          {Object.entries(clubDistances).slice(0, 12).map(([club, dist]) => (
                            <div
                              key={club}
                              className={`rounded-lg py-2 ${
                                suggestion && suggestion.club === club
                                  ? 'bg-emerald-500/20 border border-emerald-500/30'
                                  : 'bg-zinc-700/50'
                              }`}
                            >
                              <div className={`font-medium uppercase ${suggestion?.club === club ? 'text-emerald-400' : 'text-zinc-300'}`}>
                                {clubDisplayName(club)}
                              </div>
                              <div className="text-zinc-500">{dist}y</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* VOICE TAB */}
              {activeTab === 'voice' && (
                <div className="flex flex-col" style={{ height: 'calc(75vh - 140px)' }}>
                  {/* Quick questions */}
                  <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
                    {['What club?', 'Where to miss?', 'Read this putt', 'Course strategy'].map(q => (
                      <button
                        key={q}
                        onClick={() => sendVoiceMessage(q)}
                        disabled={voiceLoading}
                        className="whitespace-nowrap px-3 py-1.5 rounded-full bg-zinc-800 text-xs text-zinc-400 hover:text-white hover:bg-zinc-700 disabled:opacity-50 shrink-0"
                      >
                        {q}
                      </button>
                    ))}
                  </div>

                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto space-y-3 mb-3 min-h-0">
                    {voiceMessages.length === 0 && (
                      <div className="text-center text-zinc-600 text-sm py-8">
                        <span className="text-3xl block mb-2">{personality.avatar}</span>
                        Ask {personality.name} anything about your game
                      </div>
                    )}
                    {voiceMessages.map((msg, i) => (
                      <div
                        key={i}
                        className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${
                          msg.role === 'user'
                            ? 'bg-emerald-600/30 text-emerald-200'
                            : 'bg-zinc-800 text-zinc-300'
                        }`}>
                          {msg.role === 'assistant' && (
                            <span className="text-xs text-zinc-500 block mb-1">{personality.avatar} {personality.name}</span>
                          )}
                          {msg.content}
                        </div>
                      </div>
                    ))}
                    {voiceLoading && (
                      <div className="flex justify-start">
                        <div className="bg-zinc-800 rounded-xl px-4 py-3">
                          <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Voice input bar */}
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={voiceInput}
                      onChange={(e) => setVoiceInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && voiceInput.trim()) {
                          sendVoiceMessage(voiceInput.trim());
                        }
                      }}
                      placeholder={`Ask ${personality.name}...`}
                      className="flex-1 px-4 py-3 rounded-xl bg-zinc-800 border border-zinc-700 text-white text-sm placeholder:text-zinc-600"
                    />
                    <button
                      onClick={isListening ? stopListening : startListening}
                      className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${
                        isListening
                          ? 'bg-red-500 animate-pulse'
                          : 'bg-emerald-600 hover:bg-emerald-500'
                      }`}
                    >
                      {isListening ? <MicOff className="w-5 h-5 text-white" /> : <Mic className="w-5 h-5 text-white" />}
                    </button>
                    {isSpeaking && (
                      <button
                        onClick={() => window.speechSynthesis.cancel()}
                        className="w-12 h-12 rounded-full bg-sky-600 flex items-center justify-center shrink-0 animate-pulse"
                      >
                        <Volume2 className="w-5 h-5 text-white" />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
