'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Loader2 } from 'lucide-react';
import { createPersona } from '@/lib/caddie/api';
import type { CaddiePersonalityInfo } from '@/lib/caddie/types';

const VOICE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'sage', label: 'Sage — warm, experienced' },
  { id: 'ash', label: 'Ash — precise, sharp' },
  { id: 'fable', label: 'Fable — clear, instructional' },
  { id: 'verse', label: 'Verse — energetic' },
  { id: 'coral', label: 'Coral — upbeat, friendly' },
  { id: 'alloy', label: 'Alloy — neutral' },
  { id: 'ballad', label: 'Ballad — soft, lyrical' },
  { id: 'echo', label: 'Echo — clean baritone' },
  { id: 'onyx', label: 'Onyx — deep, grounded' },
  { id: 'nova', label: 'Nova — bright, articulate' },
  { id: 'shimmer', label: 'Shimmer — light, friendly' },
];

interface CustomPersonaModalProps {
  onClose: () => void;
  onCreated: (persona: CaddiePersonalityInfo) => void;
}

export default function CustomPersonaModal({ onClose, onCreated }: CustomPersonaModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [avatar, setAvatar] = useState('🎯');
  const [voiceId, setVoiceId] = useState('sage');
  const [instructions, setInstructions] = useState('');
  const [responseStyle, setResponseStyle] = useState<'brief' | 'detailed' | 'conversational'>('conversational');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length >= 2 && instructions.trim().length >= 20 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      // Server generates the persona id and stamps author_user_id from the
      // verified Clerk JWT. is_public is server-forced to false; sharing
      // requires admin promotion (cross-user prompt-injection mitigation).
      const created = await createPersona({
        name: trimmedName,
        description: description.trim() || `Custom persona: ${trimmedName}`,
        avatar: avatar.trim() || '🎯',
        system_prompt: instructions.trim(),
        realtime_instructions: instructions.trim(),
        voice_id: voiceId,
        response_style: responseStyle,
        traits: [],
      });
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create persona');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20 }}
        className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]"
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Create custom caddie</h2>
            <p className="text-xs text-zinc-500">Author a persona only you can pick.</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center"
          >
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-4">
          <div className="flex gap-3">
            <div className="w-16 shrink-0">
              <label className="block text-xs text-zinc-500 mb-1.5">Avatar</label>
              <input
                type="text"
                value={avatar}
                onChange={e => setAvatar(e.target.value)}
                maxLength={4}
                className="w-full h-12 px-2 rounded-lg bg-zinc-800 border border-zinc-700 text-center text-2xl"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-zinc-500 mb-1.5">Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. The Quiet Reader"
                className="w-full h-12 px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-white text-sm placeholder:text-zinc-600"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Short description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="One line shown in the picker"
              className="w-full h-10 px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-white text-sm placeholder:text-zinc-600"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Voice</label>
            <select
              value={voiceId}
              onChange={e => setVoiceId(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-white text-sm"
            >
              {VOICE_OPTIONS.map(v => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Response style</label>
            <div className="flex gap-2">
              {(['brief', 'conversational', 'detailed'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setResponseStyle(s)}
                  className={`flex-1 h-9 rounded-lg text-xs font-medium ${
                    responseStyle === s
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">
              Instructions <span className="text-zinc-600">(how this caddie talks & thinks)</span>
            </label>
            <textarea
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              rows={6}
              placeholder="e.g. You speak slowly, with a southern drawl. You favor the conservative play and never recommend hitting driver on a tight tee shot. Use phrases like 'easy does it' and 'let's keep it in play'."
              className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-white text-sm placeholder:text-zinc-600 resize-none"
            />
          </div>

          <p className="text-xs text-zinc-500">
            Custom personas are private to you. Sharing with other players is admin-reviewed and not yet available.
          </p>

          {error && (
            <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/40 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 p-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 h-11 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="flex-1 h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium flex items-center justify-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {saving ? 'Saving…' : 'Save persona'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
