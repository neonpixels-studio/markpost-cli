// The seam that turns the one-shot default sync into a self-scheduling one
// when the user's `autoSync` setting is on. The timer is isolated here behind
// a `ScheduleFn` so the scheduling decision can be tested without waiting on a
// real clock: a test injects a fake `schedule` that captures the callback.

// How long to wait between self-scheduled syncs. Named so the interval isn't a
// bare literal and tests can assert against it.
export const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export type ScheduleFn = (callback: () => void, delayMs: number) => void;

// Real scheduler: a plain `setTimeout`. The timer is deliberately left ref'd —
// it IS the work that keeps the CLI process alive between self-scheduled syncs.
// Unref'ing it would let the process exit the moment the current run resolves,
// so the next sync would never fire and autoSync would be a no-op.
export const defaultSchedule: ScheduleFn = (callback, delayMs) => {
  setTimeout(callback, delayMs);
};

// Runs one sync, then — only if that run reported `autoSync` on — schedules the
// next after `intervalMs`. Re-scheduling from the completed run (rather than a
// fixed `setInterval`) keeps runs sequential, so a slow sync can't overlap the
// next one, and lets a run that flips `autoSync` off stop the loop cleanly.
export const runSyncWithAutoSchedule = async (
  runSync: () => Promise<boolean>,
  schedule: ScheduleFn = defaultSchedule,
  intervalMs: number = AUTO_SYNC_INTERVAL_MS,
): Promise<void> => {
  const autoSyncEnabled = await runSync();

  if (!autoSyncEnabled) {
    return;
  }

  // The re-entry runs inside a timer callback with no surrounding try, so a
  // rejecting `runSync` would surface as an unhandled rejection and take the
  // process down. Attach a handler at the seam: log it and stop the loop
  // rather than crash silently.
  schedule(() => {
    runSyncWithAutoSchedule(runSync, schedule, intervalMs).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }, intervalMs);
};
