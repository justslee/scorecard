"use client";

/**
 * CourseSearch — yardage-book styled course-search bottom sheet.
 *
 * Rebuilt with T.* tokens (T.paper / T.ink / T.serif / T.mono) and inline SVGs.
 * No Tailwind classes, no lucide-react, no zinc/emerald dark theme.
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { T } from "@/components/yardage/tokens";
import { searchCourses, getClubDetails, GolfClub, GolfCourse } from "@/lib/golf-api";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CourseSearchProps {
  onSelectCourse: (course: {
    id: number | string;
    name: string;
    clubName: string;
    clubId: number | string;
    location?: string;
    holes?: number;
    par?: number;
  }) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Inline icons
// ---------------------------------------------------------------------------

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 2l10 10M12 2L2 12" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
        setError("Search failed. Check your connection.");
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
        setSelectedClub(details);
      } else {
        onSelectCourse({
          id: club.id,
          name: club.name,
          clubName: club.name,
          clubId: club.id,
          location: [club.city, club.state, club.country].filter(Boolean).join(", "),
        });
      }
    } catch {
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

  const showCourseList = !!selectedClub?.courses && selectedClub.courses.length > 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AnimatePresence>
      {/* Backdrop */}
      <motion.div
        key="cs-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.35)",
          zIndex: 50,
        }}
      />

      {/* Bottom sheet */}
      <motion.div
        key="cs-sheet"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={T.springSoft}
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 51,
          background: T.paper,
          borderRadius: "20px 20px 0 0",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 -20px 50px rgba(26,42,26,0.2)",
          maxWidth: 420,
          margin: "0 auto",
          overflow: "hidden",
        }}
      >
        {/* Drag handle */}
        <div
          style={{
            width: 40,
            height: 4,
            borderRadius: 99,
            background: T.hairline,
            margin: "12px auto 0",
            flexShrink: 0,
          }}
        />

        {/* Header */}
        <div
          style={{
            padding: "14px 22px 12px",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            borderBottom: `1px solid ${T.hairline}`,
            flexShrink: 0,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                marginBottom: 2,
              }}
            >
              Course &middot; Search
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 22,
                color: T.ink,
                letterSpacing: -0.4,
                lineHeight: 1.05,
              }}
            >
              {showCourseList ? selectedClub?.name : "Find a course"}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 36,
              height: 36,
              borderRadius: 99,
              border: `1px solid ${T.hairline}`,
              background: "transparent",
              color: T.pencil,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Search input — shown only on main search view */}
        {!showCourseList && (
          <div style={{ padding: "12px 22px 0", flexShrink: 0 }}>
            <div style={{ position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  left: 13,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: T.pencilSoft,
                  pointerEvents: "none",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <SearchIcon />
              </div>
              <input
                type="text"
                placeholder="Course name or location…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                style={{
                  width: "100%",
                  padding: "11px 14px 11px 38px",
                  borderRadius: 12,
                  border: `1px solid ${T.hairline}`,
                  background: T.paperDeep,
                  color: T.ink,
                  fontFamily: T.sans,
                  fontSize: 14,
                  letterSpacing: -0.1,
                  outline: "none",
                  boxSizing: "border-box",
                  WebkitAppearance: "none",
                }}
              />
              {loading && (
                <div
                  style={{
                    position: "absolute",
                    right: 13,
                    top: "50%",
                    transform: "translateY(-50%)",
                  }}
                >
                  <motion.div
                    animate={{ opacity: [0.3, 0.8, 0.3] }}
                    transition={{ duration: 1.2, repeat: Infinity }}
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 99,
                      background: T.pencilSoft,
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            style={{
              margin: "10px 22px 0",
              padding: "10px 14px",
              borderRadius: 10,
              background: "rgba(184,74,58,0.06)",
              border: "1px solid rgba(184,74,58,0.15)",
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 13,
              color: "#b84a3a",
              lineHeight: 1.4,
            }}
          >
            {error}
          </div>
        )}

        {/* Results list */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 0 max(24px, env(safe-area-inset-bottom))",
          }}
        >
          {showCourseList ? (
            <>
              {/* Back button */}
              <button
                onClick={() => setSelectedClub(null)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "10px 22px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencil,
                  textTransform: "uppercase",
                }}
              >
                {"← Back to search"}
              </button>

              {/* Course rows */}
              {selectedClub?.courses?.map((course: GolfCourse) => (
                <button
                  key={course.id}
                  onClick={() => handleSelectCourse(course)}
                  style={{
                    width: "100%",
                    padding: "13px 22px",
                    background: "transparent",
                    border: "none",
                    borderTop: `1px dashed ${T.hairline}`,
                    cursor: "pointer",
                    textAlign: "left",
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    alignItems: "center",
                    gap: 10,
                    minHeight: 60,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontSize: 17,
                        color: T.ink,
                        letterSpacing: -0.2,
                        marginBottom: 2,
                      }}
                    >
                      {course.name}
                    </div>
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.2,
                        color: T.pencilSoft,
                        textTransform: "uppercase",
                      }}
                    >
                      {course.holes} holes &middot; Par {course.par}
                    </div>
                  </div>
                  <div style={{ fontFamily: T.mono, fontSize: 13, color: T.pencil }}>{"›"}</div>
                </button>
              ))}
            </>

          ) : results.length === 0 && query.length >= 2 && !loading ? (
            <div
              style={{
                padding: "32px 22px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 18,
                  color: T.pencilSoft,
                  letterSpacing: -0.3,
                  marginBottom: 6,
                }}
              >
                No courses found.
              </div>
              <div
                style={{
                  fontFamily: T.sans,
                  fontSize: 13,
                  color: T.pencilSoft,
                  letterSpacing: -0.1,
                }}
              >
                Try a different name or location.
              </div>
            </div>

          ) : query.length < 2 ? (
            <div style={{ padding: "20px 22px" }}>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 16,
                  color: T.pencilSoft,
                  lineHeight: 1.4,
                  letterSpacing: -0.2,
                }}
              >
                Type at least two characters to search.
              </div>
            </div>

          ) : (
            results.map((club) => (
              <button
                key={club.id}
                onClick={() => handleSelectClub(club)}
                disabled={clubLoading}
                style={{
                  width: "100%",
                  padding: "13px 22px",
                  background: "transparent",
                  border: "none",
                  borderTop: `1px dashed ${T.hairline}`,
                  cursor: clubLoading ? "not-allowed" : "pointer",
                  textAlign: "left",
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "center",
                  gap: 10,
                  opacity: clubLoading ? 0.5 : 1,
                  minHeight: 60,
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 17,
                      color: T.ink,
                      letterSpacing: -0.2,
                      marginBottom: 2,
                    }}
                  >
                    {club.name}
                  </div>
                  {(club.city || club.state || club.country) && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.1,
                        color: T.pencilSoft,
                        textTransform: "uppercase",
                      }}
                    >
                      <MapPinIcon />
                      {[club.city, club.state, club.country].filter(Boolean).join(", ")}
                    </div>
                  )}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 13, color: T.pencil }}>{"›"}</div>
              </button>
            ))
          )}
        </div>

        {/* Powered by footer */}
        <div
          style={{
            padding: "8px 22px 10px",
            borderTop: `1px solid ${T.hairline}`,
            fontFamily: T.mono,
            fontSize: 8.5,
            letterSpacing: 1.2,
            color: T.pencilSoft,
            textTransform: "uppercase",
            textAlign: "center",
            flexShrink: 0,
          }}
        >
          Course data &mdash; GolfAPI.io
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
