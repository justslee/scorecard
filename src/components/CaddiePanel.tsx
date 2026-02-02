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

// Sheet states: collapsed (just handle) or expanded (all content)
type SheetState = 'collapsed' | 'expanded';

export default function CaddiePanel({ round, currentHole, onHoleChange, onClose }: CaddiePanelProps) {
  const [distanceToPin, setDistanceToPin] = useState<number | null>(null);
  const [windDirection, setWindDirection] = useState<'headwind' | 'tailwind' | 'crosswind' | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [sheetState, setSheetState] = useState<SheetState>('collapsed');
  const [slideDirection, setSlideDirection] = useState<'left' | 'right'>('left');
  const containerRef = useRef<HTMLDivElement>(null);
  const prevHoleRef = useRef(currentHole);

  const hole = getHoleInfo(round, currentHole);

  // Track slide direction when hole changes
  if (prevHoleRef.current !== currentHole) {
    setSlideDirection(currentHole > prevHoleRef.current ? 'left' : 'right');
    prevHoleRef.current = currentHole;
  }

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

  // Comprehensive caddie advice based on hole knowledge
  const getCaddieAdvice = (): { main: string; details: string[] } => {
    const advice: string[] = [];
    let mainTip = "";

    // Par-specific strategy
    if (hole.par === 3) {
      mainTip = "🎯 Par 3 — Club selection is everything";
      advice.push("Take one extra club, most miss short");
      advice.push("Aim for the center of the green, not the pin");
      if (hole.yards > 180) advice.push("Long par 3 — consider laying up short of trouble");
    } else if (hole.par === 4) {
      if (hole.yards < 350) {
        mainTip = "📍 Short Par 4 — Position over power";
        advice.push("Consider 3-wood or hybrid off the tee");
        advice.push("Leave yourself a full wedge in");
      } else if (hole.yards > 430) {
        mainTip = "💪 Long Par 4 — Two good shots needed";
        advice.push("Driver to maximize distance");
        advice.push("Don't force the green, bogey is okay");
      } else {
        mainTip = "⛳ Standard Par 4 — Find the fairway";
        advice.push("Fairway first, then attack");
      }
    } else if (hole.par === 5) {
      mainTip = "📐 Par 5 — Think backwards from the green";
      advice.push("Where's your ideal 3rd shot from?");
      if (hole.yards < 500) {
        advice.push("Reachable in 2 — go for it if the lie is good");
      } else {
        advice.push("Lay up to your favorite wedge distance");
      }
      advice.push("Par is a good score, birdie is a bonus");
    }

    // Distance-specific tips
    if (distanceToPin) {
      if (distanceToPin <= 50) {
        advice.push("Inside 50 — soft hands, let gravity work");
      } else if (distanceToPin <= 100) {
        advice.push("Scoring zone — smooth tempo, commit to distance");
      } else if (distanceToPin >= 150 && distanceToPin <= 170) {
        advice.push("Stock yardage — trust your swing");
      } else if (distanceToPin >= 200) {
        advice.push("Long approach — aim for the fat part of the green");
      }
    }

    // Wind adjustments
    if (windDirection === 'headwind') {
      advice.push("Into wind: Take 1-2 more clubs, swing smooth");
    } else if (windDirection === 'tailwind') {
      advice.push("Downwind: Ball will fly further and release more");
    } else if (windDirection === 'crosswind') {
      advice.push("Crosswind: Aim into the wind, let it bring it back");
    }

    // Handicap-based difficulty
    if (hole.handicap <= 3) {
      advice.push("⚠️ Tough hole (#" + hole.handicap + " handicap) — par is a WIN here");
    } else if (hole.handicap >= 16) {
      advice.push("✨ Birdie opportunity (#" + hole.handicap + " handicap) — be aggressive");
    }

    return { main: mainTip || "🏌️ Play smart, commit to your shot", details: advice };
  };

  // Handle swipe on map - down to dismiss, left/right for holes
  const handleMapDragEnd = (_: any, info: PanInfo) => {
    const { offset, velocity } = info;
    
    // Swipe down to dismiss
    if (offset.y > 100 || velocity.y > 500) {
      onClose();
      return;
    }
    
    // Swipe left for next hole
    if (offset.x < -50 || velocity.x < -300) {
      if (currentHole < 18) {
        onHoleChange(currentHole + 1);
      }
      return;
    }
    
    // Swipe right for previous hole
    if (offset.x > 50 || velocity.x > 300) {
      if (currentHole > 1) {
        onHoleChange(currentHole - 1);
      }
    }
  };

  // Handle sheet drag - simple toggle
  const handleSheetDragEnd = (_: any, info: PanInfo) => {
    const velocity = info.velocity.y;
    const offset = info.offset.y;

    if (velocity < -200 || offset < -30) {
      // Swiping up - expand
      setSheetState('expanded');
    } else if (velocity > 200 || offset > 30) {
      // Swiping down - collapse
      setSheetState('collapsed');
    }
  };

  const sheetHeights: Record<SheetState, string> = {
    collapsed: '70px',
    expanded: '70%',
  };

  const suggestion = distanceToPin ? getSuggestedClub(distanceToPin) : null;
  const caddieAdvice = getCaddieAdvice();

  return (
    <div ref={containerRef} className="relative h-full flex flex-col bg-black overscroll-none">
      {/* MAP AREA - Swipe down to dismiss, left/right for holes */}
      <motion.div 
        className="flex-1 bg-gradient-to-b from-emerald-950 to-zinc-950 relative"
        drag
        dragConstraints={{ top: 0, bottom: 0, left: 0, right: 0 }}
        dragElastic={{ top: 0, bottom: 0.5, left: 0.3, right: 0.3 }}
        onDragEnd={handleMapDragEnd}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center text-white text-lg"
        >
          ✕
        </button>

        {/* Hole info - animated */}
        <div className="absolute top-4 left-4 z-10">
          <AnimatePresence mode="wait">
            <motion.div 
              key={currentHole}
              initial={{ opacity: 0, x: slideDirection === 'left' ? 20 : -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: slideDirection === 'left' ? -20 : 20 }}
              transition={{ duration: 0.2 }}
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
          className="absolute top-20 right-4 z-10 bg-emerald-500/20 backdrop-blur-sm border border-emerald-500/30 rounded-xl px-3 py-2 flex items-center gap-2 text-emerald-400 disabled:opacity-50"
        >
          <Locate className={`w-5 h-5 ${gpsLoading ? 'animate-pulse' : ''}`} />
        </button>

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

        {/* Map placeholder - animated */}
        <AnimatePresence mode="wait">
          <motion.div 
            key={currentHole}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
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
          {Array.from({ length: currentHole <= 9 ? 9 : 9 }, (_, i) => {
            const holeNum = currentHole <= 9 ? i + 1 : i + 10;
            return (
              <button
                key={holeNum}
                onClick={() => onHoleChange(holeNum)}
                className={`w-2 h-2 rounded-full transition-all ${
                  holeNum === currentHole 
                    ? 'bg-emerald-400 w-4' 
                    : 'bg-zinc-600 hover:bg-zinc-500'
                }`}
              />
            );
          })}
        </div>

        {/* Swipe hints */}
        <p className="absolute bottom-12 left-1/2 -translate-x-1/2 text-zinc-600 text-xs">
          ← swipe for holes • down to close →
        </p>

        {/* Distance overlay */}
        {distanceToPin && sheetState === 'collapsed' && (
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
          <div className="flex items-center gap-1 text-zinc-500 text-xs mt-2">
            <ChevronUp className={`w-4 h-4 transition-transform ${sheetState === 'expanded' ? 'rotate-180' : ''}`} />
            <span>{sheetState === 'collapsed' ? 'Pull up for caddie' : 'Pull down to close'}</span>
          </div>
        </div>

        {/* Sheet content - only show when not peek */}
        <AnimatePresence>
          {sheetState === 'expanded' && (
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

                {/* Caddie Strategy */}
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">
                  <p className="text-base font-medium text-emerald-300">{caddieAdvice.main}</p>
                  {caddieAdvice.details.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {caddieAdvice.details.map((tip, i) => (
                        <li key={i} className="text-sm text-emerald-400/80 flex items-start gap-2">
                          <span className="text-emerald-500/60">•</span>
                          <span>{tip}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

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
                {/* Additional details */}
                <div className="space-y-4 pt-2">
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

                    {/* Course Knowledge */}
                    <div className="bg-zinc-800/50 rounded-xl p-4">
                      <h3 className="text-sm font-medium text-zinc-400 mb-2">Course Knowledge</h3>
                      <p className="text-sm text-zinc-300 mb-3">
                        {hole.par === 3 
                          ? "Par 3s are all about club selection. Trust the number, not the ego. Most amateurs miss short — take one more club."
                          : hole.par === 5
                          ? "Par 5s reward smart course management. Know your distances, pick your targets, and don't force shots you don't have."
                          : hole.yards < 380 
                          ? "Shorter par 4s tempt you to bomb driver. Often better to place it in the fairway with a 3-wood and attack from there."
                          : "Long par 4s demand two quality shots. Accept that and play accordingly — a stress-free bogey beats a blow-up hole."
                        }
                      </p>
                      <div className="text-xs text-zinc-500 italic">
                        💡 Tip: Course-specific knowledge will improve as you play more rounds here.
                      </div>
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
                  </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
