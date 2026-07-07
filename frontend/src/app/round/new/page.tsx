"use client";

import { useEffect, useState, useCallback, ReactNode } from "react";
import { roundHref } from "@/lib/round-url";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { T, PAPER_NOISE, DEFAULT_ACCENT, CADDIES } from "@/components/yardage/tokens";
import { saveRound as localSaveRound, getSavedPlayers } from "@/lib/storage";
import { createDefaultCourse } from "@/lib/types";
import { createRound, getPlayers } from "@/lib/api";
import type { Player, Round, Game, GameFormat, SavedPlayer, HoleInfo } from "@/lib/types";
import { matchPlayerNames } from "@/lib/player-match";
import { fuzzyBestMatch } from "@/lib/voice/utils";
import { listFavorites } from "@/lib/course-favorites";
import { getRecentCourses } from "@/lib/golf-api";
import VoiceRoundSetupRealtime from "@/components/VoiceRoundSetupRealtime";
import { warmSession } from "@/lib/voice/warm-session";
import CourseSearch from "@/components/CourseSearch";
import PlayerAutocomplete from "@/components/PlayerAutocomplete";
import { takeCourseForRound } from "@/lib/course-handoff";
import { anchorFromSelectedCourse } from "@/lib/round-anchor";
import { haptic } from "@/lib/haptics";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type GameId =
  | "stroke"
  | "match"
  | "skins"
  | "nassau"
  | "stable"
  | "wolf"
  | "vegas"
  | "bbb"
  | "bb"
  | "scr"
  | "quota"
  | "none";

type TeeId = "black" | "blue" | "white" | "gold" | "red";
type SideId = "snake" | "presses" | "greenies" | "sandies";
type Picker = null | "game" | "tee" | "sides" | "holes" | "player";

interface SelectedCourse {
  id: number | string;
  name: string;
  clubName?: string;
  location?: string;
  holes?: number; // hole count from GolfAPI (not HoleInfo[])
  par?: number;
  /** Source from CourseSearch — "mapped" means id is a mapped-course UUID. */
  source?: string;
  /** Geographic centre from the search result — becomes the round's course anchor. */
  center?: { lat: number; lng: number };
}

// ---------------------------------------------------------------------------
// Static option lists
// ---------------------------------------------------------------------------

const GAME_OPTIONS: { id: GameId; l: string; sub: string; tag: string | null }[] = [
  { id: "stroke", l: "Stroke play", sub: "Classic. Lowest total wins.", tag: "Solo OK" },
  { id: "match", l: "Match play", sub: "Hole by hole. First to close it out wins.", tag: "1v1" },
  { id: "skins", l: "Skins", sub: "Low score on a hole takes the pot.", tag: "$ per hole" },
  { id: "nassau", l: "Nassau", sub: "Three bets: front 9, back 9, overall.", tag: "$20·20·20" },
  { id: "stable", l: "Stableford", sub: "Points per hole. Aggressive rewarded.", tag: "Net" },
  { id: "wolf", l: "Wolf", sub: "Rotating lone wolf. Partners or go alone.", tag: "3–4 ply" },
  { id: "vegas", l: "Vegas", sub: "Team scores combined into two-digit numbers.", tag: "Pairs" },
  { id: "bbb", l: "Bingo Bango Bongo", sub: "First on green, closest, first to hole.", tag: "Any size" },
  { id: "bb", l: "Best ball", sub: "Two-player team, best net score wins.", tag: "Teams" },
  { id: "scr", l: "Scramble", sub: "Everyone tees off, team plays best ball.", tag: "Teams" },
  { id: "quota", l: "Quota", sub: "Beat your handicap points total.", tag: "Solo OK" },
  { id: "none", l: "No stakes", sub: "Just a round.", tag: null },
];

const TEE_OPTIONS: { id: TeeId; l: string; c: string; yds: number }[] = [
  { id: "black", l: "Black · Championship", c: "#1a1a1a", yds: 7244 },
  { id: "blue", l: "Blue · Back", c: "#3a4a8a", yds: 6845 },
  { id: "white", l: "White · Middle", c: "#eae5d6", yds: 6473 },
  { id: "gold", l: "Gold · Forward", c: "#b8763a", yds: 5984 },
  { id: "red", l: "Red", c: "#b84a3a", yds: 5412 },
];

const SIDES: { id: SideId; l: string; sub: string }[] = [
  { id: "snake", l: "Snake", sub: "$ for each 3-putt held" },
  { id: "presses", l: "Presses", sub: "Nassau rules — double down" },
  { id: "greenies", l: "Greenies", sub: "Closest-to-pin on par 3s" },
  { id: "sandies", l: "Sandies", sub: "Par after bunker shot" },
];

/** Maps the local GameId to the canonical GameFormat type on the backend. */
const GAME_ID_TO_FORMAT: Partial<Record<GameId, GameFormat>> = {
  match: "matchPlay",
  skins: "skins",
  nassau: "nassau",
  stable: "stableford",
  wolf: "wolf",
  vegas: "vegas",
  bbb: "bingoBangoBongo",
  bb: "bestBall",
  scr: "scramble",
};

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function RoundSetupPage() {
  const router = useRouter();
  const accent = DEFAULT_ACCENT;
  const caddy = CADDIES.find((c) => c.id === "steve") ?? CADDIES[0];

  // --- Course ---
  const [selectedCourse, setSelectedCourse] = useState<SelectedCourse | null>(null);

  // --- Players ---
  // At least one slot always exists; custom players use `custom-player-{i}` ids.
  const [players, setPlayers] = useState<Player[]>([
    { id: "custom-player-0", name: "", handicap: undefined },
  ]);
  const [savedPlayers, setSavedPlayers] = useState<SavedPlayer[]>([]);
  // Course candidates for voice disambiguation (favorites + recent — localStorage reads).
  // Populated once on mount; used in handleVoiceSetup to fuzzy-match the course
  // name returned by the realtime tool call against known courses.
  const [knownCourseNames, setKnownCourseNames] = useState<string[]>([]);
  // Which group row the player sheet edits; null = multi-add mode ("+ Add"),
  // where several people can be added without the sheet closing.
  const [playerPickerIndex, setPlayerPickerIndex] = useState<number | null>(0);
  const [multiAddName, setMultiAddName] = useState("");
  // Which player row is the owner ("you"). Defaults to the first; the owner can
  // re-assign it in the player editor. Drives ownerPlayerId on the round so the
  // owner's own scores power home/profile stats even when not first-listed.
  const [ownerIndex, setOwnerIndex] = useState(0);

  // --- Round options ---
  const [tee, setTee] = useState<TeeId>("white");
  const [holes, setHoles] = useState(18);
  const [walking, setWalking] = useState(true);
  // Selected formats with per-format stakes — several side games can run at
  // once (owner request 2026-07-01: multi-select, define bets in the sheet).
  const [selectedGames, setSelectedGames] = useState<{ id: GameId; stake: string }[]>([
    { id: "stroke", stake: "$5" },
  ]);
  const [sides, setSides] = useState<SideId[]>([]);

  // --- UI ---
  const [picker, setPicker] = useState<Picker>(null);
  const [showVoiceSetup, setShowVoiceSetup] = useState(false);
  const [showCourseSearch, setShowCourseSearch] = useState(false);

  // Conversation surface (populated after voice setup completes)
  const [voiceSummary, setVoiceSummary] = useState<string | null>(null);
  const [caddyReply, setCaddyReply] = useState<string | null>(null);
  const [postVoiceChips, setPostVoiceChips] = useState<string[]>([]);

  // --- Create state ---
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Load saved players: try API, fall back to localStorage cache.
  useEffect(() => {
    getPlayers()
      .then(setSavedPlayers)
      .catch(() => {
        setSavedPlayers(getSavedPlayers());
      });
  }, []);

  // Build the course candidate set for voice disambiguation from localStorage.
  // Favorites + recently-played — both are synchronous reads, no network needed.
  // Runs once; the set doesn't need to update mid-session.
  useEffect(() => {
    const favNames = listFavorites().map((f) => f.name);
    const recentNames = getRecentCourses().map((c) => c.name);
    const unique = [...new Set([...favNames, ...recentNames])].filter(Boolean);
    setKnownCourseNames(unique);
  }, []);

  // Prefill course from /courses/view "Start a round here" handoff (one-shot).
  // takeCourseForRound() reads + clears sessionStorage so it never fires again
  // or fights a later voice/manual course selection.
  useEffect(() => {
    const c = takeCourseForRound();
    if (c) setSelectedCourse(c);
  }, []);

  // Preload the voice setup session on the golfer's FIRST touch of the page —
  // NOT on bare mount (that would bill a connection for someone who never
  // opens the mic sheet, e.g. a bouncer). By the time they actually tap the
  // mic button, the session is usually already warm — "Connecting…" becomes
  // rare instead of the default. See lib/voice/warm-session.ts.
  useEffect(() => {
    let fired = false;
    const trigger = () => {
      if (fired) return;
      fired = true;
      warmSession.warm({ kind: "setup", personalityId: "classic" });
    };
    const addOpts: AddEventListenerOptions = { once: true, passive: true };
    window.addEventListener("pointerdown", trigger, addOpts);
    window.addEventListener("keydown", trigger, addOpts);
    window.addEventListener("focusin", trigger, addOpts);
    return () => {
      // `once` means the browser already removes these after the first fire —
      // this cleanup only matters for the unmount-before-any-interaction case.
      // `capture` (the only field removeEventListener matches on) defaults to
      // false either way, so no options object is needed here.
      window.removeEventListener("pointerdown", trigger);
      window.removeEventListener("keydown", trigger);
      window.removeEventListener("focusin", trigger);
      // Leaving the page without ever opening the sheet — don't leave a warm
      // (never-adopted) session running in the background.
      warmSession.teardown();
    };
  }, []);

  // --- Voice setup callback ---
  const handleVoiceSetup = useCallback(
    ({
      courseName,
      playerNames,
      teeName,
    }: {
      courseName: string;
      playerNames: string[];
      teeName?: string;
    }) => {
      setShowVoiceSetup(false);

      // Populate course — fuzzy-match the AI-returned name against the user's
      // saved / recently-played courses so mis-transcriptions like
      // "Valley Links" (heard) → "Bally Links" (real saved course) are corrected.
      // Threshold 0.74 matches pipeline.ts. Falls back to the raw name when the
      // candidate set is empty or no match clears the threshold.
      if (courseName) {
        const resolvedCourseName =
          knownCourseNames.length > 0
            ? (fuzzyBestMatch(courseName, knownCourseNames, 0.74).match ?? courseName)
            : courseName;
        setSelectedCourse({
          id: resolvedCourseName.toLowerCase().replace(/\s+/g, "-"),
          name: resolvedCourseName,
        });
      }

      // Populate players — link to saved players where possible using fuzzy +
      // phonetic matching (handles transcription drift like "Dipak" → "Deepak").
      if (playerNames.length > 0) {
        const matched = matchPlayerNames(playerNames, savedPlayers);
        setPlayers(
          matched.map(({ name, player }, i) =>
            player
              ? { id: player.id, name: player.name, handicap: player.handicap }
              : { id: `custom-player-${i}`, name, handicap: undefined }
          )
        );
      }

      // Map spoken tee name to TeeId
      if (teeName) {
        const lower = teeName.toLowerCase();
        if (lower.includes("black")) setTee("black");
        else if (lower.includes("blue")) setTee("blue");
        else if (lower.includes("gold") || lower.includes("yellow")) setTee("gold");
        else if (lower.includes("red")) setTee("red");
        else setTee("white"); // default / "whites"
      }

      // Build conversation surface summary
      const parts: string[] = [];
      if (courseName) parts.push(courseName);
      if (playerNames.length > 0) parts.push(playerNames.join(", "));
      if (teeName) parts.push(`${teeName} tees`);
      const summary = parts.join(", ");
      setVoiceSummary(summary || "voice setup");
      setCaddyReply(
        `Got it${summary ? ` — ${summary}` : ""}. Anything else, or ready to tee off?`
      );
      setPostVoiceChips(["Change game", "Different tees", "Add a player"]);
    },
    [savedPlayers, knownCourseNames]
  );

  // Quick-reply chip actions (post-voice)
  const handleQuickReply = (phrase: string) => {
    if (/change game/i.test(phrase)) {
      setPicker("game");
    } else if (/tees/i.test(phrase)) {
      setPicker("tee");
    } else if (/add a player/i.test(phrase)) {
      const newIdx = players.length;
      setPlayers((prev) => [
        ...prev,
        { id: `custom-player-${prev.length}`, name: "", handicap: undefined },
      ]);
      setPlayerPickerIndex(newIdx);
      setPicker("player");
    }
  };

  // --- Tee off ---
  const handleTeeOff = async () => {
    if (isCreating) return;

    const validPlayers = players.filter((p) => p.name.trim());
    if (validPlayers.length === 0) return;

    setIsCreating(true);
    setCreateError(null);

    // Resolve player IDs — custom slots get a real UUID. Track the owner's
    // final id as we go (ownerSlot is the same object reference in validPlayers).
    const ownerSlot = players[ownerIndex];
    let ownerResolvedId: string | undefined;
    const roundPlayers: Player[] = validPlayers.map((p) => {
      const newId = p.id.startsWith("custom-player-") ? crypto.randomUUID() : p.id;
      if (p === ownerSlot) ownerResolvedId = newId;
      return { id: newId, name: p.name.trim(), handicap: p.handicap };
    });

    // De-dup by id: if voice returns the same name twice both mapping to the same saved
    // player id, keep only the first occurrence to avoid duplicate round_players on backend.
    const deduped = roundPlayers.filter(
      (p, idx, arr) => arr.findIndex((q) => q.id === p.id) === idx
    );

    // The owner's player id: their resolved id if it survived de-dup, else the
    // first player (matches the backend default and getOwnerPlayerId fallback).
    const ownerPlayerId =
      ownerResolvedId && deduped.some((p) => p.id === ownerResolvedId)
        ? ownerResolvedId
        : deduped[0]?.id;

    // Build default course hole layout (scoring-course data; GolfAPI holes added later).
    const courseName = selectedCourse?.name ?? "New Round";
    const defaultCourse = createDefaultCourse(courseName);
    const holeList: HoleInfo[] =
      holes === 9 ? defaultCourse.holes.slice(0, 9) : defaultCourse.holes;
    // For the backend courseId, use a stable slug from GolfAPI id or a generated UUID.
    const courseId = selectedCourse?.id ? String(selectedCourse.id) : defaultCourse.id;
    const teeLabel =
      TEE_OPTIONS.find((t) => t.id === tee)?.l.split(" · ")[0] ?? "White";

    // Build game objects for the round (sent to backend; backend assigns roundId).
    // One per selected format, each with its own stake.
    const gameObjects: Game[] = [];
    for (const sel of selectedGames) {
      const gameFormat = GAME_ID_TO_FORMAT[sel.id];
      if (!gameFormat) continue; // "none" has no engine format
      const stakeValue = parseFloat(sel.stake.replace("$", "")) || 0;
      gameObjects.push({
        id: crypto.randomUUID(),
        roundId: "", // placeholder — backend assigns its own roundId FK
        format: gameFormat,
        name: GAME_OPTIONS.find((g) => g.id === sel.id)?.l ?? sel.id,
        playerIds: deduped.map((p) => p.id),
        settings: { pointValue: stakeValue > 0 ? stakeValue : undefined },
      });
    }

    try {
      // POST /api/rounds — the backend assigns its own UUID as the round id.
      const created = await createRound({
        courseId,
        courseName,
        // Course anchor: lets the round screen render the satellite map directly
        // instead of re-resolving the course by name (paper-drawing fallback bug).
        ...anchorFromSelectedCourse(selectedCourse),
        teeName: teeLabel,
        players: deduped,
        ownerPlayerId,
        holes: holeList,
        games: gameObjects,
      });

      // Write-through to localStorage so the scoring screen can read it offline.
      localSaveRound(created);

      // Navigate using the SERVER-RETURNED id (not the client placeholder).
      router.push(roundHref(created.id));
    } catch (e) {
      // fetchAPI throws a generic Error (not TypeError) for 4xx / 5xx responses.
      // Only a TypeError signals a genuine network / offline failure — safe to fabricate
      // a local round and navigate. HTTP errors must surface so the user can act.
      if (!(e instanceof TypeError)) {
        const msg = e instanceof Error ? e.message : "Failed to create round.";
        setCreateError(
          msg.length > 120 ? "Server error — check your connection and try again." : msg
        );
        setIsCreating(false);
        return;
      }

      console.error("[round/new] createRound API failed (offline) — using local fallback:", e);

      // Offline fallback: generate a client-side UUID and save locally only.
      const fallbackId = crypto.randomUUID();
      const fallbackRound: Round = {
        id: fallbackId,
        courseId,
        courseName,
        teeName: teeLabel,
        date: new Date().toISOString(),
        players: deduped,
        scores: [],
        holes: holeList,
        games: gameObjects,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      localSaveRound(fallbackRound);
      router.push(roundHref(fallbackId));
    } finally {
      setIsCreating(false);
    }
  };

  // Derived readiness: at least one named player.
  const isReady = players.some((p) => p.name.trim().length > 0);

  const gameLabel =
    selectedGames.length === 0
      ? "No stakes"
      : selectedGames
          .map((sel) => GAME_OPTIONS.find((g) => g.id === sel.id)?.l ?? sel.id)
          .join(" + ");
  const teeLabel = TEE_OPTIONS.find((t) => t.id === tee)?.l.split(" · ")[0] ?? "White";
  const teeColor = TEE_OPTIONS.find((t) => t.id === tee)?.c ?? "#eae5d6";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      style={{
        position: "relative",
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
          position: "relative",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ flex: 1, overflowY: "auto" }}>
          {/* ── Header ── */}
          <div style={{ padding: "max(14px, env(safe-area-inset-top)) 22px 10px" }}>
            <button
              onClick={() => router.push("/")}
              style={{
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.4,
                color: T.pencil,
                textTransform: "uppercase",
                display: "flex",
                alignItems: "center",
                gap: 4,
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 11 }}>{"←"}</span> Back
            </button>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: "uppercase",
              }}
            >
              New · Round
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: "italic",
                fontSize: 30,
                letterSpacing: -0.6,
                color: T.ink,
                lineHeight: 1.05,
                marginTop: 4,
              }}
            >
              Tell me what you&rsquo;re playing.
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontSize: 14,
                color: T.pencil,
                letterSpacing: -0.1,
                marginTop: 3,
                lineHeight: 1.3,
              }}
            >
              Course, group, stakes &mdash; any order, one sentence, or pick below.
            </div>
          </div>

          {/* ── Conversation surface (shown after voice setup) ── */}
          <AnimatePresence>
            {(voiceSummary || caddyReply) && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                style={{ padding: "8px 22px 12px" }}
              >
                {/* YOU bubble */}
                {voiceSummary && (
                  <div
                    style={{
                      padding: "12px 14px",
                      borderRadius: 14,
                      background: T.paperDeep,
                      border: `1px solid ${T.hairline}`,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 8.5,
                        letterSpacing: 1.4,
                        color: T.pencil,
                        textTransform: "uppercase",
                        marginBottom: 4,
                      }}
                    >
                      You · said
                    </div>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 17,
                        lineHeight: 1.3,
                        letterSpacing: -0.2,
                        color: T.ink,
                      }}
                    >
                      <span style={{ color: T.pencil, fontSize: 15 }}>&ldquo;</span>
                      {voiceSummary}
                    </div>
                  </div>
                )}

                {/* CADDY bubble */}
                {caddyReply && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "12px 14px",
                      borderRadius: 14,
                      background: T.ink,
                      color: T.paper,
                      display: "flex",
                      gap: 10,
                    }}
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 99,
                        background: "rgba(244,241,234,0.12)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 12,
                        flexShrink: 0,
                      }}
                    >
                      {caddy.initial}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8.5,
                          letterSpacing: 1.4,
                          color: "rgba(244,241,234,0.5)",
                          textTransform: "uppercase",
                        }}
                      >
                        {caddy.name}
                      </div>
                      <div
                        style={{
                          fontFamily: T.serif,
                          fontStyle: "italic",
                          fontSize: 15,
                          lineHeight: 1.35,
                          letterSpacing: -0.1,
                          marginTop: 1,
                        }}
                      >
                        {caddyReply}
                      </div>
                    </div>
                  </div>
                )}

                {/* Post-voice quick reply chips */}
                {postVoiceChips.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {postVoiceChips.map((q) => (
                      <button
                        key={q}
                        onClick={() => handleQuickReply(q)}
                        style={{
                          padding: "9px 13px",
                          borderRadius: 99,
                          border: `1px solid ${accent}`,
                          background: "transparent",
                          color: accent,
                          fontFamily: T.sans,
                          fontSize: 12,
                          fontWeight: 500,
                          letterSpacing: -0.1,
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          minHeight: 38,
                        }}
                      >
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                          <circle cx="4" cy="4" r="1.8" fill={accent} />
                        </svg>
                        {q}
                      </button>
                    ))}
                    <button
                      onClick={() => setShowVoiceSetup(true)}
                      style={{
                        padding: "9px 13px",
                        borderRadius: 99,
                        border: `1px dashed ${T.hairline}`,
                        background: "transparent",
                        color: T.pencil,
                        fontFamily: T.sans,
                        fontSize: 12,
                        letterSpacing: -0.1,
                        cursor: "pointer",
                        minHeight: 38,
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      Say something else&hellip;
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Error banner */}
          {createError && (
            <div
              style={{
                margin: "0 22px 8px",
                padding: "10px 14px",
                borderRadius: 10,
                background: "rgba(184,74,58,0.08)",
                border: "1px solid rgba(184,74,58,0.2)",
                fontFamily: T.serif,
                fontSize: 13,
                color: "#b84a3a",
                lineHeight: 1.4,
              }}
            >
              {createError}
            </div>
          )}

          {/* ── Course card ── */}
          <div style={{ padding: "10px 22px 6px" }}>
            <button
              onClick={() => setShowCourseSearch(true)}
              style={{
                width: "100%",
                border: `1px solid ${T.hairline}`,
                borderRadius: 14,
                padding: 14,
                background: selectedCourse ? T.paperDeep : T.paper,
                cursor: "pointer",
                textAlign: "left",
                transition: "background 0.3s",
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
                  Course
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

              {selectedCourse ? (
                <>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 26,
                      letterSpacing: -0.5,
                      color: T.ink,
                      lineHeight: 1.05,
                      marginTop: 4,
                    }}
                  >
                    {selectedCourse.name}
                  </div>
                  {selectedCourse.location && (
                    <div
                      style={{
                        fontFamily: T.sans,
                        fontSize: 12,
                        color: T.pencil,
                        marginTop: 3,
                        letterSpacing: -0.1,
                      }}
                    >
                      {selectedCourse.location}
                    </div>
                  )}
                  {selectedCourse.par && (
                    <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
                      <MiniStat k="Par" v={selectedCourse.par} />
                      {selectedCourse.holes && <MiniStat k="Holes" v={selectedCourse.holes} />}
                    </div>
                  )}
                </>
              ) : (
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 19,
                    color: T.pencilSoft,
                    marginTop: 3,
                  }}
                >
                  Not set &mdash; tap to search or speak
                </div>
              )}
            </button>
          </div>

          {/* ── Players card ── */}
          <div style={{ padding: "6px 22px 10px" }}>
            <div
              style={{
                border: `1px solid ${T.hairline}`,
                borderRadius: 14,
                padding: 12,
                background: T.paper,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 6,
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
                  Group · {players.filter((p) => p.name.trim()).length || "—"}
                </div>
                <button
                  onClick={() => {
                    // Multi-add mode: one sheet, several people (owner request
                    // 2026-07-01 — no more one-by-one).
                    setPlayerPickerIndex(null);
                    setMultiAddName("");
                    setPicker("player");
                  }}
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.2,
                    color: T.pencil,
                    textTransform: "uppercase",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    // ≥44pt touch target
                    minHeight: 44,
                    minWidth: 44,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    padding: "0 4px",
                  }}
                >
                  + Add
                </button>
              </div>

              {players.map((p, i) => (
                <motion.button
                  key={`player-slot-${i}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  onClick={() => {
                    setPlayerPickerIndex(i);
                    setPicker("player");
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 0",
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
                  }}
                >
                  {/* Avatar initial */}
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 99,
                      background: p.name ? T.ink : T.hairline,
                      color: p.name ? T.paper : T.pencilSoft,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 13,
                      flexShrink: 0,
                      transition: "background 0.25s",
                    }}
                  >
                    {p.name ? p.name[0].toUpperCase() : "?"}
                  </div>

                  {/* Name */}
                  <div
                    style={{
                      flex: 1,
                      fontFamily: T.sans,
                      fontSize: 14,
                      color: p.name ? T.ink : T.pencilSoft,
                      fontWeight: 500,
                      letterSpacing: -0.1,
                    }}
                  >
                    {p.name || "Tap to set name…"}
                  </div>

                  {/* "you" marker — the owner whose scores drive home/profile stats */}
                  {i === ownerIndex && p.name.trim() !== "" && (
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 13,
                        color: T.pencil,
                        letterSpacing: 0.2,
                        flexShrink: 0,
                      }}
                    >
                      you
                    </div>
                  )}

                  {/* Handicap */}
                  {p.handicap !== undefined && (
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.2,
                        color: T.pencilSoft,
                        textTransform: "uppercase",
                      }}
                    >
                      Hcp{" "}
                      <span
                        style={{
                          fontFamily: T.serif,
                          fontSize: 14,
                          color: T.ink,
                          marginLeft: 2,
                        }}
                      >
                        {p.handicap}
                      </span>
                    </div>
                  )}

                  {/* Edit chevron */}
                  <div style={{ fontFamily: T.mono, fontSize: 10, color: T.pencil }}>
                    {"›"}
                  </div>
                </motion.button>
              ))}
            </div>
          </div>

          {/* ── Options — pickable rows ── */}
          <div style={{ padding: "10px 22px 10px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
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
                Or set it manually
              </div>
              <div style={{ flex: 1, height: 1, background: T.hairline }} />
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 11,
                  color: T.pencilSoft,
                  letterSpacing: -0.1,
                }}
              >
                anything here is askable by voice
              </div>
            </div>

            <PickerRow
              label="Holes"
              value={`${holes}`}
              hint={`“nine” / “eighteen”`}
              onClick={() => setPicker("holes")}
            />
            <PickerRow
              label="Tees"
              value={
                <span>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 99,
                      background: teeColor,
                      marginRight: 6,
                      border: `1px solid ${T.hairline}`,
                      verticalAlign: "middle",
                    }}
                  />
                  {teeLabel}
                </span>
              }
              hint={`“whites” / “play the blues”`}
              onClick={() => setPicker("tee")}
            />
            <PickerRow
              label="Transport"
              value={walking ? "Walking" : "Cart"}
              hint={`“walking” / “taking a cart”`}
              onClick={() => setWalking((w) => !w)}
            />
            <PickerRow
              label="Game"
              value={gameLabel}
              hint={`“skins at ten bucks”, “add a nassau”, “match play”`}
              accent={accent}
              onClick={() => setPicker("game")}
              emphasized
            />
            <PickerRow
              label="Side bets"
              value={
                sides.length
                  ? sides
                      .map((s) => SIDES.find((x) => x.id === s)?.l)
                      .filter(Boolean)
                      .join(" · ")
                  : "None"
              }
              hint={`“add a snake”, “greenies on par 3s”`}
              onClick={() => setPicker("sides")}
            />
          </div>

          <div style={{ height: 90 }} />
        </div>

        {/* ── Sticky footer ── */}
        <div
          style={{
            padding: "10px 22px 26px",
            background: `linear-gradient(to top, ${T.paper} 65%, rgba(0,0,0,0))`,
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexShrink: 0,
            position: "sticky",
            bottom: 0,
          }}
        >
          {/* Mic button — opens VoiceRoundSetup. order:2 places it on the RIGHT
              (after the Tee off CTA) while keeping DOM/reading order sensible. */}
          <div
            style={{
              order: 2,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
            }}
          >
            <button
              onClick={() => setShowVoiceSetup(true)}
              // Belt alongside the page-wide first-interaction listener above —
              // guarantees the mic's own tap always at least attempts a warm
              // preload even if some other trigger got swallowed.
              onPointerDown={() => warmSession.warm({ kind: "setup", personalityId: "classic" })}
              style={{
                position: "relative",
                width: 56,
                height: 56,
                borderRadius: 99,
                border: "none",
                background: T.ink,
                color: T.paper,
                // Accent ring for visual weight
                boxShadow: `0 0 0 3px ${accent}33, 0 8px 20px rgba(26,42,26,0.22)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
              aria-label="Set up round by voice"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <rect x="9" y="3" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0" />
                <path d="M12 18v3" />
              </svg>
            </button>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 7.5,
                letterSpacing: 1.3,
                color: T.pencilSoft,
                textTransform: "uppercase",
              }}
            >
              Speak
            </div>
          </div>

          {/* Tee off button + disabled hint */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
            <button
              onClick={handleTeeOff}
              disabled={!isReady || isCreating}
              style={{
                width: "100%",
                padding: "14px",
                borderRadius: 99,
                border: "none",
                background: isReady && !isCreating ? T.ink : T.pencilSoft,
                color: T.paper,
                cursor: isReady && !isCreating ? "pointer" : "not-allowed",
                fontFamily: T.sans,
                fontSize: 14,
                fontWeight: 500,
                letterSpacing: -0.1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                transition: "background 0.25s",
              }}
            >
              {isCreating ? (
                <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Creating&hellip;</span>
              ) : (
                <>
                  <span style={{ fontFamily: T.serif, fontStyle: "italic" }}>Tee off</span>
                  <span
                    style={{
                      fontFamily: T.mono,
                      fontSize: 10,
                      letterSpacing: 1.2,
                      opacity: 0.7,
                    }}
                  >
                    {"→"}
                  </span>
                </>
              )}
            </button>
            {!isReady && !isCreating && (
              <div
                style={{
                  textAlign: "center",
                  fontFamily: T.serif,
                  fontStyle: "italic",
                  fontSize: 12,
                  color: T.pencilSoft,
                  letterSpacing: -0.1,
                }}
              >
                Add a player above to start
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Picker bottom sheet ── */}
      <AnimatePresence>
        {picker && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setPicker(null)}
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                zIndex: 40,
              }}
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={T.springSoft}
              style={{
                position: "fixed",
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 41,
                background: T.paper,
                borderRadius: "20px 20px 0 0",
                padding: "12px 0 28px",
                maxHeight: "80vh",
                overflow: "hidden",
                boxShadow: "0 -20px 50px rgba(0,0,0,0.2)",
                display: "flex",
                flexDirection: "column",
                maxWidth: 420,
                margin: "0 auto",
              }}
            >
              {/* Drag handle */}
              <div
                style={{
                  width: 40,
                  height: 4,
                  borderRadius: 99,
                  background: T.hairline,
                  margin: "0 auto 10px",
                }}
              />

              {picker === "game" && (
                <GamePicker
                  accent={accent}
                  selected={selectedGames}
                  onToggle={(id: GameId) => {
                    haptic("light");
                    setSelectedGames((prev) => {
                      if (prev.some((s) => s.id === id)) {
                        return prev.filter((s) => s.id !== id);
                      }
                      const withDefault = {
                        id,
                        stake: id === "nassau" ? "$20" : "$5",
                      };
                      // "No stakes" is exclusive of everything else.
                      if (id === "none") return [withDefault];
                      return [...prev.filter((s) => s.id !== "none"), withDefault];
                    });
                  }}
                  onStakeFor={(id: GameId, stake: string) => {
                    setSelectedGames((prev) =>
                      prev.map((s) => (s.id === id ? { ...s, stake } : s))
                    );
                  }}
                  onDone={() => setPicker(null)}
                />
              )}

              {picker === "tee" && (
                <TeePicker
                  current={tee}
                  onPick={(id: TeeId) => {
                    setTee(id);
                    setPicker(null);
                  }}
                />
              )}

              {picker === "sides" && (
                <SidesPicker
                  accent={accent}
                  current={sides}
                  onToggle={(id: SideId) =>
                    setSides((s) =>
                      s.includes(id) ? s.filter((x) => x !== id) : [...s, id]
                    )
                  }
                  onDone={() => setPicker(null)}
                />
              )}

              {picker === "holes" && (
                <HolesPicker
                  current={holes}
                  onPick={(n: number) => {
                    setHoles(n);
                    setPicker(null);
                  }}
                />
              )}

              {/* Multi-add player sheet — tap saved players to add/remove several
                  in one visit; type to add anyone new. Stays open until Done. */}
              {picker === "player" && playerPickerIndex === null && (
                <div style={{ padding: "4px 22px 0", flex: 1, overflow: "auto" }}>
                  <div style={{ marginBottom: 14 }}>
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.5,
                        color: T.pencil,
                        textTransform: "uppercase",
                        marginBottom: 2,
                      }}
                    >
                      Group · {players.filter((p) => p.name.trim() !== "").length}
                    </div>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 22,
                        color: T.ink,
                        letterSpacing: -0.3,
                      }}
                    >
                      Add players.
                    </div>
                  </div>

                  {/* New name — add anyone not in the saved list, stays open */}
                  <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                    <input
                      value={multiAddName}
                      onChange={(e) => setMultiAddName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && multiAddName.trim() !== "") {
                          const name = multiAddName.trim();
                          setPlayers((prev) => [
                            ...prev,
                            { id: `custom-player-${prev.length}`, name, handicap: undefined },
                          ]);
                          setMultiAddName("");
                        }
                      }}
                      placeholder="New player name"
                      style={{
                        flex: 1,
                        padding: "11px 14px",
                        borderRadius: 99,
                        border: `1px solid ${T.hairline}`,
                        background: "transparent",
                        color: T.ink,
                        fontFamily: T.sans,
                        fontSize: 14,
                        outline: "none",
                      }}
                    />
                    <button
                      onClick={() => {
                        const name = multiAddName.trim();
                        if (name === "") return;
                        setPlayers((prev) => [
                          ...prev,
                          { id: `custom-player-${prev.length}`, name, handicap: undefined },
                        ]);
                        setMultiAddName("");
                      }}
                      style={{
                        flexShrink: 0,
                        padding: "0 18px",
                        borderRadius: 99,
                        border: `1px solid ${multiAddName.trim() ? accent : T.hairline}`,
                        background: "transparent",
                        color: multiAddName.trim() ? accent : T.pencilSoft,
                        fontFamily: T.mono,
                        fontSize: 10,
                        letterSpacing: 1.2,
                        textTransform: "uppercase",
                        cursor: "pointer",
                      }}
                    >
                      Add
                    </button>
                  </div>

                  {/* Saved players — tap to add, tap again to remove; sheet stays open */}
                  {savedPlayers.map((sp) => {
                    const inGroup = players.some((p) => p.id === sp.id);
                    return (
                      <button
                        key={sp.id}
                        onClick={() => {
                          haptic("light");
                          if (inGroup) {
                            const idx = players.findIndex((p) => p.id === sp.id);
                            if (idx === ownerIndex) return; // never remove "you" here
                            setPlayers((prev) => prev.filter((p) => p.id !== sp.id));
                            setOwnerIndex((prev) => (idx < prev ? prev - 1 : prev));
                          } else {
                            setPlayers((prev) => [
                              ...prev,
                              { id: sp.id, name: sp.name, handicap: sp.handicap },
                            ]);
                          }
                        }}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 0",
                          borderTop: `1px dashed ${T.hairline}`,
                          background: "transparent",
                          borderLeft: "none",
                          borderRight: "none",
                          borderBottom: "none",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 99,
                            background: inGroup ? T.ink : T.hairline,
                            color: inGroup ? T.paper : T.pencilSoft,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontFamily: T.serif,
                            fontStyle: "italic",
                            fontSize: 13,
                            flexShrink: 0,
                            transition: "background 0.25s",
                          }}
                        >
                          {sp.name[0]?.toUpperCase() ?? "?"}
                        </div>
                        <div
                          style={{
                            flex: 1,
                            fontFamily: T.sans,
                            fontSize: 14,
                            color: T.ink,
                            fontWeight: 500,
                            letterSpacing: -0.1,
                          }}
                        >
                          {sp.name}
                        </div>
                        {sp.handicap !== undefined && (
                          <div
                            style={{
                              fontFamily: T.mono,
                              fontSize: 9,
                              letterSpacing: 1.2,
                              color: T.pencilSoft,
                              textTransform: "uppercase",
                            }}
                          >
                            hcp {sp.handicap}
                          </div>
                        )}
                        <div
                          style={{
                            fontFamily: T.serif,
                            fontStyle: "italic",
                            fontSize: 13,
                            color: inGroup ? accent : T.pencilSoft,
                            flexShrink: 0,
                            width: 44,
                            textAlign: "right",
                          }}
                        >
                          {inGroup ? "✓ added" : "add"}
                        </div>
                      </button>
                    );
                  })}

                  {/* Done */}
                  <button
                    onClick={() => setPicker(null)}
                    style={{
                      marginTop: 16,
                      marginBottom: 20,
                      width: "100%",
                      padding: "14px",
                      borderRadius: 99,
                      border: "none",
                      background: accent,
                      color: T.paper,
                      fontFamily: T.sans,
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: "pointer",
                      letterSpacing: -0.1,
                    }}
                  >
                    Done
                  </button>
                </div>
              )}

              {/* Player picker — light paper sheet hosting light-themed PlayerAutocomplete */}
              {picker === "player" && playerPickerIndex !== null && (
                <div style={{ padding: "4px 22px 0", flex: 1, overflow: "auto" }}>
                  {/* Header */}
                  <div style={{ marginBottom: 14 }}>
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.5,
                        color: T.pencil,
                        textTransform: "uppercase",
                        marginBottom: 2,
                      }}
                    >
                      Player {playerPickerIndex + 1}
                    </div>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontStyle: "italic",
                        fontSize: 22,
                        color: T.ink,
                        letterSpacing: -0.3,
                      }}
                    >
                      Who&rsquo;s playing?
                    </div>
                  </div>

                  {/* "This is me" — marks this player as the owner (drives stats).
                      Placed ABOVE the autocomplete so the inline suggestion row
                      can't push it off the sheet while typing a new name. */}
                  <button
                    onClick={() => setOwnerIndex(playerPickerIndex)}
                    style={{
                      marginBottom: 12,
                      width: "100%",
                      padding: "11px",
                      borderRadius: 99,
                      border: `1px solid ${
                        ownerIndex === playerPickerIndex ? accent : T.hairline
                      }`,
                      background:
                        ownerIndex === playerPickerIndex ? `${accent}14` : "transparent",
                      color: ownerIndex === playerPickerIndex ? accent : T.pencil,
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 13,
                      letterSpacing: 0.2,
                      cursor: "pointer",
                      transition: "all 0.2s",
                    }}
                  >
                    {ownerIndex === playerPickerIndex ? "✓ this is me" : "this is me"}
                  </button>

                  {/* PlayerAutocomplete — designed for dark backgrounds */}
                  <PlayerAutocomplete
                    value={
                      players[playerPickerIndex] ?? {
                        id: `custom-player-${playerPickerIndex}`,
                        name: "",
                      }
                    }
                    index={playerPickerIndex}
                    savedPlayers={savedPlayers}
                    selectedIds={players.map((p) => p.id)}
                    placeholder="Name or search saved players"
                    onChange={(updated) => {
                      setPlayers((prev) => {
                        const next = [...prev];
                        next[playerPickerIndex] = updated;
                        return next;
                      });
                      // Auto-close when a saved player is selected by click/enter.
                      if (savedPlayers.some((sp) => sp.id === updated.id)) {
                        setPicker(null);
                      }
                    }}
                    onRemove={
                      players.length > 1
                        ? () => {
                            setPlayers((prev) =>
                              prev.filter((_, i) => i !== playerPickerIndex)
                            );
                            // Keep ownerIndex pointing at the right row after removal.
                            setOwnerIndex((prev) => {
                              if (playerPickerIndex === prev) return 0; // removed the owner
                              if (playerPickerIndex < prev) return prev - 1; // rows shifted up
                              return prev;
                            });
                            setPicker(null);
                          }
                        : undefined
                    }
                    canRemove={players.length > 1}
                  />

                  {/* Done button */}
                  <button
                    onClick={() => setPicker(null)}
                    style={{
                      marginTop: 16,
                      width: "100%",
                      padding: "14px",
                      borderRadius: 99,
                      border: "none",
                      background: accent,
                      color: T.paper,
                      fontFamily: T.sans,
                      fontSize: 14,
                      fontWeight: 500,
                      cursor: "pointer",
                      letterSpacing: -0.1,
                    }}
                  >
                    Done
                  </button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── Voice setup overlay (Realtime conversational caddie) ──
           The sheet itself mounts ONLY while open, but a session may already be
           pre-WARMED in the background (see the first-interaction trigger above)
           before that happens. That warm session's mic is structurally withheld
           — no getUserMedia, no track, transcript events dropped — until
           VoiceRoundSetupRealtime's start() calls attachMic() right here at
           open, so it can never hallucinate a phantom transcript from live
           silence the way the previously-reverted mic-live shortcut did. */}
      <AnimatePresence>
        {showVoiceSetup && (
          <VoiceRoundSetupRealtime
            onSetupRound={handleVoiceSetup}
            onClose={() => setShowVoiceSetup(false)}
            autoStart
          />
        )}
      </AnimatePresence>

      {/* ── CourseSearch overlay ── */}
      <AnimatePresence>
        {showCourseSearch && (
          <CourseSearch
            onSelectCourse={(course) => {
              setSelectedCourse(course);
              setShowCourseSearch(false);
            }}
            onClose={() => setShowCourseSearch(false)}
            onVoiceSearch={() => {
              // Realtime voice setup already resolves a course by name —
              // hand off to it instead of building a separate voice-search path.
              setShowCourseSearch(false);
              setShowVoiceSetup(true);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components (yardage-book design — unchanged from original)
// ---------------------------------------------------------------------------

function PickerRow({
  label,
  value,
  hint,
  onClick,
  accent,
  emphasized,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  onClick?: () => void;
  accent?: string;
  emphasized?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        padding: "12px 0",
        background: "transparent",
        border: "none",
        borderTop: `1px dashed ${T.hairline}`,
        cursor: "pointer",
        textAlign: "left",
        display: "grid",
        gridTemplateColumns: "82px 1fr auto",
        gap: 10,
        alignItems: "center",
      }}
    >
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1.3,
          color: T.pencilSoft,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: T.sans,
            fontSize: 14,
            fontWeight: 500,
            color: emphasized && accent ? accent : T.ink,
            letterSpacing: -0.1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {value}
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 11.5,
            color: T.pencilSoft,
            letterSpacing: -0.1,
            marginTop: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {hint}
        </div>
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 10, color: T.pencil }}>{"›"}</div>
    </button>
  );
}

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
          fontSize: 18,
          color: T.ink,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
        }}
      >
        {v}
      </div>
    </div>
  );
}

function GamePicker({
  accent,
  selected,
  onToggle,
  onStakeFor,
  onDone,
}: {
  accent: string;
  selected: { id: GameId; stake: string }[];
  onToggle: (g: GameId) => void;
  onStakeFor: (g: GameId, s: string) => void;
  onDone: () => void;
}) {
  const stakes = ["$2", "$5", "$10", "$20"];
  return (
    <div style={{ overflow: "auto", padding: "0 0 10px" }}>
      <div style={{ padding: "0 22px 4px" }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9.5,
            letterSpacing: 1.5,
            color: T.pencil,
            textTransform: "uppercase",
          }}
        >
          Pick your games
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 22,
            color: T.ink,
            letterSpacing: -0.3,
          }}
        >
          The formats
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontSize: 12.5,
            color: T.pencil,
            letterSpacing: -0.1,
            marginTop: 2,
          }}
        >
          Stack several &mdash; or say:{" "}
          <span style={{ color: accent }}>&ldquo;skins at ten&rdquo;</span>,{" "}
          <span style={{ color: accent }}>&ldquo;wolf, no money&rdquo;</span>
        </div>
      </div>
      <div style={{ padding: "8px 14px 0" }}>
        {GAME_OPTIONS.map((g) => {
          const sel = selected.find((s) => s.id === g.id);
          const active = sel !== undefined;
          const takesStake = g.id !== "none";
          return (
            <div
              key={g.id}
              role="button"
              tabIndex={0}
              onClick={() => onToggle(g.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onToggle(g.id);
              }}
              style={{
                width: "100%",
                padding: "12px",
                marginBottom: 4,
                borderRadius: 12,
                border: `1px solid ${active ? T.ink : "transparent"}`,
                background: active ? T.paperDeep : "transparent",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        fontFamily: T.serif,
                        fontSize: 17,
                        color: T.ink,
                        letterSpacing: -0.2,
                      }}
                    >
                      {g.l}
                    </span>
                    {g.tag && (
                      <span
                        style={{
                          fontFamily: T.mono,
                          fontSize: 8,
                          letterSpacing: 1,
                          color: T.pencil,
                          border: `1px solid ${T.hairline}`,
                          padding: "1px 5px",
                          borderRadius: 3,
                          textTransform: "uppercase",
                        }}
                      >
                        {g.tag}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: "italic",
                      fontSize: 12.5,
                      color: T.pencil,
                      letterSpacing: -0.1,
                      marginTop: 1,
                    }}
                  >
                    {g.sub}
                  </div>
                </div>
                {active && (
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 99,
                      background: accent,
                      color: T.paper,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontFamily: T.mono,
                    }}
                  >
                    {"✓"}
                  </div>
                )}
              </div>

              {/* Per-format stake — inline in the selected card, so several
                  games and their bets are defined in one visit. */}
              {active && takesStake && sel && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  style={{
                    display: "flex",
                    gap: 5,
                    marginTop: 10,
                    paddingTop: 10,
                    borderTop: `1px dashed ${T.hairline}`,
                    alignItems: "center",
                  }}
                >
                  {stakes.map((s) => (
                    <button
                      key={s}
                      onClick={() => onStakeFor(g.id, s)}
                      style={{
                        flex: 1,
                        padding: "7px 0",
                        borderRadius: 10,
                        border: `1px solid ${sel.stake === s ? T.ink : T.hairline}`,
                        background: sel.stake === s ? T.ink : "transparent",
                        color: sel.stake === s ? T.paper : T.ink,
                        fontFamily: T.serif,
                        fontSize: 14,
                        cursor: "pointer",
                      }}
                    >
                      {s}
                    </button>
                  ))}
                  <input
                    value={stakes.includes(sel.stake) ? "" : sel.stake}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[^0-9$]/g, "");
                      onStakeFor(g.id, raw.startsWith("$") ? raw : `$${raw}`);
                    }}
                    placeholder="$…"
                    inputMode="numeric"
                    style={{
                      width: 52,
                      padding: "7px 6px",
                      borderRadius: 10,
                      border: `1px solid ${
                        !stakes.includes(sel.stake) && sel.stake !== ""
                          ? T.ink
                          : T.hairline
                      }`,
                      background: "transparent",
                      color: T.ink,
                      fontFamily: T.serif,
                      fontSize: 14,
                      textAlign: "center",
                      outline: "none",
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Done — multi-select never auto-closes */}
      <div style={{ padding: "10px 22px 0" }}>
        <button
          onClick={onDone}
          style={{
            width: "100%",
            padding: "14px",
            borderRadius: 99,
            border: "none",
            background: accent,
            color: T.paper,
            fontFamily: T.sans,
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
            letterSpacing: -0.1,
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function TeePicker({
  current,
  onPick,
}: {
  current: TeeId;
  onPick: (t: TeeId) => void;
}) {
  return (
    <div style={{ overflow: "auto", padding: "0 0 10px" }}>
      <div style={{ padding: "0 22px 4px" }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9.5,
            letterSpacing: 1.5,
            color: T.pencil,
            textTransform: "uppercase",
          }}
        >
          Tees
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 22,
            color: T.ink,
            letterSpacing: -0.3,
          }}
        >
          Which set today?
        </div>
      </div>
      <div style={{ padding: "8px 14px 0" }}>
        {TEE_OPTIONS.map((t) => {
          const active = current === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onPick(t.id)}
              style={{
                width: "100%",
                padding: "12px",
                marginBottom: 4,
                borderRadius: 12,
                border: `1px solid ${active ? T.ink : "transparent"}`,
                background: active ? T.paperDeep : "transparent",
                cursor: "pointer",
                textAlign: "left",
                display: "grid",
                gridTemplateColumns: "20px 1fr auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 99,
                  background: t.c,
                  border: `1px solid ${T.hairline}`,
                }}
              />
              <div
                style={{
                  fontFamily: T.serif,
                  fontSize: 16,
                  color: T.ink,
                  letterSpacing: -0.2,
                }}
              >
                {t.l}
              </div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  letterSpacing: 1.1,
                  color: T.pencilSoft,
                }}
              >
                {t.yds} y
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SidesPicker({
  accent,
  current,
  onToggle,
  onDone,
}: {
  accent: string;
  current: SideId[];
  onToggle: (id: SideId) => void;
  onDone: () => void;
}) {
  return (
    <div style={{ overflow: "auto", padding: "0 0 10px" }}>
      <div style={{ padding: "0 22px 4px" }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9.5,
            letterSpacing: 1.5,
            color: T.pencil,
            textTransform: "uppercase",
          }}
        >
          Side bets
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: "italic",
            fontSize: 22,
            color: T.ink,
            letterSpacing: -0.3,
          }}
        >
          On top of the main game
        </div>
      </div>
      <div style={{ padding: "8px 14px 0" }}>
        {SIDES.map((s) => {
          const active = current.includes(s.id);
          return (
            <button
              key={s.id}
              onClick={() => onToggle(s.id)}
              style={{
                width: "100%",
                padding: "12px",
                marginBottom: 4,
                borderRadius: 12,
                border: `1px solid ${active ? T.ink : "transparent"}`,
                background: active ? T.paperDeep : "transparent",
                cursor: "pointer",
                textAlign: "left",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: T.serif,
                    fontSize: 16,
                    color: T.ink,
                    letterSpacing: -0.2,
                  }}
                >
                  {s.l}
                </div>
                <div
                  style={{
                    fontFamily: T.serif,
                    fontStyle: "italic",
                    fontSize: 12,
                    color: T.pencil,
                    letterSpacing: -0.1,
                    marginTop: 1,
                  }}
                >
                  {s.sub}
                </div>
              </div>
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  border: `1.5px solid ${active ? accent : T.hairline}`,
                  background: active ? accent : "transparent",
                  color: T.paper,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                }}
              >
                {active ? "✓" : ""}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ padding: "10px 22px 0" }}>
        <button
          onClick={onDone}
          style={{
            width: "100%",
            padding: "12px",
            borderRadius: 99,
            border: "none",
            background: T.ink,
            color: T.paper,
            cursor: "pointer",
            fontFamily: T.sans,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function HolesPicker({
  current,
  onPick,
}: {
  current: number;
  onPick: (n: number) => void;
}) {
  return (
    <div style={{ padding: "0 22px 10px" }}>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 9.5,
          letterSpacing: 1.5,
          color: T.pencil,
          textTransform: "uppercase",
        }}
      >
        Holes
      </div>
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 22,
          color: T.ink,
          letterSpacing: -0.3,
          marginBottom: 12,
        }}
      >
        How many today?
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {[9, 18].map((n) => (
          <button
            key={n}
            onClick={() => onPick(n)}
            style={{
              padding: "22px",
              borderRadius: 14,
              border: `1px solid ${current === n ? T.ink : T.hairline}`,
              background: current === n ? T.paperDeep : "transparent",
              cursor: "pointer",
              fontFamily: T.serif,
              fontSize: 40,
              color: T.ink,
              letterSpacing: -0.8,
            }}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
