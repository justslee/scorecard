/**
 * Conversation ordering for the Realtime voice transcript.
 *
 * The bug this fixes: in a Realtime turn, the events arrive out of the order we
 * want to *render*. The user's spoken turn produces
 * `conversation.item.input_audio_transcription.completed`, but that transcript
 * event lands AFTER the assistant's streamed `response.audio_transcript.delta`s
 * for the reply it triggered. If we render messages in arrival order, the
 * caddie's reply shows ABOVE the user's "hello".
 *
 * Fix: assign a stable monotonic order key at the moment each conversation ITEM
 * *begins* — the user's input item begins at `speech_started` (before the model
 * responds), and the response item begins at `response.created`/first delta —
 * rather than when its transcript text finally arrives. We then sort the
 * rendered list by that key, so user always precedes the reply it triggered
 * while the streamed assistant deltas keep coalescing under one id.
 *
 * This module is pure (no DOM / no network) so the ordering logic is unit
 * tested directly against out-of-order event sequences.
 */

/** Anything carrying an order key can be sorted into conversation order. */
export interface Ordered {
  order: number;
}

/** Bound on `orderByResponseId` / `orderByUserItemId` / `pendingUserOrders` —
 *  belt-and-braces for a session that runs long enough (or leaks enough
 *  phantom/unconsumed reservations) to otherwise grow these for the whole
 *  session lifetime. Evict-oldest; entries are consumed within a turn in
 *  practice, so this is a pure cap with no behavior change for live turns
 *  (specs/caddie-voice-reliability-hardening-plan.md §2). */
export const MAX_TRACKED = 128;

/** Evict the oldest entry (Map insertion order) once `map` exceeds
 *  MAX_TRACKED. Pure bound, no id-aware skipping — unlike realtime.ts's
 *  input-class cap, a stale reservation here is inert once its owner is
 *  gone, so unconditional oldest-eviction is safe. */
function evictOldest<K, V>(map: Map<K, V>): void {
  if (map.size <= MAX_TRACKED) return;
  const oldestKey = map.keys().next().value;
  if (oldestKey !== undefined) map.delete(oldestKey);
}

/**
 * Hands out monotonic order keys keyed to when conversation items *begin*.
 *
 * Usage maps 1:1 to Realtime events:
 *  - `noteUserTurnStarted(itemId)`   on `input_audio_buffer.speech_started`
 *  - `orderForResponse(id)`          on `response.created` and every assistant delta
 *  - `orderForUserTranscript(itemId)` on `…input_audio_transcription.completed`
 *
 * Because a user turn always *starts* before the response it triggers, the
 * reserved user slot is always lower than that response's slot — even though the
 * user transcript event arrives last.
 */
export class MessageOrderTracker {
  private seq = 0;
  /**
   * Order slot reserved per user item_id at speech_started. Keyed by id (NOT a
   * FIFO queue) so a phantom / empty / VAD-bounced speech_started that never
   * produces a consuming transcript can't desync the matching for the rest of
   * the session — a leaked entry is simply never looked up. (Realistic on a
   * noisy course, where VAD false-starts are common.)
   */
  private orderByUserItemId = new Map<string, number>();
  /** Fallback FIFO for the rare case speech_started carries no item_id. */
  private pendingUserOrders: number[] = [];
  /** Stable order per response id, so streamed deltas don't re-sort. */
  private orderByResponseId = new Map<string, number>();

  /**
   * A user turn began (speech detected). Reserve its order slot up front, keyed
   * by the item_id the transcript will carry. Without an id, use a FIFO slot.
   */
  noteUserTurnStarted(itemId?: string): void {
    const order = ++this.seq;
    if (itemId) {
      this.orderByUserItemId.set(itemId, order);
      evictOldest(this.orderByUserItemId);
    } else {
      this.pendingUserOrders.push(order);
      while (this.pendingUserOrders.length > MAX_TRACKED) this.pendingUserOrders.shift();
    }
  }

  /**
   * Order key for the user's transcript item. Prefer the slot reserved for this
   * exact item_id at speech_started; else the oldest FIFO slot; else a fresh
   * monotonic slot (e.g. speech_started was dropped). Identity-matched when ids
   * are present, so an unconsumed reservation never shifts another turn's order.
   */
  orderForUserTranscript(itemId?: string): number {
    if (itemId) {
      const reserved = this.orderByUserItemId.get(itemId);
      if (reserved !== undefined) {
        this.orderByUserItemId.delete(itemId);
        return reserved;
      }
    }
    const fifo = this.pendingUserOrders.shift();
    return fifo ?? ++this.seq;
  }

  /**
   * Order key for a user message that was *typed* (no speech_started to reserve
   * a slot). A fresh monotonic slot — lower than the response it triggers, since
   * the typed item is created before `response.create`.
   */
  orderForTypedUser(): number {
    return ++this.seq;
  }

  /**
   * Stable order key for an assistant response, shared across all its streamed
   * deltas (assigned once on first sighting of the response id).
   */
  orderForResponse(responseId: string): number {
    const existing = this.orderByResponseId.get(responseId);
    if (existing !== undefined) return existing;
    const order = ++this.seq;
    this.orderByResponseId.set(responseId, order);
    evictOldest(this.orderByResponseId);
    return order;
  }

  /** Forget all state — call when the session is torn down. */
  reset(): void {
    this.seq = 0;
    this.orderByUserItemId.clear();
    this.pendingUserOrders = [];
    this.orderByResponseId.clear();
  }
}

/**
 * Sort messages into conversation order (ascending order key), without mutating
 * the input. Stable: items with equal keys keep their relative arrival order.
 */
export function sortByOrder<T extends Ordered>(messages: readonly T[]): T[] {
  return messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.order - b.m.order || a.i - b.i)
    .map(({ m }) => m);
}
