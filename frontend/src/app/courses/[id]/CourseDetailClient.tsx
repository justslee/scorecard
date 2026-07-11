"use client";

import { useEffect, useMemo, useState } from "react";
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
import { fetchMappedCourse, type CourseData } from "@/lib/courses/mapped-course-api";
import { stashCourseForRound, type CourseHandoff } from "@/lib/course-handoff";
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
  // Unified landing (see lib/course-url.ts courseDetailHref): src=mapped loads
  // the PostGIS store; any other src renders from the carried params (name/lat/
  // lng/loc) because non-ingested search results have no backend row to fetch.
  const src = sp.get("src");
  const nameParam = sp.get("name");
  const locParam = sp.get("loc");
  const paramCenter = useMemo(() => {
    const latRaw = sp.get("lat");
    const lngRaw = sp.get("lng");
    if (!latRaw || !lngRaw) return null;
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }, [sp]);

  const isMapped = src === "mapped";
  const isCenterOnly = !isMapped && !!src && src !== "golfapi" && !!paramCenter;

  const [course, setCourse] = useState<GolfCourse | null>(null);
  const [club, setClub] = useState<GolfClub | null>(null);
  const [mapped, setMapped] = useState<CourseData | null>(null);
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
        const reviewsP = getCourseReviews(courseId!).catch(() => [] as CourseReview[]); // silent fail → empty
        if (isMapped) {
          const [mappedData, reviewData] = await Promise.all([
            fetchMappedCourse(courseId!).catch(() => null),
            reviewsP,
          ]);
          if (!cancelled) {
            setMapped(mappedData);
            setReviews(reviewData);
          }
        } else if (isCenterOnly) {
          // No backend row guaranteed — the params carry the display data.
          const reviewData = await reviewsP;
          if (!cancelled) setReviews(reviewData);
        } else {
          const [courseData, clubData, reviewData] = await Promise.all([
            getCourseDetails(courseId!),
            clubId ? getClubDetails(clubId) : Promise.resolve(null),
            reviewsP,
          ]);
          if (!cancelled) {
            setCourse(courseData);
            setClub(clubData);
            setReviews(reviewData);
          }
        }
      } catch {
        // getCourseDetails / getClubDetails already swallow errors and return null.
        // This outer catch is a safety net for unexpected runtime failures.
        if (!cancelled) {
          setCourse(null);
          setClub(null);
          setMapped(null);
          setReviews([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [courseId, clubId, isMapped, isCenterOnly]);

  // ── Derived display values ────────────────────────────────────────────────

  const mappedPar = mapped ? mapped.holes.reduce((s, h) => s + (h.par || 0), 0) : 0;
  const name = isMapped
    ? mapped?.name ?? ""
    : isCenterOnly
    ? nameParam ?? ""
    : composeCourseName(club?.name ?? "", course?.name ?? club?.name ?? "");
  const location = isMapped
    ? mapped?.address ?? ""
    : isCenterOnly
    ? locParam ?? ""
    : [club?.city, club?.state, club?.country].filter(Boolean).join(", ");
  // One display shape for both tee sources (GolfAPI tees / mapped tee sets).
  const tees: Tee[] = isMapped
    ? (mapped?.teeSets ?? []).map((ts) => {
        const total = (mapped?.holes ?? []).reduce(
          (s, h) => s + (h.yardages?.[ts.name] ?? 0),
          0
        );
        return {
          id: ts.name,
          name: ts.name,
          color: ts.color,
          totalYards: total > 0 ? total : undefined,
        };
      })
    : isCenterOnly
    ? []
    : course?.tees ?? [];

  const displayPar = isMapped ? mappedPar || undefined : course?.par;
  const displayHoles = isMapped ? mapped?.holes.length || undefined : course?.holes;

  // The /map/course viewer stays reachable FROM detail (it's a viewer, not a
  // landing). Mapped courses open by id (hole geometry) with the centre as a
  // graceful fallback for write-through rows that have no holes yet.
  const mapHref = useMemo(() => {
    if (isMapped && mapped) {
      const qs = new URLSearchParams({ id: mapped.id });
      if (mapped.location) {
        qs.set("name", mapped.name);
        qs.set("lat", String(mapped.location.lat));
        qs.set("lng", String(mapped.location.lng));
      }
      return `/map/course?${qs.toString()}`;
    }
    if (isCenterOnly && paramCenter) {
      const qs = new URLSearchParams({
        name: nameParam ?? "",
        lat: String(paramCenter.lat),
        lng: String(paramCenter.lng),
      });
      if (courseId) qs.set("id", courseId);
      return `/map/course?${qs.toString()}`;
    }
    return null;
  }, [isMapped, mapped, isCenterOnly, paramCenter, nameParam, courseId]);

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

  const notFound = isMapped ? !mapped : isCenterOnly ? false : !course && !club;
  if (notFound) {
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
    // source + center make the round carry the course anchor (round-anchor.ts)
    // so the yardage book renders the satellite map, not the paper fallback.
    const center = isMapped
      ? mapped?.location ?? undefined
      : isCenterOnly
      ? paramCenter ?? undefined
      : undefined;
    const handoff: CourseHandoff = {
      id: courseId ?? String(club?.id ?? ""),
      name,
      clubName: club?.name,
      location: location || undefined,
      holes: isMapped ? mapped?.holes.length || undefined : course?.holes,
      par: isMapped ? mappedPar || undefined : course?.par,
      source: src ?? undefined,
      center,
    };
    saveRecentCourse({
      id: courseId ?? String(club?.id ?? ""),
      name,
      clubName: club?.name ?? name,
      source: src ?? undefined,
      center,
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
          paddingBottom: "calc(88px + env(safe-area-inset-bottom, 0px))",
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
          {(displayPar || displayHoles) && (
            <div style={{ display: "flex", gap: 18, marginTop: 12 }}>
              {displayPar ? <MiniStat k="Par" v={displayPar} /> : null}
              {displayHoles ? <MiniStat k="Holes" v={displayHoles} /> : null}
            </div>
          )}
        </div>

        {/* ── Tees section (hidden for centre-only courses — nothing to show) ── */}
        {!isCenterOnly && (
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
        )}

        {/* ── Map affordance — the /map/course viewer, reachable from detail ── */}
        {mapHref && (
          <div style={{ padding: "0 22px" }}>
            <button
              onClick={() => router.push(mapHref)}
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
                  }}
                >
                  {isMapped && (mapped?.holes.length ?? 0) > 0
                    ? "Hole map"
                    : "Satellite map"}
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
                  {isMapped && (mapped?.holes.length ?? 0) > 0
                    ? "Hole-by-hole yardages"
                    : "GPS + tap to measure"}
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
        )}

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
