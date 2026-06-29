/**
 * Course-coordinates PROVIDER
 *
 * Returns GolfAPI-verified per-hole tee + green (center / front / back)
 * coordinates for any course.  Today this returns MOCK data for the two
 * homegrown Bethpage courses; it is trivially swappable to live GolfAPI data
 * with the one-line change noted below.
 *
 * ── LIVE SWAP (one-line change) ───────────────────────────────────────────────
 * When the owner supplies a GolfAPI token:
 *   1. Set `USE_LIVE_GOLFAPI = true` below.
 *   2. Fill in `GOLFAPI_COURSE_ID_MAP` with the real GolfAPI numeric course IDs.
 *   3. Done — no other change needed.  The function falls through to the live
 *      `fetchCourseCoordinates` proxy, which already decodes the poi/location
 *      response via `_normalize_coordinates` in backend/app/routes/golf.py.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── MOCK DATA PROVENANCE ─────────────────────────────────────────────────────
 * Tee and green-center coordinates are derived from the OSM `golf=hole`
 * LineString centerlines fetched via Overpass on 2026-06-29:
 *   • First endpoint of each LineString → tee
 *   • Last endpoint                    → green center
 * Front and back are synthesized by offsetting the green center ±15 yards
 * (13.716 m) along the tee→green axis — a documented approximation until
 * the owner supplies a real GolfAPI token with verified F/B green measurements.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { CourseCoordinates } from '@/lib/golf-api';
import { fetchCourseCoordinates } from '@/lib/golf-api';
import { yardsDistance } from './hole-projection';

// ── Live-swap flag ─────────────────────────────────────────────────────────────
// SWAP TO LIVE: change to `true` and fill in GOLFAPI_COURSE_ID_MAP below.
const USE_LIVE_GOLFAPI = false;

/** Map from our homegrown UUID → GolfAPI numeric course ID.
 *  Fill in the real IDs when the owner supplies a token. */
const GOLFAPI_COURSE_ID_MAP: Record<string, number> = {
  // '2b8caab5-2c55-5752-8cda-336c3a396dac': 0,  // Bethpage Black — fill in real ID
  // '269e1f2e-65cc-5cf6-a9b0-f5908e298155': 0,  // Bethpage Red   — fill in real ID
};

// ── Known Bethpage UUIDs ───────────────────────────────────────────────────────
export const BETHPAGE_BLACK_ID = '2b8caab5-2c55-5752-8cda-336c3a396dac';
export const BETHPAGE_RED_ID   = '269e1f2e-65cc-5cf6-a9b0-f5908e298155';

// ── MOCK: Bethpage Black (OSM-derived, 2026-06-29) ────────────────────────────
// Tee = OSM centerline first point; Green center = last point.
// Front/Back = ±15-yard offsets along tee→green axis (mock approximation).
const MOCK_BLACK: CourseCoordinates[] = [
  { holeNumber: 1,  tee: { lat: 40.7429982, lng: -73.4545751 }, green: { lat: 40.745071,  lng: -73.4513512 }, front: { lat: 40.7449913, lng: -73.4514752 }, back: { lat: 40.7451507, lng: -73.4512272 } },
  { holeNumber: 2,  tee: { lat: 40.7443402, lng: -73.4502268 }, green: { lat: 40.7464053, lng: -73.44723   }, front: { lat: 40.7463224, lng: -73.4473503 }, back: { lat: 40.7464882, lng: -73.4471097 } },
  { holeNumber: 3,  tee: { lat: 40.7466109, lng: -73.446828  }, green: { lat: 40.7447291, lng: -73.4471708 }, front: { lat: 40.7448512, lng: -73.4471486 }, back: { lat: 40.744607,  lng: -73.447193  } },
  { holeNumber: 4,  tee: { lat: 40.7449885, lng: -73.4468039 }, green: { lat: 40.7484072, lng: -73.4436303 }, front: { lat: 40.7483064, lng: -73.4437239 }, back: { lat: 40.748508,  lng: -73.4435367 } },
  { holeNumber: 5,  tee: { lat: 40.7479134, lng: -73.4442669 }, green: { lat: 40.7517593, lng: -73.443137  }, front: { lat: 40.751639,  lng: -73.4431723 }, back: { lat: 40.7518796, lng: -73.4431017 } },
  { holeNumber: 6,  tee: { lat: 40.7521711, lng: -73.4428961 }, green: { lat: 40.7499837, lng: -73.4397695 }, front: { lat: 40.7500673, lng: -73.439889  }, back: { lat: 40.7499001, lng: -73.43965   } },
  { holeNumber: 7,  tee: { lat: 40.7495339, lng: -73.4388824 }, green: { lat: 40.7531537, lng: -73.4368729 }, front: { lat: 40.7530401, lng: -73.436936  }, back: { lat: 40.7532673, lng: -73.4368098 } },
  { holeNumber: 8,  tee: { lat: 40.752806,  lng: -73.4361606 }, green: { lat: 40.7544854, lng: -73.4355746 }, front: { lat: 40.7543663, lng: -73.4356162 }, back: { lat: 40.7546045, lng: -73.435533  } },
  { holeNumber: 9,  tee: { lat: 40.7551458, lng: -73.4349168 }, green: { lat: 40.753159,  lng: -73.4388179 }, front: { lat: 40.7532277, lng: -73.4386829 }, back: { lat: 40.7530903, lng: -73.4389529 } },
  { holeNumber: 10, tee: { lat: 40.7525791, lng: -73.4392425 }, green: { lat: 40.7564111, lng: -73.4412706 }, front: { lat: 40.7562967, lng: -73.4412101 }, back: { lat: 40.7565255, lng: -73.4413311 } },
  { holeNumber: 11, tee: { lat: 40.7565416, lng: -73.4419041 }, green: { lat: 40.7531614, lng: -73.440298  }, front: { lat: 40.7532773, lng: -73.4403531 }, back: { lat: 40.7530455, lng: -73.4402429 } },
  { holeNumber: 12, tee: { lat: 40.7527692, lng: -73.4395272 }, green: { lat: 40.7516039, lng: -73.4444599 }, front: { lat: 40.7516406, lng: -73.4443046 }, back: { lat: 40.7515672, lng: -73.4446152 } },
  { holeNumber: 13, tee: { lat: 40.7524216, lng: -73.4445186 }, green: { lat: 40.7479962, lng: -73.4474438 }, front: { lat: 40.7481064, lng: -73.447371  }, back: { lat: 40.747886,  lng: -73.4475166 } },
  { holeNumber: 14, tee: { lat: 40.7479925, lng: -73.4483277 }, green: { lat: 40.7469009, lng: -73.4489863 }, front: { lat: 40.747013,  lng: -73.4489187 }, back: { lat: 40.7467888, lng: -73.4490539 } },
  { holeNumber: 15, tee: { lat: 40.7458939, lng: -73.4507039 }, green: { lat: 40.7496381, lng: -73.4520769 }, front: { lat: 40.7495194, lng: -73.4520334 }, back: { lat: 40.7497568, lng: -73.4521204 } },
  { holeNumber: 16, tee: { lat: 40.7498911, lng: -73.4531798 }, green: { lat: 40.7462096, lng: -73.4512232 }, front: { lat: 40.7463239, lng: -73.4512839 }, back: { lat: 40.7460953, lng: -73.4511625 } },
  { holeNumber: 17, tee: { lat: 40.745585,  lng: -73.4509703 }, green: { lat: 40.7463694, lng: -73.4529391 }, front: { lat: 40.7463121, lng: -73.4527952 }, back: { lat: 40.7464267, lng: -73.453083  } },
  { holeNumber: 18, tee: { lat: 40.7466984, lng: -73.4534655 }, green: { lat: 40.7434937, lng: -73.4549836 }, front: { lat: 40.7436097, lng: -73.4549287 }, back: { lat: 40.7433777, lng: -73.4550385 } },
];

// ── MOCK: Bethpage Red (OSM-derived, 2026-06-29) ──────────────────────────────
const MOCK_RED: CourseCoordinates[] = [
  { holeNumber: 1,  tee: { lat: 40.7428432, lng: -73.4562572 }, green: { lat: 40.7464777, lng: -73.4547218 }, front: { lat: 40.7463604, lng: -73.4547714 }, back: { lat: 40.746595,  lng: -73.4546722 } },
  { holeNumber: 2,  tee: { lat: 40.7468278, lng: -73.4549495 }, green: { lat: 40.7461454, lng: -73.4590403 }, front: { lat: 40.7461719, lng: -73.4588815 }, back: { lat: 40.7461189, lng: -73.4591991 } },
  { holeNumber: 3,  tee: { lat: 40.7467033, lng: -73.4599324 }, green: { lat: 40.7476358, lng: -73.4561596 }, front: { lat: 40.7475976, lng: -73.4563142 }, back: { lat: 40.747674,  lng: -73.456005  } },
  { holeNumber: 4,  tee: { lat: 40.7475016, lng: -73.4554657 }, green: { lat: 40.7466565, lng: -73.4538068 }, front: { lat: 40.7467253, lng: -73.4539418 }, back: { lat: 40.7465877, lng: -73.4536718 } },
  { holeNumber: 5,  tee: { lat: 40.7472275, lng: -73.4533599 }, green: { lat: 40.7510531, lng: -73.4537163 }, front: { lat: 40.7509302, lng: -73.4537048 }, back: { lat: 40.751176,  lng: -73.4537278 } },
  { holeNumber: 6,  tee: { lat: 40.7511736, lng: -73.4544877 }, green: { lat: 40.7488088, lng: -73.455045  }, front: { lat: 40.7489301, lng: -73.4550164 }, back: { lat: 40.7486875, lng: -73.4550736 } },
  { holeNumber: 7,  tee: { lat: 40.748636,  lng: -73.455523  }, green: { lat: 40.7486597, lng: -73.4574195 }, front: { lat: 40.7486577, lng: -73.4572569 }, back: { lat: 40.7486617, lng: -73.4575821 } },
  { holeNumber: 8,  tee: { lat: 40.7482921, lng: -73.4584479 }, green: { lat: 40.7515855, lng: -73.4583189 }, front: { lat: 40.7514623, lng: -73.4583237 }, back: { lat: 40.7517087, lng: -73.4583141 } },
  { holeNumber: 9,  tee: { lat: 40.7519595, lng: -73.4591122 }, green: { lat: 40.7483036, lng: -73.4592576 }, front: { lat: 40.7484268, lng: -73.4592527 }, back: { lat: 40.7481804, lng: -73.4592625 } },
  { holeNumber: 10, tee: { lat: 40.7481814, lng: -73.4600593 }, green: { lat: 40.7516731, lng: -73.460245  }, front: { lat: 40.75155,   lng: -73.4602385 }, back: { lat: 40.7517962, lng: -73.4602515 } },
  { holeNumber: 11, tee: { lat: 40.7524212, lng: -73.4604914 }, green: { lat: 40.751611,  lng: -73.4558629 }, front: { lat: 40.7516387, lng: -73.4560214 }, back: { lat: 40.7515833, lng: -73.4557044 } },
  { holeNumber: 12, tee: { lat: 40.7515318, lng: -73.4547751 }, green: { lat: 40.7528214, lng: -73.4562412 }, front: { lat: 40.752728,  lng: -73.4561351 }, back: { lat: 40.7529148, lng: -73.4563473 } },
  { holeNumber: 13, tee: { lat: 40.7533466, lng: -73.456455  }, green: { lat: 40.7530701, lng: -73.4606763 }, front: { lat: 40.7530807, lng: -73.4605143 }, back: { lat: 40.7530595, lng: -73.4608383 } },
  { holeNumber: 14, tee: { lat: 40.752647,  lng: -73.4612203 }, green: { lat: 40.7492276, lng: -73.4613448 }, front: { lat: 40.7493508, lng: -73.4613403 }, back: { lat: 40.7491044, lng: -73.4613493 } },
  { holeNumber: 15, tee: { lat: 40.7490671, lng: -73.4608802 }, green: { lat: 40.7457242, lng: -73.4632916 }, front: { lat: 40.7458323, lng: -73.4632136 }, back: { lat: 40.7456161, lng: -73.4633696 } },
  { holeNumber: 16, tee: { lat: 40.7453517, lng: -73.4634438 }, green: { lat: 40.7450891, lng: -73.4580305 }, front: { lat: 40.745097,  lng: -73.4581928 }, back: { lat: 40.7450812, lng: -73.4578682 } },
  { holeNumber: 17, tee: { lat: 40.7449551, lng: -73.4575083 }, green: { lat: 40.7462275, lng: -73.4576721 }, front: { lat: 40.7461049, lng: -73.4576563 }, back: { lat: 40.7463501, lng: -73.4576879 } },
  { holeNumber: 18, tee: { lat: 40.746544,  lng: -73.4569085 }, green: { lat: 40.7427849, lng: -73.4568596 }, front: { lat: 40.7429081, lng: -73.4568612 }, back: { lat: 40.7426617, lng: -73.456858  } },
];

// ── Mock registry ──────────────────────────────────────────────────────────────
const MOCK_COORDS: Record<string, CourseCoordinates[]> = {
  [BETHPAGE_BLACK_ID]: MOCK_BLACK,
  [BETHPAGE_RED_ID]:   MOCK_RED,
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Return GolfAPI-verified per-hole coordinates for a course.
 *
 * Today this returns mock data derived from OSM centerlines for the two Bethpage
 * courses; all other courses get an empty array (OSM-only fallback).
 *
 * SWAP TO LIVE (one-line change):
 *   Set `USE_LIVE_GOLFAPI = true` at the top of this file, fill in
 *   `GOLFAPI_COURSE_ID_MAP`, and this function will call the real GolfAPI proxy
 *   (`fetchCourseCoordinates`) for any course that has a mapped ID.
 */
export async function getCourseCoordinates(courseId: string): Promise<CourseCoordinates[]> {
  // ── Live path (disabled until owner supplies token) ────────────────────────
  if (USE_LIVE_GOLFAPI) {
    const golfApiId = GOLFAPI_COURSE_ID_MAP[courseId];
    if (golfApiId) {
      return fetchCourseCoordinates(golfApiId);
    }
    return [];
  }

  // ── Mock path (default) ────────────────────────────────────────────────────
  return MOCK_COORDS[courseId] ?? [];
}

// ── F / C / B distance helper ──────────────────────────────────────────────────

export interface FCBDistances {
  /** Yards from player (or tee) to the front edge of the green. */
  front: number;
  /** Yards from player (or tee) to the center of the green. */
  center: number;
  /** Yards from player (or tee) to the back edge of the green. */
  back: number;
}

/**
 * Compute front / center / back-of-green distances from a given position.
 *
 * When `front` or `back` are absent on `coords` (e.g. live GolfAPI didn't
 * return them), falls back to the green center for that measurement.
 *
 * Pure function — no DOM, no network, headless-testable.
 */
export function computeFCBDistances(
  pos: { lat: number; lng: number },
  coords: Pick<CourseCoordinates, 'green' | 'front' | 'back'>
): FCBDistances {
  return {
    front:  yardsDistance(pos, coords.front  ?? coords.green),
    center: yardsDistance(pos, coords.green),
    back:   yardsDistance(pos, coords.back   ?? coords.green),
  };
}
