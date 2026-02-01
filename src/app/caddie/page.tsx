'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Home as HomeIcon, 
  Plus, 
  User, 
  Settings, 
  ChevronLeft, 
  ChevronRight,
  Target,
  Wind,
  Flag,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Minus,
  Circle,
  Navigation
} from 'lucide-react';
import { GolferProfile } from '@/lib/types';

// Mock hole data (will come from API later)
const mockHoles = Array.from({ length: 18 }, (_, i) => ({
  number: i + 1,
  par: [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5][i],
  yards: [385, 410, 175, 520, 395, 365, 195, 430, 545, 400, 165, 425, 510, 380, 405, 185, 440, 530][i],
  handicap: [7, 3, 15, 1, 11, 9, 17, 5, 13, 8, 18, 4, 2, 12, 6, 16, 10, 14][i],
  hazards: i % 3 === 0 ? ['water'] : i % 4 === 0 ? ['bunker'] : [],
  dogleg: i % 5 === 0 ? 'right' : i % 7 === 0 ? 'left' : null,
}));

// Default club distances
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

interface HoleStats {
  fairwayHit: boolean | null;
  gir: boolean | null;
  putts: number | null;
  penalties: number;
  notes: string;
}

export default function CaddiePage() {
  const [currentHole, setCurrentHole] = useState(1);
  const [holeStats, setHoleStats] = useState<Record<number, HoleStats>>({});
  const [distanceToPin, setDistanceToPin] = useState<number | null>(null);
  const [clubDistances, setClubDistances] = useState(defaultClubDistances);
  const [windDirection, setWindDirection] = useState<'headwind' | 'tailwind' | 'crosswind' | null>(null);
  const [showClubSelector, setShowClubSelector] = useState(false);
  
  const hole = mockHoles[currentHole - 1];
  const stats = holeStats[currentHole] || { fairwayHit: null, gir: null, putts: null, penalties: 0, notes: '' };

  // Calculate suggested club based on distance
  const getSuggestedClub = (distance: number): string => {
    const clubs = Object.entries(clubDistances).sort((a, b) => b[1] - a[1]);
    for (const [club, dist] of clubs) {
      if (dist <= distance + 10) {
        return club;
      }
    }
    return 'lw';
  };

  const updateStats = (updates: Partial<HoleStats>) => {
    setHoleStats(prev => ({
      ...prev,
      [currentHole]: { ...stats, ...updates }
    }));
  };

  const goToHole = (num: number) => {
    if (num >= 1 && num <= 18) {
      setCurrentHole(num);
      setDistanceToPin(null);
    }
  };

  // Get recommendation based on hole info
  const getRecommendation = () => {
    const recommendations: string[] = [];
    
    if (hole.hazards.includes('water')) {
      recommendations.push('⚠️ Water in play — favor the safe side');
    }
    if (hole.hazards.includes('bunker')) {
      recommendations.push('🏖️ Bunkers guarding approach — club up if in doubt');
    }
    if (hole.dogleg === 'right') {
      recommendations.push('↗️ Dogleg right — aim left side of fairway');
    }
    if (hole.dogleg === 'left') {
      recommendations.push('↖️ Dogleg left — aim right side of fairway');
    }
    if (hole.par === 3) {
      recommendations.push('🎯 Par 3 — commit to your club selection');
    }
    if (hole.par === 5) {
      recommendations.push('📐 Par 5 — plan your layup distance for a full wedge in');
    }
    if (hole.handicap <= 3) {
      recommendations.push('💪 Tough hole — par is a good score here');
    }
    
    return recommendations;
  };

  const suggestedClub = distanceToPin ? getSuggestedClub(distanceToPin) : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Caddie</h1>
              <span className="text-xs text-zinc-500">Your on-course assistant</span>
            </div>
            <Link href="/settings" className="btn btn-icon" aria-label="Settings">
              <Settings className="h-5 w-5" aria-hidden="true" />
            </Link>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-28">
        {/* Hole Selector */}
        <div className="flex items-center justify-between mb-6">
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => goToHole(currentHole - 1)}
            disabled={currentHole === 1}
            className={`w-12 h-12 rounded-full flex items-center justify-center ${
              currentHole > 1 ? 'bg-zinc-800 text-white' : 'bg-zinc-900 text-zinc-600'
            }`}
          >
            <ChevronLeft className="w-6 h-6" />
          </motion.button>

          <AnimatePresence mode="wait">
            <motion.div
              key={currentHole}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.15 }}
              className="text-center"
            >
              <h2 className="text-3xl font-bold text-white">Hole {currentHole}</h2>
              <div className="flex items-center justify-center gap-3 mt-1">
                <span className="text-zinc-400">Par {hole.par}</span>
                <span className="text-zinc-600">•</span>
                <span className="text-zinc-400">{hole.yards} yds</span>
                <span className="text-zinc-600">•</span>
                <span className="text-zinc-500">HCP {hole.handicap}</span>
              </div>
            </motion.div>
          </AnimatePresence>

          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => goToHole(currentHole + 1)}
            disabled={currentHole === 18}
            className={`w-12 h-12 rounded-full flex items-center justify-center ${
              currentHole < 18 ? 'bg-zinc-800 text-white' : 'bg-zinc-900 text-zinc-600'
            }`}
          >
            <ChevronRight className="w-6 h-6" />
          </motion.button>
        </div>

        {/* Hole Dots */}
        <div className="flex justify-center gap-1 mb-6">
          {mockHoles.slice(currentHole <= 9 ? 0 : 9, currentHole <= 9 ? 9 : 18).map((h) => (
            <button
              key={h.number}
              onClick={() => goToHole(h.number)}
              className={`w-3 h-3 rounded-full transition-all ${
                h.number === currentHole ? 'bg-emerald-400 scale-125' : 'bg-zinc-700 hover:bg-zinc-600'
              }`}
            />
          ))}
        </div>

        {/* Hole Visualization Placeholder */}
        <div className="rounded-2xl bg-gradient-to-b from-emerald-900/30 to-emerald-950/50 border border-emerald-800/30 p-6 mb-6 relative overflow-hidden">
          <div className="absolute inset-0 opacity-10">
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-20 h-32 bg-emerald-500 rounded-t-full" />
            <div className="absolute top-4 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-emerald-400" />
          </div>
          
          <div className="relative z-10 text-center py-8">
            <Navigation className="w-12 h-12 text-emerald-400/50 mx-auto mb-3" />
            <p className="text-emerald-300/70 text-sm">Hole map coming soon</p>
            <p className="text-emerald-400/40 text-xs mt-1">GPS integration in development</p>
          </div>

          {/* Hazard indicators */}
          {hole.hazards.length > 0 && (
            <div className="absolute top-4 right-4 flex gap-2">
              {hole.hazards.includes('water') && (
                <span className="px-2 py-1 rounded-lg bg-blue-500/20 text-blue-300 text-xs">💧 Water</span>
              )}
              {hole.hazards.includes('bunker') && (
                <span className="px-2 py-1 rounded-lg bg-amber-500/20 text-amber-300 text-xs">🏖️ Bunker</span>
              )}
            </div>
          )}
        </div>

        {/* Distance Input & Club Suggestion */}
        <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
          <div className="p-4 border-b border-zinc-800">
            <div className="flex items-center gap-2 mb-3">
              <Target className="w-5 h-5 text-emerald-400" />
              <span className="font-semibold text-white">Shot Planner</span>
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
              
              {distanceToPin && suggestedClub && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex-1"
                >
                  <label className="text-xs text-zinc-500 block mb-1">Suggested Club</label>
                  <div className="px-4 py-3 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-center">
                    <span className="text-lg font-bold text-emerald-400 uppercase">
                      {suggestedClub.replace(/(\d)/, ' $1')}
                    </span>
                    <span className="text-xs text-emerald-400/60 block">
                      {clubDistances[suggestedClub]} yds
                    </span>
                  </div>
                </motion.div>
              )}
            </div>

            {/* Quick distance buttons */}
            <div className="flex gap-2 mt-3">
              {[50, 100, 150, 200].map((d) => (
                <button
                  key={d}
                  onClick={() => setDistanceToPin(d)}
                  className="flex-1 py-2 rounded-lg bg-zinc-800 text-zinc-400 text-sm hover:bg-zinc-700 hover:text-white transition-colors"
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
                  onClick={() => setWindDirection(windDirection === w.value ? null : w.value as any)}
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
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <span className="text-sm text-zinc-400">Caddie Tips</span>
            </div>
            <div className="space-y-2">
              {getRecommendation().map((rec, i) => (
                <div key={i} className="text-sm text-zinc-300 bg-zinc-800/50 rounded-lg px-3 py-2">
                  {rec}
                </div>
              ))}
              {getRecommendation().length === 0 && (
                <div className="text-sm text-zinc-500">No specific warnings for this hole</div>
              )}
            </div>
          </div>
        </div>

        {/* Quick Stats Input */}
        <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden mb-6">
          <div className="px-4 py-3 border-b border-zinc-800">
            <span className="font-semibold text-white">Hole Stats</span>
            <span className="text-xs text-zinc-500 ml-2">Quick entry</span>
          </div>

          <div className="p-4 space-y-4">
            {/* Fairway Hit (only for par 4/5) */}
            {hole.par > 3 && (
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">Fairway Hit</span>
                <div className="flex gap-2">
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={() => updateStats({ fairwayHit: true })}
                    className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
                      stats.fairwayHit === true
                        ? 'bg-emerald-500/20 border-2 border-emerald-500 text-emerald-400'
                        : 'bg-zinc-800 border-2 border-transparent text-zinc-400'
                    }`}
                  >
                    <CheckCircle className="w-6 h-6" />
                  </motion.button>
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={() => updateStats({ fairwayHit: false })}
                    className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
                      stats.fairwayHit === false
                        ? 'bg-red-500/20 border-2 border-red-500 text-red-400'
                        : 'bg-zinc-800 border-2 border-transparent text-zinc-400'
                    }`}
                  >
                    <XCircle className="w-6 h-6" />
                  </motion.button>
                </div>
              </div>
            )}

            {/* GIR */}
            <div className="flex items-center justify-between">
              <span className="text-zinc-300">Green in Regulation</span>
              <div className="flex gap-2">
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => updateStats({ gir: true })}
                  className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
                    stats.gir === true
                      ? 'bg-emerald-500/20 border-2 border-emerald-500 text-emerald-400'
                      : 'bg-zinc-800 border-2 border-transparent text-zinc-400'
                  }`}
                >
                  <CheckCircle className="w-6 h-6" />
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => updateStats({ gir: false })}
                  className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
                    stats.gir === false
                      ? 'bg-red-500/20 border-2 border-red-500 text-red-400'
                      : 'bg-zinc-800 border-2 border-transparent text-zinc-400'
                  }`}
                >
                  <XCircle className="w-6 h-6" />
                </motion.button>
              </div>
            </div>

            {/* Putts */}
            <div className="flex items-center justify-between">
              <span className="text-zinc-300">Putts</span>
              <div className="flex items-center gap-2">
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => updateStats({ putts: Math.max(0, (stats.putts ?? 2) - 1) })}
                  className="w-10 h-10 rounded-xl bg-zinc-800 text-zinc-400 flex items-center justify-center"
                >
                  <Minus className="w-5 h-5" />
                </motion.button>
                <div className="w-16 text-center">
                  <span className="text-2xl font-bold text-white">{stats.putts ?? '–'}</span>
                </div>
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => updateStats({ putts: Math.min(9, (stats.putts ?? 0) + 1) })}
                  className="w-10 h-10 rounded-xl bg-zinc-800 text-zinc-400 flex items-center justify-center"
                >
                  <Plus className="w-5 h-5" />
                </motion.button>
              </div>
            </div>

            {/* Quick putt buttons */}
            <div className="flex gap-2">
              {[1, 2, 3].map((p) => (
                <button
                  key={p}
                  onClick={() => updateStats({ putts: p })}
                  className={`flex-1 py-2 rounded-lg text-sm transition-all ${
                    stats.putts === p
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-zinc-800 text-zinc-400 border border-transparent hover:bg-zinc-700'
                  }`}
                >
                  {p} putt{p > 1 ? 's' : ''}
                </button>
              ))}
            </div>

            {/* Penalties */}
            <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
              <span className="text-zinc-300">Penalties</span>
              <div className="flex items-center gap-2">
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => updateStats({ penalties: Math.max(0, stats.penalties - 1) })}
                  className="w-10 h-10 rounded-xl bg-zinc-800 text-zinc-400 flex items-center justify-center"
                >
                  <Minus className="w-5 h-5" />
                </motion.button>
                <div className="w-16 text-center">
                  <span className={`text-2xl font-bold ${stats.penalties > 0 ? 'text-red-400' : 'text-white'}`}>
                    {stats.penalties}
                  </span>
                </div>
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  onClick={() => updateStats({ penalties: stats.penalties + 1 })}
                  className="w-10 h-10 rounded-xl bg-zinc-800 text-zinc-400 flex items-center justify-center"
                >
                  <Plus className="w-5 h-5" />
                </motion.button>
              </div>
            </div>
          </div>
        </div>

        {/* Stats Summary */}
        <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-white">Round Stats</span>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {[
              { 
                label: 'FIR', 
                value: Object.values(holeStats).filter(s => s.fairwayHit === true).length,
                total: Object.values(holeStats).filter(s => s.fairwayHit !== null).length,
                color: 'text-emerald-400'
              },
              { 
                label: 'GIR', 
                value: Object.values(holeStats).filter(s => s.gir === true).length,
                total: Object.values(holeStats).filter(s => s.gir !== null).length,
                color: 'text-emerald-400'
              },
              { 
                label: 'Putts', 
                value: Object.values(holeStats).reduce((sum, s) => sum + (s.putts ?? 0), 0),
                total: null,
                color: 'text-white'
              },
              { 
                label: 'Penalties', 
                value: Object.values(holeStats).reduce((sum, s) => sum + s.penalties, 0),
                total: null,
                color: 'text-red-400'
              },
            ].map((stat) => (
              <div key={stat.label} className="text-center p-3 rounded-xl bg-zinc-800/50">
                <div className={`text-xl font-bold ${stat.color}`}>
                  {stat.total !== null ? `${stat.value}/${stat.total}` : stat.value}
                </div>
                <div className="text-xs text-zinc-500">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Footer Navigation */}
      <footer className="fixed bottom-0 left-0 right-0 backdrop-blur-xl bg-zinc-950/60 border-t border-white/10">
        <div className="max-w-2xl mx-auto flex justify-around px-2 py-2">
          <Link href="/" className="flex flex-col items-center p-2 text-zinc-400 hover:text-zinc-100 transition-colors">
            <HomeIcon className="h-5 w-5" aria-hidden="true" />
            <span className="text-[11px] font-medium">Home</span>
          </Link>
          <Link href="/round/new" className="flex flex-col items-center p-2 text-zinc-400 hover:text-zinc-100 transition-colors">
            <Plus className="h-5 w-5" aria-hidden="true" />
            <span className="text-[11px] font-medium">New</span>
          </Link>
          <Link href="/caddie" className="flex flex-col items-center p-2 text-emerald-300">
            <Flag className="h-5 w-5" aria-hidden="true" />
            <span className="text-[11px] font-medium">Caddie</span>
          </Link>
          <Link href="/profile" className="flex flex-col items-center p-2 text-zinc-400 hover:text-zinc-100 transition-colors">
            <User className="h-5 w-5" aria-hidden="true" />
            <span className="text-[11px] font-medium">Profile</span>
          </Link>
        </div>
      </footer>
    </div>
  );
}
