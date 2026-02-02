'use client';

import { useState, useRef } from 'react';
import { motion, AnimatePresence, PanInfo } from 'framer-motion';
import {
  Wind,
  Locate,
  Flag,
  ChevronUp,
} from 'lucide-react';
import { Round } from '@/lib/types';

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

// Sheet states: peek (just handle), half (basic controls), full (all details)
type SheetState = 'peek' | 'half' | 'full';

export default function CaddiePanel({ round, currentHole, onHoleChange, onClose }: CaddiePanelProps) {
  const [distanceToPin, setDistanceToPin] = useState<number | null>(null);
  const [windDirection, setWindDirection] = useState<'headwind' | 'tailwind' | 'crosswind' | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [sheetState, setSheetState] = useState<SheetState>('peek');
  const containerRef = useRef<HTMLDivElement>(null);

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

  const getCaddieAdvice = (): string | null => {
    if (!distanceToPin) return null;
    if (windDirection === 'headwind') return "Club up for the wind";
    if (windDirection === 'tailwind') return "Take less club, it'll fly";
    if (windDirection === 'crosswind') return "Aim into the wind";
    if (distanceToPin <= 100) return "Smooth tempo, let the club do the work";
    if (distanceToPin >= 200) return "Full swing, trust your line";
    if (hole.par === 3) return "Par 3 — aim for the fat part of the green";
    if (hole.par === 5 && distanceToPin > 220) return "Lay up to your favorite wedge number";
    return null;
  };

  // Handle swipe down on map to dismiss
  const handleMapDragEnd = (_: any, info: PanInfo) => {
    if (info.offset.y > 100 || info.velocity.y > 500) {
      onClose();
    }
  };

  // Handle sheet drag
  const handleSheetDragEnd = (_: any, info: PanInfo) => {
    const velocity = info.velocity.y;
    const offset = info.offset.y;

    if (velocity < -300 || offset < -50) {
      // Swiping up
      if (sheetState === 'peek') setSheetState('half');
      else if (sheetState === 'half') setSheetState('full');
    } else if (velocity > 300 || offset > 50) {
      // Swiping down
      if (sheetState === 'full') setSheetState('half');
      else if (sheetState === 'half') setSheetState('peek');
    }
  };

  const sheetHeights: Record<SheetState, string> = {
    peek: '80px',
    half: '45%',
    full: '75%',
  };

  const suggestion = distanceToPin ? getSuggestedClub(distanceToPin) : null;
  const caddieAdvice = getCaddieAdvice();

  return (
    <div ref={containerRef} className="relative h-full flex flex-col bg-black overscroll-none">
      {/* MAP AREA - Swipe down to dismiss */}
      <motion.div 
        className="flex-1 bg-gradient-to-b from-emerald-950 to-zinc-950 relative"
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.5 }}
        onDragEnd={handleMapDragEnd}
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

        {/* Swipe hint */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
          <div className="relative w-40 h-56 mx-auto mb-4">
            <div className="absolute inset-x-6 top-16 bottom-0 bg-emerald-800/30 rounded-t-full" />
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-20 h-20 bg-emerald-600/40 rounded-full" />
            <div className="absolute top-6 left-1/2 -translate-x-1/2">
              <Flag className="w-6 h-6 text-red-400" />
            </div>
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-4 h-4 bg-white/50 rounded-full" />
          </div>
          <p className="text-zinc-500 text-xs">Swipe down to close</p>
        </div>

        {/* Distance overlay */}
        {distanceToPin && sheetState === 'peek' && (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm rounded-full px-5 py-2 z-10">
            <span className="text-2xl font-bold text-white">{distanceToPin}</span>
            <span className="text-zinc-400 ml-1 text-sm">yds</span>
            {suggestion && (
              <span className="text-emerald-400 ml-2 font-bold uppercase">{suggestion.club.replace(/(\d)/, ' $1')}</span>
            )}
          </div>
        )}
      </motion.div>

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
          {sheetState === 'peek' && (
            <div className="flex items-center gap-1 text-zinc-500 text-xs mt-2">
              <ChevronUp className="w-4 h-4" />
              <span>Pull up for caddie</span>
            </div>
          )}
        </div>

        {/* Sheet content - only show when not peek */}
        <AnimatePresence>
          {sheetState !== 'peek' && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="px-4 pb-6 overflow-y-auto overscroll-contain"
              style={{ maxHeight: 'calc(100% - 60px)' }}
            >
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

                {/* Wind - show in half and full */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Wind className="w-4 h-4 text-zinc-500" />
                    <span className="text-sm text-zinc-500">Wind</span>
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
                        className={`flex-1 py-3 px-2 rounded-xl text-sm transition-all ${
                          windDirection === w.value
                            ? 'bg-sky-500/20 border border-sky-500/30 text-sky-300'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        <div className="font-medium">{w.label}</div>
                        <div className="text-xs opacity-60">{w.adjust}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Full state - more details */}
                {sheetState === 'full' && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="space-y-4 pt-2"
                  >
                    {/* Hole details */}
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

                    {/* Strategy */}
                    <div className="bg-zinc-800/50 rounded-xl p-4">
                      <h3 className="text-sm font-medium text-zinc-400 mb-2">Strategy</h3>
                      <p className="text-sm text-zinc-300">
                        {hole.par === 3 
                          ? "Take dead aim at the center. Club selection is everything."
                          : hole.par === 5
                          ? "Think backwards. Where's your ideal approach from?"
                          : "Find the fairway first. Position beats distance."
                        }
                      </p>
                    </div>

                    {/* Club reference */}
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
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
