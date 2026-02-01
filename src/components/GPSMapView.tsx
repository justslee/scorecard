"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Navigation,
  Target,
  Crosshair,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  MapPin,
  Compass,
  Signal,
} from "lucide-react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { GPSWatcher, calculateDistance, formatDistance, getAccuracyDescription, Position } from "@/lib/gps";
import { CourseCoordinates } from "@/lib/golf-api";

interface GPSMapViewProps {
  courseId: number;
  courseName: string;
  holeCoordinates: CourseCoordinates[];
  currentHole: number;
  onHoleChange: (hole: number) => void;
  onClose: () => void;
}

export default function GPSMapView({
  courseId,
  courseName,
  holeCoordinates,
  currentHole,
  onHoleChange,
  onClose,
}: GPSMapViewProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const userMarker = useRef<mapboxgl.Marker | null>(null);
  const greenMarker = useRef<mapboxgl.Marker | null>(null);
  
  const [position, setPosition] = useState<Position | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [distances, setDistances] = useState<{
    front: number | null;
    center: number | null;
    back: number | null;
  }>({ front: null, center: null, back: null });
  
  const gpsWatcher = useRef<GPSWatcher | null>(null);
  
  // Get current hole data
  const currentHoleData = holeCoordinates.find((h) => h.holeNumber === currentHole);
  
  // Calculate distances when position or hole changes
  useEffect(() => {
    if (!position || !currentHoleData) {
      setDistances({ front: null, center: null, back: null });
      return;
    }
    
    const center = calculateDistance(position, currentHoleData.green);
    const front = currentHoleData.front
      ? calculateDistance(position, currentHoleData.front)
      : null;
    const back = currentHoleData.back
      ? calculateDistance(position, currentHoleData.back)
      : null;
    
    setDistances({
      front: front?.yards ?? null,
      center: center.yards,
      back: back?.yards ?? null,
    });
  }, [position, currentHoleData]);
  
  // Initialize map
  useEffect(() => {
    if (!mapContainer.current || !currentHoleData) return;
    
    // Set Mapbox token
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
    
    if (!mapboxgl.accessToken) {
      setGpsError("Mapbox token not configured");
      setIsLoading(false);
      return;
    }
    
    // Initialize map centered on green
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [currentHoleData.green.lng, currentHoleData.green.lat],
      zoom: 17,
      pitch: 45,
      bearing: 0,
    });
    
    map.current.on("load", () => {
      setIsLoading(false);
      
      // Add green marker
      const greenEl = document.createElement("div");
      greenEl.className = "green-marker";
      greenEl.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-emerald-500 border-2 border-white shadow-lg flex items-center justify-center">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
            <line x1="4" y1="22" x2="4" y2="15"/>
          </svg>
        </div>
      `;
      
      greenMarker.current = new mapboxgl.Marker({ element: greenEl })
        .setLngLat([currentHoleData.green.lng, currentHoleData.green.lat])
        .addTo(map.current!);
    });
    
    return () => {
      map.current?.remove();
    };
  }, []);
  
  // Update green marker when hole changes
  useEffect(() => {
    if (!map.current || !currentHoleData || !greenMarker.current) return;
    
    greenMarker.current.setLngLat([currentHoleData.green.lng, currentHoleData.green.lat]);
    
    map.current.flyTo({
      center: [currentHoleData.green.lng, currentHoleData.green.lat],
      zoom: 17,
      duration: 1000,
    });
  }, [currentHoleData]);
  
  // Handle position updates
  const handlePositionUpdate = useCallback((pos: Position) => {
    setPosition(pos);
    setGpsError(null);
    
    if (!map.current) return;
    
    // Update or create user marker
    if (!userMarker.current) {
      const userEl = document.createElement("div");
      userEl.className = "user-marker";
      userEl.innerHTML = `
        <div class="relative">
          <div class="w-6 h-6 rounded-full bg-blue-500 border-2 border-white shadow-lg animate-pulse"></div>
          <div class="absolute inset-0 w-6 h-6 rounded-full bg-blue-500 animate-ping opacity-75"></div>
        </div>
      `;
      
      userMarker.current = new mapboxgl.Marker({ element: userEl })
        .setLngLat([pos.lng, pos.lat])
        .addTo(map.current);
    } else {
      userMarker.current.setLngLat([pos.lng, pos.lat]);
    }
  }, []);
  
  // Handle GPS errors
  const handleGpsError = useCallback((error: GeolocationPositionError) => {
    switch (error.code) {
      case error.PERMISSION_DENIED:
        setGpsError("Location permission denied. Please enable location access.");
        break;
      case error.POSITION_UNAVAILABLE:
        setGpsError("Location unavailable. Please check your GPS.");
        break;
      case error.TIMEOUT:
        setGpsError("Location request timed out. Retrying...");
        break;
      default:
        setGpsError("Unable to get location.");
    }
  }, []);
  
  // Start GPS tracking
  useEffect(() => {
    gpsWatcher.current = new GPSWatcher(handlePositionUpdate, handleGpsError);
    gpsWatcher.current.start();
    
    return () => {
      gpsWatcher.current?.stop();
    };
  }, [handlePositionUpdate, handleGpsError]);
  
  // Center on user location
  const centerOnUser = () => {
    if (!map.current || !position) return;
    
    map.current.flyTo({
      center: [position.lng, position.lat],
      zoom: 18,
      duration: 500,
    });
  };
  
  // Center on green
  const centerOnGreen = () => {
    if (!map.current || !currentHoleData) return;
    
    map.current.flyTo({
      center: [currentHoleData.green.lng, currentHoleData.green.lat],
      zoom: 17,
      duration: 500,
    });
  };
  
  const prevHole = () => {
    if (currentHole > 1) {
      onHoleChange(currentHole - 1);
    }
  };
  
  const nextHole = () => {
    if (currentHole < 18) {
      onHoleChange(currentHole + 1);
    }
  };
  
  return (
    <div className="fixed inset-0 z-50 bg-zinc-950">
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-zinc-950/90 to-transparent p-4 pb-8">
        <div className="flex items-center justify-between">
          <button
            onClick={onClose}
            className="flex items-center gap-2 text-white/80 hover:text-white"
          >
            <ChevronLeft size={24} />
            <span>Back</span>
          </button>
          
          <div className="text-center">
            <h1 className="text-white font-semibold">{courseName}</h1>
            <p className="text-zinc-400 text-sm">Hole {currentHole}</p>
          </div>
          
          <div className="w-16" /> {/* Spacer */}
        </div>
      </div>
      
      {/* Map */}
      <div ref={mapContainer} className="w-full h-full" />
      
      {/* Loading overlay */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-zinc-950 flex items-center justify-center z-20"
          >
            <div className="text-center">
              <Loader2 className="w-12 h-12 text-emerald-500 animate-spin mx-auto mb-4" />
              <p className="text-white">Loading map...</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* GPS Error */}
      <AnimatePresence>
        {gpsError && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute top-20 left-4 right-4 z-20"
          >
            <div className="bg-red-500/90 backdrop-blur-sm rounded-xl p-4 flex items-center gap-3">
              <AlertCircle className="w-6 h-6 text-white flex-shrink-0" />
              <p className="text-white text-sm">{gpsError}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Distance Panel */}
      <div className="absolute bottom-0 left-0 right-0 z-10">
        {/* Hole Navigation */}
        <div className="flex items-center justify-center gap-4 pb-4">
          <button
            onClick={prevHole}
            disabled={currentHole <= 1}
            className="w-10 h-10 rounded-full bg-zinc-800/80 backdrop-blur-sm flex items-center justify-center disabled:opacity-30"
          >
            <ChevronLeft className="text-white" size={24} />
          </button>
          
          <div className="bg-zinc-800/80 backdrop-blur-sm rounded-full px-6 py-2">
            <span className="text-white font-bold text-lg">Hole {currentHole}</span>
          </div>
          
          <button
            onClick={nextHole}
            disabled={currentHole >= 18}
            className="w-10 h-10 rounded-full bg-zinc-800/80 backdrop-blur-sm flex items-center justify-center disabled:opacity-30"
          >
            <ChevronRight className="text-white" size={24} />
          </button>
        </div>
        
        {/* Distances */}
        <div className="bg-zinc-900/95 backdrop-blur-xl rounded-t-3xl p-6 pt-8">
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="text-center">
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Front</p>
              <p className="text-white text-2xl font-bold">
                {distances.front !== null ? distances.front : "—"}
              </p>
              <p className="text-zinc-500 text-xs">yds</p>
            </div>
            
            <div className="text-center">
              <div className="bg-emerald-500/20 rounded-2xl p-3 -mt-2">
                <p className="text-emerald-400 text-xs uppercase tracking-wider mb-1">Center</p>
                <p className="text-emerald-400 text-4xl font-bold">
                  {distances.center !== null ? distances.center : "—"}
                </p>
                <p className="text-emerald-400/60 text-xs">yds</p>
              </div>
            </div>
            
            <div className="text-center">
              <p className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Back</p>
              <p className="text-white text-2xl font-bold">
                {distances.back !== null ? distances.back : "—"}
              </p>
              <p className="text-zinc-500 text-xs">yds</p>
            </div>
          </div>
          
          {/* GPS Status & Controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Signal
                size={16}
                className={position ? "text-emerald-500" : "text-zinc-500"}
              />
              <span className="text-zinc-400 text-sm">
                {position
                  ? `GPS: ${getAccuracyDescription(position.accuracy || 0)} (±${Math.round(position.accuracy || 0)}m)`
                  : "Acquiring GPS..."}
              </span>
            </div>
            
            <div className="flex gap-2">
              <button
                onClick={centerOnUser}
                disabled={!position}
                className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center disabled:opacity-30"
              >
                <Navigation className="text-blue-400" size={20} />
              </button>
              
              <button
                onClick={centerOnGreen}
                className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center"
              >
                <Target className="text-emerald-400" size={20} />
              </button>
            </div>
          </div>
        </div>
      </div>
      
      {/* Custom marker styles */}
      <style jsx global>{`
        .green-marker, .user-marker {
          cursor: pointer;
        }
        .mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib {
          display: none !important;
        }
      `}</style>
    </div>
  );
}
