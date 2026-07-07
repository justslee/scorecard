"use client";

/**
 * CourseSearch — full-screen, Google-Maps-style course-search surface in the
 * yardage-book theme.
 *
 * Structural fix (owner escalation, 2026-07-06): the previous bottom sheet
 * used `maxHeight: "90vh"` + flex content that grew/shrank with results and
 * the iOS keyboard viewport — on Capacitor, the keyboard shrinking the visual
 * viewport recomputed `90vh` and the sheet jumped. This surface is instead a
 * FIXED `position: fixed; inset: 0` frame at `100dvh`, never bound to content
 * or result count: only the inner scroll region grows, the outer frame never
 * does. The keyboard overlays the bottom of the scroll region instead.
 *
 * Idle (no query) stable sections, Google-Maps order: Favorites
 * (course-favorites.ts), Recent (getRecentCourses()), Nearby (searchNearby +
 * mergeAndSortNearby) — deduped against each other by courseNameKey so a
 * favorite never echoes under Recent/Nearby (course-search-helpers.ts).
 * Typed results replace the idle sections as ONE stable append-only list,
 * driven by a course-search session (course-search-session.ts) around
 * searchAllCourses() — rows never reshuffle under the user.
 *
 * One consolidated CourseRow idiom renders every section. Loading is a
 * subtle pulsing dot in the search bar — never a layout shift.
 *
 * Design: T.* tokens (T.paper / T.ink / T.serif / T.mono) and inline SVGs.
 * No Tailwind classes, no lucide-react, no zinc/emerald dark theme.
 */

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { searchNearby, getRecentCourses, type CourseSearchResult, type RecentCourse } from "@/lib/golf-api";
import {
  createCourseSearchSession,
  type CourseSearchSession,
} from "@/lib/course-search-session";
import { GPSWatcher } from "@/lib/gps";
import {
  listFavorites,
  addFavorite,
  removeFavorite,
  type FavoriteCourse,
} from "@/lib/course-favorites";
import {
  mergeAndSortNearby,
  dedupeIdleSections,
  buildRowSubline,
  resultSourceLabel,
  type NearbyResult,
} from "@/lib/course-search-helpers";
import { useLooperDictation } from "@/hooks/useLooperDictation";
import { buildKeyterms } from "@/lib/voice/keyterms";

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
  /**
   * Geographic centre of the course (from CourseSearchResult.center).
   * Present for GolfAPI and OSM results; used to open a center-only map view
   * for non-ingested courses instead of the old GolfAPI detail dead-end.
   */
  center?: { lat: number; lng: number };
}

interface CourseSearchProps {
  onSelectCourse: (course: CourseSelectPayload) => void;
  onClose: () => void;
  /**
   * Optional mic affordance handler. When absent (and voiceSearch is off),
   * the mic button is hidden (no dead tap targets). round/new wires this to
   * its existing Realtime voice-setup panel.
   */
  onVoiceSearch?: () => void;
  /**
   * Built-in voice search (specs/looper-orb-plan.md, courses context): the
   * mic dictates INTO the query input via live transcription — interim words
   * type themselves and the debounced search fires as usual. Takes precedence
   * over onVoiceSearch when both are set.
   */
  voiceSearch?: boolean;
  /** Start dictating immediately on mount (orb long-press / courses summon). */
  autoVoice?: boolean;
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

function ChevronLeftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 19v3" />
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
// Payload mappers
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
    center: r.center,
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
    center: f.center,
  };
}

/** Map a RecentCourse to the onSelectCourse payload. */
function recentToPayload(r: RecentCourse): CourseSelectPayload {
  return {
    id: r.id,
    name: r.name,
    clubName: r.clubName ?? r.name,
    clubId: r.id,
    source: r.source,
    center: r.center,
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

/** Build a FavoriteCourse from a RecentCourse (source defaults to "local" — recent rows may predate the source field). */
function recentToFavorite(r: RecentCourse): Omit<FavoriteCourse, "favoritedAt"> {
  return {
    id: String(r.id),
    name: r.name,
    clubName: r.clubName,
    center: r.center,
    source: (r.source as FavoriteCourse["source"]) ?? "local",
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
        padding: "14px 22px 4px",
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
// CourseRow — one consolidated row idiom for every section
// ---------------------------------------------------------------------------

function CourseRow({
  title,
  subline,
  starred,
  onStar,
  onSelect,
}: {
  title: string;
  subline?: string;
  starred?: boolean;
  onStar?: (e: React.MouseEvent) => void;
  onSelect: () => void;
}) {
  // The row is a div[role=button] (NOT a <button>) so the star toggle inside
  // it can be a real <button> — interactive-in-interactive is invalid HTML and
  // breaks iOS hit-testing / VoiceOver.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        width: "100%",
        padding: "13px 22px",
        background: "transparent",
        borderTop: `1px dashed ${T.hairline}`,
        cursor: "pointer",
        textAlign: "left",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        alignItems: "center",
        gap: 10,
        minHeight: 44,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: T.serif,
            fontSize: 16,
            color: T.ink,
            letterSpacing: -0.2,
            marginBottom: subline ? 2 : 0,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </div>
        {subline && (
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 8.5,
              letterSpacing: 1.1,
              color: T.pencilSoft,
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {subline}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {onStar && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onStar(e);
            }}
            aria-label={starred ? "Remove from favorites" : "Add to favorites"}
            style={{
              width: 34,
              height: 34,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: starred ? 1 : 0.4,
            }}
          >
            <StarIcon filled={!!starred} />
          </button>
        )}
        <div style={{ fontFamily: T.mono, fontSize: 10, color: T.pencil }}>{"›"}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CourseSearch({ onSelectCourse, onClose, onVoiceSearch, voiceSearch = false, autoVoice = false }: CourseSearchProps) {
  const [query, setQuery] = useState("");

  // Search results (query mode)
  const [searchResults, setSearchResults] = useState<CourseSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Favorites (idle-state) — refreshed on every star toggle
  const [favorites, setFavorites] = useState<FavoriteCourse[]>(() => listFavorites());

  // Recent (idle-state) — synchronous localStorage read, SSR-safe (see golf-api.ts).
  const [recent] = useState<RecentCourse[]>(() => getRecentCourses());

  // Nearby (idle-state). Starts "loading" — the GPS effect below always kicks
  // off a fetch unconditionally on mount, so there's no real "idle" moment.
  const [nearby, setNearby] = useState<NearbyResult[]>([]);
  const [nearbyState, setNearbyState] = useState<"idle" | "loading" | "done" | "denied">("loading");

  // Track which result ids are starred so star state updates instantly
  const [starredIds, setStarredIds] = useState<Set<string>>(() => {
    const favs = listFavorites();
    return new Set(favs.map((f) => f.id));
  });

  // Built-in voice search (voiceSearch prop): live dictation types into the
  // query — interim words update the input (debounced search fires as usual),
  // tap-stop finalizes. Same shared mic machinery as the Looper sheets.
  const voiceToggleRef = useRef<() => void>(() => {});
  const dictation = useLooperDictation({
    surface: "course-search",
    // Bias STT toward course names the golfer is likely to say.
    getKeyterms: () =>
      buildKeyterms(
        favorites.map((f) => f.name),
        recent.map((r) => String(r.name)),
        nearby.map((n) => n.name),
      ),
    onUtteranceEnd: () => voiceToggleRef.current(),
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  const handleVoiceToggle = async () => {
    if (dictation.listening) {
      const finalText = await dictation.stopAndResolve();
      if (finalText) handleQueryChange(finalText);
      return;
    }
    await dictation.start();
  };
  voiceToggleRef.current = () => void handleVoiceToggle();
  // Interim words type themselves into the search box.
  useEffect(() => {
    if (voiceSearch && dictation.listening && dictation.interim) {
      handleQueryChange(dictation.interim);
    }
    // handleQueryChange is a stable function declaration in this component.
     
  }, [voiceSearch, dictation.listening, dictation.interim]);
  // Auto-start on mount when summoned by voice; always release on unmount.
  useEffect(() => {
    if (voiceSearch && autoVoice) {
      const t = setTimeout(() => void dictationRef.current.start(), 80);
      return () => {
        clearTimeout(t);
        dictationRef.current.cancel();
      };
    }
    return () => dictationRef.current.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Course-search session — owns the AbortController + stale-query guard so
  // results for a superseded query can never render (see course-search-session.ts).
  const sessionRef = useRef<CourseSearchSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createCourseSearchSession({
      onResults: setSearchResults,
      onError: setSearchError,
      onSettled: () => setSearchLoading(false),
    });
  }

  // ---------------------------------------------------------------------------
  // One-shot GPS for nearby (on mount, best-effort)
  // ---------------------------------------------------------------------------
  useEffect(() => {
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

  /**
   * Query change handler — the event handler is where synchronous UI resets
   * belong (not an effect body): mark the new query live immediately so any
   * in-flight request for the previous query goes stale before the debounce
   * even fires, and reset to a clean slate for a short/cleared query.
   */
  function handleQueryChange(next: string) {
    setQuery(next);
    const session = sessionRef.current!;
    session.noteQuery(next);

    if (next.length < 2) {
      session.cancel();
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
    } else {
      setSearchLoading(true);
      setSearchError(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Debounced search (250ms) — only kicks off the actual network call; all
  // synchronous state resets live in handleQueryChange above.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (query.length < 2) return;

    const timer = setTimeout(() => {
      sessionRef.current!.search(query);
    }, 250);

    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  // Abort any in-flight search on unmount.
  useEffect(() => {
    return () => {
      sessionRef.current?.cancel();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Star toggle helpers
  // ---------------------------------------------------------------------------

  function applyFavoritesUpdate(updated: FavoriteCourse[]) {
    setFavorites(updated);
    setStarredIds(new Set(updated.map((f) => f.id)));
  }

  function toggleResultStar(r: CourseSearchResult, e: React.MouseEvent) {
    e.stopPropagation();
    const favId = resultFavId(r);
    if (starredIds.has(favId)) {
      applyFavoritesUpdate(removeFavorite(favId));
    } else {
      applyFavoritesUpdate(addFavorite(resultToFavorite(r)));
    }
  }

  function toggleRecentStar(r: RecentCourse, e: React.MouseEvent) {
    e.stopPropagation();
    const favId = String(r.id);
    if (starredIds.has(favId)) {
      applyFavoritesUpdate(removeFavorite(favId));
    } else {
      applyFavoritesUpdate(addFavorite(recentToFavorite(r)));
    }
  }

  function removeFavoriteStar(f: FavoriteCourse, e: React.MouseEvent) {
    e.stopPropagation();
    applyFavoritesUpdate(removeFavorite(f.id));
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const isEmptyState = query.length < 2;
  const hasNoResults = !searchLoading && searchResults.length === 0 && query.length >= 2;

  // Idle sections never echo the same course twice across Favorites/Recent/Nearby.
  const idle = dedupeIdleSections(favorites, recent, nearby);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AnimatePresence>
      <motion.div
        key="cs-surface"
        data-testid="course-search-surface"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ duration: 0.2, ease: T.ease }}
        style={{
          position: "fixed",
          inset: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          // Fixed to the visual viewport height — NEVER bound to content or
          // result count (this is the structural fix for the resize jank).
          height: "100dvh",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          overflow: "hidden",
        }}
      >
        {/* Fixed top search bar */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "max(14px, env(safe-area-inset-top)) 14px 12px",
            borderBottom: `1px solid ${T.hairline}`,
          }}
        >
          <button
            onClick={onClose}
            aria-label="Back"
            style={{
              width: 40,
              height: 40,
              flexShrink: 0,
              borderRadius: 99,
              border: "none",
              background: "transparent",
              color: T.ink,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <ChevronLeftIcon />
          </button>

          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
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
              onChange={(e) => handleQueryChange(e.target.value)}
              autoFocus
              style={{
                width: "100%",
                padding: "11px 34px 11px 38px",
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
            {/* Subtle inline loading — pulsing dot, never a layout shift. */}
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

          {(voiceSearch || onVoiceSearch) && (
            <button
              onClick={voiceSearch ? () => void handleVoiceToggle() : onVoiceSearch}
              aria-label={voiceSearch && dictation.listening ? "Stop dictating" : "Voice search"}
              style={{
                width: 40,
                height: 40,
                flexShrink: 0,
                borderRadius: 99,
                border: `1px solid ${voiceSearch && dictation.listening ? T.ink : T.hairline}`,
                background: voiceSearch && dictation.listening ? T.ink : "transparent",
                color: voiceSearch && dictation.listening ? T.paper : T.pencil,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <MicIcon />
            </button>
          )}
        </div>

        {/* Error */}
        {searchError && (
          <div
            style={{
              flexShrink: 0,
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

        {/* Scrollable content — the ONLY region that grows with results.
            The outer frame above never resizes, regardless of row count. */}
        <div
          data-testid="course-search-scroll-region"
          style={{
            flex: 1,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            padding: "4px 0 max(24px, env(safe-area-inset-bottom))",
          }}
        >
          {isEmptyState ? (
            /* ── Idle sections: Favorites, Recent, Nearby ── */
            <>
              {idle.favorites.length > 0 && (
                <>
                  <SectionLabel>Favorites</SectionLabel>
                  {idle.favorites.map((f) => (
                    <CourseRow
                      key={`fav-${f.id}`}
                      title={f.name}
                      subline={buildRowSubline({ name: f.name, clubName: f.clubName })}
                      starred={true}
                      onStar={(e) => removeFavoriteStar(f, e)}
                      onSelect={() => onSelectCourse(favoriteToPayload(f))}
                    />
                  ))}
                </>
              )}

              {idle.recent.length > 0 && (
                <>
                  <SectionLabel>Recent</SectionLabel>
                  {idle.recent.map((r) => (
                    <CourseRow
                      key={`recent-${r.id}`}
                      title={r.name}
                      subline={buildRowSubline({ name: r.name, clubName: r.clubName })}
                      starred={starredIds.has(String(r.id))}
                      onStar={(e) => toggleRecentStar(r, e)}
                      onSelect={() => onSelectCourse(recentToPayload(r))}
                    />
                  ))}
                </>
              )}

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

              {nearbyState === "done" && idle.nearby.length > 0 && (
                <>
                  <SectionLabel>Nearby</SectionLabel>
                  {idle.nearby.map((r) => (
                    <CourseRow
                      key={r.id}
                      title={r.name}
                      subline={buildRowSubline({
                        name: r.name,
                        city: r.city,
                        state: r.state,
                        distanceMi: r.distanceMi,
                        sourceLabel: resultSourceLabel(r),
                      })}
                      starred={starredIds.has(resultFavId(r))}
                      onStar={(e) => toggleResultStar(r, e)}
                      onSelect={() => onSelectCourse(resultToPayload(r))}
                    />
                  ))}
                </>
              )}

              {/* Quiet hint when there's nothing else to show */}
              {nearbyState === "denied" && idle.favorites.length === 0 && idle.recent.length === 0 && (
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

              {nearbyState === "denied" && (idle.favorites.length > 0 || idle.recent.length > 0) && (
                <div style={{ padding: "14px 22px 0" }}>
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

              {nearbyState === "idle" &&
                idle.favorites.length === 0 &&
                idle.recent.length === 0 && (
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
            /* ── Typed results: one stable, append-only list ── */
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
                <CourseRow
                  key={r.id}
                  title={r.name}
                  subline={buildRowSubline({
                    name: r.name,
                    city: r.city,
                    state: r.state,
                    sourceLabel: resultSourceLabel(r),
                  })}
                  starred={starredIds.has(resultFavId(r))}
                  onStar={(e) => toggleResultStar(r, e)}
                  onSelect={() => onSelectCourse(resultToPayload(r))}
                />
              ))}
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
