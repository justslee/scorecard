'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { 
  ChevronLeft, 
  ChevronRight, 
  Save, 
  Download, 
  Upload,
  MapPin,
  Target,
  Flag,
  Droplets,
  Circle,
  Square,
  Trash2,
  Layers,
  Search
} from 'lucide-react';

// Feature types for golf course mapping
type FeatureType = 'tee' | 'fairway' | 'green' | 'bunker' | 'water' | 'ob' | 'target' | 'pin';

interface HoleData {
  number: number;
  par: number;
  handicap: number;
  yardages: Record<string, number>; // tee name -> yardage
  features: GeoJSON.FeatureCollection;
}

interface CourseData {
  id: string;
  name: string;
  location: { lat: number; lng: number };
  address?: string;
  teeSets: Array<{ name: string; color: string }>;
  holes: HoleData[];
}

const DEFAULT_TEE_SETS = [
  { name: 'Black', color: '#1a1a1a' },
  { name: 'Blue', color: '#2563eb' },
  { name: 'White', color: '#e5e5e5' },
  { name: 'Red', color: '#dc2626' },
];

const FEATURE_STYLES: Record<FeatureType, { color: string; label: string; icon: React.ReactNode }> = {
  tee: { color: '#3b82f6', label: 'Tee Box', icon: <Square className="w-4 h-4" /> },
  fairway: { color: '#22c55e', label: 'Fairway', icon: <Layers className="w-4 h-4" /> },
  green: { color: '#10b981', label: 'Green', icon: <Circle className="w-4 h-4" /> },
  bunker: { color: '#fbbf24', label: 'Bunker', icon: <Circle className="w-4 h-4" /> },
  water: { color: '#0ea5e9', label: 'Water', icon: <Droplets className="w-4 h-4" /> },
  ob: { color: '#ef4444', label: 'OB', icon: <Square className="w-4 h-4" /> },
  target: { color: '#f97316', label: 'Target', icon: <Target className="w-4 h-4" /> },
  pin: { color: '#dc2626', label: 'Pin', icon: <Flag className="w-4 h-4" /> },
};

export default function CourseEditorPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const draw = useRef<MapboxDraw | null>(null);
  
  const [isLoaded, setIsLoaded] = useState(false);
  const [currentHole, setCurrentHole] = useState(1);
  const [drawMode, setDrawMode] = useState<FeatureType>('green');
  const [selectedTeeSet, setSelectedTeeSet] = useState('Blue');
  const [searchQuery, setSearchQuery] = useState('');
  
  const [courseData, setCourseData] = useState<CourseData>({
    id: crypto.randomUUID(),
    name: 'New Course',
    location: { lat: 40.7128, lng: -74.006 },
    teeSets: DEFAULT_TEE_SETS,
    holes: Array.from({ length: 18 }, (_, i) => ({
      number: i + 1,
      par: 4,
      handicap: i + 1,
      yardages: { Black: 0, Blue: 0, White: 0, Red: 0 },
      features: { type: 'FeatureCollection', features: [] },
    })),
  });

  const currentHoleData = courseData.holes[currentHole - 1];

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

    // Add draw control
    draw.current = new MapboxDraw({
      displayControlsDefault: false,
      controls: {},
      defaultMode: 'simple_select',
      styles: [
        // Polygon fill
        {
          id: 'gl-draw-polygon-fill',
          type: 'fill',
          filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
          paint: {
            'fill-color': ['coalesce', ['get', 'user_color'], '#22c55e'],
            'fill-opacity': 0.3,
          },
        },
        // Polygon outline
        {
          id: 'gl-draw-polygon-stroke',
          type: 'line',
          filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
          paint: {
            'line-color': ['coalesce', ['get', 'user_color'], '#22c55e'],
            'line-width': 2,
          },
        },
        // Point
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
        // Vertex points
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
    });

    // Handle draw events
    map.current.on('draw.create', handleDrawCreate);
    map.current.on('draw.update', handleDrawUpdate);
    map.current.on('draw.delete', handleDrawDelete);

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Load hole features when hole changes
  useEffect(() => {
    if (!draw.current || !isLoaded) return;
    
    // Clear and reload features for current hole
    draw.current.deleteAll();
    const holeFeatures = courseData.holes[currentHole - 1].features;
    if (holeFeatures.features.length > 0) {
      draw.current.set(holeFeatures);
    }
  }, [currentHole, isLoaded]);

  const handleDrawCreate = useCallback((e: { features: GeoJSON.Feature[] }) => {
    const feature = e.features[0];
    if (!feature) return;

    // Add metadata to the feature
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

    // Update in draw
    if (draw.current && feature.id) {
      draw.current.setFeatureProperty(feature.id as string, 'featureType', drawMode);
      draw.current.setFeatureProperty(feature.id as string, 'hole', currentHole);
      draw.current.setFeatureProperty(feature.id as string, 'color', FEATURE_STYLES[drawMode].color);
      draw.current.setFeatureProperty(feature.id as string, 'user_color', FEATURE_STYLES[drawMode].color);
      if (drawMode === 'tee') {
        draw.current.setFeatureProperty(feature.id as string, 'teeSet', selectedTeeSet);
      }
    }

    // Save to course data
    setCourseData(prev => {
      const newHoles = [...prev.holes];
      const holeData = newHoles[currentHole - 1];
      const existingFeatures = holeData.features.features.filter(f => f.id !== feature.id);
      holeData.features = {
        type: 'FeatureCollection',
        features: [...existingFeatures, featureWithMeta as GeoJSON.Feature],
      };
      return { ...prev, holes: newHoles };
    });
  }, [drawMode, currentHole, selectedTeeSet]);

  const handleDrawUpdate = useCallback((e: { features: GeoJSON.Feature[] }) => {
    const feature = e.features[0];
    if (!feature) return;

    setCourseData(prev => {
      const newHoles = [...prev.holes];
      const holeData = newHoles[currentHole - 1];
      const featureIndex = holeData.features.features.findIndex(f => f.id === feature.id);
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
  }, [currentHole]);

  const handleDrawDelete = useCallback((e: { features: GeoJSON.Feature[] }) => {
    const deletedIds = e.features.map(f => f.id);
    
    setCourseData(prev => {
      const newHoles = [...prev.holes];
      const holeData = newHoles[currentHole - 1];
      holeData.features = {
        type: 'FeatureCollection',
        features: holeData.features.features.filter(f => !deletedIds.includes(f.id)),
      };
      return { ...prev, holes: newHoles };
    });
  }, [currentHole]);

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
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(searchQuery)}.json?access_token=${mapboxgl.accessToken}&types=poi,address&limit=1`
      );
      const data = await response.json();
      
      if (data.features && data.features[0]) {
        const [lng, lat] = data.features[0].center;
        map.current.flyTo({ center: [lng, lat], zoom: 17 });
        setCourseData(prev => ({
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
        if (map.current) {
          map.current.flyTo({ 
            center: [imported.location.lng, imported.location.lat], 
            zoom: 17 
          });
        }
      } catch (error) {
        console.error('Import failed:', error);
        alert('Failed to import course file');
      }
    };
    reader.readAsText(file);
  };

  const updateHolePar = (par: number) => {
    setCourseData(prev => {
      const newHoles = [...prev.holes];
      newHoles[currentHole - 1].par = par;
      return { ...prev, holes: newHoles };
    });
  };

  const updateHoleYardage = (tee: string, yardage: number) => {
    setCourseData(prev => {
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
          <h1 className="text-lg font-bold text-white mb-3">Course Editor</h1>
          <div className="flex gap-2">
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
            onChange={(e) => setCourseData(prev => ({ ...prev, name: e.target.value }))}
            className="w-full mt-2 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            placeholder="Course name"
          />
        </div>

        {/* Hole Navigation */}
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setCurrentHole(h => Math.max(1, h - 1))}
              disabled={currentHole === 1}
              className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50"
            >
              <ChevronLeft className="w-5 h-5 text-white" />
            </button>
            <span className="text-xl font-bold text-white">Hole {currentHole}</span>
            <button
              onClick={() => setCurrentHole(h => Math.min(18, h + 1))}
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
              {[3, 4, 5].map(par => (
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
            {courseData.teeSets.map(tee => (
              <div key={tee.name} className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: tee.color }}
                />
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
          
          {/* Tee Set Selector (for tee boxes) */}
          {drawMode === 'tee' && (
            <div className="mb-3">
              <select
                value={selectedTeeSet}
                onChange={(e) => setSelectedTeeSet(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white text-sm"
              >
                {courseData.teeSets.map(tee => (
                  <option key={tee.name} value={tee.name}>{tee.name} Tees</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {(Object.entries(FEATURE_STYLES) as [FeatureType, typeof FEATURE_STYLES[FeatureType]][]).map(([type, style]) => (
              <button
                key={type}
                onClick={() => startDrawing(type)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  drawMode === type
                    ? 'ring-2 ring-offset-2 ring-offset-zinc-900'
                    : 'hover:bg-zinc-800'
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
                draw.current?.delete(selected.features.map(f => f.id as string));
              }
            }}
            className="w-full mt-2 px-3 py-2 bg-red-900/30 text-red-400 rounded-lg text-sm hover:bg-red-900/50 flex items-center justify-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Delete Selected
          </button>
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-zinc-800 space-y-2">
          <button
            onClick={exportCourse}
            className="w-full px-4 py-2.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-500 flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" />
            Export Course
          </button>
          <label className="w-full px-4 py-2.5 bg-zinc-800 text-white rounded-lg font-medium hover:bg-zinc-700 flex items-center justify-center gap-2 cursor-pointer">
            <Upload className="w-4 h-4" />
            Import Course
            <input type="file" accept=".json" onChange={importCourse} className="hidden" />
          </label>
        </div>
      </div>

      {/* Map Container */}
      <div ref={mapContainer} className="flex-1" />

      {/* Hole Quick Nav */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1 bg-zinc-900/90 backdrop-blur rounded-xl p-2 border border-zinc-800">
        {Array.from({ length: 18 }, (_, i) => i + 1).map(hole => {
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
