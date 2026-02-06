'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Upload,
  Target,
  Flag,
  Droplets,
  Circle,
  Square,
  Trash2,
  Layers,
  Search,
  Save,
  MapPin,
} from 'lucide-react';
import type { CourseData, FeatureType } from '@/lib/courses/types';
import { detectGreens, type GreenCandidate } from '@/lib/courses/greenDetection';
import { sequenceHolesFromGreens } from '@/lib/courses/holeSequencing';
import { estimateTees } from '@/lib/courses/teeEstimation';

const DEFAULT_TEE_SETS = [
  { name: 'Black', color: '#1a1a1a' },
  { name: 'Blue', color: '#2563eb' },
  { name: 'White', color: '#e5e5e5' },
  { name: 'Red', color: '#dc2626' },
];

const FEATURE_STYLES: Record<
  FeatureType,
  { color: string; label: string; icon: React.ReactNode }
> = {
  tee: { color: '#3b82f6', label: 'Tee Box', icon: <Square className="w-4 h-4" /> },
  fairway: { color: '#22c55e', label: 'Fairway', icon: <Layers className="w-4 h-4" /> },
  green: { color: '#10b981', label: 'Green', icon: <Circle className="w-4 h-4" /> },
  bunker: { color: '#fbbf24', label: 'Bunker', icon: <Circle className="w-4 h-4" /> },
  water: { color: '#0ea5e9', label: 'Water', icon: <Droplets className="w-4 h-4" /> },
  ob: { color: '#ef4444', label: 'OB', icon: <Square className="w-4 h-4" /> },
  target: { color: '#f97316', label: 'Target', icon: <Target className="w-4 h-4" /> },
  pin: { color: '#dc2626', label: 'Pin', icon: <Flag className="w-4 h-4" /> },
};

function newBlankCourse(): CourseData {
  return {
    id: crypto.randomUUID(),
    name: 'New Course',
    location: { lat: 40.7128, lng: -74.006 },
    teeSets: DEFAULT_TEE_SETS,
    holes: Array.from({ length: 18 }, (_, i) => ({
      number: i + 1,
      par: 4,
      handicap: i + 1,
      yardages: { Black: 0, Blue: 0, White: 0, Red: 0 },
      features: { type: 'FeatureCollection' as const, features: [] },
    })),
  };
}

export default function CourseEditorPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const draw = useRef<MapboxDraw | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const courseIdFromQuery = searchParams.get('id');

  const [isLoaded, setIsLoaded] = useState(false);
  const [currentHole, setCurrentHole] = useState(1);
  const [drawMode, setDrawMode] = useState<FeatureType>('green');
  const [selectedTeeSet, setSelectedTeeSet] = useState('Blue');
  const [searchQuery, setSearchQuery] = useState('');

  const [courseData, setCourseData] = useState<CourseData>(newBlankCourse());
  const [osmCourses, setOsmCourses] = useState<
    Array<{
      osmId: string;
      name: string;
      center?: { lat: number; lng: number };
      boundary: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    }>
  >([]);
  const [selectedOsmId, setSelectedOsmId] = useState<string>('');
  const [autoStatus, setAutoStatus] = useState<string | null>(null);
  const [lastGreenCandidates, setLastGreenCandidates] = useState<GreenCandidate[] | null>(null);
  const [cloudStatus, setCloudStatus] = useState<string | null>(null);
  const [gpsPos, setGpsPos] = useState<{ lat: number; lng: number; acc?: number } | null>(null);
  const [gpsWatchId, setGpsWatchId] = useState<number | null>(null);

  const currentHoleData = courseData.holes[currentHole - 1];

  // Load course if id is provided
  useEffect(() => {
    if (!courseIdFromQuery) return;

    let cancelled = false;
    (async () => {
      try {
        setCloudStatus('Loading…');
        const res = await fetch(`/api/courses/${encodeURIComponent(courseIdFromQuery)}`);
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = await res.json();
        if (!cancelled && data.course) {
          setCourseData(data.course as CourseData);
          setCloudStatus(null);
        }
      } catch (e) {
        if (!cancelled) {
          setCloudStatus(e instanceof Error ? e.message : 'Load failed');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [courseIdFromQuery]);

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [courseData.location.lng, courseData.location.lat],
      zoom: 17,
      pitch: 0,
      bearing: 0,
    });

    draw.current = new MapboxDraw({
      displayControlsDefault: false,
      controls: {},
      defaultMode: 'simple_select',
      styles: [
        {
          id: 'gl-draw-polygon-fill',
          type: 'fill',
          filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
          paint: {
            'fill-color': ['coalesce', ['get', 'user_color'], '#22c55e'],
            'fill-opacity': 0.3,
          },
        },
        {
          id: 'gl-draw-polygon-stroke',
          type: 'line',
          filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
          paint: {
            'line-color': ['coalesce', ['get', 'user_color'], '#22c55e'],
            'line-width': 2,
          },
        },
        {
          id: 'gl-draw-point',
          type: 'circle',
          filter: ['all', ['==', '$type', 'Point'], ['!=', 'mode', 'static']],
          paint: {
            'circle-radius': 8,
            'circle-color': ['coalesce', ['get', 'user_color'], '#ef4444'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        },
        {
          id: 'gl-draw-polygon-and-line-vertex-active',
          type: 'circle',
          filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
          paint: {
            'circle-radius': 6,
            'circle-color': '#ffffff',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#3b82f6',
          },
        },
      ],
    });

    map.current.addControl(draw.current);
    map.current.addControl(new mapboxgl.NavigationControl(), 'bottom-right');

    map.current.on('load', () => {
      setIsLoaded(true);
      const m = map.current;
      if (!m) return;

      // Boundary overlay (if/when present)
      if (!m.getSource('course-boundary')) {
        m.addSource('course-boundary', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        m.addLayer({
          id: 'course-boundary-fill',
          type: 'fill',
          source: 'course-boundary',
          paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.08 },
        });
        m.addLayer({
          id: 'course-boundary-line',
          type: 'line',
          source: 'course-boundary',
          paint: { 'line-color': '#22c55e', 'line-width': 2, 'line-opacity': 0.7 },
        });
      }
    });

    // Handle draw events
    map.current.on('draw.create', handleDrawCreate);
    map.current.on('draw.update', handleDrawUpdate);
    map.current.on('draw.delete', handleDrawDelete);

    return () => {
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fly when course center changes (e.g. after search / load)
  useEffect(() => {
    if (!map.current) return;
    map.current.flyTo({ center: [courseData.location.lng, courseData.location.lat], zoom: 17 });
  }, [courseData.location.lat, courseData.location.lng]);

  // Update boundary overlay
  useEffect(() => {
    if (!map.current) return;
    const src = map.current.getSource('course-boundary') as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;

    if (courseData.boundary) {
      src.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { kind: 'course-boundary' },
            geometry: courseData.boundary as any,
          },
        ],
      });
    } else {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [courseData.boundary]);

  // Load hole features when hole changes
  useEffect(() => {
    if (!draw.current || !isLoaded) return;

    draw.current.deleteAll();
    const holeFeatures = courseData.holes[currentHole - 1].features;
    if (holeFeatures.features.length > 0) {
      draw.current.set(holeFeatures);
    }
  }, [currentHole, isLoaded, courseData.holes]);

  const handleDrawCreate = useCallback(
    (e: { features: GeoJSON.Feature[] }) => {
      const feature = e.features[0];
      if (!feature) return;

      const featureWithMeta = {
        ...feature,
        properties: {
          ...feature.properties,
          featureType: drawMode,
          hole: currentHole,
          teeSet: drawMode === 'tee' ? selectedTeeSet : undefined,
          color: FEATURE_STYLES[drawMode].color,
          user_color: FEATURE_STYLES[drawMode].color,
        },
      };

      if (draw.current && feature.id) {
        draw.current.setFeatureProperty(feature.id as string, 'featureType', drawMode);
        draw.current.setFeatureProperty(feature.id as string, 'hole', currentHole);
        draw.current.setFeatureProperty(feature.id as string, 'color', FEATURE_STYLES[drawMode].color);
        draw.current.setFeatureProperty(
          feature.id as string,
          'user_color',
          FEATURE_STYLES[drawMode].color
        );
        if (drawMode === 'tee') {
          draw.current.setFeatureProperty(feature.id as string, 'teeSet', selectedTeeSet);
        }
      }

      setCourseData((prev) => {
        const newHoles = [...prev.holes];
        const holeData = newHoles[currentHole - 1];
        const existingFeatures = holeData.features.features.filter((f) => f.id !== feature.id);
        holeData.features = {
          type: 'FeatureCollection',
          features: [...existingFeatures, featureWithMeta as GeoJSON.Feature],
        };
        return { ...prev, holes: newHoles };
      });
    },
    [drawMode, currentHole, selectedTeeSet]
  );

  const handleDrawUpdate = useCallback(
    (e: { features: GeoJSON.Feature[] }) => {
      const feature = e.features[0];
      if (!feature) return;

      setCourseData((prev) => {
        const newHoles = [...prev.holes];
        const holeData = newHoles[currentHole - 1];
        const featureIndex = holeData.features.features.findIndex((f) => f.id === feature.id);
        if (featureIndex >= 0) {
          holeData.features.features[featureIndex] = {
            ...feature,
            properties: {
              ...holeData.features.features[featureIndex].properties,
              ...feature.properties,
            },
          };
        }
        return { ...prev, holes: newHoles };
      });
    },
    [currentHole]
  );

  const handleDrawDelete = useCallback(
    (e: { features: GeoJSON.Feature[] }) => {
      const deletedIds = e.features.map((f) => f.id);

      setCourseData((prev) => {
        const newHoles = [...prev.holes];
        const holeData = newHoles[currentHole - 1];
        holeData.features = {
          type: 'FeatureCollection',
          features: holeData.features.features.filter((f) => !deletedIds.includes(f.id)),
        };
        return { ...prev, holes: newHoles };
      });
    },
    [currentHole]
  );

  const startDrawing = (type: FeatureType) => {
    setDrawMode(type);
    if (!draw.current) return;

    if (type === 'pin' || type === 'target') {
      draw.current.changeMode('draw_point');
    } else {
      draw.current.changeMode('draw_polygon');
    }
  };

  const handleSearch = async () => {
    if (!searchQuery || !map.current) return;

    try {
      const response = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
          searchQuery
        )}.json?access_token=${mapboxgl.accessToken}&types=poi,address&limit=1`
      );
      const data = await response.json();

      if (data.features && data.features[0]) {
        const [lng, lat] = data.features[0].center;
        map.current.flyTo({ center: [lng, lat], zoom: 17 });
        setCourseData((prev) => ({
          ...prev,
          name: data.features[0].text || prev.name,
          location: { lat, lng },
          address: data.features[0].place_name,
        }));
      }
    } catch (error) {
      console.error('Search failed:', error);
    }
  };

  const handleOsmSearch = async () => {
    if (!searchQuery) return;
    try {
      setAutoStatus('Searching OSM…');
      const res = await fetch(`/api/courses/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `OSM search failed (${res.status})`);
      setOsmCourses(Array.isArray(data.courses) ? data.courses : []);
      setSelectedOsmId('');
      setAutoStatus(null);
    } catch (e) {
      setAutoStatus(e instanceof Error ? e.message : 'OSM search failed');
    }
  };

  const applyOsmCourse = () => {
    const picked = osmCourses.find((c) => c.osmId === selectedOsmId);
    if (!picked) return;
    const center = picked.center;
    setCourseData((prev) => ({
      ...prev,
      name: picked.name || prev.name,
      location: center ? center : prev.location,
      boundary: picked.boundary,
    }));
    if (center && map.current) {
      map.current.flyTo({ center: [center.lng, center.lat], zoom: 16 });
    }
  };

  const runGreenDetection = async () => {
    if (!courseData.boundary) {
      alert('Load a course boundary first (OSM search → select course)');
      return;
    }
    try {
      setAutoStatus('Detecting greens…');
      const token = (process.env.NEXT_PUBLIC_MAPBOX_TOKEN || mapboxgl.accessToken || '') as string;
      if (!token) throw new Error('Missing NEXT_PUBLIC_MAPBOX_TOKEN');
      const { candidates } = await detectGreens({
        boundary: courseData.boundary,
        mapboxToken: token,
        center: courseData.location,
        targetCount: 18,
      });

      setLastGreenCandidates(candidates);

      const sequenced = sequenceHolesFromGreens(candidates, 18);

      setCourseData((prev) => {
        const newHoles = prev.holes.map((h) => {
          // drop existing auto greens
          const kept = h.features.features.filter(
            (f) => !(f.properties?.featureType === 'green' && f.properties?.source === 'auto')
          );
          return { ...h, features: { type: 'FeatureCollection' as const, features: kept } };
        });

        for (const s of sequenced) {
          const holeIdx = s.holeNumber - 1;
          if (!newHoles[holeIdx]) continue;
          const feature: GeoJSON.Feature = {
            type: 'Feature',
            id: crypto.randomUUID(),
            geometry: { type: 'Point', coordinates: [s.green.lng, s.green.lat] },
            properties: {
              featureType: 'green',
              hole: s.holeNumber,
              color: FEATURE_STYLES.green.color,
              user_color: FEATURE_STYLES.green.color,
              source: 'auto',
            },
          };
          newHoles[holeIdx].features = {
            type: 'FeatureCollection' as const,
            features: [...newHoles[holeIdx].features.features, feature],
          };
        }

        return { ...prev, holes: newHoles };
      });

      setAutoStatus(`Detected ${candidates.length} greens (auto-added).`);
      setTimeout(() => setAutoStatus(null), 2500);
    } catch (e) {
      setAutoStatus(e instanceof Error ? e.message : 'Green detection failed');
    }
  };

  const calculateTeesFromYardage = () => {
    // Pull 1 green per hole (auto or manual) and estimate tees for each tee set
    const sequencedGreens = courseData.holes
      .map((h) => {
        const gf = h.features.features.find((f) => f.properties?.featureType === 'green');
        if (!gf || gf.geometry.type !== 'Point') return null;
        const [lng, lat] = gf.geometry.coordinates as any as [number, number];
        return { holeNumber: h.number, green: { lng, lat } };
      })
      .filter(Boolean) as Array<{ holeNumber: number; green: { lng: number; lat: number } }>;

    if (sequencedGreens.length < 2) {
      alert('Need greens placed for at least a couple holes first.');
      return;
    }

    const yardagesByHole = courseData.holes.map((h) => ({ holeNumber: h.number, yardages: h.yardages }));
    const teeSetNames = courseData.teeSets.map((t) => t.name);

    const tees = estimateTees({ sequencedGreens, yardagesByHole, teeSetNames });

    setCourseData((prev) => {
      const newHoles = prev.holes.map((h) => {
        const kept = h.features.features.filter(
          (f) => !(f.properties?.featureType === 'tee' && f.properties?.source === 'auto')
        );
        return { ...h, features: { type: 'FeatureCollection' as const, features: kept } };
      });

      for (const t of tees) {
        const holeIdx = t.holeNumber - 1;
        if (!newHoles[holeIdx]) continue;
        const feature: GeoJSON.Feature = {
          type: 'Feature',
          id: crypto.randomUUID(),
          geometry: { type: 'Point', coordinates: [t.tee.lng, t.tee.lat] },
          properties: {
            featureType: 'tee',
            hole: t.holeNumber,
            teeSet: t.teeSet,
            color: FEATURE_STYLES.tee.color,
            user_color: FEATURE_STYLES.tee.color,
            source: 'auto',
            yards: t.yards,
          },
        };
        newHoles[holeIdx].features = {
          type: 'FeatureCollection' as const,
          features: [...newHoles[holeIdx].features.features, feature],
        };
      }

      return { ...prev, holes: newHoles };
    });

    setAutoStatus(`Estimated tees for ${tees.length} tee markers.`);
    setTimeout(() => setAutoStatus(null), 2500);
  };

  const exportCourse = () => {
    const dataStr = JSON.stringify(courseData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${courseData.name.replace(/\s+/g, '-').toLowerCase()}-course.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importCourse = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string) as CourseData;
        setCourseData(imported);
        router.replace(`/courses/editor?id=${encodeURIComponent(imported.id)}`);
      } catch (error) {
        console.error('Import failed:', error);
        alert('Failed to import course file');
      }
    };
    reader.readAsText(file);
  };

  const saveToCloud = async () => {
    try {
      setCloudStatus('Saving…');
      const res = await fetch(`/api/courses/${encodeURIComponent(courseData.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(courseData),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Save failed (${res.status})`);
      setCourseData(data.course as CourseData);
      setCloudStatus('Saved');
      setTimeout(() => setCloudStatus(null), 1500);
      router.replace(`/courses/editor?id=${encodeURIComponent(courseData.id)}`);
    } catch (e) {
      setCloudStatus(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const startGps = () => {
    if (gpsWatchId !== null) return;
    if (!('geolocation' in navigator)) {
      alert('Geolocation not supported');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsPos({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: pos.coords.accuracy,
        });
      },
      (err) => {
        console.error(err);
        alert(err.message);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
    setGpsWatchId(id);
  };

  const stopGps = () => {
    if (gpsWatchId === null) return;
    navigator.geolocation.clearWatch(gpsWatchId);
    setGpsWatchId(null);
  };

  const captureGpsPoint = () => {
    if (!gpsPos || !draw.current) {
      alert('No GPS fix yet');
      return;
    }

    const id = crypto.randomUUID();
    const point: GeoJSON.Feature = {
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [gpsPos.lng, gpsPos.lat] },
      properties: {
        featureType: drawMode,
        hole: currentHole,
        teeSet: drawMode === 'tee' ? selectedTeeSet : undefined,
        color: FEATURE_STYLES[drawMode].color,
        user_color: FEATURE_STYLES[drawMode].color,
        gpsAccuracy: gpsPos.acc,
        source: 'gps',
      },
    };

    draw.current.add(point as any);

    setCourseData((prev) => {
      const newHoles = [...prev.holes];
      const holeData = newHoles[currentHole - 1];
      holeData.features = {
        type: 'FeatureCollection',
        features: [...holeData.features.features, point],
      };
      return { ...prev, holes: newHoles };
    });
  };

  const updateHolePar = (par: number) => {
    setCourseData((prev) => {
      const newHoles = [...prev.holes];
      newHoles[currentHole - 1].par = par;
      return { ...prev, holes: newHoles };
    });
  };

  const updateHoleYardage = (tee: string, yardage: number) => {
    setCourseData((prev) => {
      const newHoles = [...prev.holes];
      newHoles[currentHole - 1].yardages[tee] = yardage;
      return { ...prev, holes: newHoles };
    });
  };

  return (
    <div className="h-screen w-screen flex bg-zinc-950">
      {/* Left Sidebar */}
      <div className="w-80 bg-zinc-900 border-r border-zinc-800 flex flex-col overflow-hidden">
        {/* Course Search */}
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-bold text-white">Course Editor</h1>
            <button
              onClick={saveToCloud}
              className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              Save
            </button>
          </div>
          {cloudStatus ? (
            <div className="text-xs text-zinc-400 mt-2">{cloudStatus}</div>
          ) : null}

          <div className="flex gap-2 mt-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search course or address..."
              className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button
              onClick={handleSearch}
              className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg hover:bg-zinc-700"
            >
              <Search className="w-4 h-4 text-zinc-400" />
            </button>
          </div>
          <input
            type="text"
            value={courseData.name}
            onChange={(e) => setCourseData((prev) => ({ ...prev, name: e.target.value }))}
            className="w-full mt-2 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            placeholder="Course name"
          />

          {/* Auto-detect tools */}
          <div className="mt-3 p-3 rounded-xl bg-zinc-950/40 border border-zinc-800">
            <div className="text-sm font-semibold text-zinc-300">Auto-Detect</div>
            <div className="text-xs text-zinc-500 mt-1">
              1) Search OSM for boundary → 2) Detect greens → 3) Estimate tees.
            </div>

            {autoStatus ? <div className="text-xs text-zinc-400 mt-2">{autoStatus}</div> : null}

            <div className="flex gap-2 mt-2">
              <button
                onClick={handleOsmSearch}
                className="flex-1 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-white"
              >
                Search OSM
              </button>
              <button
                onClick={() => {
                  setOsmCourses([]);
                  setSelectedOsmId('');
                }}
                className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300"
                title="Clear"
              >
                Clear
              </button>
            </div>

            {osmCourses.length ? (
              <div className="mt-2 space-y-2">
                <select
                  value={selectedOsmId}
                  onChange={(e) => setSelectedOsmId(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-xs"
                >
                  <option value="">Select OSM result…</option>
                  {osmCourses.map((c) => (
                    <option key={c.osmId} value={c.osmId}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={applyOsmCourse}
                  disabled={!selectedOsmId}
                  className="w-full px-3 py-2 rounded-lg bg-emerald-700 disabled:opacity-40 hover:bg-emerald-600 text-xs text-white"
                >
                  Load Boundary
                </button>
              </div>
            ) : null}

            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                onClick={runGreenDetection}
                disabled={!courseData.boundary}
                className="px-3 py-2 rounded-lg bg-emerald-600 disabled:opacity-40 hover:bg-emerald-500 text-xs text-white"
              >
                Detect Greens
              </button>
              <button
                onClick={calculateTeesFromYardage}
                className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-white"
              >
                Calculate Tees
              </button>
            </div>

            {lastGreenCandidates ? (
              <div className="text-[11px] text-zinc-500 mt-2">
                Last detection: {lastGreenCandidates.length} greens.
              </div>
            ) : null}
          </div>
        </div>

        {/* Hole Navigation */}
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setCurrentHole((h) => Math.max(1, h - 1))}
              disabled={currentHole === 1}
              className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50"
            >
              <ChevronLeft className="w-5 h-5 text-white" />
            </button>
            <span className="text-xl font-bold text-white">Hole {currentHole}</span>
            <button
              onClick={() => setCurrentHole((h) => Math.min(18, h + 1))}
              disabled={currentHole === 18}
              className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50"
            >
              <ChevronRight className="w-5 h-5 text-white" />
            </button>
          </div>

          {/* Par Selection */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm text-zinc-400 w-12">Par:</span>
            <div className="flex gap-1">
              {[3, 4, 5].map((par) => (
                <button
                  key={par}
                  onClick={() => updateHolePar(par)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    currentHoleData.par === par
                      ? 'bg-emerald-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  {par}
                </button>
              ))}
            </div>
          </div>

          {/* Yardages */}
          <div className="space-y-2">
            {courseData.teeSets.map((tee) => (
              <div key={tee.name} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: tee.color }} />
                <span className="text-sm text-zinc-400 w-14">{tee.name}:</span>
                <input
                  type="number"
                  value={currentHoleData.yardages[tee.name] || ''}
                  onChange={(e) => updateHoleYardage(tee.name, parseInt(e.target.value) || 0)}
                  className="flex-1 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  placeholder="0"
                />
                <span className="text-xs text-zinc-500">yds</span>
              </div>
            ))}
          </div>
        </div>

        {/* Drawing Tools */}
        <div className="p-4 border-b border-zinc-800 flex-1 overflow-y-auto">
          <h3 className="text-sm font-semibold text-zinc-400 mb-3">Draw Features</h3>

          {drawMode === 'tee' && (
            <div className="mb-3">
              <select
                value={selectedTeeSet}
                onChange={(e) => setSelectedTeeSet(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm"
              >
                {courseData.teeSets.map((tee) => (
                  <option key={tee.name} value={tee.name}>
                    {tee.name} Tees
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {(Object.entries(FEATURE_STYLES) as Array<
              [FeatureType, (typeof FEATURE_STYLES)[FeatureType]]
            >).map(([type, style]) => (
              <button
                key={type}
                onClick={() => startDrawing(type)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  drawMode === type ? 'ring-2 ring-offset-2 ring-offset-zinc-900' : 'hover:bg-zinc-800'
                }`}
                style={{
                  backgroundColor: drawMode === type ? style.color + '30' : undefined,
                  color: style.color,
                  boxShadow: drawMode === type ? `0 0 0 2px ${style.color}` : undefined,
                }}
              >
                {style.icon}
                {style.label}
              </button>
            ))}
          </div>

          <button
            onClick={() => draw.current?.changeMode('simple_select')}
            className="w-full mt-3 px-3 py-2 bg-zinc-800 text-zinc-300 rounded-lg text-sm hover:bg-zinc-700"
          >
            Select / Edit Mode
          </button>

          <button
            onClick={() => {
              const selected = draw.current?.getSelected();
              if (selected?.features.length) {
                draw.current?.delete(selected.features.map((f) => f.id as string));
              }
            }}
            className="w-full mt-2 px-3 py-2 bg-red-900/30 text-red-400 rounded-lg text-sm hover:bg-red-900/50 flex items-center justify-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Delete Selected
          </button>

          {/* Phase 5: On-course GPS collection */}
          <div className="mt-4 p-3 rounded-xl bg-zinc-950/40 border border-zinc-800">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
                <MapPin className="w-4 h-4" /> GPS Collect
              </div>
              {gpsWatchId === null ? (
                <button
                  onClick={startGps}
                  className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
                >
                  Start
                </button>
              ) : (
                <button
                  onClick={stopGps}
                  className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700"
                >
                  Stop
                </button>
              )}
            </div>
            <div className="text-xs text-zinc-500 mt-2">
              {gpsPos
                ? `Fix: ${gpsPos.lat.toFixed(6)}, ${gpsPos.lng.toFixed(6)} (±${Math.round(
                    gpsPos.acc || 0
                  )}m)`
                : 'No fix yet'}
            </div>
            <button
              onClick={captureGpsPoint}
              disabled={!gpsPos}
              className="w-full mt-2 px-3 py-2 rounded-lg bg-emerald-600 disabled:opacity-40 hover:bg-emerald-500 text-white text-sm"
            >
              Capture as “{FEATURE_STYLES[drawMode].label}”
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-zinc-800 space-y-2">
          <button
            onClick={exportCourse}
            className="w-full px-4 py-2.5 bg-zinc-800 text-white rounded-lg font-medium hover:bg-zinc-700 flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" />
            Export JSON
          </button>
          <label className="w-full px-4 py-2.5 bg-zinc-800 text-white rounded-lg font-medium hover:bg-zinc-700 flex items-center justify-center gap-2 cursor-pointer">
            <Upload className="w-4 h-4" />
            Import JSON
            <input type="file" accept=".json" onChange={importCourse} className="hidden" />
          </label>
        </div>
      </div>

      {/* Map Container */}
      <div ref={mapContainer} className="flex-1" />

      {/* Hole Quick Nav */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1 bg-zinc-900/90 backdrop-blur rounded-xl p-2 border border-zinc-800">
        {Array.from({ length: 18 }, (_, i) => i + 1).map((hole) => {
          const hasFeatures = courseData.holes[hole - 1].features.features.length > 0;
          return (
            <button
              key={hole}
              onClick={() => setCurrentHole(hole)}
              className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
                currentHole === hole
                  ? 'bg-emerald-600 text-white'
                  : hasFeatures
                    ? 'bg-zinc-700 text-white'
                    : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'
              }`}
            >
              {hole}
            </button>
          );
        })}
      </div>
    </div>
  );
}
