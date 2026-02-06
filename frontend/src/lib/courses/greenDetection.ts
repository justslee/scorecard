/*
  Green detection (client-side)

  Approach (fast + robust enough for a first pass):
  - Fetch a Mapbox Static Image for the course bbox/center
  - Convert pixels to HSV
  - Threshold on “healthy turf” greens
  - Run connected-components to find blobs
  - Score blobs by (color score, size, compactness)

  Returns candidate green centers (lng/lat) and confidence.
*/

export type LngLat = { lng: number; lat: number };

export type GreenCandidate = {
  id: string;
  center: LngLat;
  areaM2: number;
  confidence: number; // 0..1
  debug?: {
    pixels: number;
    bboxPx: { minX: number; minY: number; maxX: number; maxY: number };
  };
};

export type DetectGreensParams = {
  boundary: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  mapboxToken: string;
  /** optional hint; if omitted will be computed from boundary bbox */
  center?: LngLat;
  /** Output count target (18 or 9) */
  targetCount?: number;
  /** Mapbox style (defaults to satellite) */
  styleId?: string;
  /** Static image size */
  width?: number;
  height?: number;
  /** Clamp zoom */
  minZoom?: number;
  maxZoom?: number;
};

function bboxFromBoundary(boundary: GeoJSON.Polygon | GeoJSON.MultiPolygon) {
  const coords: Array<[number, number]> = [];
  if (boundary.type === 'Polygon') {
    for (const ring of boundary.coordinates) for (const p of ring) coords.push(p as any);
  } else {
    for (const poly of boundary.coordinates) for (const ring of poly) for (const p of ring) coords.push(p as any);
  }
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLng, minLat, maxLng, maxLat };
}

function metersPerPixel(lat: number, zoom: number) {
  // WebMercator approx
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

function chooseZoomForBbox(params: {
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  width: number;
  height: number;
  minZoom: number;
  maxZoom: number;
}) {
  const { bbox, width, height, minZoom, maxZoom } = params;
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;

  // Rough: compute needed meters-per-pixel to fit bbox into image.
  // Convert lng/lat span to meters using simple approximations.
  const latMeters = (bbox.maxLat - bbox.minLat) * 111320; // m per deg lat
  const lngMeters = (bbox.maxLng - bbox.minLng) * 111320 * Math.cos((centerLat * Math.PI) / 180);

  const neededMpp = Math.max(latMeters / height, lngMeters / width);

  // Solve for zoom: mpp = base*cos(lat)/2^zoom
  const base = 156543.03392 * Math.cos((centerLat * Math.PI) / 180);
  const zoom = Math.log2(base / Math.max(neededMpp, 0.000001));

  return Math.max(minZoom, Math.min(maxZoom, Math.round(zoom)));
}

function rgbToHsv(r: number, g: number, b: number) {
  const rr = r / 255,
    gg = g / 255,
    bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

function pointInPolygon(px: number, py: number, ring: Array<[number, number]>) {
  // ray casting algorithm
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];

    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function boundaryContainsLngLat(boundary: GeoJSON.Polygon | GeoJSON.MultiPolygon, lng: number, lat: number) {
  if (boundary.type === 'Polygon') {
    const ring = boundary.coordinates[0] as any as Array<[number, number]>;
    return pointInPolygon(lng, lat, ring);
  }
  // MultiPolygon: accept if inside any outer ring
  for (const poly of boundary.coordinates) {
    const ring = poly[0] as any as Array<[number, number]>;
    if (pointInPolygon(lng, lat, ring)) return true;
  }
  return false;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

export async function detectGreens(params: DetectGreensParams): Promise<{ imageUrl: string; zoom: number; candidates: GreenCandidate[] }> {
  const {
    boundary,
    mapboxToken,
    center,
    targetCount = 18,
    styleId = 'mapbox/satellite-v9',
    width = 1024,
    height = 1024,
    minZoom = 15,
    maxZoom = 19,
  } = params;

  if (!mapboxToken) throw new Error('Missing Mapbox token');

  const bbox = bboxFromBoundary(boundary);
  const computedCenter = center || { lng: (bbox.minLng + bbox.maxLng) / 2, lat: (bbox.minLat + bbox.maxLat) / 2 };
  const zoom = chooseZoomForBbox({ bbox, width, height, minZoom, maxZoom });

  const imageUrl = `https://api.mapbox.com/styles/v1/${styleId}/static/${computedCenter.lng},${computedCenter.lat},${zoom}/${width}x${height}?access_token=${encodeURIComponent(
    mapboxToken
  )}`;

  const img = await loadImage(imageUrl);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  // Map pixel -> lng/lat by linear interpolation across bbox.
  // Note: static images are WebMercator; this is an approximation but ok for small areas.
  const lngPerPx = (bbox.maxLng - bbox.minLng) / width;
  const latPerPx = (bbox.maxLat - bbox.minLat) / height;

  const mask = new Uint8Array(width * height);

  // Color thresholding
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx],
        g = data[idx + 1],
        b = data[idx + 2];

      // quick reject non-greenish
      if (g < 80 || g < r + 15 || g < b + 15) continue;

      const { h, s, v } = rgbToHsv(r, g, b);
      // healthy turf: hue in green range, moderately saturated, not too dark
      const isGreen = h >= 70 && h <= 165 && s >= 0.25 && v >= 0.20;
      if (!isGreen) continue;

      const lng = bbox.minLng + (x + 0.5) * lngPerPx;
      const lat = bbox.maxLat - (y + 0.5) * latPerPx;

      if (!boundaryContainsLngLat(boundary, lng, lat)) continue;

      // Mark as green pixel
      mask[y * width + x] = 1;
    }
  }

  // Connected components (4-neighbor)
  const visited = new Uint8Array(width * height);
  const components: Array<{
    pixels: number;
    sumX: number;
    sumY: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    // boundary-ish count
    edge: number;
  }> = [];

  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);

  const push = (qx: number, qy: number, tail: number) => {
    queueX[tail] = qx;
    queueY[tail] = qy;
    return tail + 1;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!mask[p] || visited[p]) continue;

      let head = 0,
        tail = 0;
      tail = push(x, y, tail);
      visited[p] = 1;

      const comp = { pixels: 0, sumX: 0, sumY: 0, minX: x, minY: y, maxX: x, maxY: y, edge: 0 };

      while (head < tail) {
        const cx = queueX[head];
        const cy = queueY[head];
        head++;

        comp.pixels++;
        comp.sumX += cx;
        comp.sumY += cy;
        comp.minX = Math.min(comp.minX, cx);
        comp.minY = Math.min(comp.minY, cy);
        comp.maxX = Math.max(comp.maxX, cx);
        comp.maxY = Math.max(comp.maxY, cy);

        // Count edges: if any neighbor is 0
        const n0 = cy === 0 ? 0 : mask[(cy - 1) * width + cx];
        const n1 = cy === height - 1 ? 0 : mask[(cy + 1) * width + cx];
        const n2 = cx === 0 ? 0 : mask[cy * width + (cx - 1)];
        const n3 = cx === width - 1 ? 0 : mask[cy * width + (cx + 1)];
        if (!n0 || !n1 || !n2 || !n3) comp.edge++;

        // neighbors
        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const np = ny * width + nx;
          if (!mask[np] || visited[np]) continue;
          visited[np] = 1;
          tail = push(nx, ny, tail);
        }
      }

      // Filter tiny specks early
      if (comp.pixels < 50) continue;
      components.push(comp);
    }
  }

  const mpp = metersPerPixel(computedCenter.lat, zoom);

  const candidates: GreenCandidate[] = components
    .map((c) => {
      const cx = c.sumX / c.pixels;
      const cy = c.sumY / c.pixels;

      const centerLng = bbox.minLng + (cx + 0.5) * lngPerPx;
      const centerLat = bbox.maxLat - (cy + 0.5) * latPerPx;

      const areaM2 = c.pixels * mpp * mpp;

      // shape heuristics
      const w = c.maxX - c.minX + 1;
      const h = c.maxY - c.minY + 1;
      const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
      const bboxArea = w * h;
      const fill = c.pixels / Math.max(1, bboxArea);
      const perimeterApprox = c.edge; // not true perimeter but correlates
      const compactness = (4 * Math.PI * c.pixels) / Math.max(1, perimeterApprox * perimeterApprox);

      // size scoring around 400-800 m^2 (wide tolerance)
      const sizeScore =
        areaM2 < 150
          ? 0
          : areaM2 < 300
            ? 0.3
            : areaM2 <= 1400
              ? 1
              : areaM2 <= 2500
                ? 0.6
                : 0.2;

      const aspectScore = aspect <= 2.2 ? 1 : aspect <= 3.5 ? 0.6 : 0.2;
      const fillScore = fill >= 0.25 ? (fill >= 0.45 ? 1 : 0.7) : 0.3;
      const compactScore = compactness >= 0.08 ? 1 : compactness >= 0.04 ? 0.6 : 0.2;

      const confidence = Math.max(
        0,
        Math.min(1, 0.40 * sizeScore + 0.20 * aspectScore + 0.20 * fillScore + 0.20 * compactScore)
      );

      return {
        id: crypto.randomUUID(),
        center: { lng: centerLng, lat: centerLat },
        areaM2,
        confidence,
        debug: {
          pixels: c.pixels,
          bboxPx: { minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY },
        },
      };
    })
    // ensure center is inside boundary
    .filter((c) => boundaryContainsLngLat(boundary, c.center.lng, c.center.lat))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.max(targetCount * 2, 36));

  // NMS-like: remove near-duplicates (within ~15m)
  const deduped: GreenCandidate[] = [];
  const minDistM = 15;

  const distM = (a: LngLat, b: LngLat) => {
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180;
    const la2 = (b.lat * Math.PI) / 180;
    const x = dLng * Math.cos((la1 + la2) / 2);
    const y = dLat;
    return Math.sqrt(x * x + y * y) * R;
  };

  for (const c of candidates) {
    if (deduped.some((d) => distM(d.center, c.center) < minDistM)) continue;
    deduped.push(c);
    if (deduped.length >= targetCount) break;
  }

  return { imageUrl, zoom, candidates: deduped };
}
