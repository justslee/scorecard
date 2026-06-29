"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import { getRecentCourses, searchNearby, type CourseSearchResult } from "@/lib/golf-api";
import { mapRecentCourses, type RecentCourseItem } from "@/lib/course-list";
import { courseHref } from "@/lib/course-url";
import CourseSearch from "@/components/CourseSearch";

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
          <button
            onClick={() => setShowSearch(true)}
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
          </button>
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
      </div>

      {/* ── CourseSearch overlay ── */}
      {showSearch && (
        <CourseSearch
          onClose={() => setShowSearch(false)}
          onSelectCourse={(c) => {
            setShowSearch(false);
            router.push(courseHref({ courseId: c.id, clubId: c.clubId }));
          }}
        />
      )}
    </div>
  );
}
