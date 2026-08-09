import { describe, expect, it, vi } from 'vitest';

import {
  AUTO_SYNC_INTERVAL_MS,
  defaultSchedule,
  runSyncWithAutoSchedule,
  type ScheduleFn,
} from '@/libs/scheduler.js';

describe('runSyncWithAutoSchedule', () => {
  it('schedules another run at the auto-sync interval when the sync reports autoSync on', async () => {
    const runSync = vi.fn().mockResolvedValue(true);
    const schedule: ScheduleFn = vi.fn();

    await runSyncWithAutoSchedule(runSync, schedule);

    expect(runSync).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(
      expect.any(Function),
      AUTO_SYNC_INTERVAL_MS,
    );
  });

  it('does not schedule another run when the sync reports autoSync off', async () => {
    const runSync = vi.fn().mockResolvedValue(false);
    const schedule: ScheduleFn = vi.fn();

    await runSyncWithAutoSchedule(runSync, schedule);

    expect(runSync).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('re-runs the sync when the scheduled callback fires', async () => {
    const runSync = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    let scheduledCallback: (() => void) | undefined;
    const schedule: ScheduleFn = vi.fn((callback) => {
      scheduledCallback = callback;
    });

    await runSyncWithAutoSchedule(runSync, schedule);

    expect(scheduledCallback).toBeDefined();
    scheduledCallback?.();
    // The scheduled callback re-enters the loop asynchronously; let its
    // microtasks settle before asserting the second run happened.
    await vi.waitFor(() => expect(runSync).toHaveBeenCalledTimes(2));
    // Second run reported autoSync off, so the loop stops there.
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('logs and stops the loop when a scheduled re-run rejects, without a second schedule', async () => {
    const runSync = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('network down'));
    let scheduledCallback: (() => void) | undefined;
    const schedule: ScheduleFn = vi.fn((callback) => {
      scheduledCallback = callback;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    await runSyncWithAutoSchedule(runSync, schedule);
    scheduledCallback?.();

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(process.exitCode).toBe(1);
    // The rejecting re-run never reaches the schedule call, so no further timer
    // is armed — the loop stops rather than crashing on an unhandled rejection.
    expect(schedule).toHaveBeenCalledTimes(1);

    process.exitCode = originalExitCode;
    errorSpy.mockRestore();
  });

  it('honors a custom interval', async () => {
    const runSync = vi.fn().mockResolvedValue(true);
    const schedule: ScheduleFn = vi.fn();
    const customInterval = 1234;

    await runSyncWithAutoSchedule(runSync, schedule, customInterval);

    expect(schedule).toHaveBeenCalledWith(expect.any(Function), customInterval);
  });
});

describe('defaultSchedule', () => {
  it('arms a ref-holding timer so a pending sync keeps the CLI process alive', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const callback = vi.fn();

    defaultSchedule(callback, AUTO_SYNC_INTERVAL_MS);

    const timer = setTimeoutSpy.mock.results[0].value as NodeJS.Timeout;
    // A regression to `.unref()` would let the process exit before the timer
    // fires, making autoSync a no-op — assert the handle still holds the loop.
    expect(timer.hasRef()).toBe(true);

    clearTimeout(timer);
    setTimeoutSpy.mockRestore();
  });
});
