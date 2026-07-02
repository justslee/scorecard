/**
 * IdleTimer — cost control for the Realtime voice connection.
 *
 * The WebRTC burst stays warm for follow-ups but must never idle forever
 * (OpenAI bills per connected minute). Every meaningful conversation event
 * `touch()`es the timer; if nothing happens for `timeoutMs` the injected
 * `onExpire` fires (the client disconnects — a later press reconnects).
 *
 * Pure and injectable (schedule/cancel default to setTimeout/clearTimeout)
 * so the 90s policy is unit-testable with fake timers.
 */

export const REALTIME_IDLE_DISCONNECT_MS = 90_000;

type Schedule = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
type Cancel = (handle: ReturnType<typeof setTimeout>) => void;

export class IdleTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onExpire: () => void,
    private timeoutMs: number = REALTIME_IDLE_DISCONNECT_MS,
    private schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    private cancelFn: Cancel = (h) => clearTimeout(h),
  ) {}

  /** Record activity — (re)arms the countdown from now. */
  touch(): void {
    this.cancel();
    this.handle = this.schedule(() => {
      this.handle = null;
      this.onExpire();
    }, this.timeoutMs);
  }

  /** Stop the countdown without firing (connection closed deliberately). */
  cancel(): void {
    if (this.handle !== null) {
      this.cancelFn(this.handle);
      this.handle = null;
    }
  }

  isArmed(): boolean {
    return this.handle !== null;
  }
}
