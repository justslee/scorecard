'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { SavedPlayer } from '@/lib/types';

// ── Inline icons — no lucide-react ───────────────────────────────────────────

function ArrowLeftIcon({ size = 24, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </svg>
  );
}

function PlusIcon({ size = 24, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function SearchIcon({ size = 24, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function XIcon({ size = 24, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function CheckIcon({ size = 24, style }: { size?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
import {
  getPlayersAsync,
  createPlayerAsync,
  updatePlayerAsync,
  deletePlayerAsync,
} from '@/lib/storage-api';
import type { PlayerCreate, PlayerUpdate } from '@/lib/api';
import { playerHref } from '@/lib/player-url';
import { T, PAPER_NOISE } from '@/components/yardage/tokens';
import SwipeableRow from '@/components/SwipeableRow';

// ── Form data shape passed from modal to page ────────────────────────────────

interface PlayerFormData {
  name: string;
  nickname?: string;
  email?: string;
  phone?: string;
  handicap?: number;
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PlayersPage() {
  const router = useRouter();
  const [players, setPlayers] = useState<SavedPlayer[]>([]);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<SavedPlayer | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const remote = await getPlayersAsync();
        setPlayers(remote);
      } catch (e) {
        console.error('[players] load error:', e);
        setLoadError('Could not load players. Check your connection and try again.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filteredPlayers = players.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.nickname?.toLowerCase().includes(search.toLowerCase()) ||
      p.email?.toLowerCase().includes(search.toLowerCase())
  );

  // ── Delete — optimistic remove; rollback on API error ────────────────────
  const handleDelete = async (id: string) => {
    const removed = players.find((p) => p.id === id);
    setPlayers((ps) => ps.filter((p) => p.id !== id));
    setDeleteError(null);
    try {
      await deletePlayerAsync(id);
    } catch (e) {
      // Rollback: put the player back at the top (closest to its original position).
      if (removed) {
        setPlayers((ps) => [removed, ...ps.filter((p) => p.id !== id)]);
      }
      setDeleteError(
        e instanceof Error ? e.message : 'Could not delete player. Try again.'
      );
    }
  };

  // ── Save (create or update) — API authoritative; errors bubble to modal ──
  const handleSave = async (data: PlayerFormData): Promise<void> => {
    if (editingPlayer) {
      const payload: PlayerUpdate = {
        name: data.name,
        nickname: data.nickname,
        email: data.email,
        phone: data.phone,
        handicap: data.handicap,
      };
      const updated = await updatePlayerAsync(editingPlayer.id, payload);
      setPlayers((ps) => ps.map((p) => (p.id === editingPlayer.id ? updated : p)));
    } else {
      const payload: PlayerCreate = {
        name: data.name,
        nickname: data.nickname,
        email: data.email,
        phone: data.phone,
        handicap: data.handicap,
      };
      const created = await createPlayerAsync(payload);
      setPlayers((ps) => [created, ...ps]);
    }
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

  // ── Loading state ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: `${PAPER_NOISE}, ${T.paper}`,
          backgroundBlendMode: 'multiply',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: T.mono,
          fontSize: 10,
          letterSpacing: 1.6,
          color: T.pencilSoft,
          textTransform: 'uppercase',
        }}
      >
        Loading&hellip;
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: 'multiply',
        fontFamily: T.sans,
        color: T.ink,
        paddingBottom: 'calc(88px + env(safe-area-inset-bottom, 0px))',
      }}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 30,
          background: `color-mix(in oklab, ${T.paper} 88%, transparent)`,
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          borderBottom: `1px solid ${T.hairline}`,
          padding: 'max(14px, env(safe-area-inset-top)) 20px 14px',
        }}
      >
        <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link
            href="/profile"
            aria-label="Back to profile"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              borderRadius: '50%',
              border: `1px solid ${T.hairline}`,
              background: T.paper,
              color: T.ink,
              flexShrink: 0,
            }}
          >
            <ArrowLeftIcon size={18} />
          </Link>
          <h1
            style={{
              fontFamily: T.serif,
              fontSize: 22,
              fontWeight: 400,
              letterSpacing: '-0.01em',
              color: T.ink,
              margin: 0,
            }}
          >
            My Players
          </h1>
        </div>
      </header>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      <main style={{ maxWidth: 560, margin: '0 auto', padding: '20px 20px 0' }}>

        {/* Error banners */}
        {loadError && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              marginBottom: 16,
              borderRadius: 12,
              background: T.errorWash,
              border: `1px solid ${T.errorInk}30`,
              color: T.errorInk,
              fontSize: 13,
            }}
          >
            {loadError}
          </div>
        )}
        {deleteError && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              marginBottom: 16,
              borderRadius: 12,
              background: T.errorWash,
              border: `1px solid ${T.errorInk}30`,
              color: T.errorInk,
              fontSize: 13,
            }}
          >
            {deleteError}
          </div>
        )}

        {/* Search & Add */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <SearchIcon
              size={16}
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                color: T.pencil,
                pointerEvents: 'none',
              }}
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search players…"
              aria-label="Search players"
              style={{
                width: '100%',
                padding: '11px 14px 11px 36px',
                borderRadius: 12,
                border: `1px solid ${T.hairline}`,
                background: T.paperDeep,
                color: T.ink,
                fontFamily: T.sans,
                fontSize: 15,
                outline: 'none',
              }}
            />
          </div>
          <button
            onClick={openNewPlayer}
            aria-label="Add player"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              borderRadius: 12,
              border: `1px solid ${T.ink}`,
              background: T.ink,
              color: T.paper,
              flexShrink: 0,
              cursor: 'pointer',
            }}
          >
            <PlusIcon size={20} />
          </button>
        </div>

        {/* Player list */}
        {filteredPlayers.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '40px 0',
            }}
          >
            <p
              style={{
                fontFamily: T.serif,
                fontStyle: 'italic',
                fontSize: 14,
                color: T.pencilSoft,
                letterSpacing: -0.1,
                margin: '0 0 6px',
              }}
            >
              {search ? 'No players found.' : 'No players yet.'}
            </p>
            <p
              style={{
                fontFamily: T.sans,
                fontSize: 13,
                color: T.pencilSoft,
                margin: '0 0 20px',
              }}
            >
              {search
                ? 'Try a different search.'
                : 'Add the people you golf with.'}
            </p>
            {!search && (
              <button
                onClick={openNewPlayer}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 24px',
                  minHeight: 44,
                  borderRadius: 999,
                  border: `1px solid ${T.hairline}`,
                  background: 'transparent',
                  color: T.ink,
                  fontFamily: T.mono,
                  fontSize: 10,
                  letterSpacing: 1.3,
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
              >
                Add First Player
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filteredPlayers.map((player, index) => (
              <motion.div
                key={player.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: index * 0.025 }}
              >
                <SwipeableRow
                  onDelete={() => handleDelete(player.id)}
                  confirmMessage={`Remove ${player.name} from your players?`}
                >
                  <motion.button
                    whileTap={{ scale: 0.985 }}
                    onClick={() => router.push(playerHref(player.id))}
                    aria-label={`View ${player.name}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
                      width: '100%',
                      padding: '14px 16px',
                      borderRadius: 14,
                      border: `1px solid ${T.hairline}`,
                      background: T.paper,
                      color: T.ink,
                      textAlign: 'left',
                      cursor: 'pointer',
                      minHeight: 68, // well above 44pt
                    }}
                  >
                    {/* Avatar */}
                    <div
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: '50%',
                        border: `1px solid ${T.hairline}`,
                        background: T.paperDeep,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        fontFamily: T.serif,
                        fontSize: 20,
                        color: T.inkSoft,
                      }}
                    >
                      {player.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- avatar from user-provided URL; next/image requires known domains
                        <img
                          src={player.avatarUrl}
                          alt={player.name}
                          style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
                        />
                      ) : (
                        player.name.charAt(0).toUpperCase()
                      )}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontFamily: T.serif,
                          fontSize: 16,
                          letterSpacing: -0.2,
                          color: T.ink,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {player.name}
                        {player.nickname && (
                          <span style={{ fontStyle: 'italic', color: T.pencil, fontWeight: 400, marginLeft: 6 }}>
                            &ldquo;{player.nickname}&rdquo;
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 10, marginTop: 3, flexWrap: 'wrap' }}>
                        {player.handicap !== undefined && (
                          <span style={{ fontSize: 12, fontFamily: T.mono, color: T.pencil }}>
                            HCP {player.handicap}
                          </span>
                        )}
                        {player.roundsPlayed > 0 && (
                          <span style={{ fontSize: 12, color: T.pencilSoft }}>
                            {player.roundsPlayed} rounds
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Linked badge */}
                    {player.clerkUserId && (
                      <span
                        style={{
                          fontSize: 11,
                          fontFamily: T.mono,
                          letterSpacing: '0.08em',
                          textTransform: 'uppercase',
                          color: T.pencil,
                          border: `1px solid ${T.hairline}`,
                          borderRadius: 999,
                          padding: '2px 8px',
                          flexShrink: 0,
                        }}
                      >
                        Linked
                      </span>
                    )}

                    {/* Edit control — span (not button) to avoid nested <button> invalid HTML */}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit ${player.name}`}
                      onClick={(e) => { e.stopPropagation(); openEditPlayer(player); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          openEditPlayer(player);
                        }
                      }}
                      style={{
                        fontFamily: T.mono,
                        fontSize: 9,
                        letterSpacing: 1.3,
                        textTransform: 'uppercase',
                        color: T.pencilSoft,
                        cursor: 'pointer',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minWidth: 44,
                        minHeight: 44,
                        paddingLeft: 8,
                      }}
                    >
                      Edit
                    </span>
                  </motion.button>
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

// ── Modal ─────────────────────────────────────────────────────────────────────

interface PlayerModalProps {
  player: SavedPlayer | null;
  /** Async — stays open on error, surfaces message inside the modal. */
  onSave: (data: PlayerFormData) => Promise<void>;
  onClose: () => void;
}

function PlayerModal({ player, onSave, onClose }: PlayerModalProps) {
  const [name, setName] = useState(player?.name ?? '');
  const [nickname, setNickname] = useState(player?.nickname ?? '');
  const [email, setEmail] = useState(player?.email ?? '');
  const [phone, setPhone] = useState(player?.phone ?? '');
  const [handicap, setHandicap] = useState(player?.handicap?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        nickname: nickname.trim() || undefined,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        handicap: handicap ? parseFloat(handicap) : undefined,
      });
      // onSave closes the modal on success; nothing else to do.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save player. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: `1px solid ${T.hairline}`,
    background: T.paperDeep,
    color: T.ink,
    fontFamily: T.sans,
    fontSize: 15,
    outline: 'none',
    opacity: saving ? 0.6 : 1,
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12,
    fontFamily: T.mono,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: T.pencil,
    marginBottom: 6,
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{
        position: 'fixed',
        inset: 0,
        // above CaddieOrb (50); scrim covers it, below LooperSheet (60)
        zIndex: 52,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
      }}
    >
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(26,42,26,0.35)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
      />

      {/* Sheet */}
      <motion.div
        initial={{ opacity: 0, y: 80 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 80 }}
        transition={T.spring}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 520,
          margin: '0 12px',
          marginBottom: 'max(16px, env(safe-area-inset-bottom))',
          background: T.paper,
          borderRadius: 20,
          border: `1px solid ${T.hairline}`,
          padding: 24,
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontFamily: T.serif, fontSize: 20, fontWeight: 400, color: T.ink, margin: 0 }}>
            {player ? 'Edit Player' : 'Add Player'}
          </h2>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              borderRadius: '50%',
              border: `1px solid ${T.hairline}`,
              background: T.paperDeep,
              color: T.inkSoft,
              cursor: 'pointer',
              opacity: saving ? 0.5 : 1,
            }}
          >
            <XIcon size={18} />
          </button>
        </div>

        {/* Error */}
        {error && (
          <div
            role="alert"
            style={{
              padding: '10px 14px',
              marginBottom: 16,
              borderRadius: 10,
              background: T.errorWash,
              border: `1px solid ${T.errorInk}30`,
              color: T.errorInk,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label htmlFor="player-name" style={labelStyle}>Name *</label>
            <input
              id="player-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Smith"
              required
              disabled={saving}
              style={inputStyle}
            />
          </div>

          <div>
            <label htmlFor="player-nickname" style={labelStyle}>Nickname</label>
            <input
              id="player-nickname"
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Johnny"
              disabled={saving}
              style={inputStyle}
            />
          </div>

          <div>
            <label htmlFor="player-email" style={labelStyle}>Email</label>
            <input
              id="player-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@example.com"
              disabled={saving}
              style={inputStyle}
            />
          </div>

          <div>
            <label htmlFor="player-phone" style={labelStyle}>Phone</label>
            <input
              id="player-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 123 4567"
              disabled={saving}
              style={inputStyle}
            />
          </div>

          <div>
            <label htmlFor="player-handicap" style={labelStyle}>Handicap</label>
            <input
              id="player-handicap"
              type="number"
              step="0.1"
              value={handicap}
              onChange={(e) => setHandicap(e.target.value)}
              placeholder="12.5"
              disabled={saving}
              style={inputStyle}
            />
          </div>

          <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                flex: 1,
                padding: '12px 0',
                borderRadius: 999,
                border: `1px solid ${T.hairline}`,
                background: T.paperDeep,
                color: T.inkSoft,
                fontFamily: T.sans,
                fontSize: 15,
                fontWeight: 500,
                cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? 0.5 : 1,
                minHeight: 44,
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '12px 0',
                borderRadius: 999,
                border: 'none',
                background: T.ink,
                color: T.paper,
                fontFamily: T.sans,
                fontSize: 15,
                fontWeight: 500,
                cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? 0.7 : 1,
                minHeight: 44,
              }}
            >
              {saving ? (
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: `2px solid ${T.paper}40`,
                    borderTopColor: T.paper,
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
              ) : (
                <>
                  <CheckIcon size={16} />
                  {player ? 'Save' : 'Add Player'}
                </>
              )}
            </button>
          </div>
        </form>
      </motion.div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </motion.div>
  );
}
