'use client';

import { useEffect, useMemo, useState } from 'react';
import { roundHref, tournamentHref } from "@/lib/round-url";
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Round, Player, PlayerGroup, Tournament, Game, HoleInfo, createDefaultCourse } from '@/lib/types';
import { saveRound as localSaveRound } from '@/lib/storage';
import { getTournamentAsync } from '@/lib/storage-api';
import { createRound } from '@/lib/api';
import { T, PAPER_NOISE, DEFAULT_ACCENT } from '@/components/yardage/tokens';
import { haptic } from '@/lib/haptics';
import GamePicker from '@/components/GamePicker';
import { buildRoundGames, TOURNAMENT_GAME_OPTIONS, STAKE_GAME_IDS, gameSelectableForRoster, GameId } from '@/lib/round-games';
import CourseSearch from '@/components/CourseSearch';
import { anchorFromSelectedCourse } from '@/lib/round-anchor';
import { fetchMappedCourse } from '@/lib/courses/mapped-course-api';
import { namesMatch } from '@/lib/course/tee-anchor';
import { nextDayIndex, selectionFromPlanEntry } from '@/lib/tournament-course-plan';

// ── Inline icon — no lucide-react ────────────────────────────────────────────

function GripVerticalIcon({ width = 24, height = 24, color }: { width?: number; height?: number; color?: string }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" stroke="none"
      aria-hidden="true" style={color ? { color } : undefined}>
      <circle cx="9" cy="5" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="9" cy="19" r="1.5" />
      <circle cx="15" cy="5" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="15" cy="19" r="1.5" />
    </svg>
  );
}
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface GroupDraft {
  id: string;
  name: string;
  teeTime: string;
  playerIds: string[];
}

// Standard-tee model, same idiom as round/new/page.tsx.
type TeeId = 'black' | 'blue' | 'white' | 'gold' | 'red';

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

const TEE_OPTIONS: { id: TeeId; l: string; c: string; yds: number }[] = [
  { id: 'black', l: 'Black · Championship', c: '#1a1a1a', yds: 7244 },
  { id: 'blue', l: 'Blue · Back', c: '#3a4a8a', yds: 6845 },
  { id: 'white', l: 'White · Middle', c: '#eae5d6', yds: 6473 },
  { id: 'gold', l: 'Gold · Forward', c: '#b8763a', yds: 5984 },
  { id: 'red', l: 'Red', c: '#b84a3a', yds: 5412 },
];

// ── Sortable player item — yardage-book paper surface ───────────────────────
function SortablePlayer({
  id,
  name,
  onRemove
}: {
  id: string;
  name: string;
  onRemove?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 10px',
        borderRadius: 8,
        background: isDragging ? T.paperDeep : T.paper,
        border: `1px solid ${isDragging ? DEFAULT_ACCENT : T.hairline}`,
        opacity: isDragging ? 0.5 : 1,
        boxShadow: isDragging ? '0 4px 12px rgba(26,42,26,0.12)' : 'none',
      }}
    >
      <button
        {...attributes}
        {...listeners}
        style={{
          touchAction: 'none',
          cursor: 'grab',
          background: 'transparent',
          border: 'none',
          padding: '2px 0',
          display: 'flex',
          alignItems: 'center',
          color: T.pencilSoft,
          flexShrink: 0,
        }}
        aria-label="Drag to reorder"
      >
        <GripVerticalIcon width={14} height={14} color={T.pencilSoft} />
      </button>
      <span
        style={{
          flex: 1,
          fontFamily: T.sans,
          fontSize: 14,
          color: T.ink,
        }}
      >
        {name}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          style={{
            background: 'transparent',
            border: 'none',
            padding: '4px 6px',
            cursor: 'pointer',
            fontFamily: T.mono,
            fontSize: 13,
            color: T.pencilSoft,
            minHeight: 32,
            display: 'flex',
            alignItems: 'center',
          }}
          aria-label={`Remove ${name}`}
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── Drag overlay — ink ghost while dragging ──────────────────────────────────
function DraggedPlayer({ name }: { name: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        borderRadius: 8,
        background: T.ink,
        border: `1px solid ${DEFAULT_ACCENT}`,
        boxShadow: '0 8px 24px rgba(26,42,26,0.25)',
      }}
    >
      <GripVerticalIcon width={14} height={14} color={T.paper} />
      <span
        style={{
          fontFamily: T.sans,
          fontSize: 14,
          fontWeight: 500,
          color: T.paper,
        }}
      >
        {name}
      </span>
    </div>
  );
}

// ── Shared select style ──────────────────────────────────────────────────────
const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  background: T.paperDeep,
  border: `1px solid ${T.hairline}`,
  color: T.ink,
  fontFamily: T.sans,
  fontSize: 14,
  outline: 'none',
  appearance: 'none',
  WebkitAppearance: 'none',
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderRadius: 8,
  background: T.paperDeep,
  border: `1px solid ${T.hairline}`,
  color: T.ink,
  fontFamily: T.sans,
  fontSize: 14,
  outline: 'none',
};

// ── Main component ────────────────────────────────────────────────────────────
export default function NewTournamentRoundPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  // Static-export path trick (round-url.ts tournamentRoundNewHref): the real
  // dynamic segment is a placeholder ("view"); resolve the actual id from the
  // ?id= query first, falling back to the (placeholder) route param.
  const tournamentId = search?.get('id') ?? params?.id;

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [tournamentLoading, setTournamentLoading] = useState(true);
  const [tournamentNotFound, setTournamentNotFound] = useState(false);

  const [selectedCourse, setSelectedCourse] = useState<SelectedCourse | null>(null);
  const [showCourseSearch, setShowCourseSearch] = useState(false);
  const [tee, setTee] = useState<TeeId>('white');
  const [courseError, setCourseError] = useState(false);

  // Game format — per-round, optional (default = no games, honest empty settlement).
  const [selectedGames, setSelectedGames] = useState<{ id: GameId; stake: string }[]>([]);
  const [showGamePicker, setShowGamePicker] = useState(false);

  // Group management
  const [groups, setGroups] = useState<GroupDraft[]>([]);
  const [showGroupSetup, setShowGroupSetup] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Create state
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ── Load tournament (API-backed via storage-api) ────────────────────────
  useEffect(() => {
    if (!tournamentId) {
      // Defer the state update out of the effect body (react-hooks/set-state-in-effect).
      const t = setTimeout(() => {
        setTournamentLoading(false);
        setTournamentNotFound(true);
      }, 0);
      return () => clearTimeout(t);
    }
    getTournamentAsync(tournamentId)
      .then((t) => {
        if (!t) {
          setTournamentNotFound(true);
          return;
        }
        setTournament(t);
        // Pre-fill from the per-day course plan (specs/
        // tournament-per-round-format-course-plan.md §5b): drawing Day 2 of
        // the Bethpage trip opens with "Bethpage Red" already in the course
        // slot — mapped id and centre intact. No plan / no entry for this
        // day → null → identical to today's "pick it yourself" default.
        const entry = t.roundCourses?.[nextDayIndex(t)] ?? null;
        if (entry) setSelectedCourse(selectionFromPlanEntry(entry));
      })
      .catch(() => setTournamentNotFound(true))
      .finally(() => setTournamentLoading(false));
  }, [tournamentId]);

  // Prune a selected game whose roster requirement the tournament roster
  // doesn't meet (e.g. match play needs exactly 2, tournament has 8 players)
  // — the builder would silently skip it anyway; reflect that immediately
  // rather than show a phantom selection (tournament-settlement-honesty-
  // plan.md §3).
  useEffect(() => {
    if (!tournament) return;
    const rosterSize = tournament.playerIds.length;
    // Defer the state update out of the effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => {
      setSelectedGames((prev) => {
        const next = prev.filter((s) => gameSelectableForRoster(s.id, rosterSize));
        return next.length === prev.length ? prev : next;
      });
    }, 0);
    return () => clearTimeout(t);
  }, [tournament]);

  // ── Player list from tournament ─────────────────────────────────────────
  const allPlayers = useMemo(() => {
    if (!tournament) return [];
    return tournament.playerIds.map((pid) => ({
      id: pid,
      name: tournament.playerNamesById?.[pid] ?? 'Player',
    }));
  }, [tournament]);

  const unassignedPlayers = useMemo(() => {
    const assignedIds = new Set(groups.flatMap(g => g.playerIds));
    return allPlayers.filter(p => !assignedIds.has(p.id));
  }, [allPlayers, groups]);

  // ── DnD sensors ────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // ── Group helpers ────────────────────────────────────────────────────────
  const autoGenerateGroups = () => {
    const newGroups: GroupDraft[] = [];
    const playersPerGroup = 4;
    let groupNum = 1;
    const baseTime = new Date();
    baseTime.setHours(8, 0, 0, 0);

    for (let i = 0; i < allPlayers.length; i += playersPerGroup) {
      const groupPlayers = allPlayers.slice(i, i + playersPerGroup);
      const teeTime = new Date(
        baseTime.getTime() + Math.floor(i / playersPerGroup) * 10 * 60000
      ).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

      newGroups.push({
        id: crypto.randomUUID(),
        name: `Group ${groupNum}`,
        teeTime,
        playerIds: groupPlayers.map(p => p.id),
      });
      groupNum++;
    }

    setGroups(newGroups);
    setShowGroupSetup(true);
  };

  const addGroup = () => {
    setGroups(prev => [
      ...prev,
      { id: crypto.randomUUID(), name: `Group ${prev.length + 1}`, teeTime: '', playerIds: [] },
    ]);
  };

  const removeGroup = (groupId: string) => {
    setGroups(prev => prev.filter(g => g.id !== groupId));
  };

  const updateGroup = (groupId: string, updates: Partial<GroupDraft>) => {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, ...updates } : g));
  };

  const findGroupContainingPlayer = (playerId: string): string | null => {
    for (const group of groups) {
      if (group.playerIds.includes(playerId)) return group.id;
    }
    return null;
  };

  // ── DnD handlers ────────────────────────────────────────────────────────
  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activePlayerId = active.id as string;
    const overId = over.id as string;
    const sourceGroupId = findGroupContainingPlayer(activePlayerId);

    let targetGroupId: string | null = null;
    const overGroup = groups.find(g => g.id === overId);
    if (overGroup) {
      targetGroupId = overGroup.id;
    } else {
      targetGroupId = findGroupContainingPlayer(overId);
    }

    if (overId === 'unassigned' || unassignedPlayers.some(p => p.id === overId)) {
      if (sourceGroupId) {
        setGroups(prev =>
          prev.map(g =>
            g.id === sourceGroupId
              ? { ...g, playerIds: g.playerIds.filter(id => id !== activePlayerId) }
              : g
          )
        );
      }
      return;
    }

    if (sourceGroupId === targetGroupId) return;

    if (targetGroupId) {
      setGroups(prev =>
        prev.map(g => {
          if (g.id === sourceGroupId) {
            return { ...g, playerIds: g.playerIds.filter(id => id !== activePlayerId) };
          }
          if (g.id === targetGroupId && !g.playerIds.includes(activePlayerId)) {
            return { ...g, playerIds: [...g.playerIds, activePlayerId] };
          }
          return g;
        })
      );
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const activePlayerId = active.id as string;
    const overId = over.id as string;
    const overGroup = groups.find(g => g.id === overId);
    if (overGroup && !overGroup.playerIds.includes(activePlayerId)) {
      setGroups(prev =>
        prev
          .map(g => ({ ...g, playerIds: g.playerIds.filter(id => id !== activePlayerId) }))
          .map(g =>
            g.id === overId ? { ...g, playerIds: [...g.playerIds, activePlayerId] } : g
          )
      );
    }
  };

  const activePlayer = activeId ? allPlayers.find(p => p.id === activeId) : null;

  // ── Start round — POST /api/rounds with tournamentId ────────────────────
  const handleStartRound = async () => {
    if (!tournamentId || !tournament || creating) return;

    if (!selectedCourse) {
      setCourseError(true);
      return;
    }
    setCourseError(false);
    setCreating(true);
    setCreateError(null);

    const players: Player[] = tournament.playerIds.map((pid) => {
      const playerGroup = groups.find(g => g.playerIds.includes(pid));
      return {
        id: pid,
        name: tournament.playerNamesById?.[pid] ?? 'Player',
        groupId: playerGroup?.id,
      };
    });

    const games: Game[] = buildRoundGames(selectedGames, players.map((p) => p.id));

    const playerGroups: PlayerGroup[] = groups.map(g => ({
      id: g.id,
      name: g.name,
      teeTime: g.teeTime || undefined,
      playerIds: g.playerIds,
    }));

    // Build default course hole layout, then snapshot the golfer's selected
    // tee's real per-hole card yardages when the course is mapped — same
    // pattern as round/new/page.tsx:327-365.
    const defaultCourse = createDefaultCourse(selectedCourse.name);
    let holeList: HoleInfo[] =
      selectedCourse.holes === 9 ? defaultCourse.holes.slice(0, 9) : defaultCourse.holes;
    const teeLabel = TEE_OPTIONS.find((t) => t.id === tee)?.l.split(' · ')[0] ?? 'White';
    if (selectedCourse.source === 'mapped' && selectedCourse.id) {
      try {
        const mapped = await fetchMappedCourse(String(selectedCourse.id));
        const snapshot: HoleInfo[] = mapped.holes
          .filter((h) => selectedCourse.holes !== 9 || h.number <= 9)
          .sort((a, b) => a.number - b.number)
          .map((h) => {
            let yards: number | undefined;
            for (const [key, y] of Object.entries(h.yardages)) {
              if (namesMatch(key, teeLabel)) {
                yards = y;
                break;
              }
            }
            return { number: h.number, par: h.par, yards, handicap: h.handicap };
          });
        if (snapshot.length > 0) holeList = snapshot;
      } catch {
        // Offline — honest pars-only default, never fabricated yards.
      }
    }

    try {
      // POST /api/rounds — backend assigns its own UUID and appends to tournament.round_ids
      const created: Round = await createRound({
        courseId: String(selectedCourse.id),
        courseName: selectedCourse.name,
        // Course anchor: lets the round screen render the satellite map
        // directly — closes the standing bug that tournament rounds carried
        // no anchor (tournament-per-round-format-course-plan.md §5c).
        ...anchorFromSelectedCourse(selectedCourse),
        teeId: tee,
        teeName: teeLabel,
        players,
        holes: holeList,
        groups: playerGroups.length > 0 ? playerGroups : undefined,
        games,
        tournamentId,
      });

      // Write-through to localStorage so the scoring screen can read it offline.
      localSaveRound(created);

      // Navigate using the SERVER-RETURNED id (not a client-side UUID).
      router.push(roundHref(created.id));
    } catch (e) {
      if (!(e instanceof TypeError)) {
        const msg = e instanceof Error ? e.message : 'Failed to create round.';
        setCreateError(
          msg.length > 120
            ? 'Server error — check your connection and try again.'
            : msg
        );
      } else {
        setCreateError('No connection — connect to the internet to add a round.');
      }
      setCreating(false);
    }
  };

  // ── Shared paper shell ────────────────────────────────────────────────────
  const paperShell: React.CSSProperties = {
    minHeight: '100vh',
    background: `${PAPER_NOISE}, ${T.paper}`,
    backgroundBlendMode: 'multiply',
    fontFamily: T.sans,
    color: T.ink,
    display: 'flex',
    flexDirection: 'column',
  };

  // ── Loading ───────────────────────────────────────────────────────────────
  if (tournamentLoading) {
    return (
      <div style={paperShell}>
        <div
          style={{
            padding: 'max(44px, env(safe-area-inset-top)) 22px 0',
            fontFamily: T.serif,
            fontStyle: 'italic',
            fontSize: 16,
            color: T.pencilSoft,
          }}
        >
          Loading tournament…
        </div>
      </div>
    );
  }

  // ── Not found ─────────────────────────────────────────────────────────────
  if (tournamentNotFound || !tournament) {
    return (
      <div style={paperShell}>
        <div style={{ padding: 'max(14px, env(safe-area-inset-top)) 22px 14px' }}>
          <button
            onClick={() => router.push('/')}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.4,
              color: T.pencil,
              textTransform: 'uppercase',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              minHeight: 44,
            }}
          >
            <span style={{ fontSize: 11 }}>←</span> Home
          </button>
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: 'italic',
              fontSize: 22,
              color: T.pencil,
              marginTop: 16,
            }}
          >
            Tournament not found.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        ...paperShell,
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          maxWidth: 420,
          margin: '0 auto',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
        }}
      >
        <div style={{ flex: 1 }}>
          {/* ── Header ──────────────────────────────────────────────── */}
          <div
            style={{
              padding: 'max(14px, env(safe-area-inset-top)) 22px 14px',
            }}
          >
            <button
              onClick={() => router.push(tournamentHref(tournament.id))}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.4,
                color: T.pencil,
                textTransform: 'uppercase',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                marginBottom: 8,
                minHeight: 44,
              }}
            >
              <span style={{ fontSize: 11 }}>←</span> {tournament.name}
            </button>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: 'uppercase',
                marginBottom: 2,
              }}
            >
              Add · Round
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: 'italic',
                fontSize: 30,
                letterSpacing: -0.6,
                color: T.ink,
                lineHeight: 1.05,
              }}
            >
              Set up a round.
            </div>
          </div>

          {/* ── Tournament summary ──────────────────────────────────── */}
          <div style={{ padding: '0 22px' }}>
            <div
              style={{
                border: `1px solid ${T.hairline}`,
                borderRadius: 14,
                padding: '12px 14px',
                background: T.paperDeep,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencilSoft,
                  textTransform: 'uppercase',
                  marginBottom: 2,
                }}
              >
                Tournament
              </div>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: 'italic',
                  fontSize: 18,
                  color: T.ink,
                  letterSpacing: -0.2,
                }}
              >
                {tournament.name}
              </div>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.1,
                  color: T.pencilSoft,
                  marginTop: 2,
                }}
              >
                {tournament.playerIds.length} players
              </div>
            </div>

            {/* ── Course ──────────────────────────────────────────────── */}
            <div
              style={{
                border: `1px solid ${courseError ? T.errorInk : T.hairline}`,
                borderRadius: 14,
                padding: '12px 14px',
                background: T.paper,
                marginBottom: 16,
              }}
            >
              <label
                style={{
                  display: 'block',
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencilSoft,
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}
              >
                Course
              </label>
              <button
                type="button"
                onClick={() => setShowCourseSearch(true)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  textAlign: 'left',
                  minHeight: 44,
                }}
              >
                <span
                  style={{
                    fontFamily: T.serif,
                    fontStyle: selectedCourse ? 'normal' : 'italic',
                    fontSize: 15,
                    color: T.ink,
                    letterSpacing: -0.2,
                  }}
                >
                  {selectedCourse?.name ?? 'Select a course…'}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.pencilSoft }}>{'›'}</span>
              </button>

              {courseError && (
                <div
                  style={{
                    fontFamily: T.mono,
                    fontSize: 9,
                    letterSpacing: 1.1,
                    color: T.errorInk,
                    marginTop: 6,
                  }}
                >
                  Select a course to continue.
                </div>
              )}

              <label
                style={{
                  display: 'block',
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencilSoft,
                  textTransform: 'uppercase',
                  marginTop: 12,
                  marginBottom: 8,
                }}
              >
                Tee Box
              </label>
              <select
                value={tee}
                onChange={(e) => setTee(e.target.value as TeeId)}
                style={selectStyle}
              >
                {TEE_OPTIONS.map((t) => (
                  <option key={t.id} value={t.id}>{t.l}</option>
                ))}
              </select>
              <div
                style={{
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.1,
                  color: T.pencilSoft,
                  marginTop: 8,
                }}
              >
                Tee boxes can change yardage and pars.
              </div>
            </div>

            {/* ── Game ────────────────────────────────────────────────── */}
            <div
              style={{
                border: `1px solid ${T.hairline}`,
                borderRadius: 14,
                padding: '12px 14px',
                background: T.paper,
                marginBottom: 16,
              }}
            >
              <label
                style={{
                  display: 'block',
                  fontFamily: T.mono,
                  fontSize: 9,
                  letterSpacing: 1.3,
                  color: T.pencilSoft,
                  textTransform: 'uppercase',
                  marginBottom: 8,
                }}
              >
                Game · Optional
              </label>
              <button
                type="button"
                onClick={() => setShowGamePicker(true)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  textAlign: 'left',
                  minHeight: 44,
                }}
              >
                <span
                  style={{
                    fontFamily: T.serif,
                    fontStyle: selectedGames.length === 0 ? 'italic' : 'normal',
                    fontSize: 15,
                    color: T.ink,
                    letterSpacing: -0.2,
                  }}
                >
                  {selectedGames.length === 0
                    ? 'None — stroke play'
                    : selectedGames
                        .map((sel) => {
                          const label = TOURNAMENT_GAME_OPTIONS.find((g) => g.id === sel.id)?.l ?? sel.id;
                          // Only stake-taking formats ever show a $ suffix —
                          // displayed stake == settled stake, always
                          // (tournament-settlement-honesty-plan.md §3).
                          return sel.id === 'none' || !STAKE_GAME_IDS.has(sel.id)
                            ? label
                            : `${label} ${sel.stake}`;
                        })
                        .join(' + ')}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.pencilSoft }}>{'›'}</span>
              </button>
              <div
                style={{
                  fontFamily: T.serif,
                  fontStyle: 'italic',
                  fontSize: 12,
                  color: T.pencilSoft,
                  marginTop: 6,
                }}
              >
                Each round can play a different game.
              </div>
            </div>

            {/* ── Groups & Tee Times ──────────────────────────────────── */}
            <div
              style={{
                border: `1px solid ${T.hairline}`,
                borderRadius: 14,
                padding: '12px 14px',
                background: T.paper,
                marginBottom: 80,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: T.mono,
                      fontSize: 9,
                      letterSpacing: 1.3,
                      color: T.pencilSoft,
                      textTransform: 'uppercase',
                      marginBottom: 2,
                    }}
                  >
                    Groups &amp; Tee Times
                  </div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontStyle: 'italic',
                      fontSize: 13,
                      color: T.pencil,
                    }}
                  >
                    Drag players between groups.
                  </div>
                </div>
                {!showGroupSetup && (
                  <button
                    type="button"
                    onClick={autoGenerateGroups}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 99,
                      border: `1px solid ${T.hairline}`,
                      background: 'transparent',
                      color: T.pencil,
                      fontFamily: T.mono,
                      fontSize: 9,
                      letterSpacing: 1.3,
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                      minHeight: 44,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    Auto-Group
                  </button>
                )}
              </div>

              {showGroupSetup ? (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDragEnd={handleDragEnd}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Group cards */}
                    {groups.map((group) => (
                      <div
                        key={group.id}
                        style={{
                          border: `1px solid ${T.hairline}`,
                          borderRadius: 10,
                          padding: 10,
                          background: T.paperDeep,
                        }}
                      >
                        {/* Group name + tee time + remove */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            marginBottom: 8,
                          }}
                        >
                          <input
                            type="text"
                            value={group.name}
                            onChange={(e) => updateGroup(group.id, { name: e.target.value })}
                            style={{ ...inputStyle, flex: 1 }}
                            placeholder="Group name"
                          />
                          <input
                            type="text"
                            value={group.teeTime}
                            onChange={(e) => updateGroup(group.id, { teeTime: e.target.value })}
                            style={{
                              ...inputStyle,
                              width: 74,
                              textAlign: 'center',
                              fontFamily: T.mono,
                              fontSize: 11,
                              letterSpacing: 0.5,
                            }}
                            placeholder="8:00 AM"
                          />
                          <button
                            type="button"
                            onClick={() => removeGroup(group.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              padding: '4px 6px',
                              cursor: 'pointer',
                              fontFamily: T.mono,
                              fontSize: 15,
                              color: T.pencilSoft,
                              minHeight: 44,
                              display: 'flex',
                              alignItems: 'center',
                            }}
                            aria-label={`Remove ${group.name}`}
                          >
                            ×
                          </button>
                        </div>

                        {/* Drop zone */}
                        <SortableContext
                          items={group.playerIds}
                          strategy={verticalListSortingStrategy}
                        >
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 5,
                              minHeight: 44,
                              padding: 8,
                              borderRadius: 8,
                              background: T.paper,
                              border: `1px dashed ${T.hairline}`,
                            }}
                          >
                            {group.playerIds.length === 0 ? (
                              <div
                                style={{
                                  fontFamily: T.serif,
                                  fontStyle: 'italic',
                                  fontSize: 13,
                                  color: T.pencilSoft,
                                  textAlign: 'center',
                                  paddingTop: 6,
                                }}
                              >
                                Drop players here
                              </div>
                            ) : (
                              group.playerIds.map((playerId) => {
                                const player = allPlayers.find(p => p.id === playerId);
                                if (!player) return null;
                                return (
                                  <SortablePlayer
                                    key={playerId}
                                    id={playerId}
                                    name={player.name}
                                    onRemove={() => {
                                      setGroups(prev =>
                                        prev.map(g =>
                                          g.id === group.id
                                            ? { ...g, playerIds: g.playerIds.filter(id => id !== playerId) }
                                            : g
                                        )
                                      );
                                    }}
                                  />
                                );
                              })
                            )}
                          </div>
                        </SortableContext>
                      </div>
                    ))}

                    {/* Add Group */}
                    <button
                      type="button"
                      onClick={addGroup}
                      style={{
                        width: '100%',
                        padding: '10px',
                        borderRadius: 10,
                        border: `1px dashed ${T.hairline}`,
                        background: 'transparent',
                        fontFamily: T.serif,
                        fontStyle: 'italic',
                        fontSize: 14,
                        color: T.pencilSoft,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                        minHeight: 44,
                      }}
                    >
                      + Add Group
                    </button>

                    {/* Unassigned players */}
                    {unassignedPlayers.length > 0 && (
                      <div
                        style={{
                          border: `1px solid ${T.warningInk}40`,
                          borderRadius: 10,
                          padding: 10,
                          background: T.warningWash,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: T.mono,
                            fontSize: 9,
                            letterSpacing: 1.3,
                            color: T.warningInk,
                            textTransform: 'uppercase',
                            marginBottom: 6,
                          }}
                        >
                          Unassigned Players
                        </div>
                        <SortableContext
                          items={unassignedPlayers.map(p => p.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            {unassignedPlayers.map((player) => (
                              <SortablePlayer
                                key={player.id}
                                id={player.id}
                                name={player.name}
                              />
                            ))}
                          </div>
                        </SortableContext>
                      </div>
                    )}

                    {/* Clear groups */}
                    <button
                      type="button"
                      onClick={() => { setGroups([]); setShowGroupSetup(false); }}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: '4px 0',
                        cursor: 'pointer',
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.2,
                        color: T.pencilSoft,
                        textTransform: 'uppercase',
                        textAlign: 'left',
                        minHeight: 44,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      Clear all groups
                    </button>
                  </div>

                  <DragOverlay>
                    {activePlayer ? <DraggedPlayer name={activePlayer.name} /> : null}
                  </DragOverlay>
                </DndContext>
              ) : (
                <div
                  style={{
                    textAlign: 'center',
                    padding: '16px 0',
                    fontFamily: T.serif,
                    fontStyle: 'italic',
                    fontSize: 14,
                    color: T.pencilSoft,
                    lineHeight: 1.5,
                  }}
                >
                  All {allPlayers.length} players will be shown together on the scorecard.
                  {allPlayers.length > 1 && (
                    <div
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.1,
                        marginTop: 4,
                        fontStyle: 'normal',
                      }}
                    >
                      Tap Auto-Group to create tee time groups.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Sticky CTA ────────────────────────────────────────────────── */}
        <div
          style={{
            padding: '10px 22px max(26px, env(safe-area-inset-bottom, 26px))',
            background: `linear-gradient(to top, ${T.paper} 65%, rgba(0,0,0,0))`,
            flexShrink: 0,
            position: 'sticky',
            bottom: 0,
          }}
        >
          {createError && (
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9.5,
                letterSpacing: 1.1,
                color: T.errorInk,
                background: T.errorWash,
                border: `1px solid ${T.errorInk}30`,
                borderRadius: 10,
                padding: '10px 14px',
                marginBottom: 10,
                lineHeight: 1.5,
              }}
            >
              {createError}
            </div>
          )}
          <button
            onClick={handleStartRound}
            disabled={creating}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: 99,
              border: 'none',
              background: T.ink,
              color: T.paper,
              cursor: creating ? 'default' : 'pointer',
              fontFamily: T.sans,
              fontSize: 14,
              fontWeight: 500,
              letterSpacing: -0.1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              transition: 'background 0.2s',
              minHeight: 52,
              opacity: creating ? 0.7 : 1,
            }}
          >
            <span style={{ fontFamily: T.serif, fontStyle: 'italic' }}>
              {creating ? 'Creating…' : 'Start Round'}
            </span>
            {!creating && (
              <span
                style={{
                  fontFamily: T.mono,
                  fontSize: 10,
                  letterSpacing: 1.2,
                  opacity: 0.7,
                }}
              >
                →
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Game picker bottom sheet ─────────────────────────────────────── */}
      <AnimatePresence>
        {showGamePicker && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowGamePicker(false)}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.35)',
                zIndex: 52, // above CaddieOrb (50) so the scrim dims/blocks it; below LooperSheet (60)
              }}
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={T.springSoft}
              style={{
                position: 'fixed',
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 53,
                background: T.paper,
                borderRadius: '20px 20px 0 0',
                padding: '12px 0 28px',
                maxHeight: '80vh',
                overflow: 'hidden',
                boxShadow: '0 -20px 50px rgba(0,0,0,0.2)',
                display: 'flex',
                flexDirection: 'column',
                maxWidth: 420,
                margin: '0 auto',
              }}
            >
              {/* Drag handle */}
              <div
                style={{
                  width: 40,
                  height: 4,
                  borderRadius: 99,
                  background: T.hairline,
                  margin: '0 auto 10px',
                }}
              />
              <GamePicker
                accent={DEFAULT_ACCENT}
                options={TOURNAMENT_GAME_OPTIONS}
                selected={selectedGames}
                rosterSize={tournament.playerIds.length}
                onToggle={(id: GameId) => {
                  haptic('light');
                  setSelectedGames((prev) => {
                    if (prev.some((s) => s.id === id)) {
                      return prev.filter((s) => s.id !== id);
                    }
                    // Default stake only for formats settlement.ts actually
                    // settles — anything else stays stakeless so the picker
                    // never advertises money it won't pay out.
                    const withDefault = {
                      id,
                      stake: !STAKE_GAME_IDS.has(id) ? '' : id === 'nassau' ? '$20' : '$5',
                    };
                    // "No stakes" is exclusive of everything else.
                    if (id === 'none') return [withDefault];
                    return [...prev.filter((s) => s.id !== 'none'), withDefault];
                  });
                }}
                onStakeFor={(id: GameId, stake: string) => {
                  setSelectedGames((prev) =>
                    prev.map((s) => (s.id === id ? { ...s, stake } : s))
                  );
                }}
                onDone={() => setShowGamePicker(false)}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ── CourseSearch overlay — no onVoiceSearch: this page has no
           Realtime voice-setup panel, so built-in dictation is the mic path. ── */}
      <AnimatePresence>
        {showCourseSearch && (
          <CourseSearch
            voiceSearch
            onSelectCourse={(course) => {
              setSelectedCourse(course);
              setShowCourseSearch(false);
              setCourseError(false);
            }}
            onClose={() => setShowCourseSearch(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
