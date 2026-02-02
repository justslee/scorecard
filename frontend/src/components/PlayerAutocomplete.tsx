'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, User } from 'lucide-react';
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
  // We use savedPlayer IDs only for filtering, not custom IDs
  const selectedSavedIds = selectedIds.filter(id => !id.startsWith('custom-player-'));
  const availablePlayers = savedPlayers.filter(
    (sp) => !selectedSavedIds.includes(sp.id) || sp.id === value.id
  );

  // Get suggestions based on input
  const getSuggestions = (): SavedPlayer[] => {
    if (!inputValue.trim()) {
      // Show all available when empty
      return availablePlayers.slice(0, 10);
    }
    
    const lower = inputValue.toLowerCase();
    return availablePlayers
      .filter((sp) => {
        const nameMatch = sp.name.toLowerCase().includes(lower);
        const nicknameMatch = sp.nickname?.toLowerCase().includes(lower);
        const emailMatch = sp.email?.toLowerCase().includes(lower);
        return nameMatch || nicknameMatch || emailMatch;
      })
      .sort((a, b) => {
        // Prioritize matches at start of name
        const aStartsWith = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
        const bStartsWith = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
        return aStartsWith - bStartsWith;
      })
      .slice(0, 8);
  };

  const suggestions = isOpen ? getSuggestions() : [];

  // Sync input with value prop
  useEffect(() => {
    setInputValue(value.name);
  }, [value.name]);

  // Reset highlight when suggestions change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [inputValue]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (listRef.current && highlightedIndex >= 0) {
      const items = listRef.current.querySelectorAll('[data-suggestion]');
      const item = items[highlightedIndex] as HTMLElement;
      if (item) {
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setIsOpen(true);
    
    // Update the player with typed name (use stable custom ID)
    onChange({
      id: customPlayerId,
      name: newValue,
    });
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
        setHighlightedIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (suggestions[highlightedIndex]) {
          handleSelectPlayer(suggestions[highlightedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        break;
      case 'Tab':
        // Allow tab to close and move focus
        setIsOpen(false);
        break;
    }
  };

  const handleFocus = () => {
    setIsOpen(true);
    setHighlightedIndex(0);
  };

  const handleBlur = () => {
    // Delay to allow click on suggestion
    setTimeout(() => setIsOpen(false), 150);
  };

  // Highlight matching text in name
  const highlightMatch = (text: string, query: string) => {
    if (!query.trim()) return text;
    
    const lower = text.toLowerCase();
    const queryLower = query.toLowerCase();
    const index = lower.indexOf(queryLower);
    
    if (index === -1) return text;
    
    return (
      <>
        {text.slice(0, index)}
        <span className="text-emerald-300 font-semibold">
          {text.slice(index, index + query.length)}
        </span>
        {text.slice(index + query.length)}
      </>
    );
  };

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={`w-full px-4 py-3 rounded-2xl bg-white/5 border focus:bg-white/7 focus:border-emerald-400/50 focus:outline-none transition-colors ${
              isLinkedPlayer
                ? 'border-emerald-400/30 pl-11'
                : 'border-white/10'
            }`}
            role="combobox"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-autocomplete="list"
          />
          {isLinkedPlayer && (
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none">
              <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <span className="text-xs text-emerald-300">✓</span>
              </div>
            </div>
          )}
        </div>
        {canRemove && onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="btn rounded-2xl px-4 bg-red-500/10 hover:bg-red-500/20 border border-red-400/20 text-red-200"
            aria-label="Remove player"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Suggestions Dropdown */}
      <AnimatePresence>
        {isOpen && suggestions.length > 0 && (
          <motion.div
            ref={listRef}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute z-50 mt-2 w-full rounded-2xl bg-zinc-900/95 backdrop-blur-xl border border-white/10 shadow-2xl overflow-hidden"
            role="listbox"
          >
            <div className="max-h-64 overflow-y-auto py-1">
              {suggestions.map((sp, index) => (
                <button
                  key={sp.id}
                  data-suggestion
                  type="button"
                  onClick={() => handleSelectPlayer(sp)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  className={`w-full px-4 py-3 flex items-center gap-3 transition-colors text-left ${
                    index === highlightedIndex
                      ? 'bg-emerald-500/15'
                      : 'hover:bg-white/5'
                  }`}
                  role="option"
                  aria-selected={index === highlightedIndex}
                >
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-white/10 flex items-center justify-center flex-shrink-0">
                    {sp.avatarUrl ? (
                      <img
                        src={sp.avatarUrl}
                        alt=""
                        className="w-full h-full rounded-full object-cover"
                      />
                    ) : (
                      <span className="text-sm font-semibold text-emerald-300">
                        {sp.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                  </div>

                  {/* Name & Info */}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {highlightMatch(sp.name, inputValue)}
                    </div>
                    {sp.nickname && (
                      <div className="text-sm text-zinc-500 truncate">
                        &quot;{highlightMatch(sp.nickname, inputValue)}&quot;
                      </div>
                    )}
                  </div>

                  {/* Handicap Badge */}
                  {sp.handicap !== undefined && (
                    <div className="flex-shrink-0 px-2.5 py-1 rounded-full bg-white/5 border border-white/10">
                      <span className="text-xs text-zinc-400">
                        {sp.handicap}
                      </span>
                    </div>
                  )}
                </button>
              ))}
            </div>

            {/* Footer hint */}
            <div className="px-4 py-2 border-t border-white/5 bg-white/2">
              <p className="text-xs text-zinc-500">
                ↑↓ to navigate • Enter to select • Esc to close
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* No matches state */}
      <AnimatePresence>
        {isOpen && inputValue.trim() && suggestions.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="absolute z-50 mt-2 w-full rounded-2xl bg-zinc-900/95 backdrop-blur-xl border border-white/10 shadow-2xl p-4"
          >
            <div className="flex items-center gap-3 text-zinc-400">
              <User className="h-5 w-5" />
              <span className="text-sm">
                No friends found — &quot;{inputValue}&quot; will be added as a new player
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
