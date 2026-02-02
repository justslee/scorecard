'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Plus, User, Search, X, Check } from 'lucide-react';
import { SavedPlayer } from '@/lib/types';
import { getSavedPlayers, saveSavedPlayer, deleteSavedPlayer, initializeStorage } from '@/lib/storage';
import SwipeableRow from '@/components/SwipeableRow';

export default function PlayersPage() {
  const [players, setPlayers] = useState<SavedPlayer[]>([]);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<SavedPlayer | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    initializeStorage();
    setPlayers(getSavedPlayers());
    setLoaded(true);
  }, []);

  const filteredPlayers = players.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.nickname?.toLowerCase().includes(search.toLowerCase()) ||
      p.email?.toLowerCase().includes(search.toLowerCase())
  );

  const handleDelete = (id: string) => {
    deleteSavedPlayer(id);
    setPlayers(getSavedPlayers());
  };

  const handleSave = (player: SavedPlayer) => {
    saveSavedPlayer(player);
    setPlayers(getSavedPlayers());
    setShowModal(false);
    setEditingPlayer(null);
  };

  const openNewPlayer = () => {
    setEditingPlayer(null);
    setShowModal(true);
  };

  const openEditPlayer = (player: SavedPlayer) => {
    setEditingPlayer(player);
    setShowModal(true);
  };

  if (!loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-emerald-500/80" />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center gap-3">
            <Link href="/profile" className="btn btn-icon" aria-label="Back">
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            </Link>
            <h1 className="text-xl font-semibold tracking-tight">My Players</h1>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-28">
        {/* Search & Add */}
        <div className="flex gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search players..."
              className="w-full pl-10 pr-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7 focus:border-white/20 focus:outline-none transition-colors placeholder:text-zinc-500"
            />
          </div>
          <button onClick={openNewPlayer} className="btn btn-primary px-4">
            <Plus className="h-5 w-5" />
          </button>
        </div>

        {/* Player List */}
        {filteredPlayers.length === 0 ? (
          <div className="card p-8 text-center">
            <div className="flex justify-center">
              <User className="h-12 w-12 text-zinc-600" aria-hidden="true" />
            </div>
            <p className="mt-4 text-zinc-300 font-medium">
              {search ? 'No players found' : 'No players yet'}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              {search ? 'Try a different search' : 'Add players to your network for quick scoring'}
            </p>
            {!search && (
              <button onClick={openNewPlayer} className="btn btn-primary mt-4">
                + Add First Player
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredPlayers.map((player, index) => (
              <motion.div
                key={player.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: index * 0.03 }}
              >
                <SwipeableRow onDelete={() => handleDelete(player.id)}>
                  <motion.div
                    whileTap={{ scale: 0.98 }}
                    onClick={() => openEditPlayer(player)}
                    className="card card-hover p-4 cursor-pointer"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-white/10 flex items-center justify-center flex-shrink-0">
                        {player.avatarUrl ? (
                          <img
                            src={player.avatarUrl}
                            alt={player.name}
                            className="w-full h-full rounded-full object-cover"
                          />
                        ) : (
                          <span className="text-lg font-semibold text-emerald-300">
                            {player.name.charAt(0).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-lg tracking-tight truncate">
                          {player.name}
                        </h3>
                        {player.nickname && (
                          <p className="text-zinc-400 text-sm truncate">&quot;{player.nickname}&quot;</p>
                        )}
                        <div className="flex items-center gap-3 mt-1 flex-wrap">
                          {player.handicap !== undefined && (
                            <span className="text-xs text-zinc-500">
                              HCP: {player.handicap}
                            </span>
                          )}
                          {player.roundsPlayed > 0 && (
                            <span className="text-xs text-zinc-500">
                              {player.roundsPlayed} rounds
                            </span>
                          )}
                        </div>
                      </div>
                      {player.clerkUserId && (
                        <div className="flex-shrink-0">
                          <span className="px-2 py-1 rounded-full text-xs bg-emerald-500/10 border border-emerald-400/20 text-emerald-300">
                            Linked
                          </span>
                        </div>
                      )}
                    </div>
                  </motion.div>
                </SwipeableRow>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      {/* Add/Edit Modal */}
      <AnimatePresence>
        {showModal && (
          <PlayerModal
            player={editingPlayer}
            onSave={handleSave}
            onClose={() => {
              setShowModal(false);
              setEditingPlayer(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

interface PlayerModalProps {
  player: SavedPlayer | null;
  onSave: (player: SavedPlayer) => void;
  onClose: () => void;
}

function PlayerModal({ player, onSave, onClose }: PlayerModalProps) {
  const [name, setName] = useState(player?.name || '');
  const [nickname, setNickname] = useState(player?.nickname || '');
  const [email, setEmail] = useState(player?.email || '');
  const [phone, setPhone] = useState(player?.phone || '');
  const [handicap, setHandicap] = useState(player?.handicap?.toString() || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const savedPlayer: SavedPlayer = {
      id: player?.id || crypto.randomUUID(),
      name: name.trim(),
      nickname: nickname.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      handicap: handicap ? parseFloat(handicap) : undefined,
      clerkUserId: player?.clerkUserId,
      avatarUrl: player?.avatarUrl,
      roundsPlayed: player?.roundsPlayed || 0,
      createdAt: player?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    onSave(savedPlayer);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
    >
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, y: 100 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 100 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="relative w-full max-w-lg mx-4 mb-4 sm:mb-0"
      >
        <div className="card p-6 max-h-[85vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold">
              {player ? 'Edit Player' : 'Add Player'}
            </h2>
            <button onClick={onClose} className="btn btn-icon">
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">
                Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="John Smith"
                className="input w-full"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">
                Nickname
              </label>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="Johnny"
                className="input w-full"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="john@example.com"
                className="input w-full"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">
                Phone
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 123 4567"
                className="input w-full"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-400 mb-1">
                Handicap
              </label>
              <input
                type="number"
                step="0.1"
                value={handicap}
                onChange={(e) => setHandicap(e.target.value)}
                placeholder="12.5"
                className="input w-full"
              />
            </div>

            <div className="flex gap-3 pt-4">
              <button type="button" onClick={onClose} className="btn flex-1">
                Cancel
              </button>
              <button type="submit" className="btn btn-primary flex-1">
                <Check className="h-5 w-5 mr-2" />
                {player ? 'Save' : 'Add Player'}
              </button>
            </div>
          </form>
        </div>
      </motion.div>
    </motion.div>
  );
}
