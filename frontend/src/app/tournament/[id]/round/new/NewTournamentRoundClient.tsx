'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Course, Round, Player, PlayerGroup, Tournament } from '@/lib/types';
import { getCourses as localGetCourses, saveRound as localSaveRound } from '@/lib/storage';
import { getTournamentAsync } from '@/lib/storage-api';
import { createRound, getCourses as apiGetCourses } from '@/lib/api';
import { Flag, Users, Plus, X, Clock, GripVertical } from 'lucide-react';
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

// Sortable player item component
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

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/5 ${
        isDragging ? 'opacity-50 shadow-lg ring-2 ring-emerald-500/50' : ''
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="touch-none cursor-grab active:cursor-grabbing p-0.5 -ml-1"
      >
        <GripVertical className="w-4 h-4 text-zinc-500" />
      </button>
      <span className="flex-1 text-sm text-zinc-200">{name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-zinc-300"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// Dragged player overlay
function DraggedPlayer({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/50 shadow-xl">
      <GripVertical className="w-4 h-4 text-emerald-400" />
      <span className="text-sm text-emerald-200 font-medium">{name}</span>
    </div>
  );
}

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
        if (!t) {
          setTournamentNotFound(true);
        } else {
          setTournament(t);
        }
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

  // Get all player info from tournament
  const allPlayers = useMemo(() => {
    if (!tournament) return [];
    return tournament.playerIds.map((pid) => ({
      id: pid,
      name: tournament.playerNamesById?.[pid] ?? 'Player',
    }));
  }, [tournament]);

  // Players not yet assigned to a group
  const unassignedPlayers = useMemo(() => {
    const assignedIds = new Set(groups.flatMap(g => g.playerIds));
    return allPlayers.filter(p => !assignedIds.has(p.id));
  }, [allPlayers, groups]);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const selectedCourse = useMemo(
    () => courses.find((c) => c.id === selectedCourseId) || null,
    [courses, selectedCourseId]
  );

  const teeOptions = selectedCourse?.tees ?? [];

  useEffect(() => {
    if (!selectedCourse) return;
    if (teeOptions.length > 0) setSelectedTeeId(teeOptions[0].id);
    else setSelectedTeeId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCourseId]);

  // Auto-generate groups (4 players per group)
  const autoGenerateGroups = () => {
    const newGroups: GroupDraft[] = [];
    const playersPerGroup = 4;
    let groupNum = 1;
    const baseTime = new Date();
    baseTime.setHours(8, 0, 0, 0); // Start at 8:00 AM

    for (let i = 0; i < allPlayers.length; i += playersPerGroup) {
      const groupPlayers = allPlayers.slice(i, i + playersPerGroup);
      const teeTime = new Date(baseTime.getTime() + Math.floor(i / playersPerGroup) * 10 * 60000)
        .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

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

  // Add empty group
  const addGroup = () => {
    const newGroup: GroupDraft = {
      id: crypto.randomUUID(),
      name: `Group ${groups.length + 1}`,
      teeTime: '',
      playerIds: [],
    };
    setGroups([...groups, newGroup]);
  };

  // Remove group
  const removeGroup = (groupId: string) => {
    setGroups(groups.filter(g => g.id !== groupId));
  };

  // Update group
  const updateGroup = (groupId: string, updates: Partial<GroupDraft>) => {
    setGroups(groups.map(g => g.id === groupId ? { ...g, ...updates } : g));
  };

  // Find which group contains a player
  const findGroupContainingPlayer = (playerId: string): string | null => {
    for (const group of groups) {
      if (group.playerIds.includes(playerId)) {
        return group.id;
      }
    }
    return null;
  };

  // DnD handlers
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
        setGroups(groups.map(g =>
          g.id === sourceGroupId
            ? { ...g, playerIds: g.playerIds.filter(id => id !== activePlayerId) }
            : g
        ));
      }
      return;
    }

    if (sourceGroupId === targetGroupId) return;

    if (targetGroupId) {
      setGroups(groups.map(g => {
        if (g.id === sourceGroupId) {
          return { ...g, playerIds: g.playerIds.filter(id => id !== activePlayerId) };
        }
        if (g.id === targetGroupId) {
          if (!g.playerIds.includes(activePlayerId)) {
            return { ...g, playerIds: [...g.playerIds, activePlayerId] };
          }
        }
        return g;
      }));
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
      const updatedGroups = groups.map(g => ({
        ...g,
        playerIds: g.playerIds.filter(id => id !== activePlayerId)
      }));

      setGroups(updatedGroups.map(g =>
        g.id === overId
          ? { ...g, playerIds: [...g.playerIds, activePlayerId] }
          : g
      ));
    }
  };

  const activePlayer = activeId ? allPlayers.find(p => p.id === activeId) : null;

  // ── Start round — POST /api/rounds with tournamentId ────────────────────
  const handleStartRound = async () => {
    if (!tournamentId || !tournament || creating) return;
    if (!selectedCourse) {
      alert('Select a course');
      return;
    }

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
      router.push(`/round/${created.id}`);
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

  // ── Loading / not-found ──────────────────────────────────────────────────
  if (tournamentLoading) {
    return (
      <div className="min-h-screen px-6 py-8">
        <p className="text-zinc-400">Loading tournament…</p>
      </div>
    );
  }

  if (tournamentNotFound || !tournament) {
    return (
      <div className="min-h-screen px-6 py-8">
        <Link href="/" className="text-emerald-400 hover:text-emerald-300 transition-colors">
          ← Back
        </Link>
        <p className="mt-6 text-zinc-300">Tournament not found.</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href={`/tournament/${tournament.id}`} className="btn btn-icon" aria-label="Back">
            ←
          </Link>
          <div>
            <h1 className="text-base font-semibold tracking-tight">Add Round</h1>
            <p className="text-sm text-zinc-400">For {tournament.name}</p>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-24 space-y-4">
        <section className="card p-5">
          <div className="text-xs font-medium text-zinc-400 tracking-wide uppercase">Tournament</div>
          <div className="font-semibold text-zinc-100 mt-1">{tournament.name}</div>
          <div className="text-xs text-zinc-500 mt-1">Players: {tournament.playerIds.length}</div>
        </section>

        <section className="card p-5">
          <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">Course</label>
          <select
            value={selectedCourseId}
            onChange={(e) => setSelectedCourseId(e.target.value)}
            className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10"
          >
            <option value="" disabled>
              Select a course…
            </option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2 mt-4">Tee box</label>
          <select
            value={selectedTeeId}
            onChange={(e) => setSelectedTeeId(e.target.value)}
            className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10"
            disabled={!selectedCourse || teeOptions.length === 0}
          >
            {teeOptions.length === 0 ? (
              <option value="">Default</option>
            ) : (
              teeOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))
            )}
          </select>

          <p className="text-xs text-zinc-500 mt-2">Tee boxes can change yardage/pars.</p>
        </section>

        {/* Groups / Tee Times Section */}
        <section className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-xs font-medium text-zinc-400 tracking-wide uppercase">Groups &amp; Tee Times</div>
              <p className="text-xs text-zinc-500 mt-1">Drag players between groups</p>
            </div>
            {!showGroupSetup && (
              <button
                type="button"
                onClick={autoGenerateGroups}
                className="btn btn-sm bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
              >
                <Users className="w-4 h-4 mr-1" />
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
              <div className="space-y-4">
                {groups.map((group) => (
                  <div
                    key={group.id}
                    className="border border-white/10 rounded-xl p-3 bg-white/2"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <input
                        type="text"
                        value={group.name}
                        onChange={(e) => updateGroup(group.id, { name: e.target.value })}
                        className="flex-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm font-medium"
                        placeholder="Group name"
                      />
                      <div className="flex items-center gap-1 bg-white/5 rounded-lg px-2 py-1.5 border border-white/10">
                        <Clock className="w-4 h-4 text-zinc-400" />
                        <input
                          type="text"
                          value={group.teeTime}
                          onChange={(e) => updateGroup(group.id, { teeTime: e.target.value })}
                          className="w-20 bg-transparent text-sm text-center"
                          placeholder="8:00 AM"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeGroup(group.id)}
                        className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-red-400"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <SortableContext
                      items={group.playerIds}
                      strategy={verticalListSortingStrategy}
                    >
                      <div
                        className="space-y-1.5 min-h-[40px] p-2 rounded-lg bg-white/2 border border-dashed border-white/10"
                        data-group-id={group.id}
                      >
                        {group.playerIds.length === 0 ? (
                          <div className="text-xs text-zinc-500 text-center py-2">
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
                                  setGroups(groups.map(g =>
                                    g.id === group.id
                                      ? { ...g, playerIds: g.playerIds.filter(id => id !== playerId) }
                                      : g
                                  ));
                                }}
                              />
                            );
                          })
                        )}
                      </div>
                    </SortableContext>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={addGroup}
                  className="w-full py-2.5 rounded-xl border border-dashed border-white/10 text-sm text-zinc-400 hover:bg-white/2 hover:text-zinc-200 flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Add Group
                </button>

                {unassignedPlayers.length > 0 && (
                  <div className="border border-amber-500/30 rounded-xl p-3 bg-amber-500/5">
                    <div className="text-xs font-medium text-amber-400 mb-2 flex items-center gap-2">
                      <Users className="w-3.5 h-3.5" />
                      Unassigned Players
                    </div>
                    <SortableContext
                      items={unassignedPlayers.map(p => p.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-1.5">
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

                <button
                  type="button"
                  onClick={() => { setGroups([]); setShowGroupSetup(false); }}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Clear all groups
                </button>
              </div>

              <DragOverlay>
                {activePlayer ? <DraggedPlayer name={activePlayer.name} /> : null}
              </DragOverlay>
            </DndContext>
          ) : (
            <div className="text-center py-4 text-zinc-500 text-sm">
              All {allPlayers.length} players will be shown together on the scorecard.
              <br />
              <span className="text-xs">Click &quot;Auto-Group&quot; to create tee time groups.</span>
            </div>
          )}
        </section>

        {createError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {createError}
          </div>
        )}

        <button
          onClick={handleStartRound}
          disabled={creating}
          className="btn btn-primary w-full"
          style={{ opacity: creating ? 0.7 : 1 }}
        >
          <span className="inline-flex items-center justify-center gap-2">
            <Flag className="h-5 w-5" aria-hidden="true" />
            <span>{creating ? 'Creating…' : 'Start Round'}</span>
          </span>
        </button>
      </main>
    </div>
  );
}
