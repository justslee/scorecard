// SPIKE (specs/passive-shot-tracking-spike.md) — feasibility-only prototype
// code. Gated end-to-end behind NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS=1; the
// classifier below is pure and has zero effect when the flag is off (nothing
// imports it unless the gated banner mounts — see
// components/spike/PassiveShotDraftBanner.tsx).
//
// Pure, deterministic, no I/O, no Capacitor imports. Takes a stream of GPS
// samples (the SAME shape the round page's already-running GPSWatcher
// already produces — see lib/gps.ts `Position`) and classifies a
// "dwell → move → dwell" pattern as a candidate shot: the golfer was
// standing still (addressing the ball / on the tee), moved a meaningful
// distance, and is standing still again (found the ball / walked to it).
//
// This NEVER decides a shot happened — it only ever produces a DraftSuggestion,
// which the gated banner renders as a quiet prompt to hold the existing
// "Ask caddie" voice affordance and say the club. See
// specs/passive-shot-tracking-spike.md §Q3 for the accuracy/error-budget
// reasoning behind every constant below.

export interface DriftSample {
  lat: number;
  lng: number;
  /** Horizontal accuracy in meters, if the fix reports one. */
  accuracy?: number;
  /** Platform-reported instantaneous speed in m/s (Doppler-derived on real
   *  GPS — far more reliable than differencing two noisy fixes). Optional;
   *  the classifier falls back to distance/time between raw samples when
   *  absent. */
  speed?: number;
  /** Epoch ms. */
  timestamp: number;
}

export interface DraftSuggestion {
  /** Straight-line distance from the anchor dwell to the new dwell, yards. */
  estimatedYards: number;
  /** How long the destination dwell had to hold before this fired. */
  fromDwellMs: number;
  /** 'rode' when the peak speed during the transit implies a cart, not a
   *  walk — the banner softens/suppresses its copy for 'rode' (the #1
   *  false-positive case: riding to the next tee is not a shot). */
  kind: "walked" | "rode";
}

interface LatLng {
  lat: number;
  lng: number;
}

export interface DriftState {
  /** The last confirmed resting position — the "from" of the next
   *  suggestion. Only moves via resetAnchor (confirm/dismiss), never
   *  automatically — this is the deliberate seam that keeps a dismissed
   *  draft from silently re-anchoring and re-firing on its own. */
  anchor: LatLng;
  /** EMA-smoothed position — damps GPS jitter (see DriftConfig.posEmaAlpha). */
  smoothedPos: LatLng;
  /** EMA-smoothed instantaneous speed, m/s. */
  smoothedSpeedMps: number;
  /** Previous raw sample — needed for the position/time speed fallback. */
  lastRaw: { lat: number; lng: number; timestamp: number } | null;
  phase: "dwelling" | "moving";
  /** Peak smoothed speed observed during the current transit — classifies
   *  walked vs. rode. Reset each time a new transit begins. */
  peakSpeedMps: number;
  /** When the current candidate low-speed run began (null = not currently
   *  in a candidate rest). */
  restStartTs: number | null;
  /** Latest smoothed position during the candidate rest — updated every
   *  sample so it converges to the true stopping point rather than the
   *  smoothed position at the moment the golfer FIRST slowed down (which
   *  still lags the true position — see the walked-240y test). */
  restPos: LatLng | null;
  /** Latched true once a suggestion has fired for this anchor — blocks
   *  further suggestions until resetAnchor() (confirm/dismiss) is called.
   *  Without this, a golfer who ignores a draft and keeps walking would get
   *  spammed with a fresh suggestion every time displacement grows past the
   *  threshold again. */
  suggested: boolean;
}

export interface DriftConfig {
  /** Drop any sample with accuracy worse than this (meters) — tree cover /
   *  urban-canyon fixes are too noisy to trust for anything below. */
  maxAccuracyM: number;
  /** EMA smoothing factor for position, 0..1 (higher = more responsive,
   *  less smoothing). */
  posEmaAlpha: number;
  /** EMA smoothing factor for the derived speed signal, 0..1. */
  speedEmaAlpha: number;
  /** Below this smoothed speed (m/s), the golfer is considered "at rest". */
  dwellSpeedMps: number;
  /** A candidate rest must hold for at least this long (ms) before it counts
   *  as a real dwell (vs. a red light at a cart-path crossing). */
  dwellMinMs: number;
  /** Peak transit speed above this (m/s) reclassifies the suggestion as
   *  'rode' — riding, not walking (cart pace is ~4.5-9 m/s vs. a golfer's
   *  walking pace of ~1.2-1.8 m/s). */
  cartSpeedMps: number;
  /** Minimum displacement (yards) between dwells to prompt a draft at all —
   *  below this it's tee-box shuffling / bunker raking, not a shot. */
  minSuggestYards: number;
}

export const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  maxAccuracyM: 25,
  posEmaAlpha: 0.35,
  speedEmaAlpha: 0.5,
  dwellSpeedMps: 0.7,
  dwellMinMs: 10_000,
  cartSpeedMps: 4.5,
  minSuggestYards: 55,
};

// Haversine distance in meters — kept local (not calculateDistance's rounded
// integer yards) for the internal speed-fallback calc, where rounding to the
// nearest meter over a short interval would distort the implied speed.
// Uses the mean-latitude equirectangular approximation, which is accurate to
// well under 1% at golf-course scale (hundreds of meters) — plenty for a
// speed classifier with meter-scale thresholds.
const EARTH_RADIUS_M = 6_371_000;
function metersBetween(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const meanLat = toRad((a.lat + b.lat) / 2);
  const x = dLng * Math.cos(meanLat);
  const y = dLat;
  return Math.sqrt(x * x + y * y) * EARTH_RADIUS_M;
}

function metersToYards(m: number): number {
  return Math.round(m * 1.09361);
}

export function createDriftState(anchor: DriftSample): DriftState {
  const pos: LatLng = { lat: anchor.lat, lng: anchor.lng };
  return {
    anchor: pos,
    smoothedPos: pos,
    smoothedSpeedMps: 0,
    lastRaw: { lat: anchor.lat, lng: anchor.lng, timestamp: anchor.timestamp },
    phase: "dwelling",
    peakSpeedMps: 0,
    restStartTs: null,
    restPos: null,
    suggested: false,
  };
}

/** Confirm or dismiss: re-anchors on the given sample and clears every
 *  transit/latch field. The classifier never does this on its own — see
 *  DriftState.anchor doc. */
export function resetAnchor(state: DriftState, sample: DriftSample): DriftState {
  return createDriftState(sample);
}

export function advance(
  state: DriftState,
  sample: DriftSample,
  cfg: DriftConfig = DEFAULT_DRIFT_CONFIG,
): { state: DriftState; suggestion: DraftSuggestion | null } {
  // Gate: a fix this noisy can't be trusted for anything — drop it whole,
  // state unchanged (tree cover / urban canyon).
  if (sample.accuracy != null && sample.accuracy > cfg.maxAccuracyM) {
    return { state, suggestion: null };
  }

  const rawPos: LatLng = { lat: sample.lat, lng: sample.lng };

  // Prefer the platform's own speed estimate (Doppler-derived on real GPS);
  // fall back to differencing raw fixes only when it's absent.
  let rawSpeed = 0;
  if (sample.speed != null && sample.speed >= 0) {
    rawSpeed = sample.speed;
  } else if (state.lastRaw) {
    const dtS = (sample.timestamp - state.lastRaw.timestamp) / 1000;
    if (dtS > 0) {
      rawSpeed = metersBetween(state.lastRaw, rawPos) / dtS;
    }
  }

  const smoothedSpeedMps =
    state.lastRaw == null
      ? rawSpeed
      : state.smoothedSpeedMps + cfg.speedEmaAlpha * (rawSpeed - state.smoothedSpeedMps);

  const smoothedPos: LatLng = {
    lat: state.smoothedPos.lat + cfg.posEmaAlpha * (rawPos.lat - state.smoothedPos.lat),
    lng: state.smoothedPos.lng + cfg.posEmaAlpha * (rawPos.lng - state.smoothedPos.lng),
  };

  let phase = state.phase;
  let peakSpeedMps = state.peakSpeedMps;
  let restStartTs = state.restStartTs;
  let restPos = state.restPos;
  let suggested = state.suggested;
  let suggestion: DraftSuggestion | null = null;

  if (!suggested) {
    if (phase === "dwelling") {
      if (smoothedSpeedMps > cfg.dwellSpeedMps) {
        // Left the anchor — a transit has begun.
        phase = "moving";
        peakSpeedMps = smoothedSpeedMps;
        restStartTs = null;
        restPos = null;
      }
    } else {
      // phase === "moving"
      peakSpeedMps = Math.max(peakSpeedMps, smoothedSpeedMps);

      if (smoothedSpeedMps < cfg.dwellSpeedMps) {
        if (restStartTs == null) {
          restStartTs = sample.timestamp;
        }
        // Keep tracking the LATEST smoothed position through the rest —
        // it converges to the true stopping point over the dwell window,
        // rather than freezing the (still-lagging) position from the
        // instant the golfer first slowed down.
        restPos = smoothedPos;

        if (sample.timestamp - restStartTs >= cfg.dwellMinMs) {
          const yards = metersToYards(metersBetween(state.anchor, restPos));
          if (yards >= cfg.minSuggestYards) {
            suggestion = {
              estimatedYards: yards,
              fromDwellMs: sample.timestamp - restStartTs,
              kind: peakSpeedMps > cfg.cartSpeedMps ? "rode" : "walked",
            };
            suggested = true;
          }
          phase = "dwelling";
        }
      } else {
        // Moving again before settling — that low-speed blip wasn't a real
        // stop (a red light, a step over a bunker rake).
        restStartTs = null;
        restPos = null;
      }
    }
  }

  return {
    state: {
      anchor: state.anchor,
      smoothedPos,
      smoothedSpeedMps,
      lastRaw: { lat: rawPos.lat, lng: rawPos.lng, timestamp: sample.timestamp },
      phase,
      peakSpeedMps,
      restStartTs,
      restPos,
      suggested,
    },
    suggestion,
  };
}
