"use client";

import React, { ReactNode, useMemo, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import { getGolferProfileAsync, saveGolferProfileAsync, saveGolferBagAsync, getRoundsAsync } from "@/lib/storage-api";
import { calculateTotals } from "@/lib/types";
import { getOwnerPlayerId } from "@/lib/round-owner";
import type { GolferProfile, Round } from "@/lib/types";
import { deriveParTypeAverages, deriveScoreDistribution, deriveTrend } from "@/lib/profile-stats";
import type { ParTypeRow, ScoreDistRow, TrendResult } from "@/lib/profile-stats";

// ── Bag club config — ordered for display (matches GolferProfile.clubDistances keys)
// The caddie (CaddiePanel) normalises these same camelCase keys to short keys
// (driver→driver, threeWood→3wood, …) when calling the recommendation API.
type ClubKey = keyof GolferProfile["clubDistances"];

const CLUB_CONFIG: { key: ClubKey; label: string }[] = [
  { key: "driver",        label: "Driver"    },
  { key: "threeWood",     label: "3-wood"    },
  { key: "fiveWood",      label: "5-wood"    },
  { key: "hybrid",        label: "Hybrid"    },
  { key: "fourIron",      label: "4-iron"    },
  { key: "fiveIron",      label: "5-iron"    },
  { key: "sixIron",       label: "6-iron"    },
  { key: "sevenIron",     label: "7-iron"    },
  { key: "eightIron",     label: "8-iron"    },
  { key: "nineIron",      label: "9-iron"    },
  { key: "pitchingWedge", label: "PW"        },
  { key: "gapWedge",      label: "GW (52°)"  },
  { key: "sandWedge",     label: "SW (56°)"  },
  { key: "lobWedge",      label: "LW (60°)"  },
  { key: "putter",        label: "Putter (optional)" },
];

// ── ScoringByTee derived type ────────────────────────────────────────────────
// Bucketed by (teeName × holeCount) so 9-hole and 18-hole rounds at the same
// tee don't blend into a meaningless average.
type TeeRow = {
  tee: string;
  holeCount: number;     // round hole setup (9 or 18)
  yards: number | null;  // total yards when HoleInfo.yards is available
  par: number;           // par for this bucket's hole setup
  rounds: number;
  avgTotal: number;      // avg total strokes, integer (Math.round)
  avgOverPar: number;    // avg strokes over par, integer (Math.round)
};

/**
 * Compute per-tee scoring averages from the owner's completed rounds.
 * Owner's player resolved via getOwnerPlayerId() (prefers round.ownerPlayerId,
 * falls back to the first player for legacy rounds).
 * Buckets: (teeName × holeCount) so 9H and 18H rounds at the same tee stay
 * separate and each bucket's average is meaningful.
 * Rounds with fewer than 9 holes played are excluded (very partial/abandoned).
 */
function deriveScoringByTee(rounds: Round[]): TeeRow[] {
  const completed = rounds.filter(
    (r) => r.status === "completed" && r.players.length > 0
  );

  type BucketData = {
    totals: number[];
    toPars: number[];
    yards: number | null;
    par: number;
    holeCount: number;
  };

  // Key = "{teeName}|{holeCount}" — separates 9H and 18H rounds cleanly.
  const byBucket = new Map<string, BucketData>();

  for (const r of completed) {
    const teeName = r.teeName ?? "—";
    const ownerPid = getOwnerPlayerId(r);
    if (!ownerPid) continue;
    const t = calculateTotals(r.scores, r.holes, ownerPid);
    if (t.playedHoles < 9) continue; // skip very partial rounds

    const holeCount = r.holes.length;
    const bucketKey = `${teeName}|${holeCount}`;
    const totalYards = r.holes.reduce((s, h) => s + (h.yards ?? 0), 0);
    const par = r.holes.reduce((s, h) => s + h.par, 0);

    const existing = byBucket.get(bucketKey);
    if (existing) {
      existing.totals.push(t.total);
      existing.toPars.push(t.toPar);
    } else {
      byBucket.set(bucketKey, {
        totals: [t.total],
        toPars: [t.toPar],
        yards: totalYards > 0 ? totalYards : null,
        par,
        holeCount,
      });
    }
  }

  return Array.from(byBucket.entries())
    .map(([bucketKey, { totals, toPars, yards, par, holeCount }]) => {
      const tee = bucketKey.split("|")[0];
      const avgTotal = Math.round(totals.reduce((s, v) => s + v, 0) / totals.length);
      const avgOverPar = Math.round(toPars.reduce((s, v) => s + v, 0) / toPars.length);
      return { tee, holeCount, yards, par, rounds: totals.length, avgTotal, avgOverPar };
    })
    // 18H before 9H; within same holeCount: longest tee first, then alpha.
    .sort((a, b) =>
      b.holeCount - a.holeCount ||
      (b.yards ?? 0) - (a.yards ?? 0) ||
      a.tee.localeCompare(b.tee)
    );
}

// ── RoundLog derived type ────────────────────────────────────────────────────
type RoundLogEntry = {
  id: string;
  date: Date;
  course: string;
  teeName: string | null;
  holesPlayed: number;
  score: number | null;
  toPar: number | null;
};

/**
 * Derive a chronological log of the owner's completed rounds with totals.
 * Sorted most-recent first. Includes holes-played count so a 9-hole total
 * isn't mistaken for an 18-hole score. Guards against invalid date strings.
 * Owner's player resolved via getOwnerPlayerId() (prefers round.ownerPlayerId,
 * falls back to the first player for legacy rounds).
 */
function deriveRoundLog(rounds: Round[]): RoundLogEntry[] {
  return rounds
    .filter((r) => r.status === "completed" && r.players.length > 0)
    .map((r) => {
      // Guard: invalid date → epoch (sinks to bottom after sort, renders gracefully).
      const date = new Date(r.date);
      const safeDate = isNaN(date.getTime()) ? new Date(0) : date;
      const ownerPid = getOwnerPlayerId(r);
      const t = ownerPid ? calculateTotals(r.scores, r.holes, ownerPid) : null;
      const hasScore = t !== null && t.playedHoles >= 9;
      return {
        id: r.id,
        date: safeDate,
        course: r.courseName,
        teeName: r.teeName ?? null,
        holesPlayed: t?.playedHoles ?? 0,
        score: hasScore ? t!.total : null,
        toPar: hasScore ? t!.toPar : null,
      };
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

// ──────────────────────────────────────────────────────────────────────
// Edit-mode draft state (name / homeCourse / handicap only)
// ──────────────────────────────────────────────────────────────────────

type IdentityDraft = { name: string; homeCourse: string; handicap: string };

export default function ProfilePage() {
  const router = useRouter();
  const accent = DEFAULT_ACCENT;

  // ── Real profile data ──────────────────────────────────────────────
  // Use storage-api directly (same pattern as home/page.tsx) to avoid
  // Clerk's useAuth() hook — which can't run during Next.js prerender.
  const [profile, setProfile] = useState<GolferProfile | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getGolferProfileAsync(),
      getRoundsAsync(),
    ])
      .then(([p, rs]) => {
        setProfile(p);
        // Most-recent first (same ordering as home/page.tsx).
        const sorted = [...rs].sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        );
        setRounds(sorted);
      })
      .catch((e) => console.error("[profile] load error:", e))
      .finally(() => setLoading(false));
  }, []);

  // ── Edit state (identity/masthead + handicap only) ─────────────────
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<IdentityDraft>({ name: "", homeCourse: "", handicap: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const startEditing = useCallback(() => {
    setDraft({
      name: profile?.name ?? "",
      homeCourse: profile?.homeCourse ?? "",
      handicap: profile?.handicap != null ? String(profile.handicap) : "",
    });
    setSaveError(null);
    setEditing(true);
  }, [profile]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const hRaw = draft.handicap.trim();
      const handicap: number | null = hRaw === "" ? null : parseFloat(hRaw);
      if (hRaw !== "" && isNaN(handicap as number)) {
        setSaveError("Handicap must be a number");
        setSaving(false);
        return;
      }
      const updated: GolferProfile = {
        id: profile?.id ?? "",
        name: draft.name.trim() || null,
        handicap,
        homeCourse: draft.homeCourse.trim() || null,
        // clubDistances is intentionally omitted from the identity save
        // (saveGolferProfileAsync does not send it to the PUT body)
        // so we carry through the existing bag without risk of clobber.
        clubDistances: profile?.clubDistances ?? {},
      };
      // saveGolferProfileAsync: write-through (local cache + PUT).
      // Will re-throw on API rejections (4xx/5xx); TypeError (offline) is silent.
      await saveGolferProfileAsync(updated);
      setProfile(updated);
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [draft, profile]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setSaveError(null);
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
      <div style={{ maxWidth: 420, margin: "0 auto" }}>
        <Masthead
          onBack={() => router.push("/")}
          profile={profile}
          loading={loading}
          editing={editing}
          draft={draft}
          setDraft={setDraft}
          onEdit={startEditing}
          onSave={handleSave}
          onCancel={handleCancel}
          saving={saving}
          saveError={saveError}
        />
        <HandicapModule
          profile={profile}
          loading={loading}
          editing={editing}
          draft={draft}
          setDraft={setDraft}
        />
        {/* Real-data sections lead; placeholder at bottom (item 2 re-order) */}
        <Bag
          accent={accent}
          profile={profile}
          loading={loading}
          onBagSaved={(updated) => setProfile(updated)}
        />
        <ScoringByTee accent={accent} rounds={rounds} loading={loading} />
        <ParBreakdown rounds={rounds} loading={loading} />
        <ScoreDistribution rounds={rounds} loading={loading} />
        <YearLog accent={accent} rounds={rounds} loading={loading} />
        {/* Shot analytics — single calm placeholder replacing two stacked ones */}
        <ShotAnalytics />
        <Footer />
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Section shell
// ──────────────────────────────────────────────────────────────────────

function Section({
  kicker,
  title,
  aside,
  children,
  tight,
  preview,
}: {
  kicker: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  tight?: boolean;
  /** When true, appends a small "(Preview)" badge to mark unreal data. */
  preview?: boolean;
}) {
  return (
    <section style={{ padding: tight ? "18px 22px 14px" : "22px 22px 18px", borderTop: `1px solid ${T.hairline}`, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase", fontWeight: 500 }}>{kicker}</div>
            {preview && (
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 400 }}>(Preview)</div>
            )}
          </div>
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.4, lineHeight: 1, marginTop: 3 }}>{title}</div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Masthead — wired to real profile (name, homeCourse); editable via PUT.
// Fake kicker (№ 77 / member since) and GHIN card removed — not real data.
// ──────────────────────────────────────────────────────────────────────

interface MastheadProps {
  onBack: () => void;
  profile: GolferProfile | null;
  loading: boolean;
  editing: boolean;
  draft: IdentityDraft;
  setDraft: React.Dispatch<React.SetStateAction<IdentityDraft>>;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  saveError: string | null;
}

function Masthead({
  onBack,
  profile,
  loading,
  editing,
  draft,
  setDraft,
  onEdit,
  onSave,
  onCancel,
  saving,
  saveError,
}: MastheadProps) {
  // Real values; "—" when unset. opacity:0 while loading (avoids layout jump).
  const displayName = profile?.name ?? "—";
  const displayHome = profile?.homeCourse ?? "—";

  return (
    <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 18px", position: "relative" }}>
      {/* ── Header bar: back/book or cancel/save ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}>
        {editing ? (
          <>
            <button
              onClick={onCancel}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: "10px 0",
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                fontWeight: 500,
                minHeight: 44,
                display: "flex",
                alignItems: "center",
              }}
            >
              Cancel
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {saveError && (
                <span
                  style={{
                    fontFamily: T.mono,
                    fontSize: 8.5,
                    letterSpacing: 1,
                    color: T.errorInk,
                    textTransform: "uppercase",
                  }}
                >
                  {saveError}
                </span>
              )}
              <button
                onClick={onSave}
                disabled={saving}
                style={{
                  border: `1px solid ${T.ink}`,
                  borderRadius: 99,
                  padding: "6px 14px",
                  background: T.ink,
                  cursor: saving ? "not-allowed" : "pointer",
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.paper,
                  textTransform: "uppercase",
                  fontWeight: 500,
                  minHeight: 44,
                  display: "flex",
                  alignItems: "center",
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              onClick={onBack}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                padding: "10px 0",
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                fontWeight: 500,
                display: "flex",
                alignItems: "center",
                gap: 6,
                minHeight: 44,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 12 12">
                <path d="M8 2 L3 6 L8 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Home
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase", fontWeight: 500 }}>
                The Player&rsquo;s Book
              </div>
              <button
                onClick={onEdit}
                style={{
                  border: `1px solid ${T.hairline}`,
                  borderRadius: 99,
                  padding: "5px 10px",
                  background: "transparent",
                  cursor: "pointer",
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencil,
                  textTransform: "uppercase",
                  fontWeight: 500,
                  minHeight: 44,
                  minWidth: 44,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                Edit
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Identity block: name + home course (no caddy card — fake data removed) ── */}
      <div style={{ marginTop: 22 }}>
        {/* Name — real value, editable */}
        {editing ? (
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Your name"
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 38,
              color: T.ink,
              letterSpacing: -1,
              lineHeight: 1,
              background: "transparent",
              border: "none",
              borderBottom: `1.5px solid ${T.ink}`,
              outline: "none",
              padding: "2px 0",
              width: "100%",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: "italic",
              fontSize: 38,
              color: T.ink,
              letterSpacing: -1,
              lineHeight: 1,
              // opacity:0 while loading to avoid layout jump when text appears
              opacity: loading ? 0 : 1,
              transition: "opacity 0.15s",
            }}
          >
            {displayName}
          </div>
        )}

        {/* Home course — real value, editable */}
        {editing ? (
          <input
            value={draft.homeCourse}
            onChange={(e) => setDraft((d) => ({ ...d, homeCourse: e.target.value }))}
            placeholder="Home course"
            style={{
              fontFamily: T.serif,
              fontSize: 14,
              color: T.pencil,
              letterSpacing: -0.1,
              fontStyle: "italic",
              background: "transparent",
              border: "none",
              borderBottom: `1.5px solid ${T.ink}`,
              outline: "none",
              padding: "2px 0",
              marginTop: 6,
              width: "100%",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              fontFamily: T.serif,
              fontSize: 14,
              color: T.pencil,
              letterSpacing: -0.1,
              marginTop: 6,
              fontStyle: "italic",
              opacity: loading ? 0 : 1,
              transition: "opacity 0.15s",
            }}
          >
            {displayHome}
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// HandicapModule — wired: big index from real profile.handicap (editable).
// Trend badge / sparkline / low-high / differential removed (fabricated).
// A calm "Available after posting scores." note replaces the fake history chart.
// ──────────────────────────────────────────────────────────────────────

interface HandicapModuleProps {
  profile: GolferProfile | null;
  loading: boolean;
  editing: boolean;
  draft: IdentityDraft;
  setDraft: React.Dispatch<React.SetStateAction<IdentityDraft>>;
}

function HandicapModule({ profile, loading, editing, draft, setDraft }: HandicapModuleProps) {
  // Real index value; "—" while loading or when not set.
  const indexDisplay = loading
    ? "—"
    : profile?.handicap != null
    ? String(profile.handicap)
    : "—";

  return (
    <Section
      kicker="Index"
      title="Handicap"
      aside={
        // "+ Post score" button has no implementation yet — shown disabled.
        <button
          disabled
          style={{
            border: `1px solid ${T.hairline}`,
            borderRadius: 99,
            padding: "5px 10px",
            background: "transparent",
            cursor: "default",
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.pencilSoft,
            textTransform: "uppercase",
            fontWeight: 500,
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            opacity: 0.4,
          }}
        >
          + Post score
        </button>
      }
    >
      <div style={{ padding: "6px 0 4px" }}>
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
          Current index
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}>
          {/* Handicap index — real value, editable in edit mode */}
          {editing ? (
            <input
              type="text"
              inputMode="decimal"
              value={draft.handicap}
              onChange={(e) => setDraft((d) => ({ ...d, handicap: e.target.value }))}
              placeholder="—"
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 76,
                letterSpacing: -2.6,
                color: T.ink,
                lineHeight: 0.9,
                fontVariantNumeric: "tabular-nums",
                background: "transparent",
                border: "none",
                borderBottom: `1.5px solid ${T.ink}`,
                outline: "none",
                padding: "2px 0",
                width: 140,
                display: "block",
              }}
            />
          ) : (
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 76,
                letterSpacing: -2.6,
                color: T.ink,
                lineHeight: 0.9,
                fontVariantNumeric: "tabular-nums",
                opacity: loading ? 0 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {indexDisplay}
            </div>
          )}
        </div>

        {/* Status line: honest empty-state or neutral note */}
        {!editing && profile?.handicap == null && !loading && (
          <div style={{ fontFamily: T.serif, fontSize: 13, color: T.pencilSoft, fontStyle: "italic", marginTop: 6 }}>
            No handicap set — tap Edit to add one.
          </div>
        )}
        {!editing && profile?.handicap != null && (
          <div style={{ fontFamily: T.serif, fontSize: 13, color: T.pencil, fontStyle: "italic", marginTop: 6 }}>
            Post a score to track your trend.
          </div>
        )}
      </div>

      {/* Handicap history — calm placeholder (was fake sparkline + fake low/high/diff) */}
      <div
        style={{
          marginTop: 14,
          padding: "12px 14px",
          borderTop: `1px dashed ${T.hairline}`,
        }}
      >
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 8.5,
            letterSpacing: 1.3,
            color: T.pencilSoft,
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          Trend · Low · High · Differential
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontSize: 13,
            color: T.pencilSoft,
            fontStyle: "italic",
            marginTop: 6,
            letterSpacing: -0.1,
          }}
        >
          Available after posting scores.
        </div>
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// The bag — wired (P15): editable club distances from GolferProfile.clubDistances.
// Saves via PUT /api/profile/golfer with only the clubDistances field, so the
// identity editor (name/handicap/homeCourse) is never clobbered, and vice versa.
// The caddie (CaddiePanel) reads these same values to give yardage suggestions.
// ──────────────────────────────────────────────────────────────────────

function Bag({
  accent,
  profile,
  loading,
  onBagSaved,
}: {
  accent: string;
  profile: GolferProfile | null;
  loading: boolean;
  onBagSaved: (updated: GolferProfile) => void;
}) {
  const [bagEditing, setBagEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Stable reference: only changes when profile.clubDistances changes identity.
  const distances = useMemo(
    () => profile?.clubDistances ?? {},
    [profile?.clubDistances]
  );
  // Clubs that have a value set (for view mode display)
  const setClubs = useMemo(
    () => CLUB_CONFIG.filter((c) => distances[c.key] != null),
    [distances]
  );
  const hasAny = setClubs.length > 0;
  const maxDist = hasAny ? Math.max(...setClubs.map((c) => distances[c.key]!)) : 1;

  const startEditing = useCallback(() => {
    // Initialise draft from current distances (empty string = not set)
    const init: Record<string, string> = {};
    for (const { key } of CLUB_CONFIG) {
      const v = distances[key];
      init[key] = v != null ? String(v) : "";
    }
    setDraft(init);
    setSaveError(null);
    setBagEditing(true);
  }, [distances]);

  const handleCancel = useCallback(() => {
    setBagEditing(false);
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Parse draft → clubDistances; blank = omit (remove the club)
      const clubDistances: GolferProfile["clubDistances"] = {};
      for (const { key, label } of CLUB_CONFIG) {
        const raw = (draft[key] ?? "").trim();
        if (raw === "") continue; // leave key absent → backend won't store it
        const n = Math.round(parseFloat(raw));
        if (isNaN(n) || n <= 0 || n > 500) {
          setSaveError(`Invalid distance for ${label}`);
          setSaving(false);
          return;
        }
        clubDistances[key] = n;
      }
      // Bag-only save: sends ONLY clubDistances; identity fields untouched.
      await saveGolferBagAsync(clubDistances);
      // Update parent profile state so view refreshes immediately.
      onBagSaved({
        ...(profile ?? { id: "", name: null, handicap: null, homeCourse: null }),
        clubDistances,
      });
      setBagEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [draft, profile, onBagSaved]);

  return (
    <Section
      kicker="The bag"
      title="Club distances"
      aside={
        bagEditing ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {saveError && (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1,
                  color: T.errorInk,
                  textTransform: "uppercase",
                  maxWidth: 120,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {saveError}
              </span>
            )}
            <button
              onClick={handleCancel}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                fontWeight: 500,
                minHeight: 44,
                minWidth: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                border: `1px solid ${T.ink}`,
                borderRadius: 99,
                padding: "6px 14px",
                background: T.ink,
                cursor: saving ? "not-allowed" : "pointer",
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.3,
                color: T.paper,
                textTransform: "uppercase",
                fontWeight: 500,
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : (
          <button
            onClick={startEditing}
            disabled={loading}
            style={{
              border: `1px solid ${T.hairline}`,
              borderRadius: 99,
              padding: "5px 10px",
              background: "transparent",
              cursor: loading ? "default" : "pointer",
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.3,
              color: T.pencil,
              textTransform: "uppercase",
              fontWeight: 500,
              minHeight: 44,
              minWidth: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: loading ? 0.4 : 1,
            }}
          >
            Edit
          </button>
        )
      }
    >
      {bagEditing ? (
        /* Edit mode: all 15 clubs with distance inputs */
        <div style={{ display: "flex", flexDirection: "column" }}>
          {CLUB_CONFIG.map(({ key, label }, i) => (
            <div
              key={key}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                alignItems: "center",
                gap: 12,
                minHeight: 44,
                borderTop: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}`,
              }}
            >
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 14,
                  color: T.ink,
                  letterSpacing: -0.1,
                }}
              >
                {label}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="text"
                  inputMode="numeric"
                  value={draft[key] ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [key]: e.target.value }))
                  }
                  placeholder="—"
                  style={{
                    fontFamily: T.mono,
                    fontSize: 13,
                    letterSpacing: 0.5,
                    color: T.ink,
                    fontVariantNumeric: "tabular-nums",
                    background: "transparent",
                    border: "none",
                    borderBottom: `1.5px solid ${T.ink}`,
                    outline: "none",
                    padding: "2px 0",
                    width: 52,
                    textAlign: "right",
                  }}
                />
                <span
                  style={{
                    fontFamily: T.mono,
                    fontSize: 8,
                    color: T.pencilSoft,
                    letterSpacing: 1,
                    textTransform: "uppercase",
                  }}
                >
                  yd
                </span>
              </div>
            </div>
          ))}
          <div
            style={{
              marginTop: 10,
              padding: "8px 0 0",
              borderTop: `1px dashed ${T.hairline}`,
              fontFamily: T.serif,
              fontSize: 12,
              color: T.pencilSoft,
              fontStyle: "italic",
              letterSpacing: -0.1,
            }}
          >
            Leave a club blank to remove it from your bag.
            {" "}Putter distance isn&rsquo;t used for club recommendations.
          </div>
          {/* Bottom Save/Cancel — mirrors the header aside so golfers editing
              the lower clubs (SW/LW/Putter) don't need to scroll up to save. */}
          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${T.hairline}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 10,
            }}
          >
            {saveError && (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1,
                  color: T.errorInk,
                  textTransform: "uppercase",
                  maxWidth: 140,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                }}
              >
                {saveError}
              </span>
            )}
            <button
              onClick={handleCancel}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
                fontWeight: 500,
                minHeight: 44,
                minWidth: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                border: `1px solid ${T.ink}`,
                borderRadius: 99,
                padding: "6px 14px",
                background: T.ink,
                cursor: saving ? "not-allowed" : "pointer",
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.3,
                color: T.paper,
                textTransform: "uppercase",
                fontWeight: 500,
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : hasAny ? (
        /* View mode: clubs that have a value, with a proportional distance bar */
        <div style={{ display: "flex", flexDirection: "column" }}>
          {CLUB_CONFIG.map(({ key, label }, i) => {
            const val = distances[key];
            if (val == null) return null; // only show set clubs in view mode
            const widthPct = (val / maxDist) * 100;
            // Check if the next visible club is separated (skip divider logic per index)
            const isFirst = i === 0 || CLUB_CONFIG.slice(0, i).every((c) => distances[c.key] == null);
            return (
              <div
                key={key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "72px 1fr 52px",
                  gap: 10,
                  alignItems: "center",
                  padding: "7px 0",
                  borderTop: isFirst ? "none" : `1px dashed ${T.hairlineSoft}`,
                }}
              >
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 13,
                    color: T.ink,
                    letterSpacing: -0.1,
                  }}
                >
                  {label}
                </div>
                <div style={{ position: "relative", height: 10, background: T.paperDeep, borderRadius: 1 }}>
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${widthPct}%`,
                      // Use accent for the longest club's bar; ink for the rest —
                      // gives a visual anchor point without cluttering the list.
                      background: widthPct === 100 ? accent : T.ink,
                      borderRadius: 1,
                      opacity: widthPct === 100 ? 1 : 0.7,
                    }}
                  />
                </div>
                <div
                  style={{
                    textAlign: "right",
                    fontFamily: T.mono,
                    fontSize: 12,
                    color: widthPct === 100 ? accent : T.ink,
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: 0.5,
                    fontWeight: 500,
                  }}
                >
                  {val}
                  <span style={{ fontSize: 8, color: T.pencilSoft, marginLeft: 2, letterSpacing: 1 }}>yd</span>
                </div>
              </div>
            );
          })}
          <div
            style={{
              marginTop: 8,
              padding: "8px 0 0",
              borderTop: `1px dashed ${T.hairline}`,
              display: "flex",
              gap: 16,
              fontFamily: T.mono,
              fontSize: 8,
              letterSpacing: 1.1,
              color: T.pencilSoft,
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 6, background: T.ink, borderRadius: 1, display: "inline-block", opacity: 0.7 }} />
              {" "}Distance
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 6, background: accent, borderRadius: 1, display: "inline-block" }} />
              {" "}Longest
            </span>
          </div>
        </div>
      ) : (
        /* Empty state */
        <div
          style={{
            padding: "14px 0 6px",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
            letterSpacing: -0.1,
            lineHeight: 1.5,
          }}
        >
          No distances set — tap Edit to add your clubs.
        </div>
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Scoring by tee — wired (P16)
// Bucketed by (teeName × holeCount) so 9H and 18H rounds at the same tee
// form separate rows with meaningful per-bucket averages.
// Suppresses body while loading to avoid empty-state flash on mount.
// Owner's player resolved via getOwnerPlayerId() (prefers round.ownerPlayerId).
// ──────────────────────────────────────────────────────────────────────

function ScoringByTee({ accent, rounds, loading }: { accent: string; rounds: Round[]; loading: boolean }) {
  const teeRows = useMemo(() => deriveScoringByTee(rounds), [rounds]);
  const hasData = teeRows.length > 0;

  // Lifetime aside only when there is data — suppress during load and empty state.
  const aside = !loading && hasData ? (
    <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
      Lifetime
    </div>
  ) : undefined;

  const maxAvg = hasData ? Math.max(...teeRows.map((s) => s.avgTotal)) : 1;

  return (
    <Section kicker="Course" title="Scoring by tee" aside={aside}>
      {loading ? (
        // Suppress body during load — avoids empty-state flash (matches HandicapModule pattern).
        <div style={{ minHeight: 40 }} />
      ) : !hasData ? (
        <div
          style={{
            padding: "14px 0 6px",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
            letterSpacing: -0.1,
            lineHeight: 1.5,
          }}
        >
          Play a round to see your scoring by tee.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {teeRows.map((s) => {
              // Unique key: tee name + hole count (two rows can share a tee name).
              const rowKey = `${s.tee}|${s.holeCount}`;
              const width = (s.avgTotal / (maxAvg * 1.05)) * 100;
              const parWidth = s.avgTotal > 0 ? width * (s.par / s.avgTotal) : 0;
              return (
                <div key={rowKey}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 3 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1, fontStyle: "italic" }}>{s.tee}</span>
                      <span style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
                        {s.yards ? `${s.yards.toLocaleString()} yd · ` : ""}
                        {s.rounds} {s.rounds === 1 ? "round" : "rounds"} · {s.holeCount}H
                      </span>
                    </div>
                    {/* avgTotal is integer; avgOverPar is integer with "avg" label */}
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 0.5, color: T.ink, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                        {s.avgTotal}
                        <span style={{ color: accent, marginLeft: 4 }}>
                          {s.avgOverPar >= 0 ? `+${s.avgOverPar}` : `${s.avgOverPar}`}
                        </span>
                      </div>
                      <div style={{ fontFamily: T.mono, fontSize: 7.5, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", marginTop: 1 }}>
                        avg
                      </div>
                    </div>
                  </div>
                  <div style={{ position: "relative", height: 10, background: T.paperDeep, borderRadius: 1 }}>
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${parWidth}%`, background: T.ink, borderRadius: 1 }} />
                    <div
                      style={{
                        position: "absolute",
                        left: `${parWidth}%`,
                        top: 0,
                        bottom: 0,
                        width: `${width - parWidth}%`,
                        background: accent,
                        opacity: 0.8,
                        borderRadius: 1,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div
            style={{
              marginTop: 10,
              padding: "8px 0 0",
              borderTop: `1px dashed ${T.hairline}`,
              display: "flex",
              gap: 16,
              fontFamily: T.mono,
              fontSize: 8,
              letterSpacing: 1.1,
              color: T.pencilSoft,
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 6, background: T.ink }} /> At par
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 6, background: accent, opacity: 0.8 }} /> Over
            </span>
          </div>
        </>
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Season log — wired (P16)
// Shows the owner's real completed rounds: date, course, score vs par,
// holes played. Sorted most-recent first; capped at 8 with a disclosure.
// Suppresses body while loading to avoid empty-state flash on mount.
// Owner's player resolved via getOwnerPlayerId() (prefers round.ownerPlayerId).
// ──────────────────────────────────────────────────────────────────────

const SEASON_LOG_CAP = 8;

function YearLog({ accent: _accent, rounds, loading }: { accent: string; rounds: Round[]; loading: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const log = useMemo(() => deriveRoundLog(rounds), [rounds]);
  const displayed = showAll ? log : log.slice(0, SEASON_LOG_CAP);
  const hasMore = log.length > SEASON_LOG_CAP;

  // Round count aside only when there is data — suppress during load and empty state.
  const aside = !loading && log.length > 0 ? (
    <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
      {log.length} {log.length === 1 ? "round" : "rounds"}
    </div>
  ) : undefined;

  return (
    <Section kicker="Log" title="Season log" aside={aside}>
      {loading ? (
        // Suppress body during load — avoids empty-state flash (matches HandicapModule pattern).
        <div style={{ minHeight: 40 }} />
      ) : log.length === 0 ? (
        <div
          style={{
            padding: "14px 0 6px",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
            letterSpacing: -0.1,
            lineHeight: 1.5,
          }}
        >
          Post a round to track your season.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {displayed.map((entry, i) => {
              const month = entry.date.toLocaleString("en-US", { month: "short" });
              const day = entry.date.getDate();
              const toParStr =
                entry.toPar === null
                  ? null
                  : entry.toPar === 0
                  ? "E"
                  : entry.toPar > 0
                  ? `+${entry.toPar}`
                  : `${entry.toPar}`;
              // Sub-kicker combines tee name (if set) + holes played, mirrors home list.
              const subLine = [
                entry.teeName,
                entry.holesPlayed > 0 ? `${entry.holesPlayed}H` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <div
                  key={entry.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "44px 1fr auto",
                    gap: 10,
                    alignItems: "center",
                    padding: "9px 0",
                    borderTop: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}`,
                  }}
                >
                  {/* Date column */}
                  <div>
                    <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase" }}>
                      {month}
                    </div>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontSize: 20,
                        color: T.ink,
                        lineHeight: 1,
                        letterSpacing: -0.4,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {day}
                    </div>
                  </div>

                  {/* Course column */}
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontSize: 14,
                        color: T.ink,
                        letterSpacing: -0.1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {entry.course}
                    </div>
                    {subLine && (
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 7.5,
                          color: T.pencilSoft,
                          letterSpacing: 1,
                          textTransform: "uppercase",
                          marginTop: 1,
                        }}
                      >
                        {subLine}
                      </div>
                    )}
                  </div>

                  {/* Score column */}
                  <div style={{ textAlign: "right" }}>
                    {entry.score !== null ? (
                      <>
                        <div
                          style={{
                            fontFamily: T.serif,
                            fontSize: 22,
                            color: T.ink,
                            lineHeight: 1,
                            letterSpacing: -0.5,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {entry.score}
                        </div>
                        {toParStr && (
                          <div
                            style={{
                              fontFamily: T.mono,
                              fontSize: 8.5,
                              letterSpacing: 1.1,
                              color: T.pencilSoft,
                              marginTop: 1,
                            }}
                          >
                            {toParStr}
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={{ fontFamily: T.mono, fontSize: 9, color: T.pencilSoft, letterSpacing: 1 }}>
                        —
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* "Show all" disclosure — appears when log exceeds cap */}
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              style={{
                marginTop: 10,
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                borderTop: `1px dashed ${T.hairline}`,
                cursor: "pointer",
                fontFamily: T.mono,
                fontSize: 8.5,
                letterSpacing: 1.3,
                color: T.pencil,
                textTransform: "uppercase",
                fontWeight: 500,
                minHeight: 44,
                display: "flex",
                alignItems: "center",
              }}
            >
              Show all {log.length} rounds
            </button>
          )}
        </>
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Par breakdown — scores by par type (par-3 / par-4 / par-5 averages).
// Grouped after ScoringByTee so the two "how you score by category" views
// sit together. Only rows with data are rendered.
// ──────────────────────────────────────────────────────────────────────

function ParBreakdown({ rounds, loading }: { rounds: Round[]; loading: boolean }) {
  const rows: ParTypeRow[] = useMemo(() => deriveParTypeAverages(rounds), [rounds]);
  const hasData = rows.length > 0;

  return (
    <Section kicker="Breakdown" title="By par type">
      {loading ? (
        <div style={{ minHeight: 40 }} />
      ) : !hasData ? (
        <div
          style={{
            padding: "14px 0 6px",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
            letterSpacing: -0.1,
            lineHeight: 1.5,
          }}
        >
          Play a round to see your par breakdown.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((row, i) => {
            const toParStr =
              row.avgToPar === 0
                ? "E"
                : row.avgToPar > 0
                ? `+${row.avgToPar}`
                : `${row.avgToPar}`;
            const toParColor =
              row.avgToPar < 0 ? T.birdie : row.avgToPar === 0 ? T.pencilSoft : T.pencil;
            return (
              <div
                key={row.par}
                style={{
                  display: "grid",
                  gridTemplateColumns: "52px 1fr auto",
                  gap: 10,
                  alignItems: "center",
                  minHeight: 44,
                  borderTop: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}`,
                }}
              >
                {/* Par label */}
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.3,
                    color: T.pencil,
                    textTransform: "uppercase",
                    fontWeight: 500,
                  }}
                >
                  Par {row.par}
                </div>

                {/* Hole count */}
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 8,
                    letterSpacing: 1,
                    color: T.pencilSoft,
                    textTransform: "uppercase",
                  }}
                >
                  {row.holeCount} {row.holeCount === 1 ? "hole" : "holes"}
                </div>

                {/* Avg score + avg-to-par (right-aligned) */}
                <div style={{ textAlign: "right" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "flex-end",
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: T.mono,
                        fontSize: 13,
                        color: T.ink,
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: 0.3,
                      }}
                    >
                      {row.avgScore}
                    </span>
                    <span
                      style={{
                        fontFamily: T.mono,
                        fontSize: 10,
                        color: toParColor,
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: 0.3,
                        fontWeight: 500,
                      }}
                    >
                      {toParStr}
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 7.5,
                      letterSpacing: 1,
                      color: T.pencilSoft,
                      textTransform: "uppercase",
                      marginTop: 1,
                    }}
                  >
                    avg
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Score distribution — hole-by-hole result counts (eagle+/birdie/par/bogey/double+)
// with a quiet recent-trend indicator at the bottom.
// Grouped with ParBreakdown (both are hole-level aggregates) so the two views
// sit together above the round-level YearLog.
// ──────────────────────────────────────────────────────────────────────

function ScoreDistribution({ rounds, loading }: { rounds: Round[]; loading: boolean }) {
  const distRows: ScoreDistRow[] = useMemo(() => deriveScoreDistribution(rounds), [rounds]);
  const trend: TrendResult | null = useMemo(() => deriveTrend(rounds), [rounds]);
  const hasData = distRows.length > 0;
  const maxCount = hasData ? Math.max(...distRows.map((r) => r.count)) : 1;

  return (
    <Section kicker="Scoring" title="Score distribution">
      {loading ? (
        <div style={{ minHeight: 40 }} />
      ) : !hasData ? (
        <div
          style={{
            padding: "14px 0 6px",
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 14,
            color: T.pencilSoft,
            letterSpacing: -0.1,
            lineHeight: 1.5,
          }}
        >
          Play a round to see your score distribution.
        </div>
      ) : (
        <>
          {/* Distribution rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {distRows.map((row) => {
              const barPct = (row.count / maxCount) * 100;
              // Eagle = eagle colour; birdie = flag colour; par = ink;
              // bogey = pencil (slightly warmer than pencilSoft); double+ = pencilSoft (quietest)
              const barColor =
                row.bucket === "eagle_or_better"
                  ? T.eagle
                  : row.bucket === "birdie"
                  ? T.birdie
                  : row.bucket === "par"
                  ? T.ink
                  : row.bucket === "bogey"
                  ? T.pencil
                  : T.pencilSoft;

              return (
                <div
                  key={row.bucket}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "100px 1fr 36px",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  {/* Label */}
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 12,
                      color: T.ink,
                      letterSpacing: -0.1,
                      fontStyle: "italic",
                    }}
                  >
                    {row.label}
                  </div>

                  {/* Bar track */}
                  <div
                    style={{
                      position: "relative",
                      height: 8,
                      background: T.paperDeep,
                      borderRadius: 1,
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${barPct}%`,
                        background: barColor,
                        borderRadius: 1,
                        opacity: 0.75,
                      }}
                    />
                  </div>

                  {/* Count on top + percentage sub-label beneath — stacked in the same cell,
                      mirroring the ScoringByTee avgTotal/avg stacking pattern */}
                  <div style={{ textAlign: "right" }}>
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 11,
                        color: T.ink,
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 600,
                        letterSpacing: 0.3,
                      }}
                    >
                      {row.count}
                    </div>
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 7.5,
                        color: T.pencilSoft,
                        letterSpacing: 0.8,
                        marginTop: 1,
                      }}
                    >
                      {row.pct}%
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Trend — quiet footer, only shown when there is enough data */}
          {trend && (
            <div
              style={{
                marginTop: 14,
                paddingTop: 10,
                borderTop: `1px dashed ${T.hairline}`,
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 8.5,
                  letterSpacing: 1.3,
                  color: T.pencilSoft,
                  textTransform: "uppercase",
                  fontWeight: 500,
                }}
              >
                Recent form
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 13,
                  color: T.pencil,
                  letterSpacing: -0.1,
                  lineHeight: 1.4,
                }}
              >
                {/* Quiet one-line summary of the trend */}
                Last {trend.recentCount} {trend.recentCount === 1 ? "round" : "rounds"}{" "}
                avg{" "}
                {trend.recentAvgToPar === 0
                  ? "even"
                  : trend.recentAvgToPar > 0
                  ? `+${trend.recentAvgToPar}`
                  : `${trend.recentAvgToPar}`}{" "}
                vs prior avg{" "}
                {trend.priorAvgToPar === 0
                  ? "even"
                  : trend.priorAvgToPar > 0
                  ? `+${trend.priorAvgToPar}`
                  : `${trend.priorAvgToPar}`}
                {trend.delta !== 0 && (
                  <span style={{ marginLeft: 4, color: trend.delta < 0 ? T.birdie : T.pencilSoft }}>
                    ({trend.delta > 0 ? `+${trend.delta}` : `${trend.delta}`})
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Shot analytics — single calm placeholder (P16, replaces two stacked ones)
// Covers strokes gained + fairway tendency + any future per-shot analytics.
// Per-shot data doesn't exist until shot tracking ships (P28). Placed at the
// bottom so real data sections lead.
// ──────────────────────────────────────────────────────────────────────

function ShotAnalytics() {
  return (
    <Section kicker="Shot analytics" title="Strokes gained · Fairway">
      <div
        style={{
          padding: "14px 0 6px",
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 14,
          color: T.pencilSoft,
          letterSpacing: -0.1,
          lineHeight: 1.5,
        }}
      >
        Available when shot tracking ships.
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Footer
// ──────────────────────────────────────────────────────────────────────

function Footer() {
  const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <div style={{ padding: "24px 22px 36px", textAlign: "center", borderTop: `1px solid ${T.hairline}` }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontFamily: T.mono,
          fontSize: 8.5,
          letterSpacing: 1.6,
          color: T.pencil,
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        <div style={{ width: 18, height: 1, background: T.hairline }} />
        <svg width="8" height="10" viewBox="0 0 8 10">
          <line x1="1.5" y1="1" x2="1.5" y2="9" stroke={T.ink} strokeWidth="0.8" />
          <path d="M1.5,2 L7,3.5 L1.5,5 Z" fill={T.flag} />
        </svg>
        <span>Looper · {dateStr}</span>
        <div style={{ width: 18, height: 1, background: T.hairline }} />
      </div>
    </div>
  );
}
