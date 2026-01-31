'use client';

import { useMemo, useState } from 'react';
import { Game, GameFormat, Round } from '@/lib/types';
import { X } from 'lucide-react';

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
  const [skinsPlayerIds, setSkinsPlayerIds] = useState<string[]>(round.players.map((p) => p.id));
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
    setSkinsPlayerIds((prev) => (prev.includes(playerId) ? prev.filter((id) => id !== playerId) : [...prev, playerId]));
  };

  const toggleTeamPlayer = (team: 'A' | 'B', playerId: string) => {
    if (team === 'A') {
      setTeamAPlayerIds((prev) => (prev.includes(playerId) ? prev.filter((id) => id !== playerId) : [...prev, playerId]));
      setTeamBPlayerIds((prev) => prev.filter((id) => id !== playerId));
    } else {
      setTeamBPlayerIds((prev) => (prev.includes(playerId) ? prev.filter((id) => id !== playerId) : [...prev, playerId]));
      setTeamAPlayerIds((prev) => prev.filter((id) => id !== playerId));
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
      if (ids.some((id) => !id)) return 'Select A1, A2, B1, B2 pairings.';
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
      onAddGame({ ...base, playerIds: skinsPlayerIds, settings: { carryover } });
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
        playerIds: round.players.map((p) => p.id),
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
      onAddGame({ ...base, playerIds: round.players.map((p) => p.id), settings: {} });
      return;
    }

    if (format === 'wolf') {
      const order = [wolf1, wolf2, wolf3, wolf4];
      onAddGame({ ...base, playerIds: order, settings: { wolfOrderPlayerIds: order, wolfHoleChoices: {} } });
      return;
    }

    onAddGame({ ...base, playerIds: round.players.map((p) => p.id), settings: {} });
  };

  const renderPlayerChips = (ids: string[]) => {
    const byId = new Map(round.players.map((p) => [p.id, p] as const));
    return ids
      .map((id) => byId.get(id)?.name)
      .filter(Boolean)
      .join(', ');
  };

  const players = round.players;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-2">
      <div className="w-full sm:max-w-xl card p-4 sm:p-5 rounded-t-3xl sm:rounded-3xl">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Add Game</h2>
            <p className="text-sm text-zinc-400">Choose a format and configure players.</p>
          </div>
          <button onClick={onClose} className="btn btn-icon" aria-label="Close">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase">Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as GameFormat)}
              className="w-full mt-2 px-4 py-3 rounded-2xl bg-white/5 border border-white/10"
            >
              {Object.keys(formatLabel).map((f) => (
                <option key={f} value={f}>
                  {formatLabel[f as GameFormat]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultName}
              className="w-full mt-2 px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
            />
          </div>

          {format === 'skins' && (
            <div className="rounded-2xl bg-white/4 border border-white/10 p-4">
              <div className="text-sm font-semibold mb-2">Players</div>
              <div className="grid grid-cols-2 gap-2">
                {players.map((p) => {
                  const selected = skinsPlayerIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => togglePlayer(p.id)}
                      className={`px-3 py-2 rounded-2xl border text-sm font-medium transition-all duration-150 ${
                        selected
                          ? 'bg-emerald-500/10 border-emerald-400/25 text-emerald-100'
                          : 'bg-white/3 border-white/10 text-zinc-200 hover:bg-white/5'
                      }`}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>

              <label className="flex items-center gap-2 mt-3 text-sm text-zinc-300">
                <input type="checkbox" checked={carryover} onChange={(e) => setCarryover(e.target.checked)} />
                Carryover on ties
              </label>
            </div>
          )}

          {(format === 'bestBall' || format === 'threePoint' || (format === 'nassau' && nassauScope === 'team')) && (
            <div className="rounded-2xl bg-white/4 border border-white/10 p-4">
              <div className="text-sm font-semibold mb-1">Teams</div>
              <div className="text-xs text-zinc-500 mb-3">
                Tap a player to assign to Team A or Team B.
                {format === 'threePoint' ? ' (3-Point requires exactly 2 per team)' : ''}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {players.map((p) => {
                  const inA = teamAPlayerIds.includes(p.id);
                  const inB = teamBPlayerIds.includes(p.id);
                  return (
                    <div key={p.id} className="rounded-2xl p-3 border border-white/10 bg-white/3">
                      <div className="font-medium text-zinc-200 mb-2">{p.name}</div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => toggleTeamPlayer('A', p.id)}
                          className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-colors ${
                            inA ? 'bg-emerald-500/20 text-emerald-100' : 'bg-white/4 text-zinc-200 hover:bg-white/6'
                          }`}
                        >
                          A
                        </button>
                        <button
                          onClick={() => toggleTeamPlayer('B', p.id)}
                          className={`flex-1 rounded-xl py-2 text-sm font-semibold transition-colors ${
                            inB ? 'bg-sky-500/20 text-sky-100' : 'bg-white/4 text-zinc-200 hover:bg-white/6'
                          }`}
                        >
                          B
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 text-sm text-zinc-300">
                <div>
                  <span className="text-zinc-500">Team A:</span> {renderPlayerChips(teamAPlayerIds) || '–'}
                </div>
                <div>
                  <span className="text-zinc-500">Team B:</span> {renderPlayerChips(teamBPlayerIds) || '–'}
                </div>
              </div>

              {format === 'threePoint' && (
                <div className="mt-3 rounded-2xl bg-white/3 border border-white/10 p-4">
                  <div className="text-sm font-semibold mb-2">3-Point Pairings</div>
                  <div className="text-xs text-zinc-500 mb-3">
                    A1 vs B1 and A2 vs B2 each worth 1 point; best ball worth 1 point. Ties split (0.5).
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-xs text-zinc-500 mb-1">Team A Player 1 (A1)</div>
                      <select value={threeA1} onChange={(e) => setThreeA1(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                        <option value="">Select</option>
                        {teamAPlayerIds.map((id) => (
                          <option key={id} value={id}>
                            {players.find((p) => p.id === id)?.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-zinc-500 mb-1">Team B Player 1 (B1)</div>
                      <select value={threeB1} onChange={(e) => setThreeB1(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                        <option value="">Select</option>
                        {teamBPlayerIds.map((id) => (
                          <option key={id} value={id}>
                            {players.find((p) => p.id === id)?.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-zinc-500 mb-1">Team A Player 2 (A2)</div>
                      <select value={threeA2} onChange={(e) => setThreeA2(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                        <option value="">Select</option>
                        {teamAPlayerIds.map((id) => (
                          <option key={id} value={id}>
                            {players.find((p) => p.id === id)?.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="text-xs text-zinc-500 mb-1">Team B Player 2 (B2)</div>
                      <select value={threeB2} onChange={(e) => setThreeB2(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                        <option value="">Select</option>
                        {teamBPlayerIds.map((id) => (
                          <option key={id} value={id}>
                            {players.find((p) => p.id === id)?.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {format === 'nassau' && (
            <div className="rounded-2xl bg-white/4 border border-white/10 p-4">
              <div className="text-sm font-semibold mb-2">Nassau Settings</div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setNassauScope('individual')}
                  className={`rounded-2xl py-2 text-sm font-semibold ${nassauScope === 'individual' ? 'bg-emerald-500/20 text-emerald-100' : 'bg-white/4 text-zinc-200 hover:bg-white/6'}`}
                >
                  Individual
                </button>
                <button
                  onClick={() => setNassauScope('team')}
                  className={`rounded-2xl py-2 text-sm font-semibold ${nassauScope === 'team' ? 'bg-emerald-500/20 text-emerald-100' : 'bg-white/4 text-zinc-200 hover:bg-white/6'}`}
                >
                  Team
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-2">
                <button
                  onClick={() => setNassauMode('stroke')}
                  className={`rounded-2xl py-2 text-sm font-semibold ${nassauMode === 'stroke' ? 'bg-emerald-500/20 text-emerald-100' : 'bg-white/4 text-zinc-200 hover:bg-white/6'}`}
                >
                  Stroke play
                </button>
                <button
                  onClick={() => setNassauMode('match')}
                  className={`rounded-2xl py-2 text-sm font-semibold ${nassauMode === 'match' ? 'bg-emerald-500/20 text-emerald-100' : 'bg-white/4 text-zinc-200 hover:bg-white/6'}`}
                  title="Match play scoring not fully implemented yet"
                >
                  Match play (stub)
                </button>
              </div>

              {nassauMode === 'match' && <div className="text-xs text-amber-200 mt-2">Match-play Nassau is currently stubbed (shows stroke totals for now).</div>}
            </div>
          )}

          {format === 'matchPlay' && (
            <div className="rounded-2xl bg-white/4 border border-white/10 p-4">
              <div className="text-sm font-semibold mb-2">Match Play (1v1)</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Player 1</div>
                  <select value={matchPlayP1} onChange={(e) => setMatchPlayP1(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                    <option value="">Select</option>
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Player 2</div>
                  <select value={matchPlayP2} onChange={(e) => setMatchPlayP2(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                    <option value="">Select</option>
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {format === 'wolf' && (
            <div className="rounded-2xl bg-white/4 border border-white/10 p-4">
              <div className="text-sm font-semibold mb-2">Wolf Order (4 players)</div>
              <div className="text-xs text-zinc-500 mb-3">Wolf rotates each hole: 1,2,3,4,1,2,3,4…</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Position 1</div>
                  <select value={wolf1} onChange={(e) => setWolf1(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Position 2</div>
                  <select value={wolf2} onChange={(e) => setWolf2(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Position 3</div>
                  <select value={wolf3} onChange={(e) => setWolf3(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-xs text-zinc-500 mb-1">Position 4</div>
                  <select value={wolf4} onChange={(e) => setWolf4(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10">
                    {players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="text-xs text-zinc-500 mt-2">Partner / Lone Wolf can be set hole-by-hole in the game results.</div>
            </div>
          )}

          {(format === 'scramble' ||
            format === 'bingoBangoBongo' ||
            format === 'vegas' ||
            format === 'hammer' ||
            format === 'rabbit' ||
            format === 'trash' ||
            format === 'chicago' ||
            format === 'defender') && (
            <div className="rounded-2xl bg-amber-500/10 border border-amber-400/20 p-4 text-sm text-amber-100">
              {formatLabel[format]} is included but not fully implemented yet.
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn btn-secondary flex-1">
            Cancel
          </button>
          <button onClick={handleCreate} className="btn btn-primary flex-1">
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
