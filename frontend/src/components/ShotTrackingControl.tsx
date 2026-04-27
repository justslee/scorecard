'use client';

import { useState } from 'react';
import { Loader2, MapPin, Crosshair, X, Trash2 } from 'lucide-react';
import { useShotTracking } from '@/hooks/useShotTracking';
import type { Position } from '@/lib/gps';

interface ShotTrackingControlProps {
  roundId: string;
  holeNumber: number;
  holeId?: string | null;
  getPosition: () => Position | null;
  /** Optional list of common clubs (short codes like '7iron', 'pw') for the post-shot prompt. */
  clubChoices?: string[];
}

const RESULTS = ['fairway', 'rough', 'green', 'bunker', 'water', 'ob'] as const;

const lieBadge = (lie: string | null | undefined) => {
  if (!lie) return null;
  const colors: Record<string, string> = {
    fairway: 'bg-lime-700/40 text-lime-300',
    green: 'bg-emerald-700/40 text-emerald-300',
    rough: 'bg-amber-700/40 text-amber-300',
    bunker: 'bg-yellow-700/40 text-yellow-300',
    water: 'bg-sky-700/40 text-sky-300',
    ob: 'bg-red-700/40 text-red-300',
    tee: 'bg-zinc-700/60 text-zinc-300',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[lie] || 'bg-zinc-700 text-zinc-400'}`}>
      {lie}
    </span>
  );
};

export default function ShotTrackingControl({
  roundId,
  holeNumber,
  holeId,
  getPosition,
  clubChoices = ['driver', '3wood', 'hybrid', '7iron', 'pw', 'sw', 'putter'],
}: ShotTrackingControlProps) {
  const tracking = useShotTracking({ roundId, holeNumber, holeId, getPosition });
  const [club, setClub] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<string | undefined>(undefined);

  const holeShots = tracking.shots.filter(s => s.hole_number === holeNumber);

  const handleEnd = async () => {
    const saved = await tracking.markEnd({ club, result });
    if (saved) {
      setClub(undefined);
      setResult(undefined);
    }
  };

  return (
    <div className="bg-zinc-800/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-zinc-400">Shot tracking</h3>
        <span className="text-xs text-zinc-500">
          {holeShots.length} shot{holeShots.length === 1 ? '' : 's'} on this hole
        </span>
      </div>

      {tracking.error && (
        <div className="mb-3 text-xs text-red-300 bg-red-950/40 border border-red-900/40 rounded-lg px-3 py-2">
          {tracking.error}
        </div>
      )}

      {tracking.phase === 'idle' && (
        <button
          onClick={tracking.markStart}
          className="w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium flex items-center justify-center gap-2"
        >
          <MapPin className="w-4 h-4" />
          Mark shot start
        </button>
      )}

      {tracking.phase === 'awaiting_end' && (
        <div className="space-y-3">
          <div className="text-xs text-zinc-400">
            Start marked. Walk to your ball, then mark the end of the shot.
          </div>

          <div>
            <div className="text-xs text-zinc-500 mb-1.5">Club</div>
            <div className="flex flex-wrap gap-1.5">
              {clubChoices.map(c => (
                <button
                  key={c}
                  onClick={() => setClub(c === club ? undefined : c)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                    club === c
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs text-zinc-500 mb-1.5">Result</div>
            <div className="flex flex-wrap gap-1.5">
              {RESULTS.map(r => (
                <button
                  key={r}
                  onClick={() => setResult(r === result ? undefined : r)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                    result === r
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={tracking.cancel}
              className="flex-1 h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium flex items-center justify-center gap-1.5"
            >
              <X className="w-4 h-4" />
              Cancel
            </button>
            <button
              onClick={handleEnd}
              className="flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium flex items-center justify-center gap-1.5"
            >
              <Crosshair className="w-4 h-4" />
              Mark end
            </button>
          </div>
        </div>
      )}

      {tracking.phase === 'saving' && (
        <div className="h-11 flex items-center justify-center text-xs text-zinc-400 gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Saving shot…
        </div>
      )}

      {holeShots.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-zinc-700/50 pt-3">
          {holeShots.map(shot => (
            <div key={shot.id} className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500 w-6 shrink-0">#{shot.shot_number}</span>
              <span className="text-zinc-300 flex-1 truncate">
                {shot.club || '?'} · {shot.distance_yards != null ? `${shot.distance_yards}y` : '—'}
              </span>
              <div className="flex items-center gap-1">
                {lieBadge(shot.start_lie)}
                <span className="text-zinc-600">→</span>
                {lieBadge(shot.end_lie || shot.result)}
              </div>
              <button
                onClick={() => tracking.remove(shot.id)}
                className="text-zinc-600 hover:text-red-400 ml-1"
                title="Delete shot"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
