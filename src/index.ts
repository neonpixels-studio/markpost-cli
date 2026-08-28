#!/usr/bin/env node

import {
  deleteRecords,
  fetchAllRecords,
  markRecordsSynced,
  MARK_ABORTED,
  MARK_SYNCED,
  MARK_TIMED_OUT,
  MarkSyncedItem,
  MarkSyncedStop,
  PENDING_STATUS,
} from '@/libs/records.js';
import { describeApiError, isSystemicApiFailure } from '@/libs/api.js';
import {
  buildWritePreview,
  ensureOutputDirectory,
  writeMarkdown,
  WritePreview,
  WrittenRecordState,
} from '@/libs/markdown.js';
import { fetchSettings, SettingsReadResult } from '@/libs/settings.js';
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
import {
  runSettingsCommand,
  USAGE as SETTINGS_USAGE,
} from '@/commands/settings.js';
import yoctoSpinner from 'yocto-spinner';
import cliSpinners from 'cli-spinners';
import chalk from 'chalk';
import { checkConfig } from '@/libs/config.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { runSyncWithAutoSchedule } from '@/libs/scheduler.js';
import { Record } from '@/types/records.types.js';
import {
  ConflictStrategy,
  normalizeAutoDelete,
  normalizeAutoSync,
  normalizeConflictStrategy,
  normalizeFrontmatterEnabled,
} from '@/types/settings.types.js';

type Spinner = ReturnType<typeof yoctoSpinner>;

// Slug ownership (resolved `<slug>.md` path -> the uuid that wrote it), shared
// across every autoSync pass in this process rather than rebuilt per pass.
// autoSync deletes each pass's records server-side, so a later pass fetching a
// *different* same-slug record would, under `overwrite`, clobber the earlier
// pass's on-disk file — and the deleted original is unrecoverable. Persisting
// ownership across passes lets resolveStrategyForSlug downgrade only a different
// record to `suffix`. Lifetime is the CLI process (the autoSync daemon stays up
// across passes); a cron-style loop of separate single-pass `markpost sync`
// invocations starts empty each time and does not get this cross-run guard.
const processSeenSlugs = new Map<string, string>();

// Written-vs-settled bookkeeping (uuid -> the file written for it this process
// plus a hash of its content), shared across autoSync passes like
// processSeenSlugs. A record whose server-side settle (mark-synced/delete) fails
// stays pending and is re-fetched next pass; carrying its written state forward
// lets writeMarkdown reuse that file instead of the suffix strategy dropping a
// fresh `<slug>-2.md`, `<slug>-3.md` duplicate every pass, and lets a suffix/skip
// reuse re-fetch a server-side content change without clobbering a vault edit.
// The orchestrator drops an entry once the record settles (see
// forgetSettledRecords). Lifetime is the CLI process, so a cron-style loop of
// separate single-pass invocations starts empty each time — the same limitation
// processSeenSlugs carries.
const processWrittenState = new Map<string, WrittenRecordState>();

const [commandName, ...commandArgs] = process.argv.slice(2);

const SYNC_COMMAND = 'sync';

// The one flag `sync` accepts: preview the exact write/delete plan without
// touching disk or the server. Named so the parse check and usage text share
// the single literal.
const DRY_RUN_FLAG = '--dry-run';

// The fetch/write/delete sync is destructive (it can delete server records),
// so it must be requested explicitly by name — never triggered by a bare,
// accidental `markpost`. Its usage lives here because the sync lives here.
const SYNC_USAGE = `Usage: markpost sync [--dry-run]

  Fetch all pending records, write each to a markdown file, and (when
  autoDelete is enabled) delete the written records from the server

  --dry-run  Report which files would be written and which records would be
             deleted (or marked synced) without writing or mutating anything`;

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
  ['settings', { run: runSettingsCommand, usage: SETTINGS_USAGE }],
]);

// The sync is the one destructive command, so it rejects unexpected arguments
// (a typo, a stray flag) rather than ignoring them and silently fetching,
// writing, and deleting server records. `--help`/`-h` are intercepted before
// this runs (see dispatch), so anything reaching here is a genuine mistake.
async function runSyncCommand(args: string[]): Promise<void> {
  const dryRun = args.includes(DRY_RUN_FLAG);
  const unexpectedArgs = args.filter((arg) => arg !== DRY_RUN_FLAG);

  if (unexpectedArgs.length > 0) {
    console.error(
      chalk.redBright(`Unexpected arguments: ${unexpectedArgs.join(' ')}`),
    );
    console.error(SYNC_USAGE);
    process.exitCode = 1;
    return;
  }

  // The scheduler self-repeats the sync when a run reports `autoSync` on; a
  // single, non-repeating run returns after one pass. A dry run always reports
  // back `false` (see runDefaultSync), so it previews once and never
  // self-schedules — a preview loop would be noise, not a sync.
  await runSyncWithAutoSchedule(() => runDefaultSync(dryRun));
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
  // uuids whose changed server revision was dropped in favor of a local vault
  // edit during a suffix/skip reuse. The caller warns about these and holds them
  // back from the server-side delete/mark-synced so the revision isn't lost
  // silently (issue #110).
  droppedServerChangeUuids: Set<string>;
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
  seenSlugs: Map<string, string>,
  includeFrontmatter: boolean,
  writtenState: Map<string, WrittenRecordState>,
  droppedServerChanges: Set<string>,
): WriteOutcome {
  try {
    const filePath = writeMarkdown(
      record,
      conflictStrategy,
      seenSlugs,
      includeFrontmatter,
      writtenState,
      droppedServerChanges,
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
  seenSlugs: Map<string, string>,
  writtenState: Map<string, WrittenRecordState>,
): WriteRecordsResult {
  // `seenSlugs` (the module-scope `processSeenSlugs`) is threaded in so this
  // stays a function of its inputs. A sequential loop preserves order and shares
  // the one Map across every record; ownership semantics live in writeMarkdown.
  const written: WrittenRecord[] = [];
  const failed: FailedRecord[] = [];
  // One collector shared across the batch: writeMarkdown adds a uuid whenever a
  // suffix/skip reuse drops a changed server revision for a local vault edit.
  const droppedServerChangeUuids = new Set<string>();
  let skipped = 0;

  for (const record of records) {
    const outcome = writeRecordSafely(
      record,
      conflictStrategy,
      seenSlugs,
      includeFrontmatter,
      writtenState,
      droppedServerChangeUuids,
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

  return { written, failed, skipped, droppedServerChangeUuids };
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

// Split written records into the ones safe to settle server-side and the ones
// whose changed server revision was dropped for a local vault edit. The latter
// are held back from the delete/mark-synced so the server keeps the revision the
// user hasn't reconciled yet — deleting it would lose it for good (issue #110).
function partitionDeferredRecords(
  writtenRecords: WrittenRecord[],
  droppedServerChangeUuids: Set<string>,
): { settleable: WrittenRecord[]; deferred: WrittenRecord[] } {
  const settleable = writtenRecords.filter(
    ({ record }) => !droppedServerChangeUuids.has(record.uuid),
  );
  const deferred = writtenRecords.filter(({ record }) =>
    droppedServerChangeUuids.has(record.uuid),
  );

  return { settleable, deferred };
}

// Surface dropped server revisions loudly rather than deleting them silently: the
// server copy changed while the user also edited the local file, so the local
// edit was kept and the record is left on the server (excluded from the delete)
// for the user to reconcile. A warning, not an error — this is an expected,
// recoverable conflict state, mirroring how the `skip` count is reported. A no-op
// when nothing was deferred.
function reportDeferredServerChanges(deferredRecords: WrittenRecord[]): void {
  if (deferredRecords.length === 0) {
    return;
  }

  console.log(
    chalk.yellow(
      `Deferred ${deferredRecords.length} record(s): the server copy changed but your local file has edits — left on the server so the server version isn't lost. Reconcile each file, then re-run.`,
    ),
  );
  deferredRecords.forEach(({ record, filePath }) => {
    // Sanitize the composed line: record.title/uuid come from the untrusted API
    // response and filePath embeds the user-configured output path — any could
    // carry an escape sequence, same guard as the write/mark failure reporters.
    console.log(
      chalk.yellow(
        sanitizeForTerminal(
          `  ~ ${record.title} (${record.uuid}) -> ${filePath}`,
        ),
      ),
    );
  });
}

// Projects each written record down to the `{ uuid, filePath }` shape the bulk
// mark-synced call needs, preserving order so the returned outcomes stay aligned
// to `writtenRecords` by index. Chunking and the stop-on-abort logic live in
// `markRecordsSynced` (the records lib), keeping the API surface isolated there.
function toMarkSyncedItems(writtenRecords: WrittenRecord[]): MarkSyncedItem[] {
  return writtenRecords.map(({ record, filePath }) => ({
    uuid: record.uuid,
    filePath,
  }));
}

// Headline for the mark-synced failure report. An abort reads differently from a
// scatter of per-record failures: it stopped the run early, so the pending count
// can fold in records never attempted after the abort. `unattemptedCount` is how
// many of those pending records were never sent (the chunks after the stop), so
// the abort wording only claims "the rest were not attempted" when that's true —
// an abort on the final chunk leaves nothing unattempted. All cases leave the
// listed records pending on the server.
function markFailureHeadline(
  pendingCount: number,
  stoppedBy: MarkSyncedStop,
  unattemptedCount: number,
): string {
  if (stoppedBy === MARK_TIMED_OUT) {
    return `Timed out marking records synced — stopped after the first timeout; ${pendingCount} record(s) still pending on the server, they may be re-written next run.`;
  }

  if (stoppedBy === MARK_ABORTED) {
    const notAttemptedClause =
      unattemptedCount > 0 ? ' and the rest were not attempted' : '';
    return `Aborted marking records synced — the server rejected the request wholesale (a 400/422), so every record would fail the same way${notAttemptedClause}; ${pendingCount} record(s) still pending on the server, they may be re-written next run.`;
  }

  return `Failed to mark ${pendingCount} record(s) synced — written locally but still pending on the server; they may be re-written next run.`;
}

// Surfaces mark-synced failures loudly (never as success): an unmarked record
// stays pending and gets re-written as a duplicate next run, so the user needs
// to know which files are affected. Still reports how many succeeded so a
// single failure in a large batch doesn't hide that the rest went through.
function reportMarkFailures(
  failures: WrittenRecord[],
  markedCount: number,
  stoppedBy: MarkSyncedStop,
  unattemptedCount: number,
  spinner: Spinner,
): void {
  spinner.error(
    markFailureHeadline(failures.length, stoppedBy, unattemptedCount),
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

// Settled bookkeeping: a record whose server-side step (mark-synced or delete)
// succeeded will never be re-fetched as pending, so drop it from the written-
// path map. This is the "settled" half of the written-vs-settled split —
// keeping the entry would only leak memory across a long-running autoSync
// daemon, and a settled record no longer needs its file reused. Takes the map
// as an argument (like writeRecords threads processSeenSlugs) so it stays a
// function of its inputs.
function forgetSettledRecords(
  writtenState: Map<string, WrittenRecordState>,
  uuids: string[],
): void {
  uuids.forEach((uuid) => writtenState.delete(uuid));
}

// Marks every written record synced on the server after a write, so the next
// run's pending-only fetch skips them — the autoDelete-off path's
// non-destructive equivalent of the delete step.
async function markWrittenRecordsSynced(
  writtenRecords: WrittenRecord[],
  spinner: Spinner,
  writtenState: Map<string, WrittenRecordState>,
): Promise<void> {
  if (writtenRecords.length === 0) {
    return;
  }

  spinner.start('Marking records synced...');

  const { outcomes, stoppedBy } = await markRecordsSynced(
    toMarkSyncedItems(writtenRecords),
  );
  // A record is settled only when its mark-synced outcome is MARK_SYNCED; it is
  // pending if its mark failed or was never attempted (its outcome is undefined
  // because an abort — a timeout, a systemic failure, or a request-shape 4xx —
  // stopped the run before its chunk). Evict settled records from the written-
  // path map so a long-running autoSync daemon doesn't leak memory — the
  // "settled" half of the written-vs-settled split.
  const settled = writtenRecords.filter(
    (_written, index) => outcomes[index] === MARK_SYNCED,
  );
  const pending = writtenRecords.filter(
    (_written, index) => outcomes[index] !== MARK_SYNCED,
  );

  forgetSettledRecords(
    writtenState,
    settled.map(({ record }) => record.uuid),
  );

  if (pending.length > 0) {
    // Records the run never reached: an abort/timeout stops before later chunks,
    // so their outcome index is undefined and they have no per-record outcome.
    const unattemptedCount = writtenRecords.length - outcomes.length;
    reportMarkFailures(
      pending,
      writtenRecords.length - pending.length,
      stoppedBy,
      unattemptedCount,
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

// The records a dry run would actually persist. A `skip` leaves the existing
// file untouched and the record on the server, so it never reaches the delete
// or mark-synced step — mirroring the real sync, which excludes skipped records
// from both.
function previewedWrites(previews: WritePreview[]): WritePreview[] {
  return previews.filter((preview) => preview.action !== 'skip');
}

// Prints the local write plan: each record that would be written (with its
// target path and whether it's a fresh write or an overwrite), then a separate
// yellow line for records the `skip` strategy would leave on disk and on the
// server — matching the real sync's write/skip reporting. Paths are sanitized
// like the real write output: the resolved path embeds the user-configured
// output directory and a title-derived slug, either of which could carry an
// escape.
function printWritePreview(previews: WritePreview[]): void {
  const writes = previewedWrites(previews);
  const skips = previews.filter((preview) => preview.action === 'skip');

  console.log(chalk.dim(`Would write ${writes.length} record(s):`));
  writes.forEach((preview) => {
    console.log(
      chalk.dim(
        sanitizeForTerminal(`  -> ${preview.path} (${preview.action})`),
      ),
    );
  });

  if (skips.length === 0) {
    return;
  }

  console.log(
    chalk.yellow(
      `Would skip ${skips.length} record(s): a file already exists at their path — left on the server.`,
    ),
  );
  skips.forEach((preview) => {
    console.log(chalk.yellow(sanitizeForTerminal(`  -> ${preview.path}`)));
  });
}

// Lists the records a server-side step would touch. Sanitized because both the
// uuid and title come from the untrusted API response.
function printPreviewedServerRecords(writes: WritePreview[]): void {
  writes.forEach(({ record }) => {
    console.log(
      chalk.dim(sanitizeForTerminal(`  ! ${record.uuid} (${record.title})`)),
    );
  });
}

// Prints the server-side plan for a dry run. Unreadable settings force the real
// sync to mutate nothing (autoDelete off and no mark-synced), so the preview
// says exactly that. Otherwise autoDelete decides between a delete preview and
// the mark-synced preview — the same branch the real sync takes.
function printServerPreview(
  previews: WritePreview[],
  autoDelete: boolean,
  settingsOk: boolean,
): void {
  if (!settingsOk) {
    console.log(
      chalk.yellow(
        'Settings unreadable — would write records but mutate nothing on the server this run.',
      ),
    );
    return;
  }

  const writes = previewedWrites(previews);

  if (writes.length === 0) {
    return;
  }

  if (autoDelete) {
    console.log(
      chalk.dim(`Would delete ${writes.length} record(s) from the server:`),
    );
    printPreviewedServerRecords(writes);
    return;
  }

  console.log(
    chalk.dim(`Would mark ${writes.length} record(s) synced on the server:`),
  );
  printPreviewedServerRecords(writes);
}

// The whole dry run: announce it, build the read-only write plan (honoring the
// user's conflict strategy), then print the local and server-side plans. No
// spinner phase — nothing runs, so this is plain informational output.
// buildWritePreview may throw (e.g. output directory unset); the caller's outer
// catch surfaces it, same as the real write path.
function reportDryRunPlan(
  records: Record[],
  conflictStrategy: ConflictStrategy,
  autoDelete: boolean,
  settingsOk: boolean,
): void {
  console.log(
    chalk.yellow(
      `Dry run — previewing ${records.length} record(s); nothing will be written or deleted.`,
    ),
  );

  const previews = buildWritePreview(records, conflictStrategy);
  printWritePreview(previews);
  printServerPreview(previews, autoDelete, settingsOk);
}

// Default behavior when no subcommand is given: read the user's markpost
// settings, fetch all records, write each to a markdown file honoring the
// conflict strategy, then (only if autoDelete is on) delete the records that
// were actually written from the server. Returns whether `autoSync` is on so
// the scheduler can decide to repeat the sync (see runSyncWithAutoSchedule).
// `dryRun` short-circuits every mutation: it fetches and reports the exact
// write/delete plan, then returns `false` so the run never writes, deletes,
// marks synced, or self-schedules.
async function runDefaultSync(dryRun = false): Promise<boolean> {
  const spinner = yoctoSpinner({ spinner: cliSpinners.dots });

  // Hoisted to function scope so the outer catch can honor it: a transient
  // systemic failure (rate-limit/5xx) should let an autoSync daemon retry next
  // pass rather than shut it down. Defaults off so an early crash (before
  // settings are read) never spins a daemon that just keeps crashing.
  let autoSync = false;

  try {
    // A missing-config exit must never arm the auto-sync daemon, so return a
    // literal false rather than the `autoSync` initializer that merely happens
    // to still be false here.
    if (!(await checkConfig())) {
      return false;
    }

    // Read settings up front so both write and delete honor the user's
    // markpost preferences. A failed read (`ok: false`) still writes (suffix
    // is the safe non-destructive default) but never auto-deletes — deleting
    // server records is irreversible, so an unknown state must not fall
    // through to "delete". A successful read with no saved row (`settings:
    // null`) is a real account default, so it uses markpost's defaults
    // silently.
    // A settings read failure (including a timeout) is deliberately
    // non-fatal: the conservative `ok: false` branch below still writes
    // records and only skips the irreversible auto-delete. Degrade a settings
    // timeout here rather than letting it abort the whole sync — writing was
    // never the risky operation, so a slow settings endpoint must not cost
    // the user their records.
    const settingsResult = await fetchSettings().catch(
      (error: unknown): SettingsReadResult => {
        // Sanitize before printing: a propagated timeout's message embeds the
        // (env-controlled) base URL, and any future API-derived rethrow could
        // carry an escape sequence — same guard as the outer catch below.
        console.error(
          chalk.redBright(sanitizeForTerminal(extractErrorMessage(error))),
        );

        return { ok: false };
      },
    );
    const settings = settingsResult.ok ? settingsResult.settings : null;
    const conflictStrategy = normalizeConflictStrategy(
      settings?.conflictStrategy,
    );
    const autoDelete = settingsResult.ok
      ? normalizeAutoDelete(settings?.autoDelete)
      : false;
    // A failed settings read leaves autoSync off: without confirmed settings
    // we don't spin up a self-scheduling daemon (mirrors the conservative
    // autoDelete above). Frontmatter defaults to on — the safe,
    // non-destructive default, matching how conflictStrategy falls back.
    autoSync = settingsResult.ok
      ? normalizeAutoSync(settings?.autoSync)
      : false;
    const includeFrontmatter = settingsResult.ok
      ? normalizeFrontmatterEnabled(settings?.frontmatter)
      : true;

    if (!settingsResult.ok) {
      console.log(
        chalk.yellow(
          'Could not read settings — writing records but skipping the auto-delete this run. Re-run once settings are reachable.',
        ),
      );
    }

    // Fetch records. Scope the sync to pending only: markpost returns every
    // status when unfiltered, so without this the server hands back records
    // already written to disk and they get re-fetched and re-written as endless
    // `-2`/`-3` duplicates. The mark-synced step below moves each written
    // record out of `pending` so the next run skips it.
    spinner.start('Fetching records...');
    const recordsResult = await fetchAllRecords({ status: PENDING_STATUS });

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

    // A later page failed mid-pagination: sync what was fetched, but fail loud
    // (error mark + non-zero exit) so cron never treats a truncated sync as a
    // clean one. The unfetched pages stay on the server for a later run.
    if (recordsResult.partial) {
      spinner.error(
        `Fetched ${allRecords.length} record(s), but a later page failed — more remain on the server. Re-run to collect them.`,
      );
      process.exitCode = 1;

      // Nothing was fetched, so there's nothing to write or delete — return
      // rather than running the write path and printing a confusing
      // "Wrote 0 records!" right after the error mark.
      if (allRecords.length === 0) {
        return autoSync;
      }
    } else if (allRecords.length === 0) {
      spinner.success('No new records, exiting...');
      return autoSync;
    } else {
      spinner.success(`Fetched ${allRecords.length} records!`);
    }

    // Dry run: report the exact write/delete plan and stop before any mutation
    // — no directory creation, no file writes, no server delete or mark-synced.
    // Placed after the fetch and settings read so the preview reflects the real
    // record set and the user's conflict strategy / autoDelete preference.
    // Returns `false` unconditionally so a dry run previews once and never
    // self-schedules.
    if (dryRun) {
      reportDryRunPlan(
        allRecords,
        conflictStrategy,
        autoDelete,
        settingsResult.ok,
      );
      reportIncompleteSync(recordsResult.partial);
      return false;
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
      droppedServerChangeUuids,
    } = writeRecords(
      allRecords,
      conflictStrategy,
      includeFrontmatter,
      processSeenSlugs,
      processWrittenState,
    );
    reportWriteOutcome(spinner, writtenRecords.length, failedRecords.length);
    writtenRecords.forEach(({ filePath }) => {
      console.log(chalk.dim(`  -> ${filePath}`));
    });

    // Surface records the `skip` strategy left unwritten: they stay on the
    // server (they're excluded from the delete below), so the user needs to
    // know they weren't synced rather than silently losing count of them.
    if (skippedCount > 0) {
      console.log(
        chalk.yellow(
          `Skipped ${skippedCount} record(s): a file already exists at their path — left on the server.`,
        ),
      );
    }

    reportWriteFailures(failedRecords);

    // Hold back any record whose changed server revision was dropped for a local
    // edit: warn about it and exclude it from the delete/mark-synced below so the
    // server keeps the unreconciled revision (issue #110). Everything else is
    // safe to settle.
    const { settleable: settleableRecords, deferred: deferredRecords } =
      partitionDeferredRecords(writtenRecords, droppedServerChangeUuids);
    reportDeferredServerChanges(deferredRecords);

    // Settings unreadable: autoDelete is forced off above and we don't know
    // the user's real preference, so mutate nothing on the server. Marking
    // synced here would be permanent and unrecoverable — a user whose real
    // setting is autoDelete on would have these records flipped to `synced`,
    // and the next pending-only fetch would never see them again, so the
    // deferred delete the warning above promises could never happen. Skipping
    // the mark risks re-writing these records as fresh `-2`/`-3` files on every
    // run until settings are readable again (bounded by the non-destructive
    // suffix default), which we warn about explicitly below — the lesser,
    // recoverable evil versus a permanent strand.
    if (!settingsResult.ok) {
      console.log(
        chalk.yellow(
          '  Settings unreadable — records left pending; their files are reused while this process runs and re-created on a fresh run, until settings are readable.',
        ),
      );
      reportIncompleteSync(recordsResult.partial);
      return autoSync;
    }

    // autoDelete off (settings known): mark the written records synced so the
    // next run's pending-only fetch skips them instead of re-writing duplicate
    // files.
    if (!autoDelete) {
      await markWrittenRecordsSynced(
        settleableRecords,
        spinner,
        processWrittenState,
      );
      reportIncompleteSync(recordsResult.partial);
      return autoSync;
    }

    // Delete Records — skipped when nothing is settleable (a bare DELETE with an
    // empty uuid list would be a wasted, possibly-rejected request reported as
    // success). Deferred records are excluded so their changed server revision
    // survives (issue #110).
    if (settleableRecords.length === 0) {
      reportIncompleteSync(recordsResult.partial);
      return autoSync;
    }

    spinner.start('Deleting records...');
    // deleteRecords swallows its own per-request errors to null but re-throws a
    // timeout and any systemic auth/5xx failure. Describe the reason
    // (deleteRecords never got to log a re-thrown error, since the rethrow
    // happens before its logger — and `describeApiError` classifies a systemic
    // failure) and route it to the same null branch below, so the user gets
    // both the "why" and the specific "remain on the server" consequence with a
    // non-zero exit — not the generic outer catch's "Something went wrong!".
    // A PERMANENT delete failure (dead token, forbidden account) will recur on
    // every pass, so it must also stop the autoSync self-scheduling below —
    // otherwise the daemon wakes every few minutes, re-fetches the same pending
    // records, and re-writes them as `-2`/`-3` duplicates against a server it
    // already knows it can't delete from. A transient failure (rate-limit/5xx,
    // timeout) is worth another pass, so it keeps autoSync alive. Captured here
    // so the failure branch can tell the two apart.
    let deletePermanentlyFailed = false;
    const deleteMeta = await deleteRecords(
      settleableRecords.map(({ record }) => record.uuid),
    ).catch((error: unknown) => {
      deletePermanentlyFailed =
        isSystemicApiFailure(error) && error.isPermanent;
      // Sanitize before printing, same threat as the outer catch: a
      // server- or API-derived message can embed an escape.
      console.error(
        chalk.redBright(sanitizeForTerminal(describeApiError(error))),
      );

      return null;
    });

    // Reporting success here would lie (records still on the server,
    // re-fetched and duplicated next run). Surface the failure loudly instead.
    if (!deleteMeta) {
      spinner.error(
        'Failed to delete records from the server — they were written locally but remain on the server.',
      );
      process.exitCode = 1;
      // Don't keep rescheduling into a known-permanent failure; a transient one
      // still retries next pass.
      return deletePermanentlyFailed ? false : autoSync;
    }

    // Settle only on a confirmed full delete. deleteRecords returns a bare
    // count, not per-uuid results, so a short count (`deleted < written`) can't
    // tell which uuids survived; retaining every entry keeps the reuse guard for
    // any record still pending, at the harmless cost of a stale entry for the
    // ones that were deleted. A record not deleted stays pending and, without
    // its tracked path, would drop a fresh `<slug>-2.md` duplicate next pass —
    // the exact bug this split prevents.
    if (deleteMeta.deleted === settleableRecords.length) {
      forgetSettledRecords(
        processWrittenState,
        settleableRecords.map(({ record }) => record.uuid),
      );
    }

    spinner.success(`Deleted ${deleteMeta.deleted} records!`);

    reportIncompleteSync(recordsResult.partial);
    return autoSync;
  } catch (error) {
    process.exitCode = 1;

    // A systemic API failure (expired/invalid token, rate limit, 5xx) doomed
    // the whole read. Route the classified, actionable detail (e.g. "run
    // `markpost config`") through console.error so it prints unconditionally —
    // `spinner.error` no-ops when no spinner is active — and a cron log always
    // says *why* the sync died; the spinner headline is just the interactive
    // cue. Sanitize — the message is server-derived and can embed an escape.
    if (isSystemicApiFailure(error)) {
      spinner.error('Sync failed.');
      // `describeApiError` yields the classified `describeSystemicFailure`
      // text inside this guard, so we don't call the latter directly.
      console.error(
        chalk.redBright(sanitizeForTerminal(describeApiError(error))),
      );
      // A permanent failure (dead token, forbidden account) won't clear on
      // retry — stop the autoSync daemon. A transient one (rate-limit/5xx) is
      // worth another pass, so keep autoSync alive to retry ("retry shortly").
      return error.isPermanent ? false : autoSync;
    }

    spinner.error('Something went wrong!');
    // Other errors surface here (unset output dir, a non-systemic failure).
    // Sanitize before printing: a server- or API-derived message can embed an
    // escape sequence, same threat the per-record failure path guards against.
    // `describeApiError` returns the bare message for these non-systemic cases.
    console.error(
      chalk.redBright(sanitizeForTerminal(describeApiError(error))),
    );
    // Don't self-schedule after an unexpected failure — a crashing run
    // shouldn't spin a daemon that just keeps crashing.
    return false;
  }
}
