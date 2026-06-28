'use client';

import { useEffect, useMemo, useState } from 'react';
import { roundHref, tournamentHref } from "@/lib/round-url";
import { useParams, useRouter } from 'next/navigation';
import { Course, Round, Player, PlayerGroup, Tournament } from '@/lib/types';
import { getCourses as localGetCourses, saveRound as localSaveRound } from '@/lib/storage';
import { getTournamentAsync } from '@/lib/storage-api';
import { createRound, getCourses as apiGetCourses } from '@/lib/api';
import { T, PAPER_NOISE, DEFAULT_ACCENT } from '@/components/yardage/tokens';

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
  const tournamentId = params?.id;

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [tournamentLoading, setTournamentLoading] = useState(true);
  const [tournamentNotFound, setTournamentNotFound] = useState(false);

  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string>('');
  const [selectedTeeId, setSelectedTeeId] = useState<string>('');
  const [courseError, setCourseError] = useState(false);

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
      setTournamentLoading(false);
      setTournamentNotFound(true);
      return;
    }
    getTournamentAsync(tournamentId)
      .then((t) => {
        if (!t) setTournamentNotFound(true);
        else setTournament(t);
      })
      .catch(() => setTournamentNotFound(true))
      .finally(() => setTournamentLoading(false));
  }, [tournamentId]);

  // ── Load courses: try API first, fall back to local cache ───────────────
  useEffect(() => {
    apiGetCourses()
      .then(setCourses)
      .catch(() => setCourses(localGetCourses()));
  }, []);

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

  const selectedCourse = useMemo(
    () => courses.find((c) => c.id === selectedCourseId) || null,
    [courses, selectedCourseId]
  );

  const teeOptions = selectedCourse?.tees ?? [];

  useEffect(() => {
    if (!selectedCourse) return;
    setSelectedTeeId(teeOptions.length > 0 ? teeOptions[0].id : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCourseId]);

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

    const selectedTee = teeOptions.find((t) => t.id === selectedTeeId);

    const playerGroups: PlayerGroup[] = groups.map(g => ({
      id: g.id,
      name: g.name,
      teeTime: g.teeTime || undefined,
      playerIds: g.playerIds,
    }));

    try {
      // POST /api/rounds — backend assigns its own UUID and appends to tournament.round_ids
      const created: Round = await createRound({
        courseId: selectedCourse.id,
        courseName: selectedCourse.name,
        teeId: selectedTee?.id,
        teeName: selectedTee?.name,
        players,
        holes: selectedTee?.holes ?? selectedCourse.holes,
        groups: playerGroups.length > 0 ? playerGroups : undefined,
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
              <select
                value={selectedCourseId}
                onChange={(e) => { setSelectedCourseId(e.target.value); setCourseError(false); }}
                style={selectStyle}
              >
                <option value="" disabled>Select a course…</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>

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

              {teeOptions.length > 0 && (
                <>
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
                    value={selectedTeeId}
                    onChange={(e) => setSelectedTeeId(e.target.value)}
                    style={selectStyle}
                  >
                    {teeOptions.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </>
              )}
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
    </div>
  );
}
