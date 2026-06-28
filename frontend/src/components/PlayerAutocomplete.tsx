'use client';

/**
 * PlayerAutocomplete — yardage-book styled player name input with suggestion dropdown.
 *
 * Rebuilt with T.* tokens and inline SVGs. No Tailwind, no lucide-react, no dark theme.
 */

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { T, DEFAULT_ACCENT } from '@/components/yardage/tokens';
import { SavedPlayer, Player } from '@/lib/types';

interface PlayerAutocompleteProps {
  value: Player;
  index: number; // Position in the players array (for stable ID generation)
  savedPlayers: SavedPlayer[];
  selectedIds: string[]; // IDs already in the round (to exclude from suggestions)
  placeholder?: string;
  onChange: (player: Player) => void;
  onRemove?: () => void;
  canRemove?: boolean;
}

// ---------------------------------------------------------------------------
// Inline icons
// ---------------------------------------------------------------------------

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 2l10 10M12 2L2 12" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PlayerAutocomplete({
  value,
  index,
  savedPlayers,
  selectedIds,
  placeholder = 'Player name',
  onChange,
  onRemove,
  canRemove = true,
}: PlayerAutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value.name);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Stable ID for custom (non-saved) players based on position
  const customPlayerId = `custom-player-${index}`;

  // Check if current player is from saved players
  const isLinkedPlayer = savedPlayers.some((sp) => sp.id === value.id);

  // Filter available players (not already selected by other inputs)
  const selectedSavedIds = selectedIds.filter((id) => !id.startsWith('custom-player-'));
  const availablePlayers = savedPlayers.filter(
    (sp) => !selectedSavedIds.includes(sp.id) || sp.id === value.id
  );

  const getSuggestions = (): SavedPlayer[] => {
    if (!inputValue.trim()) {
      return availablePlayers.slice(0, 10);
    }
    const lower = inputValue.toLowerCase();
    return availablePlayers
      .filter((sp) => {
        return (
          sp.name.toLowerCase().includes(lower) ||
          sp.nickname?.toLowerCase().includes(lower) ||
          sp.email?.toLowerCase().includes(lower)
        );
      })
      .sort((a, b) => {
        const aStartsWith = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
        const bStartsWith = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
        return aStartsWith - bStartsWith;
      })
      .slice(0, 8);
  };

  const suggestions = isOpen ? getSuggestions() : [];

  // Sync inputValue with the value prop using the React "store previous prop" pattern.
  // Using a second useState instead of useRef avoids both the set-state-in-effect and
  // the refs-during-render lint rules while keeping React's expected re-render semantics.
  const [prevValueName, setPrevValueName] = useState(value.name);
  if (prevValueName !== value.name) {
    setPrevValueName(value.name);
    setInputValue(value.name);
    setHighlightedIndex(0);
  }

  // Scroll highlighted item into view
  useEffect(() => {
    if (listRef.current && highlightedIndex >= 0) {
      const items = listRef.current.querySelectorAll('[data-suggestion]');
      const item = items[highlightedIndex] as HTMLElement;
      if (item) item.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setHighlightedIndex(0);
    setIsOpen(true);
    onChange({ id: customPlayerId, name: newValue });
  };

  const handleSelectPlayer = (savedPlayer: SavedPlayer) => {
    const player: Player = {
      id: savedPlayer.id,
      name: savedPlayer.name,
      handicap: savedPlayer.handicap,
    };
    onChange(player);
    setInputValue(savedPlayer.name);
    setIsOpen(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || suggestions.length === 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setIsOpen(true);
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (suggestions[highlightedIndex]) handleSelectPlayer(suggestions[highlightedIndex]);
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        break;
      case 'Tab':
        setIsOpen(false);
        break;
    }
  };

  const handleFocus = () => {
    setIsOpen(true);
    setHighlightedIndex(0);
  };

  const handleBlur = () => {
    setTimeout(() => setIsOpen(false), 150);
  };

  // Highlight matching text — uses inline style, not Tailwind class
  const highlightMatch = (text: string, query: string) => {
    if (!query.trim()) return <>{text}</>;
    const lower = text.toLowerCase();
    const queryLower = query.toLowerCase();
    const idx = lower.indexOf(queryLower);
    if (idx === -1) return <>{text}</>;
    return (
      <>
        {text.slice(0, idx)}
        <span style={{ color: DEFAULT_ACCENT, fontWeight: 600 }}>
          {text.slice(idx, idx + query.length)}
        </span>
        {text.slice(idx + query.length)}
      </>
    );
  };

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {/* Input wrapper */}
        <div style={{ position: 'relative', flex: 1 }}>
          {/* Linked-player check badge */}
          {isLinkedPlayer && (
            <div
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
                width: 20,
                height: 20,
                borderRadius: 99,
                border: `1px solid ${T.hairline}`,
                background: T.paperDeep,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: T.mono,
                fontSize: 9,
                color: DEFAULT_ACCENT,
              }}
            >
              ✓
            </div>
          )}
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-controls={`player-suggestions-${index}`}
            style={{
              width: '100%',
              padding: isLinkedPlayer ? '11px 14px 11px 38px' : '11px 14px',
              borderRadius: 12,
              border: `1px solid ${isLinkedPlayer ? DEFAULT_ACCENT + '55' : T.hairline}`,
              background: T.paperDeep,
              color: T.ink,
              fontFamily: T.sans,
              fontSize: 14,
              letterSpacing: -0.1,
              outline: 'none',
              boxSizing: 'border-box',
              WebkitAppearance: 'none',
            }}
          />
        </div>

        {/* Remove button */}
        {canRemove && onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove player"
            style={{
              minWidth: 44,
              height: 44,
              borderRadius: 12,
              border: `1px solid ${T.hairline}`,
              background: 'transparent',
              color: T.pencilSoft,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <XIcon />
          </button>
        )}
      </div>

      {/* Suggestions dropdown */}
      <AnimatePresence>
        {isOpen && suggestions.length > 0 && (
          <motion.div
            ref={listRef}
            key="suggestions"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            id={`player-suggestions-${index}`}
            role="listbox"
            style={{
              position: 'absolute',
              zIndex: 60,
              top: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              borderRadius: 14,
              background: T.paper,
              border: `1px solid ${T.hairline}`,
              boxShadow: '0 12px 32px rgba(26,42,26,0.14)',
              overflow: 'hidden',
            }}
          >
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              {suggestions.map((sp, i) => (
                <button
                  key={sp.id}
                  data-suggestion
                  type="button"
                  onClick={() => handleSelectPlayer(sp)}
                  onMouseEnter={() => setHighlightedIndex(i)}
                  role="option"
                  aria-selected={i === highlightedIndex}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    background: i === highlightedIndex ? T.paperDeep : 'transparent',
                    border: 'none',
                    borderTop: i === 0 ? 'none' : `1px solid ${T.hairline}`,
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    minHeight: 48,
                  }}
                >
                  {/* Avatar */}
                  <div
                    style={{
                      flexShrink: 0,
                      width: 32,
                      height: 32,
                      borderRadius: 99,
                      background: T.ink,
                      color: T.paper,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: T.serif,
                      fontStyle: 'italic',
                      fontSize: 14,
                      overflow: 'hidden',
                    }}
                  >
                    {sp.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={sp.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      sp.name.charAt(0).toUpperCase()
                    )}
                  </div>

                  {/* Name & nickname */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: T.serif,
                        fontSize: 16,
                        color: T.ink,
                        letterSpacing: -0.2,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {highlightMatch(sp.name, inputValue)}
                    </div>
                    {sp.nickname && (
                      <div
                        style={{
                          fontFamily: T.mono,
                          fontSize: 9,
                          letterSpacing: 1.1,
                          color: T.pencilSoft,
                          textTransform: 'uppercase',
                          marginTop: 1,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        &ldquo;{sp.nickname}&rdquo;
                      </div>
                    )}
                  </div>

                  {/* Handicap badge */}
                  {sp.handicap !== undefined && (
                    <div
                      style={{
                        flexShrink: 0,
                        padding: '3px 8px',
                        borderRadius: 99,
                        border: `1px solid ${T.hairline}`,
                        background: T.paperDeep,
                        fontFamily: T.mono,
                        fontSize: 10,
                        letterSpacing: 0.5,
                        color: T.pencil,
                      }}
                    >
                      {sp.handicap}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* No matches state */}
      <AnimatePresence>
        {isOpen && inputValue.trim() && suggestions.length === 0 && (
          <motion.div
            key="no-matches"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            style={{
              position: 'absolute',
              zIndex: 60,
              top: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              borderRadius: 14,
              background: T.paper,
              border: `1px solid ${T.hairline}`,
              boxShadow: '0 12px 32px rgba(26,42,26,0.14)',
              padding: '14px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div style={{ color: T.pencilSoft }}>
              <UserIcon />
            </div>
            <span
              style={{
                fontFamily: T.serif,
                fontStyle: 'italic',
                fontSize: 14,
                color: T.pencilSoft,
                letterSpacing: -0.2,
                lineHeight: 1.35,
              }}
            >
              &ldquo;{inputValue}&rdquo; will be added as a new player.
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
