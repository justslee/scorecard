'use client';

/**
 * SettleUpPanel — settle-up summary for completed rounds with money games.
 *
 * Displayed inside RoundRecap after the game results section.
 * Computes the net ledger client-side, minimizes transfers, then lets the
 * owner tap "Finalize" to persist the ledger to the backend.
 *
 * Design rules: T.* tokens only, inline styles, no external libs.
 * Mobile-first, ≥44pt tap targets. Yardage-book aesthetic.
 *
 * Empty rounds (no money games) → returns null (nothing rendered).
 * Already-settled rounds       → shows the locked, read-only settled state.
 */

import { useState } from 'react';
import { T } from '@/components/yardage/tokens';
import { Round } from '@/lib/types';
import {
  computeNetSettlement,
  getPersistedSettlement,
  FinalizedSettlement,
  SettlementTransfer,
} from '@/lib/settlement';
import { finalizeSettlement } from '@/lib/api';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SettleUpPanelProps {
  round: Round;
  /**
   * The player ID representing the signed-in owner in this round.
   * Used to render "You pay Sam" / "Sam pays you" language.
   * When absent, falls back to neutral "Player A pays Player B" language.
   */
  ownerPlayerId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function playerName(round: Round, id: string): string {
  return round.players.find((p) => p.id === id)?.name ?? id;
}

/** Format a dollar amount: "$23.50" or "$23" (no trailing .00). */
function formatDollars(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Format the ISO datetime to a short locale date string. */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

// ─── Transfer row — perspective-aware "You pay X" / "X pays you" / "A pays B" ─

function TransferRow({
  transfer,
  round,
  ownerPlayerId,
  muted,
}: {
  transfer: SettlementTransfer;
  round: Round;
  ownerPlayerId: string | undefined;
  muted: boolean;
}) {
  const fromName = playerName(round, transfer.fromPlayerId);
  const toName = playerName(round, transfer.toPlayerId);
  const isOwnerPaying = transfer.fromPlayerId === ownerPlayerId;
  const isOwnerReceiving = transfer.toPlayerId === ownerPlayerId;

  let label: string;
  if (isOwnerPaying) {
    label = `You pay ${toName}`;
  } else if (isOwnerReceiving) {
    label = `${fromName} pays you`;
  } else {
    label = `${fromName} pays ${toName}`;
  }

  const amountColor = isOwnerReceiving
    ? T.accent // money coming to you — accent (cobalt)
    : isOwnerPaying
      ? T.errorInk // money going out — warm red
      : T.ink; // neutral

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 14px',
        border: `1px solid ${T.hairlineSoft}`,
        borderRadius: 12,
        background: muted ? 'transparent' : T.paper,
      }}
    >
      <div
        style={{
          fontFamily: T.sans,
          fontSize: 14,
          fontWeight: 500,
          color: muted ? T.pencil : T.ink,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: T.serif,
          fontSize: 20,
          color: muted ? T.pencilSoft : amountColor,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.3px',
          flexShrink: 0,
          marginLeft: 12,
        }}
      >
        {formatDollars(transfer.amount)}
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

type Status = 'idle' | 'saving' | 'saved' | 'error';

export default function SettleUpPanel({ round, ownerPlayerId }: SettleUpPanelProps) {
  // Check if already finalized (persisted in round.games as a settlement record)
  const persistedSettlement = getPersistedSettlement(round);

  // Local-pending settlement computed fresh (before finalization)
  const ledger = computeNetSettlement(round);

  // Local state: once the owner clicks "Finalize" we flip to settled display
  const [localSettled, setLocalSettled] = useState<FinalizedSettlement | null>(null);
  const [status, setStatus] = useState<Status>('idle');

  // Nothing to settle — no money games
  if (ledger.isEmpty) return null;

  // Which settlement to display: persisted (from backend) > local (just finalized) > pending
  const displaySettled = persistedSettlement ?? localSettled;
  const isSettled = displaySettled !== null;

  // ── Finalized read-only view ──────────────────────────────────────────────
  if (isSettled) {
    return (
      <div>
        {/* Section kicker */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: '1.4px',
              color: T.pencil,
              textTransform: 'uppercase',
            }}
          >
            Settled
          </div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: '0.8px',
              color: T.pencilSoft,
              textTransform: 'uppercase',
            }}
          >
            {formatDate(displaySettled.finalizedAt)}
          </div>
        </div>

        {displaySettled.transfers.length === 0 ? (
          <div
            style={{
              fontFamily: T.serif,
              fontStyle: 'italic',
              fontSize: 14,
              color: T.pencilSoft,
              textAlign: 'center',
              padding: '16px 0',
            }}
          >
            All square — no transfers needed.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {displaySettled.transfers.map((t, i) => (
              <TransferRow
                key={i}
                transfer={t}
                round={round}
                ownerPlayerId={ownerPlayerId}
                muted={true}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Pending settle-up view ────────────────────────────────────────────────

  async function handleFinalize() {
    if (status === 'saving') return;
    setStatus('saving');

    const finalizedAt = new Date().toISOString();
    try {
      await finalizeSettlement(round.id, {
        transfers: ledger.transfers,
        finalizedAt,
      });
      setLocalSettled({ transfers: ledger.transfers, finalizedAt });
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  return (
    <div>
      {/* Section header */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: '1.4px',
            color: T.pencil,
            textTransform: 'uppercase',
            marginBottom: 4,
          }}
        >
          Settle up
        </div>
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: 'italic',
            fontSize: 20,
            color: T.ink,
            letterSpacing: '-0.3px',
          }}
        >
          After the match
        </div>
      </div>

      {/* Transfers */}
      {ledger.transfers.length === 0 ? (
        <div
          style={{
            fontFamily: T.serif,
            fontStyle: 'italic',
            fontSize: 14,
            color: T.pencilSoft,
            marginBottom: 16,
          }}
        >
          All square — no transfers needed.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {ledger.transfers.map((t, i) => (
            <TransferRow
              key={i}
              transfer={t}
              round={round}
              ownerPlayerId={ownerPlayerId}
              muted={false}
            />
          ))}
        </div>
      )}

      {/* Finalize button */}
      <button
        onClick={handleFinalize}
        disabled={status === 'saving'}
        style={{
          width: '100%',
          padding: '13px 20px',
          minHeight: 44,
          borderRadius: 12,
          border: `1px solid ${T.hairline}`,
          background: status === 'saving' ? T.paperDeep : T.paperDeep,
          color: status === 'saving' ? T.pencilSoft : T.ink,
          fontFamily: T.sans,
          fontSize: 14,
          fontWeight: 500,
          cursor: status === 'saving' ? 'default' : 'pointer',
          letterSpacing: '0.1px',
          transition: 'background 0.15s',
        }}
      >
        {status === 'saving' ? 'Saving…' : 'Mark as settled'}
      </button>

      {/* Error state — muted, never blocks Done */}
      {status === 'error' && (
        <div
          style={{
            marginTop: 8,
            fontFamily: T.mono,
            fontSize: 10,
            letterSpacing: '0.8px',
            color: T.errorInk,
            textAlign: 'center',
            textTransform: 'uppercase',
          }}
        >
          Couldn&apos;t save — tap again or skip
        </div>
      )}
    </div>
  );
}
