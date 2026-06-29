"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import {
  getCourseDetails,
  getClubDetails,
  composeCourseName,
  saveRecentCourse,
  type GolfCourse,
  type GolfClub,
  type Tee,
} from "@/lib/golf-api";
import { stashCourseForRound } from "@/lib/course-handoff";
import { getCourseReviews } from "@/lib/api";
import type { CourseReview } from "@/lib/types";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CourseDetailClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const courseId = sp.get("id");
  const clubId = sp.get("clubId");

  const [course, setCourse] = useState<GolfCourse | null>(null);
  const [club, setClub] = useState<GolfClub | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviews, setReviews] = useState<CourseReview[]>([]);

  useEffect(() => {
    if (!courseId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const [courseData, clubData, reviewData] = await Promise.all([
          getCourseDetails(courseId!),
          clubId ? getClubDetails(clubId) : Promise.resolve(null),
          getCourseReviews(courseId!).catch(() => [] as CourseReview[]), // silent fail → empty
        ]);
        if (!cancelled) {
          setCourse(courseData);
          setClub(clubData);
          setReviews(reviewData);
        }
      } catch {
        // getCourseDetails / getClubDetails already swallow errors and return null.
        // This outer catch is a safety net for unexpected runtime failures.
        if (!cancelled) {
          setCourse(null);
          setClub(null);
          setReviews([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [courseId, clubId]);

  // ── Derived display values ────────────────────────────────────────────────

  const name = composeCourseName(club?.name ?? "", course?.name ?? club?.name ?? "");
  const location = [club?.city, club?.state, club?.country].filter(Boolean).join(", ");
  const tees: Tee[] = course?.tees ?? [];

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: T.mono,
          fontSize: 10,
          letterSpacing: 1.6,
          color: T.pencilSoft,
          textTransform: "uppercase",
        }}
      >
        Loading&hellip;
      </div>
    );
  }

  // ── Not-found state ───────────────────────────────────────────────────────

  if (!course && !club) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: "multiply",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px 22px",
          textAlign: "center",
          fontFamily: T.sans,
          color: T.ink,
        }}
      >
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 22,
            letterSpacing: -0.3,
            color: T.pencil,
            lineHeight: 1.3,
          }}
        >
          Course not found.
        </div>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.pencilSoft,
            textTransform: "uppercase",
            marginTop: 8,
          }}
        >
          It may no longer be in the directory.
        </div>
        <button
          onClick={() => router.push("/courses")}
          style={{
            marginTop: 24,
            padding: "11px 24px",
            borderRadius: 99,
            border: `1px solid ${T.hairline}`,
            background: "transparent",
            color: T.ink,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: 1.3,
            cursor: "pointer",
            textTransform: "uppercase",
            minHeight: 44,
          }}
        >
          Back to courses
        </button>
      </div>
    );
  }

  // ── "Start a round here" handler ─────────────────────────────────────────

  function handleStartRound() {
    const handoff = {
      id: courseId ?? String(club?.id ?? ""),
      name,
      clubName: club?.name,
      location: location || undefined,
      holes: course?.holes,
      par: course?.par,
    };
    saveRecentCourse({
      id: courseId ?? String(club?.id ?? ""),
      name,
      clubName: club?.name ?? name,
    });
    stashCourseForRound(handoff);
    router.push("/round/new");
  }

  // ── Main render ───────────────────────────────────────────────────────────

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
          paddingBottom: "calc(32px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: "max(14px, env(safe-area-inset-top)) 22px 14px",
          }}
        >
          <button
            onClick={() => router.push("/courses")}
            style={{
              background: "transparent",
              border: "none",
              padding: "0 8px",
              cursor: "pointer",
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.4,
              color: T.pencil,
              textTransform: "uppercase",
              display: "flex",
              alignItems: "center",
              gap: 4,
              marginBottom: 10,
              minHeight: 44,
            }}
          >
            <span style={{ fontSize: 11 }}>{"←"}</span> Courses
          </button>

          {/* Kicker */}
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.6,
              color: T.pencil,
              textTransform: "uppercase",
            }}
          >
            Course
          </div>

          {/* Course name */}
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
            {name}
          </div>

          {/* Location */}
          {location && (
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 8.5,
                letterSpacing: 1.1,
                color: T.pencilSoft,
                textTransform: "uppercase",
                marginTop: 4,
              }}
            >
              {location}
            </div>
          )}

          {/* Par / Holes mini-stats */}
          {(course?.par || course?.holes) && (
            <div style={{ display: "flex", gap: 18, marginTop: 12 }}>
              {course.par && <MiniStat k="Par" v={course.par} />}
              {course.holes && <MiniStat k="Holes" v={course.holes} />}
            </div>
          )}
        </div>

        {/* ── Tees section ── */}
        <div style={{ padding: "18px 22px 10px" }}>
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
            Tees
          </div>

          {tees.length === 0 ? (
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 14,
                color: T.pencilSoft,
                letterSpacing: -0.1,
                paddingTop: 4,
              }}
            >
              Tee data unavailable.
            </div>
          ) : (
            <div>
              {tees.map((tee, i) => (
                <div
                  key={String(tee.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 0",
                    borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                    minHeight: 44,
                  }}
                >
                  {/* Color dot */}
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 99,
                      background: tee.color ?? T.pencilSoft,
                      border: `1px solid ${T.hairline}`,
                      flexShrink: 0,
                    }}
                  />
                  {/* Tee name */}
                  <div
                    style={{
                      flex: 1,
                      fontFamily: T.serif,
                      fontSize: 16,
                      color: T.ink,
                      letterSpacing: -0.2,
                    }}
                  >
                    {tee.name}
                  </div>
                  {/* Total yards */}
                  {tee.totalYards != null && (
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 10,
                        letterSpacing: 1.1,
                        color: T.pencilSoft,
                      }}
                    >
                      {tee.totalYards} y
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Reviews section — only rendered when there is at least one review ── */}
        {reviews.length > 0 && (
          <div style={{ padding: "18px 22px 10px" }}>
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
              Reviews
            </div>

            <div>
              {reviews.map((review, i) => {
                // Prefer playedAt (YYYY-MM-DD); fall back to createdAt (ISO datetime).
                const rawDate = review.playedAt ?? review.createdAt;
                // YYYY-MM-DD parses as UTC midnight and can show the prior day in negative-UTC
                // timezones; force local-midnight parsing by appending a local time component.
                const d = /^\d{4}-\d{2}-\d{2}$/.test(rawDate ?? "")
                  ? new Date(`${rawDate}T00:00:00`)
                  : new Date(rawDate);
                const dateLabel = isNaN(d.getTime())
                  ? ""
                  : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                return (
                  <div
                    key={review.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "11px 0",
                      borderTop: i === 0 ? "none" : `1px dashed ${T.hairline}`,
                      minHeight: 44,
                    }}
                  >
                    {/* Left: body note + date */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {review.body && (
                        <div
                          style={{
                            fontFamily: T.serif,
                            fontSize: 15,
                            color: T.ink,
                            letterSpacing: -0.1,
                            lineHeight: 1.4,
                          }}
                        >
                          {review.body}
                        </div>
                      )}
                      {dateLabel && (
                        <div
                          style={{
                            fontFamily: T.mono,
                            fontSize: 9,
                            letterSpacing: 1.1,
                            color: T.pencilSoft,
                            textTransform: "uppercase",
                            marginTop: review.body ? 3 : 0,
                          }}
                        >
                          {dateLabel}
                        </div>
                      )}
                    </div>
                    {/* Right: rating */}
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 10,
                        letterSpacing: 1.1,
                        color: T.ink,
                        flexShrink: 0,
                      }}
                    >
                      {review.rating} / 5
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Primary CTA ── */}
        <div style={{ padding: "10px 22px 20px" }}>
          <button
            onClick={handleStartRound}
            style={{
              width: "100%",
              padding: "15px",
              borderRadius: 99,
              border: "none",
              background: T.ink,
              color: T.paper,
              cursor: "pointer",
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 18,
              letterSpacing: -0.2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
            }}
          >
            Start a round here
            <span
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: 1.2,
                opacity: 0.7,
                fontStyle: "normal",
              }}
            >
              {"→"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MiniStat({ k, v }: { k: string; v: number | string }) {
  return (
    <div>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 8,
          letterSpacing: 1.2,
          color: T.pencilSoft,
          textTransform: "uppercase",
        }}
      >
        {k}
      </div>
      <div
        style={{
          fontFamily: T.serif,
          fontSize: 22,
          color: T.ink,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
          marginTop: 2,
        }}
      >
        {v}
      </div>
    </div>
  );
}
