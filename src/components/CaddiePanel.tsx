'use client';

import { useState, useRef } from 'react';
import { motion, useMotionValue, animate, PanInfo, useDragControls } from 'framer-motion';
import {
  Wind,
  Locate,
  Flag,
  ChevronUp,
} from 'lucide-react';
import { Round } from '@/lib/types';

// Default club distances (yards)
const defaultClubDistances: Record<string, number> = {
  driver: 250,
  '3wood': 230,
  '5wood': 215,
  hybrid: 200,
  '4iron': 190,
  '5iron': 180,
  '6iron': 170,
  '7iron': 160,
  '8iron': 150,
  '9iron': 140,
  pw: 130,
  gw: 115,
  sw: 100,
  lw: 85,
};

interface CaddiePanelProps {
  round: Round;
  currentHole: number;
  onHoleChange: (hole: number) => void;
  onClose: () => void;
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

const COLLAPSED_HEIGHT = 140;
const EXPANDED_HEIGHT = 320;

export default function CaddiePanel({ round, currentHole, onHoleChange, onClose }: CaddiePanelProps) {
  const [distanceToPin, setDistanceToPin] = useState<number | null>(null);
  const [windDirection, setWindDirection] = useState<'headwind' | 'tailwind' | 'crosswind' | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  
  const sheetHeight = useMotionValue(COLLAPSED_HEIGHT);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();

  const hole = getHoleInfo(round, currentHole);

  const getSuggestedClub = (distance: number): { club: string; yards: number } => {
    let adjustedDistance = distance;
    if (windDirection === 'headwind') adjustedDistance += 10;
    if (windDirection === 'tailwind') adjustedDistance -= 10;

    const clubs = Object.entries(defaultClubDistances).sort((a, b) => b[1] - a[1]);
    for (const [club, dist] of clubs) {
      if (dist <= adjustedDistance + 5) {
        return { club, yards: dist };
      }
    }
    return { club: 'lw', yards: defaultClubDistances.lw };
  };

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      alert('GPS not supported');
      return;
    }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsLoading(false);
        alert(`Location: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}\n\nGPS distance coming soon.`);
      },
      () => {
        setGpsLoading(false);
        alert('Could not get location');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleDragEnd = (_: any, info: PanInfo) => {
    const shouldExpand = info.velocity.y < -200 || (isExpanded ? info.offset.y < 50 : info.offset.y < -50);
    const targetHeight = shouldExpand ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;
    animate(sheetHeight, targetHeight, { type: 'spring', damping: 25, stiffness: 300 });
    setIsExpanded(shouldExpand);
  };

  const toggleExpand = () => {
    const targetHeight = isExpanded ? COLLAPSED_HEIGHT : EXPANDED_HEIGHT;
    animate(sheetHeight, targetHeight, { type: 'spring', damping: 25, stiffness: 300 });
    setIsExpanded(!isExpanded);
  };

  const suggestion = distanceToPin ? getSuggestedClub(distanceToPin) : null;

  // Generate caddie advice based on conditions
  const getCaddieAdvice = (): string | null => {
    if (!distanceToPin) return null;
    
    const tips: string[] = [];
    
    // Wind advice
    if (windDirection === 'headwind') {
      tips.push("Club up for the wind");
    } else if (windDirection === 'tailwind') {
      tips.push("Take less club, it'll fly");
    } else if (windDirection === 'crosswind') {
      tips.push("Aim into the wind");
    }
    
    // Distance-based advice
    if (distanceToPin <= 100) {
      tips.push("Smooth tempo, let the club do the work");
    } else if (distanceToPin >= 200) {
      tips.push("Full swing, trust your line");
    } else if (distanceToPin >= 150 && distanceToPin <= 170) {
      tips.push("Stock shot distance — commit to it");
    }
    
    // Par-based advice
    if (hole.par === 3) {
      tips.push("Par 3 — aim for the fat part of the green");
    } else if (hole.par === 5 && distanceToPin > 220) {
      tips.push("Lay up to your favorite wedge number");
    }
    
    return tips[0] || null;
  };

  const caddieAdvice = getCaddieAdvice();

  return (
    <div className="relative h-full flex flex-col bg-black">
      {/* MAP AREA - Takes all available space */}
      <div className="flex-1 bg-gradient-to-b from-emerald-950 to-zinc-950 relative">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white"
        >
          ✕
        </button>

        {/* Hole info */}
        <div className="absolute top-4 left-4 z-10">
          <div className="bg-black/50 backdrop-blur-sm rounded-xl px-4 py-2">
            <div className="text-2xl font-bold text-white">Hole {currentHole}</div>
            <div className="text-sm text-zinc-400">Par {hole.par} • {hole.yards} yds</div>
          </div>
        </div>

        {/* GPS button */}
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={handleGetLocation}
          disabled={gpsLoading}
          className="absolute top-20 right-4 z-10 bg-emerald-500/20 backdrop-blur-sm border border-emerald-500/30 rounded-xl px-3 py-2 flex items-center gap-2 text-emerald-400 disabled:opacity-50"
        >
          <Locate className={`w-5 h-5 ${gpsLoading ? 'animate-pulse' : ''}`} />
        </motion.button>

        {/* Map placeholder - fills the space */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="relative w-40 h-64 mx-auto">
              {/* Fairway */}
              <div className="absolute inset-x-6 top-16 bottom-0 bg-emerald-800/30 rounded-t-full" />
              {/* Green */}
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-20 h-20 bg-emerald-600/40 rounded-full" />
              {/* Pin */}
              <div className="absolute top-6 left-1/2 -translate-x-1/2">
                <Flag className="w-6 h-6 text-red-400" />
              </div>
              {/* Tee */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-4 h-4 bg-white/50 rounded-full" />
              {/* Distance line */}
              {distanceToPin && (
                <div className="absolute top-24 left-1/2 -translate-x-1/2 w-px h-32 bg-yellow-400/50" />
              )}
            </div>
            <p className="text-emerald-500/50 text-xs mt-4">Course map coming soon</p>
          </div>
        </div>

        {/* Distance overlay on map */}
        {distanceToPin && (
          <div className="absolute bottom-36 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm rounded-full px-5 py-2 z-10">
            <span className="text-2xl font-bold text-white">{distanceToPin}</span>
            <span className="text-zinc-400 ml-1 text-sm">yds</span>
          </div>
        )}
      </div>

      {/* BOTTOM SHEET - Draggable via handle only */}
      <motion.div
        ref={sheetRef}
        style={{ height: sheetHeight }}
        drag="y"
        dragControls={dragControls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.1, bottom: 0.1 }}
        onDragEnd={handleDragEnd}
        className="absolute bottom-0 left-0 right-0 bg-zinc-900 rounded-t-2xl border-t border-zinc-800 overflow-hidden"
      >
        {/* Drag handle - only this initiates drag */}
        <div 
          onPointerDown={(e) => dragControls.start(e)}
          onClick={toggleExpand}
          className="w-full py-2 flex flex-col items-center gap-1 cursor-grab active:cursor-grabbing touch-none"
        >
          <div className="w-10 h-1 rounded-full bg-zinc-600" />
          <ChevronUp className={`w-4 h-4 text-zinc-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
        </div>

        {/* Sheet content */}
        <div className="px-4 pb-4 space-y-3">
          {/* Distance + Club - Always visible */}
          <div className="flex gap-3">
            <input
              type="number"
              value={distanceToPin ?? ''}
              onChange={(e) => setDistanceToPin(e.target.value ? Number(e.target.value) : null)}
              placeholder="Yards to pin"
              className="flex-1 px-4 py-3 rounded-xl bg-zinc-800 border border-zinc-700 text-white text-lg font-bold text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none placeholder:text-zinc-600 placeholder:font-normal placeholder:text-sm"
            />
            {suggestion && (
              <div className="px-5 py-3 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-center min-w-[100px]">
                <div className="text-lg font-bold text-emerald-400 uppercase">
                  {suggestion.club.replace(/(\d)/, ' $1')}
                </div>
                <div className="text-xs text-emerald-400/60">{suggestion.yards}y</div>
              </div>
            )}
          </div>

          {/* Caddie advice - Always visible when available */}
          {caddieAdvice && (
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-3 py-2">
              <p className="text-sm text-emerald-300">🏌️ {caddieAdvice}</p>
            </div>
          )}

          {/* Quick distances - Always visible */}
          <div className="flex gap-1.5">
            {[75, 100, 125, 150, 175, 200].map((d) => (
              <button
                key={d}
                onClick={() => setDistanceToPin(d)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  distanceToPin === d
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-zinc-800 text-zinc-500'
                }`}
              >
                {d}
              </button>
            ))}
          </div>

          {/* Expanded content */}
          {isExpanded && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-3 pt-2"
            >
              {/* Wind */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Wind className="w-4 h-4 text-zinc-500" />
                  <span className="text-xs text-zinc-500 uppercase">Wind</span>
                </div>
                <div className="flex gap-2">
                  {[
                    { value: 'headwind', label: '↓ Into', adjust: '+1' },
                    { value: 'tailwind', label: '↑ Down', adjust: '-1' },
                    { value: 'crosswind', label: '↔ Cross', adjust: 'Aim' },
                  ].map((w) => (
                    <button
                      key={w.value}
                      onClick={() => setWindDirection(windDirection === w.value ? null : (w.value as typeof windDirection))}
                      className={`flex-1 py-2 px-2 rounded-xl text-sm transition-all ${
                        windDirection === w.value
                          ? 'bg-sky-500/20 border border-sky-500/30 text-sky-300'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      <div className="font-medium text-xs">{w.label}</div>
                    </button>
                  ))}
                </div>
              </div>

            </motion.div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
