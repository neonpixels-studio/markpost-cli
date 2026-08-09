#!/usr/bin/env node

import {
  deleteRecords,
  fetchAllRecords,
  markRecordSynced,
} from '@/libs/records.js';
import { ensureOutputDirectory, writeMarkdown } from '@/libs/markdown.js';
import {
  fetchSettings,
  resolveSyncSettings,
  ResolvedSyncSettings,
} from '@/libs/settings.js';
import { runPushCommand, USAGE as PUSH_USAGE } from '@/commands/push.js';
import { runGetCommand, USAGE as GET_USAGE } from '@/commands/get.js';
import {
  runSourcesCommand,
  USAGE as SOURCES_USAGE,
} from '@/commands/sources.js';
import {
  runRecordsCommand,
  USAGE as RECORDS_USAGE,
} from '@/commands/records.js';
import { runConfigCommand, USAGE as CONFIG_USAGE } from '@/commands/config.js';
import yoctoSpinner from 'yocto-spinner';
import cliSpinners from 'cli-spinners';
import chalk from 'chalk';
import { checkConfig } from '@/libs/config.js';
import {
  AUTO_SYNC_INTERVAL_MS,
  runSyncWithAutoSchedule,
} from '@/libs/scheduler.js';
import { Record } from '@/types/records.types.js';
import { ConflictStrategy } from '@/types/settings.types.js';

// Declared before the top-level command dispatch below: that dispatch awaits
// runDefaultSync during module evaluation, so any module const it reads must
// already be initialized (a const declared lower would be in its temporal dead
// zone when the sync runs).
const MS_PER_MINUTE = 60_000;
const AUTO_SYNC_INTERVAL_MINUTES = AUTO_SYNC_INTERVAL_MS / MS_PER_MINUTE;

// One-shot guard so the daemon announces autoSync mode once per process rather
// than reprinting the banner on every scheduled iteration.
let autoSyncAnnounced = false;

// The last settings confirmed from a successful read. On a transient read
// failure an established daemon reuses these (forcing autoDelete off — the
// irreversible delete must never run on unconfirmed settings) so records aren't
// written in the wrong format or the loop silently stopped. Null until the
// first successful read, so an initial failure stays fully conservative.
let lastResolvedSettings: ResolvedSyncSettings | null = null;

// UUIDs already written this process. In an autoSync loop with autoDelete off,
// the same server records reappear every iteration; without this the suffix
// strategy would write test-title-1.md, test-title-2.md, ... endlessly. Scoped
// to the process, so a fresh `markpost` invocation starts empty. Keyed by uuid
// alone (the record contract carries no mutation timestamp), so a record edited
// on the server after being synced is not re-fetched within the same session.
const syncedRecordIds = new Set<string>();

type Spinner = ReturnType<typeof yoctoSpinner>;

// Cap how many mark-synced PATCHes are in flight at once. A large first sync
// can write hundreds of records; firing one unbounded `Promise.all` over all
// of them risks rate-limit/connection failures exactly when the batch is
// biggest — and every failed mark stays pending and re-duplicates next run.
// Declared here (above the top-level `dispatch()` call) so the hoisted helpers
// don't hit its temporal dead zone when the default sync runs.
const MARK_SYNCED_CONCURRENCY = 10;

const [commandName, ...commandArgs] = process.argv.slice(2);

const SYNC_COMMAND = 'sync';

// Control-character code points to strip before printing untrusted text: the
// C0 range (0x00–0x1f), DEL (0x7f), and the C1 range (0x80–0x9f, which carries
// 8-bit CSI/OSC that some terminals still act on). Declared up here (above the
// top-level `await dispatch()`) so they're initialized before the sync runs
// and calls sanitizeForTerminal — a `const` below that await would sit in the
// temporal dead zone when the sync reads it.
const LAST_C0_CONTROL_CODE = 0x1f;
const DELETE_CONTROL_CODE = 0x7f;
const FIRST_C1_CONTROL_CODE = 0x80;
const LAST_C1_CONTROL_CODE = 0x9f;

// The fetch/write/delete sync is destructive (it can delete server records),
// so it must be requested explicitly by name — never triggered by a bare,
// accidental `markpost`. Its usage lives here because the sync lives here.
const SYNC_USAGE = `Usage: markpost sync

  Fetch all pending records, write each to a markdown file, and (when
  autoDelete is enabled) delete the written records from the server`;

// Tokens in the command position that print top-level help instead of running
// a command. `help` is only a command word — as a sub-argument it could be a
// real path, so per-command help below accepts flags only.
const HELP_COMMANDS = new Set(['help', '--help', '-h']);
const HELP_FLAG_ARGS = new Set(['--help', '-h']);

interface Command {
  run: (args: string[]) => Promise<void>;
  usage: string;
}

// Single source of truth for dispatch, per-command help, and the aggregated
// top-level help: adding a command here wires up all three. A Map (rather than
// a plain object) means a command named "toString" or "constructor" can't
// resolve to an inherited Object.prototype member instead of falling through
// to the "unknown command" branch.
const COMMANDS = new Map<string, Command>([
  [SYNC_COMMAND, { run: runSyncCommand, usage: SYNC_USAGE }],
  ['push', { run: runPushCommand, usage: PUSH_USAGE }],
  ['get', { run: runGetCommand, usage: GET_USAGE }],
  ['sources', { run: runSourcesCommand, usage: SOURCES_USAGE }],
  ['records', { run: runRecordsCommand, usage: RECORDS_USAGE }],
  ['config', { run: runConfigCommand, usage: CONFIG_USAGE }],
]);

// The sync is the one destructive command, so it rejects unexpected arguments
// (a typo, a stray flag) rather than ignoring them and silently fetching,
// writing, and deleting server records. `--help`/`-h` are intercepted before
// this runs (see dispatch), so anything reaching here is a genuine mistake.
async function runSyncCommand(args: string[]): Promise<void> {
  if (args.length > 0) {
    console.error(chalk.redBright(`Unexpected arguments: ${args.join(' ')}`));
    console.error(SYNC_USAGE);
    process.exitCode = 1;
    return;
  }

  // The scheduler self-repeats the sync when the run reports `autoSync` on,
  // turning `markpost sync` into a self-scheduling daemon; a one-shot run
  // (autoSync off) returns after a single pass.
  await runSyncWithAutoSchedule(runDefaultSync);
}

// Aggregate each command's own USAGE string rather than maintaining a second,
// hand-written help blob that would drift — each command owns the single
// source of truth for its own usage, and this reads straight from COMMANDS.
const HELP_TEXT = [
  'markpost — sync markdown records with your markpost account',
  '',
  'Usage: markpost <command> [options]',
  '',
  'Commands:',
  ...[...COMMANDS.values()].flatMap((command) => ['', command.usage]),
  '',
  'Run `markpost help` (or `--help`) to see this message.',
].join('\n');

// A top-level help request optionally targets one command: `markpost help
// sync` prints just the sync usage. An unrecognized topic falls back to the
// full help rather than erroring — a help request should stay helpful.
function printHelp(topic: string | undefined): void {
  const command = topic ? COMMANDS.get(topic) : undefined;
  console.log(command ? command.usage : HELP_TEXT);
}

async function dispatch(): Promise<void> {
  // An explicit top-level help request is a success: print to stdout, exit 0.
  if (HELP_COMMANDS.has(commandName)) {
    printHelp(commandArgs[0]);
    return;
  }

  // A bare `markpost` (no command, or an empty-string arg) prints help but
  // fails loud (stderr + non-zero exit): it never runs the destructive sync,
  // and because bare `markpost` used to be the sync trigger, a silent exit 0
  // would let a cron job or wrapper "succeed" while quietly syncing nothing.
  // Run `markpost sync` to sync on purpose.
  if (!commandName) {
    console.error(HELP_TEXT);
    console.error(
      chalk.redBright('No command given. Run `markpost sync` to sync records.'),
    );
    process.exitCode = 1;
    return;
  }

  const command = COMMANDS.get(commandName);

  // An unrecognized command errors out rather than falling through to the
  // sync that deletes server records.
  if (!command) {
    console.error(chalk.redBright(`Unknown command: ${commandName}`));
    console.error(
      chalk.dim('Run `markpost help` to see the available commands.'),
    );
    process.exitCode = 1;
    return;
  }

  // Per-command help: `markpost <command> --help` prints that command's usage
  // with no side effects (no config check, no API call). Handled centrally so
  // every command supports it, not just the ones that happen to print usage on
  // a bad sub-argument.
  if (commandArgs.some((arg) => HELP_FLAG_ARGS.has(arg))) {
    console.log(command.usage);
    return;
  }

  await command.run(commandArgs);
}

await dispatch();

type WrittenRecord = { record: Record; filePath: string };
type FailedRecord = { record: Record; error: unknown };

// The three ways a single record's write can end: it landed at a path, the
// `skip` strategy left an existing file untouched (`null` from writeMarkdown),
// or the write threw (e.g. EACCES/EISDIR). Modeling all three as one tagged
// result lets writeRecords sort each record without a nested try/if.
type WriteOutcome =
  | { status: 'written'; filePath: string }
  | { status: 'skipped' }
  | { status: 'failed'; error: unknown };

type WriteRecordsResult = {
  written: WrittenRecord[];
  failed: FailedRecord[];
  skipped: number;
};

// A function declaration (not a `const` arrow) so it's hoisted above the
// top-level `await dispatch()` that kicks off the sync — the same reason
// writeRecords/runDefaultSync are declarations. A `const` here sits in the
// temporal dead zone when reportWriteFailures runs mid-sync.
function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One record's write, contained: a throw (EACCES/EISDIR, a full disk, ...) is
// caught and returned as a `failed` outcome so a single bad record can't abort
// the batch and hide files already written for the records around it.
function writeRecordSafely(
  record: Record,
  conflictStrategy: ConflictStrategy,
  seenSlugs: Set<string>,
  includeFrontmatter: boolean,
): WriteOutcome {
  try {
    const filePath = writeMarkdown(
      record,
      conflictStrategy,
      seenSlugs,
      includeFrontmatter,
    );

    if (filePath === null) {
      return { status: 'skipped' };
    }

    return { status: 'written', filePath };
  } catch (error) {
    return { status: 'failed', error };
  }
}

// Writes each record with the user's conflict strategy, keeping the record
// alongside the path it landed at. A `skipped` outcome means the `skip`
// strategy left an existing file untouched, so that record never reaches the
// delete step — deleting a record the CLI never persisted would lose it for
// good. A `failed` outcome is collected (not thrown) so the rest of the batch
// still writes; the caller surfaces the failures and exits non-zero.
function writeRecords(
  records: Record[],
  conflictStrategy: ConflictStrategy,
  includeFrontmatter: boolean,
): WriteRecordsResult {
  // One Set shared across the whole batch so `overwrite` can detect two
  // same-slug records in a single sync and avoid clobbering (see
  // writeMarkdown/resolveStrategyForSlug). A sequential loop preserves order
  // and threads the same Set across every record.
  const seenSlugs = new Set<string>();
  const written: WrittenRecord[] = [];
  const failed: FailedRecord[] = [];
  let skipped = 0;

  for (const record of records) {
    const outcome = writeRecordSafely(
      record,
      conflictStrategy,
      seenSlugs,
      includeFrontmatter,
    );

    if (outcome.status === 'written') {
      written.push({ record, filePath: outcome.filePath });
      continue;
    }

    if (outcome.status === 'skipped') {
      skipped += 1;
      continue;
    }

    failed.push({ record, error: outcome.error });
  }

  return { written, failed, skipped };
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  const isC1Control =
    codePoint >= FIRST_C1_CONTROL_CODE && codePoint <= LAST_C1_CONTROL_CODE;
  return (
    codePoint <= LAST_C0_CONTROL_CODE ||
    codePoint === DELETE_CONTROL_CODE ||
    isC1Control
  );
}

// Replace control characters (C0 range + DEL) in any API-controlled string
// before it reaches the terminal. A record title is untrusted (see
// markdown.ts slugifyTitle), so a title carrying ANSI escapes could otherwise
// clear the screen or overwrite earlier output, including the failure warning
// itself, with fabricated text. Done by code point rather than a regex to
// avoid embedding control characters in source (eslint no-control-regex). The
// uuid alongside keeps the record identifiable even if the title is emptied.
function sanitizeForTerminal(value: string): string {
  return Array.from(value, (character) =>
    isControlCharacter(character) ? ' ' : character,
  ).join('');
}

// End the write phase on the right indicator. A run where every record threw
// is an error, not a success checkmark. An all-skipped run (the `skip` strategy
// found every file already on disk) stays a success: nothing failed and the
// records are intentionally left on the server, reported separately by the
// yellow "Skipped N" line — so only an all-failed run flips to spinner.error.
function reportWriteOutcome(
  spinner: ReturnType<typeof yoctoSpinner>,
  writtenCount: number,
  failedCount: number,
): void {
  if (writtenCount === 0 && failedCount > 0) {
    spinner.error(`Wrote 0 records — all ${failedCount} failed.`);
    return;
  }

  spinner.success(`Wrote ${writtenCount} records!`);
}

// Fail loud on per-record write errors: name every record that couldn't be
// written (with its error) and set a non-zero exit so a cron run notices,
// rather than swallowing the failures. The failed records were never added to
// `written`, so they're excluded from the delete step and stay on the server
// for the next sync to retry. A no-op when nothing failed.
function reportWriteFailures(failedRecords: FailedRecord[]): void {
  if (failedRecords.length === 0) {
    return;
  }

  console.error(
    chalk.redBright(
      `Failed to write ${failedRecords.length} record(s) — left on the server:`,
    ),
  );
  failedRecords.forEach(({ record, error }) => {
    // Sanitize the whole composed line: the uuid comes from the same untrusted
    // API response as the title, and a filesystem error message embeds the
    // (user-configured) target path — any of them could carry an escape.
    console.error(
      chalk.redBright(
        sanitizeForTerminal(
          `  -> ${record.title} (${record.uuid}): ${extractErrorMessage(error)}`,
        ),
      ),
    );
  });

  process.exitCode = 1;
}

// autoSync turns the CLI into a self-scheduling daemon, so a bare `markpost`
// invocation won't return. Announce it once per process (not on every
// scheduled iteration) so the user knows the process is intentionally staying
// alive without spamming the banner every interval.
function announceAutoSync(autoSync: boolean): void {
  if (!autoSync || autoSyncAnnounced) {
    return;
  }

  autoSyncAnnounced = true;
  console.log(
    chalk.dim(
      `  autoSync is on — will re-sync every ${AUTO_SYNC_INTERVAL_MINUTES}m (Ctrl-C to stop).`,
    ),
  );
}

// Surface records the `skip` strategy left unwritten: they stay on the server
// (they're excluded from the delete), so the user needs to know they weren't
// synced rather than silently losing count of them.
function reportSkipped(skippedCount: number): void {
  if (skippedCount <= 0) {
    return;
  }

  console.log(
    chalk.yellow(
      `Skipped ${skippedCount} record(s): a file already exists at their path — left on the server.`,
    ),
  );
}

// PATCHes the written records synced in bounded-concurrency batches, returning
// a success flag per record in the original order.
async function markRecordsInBatches(
  writtenRecords: WrittenRecord[],
): Promise<boolean[]> {
  const results: boolean[] = [];

  for (
    let start = 0;
    start < writtenRecords.length;
    start += MARK_SYNCED_CONCURRENCY
  ) {
    const batch = writtenRecords.slice(start, start + MARK_SYNCED_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(({ record, filePath }) =>
        markRecordSynced(record.uuid, filePath),
      ),
    );

    results.push(...batchResults);
  }

  return results;
}

// Surfaces mark-synced failures loudly (never as success): an unmarked record
// stays pending and gets re-written as a duplicate next run, so the user needs
// to know which files are affected. Still reports how many succeeded so a
// single failure in a large batch doesn't hide that the rest went through.
function reportMarkFailures(
  failures: WrittenRecord[],
  markedCount: number,
  spinner: Spinner,
): void {
  spinner.error(
    `Failed to mark ${failures.length} record(s) synced — written locally but still pending on the server; they may be re-written next run.`,
  );
  failures.forEach(({ record, filePath }) => {
    // Sanitize the composed line: record.uuid comes from the same untrusted API
    // response as a title, and filePath embeds the user-configured output path —
    // either could carry an escape sequence. Route to stderr like the write-
    // failure list so `2>` captures exactly which files are still pending.
    console.error(
      chalk.dim(sanitizeForTerminal(`  ! ${record.uuid} -> ${filePath}`)),
    );
  });

  if (markedCount > 0) {
    console.log(
      chalk.dim(`  Marked ${markedCount} record(s) synced despite the above.`),
    );
  }

  process.exitCode = 1;
}

// Marks every written record synced on the server after a write, so the next
// run's pending-only fetch skips them — the autoDelete-off path's
// non-destructive equivalent of the delete step.
async function markWrittenRecordsSynced(
  writtenRecords: WrittenRecord[],
  spinner: Spinner,
): Promise<void> {
  if (writtenRecords.length === 0) {
    return;
  }

  spinner.start('Marking records synced...');

  const results = await markRecordsInBatches(writtenRecords);
  const failures = writtenRecords.filter((_written, index) => !results[index]);

  if (failures.length > 0) {
    reportMarkFailures(
      failures,
      writtenRecords.length - failures.length,
      spinner,
    );
    return;
  }

  spinner.success(`Marked ${writtenRecords.length} records synced!`);
}

// Ends a truncated sync on the truncation warning, never on a green success
// line — otherwise the last thing on screen reads as a clean run even though a
// page failed and records remain on the server (exit code is already 1). Called
// before every path that would otherwise finish on a success mark.
function reportIncompleteSync(partial: boolean): void {
  if (!partial) {
    return;
  }

  console.error(
    chalk.yellow(
      'Sync was incomplete — a later page failed to fetch. Re-run to collect the remaining records.',
    ),
  );
}

// Resolves the server side of a write and reports whether the records are
// settled server-side (safe to record in-process so the autoSync daemon won't
// re-write them). Three cases: settings unreadable → mutate nothing and leave
// records pending (the real preference is unknown, and deleting is
// irreversible); autoDelete off → mark the written records synced on the
// server so the next pending-only fetch skips them; autoDelete on → delete
// them, with a failed or partial delete returning false so they're retried
// next iteration instead of being abandoned.
async function finalizeServerRecords(
  writtenRecords: WrittenRecord[],
  autoDelete: boolean,
  settingsOk: boolean,
  spinner: Spinner,
): Promise<boolean> {
  // Settings unreadable: autoDelete is forced off upstream and we don't know
  // the user's real preference, so mutate nothing on the server. Marking synced
  // here would be permanent and unrecoverable — a user whose real setting is
  // autoDelete on would have these records flipped to `synced`, and the next
  // pending-only fetch would never see them again. Leaving them pending risks
  // re-writing them as fresh suffixed files next run (the lesser, recoverable
  // evil), so we return false rather than record them synced in-process.
  if (!settingsOk) {
    console.log(
      chalk.yellow(
        '  Settings unreadable — records left pending; they will be re-written as new files each run until settings are readable.',
      ),
    );
    return false;
  }

  // autoDelete off (settings known): mark the written records synced on the
  // server so the next run's pending-only fetch skips them instead of writing
  // duplicate files — the non-destructive equivalent of the delete step.
  if (!autoDelete) {
    await markWrittenRecordsSynced(writtenRecords, spinner);
    return true;
  }

  // A bare DELETE with an empty uuid list would be a wasted, possibly-rejected
  // request reported as success.
  if (writtenRecords.length === 0) {
    return true;
  }

  spinner.start('Deleting records...');
  const deleteMeta = await deleteRecords(
    writtenRecords.map(({ record }) => record.uuid),
  );

  // deleteRecords swallows its own errors and returns null; reporting success
  // here would lie (records still on the server, re-fetched next run). Surface
  // the failure loudly and report "not settled" so they're retried.
  if (!deleteMeta) {
    spinner.error(
      'Failed to delete records from the server — they were written locally but remain on the server.',
    );
    process.exitCode = 1;
    return false;
  }

  // A partial delete (fewer removed than requested) must not be reported as a
  // full success — the survivors would be recorded synced and abandoned. Fail
  // loud and retry them next iteration.
  if (deleteMeta.deleted < writtenRecords.length) {
    spinner.error(
      `Deleted ${deleteMeta.deleted} of ${writtenRecords.length} records — the rest remain on the server and will be retried.`,
    );
    process.exitCode = 1;
    return false;
  }

  spinner.success(`Deleted ${deleteMeta.deleted} records!`);
  return true;
}

// Default behavior when no subcommand is given: read the user's markpost
// settings, fetch all records, write each to a markdown file honoring the
// conflict strategy, then (only if autoDelete is on) delete the records that
// were actually written from the server. Returns whether `autoSync` is on so
// the scheduler can decide to repeat the sync (see runSyncWithAutoSchedule).
async function runDefaultSync(): Promise<boolean> {
  const spinner = yoctoSpinner({ spinner: cliSpinners.dots });
  // Reset per iteration: in autoSync's daemon loop a transient failure that
  // set exitCode=1 must not stick and mark a later, fully-successful run as
  // failed to whatever supervises the process.
  process.exitCode = 0;

  // Start from the last confirmed value so a failure before the settings read
  // (checkConfig, an unreachable settings endpoint) resumes an already-running
  // daemon rather than silently ending it. Stays false until the first
  // successful read, so a failure on the very first iteration never loops.
  let autoSync = lastResolvedSettings?.autoSync ?? false;

  try {
    await checkConfig();

    // Read settings up front so both write and delete honor the user's
    // markpost preferences. A failed read (`ok: false`) reuses the last
    // confirmed settings when we have them (so records keep the user's real
    // format) but always forces autoDelete off — deleting server records is
    // irreversible, so an unconfirmed state must never delete. A successful
    // read with no saved row (`settings: null`) is a real account default, so
    // it uses markpost's defaults. resolveSyncSettings owns those fallbacks
    // (see settings.ts).
    const settingsResult = await fetchSettings();
    const resolved = resolveSyncSettings(settingsResult);

    if (settingsResult.ok) {
      lastResolvedSettings = resolved;
    }

    // On a failed read with a prior good read, reuse it (autoDelete forced off);
    // otherwise take the resolver's conservative defaults.
    const {
      conflictStrategy,
      autoDelete,
      autoSync: resolvedAutoSync,
      includeFrontmatter,
    } = settingsResult.ok || !lastResolvedSettings
      ? resolved
      : { ...lastResolvedSettings, autoDelete: false };
    autoSync = resolvedAutoSync;

    if (!settingsResult.ok) {
      console.log(
        chalk.yellow(
          'Could not read settings — writing records but skipping the auto-delete this run. Re-run once settings are reachable.',
        ),
      );
    }

    announceAutoSync(autoSync);

    // Fetch records
    spinner.start('Fetching records...');
    const recordsResult = await fetchAllRecords();

    // A failed fetch must fail loud: reporting "No new records" and exiting 0
    // on a network/auth error silently masks a broken sync in cron. An empty
    // account still succeeds via the `ok: true` branch below.
    if (!recordsResult.ok) {
      spinner.error(
        'Failed to fetch records from the server — nothing synced.',
      );
      process.exitCode = 1;
      return autoSync;
    }

    const allRecords = recordsResult.records;

    // Drop records already written earlier this process so a self-scheduling
    // run doesn't re-write them (see syncedRecordIds).
    const newRecords = allRecords.filter(
      (record) => !syncedRecordIds.has(record.uuid),
    );

    // A later page failed mid-pagination: sync what was fetched, but fail loud
    // (error mark + non-zero exit) so cron never treats a truncated sync as a
    // clean one. The unfetched pages stay on the server for a later run.
    if (recordsResult.partial) {
      spinner.error(
        `Fetched ${allRecords.length} record(s), but a later page failed — more remain on the server. Re-run to collect them.`,
      );
      process.exitCode = 1;

      // Nothing new to write or delete — return rather than running the write
      // path and printing a confusing "Wrote 0 records!" after the error mark.
      if (newRecords.length === 0) {
        return autoSync;
      }
    } else if (newRecords.length === 0) {
      spinner.success(
        autoSync ? 'No new records.' : 'No new records, exiting...',
      );
      return autoSync;
    } else {
      spinner.success(`Fetched ${newRecords.length} records!`);
    }

    // Write Records
    spinner.start('Writing records...');
    // A batch-wide precondition (unset/un-creatable output directory) throws
    // here into the outer catch and is reported once, before the per-record
    // loop — so a systemic error can't masquerade as N per-record failures.
    ensureOutputDirectory();
    const {
      written: writtenRecords,
      failed: failedRecords,
      skipped: skippedCount,
    } = writeRecords(newRecords, conflictStrategy, includeFrontmatter);
    reportWriteOutcome(spinner, writtenRecords.length, failedRecords.length);
    writtenRecords.forEach(({ filePath }) => {
      console.log(chalk.dim(`  -> ${filePath}`));
    });

    reportSkipped(skippedCount);
    reportWriteFailures(failedRecords);

    const settled = await finalizeServerRecords(
      writtenRecords,
      autoDelete,
      settingsResult.ok,
      spinner,
    );

    // Mark synced only once settled server-side: a failed delete leaves them
    // unmarked so the next iteration retries instead of abandoning them.
    if (settled) {
      writtenRecords.forEach(({ record }) => syncedRecordIds.add(record.uuid));
    }

    reportIncompleteSync(recordsResult.partial);

    return autoSync;
  } catch (error) {
    spinner.error('Something went wrong!');
    // Systemic errors surface here (unset output dir, a failed fetch/delete).
    // Sanitize before printing: a server- or API-derived message can embed an
    // escape sequence, same threat the per-record failure path guards against.
    console.error(
      chalk.redBright(sanitizeForTerminal(extractErrorMessage(error))),
    );
    process.exitCode = 1;
    // Keep the daemon alive across a transient failure (a network blip
    // shouldn't end an autoSync session); the next iteration resets exitCode
    // and retries. `autoSync` is still `false` if we failed before reading
    // settings, so a run that never got that far won't start looping.
    return autoSync;
  }
}
