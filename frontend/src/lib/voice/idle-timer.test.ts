import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IdleTimer, REALTIME_IDLE_DISCONNECT_MS } from './idle-timer';

describe('IdleTimer — 90s realtime idle disconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onExpire after the timeout with no activity', () => {
    const onExpire = vi.fn();
    const timer = new IdleTimer(onExpire);
    timer.touch();
    vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(timer.isArmed()).toBe(false);
  });

  it('activity (touch) resets the countdown', () => {
    const onExpire = vi.fn();
    const timer = new IdleTimer(onExpire);
    timer.touch();
    vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS - 1000);
    timer.touch(); // conversation event just before expiry
    vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS - 1000);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('cancel disarms without firing (deliberate disconnect)', () => {
    const onExpire = vi.fn();
    const timer = new IdleTimer(onExpire);
    timer.touch();
    expect(timer.isArmed()).toBe(true);
    timer.cancel();
    vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();
    expect(timer.isArmed()).toBe(false);
  });

  it('repeated touches never stack multiple timers', () => {
    const onExpire = vi.fn();
    const timer = new IdleTimer(onExpire);
    for (let i = 0; i < 5; i++) timer.touch();
    vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('respects a custom timeout', () => {
    const onExpire = vi.fn();
    const timer = new IdleTimer(onExpire, 500);
    timer.touch();
    vi.advanceTimersByTime(500);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
