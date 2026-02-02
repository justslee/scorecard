'use client';

import { useState, useMemo } from 'react';
import { Round, Player, PlayerGroup } from '@/lib/types';
import { X, Users, Clock, Plus, GripVertical } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
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

interface EditGroupsModalProps {
  round: Round;
  onSave: (groups: PlayerGroup[]) => void;
  onClose: () => void;
}

interface GroupDraft {
  id: string;
  name: string;
  teeTime: string;
  playerIds: string[];
}

// Sortable player item
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

// Drag overlay
function DraggedPlayer({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/50 shadow-xl">
      <GripVertical className="w-4 h-4 text-emerald-400" />
      <span className="text-sm text-emerald-200 font-medium">{name}</span>
    </div>
  );
}

export default function EditGroupsModal({ round, onSave, onClose }: EditGroupsModalProps) {
  // Initialize groups from round
  const [groups, setGroups] = useState<GroupDraft[]>(() => {
    if (round.groups && round.groups.length > 0) {
      return round.groups.map(g => ({
        id: g.id,
        name: g.name,
        teeTime: g.teeTime || '',
        playerIds: [...g.playerIds],
      }));
    }
    // No groups - create one with all players
    return [{
      id: crypto.randomUUID(),
      name: 'Group 1',
      teeTime: '',
      playerIds: round.players.map(p => p.id),
    }];
  });

  const [activeId, setActiveId] = useState<string | null>(null);

  // All players
  const allPlayers = useMemo(() => round.players, [round.players]);

  // Unassigned players
  const unassignedPlayers = useMemo(() => {
    const assignedIds = new Set(groups.flatMap(g => g.playerIds));
    return allPlayers.filter(p => !assignedIds.has(p.id));
  }, [allPlayers, groups]);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Find group containing player
  const findGroupContainingPlayer = (playerId: string): string | null => {
    for (const group of groups) {
      if (group.playerIds.includes(playerId)) return group.id;
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
        if (g.id === targetGroupId && !g.playerIds.includes(activePlayerId)) {
          return { ...g, playerIds: [...g.playerIds, activePlayerId] };
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

  // Group operations
  const addGroup = () => {
    setGroups([...groups, {
      id: crypto.randomUUID(),
      name: `Group ${groups.length + 1}`,
      teeTime: '',
      playerIds: [],
    }]);
  };

  const removeGroup = (groupId: string) => {
    setGroups(groups.filter(g => g.id !== groupId));
  };

  const updateGroup = (groupId: string, updates: Partial<GroupDraft>) => {
    setGroups(groups.map(g => g.id === groupId ? { ...g, ...updates } : g));
  };

  // Save
  const handleSave = () => {
    const playerGroups: PlayerGroup[] = groups
      .filter(g => g.playerIds.length > 0)
      .map(g => ({
        id: g.id,
        name: g.name,
        teeTime: g.teeTime || undefined,
        playerIds: g.playerIds,
      }));
    onSave(playerGroups);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, y: 100 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 100 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="w-full max-w-lg max-h-[85vh] overflow-hidden bg-zinc-900 rounded-t-3xl sm:rounded-3xl border border-white/10"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
            <div>
              <h2 className="font-semibold text-lg">Edit Groups</h2>
              <p className="text-xs text-zinc-500">Drag players between groups</p>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-white/5">
              <X className="w-5 h-5 text-zinc-400" />
            </button>
          </div>

          {/* Content */}
          <div className="overflow-y-auto max-h-[60vh] p-5">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
            >
              <div className="space-y-4">
                {groups.map((group) => (
                  <div key={group.id} className="border border-white/10 rounded-xl p-3 bg-white/2">
                    <div className="flex items-center gap-2 mb-3">
                      <input
                        type="text"
                        value={group.name}
                        onChange={(e) => updateGroup(group.id, { name: e.target.value })}
                        className="flex-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm font-medium"
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

                    <SortableContext items={group.playerIds} strategy={verticalListSortingStrategy}>
                      <div className="space-y-1.5 min-h-[40px] p-2 rounded-lg bg-white/2 border border-dashed border-white/10">
                        {group.playerIds.length === 0 ? (
                          <div className="text-xs text-zinc-500 text-center py-2">Drop players here</div>
                        ) : (
                          group.playerIds.map((playerId) => {
                            const player = allPlayers.find(p => p.id === playerId);
                            if (!player) return null;
                            return (
                              <SortablePlayer
                                key={playerId}
                                id={playerId}
                                name={player.name}
                                onRemove={() => updateGroup(group.id, {
                                  playerIds: group.playerIds.filter(id => id !== playerId)
                                })}
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
                  className="w-full py-2.5 rounded-xl border border-dashed border-white/10 text-sm text-zinc-400 hover:bg-white/2"
                >
                  <Plus className="w-4 h-4 inline mr-1" />
                  Add Group
                </button>

                {unassignedPlayers.length > 0 && (
                  <div className="border border-amber-500/30 rounded-xl p-3 bg-amber-500/5">
                    <div className="text-xs font-medium text-amber-400 mb-2 flex items-center gap-2">
                      <Users className="w-3.5 h-3.5" />
                      Unassigned Players
                    </div>
                    <SortableContext items={unassignedPlayers.map(p => p.id)} strategy={verticalListSortingStrategy}>
                      <div className="space-y-1.5">
                        {unassignedPlayers.map((player) => (
                          <SortablePlayer key={player.id} id={player.id} name={player.name} />
                        ))}
                      </div>
                    </SortableContext>
                  </div>
                )}
              </div>

              <DragOverlay>
                {activePlayer ? <DraggedPlayer name={activePlayer.name} /> : null}
              </DragOverlay>
            </DndContext>
          </div>

          {/* Footer */}
          <div className="px-5 py-4 border-t border-white/10 flex gap-3">
            <button onClick={onClose} className="btn btn-secondary flex-1">
              Cancel
            </button>
            <button onClick={handleSave} className="btn btn-primary flex-1">
              Save Changes
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
