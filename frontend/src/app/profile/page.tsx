"use client";

import React, { ReactNode, useMemo, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import { getGolferProfileAsync, saveGolferProfileAsync } from "@/lib/storage-api";
import type { GolferProfile } from "@/lib/types";

// ──────────────────────────────────────────────────────────────────────
// Preview-only mock data — NOT the owner's data.
// Sections that use these are labelled "(Preview)" and will be replaced
// when the corresponding wiring item ships:
//   wire-profile-bag  (P15) → Bag / club distances
//   wire-profile-stats (P16) → StrokesGained / FairwayFan / ScoringByTee / YearLog
// PP_PLAYER / PP_HANDICAP / PP_RECENT removed — those had fabricated owner facts.
// ──────────────────────────────────────────────────────────────────────

const PP_SCORING = [
  { tee: "Championship", yards: 7040, avg: 88.4, par: 72, rounds: 4 },
  { tee: "Back", yards: 6620, avg: 84.1, par: 72, rounds: 18 },
  { tee: "Regular", yards: 6180, avg: 81.0, par: 72, rounds: 31 },
  { tee: "Forward", yards: 5640, avg: 77.2, par: 72, rounds: 3 },
];

const PP_SG = [
  { cat: "Off the tee", you: +0.4, label: "Driver length helps; fairway % hurts" },
  { cat: "Approach", you: -0.8, label: "Losing shots inside 150" },
  { cat: "Around green", you: +0.2, label: "Up-and-down rate: 42%" },
  { cat: "Putting", you: -0.3, label: "3-putt rate: 11% · one per round" },
];

const PP_FWY = { left: 18, middle: 62, right: 20 };

type BagClub = { club: string; carry: number; total: number; last: number; disp: number; hits: number };

const PP_BAG: BagClub[] = [
  { club: "Driver", carry: 252, total: 271, last: 274, disp: 24, hits: 312 },
  { club: "3-wood", carry: 228, total: 245, last: 239, disp: 22, hits: 84 },
  { club: "3-hybrid", carry: 210, total: 224, last: 218, disp: 20, hits: 141 },
  { club: "4-iron", carry: 196, total: 206, last: 202, disp: 18, hits: 92 },
  { club: "5-iron", carry: 184, total: 192, last: 188, disp: 17, hits: 168 },
  { club: "6-iron", carry: 172, total: 179, last: 176, disp: 15, hits: 204 },
  { club: "7-iron", carry: 161, total: 167, last: 164, disp: 14, hits: 256 },
  { club: "8-iron", carry: 148, total: 153, last: 149, disp: 12, hits: 221 },
  { club: "9-iron", carry: 135, total: 139, last: 136, disp: 11, hits: 198 },
  { club: "PW", carry: 121, total: 124, last: 119, disp: 10, hits: 176 },
  { club: "GW (52°)", carry: 102, total: 104, last: 101, disp: 9, hits: 124 },
  { club: "SW (56°)", carry: 84, total: 86, last: 82, disp: 8, hits: 112 },
  { club: "LW (60°)", carry: 64, total: 66, last: 63, disp: 6, hits: 88 },
];

function buildYear(seed = 7) {
  const weeks = 52;
  const cells: Array<{ w: number; d: number; v: 0 | 1 | 2 | 3 }> = [];
  let r = seed;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      r = (r * 9301 + 49297) % 233280;
      const rand = r / 233280;
      const weekendBoost = d === 0 || d === 6 ? 2.2 : 1;
      const monthIdx = Math.floor(w / 4.33);
      const summerBoost = monthIdx >= 4 && monthIdx <= 9 ? 1.3 : 0.7;
      const p = rand * weekendBoost * summerBoost;
      let v: 0 | 1 | 2 | 3 = 0;
      if (p > 1.8) v = 3;
      else if (p > 1.2) v = 2;
      else if (p > 0.9) v = 1;
      cells.push({ w, d, v });
    }
  }
  return cells;
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getGolferProfileAsync()
      .then(setProfile)
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
        <StrokesGained accent={accent} />
        <FairwayFan accent={accent} />
        <Bag accent={accent} />
        <ScoringByTee accent={accent} />
        <YearLog accent={accent} />
        <Recent />
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
// A calm "Coming soon" note replaces the fake history chart until P16.
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

      {/* Handicap history — coming soon (was fake sparkline + fake low/high/diff) */}
      <div
        style={{
          marginTop: 14,
          padding: "12px 14px",
          borderTop: `1px dashed ${T.hairline}`,
          borderRadius: 4,
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
// Strokes gained — preview (P16)
// ──────────────────────────────────────────────────────────────────────

function StrokesGained({ accent }: { accent: string }) {
  const max = Math.max(...PP_SG.map((s) => Math.abs(s.you))) + 0.2;
  return (
    <Section
      kicker="Shot quality"
      title="Strokes gained"
      preview
      aside={
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
          vs 10-hdcp
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {PP_SG.map((s, i) => {
          const pct = s.you / max;
          const pos = pct >= 0;
          const width = Math.abs(pct) * 50;
          return (
            <div key={s.cat}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 3 }}>
                <div style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1, fontStyle: "italic" }}>{s.cat}</div>
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 11,
                    letterSpacing: 0.5,
                    color: pos ? accent : T.pencil,
                    fontVariantNumeric: "tabular-nums",
                    fontWeight: 600,
                  }}
                >
                  {pos ? "+" : ""}
                  {s.you.toFixed(1)}
                </div>
              </div>
              <div style={{ position: "relative", height: 14, background: T.paperDeep, borderRadius: 2 }}>
                <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: T.ink, opacity: 0.3 }} />
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${width}%` }}
                  transition={{ delay: 0.1 + i * 0.08, duration: 0.6, ease: T.ease }}
                  style={{
                    position: "absolute",
                    top: 2,
                    bottom: 2,
                    left: pos ? "50%" : undefined,
                    right: pos ? undefined : "50%",
                    background: pos ? accent : T.pencil,
                    borderRadius: 1,
                  }}
                />
              </div>
              <div style={{ fontFamily: T.serif, fontSize: 11.5, color: T.pencilSoft, marginTop: 3, fontStyle: "italic", letterSpacing: -0.05 }}>{s.label}</div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Fairway fan — preview (P16)
// ──────────────────────────────────────────────────────────────────────

function FairwayFan({ accent }: { accent: string }) {
  const { left, middle, right } = PP_FWY;
  return (
    <Section
      kicker="Tendencies"
      title="Off the tee"
      preview
      aside={
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
          Last 30 rounds
        </div>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 14, alignItems: "center" }}>
        <div style={{ position: "relative" }}>
          <svg width="160" height="120" viewBox="0 0 160 120">
            <circle cx="80" cy="110" r="2.5" fill={T.ink} />
            <text x="80" y="118" textAnchor="middle" fontFamily={T.mono} fontSize="7" fill={T.pencilSoft} letterSpacing="1">TEE</text>

            <path d="M80,110 L10,40 A85,85 0 0,1 55,18 Z" fill={`${T.pencil}25`} stroke={T.hairline} strokeWidth="0.6" />
            <path d="M80,110 L55,18 A85,85 0 0,1 105,18 Z" fill={`${accent}20`} stroke={accent} strokeWidth="0.6" />
            <path d="M80,110 L105,18 A85,85 0 0,1 150,40 Z" fill={`${T.pencil}25`} stroke={T.hairline} strokeWidth="0.6" />

            <text x="30" y="58" textAnchor="middle" fontFamily={T.serif} fontStyle="italic" fontSize="14" fill={T.ink} letterSpacing="-0.2">{left}%</text>
            <text x="30" y="68" textAnchor="middle" fontFamily={T.mono} fontSize="6.5" fill={T.pencil} letterSpacing="1">LEFT</text>
            <text x="80" y="50" textAnchor="middle" fontFamily={T.serif} fontStyle="italic" fontSize="20" fill={T.ink} letterSpacing="-0.4">{middle}%</text>
            <text x="80" y="62" textAnchor="middle" fontFamily={T.mono} fontSize="6.5" fill={accent} letterSpacing="1" fontWeight="600">FAIRWAY</text>
            <text x="130" y="58" textAnchor="middle" fontFamily={T.serif} fontStyle="italic" fontSize="14" fill={T.ink} letterSpacing="-0.2">{right}%</text>
            <text x="130" y="68" textAnchor="middle" fontFamily={T.mono} fontSize="6.5" fill={T.pencil} letterSpacing="1">RIGHT</text>

            {Array.from({ length: 18 }).map((_, i) => {
              const seed = (i * 7919) % 100;
              const angle = -Math.PI / 2 + ((seed - 50) / 50) * 0.55;
              const dist = 50 + (seed % 40);
              const x = 80 + Math.cos(angle) * dist;
              const y = 110 + Math.sin(angle) * dist;
              return <circle key={i} cx={x} cy={y} r="1.6" fill={T.ink} opacity="0.45" />;
            })}
          </svg>
        </div>

        <div>
          <div style={{ fontFamily: T.serif, fontSize: 13, color: T.ink, fontStyle: "italic", letterSpacing: -0.1, lineHeight: 1.35 }}>
            You miss{" "}
            <span style={{ color: accent, fontWeight: 500, fontStyle: "normal", fontFamily: T.sans }}>slightly right</span>, and rarely left of center.
          </div>
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>Drive dist</div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 20,
                  color: T.ink,
                  letterSpacing: -0.4,
                  lineHeight: 1,
                  marginTop: 2,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                268<span style={{ fontSize: 11, color: T.pencil, marginLeft: 2 }}>yd</span>
              </div>
            </div>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>Dispersion</div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 20,
                  color: T.ink,
                  letterSpacing: -0.4,
                  lineHeight: 1,
                  marginTop: 2,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                ±28<span style={{ fontSize: 11, color: T.pencil, marginLeft: 2 }}>yd</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// The bag — preview (P15); Edit toggle removed (no persistence yet)
// ──────────────────────────────────────────────────────────────────────

function Bag({ accent }: { accent: string }) {
  const [sel, setSel] = useState("7-iron");
  const selected = PP_BAG.find((c) => c.club === sel);
  const maxTotal = Math.max(...PP_BAG.map((c) => c.total));

  return (
    <Section
      kicker="The bag"
      title="Club distances"
      preview
      aside={
        // Edit toggle removed — bag has no persistence until wire-profile-bag (P15).
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.pencilSoft,
            textTransform: "uppercase",
            fontWeight: 500,
            opacity: 0.5,
            padding: "5px 10px",
          }}
        >
          Coming soon
        </div>
      }
    >
      {selected && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            padding: "12px 14px",
            borderRadius: 10,
            border: `1px solid ${T.hairline}`,
            background: T.paperDeep,
            marginBottom: 10,
          }}
        >
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>Selected</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 24, color: T.ink, letterSpacing: -0.5, lineHeight: 1, marginTop: 2 }}>
              {selected.club}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", marginTop: 4 }}>
              {selected.hits} shots tracked
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", justifyContent: "flex-end" }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>Carry</div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.3, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
                {selected.carry}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: accent, textTransform: "uppercase", fontWeight: 600 }}>Total</div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 22,
                  color: accent,
                  letterSpacing: -0.3,
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {selected.total}
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column" }}>
        {PP_BAG.map((c, i) => {
          const active = c.club === sel;
          const widthCarry = (c.carry / maxTotal) * 100;
          const widthTotal = (c.total / maxTotal) * 100;
          const lastPct = (c.last / maxTotal) * 100;
          const dispWidth = (c.disp / maxTotal) * 100;
          const dispLeft = widthCarry - dispWidth / 2;
          return (
            <button
              key={c.club}
              onClick={() => setSel(c.club)}
              style={{
                display: "grid",
                gridTemplateColumns: "64px 1fr 54px",
                gap: 10,
                alignItems: "center",
                padding: "8px 0",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                borderTop: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}`,
                textAlign: "left",
              }}
            >
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: active ? "italic" : "normal",
                  fontSize: 14,
                  color: active ? accent : T.ink,
                  letterSpacing: -0.1,
                  fontWeight: active ? 500 : 400,
                }}
              >
                {c.club}
              </div>
              <div style={{ position: "relative", height: 10, background: T.paperDeep, borderRadius: 1 }}>
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${widthTotal}%`,
                    background: active ? `${accent}30` : `${T.pencil}30`,
                    borderRadius: 1,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${widthCarry}%`,
                    background: active ? accent : T.ink,
                    borderRadius: 1,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: `calc(${lastPct}% - 1px)`,
                    top: -2,
                    bottom: -2,
                    width: 2,
                    background: T.paper,
                    border: `0.5px solid ${T.ink}`,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: `${dispLeft}%`,
                    width: `${dispWidth}%`,
                    top: -3,
                    height: 2,
                    border: `1px solid ${T.ink}`,
                    borderBottom: "none",
                    borderRadius: "1px 1px 0 0",
                    opacity: 0.35,
                  }}
                />
              </div>
              <div
                style={{
                  textAlign: "right",
                  fontFamily: T.mono,
                  fontSize: 12,
                  color: active ? accent : T.ink,
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: 0.5,
                  fontWeight: active ? 600 : 500,
                }}
              >
                {c.total}
                <span style={{ fontSize: 8, color: T.pencilSoft, marginLeft: 2, letterSpacing: 1 }}>yd</span>
              </div>
            </button>
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
          <span style={{ width: 10, height: 6, background: T.ink, borderRadius: 1 }} /> Carry
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 6, background: `${T.pencil}30`, borderRadius: 1 }} /> Roll
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 2, height: 8, background: T.ink }} /> Last hit
        </span>
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Scoring by tee — preview (P16)
// ──────────────────────────────────────────────────────────────────────

function ScoringByTee({ accent }: { accent: string }) {
  const maxAvg = Math.max(...PP_SCORING.map((s) => s.avg));
  return (
    <Section
      kicker="Course"
      title="Scoring by tee"
      preview
      aside={
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
          Lifetime
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {PP_SCORING.map((s) => {
          const over = s.avg - s.par;
          const width = (s.avg / (maxAvg * 1.05)) * 100;
          const parWidth = width * (s.par / s.avg);
          return (
            <div key={s.tee}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 3 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1, fontStyle: "italic" }}>{s.tee}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
                    {s.yards.toLocaleString()} yd · {s.rounds} rounds
                  </span>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: 0.5, color: T.ink, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                  {s.avg.toFixed(1)}
                  <span style={{ color: accent, marginLeft: 4 }}>+{over.toFixed(1)}</span>
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
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Year heatmap — preview (P16)
// ──────────────────────────────────────────────────────────────────────

function YearLog({ accent }: { accent: string }) {
  const cells = useMemo(() => buildYear(7), []);
  const rounds = cells.filter((c) => c.v > 0).length;
  const nines = cells.filter((c) => c.v === 1).length;
  const r18 = cells.filter((c) => c.v === 2).length;
  const tourn = cells.filter((c) => c.v === 3).length;

  const cellSize = 7;
  const gap = 2;
  const w = 52 * (cellSize + gap);
  const h = 7 * (cellSize + gap);

  const color = (v: 0 | 1 | 2 | 3) => {
    if (v === 0) return T.paperDeep;
    if (v === 1) return `${T.pencil}80`;
    if (v === 2) return T.ink;
    if (v === 3) return accent;
    return T.paperDeep;
  };

  return (
    <Section
      kicker="Log"
      title="This season"
      preview
      aside={
        <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>
          52 weeks
        </div>
      }
    >
      <div
        style={{
          padding: "12px 12px",
          borderRadius: 8,
          background: T.paperDeep,
          border: `1px solid ${T.hairlineSoft}`,
          overflowX: "auto",
        }}
      >
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          {cells.map((c, i) => (
            <rect
              key={i}
              x={c.w * (cellSize + gap)}
              y={c.d * (cellSize + gap)}
              width={cellSize}
              height={cellSize}
              rx="1"
              fill={color(c.v)}
              opacity={c.v === 0 ? 0.5 : 1}
            />
          ))}
        </svg>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 6,
            fontFamily: T.mono,
            fontSize: 7.5,
            letterSpacing: 1,
            color: T.pencilSoft,
            textTransform: "uppercase",
          }}
        >
          {["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", paddingTop: 8, borderTop: `1px dashed ${T.hairline}` }}>
        {[
          { l: "Rounds", v: rounds, accent: false },
          { l: "9 holes", v: nines, accent: false },
          { l: "18 holes", v: r18, accent: false },
          { l: "Tourneys", v: tourn, accent: true },
        ].map((b, i) => (
          <div key={b.l} style={{ borderLeft: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}`, paddingLeft: i === 0 ? 0 : 10 }}>
            <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: T.pencilSoft, textTransform: "uppercase", fontWeight: 500 }}>{b.l}</div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 20,
                color: b.accent ? accent : T.ink,
                letterSpacing: -0.4,
                lineHeight: 1.1,
                marginTop: 2,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {b.v}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Recent rounds — empty state (PP_RECENT was fabricated; real wiring is P16)
// ──────────────────────────────────────────────────────────────────────

function Recent() {
  return (
    <Section
      kicker="Ledger"
      title="Recent rounds"
    >
      <div
        style={{
          padding: "18px 0 6px",
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 14,
          color: T.pencilSoft,
          letterSpacing: -0.1,
          lineHeight: 1.5,
        }}
      >
        No rounds yet — start a round to see your history.
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
