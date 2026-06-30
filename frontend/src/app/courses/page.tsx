"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { getRecentCourses, searchNearby, type CourseSearchResult } from "@/lib/golf-api";
import { mapRecentCourses, type RecentCourseItem } from "@/lib/course-list";
import { courseHref } from "@/lib/course-url";
import CourseSearch from "@/components/CourseSearch";

// Mapped courses ingested into the PostGIS store via ingest_osm_course.py.
// UUIDs are deterministic: _deterministic_uuid(<course-key>) in osm_ingest.py.
// Run the ingest script on the deploy box to populate each course; the viewer
// renders once the row exists in the DB.
const BETHPAGE_BLACK_MAP_ID = "2b8caab5-2c55-5752-8cda-336c3a396dac"; // key: osm-bethpage-black
// Bethpage Red: ingest with --course-key osm-bethpage-red --target-course Red
// (prod ingest required before this entry renders in the viewer)
const BETHPAGE_RED_MAP_ID   = "269e1f2e-65cc-5cf6-a9b0-f5908e298155"; // key: osm-bethpage-red

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CoursesHubPage() {
  const router = useRouter();

  const [showSearch, setShowSearch] = useState(false);
  // Lazy initializer: getRecentCourses() is synchronous (localStorage) and already
  // SSR-safe (guards typeof window). Avoids calling setState in a synchronous effect.
  const [recent] = useState<RecentCourseItem[]>(() =>
    mapRecentCourses(getRecentCourses())
  );
  const [nearby, setNearby] = useState<CourseSearchResult[]>([]);
  const [nearbyState, setNearbyState] = useState<"idle" | "loading" | "done">("idle");

  // Attempt nearby search on mount (best-effort, device-only)
  useEffect(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return;

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setNearbyState("loading");
        try {
          const res = await searchNearby(pos.coords.latitude, pos.coords.longitude);
          setNearby(res);
        } catch {
          // Best-effort — silently ignore on error
        }
        setNearbyState("done");
      },
      () => {
        // Permission denied / no fix — omit the section entirely (NORTHSTAR: no noise)
      },
      { timeout: 8000, maximumAge: 600000 }
    );
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        fontFamily: T.sans,
        color: T.ink,
      }}
    >
      <div
        style={{
          maxWidth: 420,
          margin: "0 auto",
          // Hub pattern: clear the floating tab bar
          paddingBottom: "calc(88px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {/* ── Masthead ── */}
        <div
          style={{
            padding: "max(14px, env(safe-area-inset-top)) 22px 14px",
          }}
        >
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.6,
              color: T.pencil,
              textTransform: "uppercase",
            }}
          >
            Courses
          </div>
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 32,
              letterSpacing: -0.7,
              color: T.ink,
              lineHeight: 1.05,
              marginTop: 4,
            }}
          >
            The course book.
          </div>
        </div>

        {/* ── Find a course affordance ── */}
        <div style={{ padding: "4px 22px 18px" }}>
          <motion.button
            onClick={() => setShowSearch(true)}
            whileTap={{ scale: 0.98 }}
            style={{
              width: "100%",
              border: `1px solid ${T.hairline}`,
              borderRadius: 14,
              padding: 14,
              background: T.paper,
              cursor: "pointer",
              textAlign: "left",
              transition: "background 0.2s",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencil,
                  textTransform: "uppercase",
                }}
              >
                Find a course
              </div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1.2,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                }}
              >
                Tap to search
              </div>
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 19,
                color: T.pencilSoft,
                marginTop: 3,
              }}
            >
              Search by name or location
            </div>
          </motion.button>
        </div>

        {/* ── Recent courses ── */}
        {recent.length > 0 && (
          <div style={{ padding: "0 22px 18px" }}>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Recent
            </div>
            <div>
              {recent.map((item, i) => (
                <button
                  key={item.id}
                  onClick={() => router.push(item.href)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 0",
                    borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                    background: "transparent",
                    border: i === 0 ? "none" : undefined,
                    borderTopColor: i === 0 ? undefined : T.hairline,
                    borderTopStyle: i === 0 ? undefined : "dashed",
                    borderLeft: "none",
                    borderRight: "none",
                    borderBottom: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    minHeight: 44,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontSize: 16,
                        color: T.ink,
                        letterSpacing: -0.2,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {item.title}
                    </div>
                    {item.subtitle && (
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8.5,
                          letterSpacing: 1.1,
                          color: T.pencilSoft,
                          textTransform: "uppercase",
                          marginTop: 2,
                        }}
                      >
                        {item.subtitle}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.pencil,
                      flexShrink: 0,
                    }}
                  >
                    {"›"}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Nearby courses (device-only, best-effort) ── */}
        {nearbyState === "done" && nearby.length > 0 && (
          <div style={{ padding: "0 22px 18px" }}>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Nearby
            </div>
            <div>
              {nearby.map((r, i) => (
                <button
                  key={r.id}
                  onClick={() =>
                    router.push(
                      courseHref({
                        courseId: r.golfApiCourseId ?? r.id,
                        clubId: r.golfApiClubId,
                      })
                    )
                  }
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 0",
                    borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                    background: "transparent",
                    border: i === 0 ? "none" : undefined,
                    borderTopColor: i === 0 ? undefined : T.hairline,
                    borderTopStyle: i === 0 ? undefined : "dashed",
                    borderLeft: "none",
                    borderRight: "none",
                    borderBottom: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    minHeight: 44,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontSize: 16,
                        color: T.ink,
                        letterSpacing: -0.2,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {r.name}
                    </div>
                    {(r.city || r.state) && (
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8.5,
                          letterSpacing: 1.1,
                          color: T.pencilSoft,
                          textTransform: "uppercase",
                          marginTop: 2,
                        }}
                      >
                        {[r.city, r.state].filter(Boolean).join(", ")}
                      </div>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      color: T.pencil,
                      flexShrink: 0,
                    }}
                  >
                    {"›"}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {/* ── Course maps (beta) ── */}
        <div
          style={{
            padding: "0 22px 18px",
            borderTop: `1px solid ${T.hairline}`,
            marginTop: 2,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 7,
              marginBottom: 8,
              paddingTop: 16,
            }}
          >
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
              }}
            >
              Course maps
            </div>
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 7.5,
                letterSpacing: 1.2,
                color: T.pencilSoft,
                border: `1px solid ${T.hairline}`,
                padding: "1px 5px",
                borderRadius: 3,
                textTransform: "uppercase",
                lineHeight: 1.6,
              }}
            >
              beta
            </span>
          </div>

          <button
            onClick={() => router.push(`/map/course?id=${BETHPAGE_BLACK_MAP_ID}`)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 0",
              background: "transparent",
              border: "none",
              borderTop: `1px dashed ${T.hairline}`,
              cursor: "pointer",
              textAlign: "left",
              minHeight: 44,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 16,
                  color: T.ink,
                  letterSpacing: -0.2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Bethpage Black
              </div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1.1,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                  marginTop: 2,
                }}
              >
                Hole map
              </div>
            </div>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                color: T.pencil,
                flexShrink: 0,
              }}
            >
              {"›"}
            </div>
          </button>

          <button
            onClick={() => router.push(`/map/course?id=${BETHPAGE_RED_MAP_ID}`)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 0",
              background: "transparent",
              border: "none",
              borderTop: `1px dashed ${T.hairline}`,
              cursor: "pointer",
              textAlign: "left",
              minHeight: 44,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 16,
                  color: T.ink,
                  letterSpacing: -0.2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Bethpage Red
              </div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1.1,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                  marginTop: 2,
                }}
              >
                Hole map
              </div>
            </div>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                color: T.pencil,
                flexShrink: 0,
              }}
            >
              {"›"}
            </div>
          </button>
        </div>
      </div>

      {/* ── CourseSearch overlay ── */}
      {showSearch && (
        <CourseSearch
          onClose={() => setShowSearch(false)}
          onSelectCourse={(c) => {
            setShowSearch(false);
            if (c.source === "mapped") {
              // Full hole-by-hole map (ingested course with OSM geometry)
              router.push(`/map/course?id=${encodeURIComponent(String(c.id))}`);
            } else if (c.center) {
              // Non-ingested course with known location → satellite/vector map
              // centred on lat/lng (GPS + tap-to-measure work everywhere; no hole data yet)
              const qs = new URLSearchParams({
                name: c.name,
                lat:  String(c.center.lat),
                lng:  String(c.center.lng),
              });
              // Include id for display even if not yet ingested
              if (c.id) qs.set("id", String(c.id));
              router.push(`/map/course?${qs.toString()}`);
            } else {
              // Fallback: GolfAPI detail page (no location available)
              router.push(courseHref({ courseId: c.id, clubId: c.clubId }));
            }
          }}
        />
      )}
    </div>
  );
}
