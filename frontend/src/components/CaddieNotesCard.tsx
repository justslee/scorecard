'use client';

import { Brain } from 'lucide-react';
import type { CaddieMemoryEntry, CaddieProfile } from '@/lib/caddie/api';

interface CaddieNotesCardProps {
  memories: CaddieMemoryEntry[];
  profile: CaddieProfile | null;
}

const KIND_LABELS: Record<CaddieMemoryEntry['kind'], string> = {
  tendency: 'tendency',
  preference: 'preference',
  course_history: 'course',
  incident: 'note',
};

const KIND_COLORS: Record<CaddieMemoryEntry['kind'], string> = {
  tendency: 'bg-amber-700/40 text-amber-300',
  preference: 'bg-sky-700/40 text-sky-300',
  course_history: 'bg-emerald-700/40 text-emerald-300',
  incident: 'bg-zinc-700/60 text-zinc-300',
};

export default function CaddieNotesCard({ memories, profile }: CaddieNotesCardProps) {
  if (memories.length === 0 && !profile?.rounds_analyzed) return null;

  // Highest-weighted first; cap to 4 to stay scannable.
  const top = [...memories].sort((a, b) => b.weight - a.weight).slice(0, 4);
  const roundsAnalyzed = profile?.rounds_analyzed || 0;

  return (
    <div className="bg-zinc-800/50 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-medium text-zinc-300">Caddie&apos;s notes on you</h3>
        </div>
        {roundsAnalyzed > 0 && (
          <span className="text-[10px] text-zinc-500">
            {roundsAnalyzed} {roundsAnalyzed === 1 ? 'round' : 'rounds'} analyzed
          </span>
        )}
      </div>

      {top.length === 0 ? (
        <p className="text-xs text-zinc-500 italic">
          Nothing learned yet — finish a round and log some shots so I can adapt.
        </p>
      ) : (
        <ul className="space-y-2">
          {top.map((m, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 mt-0.5 ${KIND_COLORS[m.kind]}`}>
                {KIND_LABELS[m.kind]}
              </span>
              <span className="text-zinc-300 leading-snug">{m.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
