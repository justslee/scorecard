'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Course, Round, Player, PlayerGroup } from '@/lib/types';
import { addRoundToTournament, getCourses, getTournament, saveRound } from '@/lib/storage';
import { Flag, Users, Plus, X, Clock, GripVertical } from 'lucide-react';

interface GroupDraft {
  id: string;
  name: string;
  teeTime: string;
  playerIds: string[];
}

export default function NewTournamentRoundPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const tournamentId = params?.id;

  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string>('');
  const [selectedTeeId, setSelectedTeeId] = useState<string>('');
  
  // Group management
  const [groups, setGroups] = useState<GroupDraft[]>([]);
  const [showGroupSetup, setShowGroupSetup] = useState(false);

  const tournament = useMemo(() => (tournamentId ? getTournament(tournamentId) : null), [tournamentId]);

  // Get all player info
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

  useEffect(() => {
    setCourses(getCourses());
  }, []);

  const selectedCourse = useMemo(() => courses.find((c) => c.id === selectedCourseId) || null, [courses, selectedCourseId]);

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
    let baseTime = new Date();
    baseTime.setHours(8, 0, 0, 0); // Start at 8:00 AM

    for (let i = 0; i < allPlayers.length; i += playersPerGroup) {
      const groupPlayers = allPlayers.slice(i, i + playersPerGroup);
      const teeTime = baseTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      
      newGroups.push({
        id: crypto.randomUUID(),
        name: `Group ${groupNum}`,
        teeTime,
        playerIds: groupPlayers.map(p => p.id),
      });
      
      groupNum++;
      baseTime = new Date(baseTime.getTime() + 10 * 60000); // Add 10 minutes
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

  // Add player to group
  const addPlayerToGroup = (groupId: string, playerId: string) => {
    setGroups(groups.map(g => 
      g.id === groupId 
        ? { ...g, playerIds: [...g.playerIds, playerId] }
        : g
    ));
  };

  // Remove player from group
  const removePlayerFromGroup = (groupId: string, playerId: string) => {
    setGroups(groups.map(g => 
      g.id === groupId 
        ? { ...g, playerIds: g.playerIds.filter(id => id !== playerId) }
        : g
    ));
  };

  const handleStartRound = () => {
    if (!tournamentId || !tournament) return;
    if (!selectedCourse) {
      alert('Select a course');
      return;
    }

    const players: Player[] = tournament.playerIds.map((pid) => {
      // Find which group this player is in
      const playerGroup = groups.find(g => g.playerIds.includes(pid));
      return {
        id: pid,
        name: tournament.playerNamesById?.[pid] ?? 'Player',
        groupId: playerGroup?.id,
      };
    });

    const selectedTee = teeOptions.find((t) => t.id === selectedTeeId);

    // Convert draft groups to PlayerGroup
    const playerGroups: PlayerGroup[] = groups.map(g => ({
      id: g.id,
      name: g.name,
      teeTime: g.teeTime || undefined,
      playerIds: g.playerIds,
    }));

    const round: Round = {
      id: crypto.randomUUID(),
      courseId: selectedCourse.id,
      courseName: selectedCourse.name,
      teeId: selectedTee?.id,
      teeName: selectedTee?.name,
      date: new Date().toISOString(),
      players,
      scores: [],
      holes: selectedTee?.holes ?? selectedCourse.holes,
      groups: playerGroups.length > 0 ? playerGroups : undefined,
      status: 'active',
      tournamentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveRound(round);
    addRoundToTournament(tournamentId, round.id);
    router.push(`/round/${round.id}`);
  };

  if (!tournament) {
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
              <div className="text-xs font-medium text-zinc-400 tracking-wide uppercase">Groups & Tee Times</div>
              <p className="text-xs text-zinc-500 mt-1">Optional: Organize players into groups</p>
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
            <div className="space-y-4">
              {/* Groups */}
              {groups.map((group, groupIndex) => (
                <div key={group.id} className="border border-white/10 rounded-xl p-3 bg-white/2">
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

                  {/* Players in group */}
                  <div className="space-y-1.5">
                    {group.playerIds.map((playerId) => {
                      const player = allPlayers.find(p => p.id === playerId);
                      return (
                        <div key={playerId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/3">
                          <GripVertical className="w-4 h-4 text-zinc-600" />
                          <span className="flex-1 text-sm text-zinc-200">{player?.name}</span>
                          <button
                            type="button"
                            onClick={() => removePlayerFromGroup(group.id, playerId)}
                            className="p-1 rounded hover:bg-white/5 text-zinc-500 hover:text-zinc-300"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}

                    {/* Add player dropdown */}
                    {unassignedPlayers.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => {
                          if (e.target.value) addPlayerToGroup(group.id, e.target.value);
                        }}
                        className="w-full px-3 py-1.5 rounded-lg bg-white/5 border border-dashed border-white/10 text-sm text-zinc-400"
                      >
                        <option value="">+ Add player...</option>
                        {unassignedPlayers.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              ))}

              {/* Add group button */}
              <button
                type="button"
                onClick={addGroup}
                className="w-full py-2.5 rounded-xl border border-dashed border-white/10 text-sm text-zinc-400 hover:bg-white/2 hover:text-zinc-200 flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                Add Group
              </button>

              {/* Unassigned players warning */}
              {unassignedPlayers.length > 0 && (
                <div className="text-xs text-amber-400 bg-amber-500/10 px-3 py-2 rounded-lg">
                  {unassignedPlayers.length} player{unassignedPlayers.length > 1 ? 's' : ''} not assigned to a group:
                  {' '}{unassignedPlayers.map(p => p.name).join(', ')}
                </div>
              )}

              {/* Clear groups */}
              <button
                type="button"
                onClick={() => { setGroups([]); setShowGroupSetup(false); }}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Clear all groups
              </button>
            </div>
          ) : (
            <div className="text-center py-4 text-zinc-500 text-sm">
              All {allPlayers.length} players will be shown together on the scorecard.
              <br />
              <span className="text-xs">Click "Auto-Group" to create tee time groups.</span>
            </div>
          )}
        </section>

        <button onClick={handleStartRound} className="btn btn-primary w-full">
          <span className="inline-flex items-center justify-center gap-2">
            <Flag className="h-5 w-5" aria-hidden="true" />
            <span>Start Round</span>
          </span>
        </button>
      </main>
    </div>
  );
}
