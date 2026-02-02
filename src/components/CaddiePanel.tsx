'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Target,
  Wind,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Minus,
  Plus,
  Navigation,
  Locate,
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

interface HoleInfo {
  number: number;
  par: number;
  yards: number;
  handicap: number;
  hazards: string[];
  dogleg: 'left' | 'right' | null;
}

interface HoleStats {
  fairwayHit: boolean | null;
  gir: boolean | null;
  putts: number | null;
  penalties: number;
}

interface CaddiePanelProps {
  round: Round;
  currentHole: number;
  onHoleChange: (hole: number) => void;
}

// Generate hole info from round data or use defaults
function getHoleInfo(round: Round, holeNumber: number): HoleInfo {
  // Check if round has hole data from API
  const holeData = round.holes?.[holeNumber - 1];
  
  if (holeData) {
    return {
      number: holeNumber,
      par: holeData.par,
      yards: holeData.yards || holeData.distance || 400,
      handicap: holeData.handicap || holeNumber,
      hazards: holeData.hazards || [],
      dogleg: holeData.dogleg || null,
    };
  }

  // Default mock data if no hole info available
  const defaultPars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5];
  const defaultYards = [385, 410, 175, 520, 395, 365, 195, 430, 545, 400, 165, 425, 510, 380, 405, 185, 440, 530];
  
  return {
    number: holeNumber,
    par: defaultPars[holeNumber - 1] || 4,
    yards: defaultYards[holeNumber - 1] || 400,
    handicap: holeNumber,
    hazards: [],
    dogleg: null,
  };
}

export default function CaddiePanel({ round, currentHole, onHoleChange }: CaddiePanelProps) {
  const [holeStats, setHoleStats] = useState<Record<number, HoleStats>>({});
  const [distanceToPin, setDistanceToPin] = useState<number | null>(null);
  const [clubDistances] = useState(defaultClubDistances);
  const [windDirection, setWindDirection] = useState<'headwind' | 'tailwind' | 'crosswind' | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  const hole = getHoleInfo(round, currentHole);
  const stats = holeStats[currentHole] || { fairwayHit: null, gir: null, putts: null, penalties: 0 };

  // Calculate suggested club based on distance
  const getSuggestedClub = (distance: number): string => {
    // Adjust for wind
    let adjustedDistance = distance;
    if (windDirection === 'headwind') adjustedDistance += 10;
    if (windDirection === 'tailwind') adjustedDistance -= 10;

    const clubs = Object.entries(clubDistances).sort((a, b) => b[1] - a[1]);
    for (const [club, dist] of clubs) {
      if (dist <= adjustedDistance + 5) {
        return club;
      }
    }
    return 'lw';
  };

  const updateStats = (updates: Partial<HoleStats>) => {
    setHoleStats((prev) => ({
      ...prev,
      [currentHole]: { ...stats, ...updates },
    }));
  };

  // Get GPS location
  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      alert('GPS not supported on this device');
      return;
    }

    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setGpsLoading(false);
        // TODO: Calculate distance to pin using course coordinates
        // For now, just show that we got the location
      },
      (error) => {
        console.error('GPS error:', error);
        setGpsLoading(false);
        alert('Could not get location. Please enter distance manually.');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Get recommendations based on hole info
  const getRecommendations = (): string[] => {
    const recs: string[] = [];

    if (hole.hazards.includes('water')) {
      recs.push('⚠️ Water in play — favor the safe side');
    }
    if (hole.hazards.includes('bunker')) {
      recs.push('🏖️ Bunkers guarding approach — club up if in doubt');
    }
    if (hole.dogleg === 'right') {
      recs.push('↗️ Dogleg right — aim left side of fairway');
    }
    if (hole.dogleg === 'left') {
      recs.push('↖️ Dogleg left — aim right side of fairway');
    }
    if (hole.par === 3) {
      recs.push('🎯 Par 3 — commit to your club selection');
    }
    if (hole.par === 5 && distanceToPin && distanceToPin > 200) {
      recs.push('📐 Par 5 — plan your layup for a full wedge in');
    }
    if (hole.handicap <= 3) {
      recs.push('💪 Tough hole — par is a good score here');
    }
    if (windDirection === 'headwind') {
      recs.push('🌬️ Into the wind — take one more club');
    }
    if (windDirection === 'tailwind') {
      recs.push('🌬️ Downwind — take one less club');
    }

    return recs;
  };

  const suggestedClub = distanceToPin ? getSuggestedClub(distanceToPin) : null;
  const recommendations = getRecommendations();

  // Calculate round stats
  const roundStats = {
    fir: {
      hit: Object.values(holeStats).filter((s) => s.fairwayHit === true).length,
      total: Object.values(holeStats).filter((s) => s.fairwayHit !== null).length,
    },
    gir: {
      hit: Object.values(holeStats).filter((s) => s.gir === true).length,
      total: Object.values(holeStats).filter((s) => s.gir !== null).length,
    },
    putts: Object.values(holeStats).reduce((sum, s) => sum + (s.putts ?? 0), 0),
    penalties: Object.values(holeStats).reduce((sum, s) => sum + s.penalties, 0),
  };

  return (
    <div className="space-y-4">
      {/* Hole Info Header */}
      <div className="text-center py-2">
        <div className="flex items-center justify-center gap-3 text-sm text-zinc-400">
          <span>Par {hole.par}</span>
          <span className="text-zinc-600">•</span>
          <span>{hole.yards} yds</span>
          <span className="text-zinc-600">•</span>
          <span className="text-zinc-500">HCP {hole.handicap}</span>
        </div>
      </div>

      {/* Distance Input & Club Suggestion */}
      <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Target className="w-5 h-5 text-emerald-400" />
              <span className="font-semibold text-white">Shot Planner</span>
            </div>
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={handleGetLocation}
              disabled={gpsLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 text-sm hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
            >
              <Locate className={`w-4 h-4 ${gpsLoading ? 'animate-pulse' : ''}`} />
              {gpsLoading ? 'Locating...' : 'GPS'}
            </motion.button>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-zinc-500 block mb-1">Distance to Pin (yds)</label>
              <input
                type="number"
                value={distanceToPin ?? ''}
                onChange={(e) => setDistanceToPin(e.target.value ? Number(e.target.value) : null)}
                placeholder="Enter distance"
                className="w-full px-4 py-3 rounded-xl bg-zinc-800 border border-zinc-700 text-white text-lg font-semibold text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>

            <AnimatePresence mode="wait">
              {distanceToPin && suggestedClub && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, x: 10 }}
                  animate={{ opacity: 1, scale: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.9, x: 10 }}
                  className="flex-1"
                >
                  <label className="text-xs text-zinc-500 block mb-1">Suggested Club</label>
                  <div className="px-4 py-3 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-center">
                    <span className="text-lg font-bold text-emerald-400 uppercase">
                      {suggestedClub.replace(/(\d)/, ' $1')}
                    </span>
                    <span className="text-xs text-emerald-400/60 block">{clubDistances[suggestedClub]} yds</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Quick distance buttons */}
          <div className="flex gap-2 mt-3">
            {[75, 100, 125, 150, 175].map((d) => (
              <button
                key={d}
                onClick={() => setDistanceToPin(d)}
                className={`flex-1 py-2 rounded-lg text-sm transition-colors ${
                  distanceToPin === d
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Wind */}
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center gap-2 mb-3">
            <Wind className="w-4 h-4 text-zinc-400" />
            <span className="text-sm text-zinc-400">Wind Adjustment</span>
          </div>
          <div className="flex gap-2">
            {[
              { value: 'headwind', label: '↓ Head', adjust: '+1 club' },
              { value: 'tailwind', label: '↑ Tail', adjust: '-1 club' },
              { value: 'crosswind', label: '← → Cross', adjust: 'Aim off' },
            ].map((w) => (
              <button
                key={w.value}
                onClick={() => setWindDirection(windDirection === w.value ? null : (w.value as typeof windDirection))}
                className={`flex-1 py-2 px-3 rounded-xl text-sm transition-all ${
                  windDirection === w.value
                    ? 'bg-sky-500/20 border border-sky-500/30 text-sky-300'
                    : 'bg-zinc-800 border border-transparent text-zinc-400 hover:text-white'
                }`}
              >
                <div className="font-medium">{w.label}</div>
                <div className="text-xs opacity-60">{w.adjust}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Recommendations */}
        {recommendations.length > 0 && (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <span className="text-sm text-zinc-400">Caddie Tips</span>
            </div>
            <div className="space-y-2">
              {recommendations.map((rec, i) => (
                <div key={i} className="text-sm text-zinc-300 bg-zinc-800/50 rounded-lg px-3 py-2">
                  {rec}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Quick Stats Input */}
      <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800">
          <span className="font-semibold text-white">Hole {currentHole} Stats</span>
        </div>

        <div className="p-4 space-y-4">
          {/* Fairway Hit (only for par 4/5) */}
          {hole.par > 3 && (
            <div className="flex items-center justify-between">
              <span className="text-zinc-300">Fairway Hit</span>
              <div className="flex gap-2">
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => updateStats({ fairwayHit: stats.fairwayHit === true ? null : true })}
                  className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${
                    stats.fairwayHit === true
                      ? 'bg-emerald-500/20 border-2 border-emerald-500 text-emerald-400'
                      : 'bg-zinc-800 border-2 border-transparent text-zinc-500'
                  }`}
                >
                  <CheckCircle className="w-5 h-5" />
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => updateStats({ fairwayHit: stats.fairwayHit === false ? null : false })}
                  className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${
                    stats.fairwayHit === false
                      ? 'bg-red-500/20 border-2 border-red-500 text-red-400'
                      : 'bg-zinc-800 border-2 border-transparent text-zinc-500'
                  }`}
                >
                  <XCircle className="w-5 h-5" />
                </motion.button>
              </div>
            </div>
          )}

          {/* GIR */}
          <div className="flex items-center justify-between">
            <span className="text-zinc-300">Green in Reg</span>
            <div className="flex gap-2">
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={() => updateStats({ gir: stats.gir === true ? null : true })}
                className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${
                  stats.gir === true
                    ? 'bg-emerald-500/20 border-2 border-emerald-500 text-emerald-400'
                    : 'bg-zinc-800 border-2 border-transparent text-zinc-500'
                }`}
              >
                <CheckCircle className="w-5 h-5" />
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={() => updateStats({ gir: stats.gir === false ? null : false })}
                className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${
                  stats.gir === false
                    ? 'bg-red-500/20 border-2 border-red-500 text-red-400'
                    : 'bg-zinc-800 border-2 border-transparent text-zinc-500'
                }`}
              >
                <XCircle className="w-5 h-5" />
              </motion.button>
            </div>
          </div>

          {/* Putts */}
          <div className="flex items-center justify-between">
            <span className="text-zinc-300">Putts</span>
            <div className="flex gap-2">
              {[1, 2, 3].map((p) => (
                <motion.button
                  key={p}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => updateStats({ putts: stats.putts === p ? null : p })}
                  className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg font-semibold transition-all ${
                    stats.putts === p
                      ? 'bg-emerald-500/20 border-2 border-emerald-500 text-emerald-400'
                      : 'bg-zinc-800 border-2 border-transparent text-zinc-400'
                  }`}
                >
                  {p}
                </motion.button>
              ))}
            </div>
          </div>

          {/* Penalties */}
          <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
            <span className="text-zinc-300">Penalties</span>
            <div className="flex items-center gap-2">
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={() => updateStats({ penalties: Math.max(0, stats.penalties - 1) })}
                className="w-9 h-9 rounded-xl bg-zinc-800 text-zinc-400 flex items-center justify-center"
              >
                <Minus className="w-4 h-4" />
              </motion.button>
              <div className="w-10 text-center">
                <span className={`text-xl font-bold ${stats.penalties > 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                  {stats.penalties}
                </span>
              </div>
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={() => updateStats({ penalties: stats.penalties + 1 })}
                className="w-9 h-9 rounded-xl bg-zinc-800 text-zinc-400 flex items-center justify-center"
              >
                <Plus className="w-4 h-4" />
              </motion.button>
            </div>
          </div>
        </div>
      </div>

      {/* Round Stats Summary */}
      {Object.keys(holeStats).length > 0 && (
        <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4">
          <div className="font-semibold text-white mb-3">Round Stats</div>
          <div className="grid grid-cols-4 gap-2">
            <div className="text-center p-2 rounded-xl bg-zinc-800/50">
              <div className="text-lg font-bold text-emerald-400">
                {roundStats.fir.total > 0 ? `${roundStats.fir.hit}/${roundStats.fir.total}` : '–'}
              </div>
              <div className="text-xs text-zinc-500">FIR</div>
            </div>
            <div className="text-center p-2 rounded-xl bg-zinc-800/50">
              <div className="text-lg font-bold text-emerald-400">
                {roundStats.gir.total > 0 ? `${roundStats.gir.hit}/${roundStats.gir.total}` : '–'}
              </div>
              <div className="text-xs text-zinc-500">GIR</div>
            </div>
            <div className="text-center p-2 rounded-xl bg-zinc-800/50">
              <div className="text-lg font-bold text-white">{roundStats.putts || '–'}</div>
              <div className="text-xs text-zinc-500">Putts</div>
            </div>
            <div className="text-center p-2 rounded-xl bg-zinc-800/50">
              <div className={`text-lg font-bold ${roundStats.penalties > 0 ? 'text-red-400' : 'text-zinc-400'}`}>
                {roundStats.penalties}
              </div>
              <div className="text-xs text-zinc-500">Pen</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
