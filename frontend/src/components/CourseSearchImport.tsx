'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  MapPin,
  Locate,
  Loader2,
  ChevronRight,
  Globe,
  Database,
  Map,
  X,
  Navigation,
} from 'lucide-react';
import {
  searchAllCourses,
  searchNearby,
  importGolfApiCourse,
  getRecentCourses,
  CourseSearchResult,
} from '@/lib/golf-api';
import type { Course } from '@/lib/types';

interface CourseSearchImportProps {
  onSelectCourse: (course: Course) => void;
  onClose: () => void;
}

export default function CourseSearchImport({
  onSelectCourse,
  onClose,
}: CourseSearchImportProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CourseSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentCourses, setRecentCourses] = useState<
    Array<{ id: number; name: string; clubName: string }>
  >([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setRecentCourses(getRecentCourses());
    inputRef.current?.focus();
  }, []);

  const handleSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const searchResults = await searchAllCourses(q);
      setResults(searchResults);
    } catch {
      setError('Search failed. Check your connection.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => handleSearch(value), 400);
  };

  const handleNearby = async () => {
    if (!navigator.geolocation) {
      setError('GPS not available');
      return;
    }

    setLoadingNearby(true);
    setError(null);

    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        });
      });

      const nearbyResults = await searchNearby(
        pos.coords.latitude,
        pos.coords.longitude
      );
      setResults(nearbyResults);
      setQuery('');
    } catch {
      setError('Could not get location or find nearby courses.');
    } finally {
      setLoadingNearby(false);
    }
  };

  const handleSelectResult = async (result: CourseSearchResult) => {
    // If it's a GolfAPI course, import it
    if (result.source === 'golfapi' && result.golfApiClubId) {
      setImporting(result.id);
      try {
        const course = await importGolfApiCourse(
          result.golfApiClubId,
          result.golfApiCourseId
        );
        if (course) {
          onSelectCourse(course);
          return;
        }
        setError('Could not load course data.');
      } catch {
        setError('Import failed.');
      } finally {
        setImporting(null);
      }
      return;
    }

    // For mapped courses, fetch full data and convert
    if (result.source === 'mapped') {
      setImporting(result.id);
      try {
        const res = await fetch(
          `/api/courses/${encodeURIComponent(result.id)}`
        );
        const data = await res.json();
        const courseData = data.course;
        if (courseData) {
          const baseHoles = courseData.holes.map(
            (h: { number: number; par: number; handicap?: number; yardages?: Record<string, number> }) => ({
              number: h.number,
              par: h.par,
              handicap: h.handicap,
            })
          );

          const tees = (courseData.teeSets || []).map(
            (t: { name: string }) => ({
              id: t.name,
              name: t.name,
              holes: courseData.holes.map(
                (h: { number: number; par: number; handicap?: number; yardages?: Record<string, number> }) => ({
                  number: h.number,
                  par: h.par,
                  handicap: h.handicap,
                  yards: h.yardages?.[t.name] || undefined,
                })
              ),
            })
          );

          onSelectCourse({
            id: courseData.id,
            name: courseData.name,
            holes: baseHoles,
            tees,
            location: courseData.address,
          });
          return;
        }
      } catch {
        setError('Could not load mapped course.');
      } finally {
        setImporting(null);
      }
      return;
    }

    // For OSM results, create a course with basic info + location
    // User can map it later in the editor
    const course: Course = {
      id: result.id,
      name: result.name,
      holes: Array.from({ length: 18 }, (_, i) => ({
        number: i + 1,
        par: [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5][i],
      })),
      tees: [
        {
          id: crypto.randomUUID(),
          name: 'Blue',
          holes: Array.from({ length: 18 }, (_, i) => ({
            number: i + 1,
            par: [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5][i],
          })),
        },
        {
          id: crypto.randomUUID(),
          name: 'White',
          holes: Array.from({ length: 18 }, (_, i) => ({
            number: i + 1,
            par: [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5][i],
          })),
        },
      ],
      location: result.address,
    };
    onSelectCourse(course);
  };

  const handleSelectRecent = async (recent: {
    id: number;
    name: string;
    clubName: string;
  }) => {
    setImporting(`recent-${recent.id}`);
    try {
      const course = await importGolfApiCourse(recent.id);
      if (course) {
        onSelectCourse(course);
        return;
      }
    } catch {
      // Fall through
    }
    setImporting(null);
  };

  const sourceIcon = (source: CourseSearchResult['source']) => {
    switch (source) {
      case 'golfapi':
        return <Globe className="w-4 h-4 text-emerald-400" />;
      case 'mapped':
        return <Database className="w-4 h-4 text-blue-400" />;
      case 'osm':
        return <Map className="w-4 h-4 text-orange-400" />;
      default:
        return <MapPin className="w-4 h-4 text-zinc-400" />;
    }
  };

  const sourceLabel = (source: CourseSearchResult['source']) => {
    switch (source) {
      case 'golfapi':
        return 'Golf API';
      case 'mapped':
        return 'Mapped';
      case 'osm':
        return 'OpenStreetMap';
      default:
        return '';
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950/95 backdrop-blur-sm">
      <div className="max-w-2xl mx-auto h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-zinc-800">
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center"
          >
            <X className="w-5 h-5 text-zinc-400" />
          </button>

          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => handleInputChange(e.target.value)}
              placeholder="Search courses..."
              className="w-full pl-10 pr-4 py-3 rounded-xl bg-zinc-800 border border-zinc-700 text-white placeholder:text-zinc-500 focus:border-emerald-500/50 focus:outline-none"
            />
          </div>

          <button
            onClick={handleNearby}
            disabled={loadingNearby}
            className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center hover:bg-zinc-700 disabled:opacity-50"
            title="Find nearby courses"
          >
            {loadingNearby ? (
              <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
            ) : (
              <Navigation className="w-5 h-5 text-emerald-400" />
            )}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <AnimatePresence mode="wait">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm"
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
            </div>
          )}

          {!loading && results.length === 0 && !query && (
            <>
              {/* Nearby button */}
              <button
                onClick={handleNearby}
                disabled={loadingNearby}
                className="w-full p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-3 hover:bg-emerald-500/15 transition-colors disabled:opacity-50"
              >
                <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <Locate className="w-5 h-5 text-emerald-400" />
                </div>
                <div className="text-left">
                  <div className="font-medium text-emerald-300">
                    Find Nearby Courses
                  </div>
                  <div className="text-sm text-emerald-400/60">
                    Use GPS to find courses near you
                  </div>
                </div>
              </button>

              {/* Recent courses */}
              {recentCourses.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
                    Recent
                  </div>
                  <div className="space-y-2">
                    {recentCourses.map((rc) => (
                      <button
                        key={rc.id}
                        onClick={() => handleSelectRecent(rc)}
                        disabled={importing === `recent-${rc.id}`}
                        className="w-full p-3 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center gap-3 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                      >
                        <MapPin className="w-5 h-5 text-zinc-500 flex-shrink-0" />
                        <div className="text-left min-w-0 flex-1">
                          <div className="font-medium truncate">{rc.name}</div>
                          <div className="text-sm text-zinc-500 truncate">
                            {rc.clubName}
                          </div>
                        </div>
                        {importing === `recent-${rc.id}` ? (
                          <Loader2 className="w-5 h-5 text-emerald-400 animate-spin flex-shrink-0" />
                        ) : (
                          <ChevronRight className="w-5 h-5 text-zinc-600 flex-shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {!loading && results.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                {results.length} result{results.length !== 1 ? 's' : ''}
              </div>
              {results.map((result) => (
                <motion.button
                  key={result.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  onClick={() => handleSelectResult(result)}
                  disabled={importing === result.id}
                  className="w-full p-4 rounded-xl bg-zinc-900 border border-zinc-800 flex items-start gap-3 hover:bg-zinc-800 transition-colors disabled:opacity-50 text-left"
                >
                  <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center flex-shrink-0 mt-0.5">
                    {sourceIcon(result.source)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{result.name}</div>
                    {result.clubName && result.clubName !== result.name && (
                      <div className="text-sm text-zinc-400 truncate">
                        {result.clubName}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      {result.address && (
                        <span className="text-xs text-zinc-500 truncate">
                          {result.address}
                        </span>
                      )}
                      {result.city && !result.address && (
                        <span className="text-xs text-zinc-500">
                          {result.city}
                          {result.state ? `, ${result.state}` : ''}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-zinc-600">
                        {sourceLabel(result.source)}
                      </span>
                      {result.hasCoordinates && (
                        <span className="text-xs text-emerald-500/70 flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          GPS
                        </span>
                      )}
                    </div>
                  </div>
                  {importing === result.id ? (
                    <Loader2 className="w-5 h-5 text-emerald-400 animate-spin flex-shrink-0 mt-1" />
                  ) : (
                    <ChevronRight className="w-5 h-5 text-zinc-600 flex-shrink-0 mt-1" />
                  )}
                </motion.button>
              ))}
            </div>
          )}

          {!loading && results.length === 0 && query && (
            <div className="text-center py-12 text-zinc-500">
              <Search className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>No courses found for &quot;{query}&quot;</p>
              <p className="text-sm mt-1">
                Try a different name or use the GPS button
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
