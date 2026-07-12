'use client';

// SPIKE (specs/passive-shot-tracking-spike.md) — Option B, the half-day
// measurement rider. Gated behind NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS=1, OFF in
// every real env — renders nothing (empty page) otherwise.
//
// Purpose: get an HONEST empirical number for the writeup, nothing more.
// Tap "Request permission", then move the phone — this shows the
// DeviceMotionEvent.requestPermission() outcome, the achieved sample
// interval (ms between events, i.e. the real Hz ceiling in THIS WKWebView
// shell), and a live peak |acceleration| reading. No thresholding, no
// swing classifier, no draft, no write path — a printed number, that's it.
import { useEffect, useRef, useState } from 'react';
import { T, PAPER_NOISE } from '@/components/yardage/tokens';

type PermissionOutcome = 'unrequested' | 'unsupported' | 'granted' | 'denied' | 'error';

interface DeviceMotionEventWithPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

function spikeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS === '1';
}

export default function MotionProbePage() {
  const [permission, setPermission] = useState<PermissionOutcome>('unrequested');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [avgIntervalMs, setAvgIntervalMs] = useState<number | null>(null);
  const [peakAccel, setPeakAccel] = useState(0);
  const lastEventTs = useRef<number | null>(null);
  const intervalSamples = useRef<number[]>([]);

  useEffect(() => {
    if (!spikeEnabled()) return;
    const handler = (e: DeviceMotionEvent) => {
      const now = performance.now();
      if (lastEventTs.current != null) {
        const dt = now - lastEventTs.current;
        // Keep a rolling window so the average reflects "right now", not
        // the first few (often irregular) events.
        intervalSamples.current.push(dt);
        if (intervalSamples.current.length > 60) intervalSamples.current.shift();
        const avg =
          intervalSamples.current.reduce((a, b) => a + b, 0) / intervalSamples.current.length;
        setAvgIntervalMs(avg);
      }
      lastEventTs.current = now;
      setEventCount((c) => c + 1);

      const a = e.accelerationIncludingGravity;
      if (a && a.x != null && a.y != null && a.z != null) {
        const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
        setPeakAccel((prev) => Math.max(prev, mag));
      }
    };
    window.addEventListener('devicemotion', handler);
    return () => window.removeEventListener('devicemotion', handler);
  }, [permission]);

  if (!spikeEnabled()) return null;

  const requestPermission = async () => {
    setErrorMsg(null);
    try {
      const ctor = (
        typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : undefined
      ) as unknown as DeviceMotionEventWithPermission | undefined;
      if (!ctor) {
        setPermission('unsupported');
        return;
      }
      if (typeof ctor.requestPermission === 'function') {
        // Must be called from a user gesture (tap) — iOS 13+ requirement.
        const outcome = await ctor.requestPermission();
        setPermission(outcome === 'granted' ? 'granted' : 'denied');
      } else {
        // No requestPermission on this platform (older iOS / non-iOS) —
        // events just start firing, or don't.
        setPermission('granted');
      }
    } catch (err) {
      setPermission('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: 'multiply',
        fontFamily: T.sans,
        color: T.ink,
        padding: '24px 20px',
        maxWidth: 420,
        margin: '0 auto',
      }}
    >
      <h1 style={{ fontFamily: T.serif, fontStyle: 'italic', fontSize: 24, marginBottom: 4 }}>
        Motion probe
      </h1>
      <p style={{ fontSize: 13, color: T.pencil, marginBottom: 20, lineHeight: 1.5 }}>
        SPIKE diagnostic (specs/passive-shot-tracking-spike.md, Option B). Measures the real
        DeviceMotionEvent permission + sample-rate ceiling in this WKWebView shell. No swing
        detection, no draft, no write.
      </p>

      <button
        onClick={requestPermission}
        style={{
          padding: '12px 18px',
          borderRadius: 99,
          border: 'none',
          background: T.ink,
          color: T.paper,
          fontFamily: T.sans,
          fontSize: 14,
          fontWeight: 500,
          cursor: 'pointer',
          marginBottom: 20,
        }}
      >
        Request permission
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
        <Row label="Permission" value={permission} />
        {errorMsg && <Row label="Error" value={errorMsg} />}
        <Row label="Events received" value={String(eventCount)} />
        <Row
          label="Avg interval"
          value={avgIntervalMs != null ? `${avgIntervalMs.toFixed(1)} ms (~${(1000 / avgIntervalMs).toFixed(0)} Hz)` : '—'}
        />
        <Row label="Peak |accel incl. gravity|" value={`${peakAccel.toFixed(2)} m/s²`} />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '10px 0',
        borderBottom: `1px solid ${T.hairline}`,
      }}
    >
      <span style={{ color: T.pencil }}>{label}</span>
      <span style={{ fontFamily: T.mono }}>{value}</span>
    </div>
  );
}
