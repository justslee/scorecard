'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Target,
  Wind,
  Navigation,
  Locate,
  Flag,
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
}

interface CaddiePanelProps {
  round: Round;
  currentHole: number;
  onHoleChange: (hole: number) => void;
}

// Generate hole info from round data or use defaults
function getHoleInfo(round: Round, holeNumber: number): HoleInfo {
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

export default function CaddiePanel({ round, currentHole, onHoleChange }: CaddiePanelProps) {
  const [distanceToPin, setDistanceToPin] = useState<number | null>(null);
  const [clubDistances] = useState(defaultClubDistances);
  const [windDirection, setWindDirection] = useState<'headwind' | 'tailwind' | 'crosswind' | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [sheetExpanded, setSheetExpanded] = useState(false);

  const hole = getHoleInfo(round, currentHole);

  // Calculate suggested club based on distance
  const getSuggestedClub = (distance: number): { club: string; yards: number } => {
    let adjustedDistance = distance;
    if (windDirection === 'headwind') adjustedDistance += 10;
    if (windDirection === 'tailwind') adjustedDistance -= 10;

    const clubs = Object.entries(clubDistances).sort((a, b) => b[1] - a[1]);
    for (const [club, dist] of clubs) {
      if (dist <= adjustedDistance + 5) {
        return { club, yards: dist };
      }
    }
    return { club: 'lw', yards: clubDistances.lw };
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
        // TODO: Calculate distance to pin using course coordinates
        setGpsLoading(false);
        alert(`Location acquired!\nLat: ${position.coords.latitude.toFixed(6)}\nLng: ${position.coords.longitude.toFixed(6)}\n\nGPS distance calculation coming soon.`);
      },
      (error) => {
        console.error('GPS error:', error);
        setGpsLoading(false);
        alert('Could not get location. Please enter distance manually.');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const suggestion = distanceToPin ? getSuggestedClub(distanceToPin) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Map Area - Large */}
      <div className="flex-1 min-h-[280px] bg-gradient-to-b from-emerald-950/80 to-zinc-950 relative overflow-hidden">
        {/* Hole info overlay */}
        <div className="absolute top-4 left-4 right-4 flex justify-between items-start z-10">
          <div className="bg-black/50 backdrop-blur-sm rounded-xl px-4 py-2">
            <div className="text-2xl font-bold text-white">Hole {currentHole}</div>
            <div className="text-sm text-zinc-400">Par {hole.par} • {hole.yards} yds</div>
          </div>
          
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={handleGetLocation}
            disabled={gpsLoading}
            className="bg-emerald-500/20 backdrop-blur-sm border border-emerald-500/30 rounded-xl px-4 py-3 flex items-center gap-2 text-emerald-400 disabled:opacity-50"
          >
            <Locate className={`w-5 h-5 ${gpsLoading ? 'animate-pulse' : ''}`} />
            <span className="text-sm font-medium">{gpsLoading ? 'Locating...' : 'GPS'}</span>
          </motion.button>
        </div>

        {/* Map placeholder */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            {/* Simple hole illustration */}
            <div className="relative w-32 h-48 mx-auto mb-4">
              {/* Fairway */}
              <div className="absolute inset-x-4 top-12 bottom-0 bg-emerald-800/40 rounded-t-full" />
              {/* Green */}
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-16 h-16 bg-emerald-600/50 rounded-full" />
              {/* Pin */}
              <div className="absolute top-4 left-1/2 -translate-x-1/2 flex flex-col items-center">
                <Flag className="w-5 h-5 text-red-400" />
              </div>
              {/* Tee */}
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-3 h-3 bg-white/60 rounded-full" />
            </div>
            <p className="text-emerald-400/60 text-sm">Course map coming soon</p>
          </div>
        </div>

        {/* Distance markers (when available) */}
        {distanceToPin && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-sm rounded-full px-6 py-2">
            <span className="text-2xl font-bold text-white">{distanceToPin}</span>
            <span className="text-zinc-400 ml-1">yds to pin</span>
          </div>
        )}
      </div>

      {/* Shot Planner Sheet */}
      <div className="bg-zinc-900 border-t border-zinc-800 shrink-0 max-h-[45%] flex flex-col">
        {/* Drag handle */}
        <div className="flex justify-center py-2 shrink-0">
          <div className="w-10 h-1 rounded-full bg-zinc-700" />
        </div>

        <div className="px-4 pb-4 space-y-4 overflow-y-auto touch-pan-y">
          {/* Distance input + club suggestion */}
          <div className="flex gap-3 items-stretch">
            <div className="relative flex-1">
              <input
                type="number"
                value={distanceToPin ?? ''}
                onChange={(e) => setDistanceToPin(e.target.value ? Number(e.target.value) : null)}
                placeholder="Yards"
                className="w-full h-full px-4 py-3 rounded-xl bg-zinc-800 border border-zinc-700 text-white text-xl font-bold text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none placeholder:text-zinc-600 placeholder:font-normal placeholder:text-base"
              />
            </div>

            {suggestion && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex-1 px-4 py-3 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-center"
              >
                <div className="text-xl font-bold text-emerald-400 uppercase">
                  {suggestion.club.replace(/(\d)/, ' $1')}
                </div>
                <div className="text-xs text-emerald-400/60">{suggestion.yards} yds</div>
              </motion.div>
            )}
          </div>

          {/* Quick distance buttons */}
          <div className="flex gap-2">
            {[75, 100, 125, 150, 175, 200].map((d) => (
              <button
                key={d}
                onClick={() => setDistanceToPin(d)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                  distanceToPin === d
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
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
              <span className="text-xs text-zinc-500 uppercase tracking-wide">Wind</span>
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
                  className={`flex-1 py-2.5 px-3 rounded-xl text-sm transition-all ${
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

          {/* Caddie tip */}
          {hole.par === 3 && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
              <p className="text-sm text-amber-200">🎯 Par 3 — commit to your club, smooth swing</p>
            </div>
          )}
          {hole.par === 5 && distanceToPin && distanceToPin > 220 && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
              <p className="text-sm text-amber-200">📐 Lay up to your favorite wedge distance</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
