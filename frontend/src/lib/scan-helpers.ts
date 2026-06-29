/**
 * scan-helpers.ts — pure helpers for the OCR scorecard-scan feature.
 *
 * All functions here are side-effect-free and testable in vitest without
 * a camera, network, or database.  The ScanSheet component uses these to
 * separate the concern of:
 *   (a) converting the backend response to a review model,
 *   (b) matching OCR player names to round players (fuzzy + phonetic), and
 *   (c) extracting confirmed score updates for the existing per-hole persist path.
 *
 * Device-only (not tested here): camera capture, image blob construction,
 * and the live vision accuracy of the backend OCR call.
 */

import type { ScanScorecardResponse, Player } from './types';
import type { SavedPlayer } from './types';
import { matchPlayerName } from './player-match';

// ─────────────────────────────────────────────────────────────────────────────
// Review model shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-player row in the review grid shown between scan and confirm.
 *
 * This is the single internal type used by ScanSheet; it is also exported
 * so pure helpers and tests can reference it without importing the component.
 */
export interface OcrPlayerReview {
  /** Name exactly as read from the card by the OCR backend. */
  ocrName: string;
  /**
   * 18-slot score array (index = holeNumber - 1).
   * null = blank / unreadable cell, or hole not on the card.
   */
  scores: (number | null)[];
  /**
   * Round player ID this OCR row has been mapped to.
   * null = "Skip" (user chose not to import) or no confident auto-match was found.
   */
  mappedPlayerId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) ScanScorecardResponse → OcrPlayerReview[]
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a ScanScorecardResponse (hole-centric shape from the backend) into
 * per-player review rows for the scan review screen.
 *
 * Player matching strategy (reuses player-match.ts):
 *   1. Exact normalized equality (case-insensitive, diacritic-stripped)  → 1.0
 *   2. Fuzzy Levenshtein + containment similarity                        → [0, 1)
 *   3. Soundex phonetic key collision (e.g. "Bob" / "Robert" would need
 *      longer names; "Dipak" / "Deepak" both resolve to D120)            → 0.8
 *
 * OCR names that fall below the matching threshold get mappedPlayerId = null
 * so the user can assign them manually in the review screen.
 *
 * @param response    - Structured scan response from POST /api/scorecard/scan
 * @param roundPlayers - Players in the current round (source of IDs to map to)
 */
export function scanResponseToReviewModel(
  response: ScanScorecardResponse,
  roundPlayers: Player[]
): OcrPlayerReview[] {
  // Build a minimal SavedPlayer roster from round players.  player-match.ts
  // operates on SavedPlayer[] because it was originally designed for the saved-
  // contacts feature; round Player objects have the same name/id fields, so the
  // cast is safe and adds zero runtime cost.
  const roster: SavedPlayer[] = roundPlayers.map((p) => ({
    id: p.id,
    name: p.name,
    roundsPlayed: 0,
    createdAt: '',
    updatedAt: '',
  }));

  return response.players.map((ocrName) => {
    // Build the 18-slot score array from the hole-centric response.
    const scores: (number | null)[] = Array(18).fill(null);
    for (const hole of response.holes) {
      const idx = hole.number - 1; // 0-based
      if (idx >= 0 && idx < 18) {
        const val = hole.scores[ocrName];
        // Coerce any non-number to null (null / undefined / missing key).
        scores[idx] = typeof val === 'number' ? val : null;
      }
    }

    // Fuzzy + phonetic match.  Returns player: null when below the threshold
    // (default MIN_MATCH = 0.72), which the UI shows as "No match / Skip".
    const matchResult = matchPlayerName(ocrName, roster);

    return {
      ocrName,
      scores,
      mappedPlayerId: matchResult.player?.id ?? null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) scanned-player → round-player matching (re-exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

// matchPlayerName is already exported from player-match.ts; re-export here so
// callers of scan-helpers don't need a separate import path.
export { matchPlayerName } from './player-match';

// ─────────────────────────────────────────────────────────────────────────────
// (c) Confirmed review model → score-update shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a confirmed review model to the list of (playerId, holeIdx, strokes)
 * triples expected by RoundPageClient's handleSetScore(pid, idx, val).
 *
 * Only includes:
 *   - Rows with a non-null mappedPlayerId  (user has assigned a player)
 *   - Cells with strokes in the valid range [1, 15]  (rejects blanks + typos)
 *
 * This function never applies scores itself — the caller must drive the
 * existing score-entry/persist path, which shows a loading state, handles
 * optimistic updates, and guards against silent overwrites.
 */
export function buildScoreUpdates(
  reviewModel: OcrPlayerReview[]
): [string, number, number][] {
  const entries: [string, number, number][] = [];
  for (const row of reviewModel) {
    if (!row.mappedPlayerId) continue;
    row.scores.forEach((val, holeIdx) => {
      if (val !== null && val >= 1 && val <= 15) {
        entries.push([row.mappedPlayerId!, holeIdx, val]);
      }
    });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data-URL → Blob (browser-only; not unit-tested — depends on atob + Blob)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a data-URL string (as produced by CameraCapture / canvas.toDataURL)
 * to a Blob suitable for the multipart form upload in `scanScorecard()`.
 *
 * Called only in the browser; `atob` and `Blob` are browser / Node 18+ globals.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64Data] = dataUrl.split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  // atob is available in browsers and Node 18+; the global Buffer path provides
  // the same result in older Node environments (e.g. older CI images).
  // Use atob (browser + Node 18+) to decode the base64 payload.
  // Node <18 doesn't have atob but does have Buffer; guard against that.
  let blobParts: BlobPart[];
  if (typeof atob !== 'undefined') {
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    // Convert to ArrayBuffer (plain ArrayBuffer, not ArrayBufferLike) to satisfy
    // the strict Blob constructor overload in lib.dom.d.ts (TypeScript ≥5.2).
    blobParts = [bytes.buffer as ArrayBuffer];
  } else {
    // Node <18 fallback — Buffer is available but not atob.
    const buf = Buffer.from(base64Data, 'base64');
    blobParts = [buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer];
  }

  return new Blob(blobParts, { type: mime });
}
