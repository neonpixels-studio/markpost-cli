import { parseArgs } from 'node:util';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  deleteRecords,
  ERROR_STATUS,
  fetchAllRecords,
  MAX_DELETE_BATCH_SIZE,
  PENDING_STATUS,
  RecordListFilters,
  updateRecord,
} from '#src/libs/records.js';
import {
  describeApiError,
  describeRequestRejection,
  isPerRecordRejection,
} from '#src/libs/api.js';
import { checkConfig } from '#src/libs/config.js';
import { failWithMessage, warnPartialRead } from '#src/libs/errors.js';
import {
  isInteractiveTerminal,
  sanitizeForTerminal,
} from '#src/libs/terminal.js';
import {
  failWithSubcommandUsage,
  failWithUsage,
  parseOrFailWithUsage,
} from '#src/libs/usage.js';
import {
  hasJsonFlag,
  JSON_ERROR_FETCH_FAILED,
  printJson,
  printJsonError,
} from '#src/libs/output.js';
import { Record } from '#src/types/records.types.js';

const LIST_SUBCOMMAND = 'list';
const UPDATE_SUBCOMMAND = 'update';
const DELETE_SUBCOMMAND = 'delete';

export const USAGE = `Usage: markpost records <list|update|delete> [options]

  list              List records, optionally filtered by source, status, or search text
  update <uuid>     Edit an existing record's title and/or content — requeues it to
                    pending (for resync) if the record was already synced
  delete <uuid...>  Delete one or more records from the server. Asks to confirm
                    first (this cannot be undone); pass --yes to skip the prompt

List options:
  --source <type>    Filter by source type (markpost reports the valid types if the value is rejected)
  --status <status>  Filter by record status (synced, pending, or error)
  --search <text>    Filter by text in the title or content
  --json             Print the records as JSON instead of formatted text

Update options (at least one of --title/--content is required; neither may be
blank — pass a non-empty value):
  --title <text>    New title for the record
  --content <text>  New content for the record
  --json            Print the updated record as JSON instead of formatted text

Delete options:
  --yes             Skip the confirmation prompt (required when not running in a
                    terminal, and with --json)
  --json            Print the deleted count as JSON instead of formatted text`;

export const runRecordsCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below is rendered in
  // whichever contract the caller asked for, even one thrown before parsing.
  const json = hasJsonFlag(args);
  const [subcommand] = args;

  if (subcommand === UPDATE_SUBCOMMAND) {
    await runUpdateCommand(args, json);
    return;
  }

  if (subcommand === DELETE_SUBCOMMAND) {
    await runDeleteCommand(args, json);
    return;
  }

  // Validate before the config check so a bad subcommand fails on usage alone,
  // without needing a configured account.
  if (subcommand !== LIST_SUBCOMMAND) {
    failWithSubcommandUsage(subcommand, USAGE, json);
    return;
  }

  // Parse before checkConfig, which prompts for and persists config when
  // unset: a bad flag must fail on usage alone. Parsed via
  // parseOrFailWithUsage so a usage throw reports the `usage` JSON code, not
  // the fetch path's `fetch_failed`.
  const parsed = parseOrFailWithUsage(() => parseListArgs(args), USAGE, json);

  if (!parsed) {
    return;
  }

  const { filters } = parsed;

  try {
    if (!(await checkConfig(json))) {
      return;
    }

    await listRecords(filters, json);
  } catch (error) {
    // A systemic auth/5xx failure now re-throws from fetchAllRecords (issue
    // #89): surface its classified, actionable message with a non-zero exit,
    // distinct from the generic "Failed to fetch records" a non-systemic
    // failure produces. Sanitize — the message can be server-derived.
    failWithMessage(sanitizeForTerminal(describeApiError(error)), json);
  }
};

// `parseArgs` handles both `--source webhook` and `--source=webhook`, and
// throws on an unknown flag or a missing value, which the command's usage
// catch surfaces to the user. The `list` subcommand itself lands in
// `positionals` and is skipped here.
const parseListArgs = (args: string[]): { filters: RecordListFilters } => {
  // `multiple: true` collects repeats into an array so a flag passed twice
  // (`--source webhook --source email`) can be rejected rather than silently
  // last-winning, matching how stray positionals and empty values fail below.
  // `--json` is still declared so `parseArgs` accepts it; its value is read
  // from argv by `hasJsonFlag` in the caller.
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      source: { type: 'string', multiple: true },
      status: { type: 'string', multiple: true },
      search: { type: 'string', multiple: true },
      json: { type: 'boolean' },
    },
  });

  // positionals[0] is the `list` subcommand itself; anything past it is a
  // stray argument (e.g. `records list webhook`, a likely miss for
  // `--source webhook`) and must fail loudly rather than silently listing
  // everything unfiltered.
  if (positionals.length > 1) {
    throw new Error(
      `Unexpected argument "${positionals[1]}". Set filters with --source, --status, or --search.`,
    );
  }

  return {
    filters: {
      source: normalizeFilter('source', values.source),
      status: normalizeFilter('status', values.status),
      search: normalizeFilter('search', values.search),
    },
  };
};

// Collapses a flag's parsed occurrences (an array under `multiple: true`)
// into a single validated value. A flag passed more than once is ambiguous
// and rejected. A present-but-empty or whitespace-only flag (`--source=`,
// `--search ' '`) would otherwise drop out of the query and list everything
// while the user believes they filtered, so it is rejected too. The trimmed
// value is what gets sent: markpost trims `filter[q]` server-side anyway, and
// a trimmed source/status is more forgiving than shipping surrounding spaces
// that match nothing.
const normalizeFilter = (
  flag: string,
  occurrences: string[] | undefined,
): string | undefined => {
  if (occurrences === undefined) {
    return undefined;
  }

  if (occurrences.length > 1) {
    throw new Error(`--${flag} was given more than once. Pass it only once.`);
  }

  const trimmed = occurrences[0].trim();

  if (trimmed.length === 0) {
    throw new Error(`--${flag} needs a non-empty value.`);
  }

  return trimmed;
};

// title, uuid, createdAt, status, syncedAt, and errorMessage all come from the
// untrusted API response, so each is stripped of control/ANSI escapes before
// printing (see terminal.ts). status and syncedAt are printed only when
// present: markpost sends both on every record, but they stay optional in the
// type for off-contract responses, and a missing value shouldn't print a
// blank label. errorMessage is printed only for a record whose CURRENT status
// is `error` — see the doc comment on `ERROR_STATUS` for why presence alone
// isn't enough.
const printRecord = (record: Record): void => {
  console.log(chalk.bold(sanitizeForTerminal(record.title)));
  console.log(`  uuid:       ${sanitizeForTerminal(record.uuid)}`);
  console.log(`  created at: ${sanitizeForTerminal(record.createdAt)}`);

  if (record.status) {
    console.log(`  status:     ${sanitizeForTerminal(record.status)}`);
  }

  if (record.syncedAt) {
    console.log(`  synced at:  ${sanitizeForTerminal(record.syncedAt)}`);
  }

  if (record.status === ERROR_STATUS && record.errorMessage) {
    console.log(`  error:      ${sanitizeForTerminal(record.errorMessage)}`);
  }
};

// Read-only preview of the records on the server (optionally filtered).
// Deliberately never touches deleteRecords: this is the safe alternative to
// running the no-arg sync just to see what's there.
const listRecords = async (
  filters: RecordListFilters,
  json: boolean,
): Promise<void> => {
  const result = await fetchAllRecords(filters, json);

  // A failed fetch must not masquerade as "No records found." — throw so the
  // command's catch reports it loudly and exits non-zero, rather than printing
  // the same message an empty account would produce.
  if (!result.ok) {
    throw new Error('Failed to fetch records from the server.');
  }

  const { records, partial } = result;

  // A partial read (a later page failed mid-pagination) must not present a
  // truncated list as the full set. `warnPartialRead` reports it honestly —
  // chalk prose on stderr in plain mode, or the unified `{ error, message }`
  // JSON contract under `--json` — and sets a non-zero exit either way, so
  // the JSON path below still writes clean JSON to stdout while the caller
  // (and `--json`) still sees the failure.
  if (partial) {
    warnPartialRead(json);
  }

  // JSON mode prints the array (empty included, as `[]`) and nothing else —
  // no "No records found." line, so the stdout stays valid JSON for `jq`.
  if (json) {
    printJson(records);
    return;
  }

  if (records.length === 0) {
    // A partial read with zero records must not claim "No records found." — the
    // read failed before any page came back, which is not an empty account.
    console.log(
      partial
        ? 'No records fetched — the read failed partway through.'
        : 'No records found.',
    );
    return;
  }

  records.forEach(printRecord);
};

type UpdateRecordArgs = {
  uuid: string;
  title?: string;
  content?: string;
};

// Rejects the pathological uuid values that would make updateRecord's request
// URL resolve to a DIFFERENT markpost endpoint than the single-record one this
// command is built for: `.` and `..` are dot-segments a URL parser collapses
// away during resolution (`/api/records/..` normalizes to `/api/`, not the
// literal path), and a uuid containing `/` would inject an extra path
// segment. `encodeURIComponent` (used when the request is built) doesn't stop
// either case — it leaves a bare `.` untouched, and the collapse happens
// during URL resolution, before the request ever reaches the server.
const isPathUnsafeUuid = (uuid: string): boolean =>
  uuid === '.' || uuid === '..' || uuid.includes('/');

// Collapses a flag's parsed occurrences (an array under `multiple: true`,
// mirroring normalizeFilter above) into a single value — rejecting a flag
// passed more than once (ambiguous) and a present-but-empty value (almost
// certainly a typo, e.g. `--title=` when a shell variable expanded empty).
// Unlike normalizeFilter, this returns `undefined` when the flag was never
// given at all — parseUpdateArgs needs to tell "omitted" (the field is left
// untouched by the PATCH) apart from "given", which a flag's mere absence vs.
// an empty string can't express on its own.
const extractUpdateFlag = (
  flag: string,
  occurrences: string[] | undefined,
): string | undefined => {
  if (occurrences === undefined) {
    return undefined;
  }

  if (occurrences.length > 1) {
    throw new Error(`--${flag} was given more than once. Pass it only once.`);
  }

  const value = occurrences[0];

  if (value.trim().length === 0) {
    throw new Error(`--${flag} needs a non-empty value.`);
  }

  return value;
};

// `parseArgs` handles both `--title foo` and `--title=foo`, and throws on an
// unknown flag or a missing value, which the update usage catch surfaces to
// the user. positionals[0] is the `update` subcommand itself (mirroring
// parseListArgs' identical `list` handling); positionals[1] is the uuid, and
// anything past it is a stray argument.
const parseUpdateArgs = (args: string[]): UpdateRecordArgs => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: 'string', multiple: true },
      content: { type: 'string', multiple: true },
      json: { type: 'boolean' },
    },
  });

  const [, uuid, ...extraPositionals] = positionals;

  if (!uuid) {
    throw new Error(
      'No uuid given. Usage: markpost records update <uuid> [--title <text>] [--content <text>]',
    );
  }

  if (isPathUnsafeUuid(uuid)) {
    throw new Error(`"${uuid}" is not a valid record uuid.`);
  }

  if (extraPositionals.length > 0) {
    throw new Error(`Unexpected argument "${extraPositionals[0]}".`);
  }

  const title = extractUpdateFlag('title', values.title);
  const content = extractUpdateFlag('content', values.content);

  // Neither flag given is a no-op request that would otherwise reach the
  // server as an empty attributes object and be rejected there (see
  // markpost's emptyUpdateError) — fail loud here instead, before a network
  // round trip.
  if (title === undefined && content === undefined) {
    throw new Error('Nothing to update: pass --title and/or --content.');
  }

  return { uuid, title, content };
};

// Applies the edit and reports the result: the updated record (pretty or
// --json), plus an explicit confirmation when the server's response shows the
// record is now `pending` — the resync-requeue behavior markpost's PATCH
// endpoint performs when an already-synced record's title/content changes
// (markpost#306). A record that was already pending/error before the edit
// also reads `pending`/`error` here, so this reports the record's current
// state honestly rather than claiming a transition that may not have
// happened.
const updateRecordAndReport = async (
  { uuid, title, content }: UpdateRecordArgs,
  json: boolean,
): Promise<void> => {
  let updated: Record | null;

  try {
    updated = await updateRecord(uuid, { title, content }, json);
  } catch (error) {
    // A per-record rejection (a 404 for an unknown uuid, a 422 for an invalid
    // title/content) carries the server's own detail, so name the record and
    // report why; a systemic failure falls through to the caller's catch.
    if (!isPerRecordRejection(error)) {
      throw error;
    }

    failWithMessage(
      sanitizeForTerminal(
        `Failed to update record "${uuid}": ${describeRequestRejection(error)}`,
      ),
      json,
    );
    return;
  }

  if (!updated) {
    failWithMessage(
      `Failed to update record "${sanitizeForTerminal(uuid)}".`,
      json,
    );
    return;
  }

  if (json) {
    printJson(updated);
    return;
  }

  console.log(
    chalk.greenBright(
      sanitizeForTerminal(`Updated "${updated.title}" (${updated.uuid})`),
    ),
  );

  // State-neutral wording on purpose: `pending` here can mean the server just
  // requeued a previously-synced record for resync (markpost#306), or that the
  // record was already pending before this edit and was never written to disk
  // in the first place. Either way "the next sync run will write it to disk"
  // is accurate; claiming a fresh "re-sync" transition would not be.
  if (updated.status === PENDING_STATUS) {
    console.log(
      chalk.yellow(
        'Record is pending — the next sync run will write it to disk.',
      ),
    );
  }

  printRecord(updated);
};

// `update <uuid>` edits an existing record's title/content via markpost's
// single-record PATCH /api/records/{uuid} — the CLI's only write path for a
// record that already exists (until now the only way to change a record was
// delete-and-recreate, which loses the uuid and any source linkage).
const runUpdateCommand = async (
  args: string[],
  json: boolean,
): Promise<void> => {
  // Parse via parseOrFailWithUsage, before the config check, so a bad flag or a
  // missing uuid fails on usage alone — mirrors runRecordsCommand's list path.
  const updateArgs = parseOrFailWithUsage(
    () => parseUpdateArgs(args),
    USAGE,
    json,
  );

  if (!updateArgs) {
    return;
  }

  try {
    if (!(await checkConfig(json))) {
      return;
    }

    await updateRecordAndReport(updateArgs, json);
  } catch (error) {
    // A systemic auth/5xx failure re-throws from updateRecord: surface its
    // classified, actionable message with a non-zero exit rather than the
    // generic "Failed to update record" a null return produces. Sanitize —
    // the message can be server-derived.
    failWithMessage(sanitizeForTerminal(describeApiError(error)), json);
  }
};

// markpost validates every uuid in a bulk DELETE against this shape
// (server/utils/uuid.ts) and rejects the WHOLE request with a 422 if any one
// fails, so the CLI checks first and sends nothing rather than fail a chunk.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_INVALID_UUIDS_SHOWN = 5;

// Argv is untrusted (xargs over a file, say): sanitize before echoing it, and
// cap the list so a large bad input doesn't flood stderr.
const describeInvalidUuids = (invalid: string[]): string => {
  const shown = invalid
    .slice(0, MAX_INVALID_UUIDS_SHOWN)
    .map((uuid) => `"${sanitizeForTerminal(uuid)}"`)
    .join(', ');
  const hidden = invalid.length - MAX_INVALID_UUIDS_SHOWN;
  const more = hidden > 0 ? ` and ${hidden} more` : '';

  return `Not a valid record uuid: ${shown}${more}. Nothing was deleted.`;
};

type DeleteRecordsArgs = {
  uuids: string[];
  skipConfirm: boolean;
};

// Lowercases before deduping so the same record typed in two cases counts
// once; markpost generates lowercase uuids.
const dedupeUuids = (uuids: string[]): string[] => [
  ...new Set(uuids.map((uuid) => uuid.toLowerCase())),
];

// positionals[0] is the `delete` subcommand itself, mirroring parseUpdateArgs.
const parseDeleteArgs = (args: string[]): DeleteRecordsArgs => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });

  const [, ...rawUuids] = positionals;

  if (rawUuids.length === 0) {
    throw new Error(
      'No uuid given. Usage: markpost records delete <uuid...> [--yes]',
    );
  }

  const invalid = rawUuids.filter((uuid) => !UUID_PATTERN.test(uuid));

  if (invalid.length > 0) {
    throw new Error(describeInvalidUuids(invalid));
  }

  return { uuids: dedupeUuids(rawUuids), skipConfirm: Boolean(values.yes) };
};

// The prompt reads from and renders to a TTY, so a redirected run would hang
// (or exit 0 without deleting). Refuse up front, matching `sources delete`.
const nonInteractiveRefusal = (
  skipConfirm: boolean,
  json: boolean,
): string | null => {
  if (skipConfirm) {
    return null;
  }

  // The prompt renders on stdout, which --json reserves for the JSON payload.
  if (json) {
    return `\`records ${DELETE_SUBCOMMAND} --json\` needs --yes: the confirmation prompt would corrupt the JSON on stdout.`;
  }

  if (isInteractiveTerminal()) {
    return null;
  }

  return `\`records ${DELETE_SUBCOMMAND}\` needs an interactive terminal to confirm; pass --yes (\`markpost records ${DELETE_SUBCOMMAND} <uuid...> --yes\`) to delete without a prompt.`;
};

const confirmRecordDeletion = (count: number): Promise<boolean> =>
  confirm({
    message: `Delete ${count} record(s)? This cannot be undone.`,
    default: false,
  });

type ChunkFailure = { chunk: number; reason: string };

type DeleteRun = {
  deleted: number;
  totalChunks: number;
  failures: ChunkFailure[];
};

const chunkUuids = (uuids: string[]): string[][] => {
  const chunks: string[][] = [];

  for (let start = 0; start < uuids.length; start += MAX_DELETE_BATCH_SIZE) {
    chunks.push(uuids.slice(start, start + MAX_DELETE_BATCH_SIZE));
  }

  return chunks;
};

const NOT_ATTEMPTED_REASON = 'not attempted after an earlier systemic failure';

type ChunkOutcome = {
  deleted: number;
  failureReason: string | null;
  // A thrown systemic failure (auth/5xx/timeout) would recur on every later
  // chunk, so the run stops; a plain failure leaves later chunks to try.
  systemic: boolean;
};

const attemptChunk = async (chunk: string[]): Promise<ChunkOutcome> => {
  try {
    const { meta } = await deleteRecords(chunk);

    if (meta) {
      return { deleted: meta.deleted, failureReason: null, systemic: false };
    }

    return {
      deleted: 0,
      failureReason: 'the request failed',
      systemic: false,
    };
  } catch (error) {
    return {
      deleted: 0,
      failureReason: sanitizeForTerminal(describeApiError(error)),
      systemic: true,
    };
  }
};

const notAttemptedFailures = (
  fromChunk: number,
  totalChunks: number,
): ChunkFailure[] =>
  Array.from({ length: totalChunks - fromChunk + 1 }, (_, offset) => ({
    chunk: fromChunk + offset,
    reason: NOT_ATTEMPTED_REASON,
  }));

// Folds a chunk's outcome into the run; returns true when the run must stop.
const recordChunkOutcome = (
  run: DeleteRun,
  chunkNumber: number,
  outcome: ChunkOutcome,
): boolean => {
  run.deleted += outcome.deleted;

  if (outcome.failureReason !== null) {
    run.failures.push({ chunk: chunkNumber, reason: outcome.failureReason });
  }

  if (!outcome.systemic) {
    return false;
  }

  run.failures.push(...notAttemptedFailures(chunkNumber + 1, run.totalChunks));
  return true;
};

// Sends one chunk at a time through the shared deleteRecords lib (one chunk is
// a single request, so the lib's own chunking is a no-op here) because it only
// reports a whole-run `null` on failure; going chunk by chunk is what lets us
// name WHICH chunk failed.
const deleteInChunks = async (uuids: string[]): Promise<DeleteRun> => {
  const chunks = chunkUuids(uuids);
  const run: DeleteRun = {
    deleted: 0,
    totalChunks: chunks.length,
    failures: [],
  };

  for (const [index, chunk] of chunks.entries()) {
    const outcome = await attemptChunk(chunk);

    if (recordChunkOutcome(run, index + 1, outcome)) {
      return run;
    }
  }

  return run;
};

const describeChunkFailures = (run: DeleteRun): string =>
  run.failures
    .map(
      ({ chunk, reason }) => `chunk ${chunk} of ${run.totalChunks} (${reason})`,
    )
    .join('; ');

const reportDeleteFailure = (
  run: DeleteRun,
  requested: number,
  json: boolean,
): void => {
  const message = `Deleted ${run.deleted} of ${requested} requested record(s). Failed: ${describeChunkFailures(run)}. Each chunk holds up to ${MAX_DELETE_BATCH_SIZE} uuids; re-run to retry (already-deleted uuids are harmless to resend).`;

  if (!json) {
    failWithMessage(message);
    return;
  }

  process.exitCode = 1;
  printJsonError(JSON_ERROR_FETCH_FAILED, message, {
    deleted: run.deleted,
    requested,
    failedChunks: run.failures,
  });
};

// markpost's DELETE /api/records returns `{ meta: { deleted } }`, the count of
// rows actually removed, so it can be lower than `requested` when a uuid does
// not exist or belongs to someone else; that is reported, not treated as an error.
const reportDeleteSuccess = (
  deleted: number,
  requested: number,
  json: boolean,
): void => {
  if (json) {
    printJson({ deleted, requested });
    return;
  }

  console.log(chalk.greenBright(`Deleted ${deleted} record(s).`));

  if (deleted < requested) {
    console.log(
      chalk.yellow(
        `${requested - deleted} of ${requested} requested uuid(s) matched no record.`,
      ),
    );
  }
};

const deleteRecordsAndReport = async (
  { uuids, skipConfirm }: DeleteRecordsArgs,
  json: boolean,
): Promise<void> => {
  const confirmed = skipConfirm || (await confirmRecordDeletion(uuids.length));

  if (!confirmed) {
    console.log('Deletion cancelled.');
    return;
  }

  const run = await deleteInChunks(uuids);

  if (run.failures.length > 0) {
    reportDeleteFailure(run, uuids.length, json);
    return;
  }

  reportDeleteSuccess(run.deleted, uuids.length, json);
};

// `delete <uuid...>` is the explicit counterpart to the sync's auto-delete:
// removing stray records without the web UI.
const runDeleteCommand = async (
  args: string[],
  json: boolean,
): Promise<void> => {
  const parsed = parseOrFailWithUsage(() => parseDeleteArgs(args), USAGE, json);

  if (!parsed) {
    return;
  }

  const refusal = nonInteractiveRefusal(parsed.skipConfirm, json);

  if (refusal) {
    failWithUsage(refusal, USAGE, json);
    return;
  }

  try {
    if (!(await checkConfig(json))) {
      return;
    }

    await deleteRecordsAndReport(parsed, json);
  } catch (error) {
    // A deliberate Ctrl+C at the prompt is a user abort, not a failure.
    if (error instanceof Error && error.name === 'ExitPromptError') {
      return;
    }

    failWithMessage(sanitizeForTerminal(describeApiError(error)), json);
  }
};
