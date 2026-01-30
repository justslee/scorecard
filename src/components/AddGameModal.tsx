'use client';

import { useMemo, useState } from 'react';
import { Game, GameFormat, Player, Round } from '@/lib/types';

interface AddGameModalProps {
  round: Round;
  onClose: () => void;
  onAddGame: (game: Game) => void;
}

const formatLabel: Record<GameFormat, string> = {
  skins: 'Skins',
  nassau: 'Nassau',
  bestBall: 'Best Ball / Four Ball',
  scramble: 'Scramble',
  wolf: 'Wolf',
  threePoint: '2v2 Three Point',
};

export default function AddGameModal({ round, onClose, onAddGame }: AddGameModalProps) {
  const [format, setFormat] = useState<GameFormat>('skins');
  const [name, setName] = useState('');

  // skins
  const [skinsPlayerIds, setSkinsPlayerIds] = useState<string[]>(round.players.map(p => p.id));
  const [carryover, setCarryover] = useState(true);

  // team selection (best ball, team nassau)
  const [teamAPlayerIds, setTeamAPlayerIds] = useState<string[]>([]);
  const [teamBPlayerIds, setTeamBPlayerIds] = useState<string[]>([]);

  // nassau
  const [nassauScope, setNassauScope] = useState<'individual' | 'team'>('individual');
  const [nassauMode, setNassauMode] = useState<'stroke' | 'match'>('stroke');

  const defaultName = useMemo(() => {
    const base = formatLabel[format];
    if (format === 'skins') return '$ Skins';
    if (format === 'bestBall') return '$ Best Ball';
    if (format === 'nassau') return '$ Nassau';
    return `$ ${base}`;
  }, [format]);

  const togglePlayer = (playerId: string) => {
    setSkinsPlayerIds(prev => (prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]));
  };

  const toggleTeamPlayer = (team: 'A' | 'B', playerId: string) => {
    if (team === 'A') {
      setTeamAPlayerIds(prev => (prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]));
      setTeamBPlayerIds(prev => prev.filter(id => id !== playerId));
    } else {
      setTeamBPlayerIds(prev => (prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]));
      setTeamAPlayerIds(prev => prev.filter(id => id !== playerId));
    }
  };

  const validate = (): string | null => {
    if (format === 'skins') {
      if (skinsPlayerIds.length < 2) return 'Skins needs at least 2 players.';
    }

    if (format === 'bestBall') {
      if (teamAPlayerIds.length < 1 || teamBPlayerIds.length < 1) return 'Pick players for both teams.';
    }

    if (format === 'nassau') {
      if (nassauScope === 'individual') {
        if (round.players.length < 2) return 'Nassau needs at least 2 players.';
      } else {
        if (teamAPlayerIds.length < 1 || teamBPlayerIds.length < 1) return 'Pick players for both Nassau teams.';
      }
    }

    return null;
  };

  const handleCreate = () => {
    const err = validate();
    if (err) {
      alert(err);
      return;
    }

    const gameId = crypto.randomUUID();

    const base: Game = {
      id: gameId,
      roundId: round.id,
      format,
      name: (name.trim() || defaultName).trim(),
      playerIds: [],
      settings: {},
    };

    if (format === 'skins') {
      onAddGame({
        ...base,
        playerIds: skinsPlayerIds,
        settings: { carryover },
      });
      return;
    }

    if (format === 'bestBall') {
      onAddGame({
        ...base,
        playerIds: [...new Set([...teamAPlayerIds, ...teamBPlayerIds])],
        teams: [
          { id: `${gameId}-A`, name: 'Team A', playerIds: teamAPlayerIds },
          { id: `${gameId}-B`, name: 'Team B', playerIds: teamBPlayerIds },
        ],
        settings: {},
      });
      return;
    }

    if (format === 'nassau') {
      if (nassauScope === 'team') {
        onAddGame({
          ...base,
          playerIds: [...new Set([...teamAPlayerIds, ...teamBPlayerIds])],
          teams: [
            { id: `${gameId}-A`, name: 'Team A', playerIds: teamAPlayerIds },
            { id: `${gameId}-B`, name: 'Team B', playerIds: teamBPlayerIds },
          ],
          settings: { nassauScope, nassauMode },
        });
        return;
      }

      onAddGame({
        ...base,
        playerIds: round.players.map(p => p.id),
        settings: { nassauScope, nassauMode },
      });
      return;
    }

    // stubs: create game with all players
    onAddGame({
      ...base,
      playerIds: round.players.map(p => p.id),
      settings: {},
    });
  };

  const renderPlayerChips = (ids: string[]) => {
    const byId = new Map(round.players.map(p => [p.id, p] as const));
    return ids
      .map(id => byId.get(id)?.name)
      .filter(Boolean)
      .join(', ');
  };

  const players = round.players;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-xl bg-gray-900 border border-gray-700 rounded-t-2xl sm:rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold">Add Game</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded">✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-sm text-gray-400">Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as GameFormat)}
              className="w-full p-3 bg-gray-800 rounded-lg mt-1"
            >
              {Object.keys(formatLabel).map((f) => (
                <option key={f} value={f}>
                  {formatLabel[f as GameFormat]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm text-gray-400">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName}
              className="w-full p-3 bg-gray-800 rounded-lg mt-1"
            />
          </div>

          {format === 'skins' && (
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="text-sm font-semibold mb-2">Players</div>
              <div className="grid grid-cols-2 gap-2">
                {players.map(p => {
                  const selected = skinsPlayerIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => togglePlayer(p.id)}
                      className={`p-2 rounded-lg border ${
                        selected ? 'bg-green-700 border-green-500' : 'bg-gray-900 border-gray-700'
                      }`}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>

              <label className="flex items-center gap-2 mt-3 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={carryover}
                  onChange={(e) => setCarryover(e.target.checked)}
                />
                Carryover on ties
              </label>
            </div>
          )}

          {(format === 'bestBall' || (format === 'nassau' && nassauScope === 'team')) && (
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="text-sm font-semibold mb-2">Teams</div>
              <div className="text-xs text-gray-400 mb-2">
                Tap a player to assign to Team A or Team B.
              </div>
              <div className="grid grid-cols-2 gap-2">
                {players.map(p => {
                  const inA = teamAPlayerIds.includes(p.id);
                  const inB = teamBPlayerIds.includes(p.id);
                  return (
                    <div key={p.id} className="bg-gray-900 rounded-lg p-2 border border-gray-700">
                      <div className="font-medium mb-2">{p.name}</div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => toggleTeamPlayer('A', p.id)}
                          className={`flex-1 p-2 rounded ${inA ? 'bg-green-700' : 'bg-gray-800'}`}
                        >
                          A
                        </button>
                        <button
                          onClick={() => toggleTeamPlayer('B', p.id)}
                          className={`flex-1 p-2 rounded ${inB ? 'bg-blue-700' : 'bg-gray-800'}`}
                        >
                          B
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 text-sm text-gray-300">
                <div><span className="text-gray-400">Team A:</span> {renderPlayerChips(teamAPlayerIds) || '-'}</div>
                <div><span className="text-gray-400">Team B:</span> {renderPlayerChips(teamBPlayerIds) || '-'}</div>
              </div>
            </div>
          )}

          {format === 'nassau' && (
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="text-sm font-semibold mb-2">Nassau Settings</div>

              <div className="flex gap-2">
                <button
                  onClick={() => setNassauScope('individual')}
                  className={`flex-1 p-2 rounded-lg ${nassauScope === 'individual' ? 'bg-green-700' : 'bg-gray-900'}`}
                >
                  Individual
                </button>
                <button
                  onClick={() => setNassauScope('team')}
                  className={`flex-1 p-2 rounded-lg ${nassauScope === 'team' ? 'bg-green-700' : 'bg-gray-900'}`}
                >
                  Team
                </button>
              </div>

              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => setNassauMode('stroke')}
                  className={`flex-1 p-2 rounded-lg ${nassauMode === 'stroke' ? 'bg-green-700' : 'bg-gray-900'}`}
                >
                  Stroke play
                </button>
                <button
                  onClick={() => setNassauMode('match')}
                  className={`flex-1 p-2 rounded-lg ${nassauMode === 'match' ? 'bg-green-700' : 'bg-gray-900'}`}
                  title="Match play scoring not fully implemented yet"
                >
                  Match play (stub)
                </button>
              </div>

              {nassauMode === 'match' && (
                <div className="text-xs text-yellow-300 mt-2">
                  Match-play Nassau is currently stubbed (shows stroke totals for now).
                </div>
              )}
            </div>
          )}

          {(format === 'scramble' || format === 'wolf' || format === 'threePoint') && (
            <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-3 text-sm text-yellow-200">
              {formatLabel[format]} scoring UI is not implemented yet. This will be a stub game for now.
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 p-3 bg-gray-800 rounded-lg">Cancel</button>
          <button onClick={handleCreate} className="flex-1 p-3 bg-green-600 hover:bg-green-700 rounded-lg font-bold">
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
