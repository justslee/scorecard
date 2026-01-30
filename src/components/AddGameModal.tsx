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
  nassau: 'Nassau (Front/Back/Overall)',
  bestBall: 'Best Ball / Four Ball (2v2)',
  scramble: 'Scramble',
  wolf: 'Wolf',
  threePoint: '3-Point System (2v2)',
  stableford: 'Stableford',
  modifiedStableford: 'Modified Stableford',
  matchPlay: 'Match Play',
  bingoBangoBongo: 'Bingo Bango Bongo',
  vegas: 'Vegas',
  hammer: 'Hammer',
  rabbit: 'Rabbit',
  trash: 'Trash / Dots',
  chicago: 'Chicago / Quota',
  defender: 'Defender',
};

export default function AddGameModal({ round, onClose, onAddGame }: AddGameModalProps) {
  const [format, setFormat] = useState<GameFormat>('skins');
  const [name, setName] = useState('');

  // skins
  const [skinsPlayerIds, setSkinsPlayerIds] = useState<string[]>(round.players.map(p => p.id));
  const [carryover, setCarryover] = useState(true);

  // team selection (best ball, team nassau, threePoint)
  const [teamAPlayerIds, setTeamAPlayerIds] = useState<string[]>([]);
  const [teamBPlayerIds, setTeamBPlayerIds] = useState<string[]>([]);

  // nassau
  const [nassauScope, setNassauScope] = useState<'individual' | 'team'>('individual');
  const [nassauMode, setNassauMode] = useState<'stroke' | 'match'>('stroke');

  // match play (1v1)
  const [matchPlayP1, setMatchPlayP1] = useState<string>('');
  const [matchPlayP2, setMatchPlayP2] = useState<string>('');

  // wolf (4 players) order
  const [wolf1, setWolf1] = useState<string>(round.players[0]?.id ?? '');
  const [wolf2, setWolf2] = useState<string>(round.players[1]?.id ?? '');
  const [wolf3, setWolf3] = useState<string>(round.players[2]?.id ?? '');
  const [wolf4, setWolf4] = useState<string>(round.players[3]?.id ?? '');

  // 3-point pairs (A1 vs B1, A2 vs B2)
  const [threeA1, setThreeA1] = useState<string>('');
  const [threeA2, setThreeA2] = useState<string>('');
  const [threeB1, setThreeB1] = useState<string>('');
  const [threeB2, setThreeB2] = useState<string>('');

  const defaultName = useMemo(() => {
    const base = formatLabel[format];
    if (format === 'skins') return '$ Skins';
    if (format === 'bestBall') return '$ Best Ball';
    if (format === 'nassau') return '$ Nassau';
    if (format === 'stableford') return 'Stableford';
    if (format === 'modifiedStableford') return 'Modified Stableford';
    if (format === 'matchPlay') return 'Match Play';
    if (format === 'threePoint') return '3-Point (2v2)';
    return base;
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

    if (format === 'matchPlay') {
      if (!matchPlayP1 || !matchPlayP2) return 'Pick two players for Match Play.';
      if (matchPlayP1 === matchPlayP2) return 'Match Play players must be different.';
    }

    if (format === 'threePoint') {
      if (teamAPlayerIds.length !== 2 || teamBPlayerIds.length !== 2) return '3-Point requires exactly 2 players on each team.';
      const ids = [threeA1, threeA2, threeB1, threeB2];
      if (ids.some(id => !id)) return 'Select A1, A2, B1, B2 pairings.';
      if (new Set(ids).size !== 4) return 'Pairings must be four unique players.';
    }

    if (format === 'wolf') {
      if (round.players.length < 4) return 'Wolf requires 4 players in the round.';
      const ids = [wolf1, wolf2, wolf3, wolf4].filter(Boolean);
      if (ids.length !== 4) return 'Select an order for all 4 wolf players.';
      if (new Set(ids).size !== 4) return 'Wolf order must be 4 unique players.';
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

    if (format === 'matchPlay') {
      onAddGame({
        ...base,
        playerIds: [matchPlayP1, matchPlayP2],
        settings: { matchPlayMode: 'individual', matchPlayPlayers: { player1Id: matchPlayP1, player2Id: matchPlayP2 } },
      });
      return;
    }

    if (format === 'threePoint') {
      onAddGame({
        ...base,
        playerIds: [...new Set([...teamAPlayerIds, ...teamBPlayerIds])],
        teams: [
          { id: `${gameId}-A`, name: 'Team A', playerIds: teamAPlayerIds },
          { id: `${gameId}-B`, name: 'Team B', playerIds: teamBPlayerIds },
        ],
        settings: {
          threePointPairs: {
            teamAPlayer1Id: threeA1,
            teamAPlayer2Id: threeA2,
            teamBPlayer1Id: threeB1,
            teamBPlayer2Id: threeB2,
          },
        },
      });
      return;
    }

    if (format === 'stableford' || format === 'modifiedStableford') {
      onAddGame({
        ...base,
        playerIds: round.players.map(p => p.id),
        settings: {},
      });
      return;
    }

    if (format === 'wolf') {
      const order = [wolf1, wolf2, wolf3, wolf4];
      onAddGame({
        ...base,
        playerIds: order,
        settings: { wolfOrderPlayerIds: order, wolfHoleChoices: {} },
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

          {(format === 'bestBall' || format === 'threePoint' || (format === 'nassau' && nassauScope === 'team')) && (
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="text-sm font-semibold mb-2">Teams</div>
              <div className="text-xs text-gray-400 mb-2">
                Tap a player to assign to Team A or Team B.
                {format === 'threePoint' ? ' (3-Point requires exactly 2 per team)' : ''}
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

              {format === 'threePoint' && (
                <div className="mt-3 bg-gray-900 border border-gray-700 rounded-lg p-3">
                  <div className="text-sm font-semibold mb-2">3-Point Pairings</div>
                  <div className="text-xs text-gray-400 mb-2">
                    A1 vs B1 and A2 vs B2 each worth 1 point; best ball worth 1 point. Ties split (0.5).
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-xs text-gray-400 mb-1">Team A Player 1 (A1)</div>
                      <select
                        value={threeA1}
                        onChange={(e) => setThreeA1(e.target.value)}
                        className="w-full p-2 bg-gray-800 rounded"
                      >
                        <option value="">Select</option>
                        {teamAPlayerIds.map(id => (
                          <option key={id} value={id}>{players.find(p => p.id === id)?.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400 mb-1">Team B Player 1 (B1)</div>
                      <select
                        value={threeB1}
                        onChange={(e) => setThreeB1(e.target.value)}
                        className="w-full p-2 bg-gray-800 rounded"
                      >
                        <option value="">Select</option>
                        {teamBPlayerIds.map(id => (
                          <option key={id} value={id}>{players.find(p => p.id === id)?.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400 mb-1">Team A Player 2 (A2)</div>
                      <select
                        value={threeA2}
                        onChange={(e) => setThreeA2(e.target.value)}
                        className="w-full p-2 bg-gray-800 rounded"
                      >
                        <option value="">Select</option>
                        {teamAPlayerIds.map(id => (
                          <option key={id} value={id}>{players.find(p => p.id === id)?.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400 mb-1">Team B Player 2 (B2)</div>
                      <select
                        value={threeB2}
                        onChange={(e) => setThreeB2(e.target.value)}
                        className="w-full p-2 bg-gray-800 rounded"
                      >
                        <option value="">Select</option>
                        {teamBPlayerIds.map(id => (
                          <option key={id} value={id}>{players.find(p => p.id === id)?.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}
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

          {format === 'matchPlay' && (
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="text-sm font-semibold mb-2">Match Play (1v1)</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-gray-400 mb-1">Player 1</div>
                  <select
                    value={matchPlayP1}
                    onChange={(e) => setMatchPlayP1(e.target.value)}
                    className="w-full p-2 bg-gray-900 rounded border border-gray-700"
                  >
                    <option value="">Select</option>
                    {players.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs text-gray-400 mb-1">Player 2</div>
                  <select
                    value={matchPlayP2}
                    onChange={(e) => setMatchPlayP2(e.target.value)}
                    className="w-full p-2 bg-gray-900 rounded border border-gray-700"
                  >
                    <option value="">Select</option>
                    {players.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {format === 'wolf' && (
            <div className="bg-gray-800 rounded-lg p-3">
              <div className="text-sm font-semibold mb-2">Wolf Order (4 players)</div>
              <div className="text-xs text-gray-400 mb-2">
                Wolf rotates each hole: 1,2,3,4,1,2,3,4...
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-gray-400 mb-1">Position 1</div>
                  <select value={wolf1} onChange={(e) => setWolf1(e.target.value)} className="w-full p-2 bg-gray-900 rounded border border-gray-700">
                    {players.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs text-gray-400 mb-1">Position 2</div>
                  <select value={wolf2} onChange={(e) => setWolf2(e.target.value)} className="w-full p-2 bg-gray-900 rounded border border-gray-700">
                    {players.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs text-gray-400 mb-1">Position 3</div>
                  <select value={wolf3} onChange={(e) => setWolf3(e.target.value)} className="w-full p-2 bg-gray-900 rounded border border-gray-700">
                    {players.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs text-gray-400 mb-1">Position 4</div>
                  <select value={wolf4} onChange={(e) => setWolf4(e.target.value)} className="w-full p-2 bg-gray-900 rounded border border-gray-700">
                    {players.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="text-xs text-gray-400 mt-2">Partner / Lone Wolf can be set hole-by-hole in the game results.</div>
            </div>
          )}

          {(format === 'scramble' || format === 'bingoBangoBongo' || format === 'vegas' || format === 'hammer' || format === 'rabbit' || format === 'trash' || format === 'chicago' || format === 'defender') && (
            <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-3 text-sm text-yellow-200">
              {formatLabel[format]} is included but not fully implemented yet.
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
