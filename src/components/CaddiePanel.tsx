'use client';

import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Wind,
  Locate,
  Flag,
  ChevronUp,
  ChevronDown,
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

export default function CaddiePanel({ round, currentHole, onHoleChange, onClose }: CaddiePanelProps) {
  const [distanceToPin, setDistanceToPin] = useState<number | null>(null);
  const [windDirection, setWindDirection] = useState<'headwind' | 'tailwind' | 'crosswind' | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

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

  // Generate caddie advice
  const getCaddieAdvice = (): string | null => {
    if (!distanceToPin) return null;
    
    if (windDirection === 'headwind') return "Club up for the wind";
    if (windDirection === 'tailwind') return "Take less club, it'll fly";
    if (windDirection === 'crosswind') return "Aim into the wind";
    if (distanceToPin <= 100) return "Smooth tempo, let the club do the work";
    if (distanceToPin >= 200) return "Full swing, trust your line";
    if (hole.par === 3) return "Par 3 — aim for the fat part of the green";
    if (hole.par === 5 && distanceToPin > 220) return "Lay up to your favorite wedge number";
    if (distanceToPin >= 150 && distanceToPin <= 170) return "Stock shot distance — commit to it";
    
    return null;
  };

  const suggestion = distanceToPin ? getSuggestedClub(distanceToPin) : null;
  const caddieAdvice = getCaddieAdvice();

  return (
    <div className="relative h-full flex flex-col bg-black">
      {/* MAP AREA */}
      <div 
        className="bg-gradient-to-b from-emerald-950 to-zinc-950 relative"
        style={{ height: isExpanded ? '35%' : '60%', transition: 'height 0.3s ease-out' }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white text-lg"
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
        <button
          onClick={handleGetLocation}
          disabled={gpsLoading}
          className="absolute top-20 right-4 z-10 bg-emerald-500/20 backdrop-blur-sm border border-emerald-500/30 rounded-xl px-3 py-2 flex items-center gap-2 text-emerald-400 disabled:opacity-50"
        >
          <Locate className={`w-5 h-5 ${gpsLoading ? 'animate-pulse' : ''}`} />
        </button>

        {/* Map placeholder */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="relative w-40 h-56 mx-auto">
              <div className="absolute inset-x-6 top-16 bottom-0 bg-emerald-800/30 rounded-t-full" />
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-20 h-20 bg-emerald-600/40 rounded-full" />
              <div className="absolute top-6 left-1/2 -translate-x-1/2">
                <Flag className="w-6 h-6 text-red-400" />
              </div>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-4 h-4 bg-white/50 rounded-full" />
            </div>
            <p className="text-emerald-500/50 text-xs mt-2">Course map coming soon</p>
          </div>
        </div>

        {/* Distance on map */}
        {distanceToPin && !isExpanded && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm rounded-full px-5 py-2 z-10">
            <span className="text-2xl font-bold text-white">{distanceToPin}</span>
            <span className="text-zinc-400 ml-1 text-sm">yds</span>
          </div>
        )}
      </div>

      {/* BOTTOM SHEET */}
      <div 
        className="flex-1 bg-zinc-900 rounded-t-2xl border-t border-zinc-800 flex flex-col overflow-hidden"
      >
        {/* Pull tab - tap to expand/collapse */}
        <button 
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full py-3 flex flex-col items-center gap-1 shrink-0"
        >
          <div className="w-12 h-1.5 rounded-full bg-zinc-600" />
          <div className="flex items-center gap-1 text-zinc-500 text-xs mt-1">
            {isExpanded ? (
              <>
                <ChevronDown className="w-4 h-4" />
                <span>Less</span>
              </>
            ) : (
              <>
                <ChevronUp className="w-4 h-4" />
                <span>More options</span>
              </>
            )}
          </div>
        </button>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-4 pb-6">
          <div className="space-y-4">
            {/* Distance + Club */}
            <div className="flex gap-3">
              <input
                type="number"
                value={distanceToPin ?? ''}
                onChange={(e) => setDistanceToPin(e.target.value ? Number(e.target.value) : null)}
                placeholder="Yards to pin"
                className="flex-1 px-4 py-4 rounded-xl bg-zinc-800 border border-zinc-700 text-white text-xl font-bold text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none placeholder:text-zinc-600 placeholder:font-normal placeholder:text-base"
              />
              {suggestion && (
                <div className="px-6 py-4 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-center min-w-[110px]">
                  <div className="text-xl font-bold text-emerald-400 uppercase">
                    {suggestion.club.replace(/(\d)/, ' $1')}
                  </div>
                  <div className="text-xs text-emerald-400/60">{suggestion.yards}y</div>
                </div>
              )}
            </div>

            {/* Caddie advice */}
            {caddieAdvice && (
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">
                <p className="text-sm text-emerald-300">🏌️ {caddieAdvice}</p>
              </div>
            )}

            {/* Quick distances */}
            <div className="flex gap-2">
              {[75, 100, 125, 150, 175, 200].map((d) => (
                <button
                  key={d}
                  onClick={() => setDistanceToPin(d)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                    distanceToPin === d
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>

            {/* Wind adjustment */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Wind className="w-4 h-4 text-zinc-500" />
                <span className="text-sm text-zinc-500">Wind Adjustment</span>
              </div>
              <div className="flex gap-2">
                {[
                  { value: 'headwind', label: '↓ Into Wind', adjust: '+1 club' },
                  { value: 'tailwind', label: '↑ Downwind', adjust: '-1 club' },
                  { value: 'crosswind', label: '↔ Crosswind', adjust: 'Aim off' },
                ].map((w) => (
                  <button
                    key={w.value}
                    onClick={() => setWindDirection(windDirection === w.value ? null : (w.value as typeof windDirection))}
                    className={`flex-1 py-3 px-2 rounded-xl text-sm transition-all ${
                      windDirection === w.value
                        ? 'bg-sky-500/20 border border-sky-500/30 text-sky-300'
                        : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    <div className="font-medium">{w.label}</div>
                    <div className="text-xs opacity-60 mt-0.5">{w.adjust}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Expanded content - more details */}
            <AnimatePresence>
              {isExpanded && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-4 overflow-hidden"
                >
                  {/* Hole details */}
                  <div className="bg-zinc-800/50 rounded-xl p-4">
                    <h3 className="text-sm font-medium text-zinc-400 mb-3">Hole {currentHole} Details</h3>
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
                        <div className="text-xs text-zinc-500">Handicap</div>
                      </div>
                    </div>
                  </div>

                  {/* Strategy placeholder */}
                  <div className="bg-zinc-800/50 rounded-xl p-4">
                    <h3 className="text-sm font-medium text-zinc-400 mb-2">Strategy</h3>
                    <p className="text-sm text-zinc-300">
                      {hole.par === 3 
                        ? "Take dead aim at the center of the green. Club selection is everything on par 3s."
                        : hole.par === 5
                        ? "Think backwards from the green. Where do you want your approach shot from?"
                        : "Find the fairway first. Position A is better than distance from the rough."
                      }
                    </p>
                  </div>

                  {/* Club distances reference */}
                  <div className="bg-zinc-800/50 rounded-xl p-4">
                    <h3 className="text-sm font-medium text-zinc-400 mb-3">Your Clubs</h3>
                    <div className="grid grid-cols-4 gap-2 text-center text-xs">
                      {Object.entries(defaultClubDistances).slice(0, 8).map(([club, dist]) => (
                        <div key={club} className="bg-zinc-700/50 rounded-lg py-2">
                          <div className="font-medium text-zinc-300 uppercase">{club}</div>
                          <div className="text-zinc-500">{dist}y</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
