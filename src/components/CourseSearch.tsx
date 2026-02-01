"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, MapPin, Loader2, X } from "lucide-react";
import { searchCourses, getClubDetails, GolfClub, GolfCourse } from "@/lib/golf-api";

interface CourseSearchProps {
  onSelectCourse: (course: {
    id: number;
    name: string;
    clubName: string;
    clubId: number;
    location?: string;
    holes?: number;
    par?: number;
  }) => void;
  onClose: () => void;
}

export default function CourseSearch({ onSelectCourse, onClose }: CourseSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GolfClub[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedClub, setSelectedClub] = useState<GolfClub | null>(null);
  const [clubLoading, setClubLoading] = useState(false);

  // Debounced search
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const clubs = await searchCourses(query);
        setResults(clubs);
      } catch (err) {
        setError("Failed to search courses. Check your API key.");
        console.error(err);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const handleSelectClub = async (club: GolfClub) => {
    setClubLoading(true);
    setSelectedClub(club);
    
    try {
      const details = await getClubDetails(club.id);
      if (details?.courses && details.courses.length > 0) {
        // If multiple courses, show them; otherwise select directly
        setSelectedClub(details);
      } else {
        // No courses found, use club as single course
        onSelectCourse({
          id: club.id,
          name: club.name,
          clubName: club.name,
          clubId: club.id,
          location: [club.city, club.state, club.country].filter(Boolean).join(", "),
        });
      }
    } catch (err) {
      console.error(err);
      // Fallback: use club directly
      onSelectCourse({
        id: club.id,
        name: club.name,
        clubName: club.name,
        clubId: club.id,
        location: [club.city, club.state, club.country].filter(Boolean).join(", "),
      });
    } finally {
      setClubLoading(false);
    }
  };

  const handleSelectCourse = (course: GolfCourse) => {
    if (!selectedClub) return;
    
    onSelectCourse({
      id: course.id,
      name: course.name,
      clubName: selectedClub.name,
      clubId: selectedClub.id,
      holes: course.holes,
      par: course.par,
      location: [selectedClub.city, selectedClub.state, selectedClub.country]
        .filter(Boolean)
        .join(", "),
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950/95 backdrop-blur-xl">
      <div className="max-w-2xl mx-auto p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-white">Search Courses</h2>
          <button
            onClick={onClose}
            className="btn btn-icon"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search Input */}
        <div className="relative mb-6">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-400" />
          <input
            type="text"
            placeholder="Search by course name or location..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-12 pr-4 py-4 rounded-2xl bg-zinc-900 border border-zinc-800 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            autoFocus
          />
          {loading && (
            <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 h-5 w-5 text-emerald-500 animate-spin" />
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300">
            {error}
          </div>
        )}

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto space-y-2">
          <AnimatePresence mode="wait">
            {selectedClub?.courses && selectedClub.courses.length > 0 ? (
              // Show courses within selected club
              <motion.div
                key="courses"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <button
                  onClick={() => setSelectedClub(null)}
                  className="text-sm text-emerald-400 hover:text-emerald-300 mb-4 flex items-center gap-1"
                >
                  ← Back to search
                </button>
                <h3 className="text-sm text-zinc-400 uppercase tracking-wider mb-3">
                  Courses at {selectedClub.name}
                </h3>
                {selectedClub.courses.map((course) => (
                  <button
                    key={course.id}
                    onClick={() => handleSelectCourse(course)}
                    className="w-full text-left p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 hover:bg-zinc-800/50 transition-colors mb-2"
                  >
                    <div className="font-semibold text-white">{course.name}</div>
                    <div className="text-sm text-zinc-400">
                      {course.holes} holes • Par {course.par}
                    </div>
                  </button>
                ))}
              </motion.div>
            ) : (
              // Show search results
              <motion.div
                key="results"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                {results.length === 0 && query.length >= 2 && !loading && (
                  <div className="text-center py-8 text-zinc-400">
                    No courses found. Try a different search.
                  </div>
                )}
                {results.map((club) => (
                  <button
                    key={club.id}
                    onClick={() => handleSelectClub(club)}
                    disabled={clubLoading}
                    className="w-full text-left p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 hover:bg-zinc-800/50 transition-colors mb-2 disabled:opacity-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-white">{club.name}</div>
                        {(club.city || club.state || club.country) && (
                          <div className="flex items-center gap-1 text-sm text-zinc-400 mt-1">
                            <MapPin className="h-3 w-3" />
                            {[club.city, club.state, club.country]
                              .filter(Boolean)
                              .join(", ")}
                          </div>
                        )}
                      </div>
                      <div className="text-zinc-500">→</div>
                    </div>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Powered by */}
        <div className="mt-6 text-center text-xs text-zinc-600">
          Course data powered by GolfAPI.io
        </div>
      </div>
    </div>
  );
}
