import { parseArgs } from 'node:util';
import chalk from 'chalk';
import {
  ERROR_STATUS,
  fetchAllRecords,
  PENDING_STATUS,
  RecordListFilters,
  updateRecord,
} from '@/libs/records.js';
import { describeApiError } from '@/libs/api.js';
import { checkConfig } from '@/libs/config.js';
import {
  failWithMessage,
  messageFromError,
  warnPartialRead,
} from '@/libs/errors.js';
import { sanitizeForTerminal } from '@/libs/terminal.js';
import { failWithSubcommandUsage, failWithUsage } from '@/libs/usage.js';
import { hasJsonFlag, printJson } from '@/libs/output.js';
import { Record } from '@/types/records.types.js';

const LIST_SUBCOMMAND = 'list';
const UPDATE_SUBCOMMAND = 'update';

export const USAGE = `Usage: markpost records <list|update> [options]

  list           List records, optionally filtered by source, status, or search text
  update <uuid>  Edit an existing record's title and/or content — requeues it to
                 pending (for resync) if the record was already synced

List options:
  --source <type>    Filter by source type (markpost reports the valid types if the value is rejected)
  --status <status>  Filter by record status (synced, pending, or error)
  --search <text>    Filter by text in the title or content
  --json             Print the records as JSON instead of formatted text

Update options (at least one of --title/--content is required; neither may be
blank — pass a non-empty value):
  --title <text>    New title for the record
  --content <text>  New content for the record
  --json            Print the updated record as JSON instead of formatted text`;

export const runRecordsCommand = async (args: string[]): Promise<void> => {
  // Read `--json` straight from argv so every failure below is rendered in
  // whichever contract the caller asked for, even one thrown before parsing.
  const json = hasJsonFlag(args);
  const [subcommand] = args;

  if (subcommand === UPDATE_SUBCOMMAND) {
    await runUpdateCommand(args, json);
    return;
  }

  // Validate before the config check so a bad subcommand fails on usage alone,
  // without needing a configured account.
  if (subcommand !== LIST_SUBCOMMAND) {
    failWithSubcommandUsage(subcommand, USAGE, json);
    return;
  }

  // Parse before checkConfig, which prompts for and persists config when
  // unset: a bad flag must fail on usage alone. Its own catch so a usage
  // throw reports the `usage` JSON code, not the fetch path's `fetch_failed`.
  let filters: RecordListFilters;

  try {
    ({ filters } = parseListArgs(args));
  } catch (error) {
    failWithUsage(sanitizeForTerminal(messageFromError(error)), USAGE, json);
    return;
  }

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
  const updated = await updateRecord(uuid, { title, content });

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
  // Parse in its own try/catch, before the config check, so a bad flag or a
  // missing uuid fails on usage alone — mirrors runRecordsCommand's list path.
  let updateArgs: UpdateRecordArgs;

  try {
    updateArgs = parseUpdateArgs(args);
  } catch (error) {
    failWithUsage(sanitizeForTerminal(messageFromError(error)), USAGE, json);
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
