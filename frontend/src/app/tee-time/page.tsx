"use client";

import { useEffect, useState, useRef, useCallback, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT } from "@/components/yardage/tokens";
import { searchTeeTimes, bookTeeTime } from "@/lib/teetime/client";
import { confirmCopy, callTelHref } from "@/lib/teetime/confirm-copy";
import type { TeeTimeSlot, TeeTimeQuery, BookingResult } from "@/lib/teetime/types";
import {
  reconcileCourseOptions,
  createCourseFetchSession,
  addCourseOption,
  courseOptionFromSelection,
  radiusMetersForMiles,
  loadStateAfterLocate,
  loadStateAfterFetch,
  emptyCoursesNote,
  type CourseOption,
  type CourseLoadState,
} from "@/lib/teetime/courses";
import { buildTeeTimeQueries } from "@/lib/teetime/query";
import { readLastKnownArea, acquireArea } from "@/lib/teetime/location";
import { defaultWindows, nextDefaultWindow, weekdayFromLabel, weekdayName } from "@/lib/teetime/dates";
import CourseSearch, { type CourseSelectPayload } from "@/components/CourseSearch";
import { isFavorite } from "@/lib/course-favorites";
import { getPlayers, getGolferProfileAsync } from "@/lib/api";
import { getSavedPlayers } from "@/lib/storage";
import type { SavedPlayer } from "@/lib/types";
import { buildTeeTimeICS, icsFilename, downloadICS } from "@/lib/teetime/ics";
import { parseTeeTimePrefs, hasTeeTimeSignal } from "@/lib/voice/parseTeeTimePrefs";
import type { TeeTimePrefsParseResultValidated } from "@/lib/voice/schemas";
import {
  applyParsedWindows,
  applyParsedCourses,
  applyPartySize,
  teeTimeAckLine,
} from "@/lib/teetime/voice-prefs";
import WindowCard from "./WindowCard";
import { LooperSheetShell } from "@/components/LooperSheet";
import { useLooperDictation } from "@/hooks/useLooperDictation";
import { onLooperOpen } from "@/lib/looper-bus";
import { buildKeyterms } from "@/lib/voice/keyterms";

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = "prefs" | "searching" | "confirmed";

interface TimeWindow {
  id: string;
  label: string;
  sub: string;
  start: string;
  end: string;
  /** Real ISO date (YYYY-MM-DD) — the source of truth for WHEN this window
   *  searches. `label`/`sub` are display-only. */
  date: string;
  selected: boolean;
}

interface GroupMember {
  id: string;
  name: string;
  /** Handicap — null when unknown (never a made-up number). */
  hdcp: number | null;
  init: string;
  confirmed: boolean;
  self: boolean;
}

// ─── Static defaults ──────────────────────────────────────────────────────────

const DEFAULT_MAX_MILES = 15;

/**
 * The golfer's own chip. Handicap and initials fill in from the real golfer
 * profile once it loads — until then they're honestly unknown, never fake.
 */
const SELF_MEMBER: GroupMember = { id: "me", name: "You", hdcp: null, init: "ME", confirmed: true, self: true };

/** "Jack Harrington" → "JH" — avatar initials from a real name. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.map((p) => p[0]).join("").slice(0, 2) || "?").toUpperCase();
}

/** A saved playing partner (GET /api/players) → an invitable group member. */
function savedPlayerToMember(p: SavedPlayer): GroupMember {
  const name = p.nickname || p.name;
  return {
    id: p.id,
    name,
    hdcp: p.handicap ?? null,
    init: initialsOf(name),
    confirmed: false,
    self: false,
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TeeTimePage() {
  const router = useRouter();
  const accent = DEFAULT_ACCENT;
  const [phase, setPhase] = useState<Phase>("prefs");

  // Prefs state — lifted so confirmed can read them.
  const [windows, setWindows] = useState<TimeWindow[]>(() => defaultWindows());
  // Courses start EMPTY — never a fake list. Real nearby courses + real
  // favorites load in; until then the page says what's happening honestly.
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [courseLoad, setCourseLoad] = useState<CourseLoadState>("locating");
  const [maxMiles, setMaxMiles] = useState(DEFAULT_MAX_MILES);
  // Latest maxMiles, readable from the long-lived fetch session's callback
  // (which must never close over a stale render's value).
  const maxMilesRef = useRef(maxMiles);
  useEffect(() => { maxMilesRef.current = maxMiles; }, [maxMiles]);
  // Once the golfer touches the course list (toggles or hand-adds a course),
  // the first-load auto-pre-selection (nearest-3 / favorites) never re-applies.
  const coursesTouchedRef = useRef(false);
  const [group, setGroup] = useState<GroupMember[]>([SELF_MEMBER]);
  // Price ceiling — only voice sets this today ("under eighty dollars").
  const [maxPriceUsd, setMaxPriceUsd] = useState<number | null>(null);

  // The golfer's real profile fills in the self chip (handicap, initials) and
  // names the booking. No profile → the chip stays honestly blank.
  const [profileName, setProfileName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getGolferProfileAsync()
      .then((profile) => {
        if (cancelled || !profile) return;
        setProfileName(profile.name);
        setGroup((g) => g.map((m) => m.self
          ? { ...m, hdcp: profile.handicap, init: profile.name ? initialsOf(profile.name) : m.init }
          : m));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Invitable roster = the golfer's real saved playing partners
  // (GET /api/players, local-storage fallback like round setup).
  const [roster, setRoster] = useState<GroupMember[]>([]);
  useEffect(() => {
    let cancelled = false;
    getPlayers()
      .then((ps) => { if (!cancelled) setRoster(ps.map(savedPlayerToMember)); })
      .catch(() => { if (!cancelled) setRoster(getSavedPlayers().map(savedPlayerToMember)); });
    return () => { cancelled = true; };
  }, []);

  // Golfer location ("lat,lng") — last-known immediately, fresh fix when granted.
  // Search never blocks on this: it fires with whatever is available.
  const [area, setArea] = useState<string | null>(() => readLastKnownArea());

  // Locate the golfer (non-blocking). The nearby fetch below fires as soon as
  // ANY area is known (last-known first, fresh fix when it lands). No fix and
  // no last-known → honest "unlocated" state, never fake data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fresh = await acquireArea();
      if (cancelled) return;
      if (fresh) setArea(fresh);
      else setCourseLoad((l) => (l === "locating" ? loadStateAfterLocate(readLastKnownArea()) : l));
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch radius follows the "Max drive" slider, debounced so dragging doesn't
  // spam the backend.
  const [radiusM, setRadiusM] = useState(() => radiusMetersForMiles(DEFAULT_MAX_MILES));
  useEffect(() => {
    const t = setTimeout(() => setRadiusM(radiusMetersForMiles(maxMiles)), 500);
    return () => clearTimeout(t);
  }, [maxMiles]);

  // Fetch nearby courses whenever the area changes or the radius grows past
  // what we've already covered. The session is abort-hardened (mirrors
  // course-search-session's pattern): if two fetches are ever in flight back
  // to back, a stale (older) one's result can never land over a newer one's.
  // Fresh results reconcile into the list — new courses append (golfer's
  // toggles and hand-added courses are never clobbered), and rows beyond the
  // CURRENT drive radius that the golfer never selected/favorited are pruned.
  const lastFetched = useRef<{ area: string; radius: number } | null>(null);
  // Built once, in an effect (never during render) — its callback reads the
  // refs above fresh on every call, however late it lands.
  const fetchSession = useRef<ReturnType<typeof createCourseFetchSession> | null>(null);
  useEffect(() => {
    const session = createCourseFetchSession({
      onResult: (result, target) => {
        lastFetched.current = target;
        setCourses((prev) => reconcileCourseOptions(prev, result.options, {
          maxMiles: maxMilesRef.current,
          touched: coursesTouchedRef.current,
        }));
        setCourseLoad(loadStateAfterFetch(result.failed, result.options.length));
      },
    });
    fetchSession.current = session;
    return () => { session.cancel(); fetchSession.current = null; };
  }, []);

  useEffect(() => {
    if (!area) return;
    const last = lastFetched.current;
    if (last && last.area === area && radiusM <= last.radius) return;
    (() => {
      setCourseLoad((l) => (l === "done" ? l : "loading"));
      const [lat, lng] = area.split(",").map(Number);
      fetchSession.current?.fetch({ area, radius: radiusM }, lat, lng);
    })();
  }, [area, radiusM]);

  // The golfer can shrink "Max drive" without a new fetch ever firing (the
  // radius only re-fetches on GROWTH) — reconcile the list against the new
  // ceiling immediately so a shrink is honest without waiting on a network
  // round-trip. Selected/favorited/hand-added rows are never pruned.
  // Lower the fetched-radius watermark alongside the prune, so growing BACK
  // to a previously-covered radius refetches and the pruned rows return
  // (review finding: shrink 15→5→15 used to leave the list thinned).
  useEffect(() => {
    (() => {
      setCourses((cs) => (cs.length > 0 ? reconcileCourseOptions(cs, cs, { maxMiles }) : cs));
      const shrunk = radiusMetersForMiles(maxMiles);
      const last = lastFetched.current;
      if (last && shrunk < last.radius) {
        lastFetched.current = { ...last, radius: shrunk };
      }
    })();
  }, [maxMiles]);

  // Results.
  const [slots, setSlots] = useState<TeeTimeSlot[]>([]);
  const [chosenSlot, setChosenSlot] = useState<TeeTimeSlot | null>(null);
  const [bookingResult, setBookingResult] = useState<BookingResult | null>(null);
  void slots; // available for future "results list" UI

  if (phase === "prefs") {
    return (
      <Prefs
        accent={accent}
        windows={windows}
        setWindows={setWindows}
        courses={courses}
        setCourses={setCourses}
        courseLoad={courseLoad}
        area={area}
        maxMiles={maxMiles}
        setMaxMiles={setMaxMiles}
        group={group}
        setGroup={setGroup}
        roster={roster}
        setMaxPriceUsd={setMaxPriceUsd}
        coursesTouchedRef={coursesTouchedRef}
        onBack={() => router.push("/")}
        onDispatch={() => setPhase("searching")}
      />
    );
  }

  if (phase === "searching") {
    return (
      <Searching
        accent={accent}
        windows={windows}
        courses={courses}
        maxMiles={maxMiles}
        group={group}
        maxPriceUsd={maxPriceUsd}
        area={area}
        bookerName={profileName}
        onBack={() => setPhase("prefs")}
        onFound={(allSlots, best, result) => {
          setSlots(allSlots);
          setChosenSlot(best);
          setBookingResult(result);
          setPhase("confirmed");
        }}
      />
    );
  }

  return (
    <Confirmed
      accent={accent}
      slot={chosenSlot}
      bookingResult={bookingResult}
      group={group}
      windows={windows}
      onBack={() => router.push("/")}
    />
  );
}

/* ─────────────────────────────────────────────
   PREFS
   ───────────────────────────────────────────── */

interface PrefsProps {
  accent: string;
  windows: TimeWindow[];
  setWindows: (ws: TimeWindow[]) => void;
  courses: CourseOption[];
  setCourses: (cs: CourseOption[]) => void;
  /** Where the course list is in its load cycle — drives the honest empty copy. */
  courseLoad: CourseLoadState;
  /** Golfer location "lat,lng" — used for honest distances on added courses. */
  area: string | null;
  maxMiles: number;
  setMaxMiles: (m: number) => void;
  group: GroupMember[];
  setGroup: (g: GroupMember[]) => void;
  /** Real saved playing partners — the invite list. Empty when none saved. */
  roster: GroupMember[];
  setMaxPriceUsd: (p: number | null) => void;
  /** Flips true the first time the golfer touches the course list — gates
   *  the auto-pre-selection convenience from re-applying after that. */
  coursesTouchedRef: React.MutableRefObject<boolean>;
  onBack: () => void;
  onDispatch: () => void;
}

/** How the voice affordance currently feels: quiet, live, or working. */

function Prefs({
  accent, windows, setWindows, courses, setCourses, courseLoad, area,
  maxMiles, setMaxMiles, group, setGroup, roster, setMaxPriceUsd,
  coursesTouchedRef, onBack, onDispatch,
}: PrefsProps) {
  const [showRoster, setShowRoster] = useState(false);
  const [showCourseSearch, setShowCourseSearch] = useState(false);

  /** "+ Add course" pick — appended with an honest distance, de-duped by name. */
  const addCourse = (payload: CourseSelectPayload) => {
    coursesTouchedRef.current = true;
    let origin: { lat: number; lng: number } | null = null;
    if (area) {
      const [lat, lng] = area.split(",").map(Number);
      origin = { lat, lng };
    }
    const option = courseOptionFromSelection({
      id: payload.id,
      name: payload.name,
      location: payload.location,
      center: payload.center,
      favorite: isFavorite(String(payload.id)),
    }, origin);
    setCourses(addCourseOption(courses, option));
    setShowCourseSearch(false);
  };

  // ── Voice ("Hold to talk") ──
  // Voice: the Looper orb (tab island) summons the sheet below; live
  // dictation → the deterministic tee-time intent parser. Filling the form
  // by hand remains the fallback.
  const [voiceLines, setVoiceLines] = useState<Array<{ who: "looper" | "you"; text: string }>>([
    { who: "looper", text: "What do you have in mind for this weekend? I'll rustle one up." },
  ]);
  const dispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (dispatchTimerRef.current) clearTimeout(dispatchTimerRef.current);
  }, []);

  /** Append a looper line, keeping the exchange short (calm, not a chat log). */
  const say = useCallback((text: string) => {
    setVoiceLines((ls) => [...ls, { who: "looper" as const, text }].slice(-4));
  }, []);

  const applyParsed = useCallback((parsed: TeeTimePrefsParseResultValidated) => {
    if (!hasTeeTimeSignal(parsed)) {
      const example = courses[0] ? `“Saturday morning at ${courses[0].name}”` : "“Saturday morning, early”";
      say(`Didn’t quite get that — try ${example}, or fill it in below.`);
      return;
    }

    if (parsed.windows.length > 0) {
      setWindows(applyParsedWindows(windows, parsed.windows));
    }
    if (parsed.courseNames.length > 0 || parsed.favoritesOnly) {
      const next = applyParsedCourses(courses, parsed.courseNames, parsed.favoritesOnly);
      setCourses(next);
      // Widen the drive radius when a named course sits beyond it — the golfer
      // asked for that course; silently filtering it out would be dishonest.
      const farthest = Math.max(0, ...next.filter((c) => c.selected && c.distance != null).map((c) => c.distance ?? 0));
      if (parsed.courseNames.length > 0 && farthest > maxMiles) {
        setMaxMiles(Math.min(50, Math.ceil(farthest)));
      }
    }
    if (parsed.maxDistanceMiles != null) {
      setMaxMiles(Math.max(1, Math.min(50, Math.round(parsed.maxDistanceMiles))));
    }
    if (parsed.partySize != null) setGroup(applyPartySize(group, parsed.partySize));
    if (parsed.maxPriceUsd != null) setMaxPriceUsd(parsed.maxPriceUsd);

    say(teeTimeAckLine(parsed) ?? "Got it.");

    // Voice-first: a complete request (a day/time) or an explicit go-ahead
    // sends the looper out — speak, and it searches. A short beat lets the
    // acknowledgement land first.
    if (parsed.windows.length > 0 || parsed.dispatch) {
      dispatchTimerRef.current = setTimeout(onDispatch, 1400);
    }
  }, [windows, setWindows, courses, setCourses, maxMiles, setMaxMiles, group, setGroup, setMaxPriceUsd, onDispatch, say]);

  // ── The Looper sheet (summoned by the tab-island orb) ────────────────────
  const [looperOpen, setLooperOpen] = useState(false);
  const [looperThinking, setLooperThinking] = useState(false);
  const looperMicRef = useRef<() => void>(() => {});
  const dictation = useLooperDictation({
    surface: "tee-time",
    // Bias STT toward the course names on screen — "Bethpage" beats "bath page".
    getKeyterms: () => buildKeyterms(courses.map((c) => c.name)),
    onUtteranceEnd: () => looperMicRef.current(),
  });
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;

  useEffect(() => {
    return onLooperOpen((detail) => {
      if (detail.context !== "tee-time") return;
      setLooperOpen(true);
      if (detail.listening) {
        setTimeout(() => void dictationRef.current.start(), 60);
      }
    });
  }, []);

  const closeLooper = useCallback(() => {
    dictation.cancel();
    setLooperThinking(false);
    setLooperOpen(false);
  }, [dictation]);

  /** Tap: start listening, or stop → parse → apply (the same deterministic
   *  tee-time intent pipeline the hold-to-talk bar used). */
  const handleLooperMic = useCallback(async () => {
    if (!dictation.listening) {
      await dictation.start();
      return;
    }
    setLooperThinking(true);
    const heard = await dictation.stopAndResolve();
    if (!heard) {
      setLooperThinking(false);
      say("Didn’t catch that — tap the mic and tell me when and where.");
      return;
    }
    setVoiceLines((ls) => [...ls, { who: "you" as const, text: heard }].slice(-4));
    try {
      const parsed = await parseTeeTimePrefs({
        transcript: heard,
        known: { courses: courses.map((c) => c.name) },
      });
      applyParsed(parsed);
    } catch {
      say("Lost that one — mind saying it again? Or fill it in below.");
    } finally {
      setLooperThinking(false);
    }
  }, [dictation, courses, applyParsed, say]);
  looperMicRef.current = () => void handleLooperMic();

  const toggleWin = (id: string) => setWindows(windows.map((w) => (w.id === id ? { ...w, selected: !w.selected } : w)));
  const toggleCourse = (id: string) => {
    coursesTouchedRef.current = true;
    setCourses(courses.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)));
  };

  /** Slide-to-edit — dragging a window's track (a preset or a custom one)
   *  keeps its label ("Saturday") but flips `sub` to "custom" so the card
   *  reads honestly as adjusted rather than the original preset time. */
  const editWindow = (id: string, start: string, end: string) =>
    setWindows(windows.map((w) => (w.id === id ? { ...w, start, end, sub: "custom" } : w)));

  /** Calendar date pick — updates the real date; if the picked day's weekday
   *  differs from the window's label, the label follows the picked weekday
   *  (a Saturday window moved to a Wednesday now reads "Wednesday"). */
  const pickWindowDate = (id: string, iso: string) =>
    setWindows(windows.map((w) => {
      if (w.id !== id) return w;
      const pickedWeekday = new Date(`${iso}T12:00:00`).getDay();
      const sameWeekday = weekdayFromLabel(w.label) === pickedWeekday;
      return sameWeekday ? { ...w, date: iso } : { ...w, date: iso, label: weekdayName(pickedWeekday), sub: "custom" };
    }));

  /** Quiet delete — never drops the last window. */
  const deleteWindow = (id: string) => {
    if (windows.length <= 1) return;
    setWindows(windows.filter((w) => w.id !== id));
  };

  /** "Add another window" — a real, DIFFERENT editable window every time
   *  (never a duplicate stamp of the last one added). */
  const addWindow = () => {
    const slot = nextDefaultWindow(windows);
    setWindows([...windows, {
      id: `custom-${Date.now()}`,
      label: slot.label,
      sub: slot.sub,
      start: slot.start,
      end: slot.end,
      date: slot.date,
      selected: true,
    }]);
  };

  /** "Invite" — add a person from the local roster to the group. */
  const addFromRoster = (member: GroupMember) => {
    if (group.find((g) => g.id === member.id)) return;
    setGroup([...group, { ...member, confirmed: false }]);
    setShowRoster(false);
  };

  const selectedCount = courses.filter((c) => c.selected).length;
  const winCount      = windows.filter((w) => w.selected).length;

  return (
    <PaperShell>
      <TTMasthead accent={accent} onBack={onBack} kicker="Dispatch" title="Find me a tee time" />

      {/* Voice moved to the Looper orb in the tab island (specs/looper-orb-plan.md)
          — the sheet below carries the whole exchange; the page body stays calm. */}
      <LooperSheetShell
        open={looperOpen}
        onClose={closeLooper}
        title="Where are we playing?"
        emptyHint={voiceLines[0]?.text ?? "Tell me when and where."}
        turns={voiceLines.slice(1).map((l) => ({ role: l.who === "you" ? "user" as const : "looper" as const, text: l.text }))}
        phase={dictation.listening ? "listening" : looperThinking ? "thinking" : "idle"}
        interim={dictation.interim}
        error={dictation.micError}
        onMicTap={() => void handleLooperMic()}
      />

      {/* ── When ── */}
      <Section kicker="When" title="Windows" aside={<Kicker>{winCount} selected</Kicker>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {windows.map((w) => (
            <WindowCard
              key={w.id}
              win={w}
              accent={accent}
              onToggle={() => toggleWin(w.id)}
              onEdit={(start, end) => editWindow(w.id, start, end)}
              onPickDate={(date) => pickWindowDate(w.id, date)}
              onDelete={() => deleteWindow(w.id)}
            />
          ))}
          <button
            onClick={addWindow}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px dashed ${T.hairline}`,
              background: "transparent",
              cursor: "pointer",
              textAlign: "left" as const,
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.3,
              color: T.pencilSoft,
              textTransform: "uppercase" as const,
              fontWeight: 500,
            }}
          >
            + Add another window
          </button>
        </div>
      </Section>

      {/* ── Who ── */}
      <Section kicker="Who" title="The group" aside={<Kicker>{group.length} playing</Kicker>}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {group.map((p) => (
            <GroupChip key={p.id} p={p} accent={accent} />
          ))}
          <button
            onClick={() => setShowRoster(true)}
            style={{
              padding: "6px 12px",
              borderRadius: 99,
              border: `1px dashed ${T.hairline}`,
              background: "transparent",
              cursor: "pointer",
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.3,
              color: T.pencil,
              textTransform: "uppercase" as const,
              fontWeight: 500,
            }}
          >
            + Invite
          </button>
        </div>

        {/* Local roster picker */}
        <AnimatePresence>
          {showRoster && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
              style={{
                marginTop: 10,
                border: `1px solid ${T.hairline}`,
                borderRadius: 12,
                background: T.paperDeep,
                overflow: "hidden",
              }}
            >
              <div style={{ padding: "10px 14px 6px", fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" as const }}>
                Your roster
              </div>
              {roster.filter((r) => !group.find((g) => g.id === r.id)).map((r, i) => (
                <button
                  key={r.id}
                  onClick={() => addFromRoster(r)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "28px 1fr auto",
                    gap: 10,
                    alignItems: "center",
                    padding: "9px 14px",
                    width: "100%",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    textAlign: "left" as const,
                    borderTop: i === 0 ? "none" : `1px dashed ${T.hairlineSoft}`,
                  }}
                >
                  <div style={{
                    width: 24, height: 24, borderRadius: 99,
                    background: T.paper, border: `1px solid ${T.hairline}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: T.mono, fontSize: 9, fontWeight: 600,
                  }}>
                    {r.init}
                  </div>
                  <div>
                    <div style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1 }}>{r.name}</div>
                    {r.hdcp != null && (
                      <div style={{ fontFamily: T.mono, fontSize: 8, color: T.pencilSoft, letterSpacing: 1, textTransform: "uppercase" as const, marginTop: 1 }}>hdcp {r.hdcp}</div>
                    )}
                  </div>
                  <div style={{ fontFamily: T.mono, fontSize: 9, color: accent, letterSpacing: 1, textTransform: "uppercase" as const }}>Add</div>
                </button>
              ))}
              {roster.length === 0 && (
                <div style={{ padding: "10px 14px 12px", fontFamily: T.serif, fontStyle: "italic", fontSize: 13, color: T.pencil }}>
                  No saved partners yet &mdash; add players to a round and they&rsquo;ll show up here.
                </div>
              )}
              {roster.length > 0 && roster.every((r) => group.find((g) => g.id === r.id)) && (
                <div style={{ padding: "10px 14px 12px", fontFamily: T.serif, fontStyle: "italic", fontSize: 13, color: T.pencil }}>
                  Everyone&rsquo;s already in.
                </div>
              )}
              <div style={{ padding: "6px 14px 10px" }}>
                <button
                  onClick={() => setShowRoster(false)}
                  style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" as const, border: "none", background: "none", cursor: "pointer" }}
                >
                  Close
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Section>

      {/* ── Where ── */}
      <Section kicker="Where" title="Courses" aside={courses.length > 0 ? <Kicker>{selectedCount} selected</Kicker> : undefined}>
        <div style={{ padding: "6px 2px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" as const, fontWeight: 500 }}>
              Max drive
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 15, color: T.ink, letterSpacing: -0.2, fontVariantNumeric: "tabular-nums" }}>
              {maxMiles} <span style={{ fontSize: 10, color: T.pencil }}>mi</span>
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={50}
            value={maxMiles}
            onChange={(e) => setMaxMiles(parseInt(e.target.value))}
            style={{ width: "100%", accentColor: T.ink }}
          />
        </div>

        <div>
          {courses.length === 0 && (
            <div style={{ padding: "2px 0 12px", fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.pencil, letterSpacing: -0.1 }}>
              {emptyCoursesNote(courseLoad, maxMiles)}
            </div>
          )}

          {courses.some((c) => c.favorite) && (
            <>
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" as const, fontWeight: 500, marginBottom: 4 }}>
                Your favorites
              </div>
              {courses.filter((c) => c.favorite).map((c, i) => (
                <CourseRow key={c.id} c={c} accent={accent} onToggle={() => toggleCourse(c.id)} first={i === 0} />
              ))}
            </>
          )}

          {courses.some((c) => !c.favorite) && (
            <>
              <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.3, color: T.pencilSoft, textTransform: "uppercase" as const, fontWeight: 500, marginTop: courses.some((c) => c.favorite) ? 14 : 0, marginBottom: 4 }}>
                {courses.some((c) => c.favorite) ? "Open to" : "Nearby"}
              </div>
              {courses.filter((c) => !c.favorite).map((c, i) => (
                <CourseRow key={c.id} c={c} accent={accent} onToggle={() => toggleCourse(c.id)} first={i === 0} />
              ))}
            </>
          )}

          <button
            onClick={() => setShowCourseSearch(true)}
            style={{
              marginTop: courses.length > 0 ? 8 : 0,
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px dashed ${T.hairline}`,
              background: "transparent",
              cursor: "pointer",
              textAlign: "left" as const,
              fontFamily: T.mono,
              fontSize: 9.5,
              letterSpacing: 1.3,
              color: T.pencilSoft,
              textTransform: "uppercase" as const,
              fontWeight: 500,
            }}
          >
            + Add course
          </button>
        </div>
      </Section>

      <div style={{ padding: "20px 22px 28px" }}>
        <button
          onClick={onDispatch}
          style={{
            width: "100%",
            padding: "16px 18px",
            borderRadius: 16,
            border: "none",
            background: T.ink,
            color: T.paper,
            cursor: "pointer",
            textAlign: "left" as const,
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <div style={{
            width: 42, height: 42, borderRadius: 99, background: accent,
            color: T.paper, display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.serif, fontStyle: "italic", fontSize: 20, letterSpacing: -0.5,
          }}>
            L
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.3, color: "rgba(244,241,234,0.5)", textTransform: "uppercase" as const }}>
              Dispatch looper
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 20, color: T.paper, letterSpacing: -0.3, lineHeight: 1.1, marginTop: 2 }}>
              Go find us one
            </div>
          </div>
          <svg width="12" height="12" viewBox="0 0 12 12" style={{ color: "rgba(244,241,234,0.4)" }}>
            <path d="M3 2 L8 6 L3 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div style={{ marginTop: 10, fontFamily: T.serif, fontSize: 13, color: T.pencil, fontStyle: "italic", textAlign: "center", letterSpacing: -0.1 }}>
          Takes a minute or two. I&rsquo;ll ping you the moment I&rsquo;ve got one.
        </div>
      </div>

      {/* ── Add-course search (same sheet as round setup) ── */}
      <AnimatePresence>
        {showCourseSearch && (
          <CourseSearch
            onSelectCourse={addCourse}
            onClose={() => setShowCourseSearch(false)}
          />
        )}
      </AnimatePresence>
    </PaperShell>
  );
}

/* ─────────────────────────────────────────────
   SEARCHING
   Real provider call; live log.
   ───────────────────────────────────────────── */

type LogState = "ok" | "pending" | "miss" | "win";
interface LogLine { t: string; text: string; state: LogState; course: string }

interface SearchingProps {
  accent: string;
  windows: TimeWindow[];
  courses: CourseOption[];
  maxMiles: number;
  group: GroupMember[];
  /** Price ceiling in USD — null when the golfer never named one. */
  maxPriceUsd: number | null;
  /** Golfer location as "lat,lng" — null when unknown (search runs without it). */
  area: string | null;
  /** The golfer's real profile name — null when no profile exists yet. */
  bookerName: string | null;
  onBack: () => void;
  onFound: (slots: TeeTimeSlot[], chosen: TeeTimeSlot, result: BookingResult) => void;
}

function Searching({ accent, windows, courses, maxMiles, group, maxPriceUsd, area, bookerName, onBack, onFound }: SearchingProps) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  const selectedWindows  = windows.filter((w) => w.selected);
  // Unknown-distance courses (hand-added, no center) are the golfer's explicit
  // picks — never silently dropped by the radius filter.
  const selectedCourses  = courses.filter((c) => c.selected && (c.distance == null || c.distance <= maxMiles));
  const partySize        = Math.max(1, group.length);

  // One query per selected window, each on its OWN day's next date.
  const queries: TeeTimeQuery[] = buildTeeTimeQueries({
    windows: selectedWindows.map((w) => ({ label: w.label, start: w.start, end: w.end, date: w.date })),
    courseIds: selectedCourses.map((c) => c.id),
    partySize,
    maxDistanceMiles: maxMiles,
    maxPriceUsd: maxPriceUsd ?? undefined,
    area: area ?? undefined,
  });
  const targetDate = queries[0].date;

  const windowSummary = selectedWindows.length > 0
    ? `${selectedWindows[0].start}–${selectedWindows[0].end}`
    : "any time";
  const courseSummary = selectedCourses.length > 0
    ? selectedCourses.map((c) => c.name).join(" · ")
    : "any course";

  useEffect(() => {
    const iv = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (done.current) return;
    done.current = true;

    const run = async () => {
      const append = (line: LogLine) => setLog((prev) => [...prev, line]);
      const nowStr = () => {
        const d = new Date();
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      };

      append({ t: nowStr(), text: `Checking ${selectedCourses.length || "nearby"} course${selectedCourses.length !== 1 ? "s" : ""} …`, state: "pending", course: "" });

      let allSlots: TeeTimeSlot[] = [];
      for (const q of queries) {
        try {
          const results = await searchTeeTimes(q);
          allSlots = [...allSlots, ...results];
          if (results.length > 0) {
            const isRouteEntries = Boolean(results[0]?.route);
            const text = isRouteEntries
              ? `${results.length} course${results.length !== 1 ? "s" : ""} open to the public in ${q.timeWindowStart}–${q.timeWindowEnd}`
              : `${results.length} slot${results.length !== 1 ? "s" : ""} in ${q.timeWindowStart}–${q.timeWindowEnd}`;
            append({ t: nowStr(), text, state: "ok", course: "" });
          } else {
            append({ t: nowStr(), text: `Nothing in ${q.timeWindowStart}–${q.timeWindowEnd}`, state: "miss", course: "" });
          }
        } catch {
          append({ t: nowStr(), text: "Couldn't reach that window — skipping it.", state: "miss", course: "" });
        }
      }

      // Deduplicate.
      const seen = new Set<string>();
      const unique = allSlots.filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });

      if (unique.length === 0) {
        setError("Nothing open nearby. Try a wider window or radius.");
        return;
      }

      // Unknown (null) prices sort last — never preferred over a known price.
      const best = unique.slice().sort((a, b) =>
        a.distanceMiles - b.distanceMiles ||
        (a.priceUsd ?? Number.MAX_SAFE_INTEGER) - (b.priceUsd ?? Number.MAX_SAFE_INTEGER)
      )[0];
      // A route entry (routing provider) is a course we found, not a locked
      // slot — the copy says so. A real slot (foreup: route is undefined) is
      // still a needs_human deep-link handoff, not a completed booking — "Setting
      // it up" stays honest without overclaiming a reservation we haven't made.
      const bestLine = best.route
        ? `${best.courseName} — closest match. Pulling up how to book.`
        : `${best.courseName} ${formatTime12h(best.time)} — ${best.players} open. Setting it up.`;
      append({ t: nowStr(), text: bestLine, state: "ok", course: best.courseName });

      let result: BookingResult;
      try {
        result = await bookTeeTime(best, { name: bookerName ?? "Guest", partySize });
      } catch {
        result = { status: "pending", message: "Booking request sent — check back shortly." };
      }

      if (result.status === "confirmed") {
        append({ t: nowStr(), text: `${best.courseName} confirmed — ${best.time}.`, state: "win", course: best.courseName });
      } else {
        // The backend's `message` is already golfer-facing copy (routing's
        // needs_human handoff line, etc.) — never surface the raw status enum.
        const text = result.message ?? (result.status === "failed" ? "That didn't go through." : "Working on it.");
        append({ t: nowStr(), text, state: result.status === "failed" ? "miss" : "ok", course: best.courseName });
      }

      await new Promise<void>((r) => setTimeout(r, 1200));
      onFound(unique, best, result);
    };

    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");

  return (
    <PaperShell>
      <TTMasthead accent={accent} onBack={onBack} kicker="In flight" title="Looper is working" />

      <div style={{ padding: "0 22px 16px" }}>
        <div style={{ padding: "12px 14px", borderRadius: 12, background: T.ink, color: T.paper, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ position: "relative" }}>
            <motion.span
              animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
              transition={{ duration: 1.6, repeat: Infinity }}
              style={{ position: "absolute", inset: -4, borderRadius: 99, background: accent }}
            />
            <span style={{ position: "relative", display: "block", width: 10, height: 10, borderRadius: 99, background: accent }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1.4, color: "rgba(244,241,234,0.55)", textTransform: "uppercase" as const, fontWeight: 500 }}>
              Dispatched · {targetDate}
            </div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 17, color: T.paper, letterSpacing: -0.2, lineHeight: 1.1, marginTop: 2 }}>
              {selectedCourses.length || "all"} courses · {windowSummary}
            </div>
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 14, letterSpacing: 1.2, color: T.paper, fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
            {mm}:{ss}
          </div>
        </div>
      </div>

      <div style={{ padding: "4px 22px 10px" }}>
        <Radar
          accent={accent}
          pins={(selectedCourses.length > 0 ? selectedCourses : courses.filter((c) => c.distance != null && c.distance <= maxMiles))
            .filter((c) => c.distance != null)
            .map((c) => ({ name: c.name, distance: c.distance ?? 0 }))}
        />
      </div>

      <Section kicker="Live log" title="Dispatches" aside={<Kicker>· live</Kicker>}>
        <div>
          {log.length === 0 && !error && (
            <div style={{ display: "grid", gridTemplateColumns: "40px 14px 1fr", gap: 10, padding: "8px 0", alignItems: "center" }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase" as const }}>— —</div>
              <div style={{ display: "flex", gap: 2 }}>
                {[0, 1, 2].map((i) => (
                  <motion.span key={i} animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15 }} style={{ width: 2, height: 2, borderRadius: 99, background: T.pencil, display: "inline-block" }} />
                ))}
              </div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.pencil, letterSpacing: -0.1 }}>Checking nearby courses&hellip;</div>
            </div>
          )}
          {log.map((l, i) => (
            <LogRow key={i} line={l} accent={accent} first={i === 0} />
          ))}
          {error && (
            <div style={{ padding: "10px 0", fontFamily: T.serif, fontSize: 14, fontStyle: "italic", color: T.pencilSoft, letterSpacing: -0.1 }}>
              {error}
            </div>
          )}
          {log.length > 0 && !error && (
            <div style={{ display: "grid", gridTemplateColumns: "40px 14px 1fr", gap: 10, padding: "8px 0", alignItems: "center", borderTop: `1px dashed ${T.hairlineSoft}` }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase" as const }}>— —</div>
              <div style={{ display: "flex", gap: 2 }}>
                {[0, 1, 2].map((i) => (
                  <motion.span key={i} animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15 }} style={{ width: 2, height: 2, borderRadius: 99, background: T.pencil, display: "inline-block" }} />
                ))}
              </div>
              <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 14, color: T.pencil, letterSpacing: -0.1 }}>Still working&hellip;</div>
            </div>
          )}
        </div>
      </Section>

      <Section kicker="Brief" title="What I told the looper">
        <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 8, rowGap: 10 }}>
          {[
            ["When",   selectedWindows.map((w) => `${w.label} ${w.start}–${w.end}`).join(", ") || "any time"],
            ["Who",    `${group.length} · ${group.map((p) => p.name).join(", ")}`],
            ["Where",  courseSummary],
            ["Radius", `Under ${maxMiles} miles`],
            ...(maxPriceUsd != null ? [["Budget", `Under $${Math.round(maxPriceUsd)}`]] : []),
          ].map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.4, color: T.pencilSoft, textTransform: "uppercase" as const, fontWeight: 500, paddingTop: 2 }}>{k}</div>
              <div style={{ fontFamily: T.serif, fontSize: 14, color: T.ink, letterSpacing: -0.1, lineHeight: 1.3 }}>{v}</div>
            </div>
          ))}
        </div>
      </Section>

      {error && (
        <div style={{ padding: "12px 22px 24px" }}>
          <button
            onClick={onBack}
            style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: `1.5px solid ${T.ink}`, background: "transparent", cursor: "pointer", fontFamily: T.mono, fontSize: 10, letterSpacing: 1.5, color: T.ink, textTransform: "uppercase" as const, fontWeight: 600 }}
          >
            ← Adjust prefs
          </button>
        </div>
      )}

      <div style={{ padding: "8px 22px 30px" }}>
        <div style={{ marginTop: 10, textAlign: "center", fontFamily: T.serif, fontSize: 13, fontStyle: "italic", color: T.pencil, letterSpacing: -0.1 }}>
          Keep walking. I&rsquo;ll buzz you.
        </div>
      </div>
    </PaperShell>
  );
}

/* ─────────────────────────────────────────────
   CONFIRMED
   Data-driven from the real provider result.
   ───────────────────────────────────────────── */

interface ConfirmedProps {
  accent: string;
  slot: TeeTimeSlot | null;
  bookingResult: BookingResult | null;
  group: GroupMember[];
  /** The prefs windows the golfer selected — used when `slot.time` is unknown
   *  (routing) to show the requested window instead of a fabricated time. */
  windows: TimeWindow[];
  onBack: () => void;
}

function Confirmed({ accent, slot, bookingResult, group, windows, onBack }: ConfirmedProps) {
  if (!slot) {
    return (
      <PaperShell>
        <div style={{ padding: "80px 22px", textAlign: "center", fontFamily: T.serif, fontStyle: "italic", fontSize: 18, color: T.pencil }}>
          No result found. Try again.
        </div>
        <div style={{ padding: "0 22px" }}>
          <button onClick={onBack} style={{ width: "100%", padding: "12px", borderRadius: 12, border: `1px solid ${T.ink}`, background: "transparent", cursor: "pointer", fontFamily: T.mono, fontSize: 10, letterSpacing: 1.5, color: T.ink, textTransform: "uppercase" as const }}>
            Back
          </button>
        </div>
      </PaperShell>
    );
  }

  const confCode   = bookingResult?.confirmationNumber ?? (bookingResult?.status === "pending" ? "PENDING" : "—");
  const dateLabel  = formatDateLabel(slot.date);
  const isMock     = slot.provider === "mock";
  // A needs_human result is a HANDOFF, not a booking — the course takes the
  // reservation; we never fabricate a confirmation.
  const needsHuman = bookingResult?.status === "needs_human";
  const bookingUrl = bookingResult?.bookingUrl ?? slot.bookingUrl;
  const copy = confirmCopy(slot, bookingResult);
  const { stampWord, looperLine, ctaLabel, subCopy } = copy;
  const telHref = callTelHref(slot);

  // No fabricated tee time (routing): `formatTime12h("")` would read "NaN:NaN".
  // Show the requested window instead — the window whose date matches this
  // slot, falling back to the first selected, then the first window.
  const hasKnownTime = slot.time !== "";
  const requestedWindow = windows.find((w) => w.date === slot.date)
    ?? windows.find((w) => w.selected)
    ?? windows[0];
  const timeCardKicker = hasKnownTime ? "Tee off" : "Your window";
  const timeCardFigure = hasKnownTime
    ? formatTime12h(slot.time)
    : requestedWindow ? formatWindowRange(requestedWindow.start, requestedWindow.end) : "—";

  const addToCalendar = () => {
    const ev = {
      courseName: slot.courseName,
      city: slot.city || undefined,
      date: slot.date,
      time: slot.time,
      partySize: group.length,
      bookingUrl: bookingUrl ?? undefined,
      estimated: slot.estimated,
    };
    downloadICS(buildTeeTimeICS(ev), icsFilename(ev));
  };

  return (
    <PaperShell>
      <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 12px", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <button
            onClick={onBack}
            style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, fontFamily: T.mono, fontSize: 10, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase" as const, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12">
              <path d="M8 2 L3 6 L8 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Home
          </button>
          <Kicker>Looper · {stampWord}</Kicker>
        </div>

        {/* Stamp */}
        <motion.div
          initial={{ rotate: -4, scale: 0.9, opacity: 0 }}
          animate={{ rotate: -3, scale: 1, opacity: 0.96 }}
          transition={{ duration: 0.6, ease: T.ease, delay: 0.2 }}
          style={{ position: "absolute", top: 34, right: 22, width: 90, height: 90, borderRadius: 99, border: `2.5px solid ${accent}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: accent, pointerEvents: "none" }}
        >
          <div style={{ fontFamily: T.mono, fontSize: 7.5, letterSpacing: 1.8, textTransform: "uppercase" as const, fontWeight: 700 }}>
            {isMock ? "Demo" : "Looper"}
          </div>
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, letterSpacing: -0.4, lineHeight: 1, marginTop: 2 }}>
            {stampWord}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 7, letterSpacing: 1.3, textTransform: "uppercase" as const, marginTop: 2, opacity: 0.8 }}>
            {confCode}
          </div>
        </motion.div>

        <div style={{ marginTop: 22 }}>
          <Kicker>{dateLabel}</Kicker>
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 38, color: T.ink, letterSpacing: -1, lineHeight: 1, marginTop: 4 }}>
            {slot.courseName}
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 14, color: T.pencil, fontStyle: "italic", marginTop: 6, letterSpacing: -0.1 }}>
            {slot.city} · {slot.holes} holes
          </div>
        </div>
      </div>

      {/* Time card */}
      <div style={{ padding: "8px 22px 16px" }}>
        <div style={{ padding: "18px 20px", borderRadius: 14, background: T.ink, color: T.paper, position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, background: `repeating-linear-gradient(to bottom, ${accent} 0, ${accent} 3px, transparent 3px, transparent 7px)` }} />
          <div style={{ paddingLeft: 10 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: "rgba(244,241,234,0.55)", textTransform: "uppercase" as const, fontWeight: 500 }}>{timeCardKicker}</div>
            <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: hasKnownTime ? 68 : 40, letterSpacing: -2.2, color: T.paper, lineHeight: 0.95, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
              {timeCardFigure}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4, marginTop: 14, paddingTop: 12, borderTop: "1px dashed rgba(244,241,234,0.2)" }}>
              {[
                ["Group",    `${group.length} players`],
                ["Price",    slot.priceUsd != null ? `$${Math.round(slot.priceUsd)}` : "—"],
                ["Distance", `${slot.distanceMiles} mi`],
              ].map(([k, v], i) => (
                <div key={k} style={{ paddingLeft: i === 0 ? 0 : 10, borderLeft: i === 0 ? "none" : "1px dashed rgba(244,241,234,0.18)" }}>
                  <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.2, color: "rgba(244,241,234,0.5)", textTransform: "uppercase" as const, fontWeight: 500 }}>{k}</div>
                  <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 17, color: T.paper, letterSpacing: -0.3, marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Looper message */}
      <div style={{ padding: "0 22px 14px" }}>
        <Transcript accent={accent} lines={[{ who: "looper", text: looperLine }]} />
      </div>

      {/* Booking handoff — the course takes the reservation (routing/mock). */}
      {bookingUrl ? (
        <div style={{ padding: "0 22px 14px" }}>
          <a
            href={bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "block", width: "100%", padding: "12px 14px", borderRadius: 12, border: `1.5px solid ${accent}`, background: "transparent", cursor: "pointer", textAlign: "center" as const, fontFamily: T.mono, fontSize: 10, letterSpacing: 1.4, color: accent, textTransform: "uppercase" as const, fontWeight: 600, textDecoration: "none" }}
          >
            {ctaLabel}
          </a>
          {needsHuman && subCopy && (
            <div style={{ marginTop: 6, textAlign: "center", fontFamily: T.serif, fontStyle: "italic", fontSize: 12, color: T.pencilSoft }}>
              {subCopy}
            </div>
          )}
          {isMock && (
            <div style={{ marginTop: 6, textAlign: "center", fontFamily: T.serif, fontStyle: "italic", fontSize: 12, color: T.pencilSoft }}>
              Demo mode &mdash; link opens real booking page
            </div>
          )}
        </div>
      ) : needsHuman && telHref ? (
        <div style={{ padding: "0 22px 14px" }}>
          {/* No online booking link — but a real phone number, so this is a
              working tel: link, never an inert button. */}
          <a
            href={telHref}
            style={{ display: "block", width: "100%", padding: "12px 14px", borderRadius: 12, border: `1.5px solid ${T.ink}`, background: "transparent", cursor: "pointer", textAlign: "center" as const, fontFamily: T.mono, fontSize: 10, letterSpacing: 1.4, color: T.ink, textTransform: "uppercase" as const, fontWeight: 600, textDecoration: "none" }}
          >
            {ctaLabel}
          </a>
          <div style={{ marginTop: 6, textAlign: "center", fontFamily: T.serif, fontStyle: "italic", fontSize: 12, color: T.pencilSoft }}>
            {slot.phone}
          </div>
        </div>
      ) : needsHuman ? (
        // No booking link AND no phone on file — never render button chrome
        // with nothing behind it; the looper message already says to call.
        <div style={{ padding: "0 22px 14px", textAlign: "center" as const, fontFamily: T.serif, fontStyle: "italic", fontSize: 13, color: T.pencilSoft }}>
          No phone number on file for this course &mdash; try their website or a quick search.
        </div>
      ) : null}

      {/* Group */}
      <Section kicker="The group" title={`${group.length} ball${group.length !== 1 ? "s" : ""}`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {group.map((p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "32px 1fr auto", gap: 12, alignItems: "center", padding: "8px 0" }}>
              <div style={{ width: 32, height: 32, borderRadius: 99, background: p.self ? accent : T.paperDeep, color: p.self ? T.paper : T.ink, border: p.self ? "none" : `1px solid ${T.hairline}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono, fontSize: 10, fontWeight: 600, letterSpacing: 0.3 }}>
                {p.init}
              </div>
              <div>
                <div style={{ fontFamily: T.serif, fontStyle: p.self ? "italic" : "normal", fontSize: 15, color: T.ink, letterSpacing: -0.15, lineHeight: 1.1 }}>{p.name}</div>
                <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.1, color: T.pencilSoft, textTransform: "uppercase" as const, fontWeight: 500, marginTop: 2 }}>
                  {p.confirmed ? "Confirmed" : "Invited"}{p.hdcp != null ? ` · hdcp ${p.hdcp}` : ""}
                </div>
              </div>
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M2 5 L4 7 L8 3" stroke={p.confirmed ? accent : T.pencilSoft} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          ))}
        </div>
      </Section>

      {/* No known tee time (routing) → never a calendar event at a fabricated
          time; the button returns once a real time is known (S1). */}
      {hasKnownTime && (
        <div style={{ padding: "20px 22px 36px" }}>
          <button
            onClick={addToCalendar}
            style={{ width: "100%", padding: "14px 18px", borderRadius: 14, border: "none", background: accent, color: T.paper, cursor: "pointer", fontFamily: T.serif, fontStyle: "italic", fontSize: 18, letterSpacing: -0.3 }}
          >
            Add to calendar · Set reminder
          </button>
        </div>
      )}
    </PaperShell>
  );
}

/* ─────────────────────────────────────────────
   Utility helpers
   ───────────────────────────────────────────── */

/** "2026-10-18" → "Saturday, Oct 18" */
function formatDateLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

/** "07:10" → "7:10 AM" */
function formatTime12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const hour   = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}

/** "07:00" + "10:00" → "7:00–10:00 AM"; different periods → "11:00 AM–1:00 PM". */
function formatWindowRange(start: string, end: string): string {
  const [sh] = start.split(":").map(Number);
  const [eh] = end.split(":").map(Number);
  const sPeriod = sh < 12 ? "AM" : "PM";
  const ePeriod = eh < 12 ? "AM" : "PM";
  const startLabel = formatTime12h(start);
  const endLabel = formatTime12h(end);
  return sPeriod === ePeriod
    ? `${startLabel.replace(` ${sPeriod}`, "")}–${endLabel}`
    : `${startLabel}–${endLabel}`;
}

/* ─────────────────────────────────────────────
   Primitives
   ───────────────────────────────────────────── */

function PaperShell({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: `${PAPER_NOISE}, ${T.paper}`, backgroundBlendMode: "multiply", fontFamily: T.sans, color: T.ink }}>
      <div style={{ maxWidth: 420, margin: "0 auto", paddingBottom: "calc(88px + env(safe-area-inset-bottom, 0px))" }}>{children}</div>
    </div>
  );
}

function Kicker({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1.6, color: T.pencilSoft, textTransform: "uppercase" as const, fontWeight: 500 }}>
      {children}
    </div>
  );
}

function Section({ kicker, title, aside, children }: { kicker: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ padding: "20px 22px 16px", borderTop: `1px solid ${T.hairline}`, position: "relative" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div>
          <Kicker>{kicker}</Kicker>
          <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 22, color: T.ink, letterSpacing: -0.4, lineHeight: 1, marginTop: 3 }}>{title}</div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TTMasthead({ accent: _accent, onBack, kicker, title }: { accent: string; onBack: () => void; kicker: string; title: string }) {
  return (
    <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 14px", position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button
          onClick={onBack}
          style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, fontFamily: T.mono, fontSize: 10, letterSpacing: 1.6, color: T.pencil, textTransform: "uppercase" as const, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12">
            <path d="M8 2 L3 6 L8 10" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Home
        </button>
        <Kicker>Looper · dispatch</Kicker>
      </div>
      <div style={{ marginTop: 18 }}>
        <Kicker>{kicker}</Kicker>
        <div style={{ fontFamily: T.serif, fontStyle: "italic", fontSize: 38, color: T.ink, letterSpacing: -1, lineHeight: 1, marginTop: 4 }}>{title}</div>
      </div>
    </div>
  );
}

function Transcript({ accent, lines }: { accent: string; lines: Array<{ who: "looper" | "you"; text: string }> }) {
  return (
    <div style={{ padding: "14px 16px", borderRadius: 12, background: T.paperDeep, border: `1px solid ${T.hairline}`, display: "flex", flexDirection: "column", gap: 8 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "46px 1fr", gap: 10, alignItems: "baseline" }}>
          <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: 1.3, color: l.who === "looper" ? accent : T.pencilSoft, textTransform: "uppercase" as const, fontWeight: 600, paddingTop: 2 }}>
            {l.who === "looper" ? "Looper" : "You"}
          </div>
          <div style={{ fontFamily: T.serif, fontStyle: l.who === "looper" ? "italic" : "normal", fontSize: 14.5, color: T.ink, letterSpacing: -0.1, lineHeight: 1.35 }}>
            {l.text}
          </div>
        </div>
      ))}
    </div>
  );
}

function GroupChip({ p, accent }: { p: GroupMember; accent: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px 6px 6px", borderRadius: 99, background: p.self ? `${accent}14` : T.paperDeep, border: `1px solid ${p.self ? accent : T.hairline}` }}>
      <div style={{ width: 24, height: 24, borderRadius: 99, background: p.self ? accent : T.paper, color: p.self ? T.paper : T.ink, border: p.self ? "none" : `1px solid ${T.hairline}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.mono, fontSize: 9, letterSpacing: 0.3, fontWeight: 600 }}>
        {p.init}
      </div>
      <div>
        <div style={{ fontFamily: T.serif, fontStyle: p.self ? "italic" : "normal", fontSize: 13, color: T.ink, letterSpacing: -0.1, lineHeight: 1 }}>{p.name}</div>
        {p.hdcp != null && (
          <div style={{ fontFamily: T.mono, fontSize: 7.5, letterSpacing: 0.8, color: T.pencilSoft, textTransform: "uppercase" as const, fontWeight: 500, marginTop: 1 }}>hdcp {p.hdcp}</div>
        )}
      </div>
    </div>
  );
}

function CourseRow({ c, accent, onToggle, first }: { c: CourseOption; accent: string; onToggle: () => void; first: boolean }) {
  return (
    <button
      onClick={onToggle}
      style={{ display: "grid", gridTemplateColumns: "26px 1fr auto", gap: 10, alignItems: "center", padding: "13px 2px", width: "100%", border: "none", background: "transparent", cursor: "pointer", textAlign: "left" as const, borderTop: first ? "none" : `1px dashed ${T.hairlineSoft}` }}
    >
      <div style={{ width: 21, height: 21, borderRadius: 4, border: `1.5px solid ${c.selected ? T.ink : T.hairline}`, background: c.selected ? T.ink : T.paper, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {c.selected && (
          <svg width="11" height="11" viewBox="0 0 10 10">
            <path d="M2 5 L4 7 L8 3" stroke={T.paper} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <div style={{ fontFamily: T.serif, fontStyle: c.favorite ? "italic" : "normal", fontSize: 15, color: T.ink, letterSpacing: -0.15, lineHeight: 1.1 }}>{c.name}</div>
        {c.favorite && (
          <svg width="9" height="9" viewBox="0 0 10 10" style={{ flexShrink: 0 }}>
            <path d="M5 1 L6.2 3.8 L9 4 L6.8 6 L7.5 9 L5 7.5 L2.5 9 L3.2 6 L1 4 L3.8 3.8 Z" fill={accent} />
          </svg>
        )}
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 8.5, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase" as const, fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
        {[c.distance != null ? `${c.distance}mi` : null, c.muni || null].filter(Boolean).join(" · ")}
      </div>
    </button>
  );
}

/** "TPC Harding Park Golf Course" → "TPC HARDIN" — short mono radar label. */
function radarLabel(name: string): string {
  return name.replace(/\s+(golf\s+(course|club|links)|country club|park)\s*$/i, "").toUpperCase().slice(0, 10).trim();
}

/**
 * Dispatch radar. Pins are the golfer's actual selected courses: angle slots
 * are fixed (deterministic — no jitter), radius scales with the course's real
 * relative distance. Capped to the 4 nearest so labels always fit.
 */
function Radar({ accent, pins }: { accent: string; pins: Array<{ name: string; distance: number }> }) {
  const shown = pins.slice(0, 4);
  const maxD = Math.max(1, ...shown.map((p) => p.distance));
  const ANGLES = [155, 50, 215, 325]; // deg: up-left, up-right, down-left, down-right
  return (
    <div style={{ position: "relative", width: 200, height: 200, margin: "0 auto" }}>
      <svg width="200" height="200" viewBox="0 0 200 200">
        {[30, 55, 80].map((r) => (
          <circle key={r} cx="100" cy="100" r={r} fill="none" stroke={T.hairline} strokeWidth="0.7" strokeDasharray="2 3" />
        ))}
        <line x1="20" y1="100" x2="180" y2="100" stroke={T.hairline} strokeWidth="0.5" />
        <line x1="100" y1="20" x2="100" y2="180" stroke={T.hairline} strokeWidth="0.5" />
        {shown.map((p, i) => {
          const r = 30 + 48 * (p.distance / maxD);
          const a = (ANGLES[i % ANGLES.length] * Math.PI) / 180;
          const cx = 100 + r * Math.cos(a);
          const cy = 100 - r * Math.sin(a);
          const left = cx <= 100;
          return (
            <g key={`${p.name}-${i}`}>
              <circle cx={cx} cy={cy} r="3" fill={i === 0 ? accent : T.ink} />
              <text x={left ? cx - 7 : cx + 7} y={cy + 3} textAnchor={left ? "end" : "start"} fontFamily={T.mono} fontSize="7" fill={T.pencil} letterSpacing="1">
                {radarLabel(p.name)}
              </text>
            </g>
          );
        })}
        <circle cx="100" cy="100" r="4" fill={T.ink} />
        <circle cx="100" cy="100" r="7" fill="none" stroke={T.ink} strokeWidth="0.6" />
        <defs>
          <linearGradient id="tt-sweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={accent} stopOpacity="0" />
            <stop offset="100%" stopColor={accent} stopOpacity="0.35" />
          </linearGradient>
        </defs>
        <motion.g animate={{ rotate: 360 }} transition={{ duration: 4, repeat: Infinity, ease: "linear" }} style={{ transformOrigin: "100px 100px" }}>
          <path d="M100,100 L100,20 A80,80 0 0,1 175,80 Z" fill="url(#tt-sweep)" />
        </motion.g>
      </svg>
    </div>
  );
}

function LogRow({ line, accent, first }: { line: LogLine; accent: string; first: boolean }) {
  const dotColor = line.state === "win" ? accent : line.state === "miss" ? T.pencilSoft : line.state === "pending" ? T.pencil : T.ink;
  const glyph    = line.state === "win" ? "✓" : line.state === "miss" ? "·" : "›";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "40px 14px 1fr", gap: 10, padding: "8px 0", alignItems: "baseline", borderTop: first ? "none" : `1px dashed ${T.hairlineSoft}` }}>
      <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 1, color: T.pencilSoft, textTransform: "uppercase" as const, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{line.t}</div>
      <div style={{ fontFamily: T.mono, fontSize: 13, color: dotColor, textAlign: "center", lineHeight: 1, fontWeight: 600 }}>{glyph}</div>
      <div style={{ fontFamily: T.serif, fontStyle: line.state === "win" ? "italic" : "normal", fontSize: 14, color: line.state === "win" ? accent : T.ink, letterSpacing: -0.1, lineHeight: 1.35 }}>
        {line.text}
      </div>
    </div>
  );
}
