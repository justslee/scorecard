"use client";

/**
 * CourseSearch — yardage-book styled course-search bottom sheet.
 *
 * Empty state (no query): Favorites (user-starred) then Nearby (GPS, best-effort).
 * Active search: searchAllCourses() — mapped sources first, GolfAPI as fallback.
 * Star toggle on every result persists to course-favorites.ts (localStorage).
 *
 * Design: T.* tokens (T.paper / T.ink / T.serif / T.mono) and inline SVGs.
 * No Tailwind classes, no lucide-react, no zinc/emerald dark theme.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { T } from "@/components/yardage/tokens";
import { searchAllCourses, searchNearby, type CourseSearchResult } from "@/lib/golf-api";
import { GPSWatcher } from "@/lib/gps";
import {
  listFavorites,
  addFavorite,
  removeFavorite,
  type FavoriteCourse,
} from "@/lib/course-favorites";
import { mergeAndSortNearby, formatMiles, type NearbyResult } from "@/lib/course-search-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CourseSelectPayload {
  id: number | string;
  name: string;
  clubName: string;
  clubId: number | string;
  location?: string;
  holes?: number;
  par?: number;
  /** Source — callers can use this to route to the map view for mapped courses. */
  source?: string;
}

interface CourseSearchProps {
  onSelectCourse: (course: CourseSelectPayload) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Inline icons (no external deps)
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
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
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

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? T.pencil : "none"}
      stroke={T.pencil}
      strokeWidth="1.6"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a CourseSearchResult to the onSelectCourse payload. */
function resultToPayload(r: CourseSearchResult): CourseSelectPayload {
  const id = r.source === "golfapi" ? (r.golfApiCourseId ?? r.id) : r.id;
  const clubId = r.golfApiClubId ?? r.id;
  const location =
    [r.city, r.state].filter(Boolean).join(", ") || r.address || undefined;
  return {
    id,
    name: r.name,
    clubName: r.clubName ?? r.name,
    clubId,
    location,
    source: r.source,
  };
}

/** Map a FavoriteCourse to the onSelectCourse payload. */
function favoriteToPayload(f: FavoriteCourse): CourseSelectPayload {
  return {
    id: f.id,
    name: f.name,
    clubName: f.clubName ?? f.name,
    clubId: f.golfApiClubId ?? f.id,
    source: f.source,
  };
}

/** Build a FavoriteCourse from a CourseSearchResult. */
function resultToFavorite(r: CourseSearchResult): Omit<FavoriteCourse, "favoritedAt"> {
  return {
    id: r.source === "golfapi" ? String(r.golfApiCourseId ?? r.id) : r.id,
    name: r.name,
    clubName: r.clubName,
    center: r.center,
    source: r.source,
    golfApiClubId: r.golfApiClubId != null ? String(r.golfApiClubId) : undefined,
  };
}

/** Key used to check isFavorite for a search result. */
function resultFavId(r: CourseSearchResult): string {
  return r.source === "golfapi" ? String(r.golfApiCourseId ?? r.id) : r.id;
}

// ---------------------------------------------------------------------------
// Section label
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "12px 22px 4px",
        fontFamily: T.mono,
        fontSize: 9,
        letterSpacing: 1.6,
        color: T.pencil,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CourseSearch({ onSelectCourse, onClose }: CourseSearchProps) {
  const [query, setQuery] = useState("");

  // Search results (query mode)
  const [searchResults, setSearchResults] = useState<CourseSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Favorites (empty-state mode) — refreshed on every star toggle
  const [favorites, setFavorites] = useState<FavoriteCourse[]>(() => listFavorites());

  // Nearby (empty-state mode)
  const [nearby, setNearby] = useState<NearbyResult[]>([]);
  const [nearbyState, setNearbyState] = useState<"idle" | "loading" | "done" | "denied">("idle");

  // Track which result ids are starred so star state updates instantly
  const [starredIds, setStarredIds] = useState<Set<string>>(() => {
    const favs = listFavorites();
    return new Set(favs.map((f) => f.id));
  });

  // Abort controller ref for cancelling stale search requests
  const abortRef = useRef<AbortController | null>(null);

  // ---------------------------------------------------------------------------
  // One-shot GPS for nearby (on mount, best-effort)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setNearbyState("loading");

    GPSWatcher.getCurrentPosition().then(
      async (pos) => {
        try {
          const raw = await searchNearby(pos.lat, pos.lng);
          setNearby(mergeAndSortNearby(raw, pos.lat, pos.lng));
        } catch {
          // best-effort — nearby stays empty on error
        }
        setNearbyState("done");
      },
      () => {
        // permission denied or fix unavailable
        setNearbyState("denied");
      }
    );
    // One-shot promise — no cleanup needed
  }, []);

  // ---------------------------------------------------------------------------
  // Debounced search (250ms) with stale-request cancellation
  // ---------------------------------------------------------------------------
  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setSearchLoading(true);
    setSearchError(null);
    try {
      const results = await searchAllCourses(q);
      setSearchResults(results);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        setSearchError("Search failed — check your connection.");
      }
    } finally {
      setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void doSearch(query); }, 250);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query, doSearch]);

  // ---------------------------------------------------------------------------
  // Star toggle helpers
  // ---------------------------------------------------------------------------

  function toggleResultStar(r: CourseSearchResult, e: React.MouseEvent) {
    e.stopPropagation();
    const favId = resultFavId(r);
    if (starredIds.has(favId)) {
      const updated = removeFavorite(favId);
      setFavorites(updated);
      setStarredIds(new Set(updated.map((f) => f.id)));
    } else {
      const updated = addFavorite(resultToFavorite(r));
      setFavorites(updated);
      setStarredIds(new Set(updated.map((f) => f.id)));
    }
  }

  function removeFavoriteStar(f: FavoriteCourse, e: React.MouseEvent) {
    e.stopPropagation();
    const updated = removeFavorite(f.id);
    setFavorites(updated);
    setStarredIds(new Set(updated.map((fav) => fav.id)));
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const isEmptyState = query.length < 2;
  const hasNoResults = !searchLoading && searchResults.length === 0 && query.length >= 2;

  // ---------------------------------------------------------------------------
  // Row renderers — defined as inner functions to access state
  // ---------------------------------------------------------------------------

  function ResultRow({
    r,
    distanceMi,
  }: {
    r: CourseSearchResult;
    distanceMi?: number;
  }) {
    const favId = resultFavId(r);
    const starred = starredIds.has(favId);
    const sub = [r.city, r.state].filter(Boolean).join(", ");
    const isMapped = r.source === "mapped";

    return (
      <button
        onClick={() => onSelectCourse(resultToPayload(r))}
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
          minHeight: 58,
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
              lineHeight: 1.2,
            }}
          >
            {r.name}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.1,
              color: T.pencilSoft,
              textTransform: "uppercase",
              flexWrap: "wrap",
            }}
          >
            {sub && (
              <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <MapPinIcon />
                {sub}
              </span>
            )}
            {distanceMi !== undefined && (
              <span style={{ color: T.pencil }}>{formatMiles(distanceMi)}</span>
            )}
            {isMapped && (
              <span
                style={{
                  border: `1px solid ${T.hairline}`,
                  borderRadius: 3,
                  padding: "1px 4px",
                  fontSize: 7.5,
                  letterSpacing: 1.2,
                  color: T.pencilSoft,
                  lineHeight: 1.5,
                }}
              >
                mapped
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button
            onClick={(e) => toggleResultStar(r, e)}
            aria-label={starred ? "Remove from favorites" : "Add to favorites"}
            style={{
              padding: 4,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              opacity: starred ? 1 : 0.4,
            }}
          >
            <StarIcon filled={starred} />
          </button>
          <div style={{ fontFamily: T.mono, fontSize: 13, color: T.pencil }}>{"›"}</div>
        </div>
      </button>
    );
  }

  function FavoriteRow({ f }: { f: FavoriteCourse }) {
    return (
      <button
        onClick={() => onSelectCourse(favoriteToPayload(f))}
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
          minHeight: 58,
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
            {f.name}
          </div>
          {f.clubName && f.clubName !== f.name && (
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.1,
                color: T.pencilSoft,
                textTransform: "uppercase",
              }}
            >
              {f.clubName}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button
            onClick={(e) => removeFavoriteStar(f, e)}
            aria-label="Remove from favorites"
            style={{
              padding: 4,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
            }}
          >
            <StarIcon filled={true} />
          </button>
          <div style={{ fontFamily: T.mono, fontSize: 13, color: T.pencil }}>{"›"}</div>
        </div>
      </button>
    );
  }

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
              Find a course
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

        {/* Search input */}
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
            {searchLoading && (
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

        {/* Error */}
        {searchError && (
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
            {searchError}
          </div>
        )}

        {/* Scrollable content */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 0 max(24px, env(safe-area-inset-bottom))",
          }}
        >
          {isEmptyState ? (
            /* ── Empty state ── */
            <>
              {/* Favorites */}
              {favorites.length > 0 && (
                <>
                  <SectionLabel>Favorites</SectionLabel>
                  {favorites.map((f) => (
                    <FavoriteRow key={f.id} f={f} />
                  ))}
                </>
              )}

              {/* Nearby */}
              {nearbyState === "loading" && (
                <div style={{ padding: "16px 22px" }}>
                  <motion.div
                    animate={{ opacity: [0.3, 0.7, 0.3] }}
                    transition={{ duration: 1.4, repeat: Infinity }}
                    style={{
                      fontFamily: T.mono,
                      fontSize: 9,
                      letterSpacing: 1.4,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                    }}
                  >
                    Finding nearby courses…
                  </motion.div>
                </div>
              )}

              {nearbyState === "done" && nearby.length > 0 && (
                <>
                  <SectionLabel>Nearby</SectionLabel>
                  {nearby.map((r) => (
                    <ResultRow key={r.id} r={r} distanceMi={r.distanceMi} />
                  ))}
                </>
              )}

              {/* Quiet hint when location denied and nothing else to show */}
              {nearbyState === "denied" && favorites.length === 0 && (
                <div style={{ padding: "24px 22px" }}>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 16,
                      color: T.pencilSoft,
                      lineHeight: 1.5,
                      letterSpacing: -0.2,
                    }}
                  >
                    Type to search, or enable location to see nearby courses.
                  </div>
                </div>
              )}

              {nearbyState === "denied" && favorites.length > 0 && (
                <div style={{ padding: "10px 22px 0" }}>
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 8.5,
                      letterSpacing: 1.1,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                    }}
                  >
                    Enable location to see nearby courses
                  </div>
                </div>
              )}

              {/* Idle default */}
              {nearbyState === "idle" && favorites.length === 0 && (
                <div style={{ padding: "24px 22px" }}>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 16,
                      color: T.pencilSoft,
                      lineHeight: 1.5,
                      letterSpacing: -0.2,
                    }}
                  >
                    Type to search by name or location.
                  </div>
                </div>
              )}
            </>
          ) : (
            /* ── Search results ── */
            <>
              {hasNoResults && (
                <div style={{ padding: "32px 22px", textAlign: "center" }}>
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
              )}

              {searchResults.map((r) => (
                <ResultRow key={r.id} r={r} />
              ))}
            </>
          )}
        </div>

        {/* Footer — neutral source attribution, GolfAPI no longer the headline */}
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
          Course data &mdash; Mapped &middot; Community &middot; OpenStreetMap
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
