'use client';

import { useState } from 'react';
import { Flag, Loader2, Check } from 'lucide-react';
import { markPin, type PinRecord } from '@/lib/caddie/api';
import type { Position } from '@/lib/gps';

interface PinMarkControlProps {
  courseId: string;
  holeNumber: number;
  /** Today's marked pin for this hole, if any. Used to render a 'remark' state. */
  currentPin?: PinRecord | null;
  /** Returns the player's current GPS position. */
  getPosition: () => Position | null;
  /** Called after a successful save with the new pin. */
  onPinMarked?: (pin: PinRecord) => void;
}

export default function PinMarkControl({
  courseId,
  holeNumber,
  currentPin,
  getPosition,
  onPinMarked,
}: PinMarkControlProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setError(null);
    const pos = getPosition();
    if (!pos) {
      setError('No GPS fix yet — wait a moment and try again.');
      return;
    }
    setSaving(true);
    try {
      const saved = await markPin({
        course_id: courseId,
        hole_number: holeNumber,
        pin_lat: pos.lat,
        pin_lng: pos.lng,
      });
      onPinMarked?.(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save pin');
    } finally {
      setSaving(false);
    }
  };

  const hasPin = !!currentPin;
  const label = saving
    ? 'Saving…'
    : hasPin
    ? 'Re-mark pin here'
    : 'Mark pin here';

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={saving}
        className={`w-full h-10 rounded-xl text-sm font-medium flex items-center justify-center gap-2 ${
          hasPin
            ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700'
            : 'bg-amber-600/80 hover:bg-amber-500 text-white'
        } disabled:opacity-60`}
      >
        {saving
          ? <Loader2 className="w-4 h-4 animate-spin" />
          : hasPin
          ? <Check className="w-4 h-4" />
          : <Flag className="w-4 h-4" />
        }
        {label}
      </button>
      {error && <div className="mt-1.5 text-xs text-red-300">{error}</div>}
    </div>
  );
}
